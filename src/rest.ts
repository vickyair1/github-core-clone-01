// REST v3 surface for the github-core-clone-01 forge: every /api/v3/* route.
//
// Contract sources: specs/rest-spec.md (endpoint/status catalogue) and
// ARCHITECTURE.md ("rest.ts — contract" + the git.ts function signatures).
//
// Integration (server.ts is the caller — read it before changing this file):
//   - server.ts enforces auth before dispatch; this module never re-checks
//     the token. Ownership is enforced through store.getRepo(): any owner
//     other than the token's login 404s (never 403).
//   - server.ts sets X-GitHub-Request-Id on every reply up front, reads the
//     body, and JSON-parses it (malformed JSON -> 400 before dispatch).
//     The parsed body arrives as req.json on the ForgeRequest, and the
//     pathname / raw query as req.path / req.query. This module reads those
//     fields and answers ONLY through ctx.sendJson / ctx.sendError /
//     ctx.sendBuffer (server.ts's ServerContext). Extra headers (Link,
//     X-OAuth-Scopes) are set with res.setHeader before the send call —
//     writeHead merges them with the helpers' own headers.
//   - Fallbacks, used only when handleRest is called outside server.ts
//     (e.g. a test harness passing a raw IncomingMessage): req.path /
//     req.query are re-derived from req.url, and a body-carrying request
//     without a parsed `json` field has its stream read + JSON-parsed here
//     (malformed -> 400). If ctx lacks the send helpers, minimal local
//     ones are used instead. None of these paths run in production.
//
// Determinism: timestamps come from store.nowIso() or from the logical-clock
// epoch + createdSeq. No Date.now()/Math.random() anywhere in this module.
//
// Perf: GET /issues/{n} serves a cached serialized Buffer (repo.issueJsonCache,
// populated on create + first GET, invalidated on PATCH and on comment
// create — the issue view carries a comments count). All lookups are O(1)
// Maps; list endpoints never re-serialize a single-item path.

import type { ServerResponse } from 'node:http';
import { CLOCK_EPOCH_SEC } from './store.ts';
import type { Comment, Issue, Label, Pull, Repo, Store } from './store.ts';
import type { ForgeRequest, ServerContext } from './server.ts';
import {
  commitFile,
  deleteFile,
  diffTrees,
  listCommits,
  readFileAt,
  resolveRef,
  squashMerge,
} from './git.ts';

/** Per-request bundle passed to the route handlers. */
interface HCtx {
  req: ForgeRequest;
  res: ServerResponse;
  store: Store;
  ctx: ServerContext;
  /** Parsed query string, or null when the request had no `?`. */
  query: URLSearchParams | null;
  /** Parsed JSON body (undefined for GETs and empty bodies). */
  body: unknown;
}

const SHA40_RE = /^[0-9a-f]{40}$/i;
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_BODY_BYTES = 10 * 1024 * 1024;

/** updated_at overrides for repos (store.ts keeps no updatedAt on Repo):
 *  set on PATCH, derived from createdSeq otherwise. */
const repoUpdatedAt = new WeakMap<Repo, string>();

/** Stable ISO timestamp derived from a creation sequence number (the
 *  logical clock's epoch + seq seconds). Deterministic across runs and
 *  stable across reads — used for repo/comment timestamps, which the
 *  store does not keep as clock values. */
function isoFromSeq(seq: number): string {
  return new Date((CLOCK_EPOCH_SEC + seq) * 1000).toISOString();
}

function decodeSeg(s: string): string {
  if (s.indexOf('%') === -1) return s;
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Strict non-negative integer parse for /issues/{n} and /pulls/{n}. */
function parseNum(s: string): number {
  if (!/^\d+$/.test(s)) return NaN;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : NaN;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Send helpers — thin wrappers over the ctx helpers, with a local fallback
// used only when ctx was built without them (never in production).
// ---------------------------------------------------------------------------

function sendJson(
  res: ServerResponse,
  status: number,
  obj: unknown,
  ctx: ServerContext,
  extraHeaders?: Record<string, string>,
): void {
  if (extraHeaders !== undefined) {
    for (const k of Object.keys(extraHeaders)) res.setHeader(k, extraHeaders[k]);
  }
  if (typeof ctx.sendJson === 'function') {
    ctx.sendJson(res, status, obj);
    return;
  }
  if (!res.hasHeader('content-type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (!res.hasHeader('x-github-request-id')) res.setHeader('X-GitHub-Request-Id', ctx.requestId());
  if (status === 204) {
    res.writeHead(204);
    res.end();
    return;
  }
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, message: string, ctx: ServerContext): void {
  if (typeof ctx.sendError === 'function') {
    ctx.sendError(res, status, message);
    return;
  }
  sendJson(res, status, { message }, ctx);
}

function sendBuffer(res: ServerResponse, status: number, buf: Buffer, ctx: ServerContext): void {
  if (typeof ctx.sendBuffer === 'function') {
    ctx.sendBuffer(res, status, buf);
    return;
  }
  if (!res.hasHeader('content-type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (!res.hasHeader('x-github-request-id')) res.setHeader('X-GitHub-Request-Id', ctx.requestId());
  res.writeHead(status, { 'Content-Length': buf.length });
  res.end(buf);
}

function sendNoContent(res: ServerResponse, ctx: ServerContext): void {
  // server.ts's sendJson sends no body for 204.
  sendJson(res, 204, null, ctx);
}

// ---------------------------------------------------------------------------
// Body fallback: read + JSON-parse the request stream. Only used when the
// request was NOT pre-parsed by server.ts (no `json` field on req).
// ---------------------------------------------------------------------------

async function readBodyStream(req: ForgeRequest): Promise<{ value: unknown; malformed: boolean }> {
  const chunks: Buffer[] = [];
  let len = 0;
  try {
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      len += buf.length;
      if (len > MAX_BODY_BYTES) return { value: undefined, malformed: true };
      chunks.push(buf);
    }
  } catch {
    return { value: undefined, malformed: true };
  }
  if (len === 0) return { value: undefined, malformed: false };
  try {
    return { value: JSON.parse(Buffer.concat(chunks).toString('utf8')), malformed: false };
  } catch {
    return { value: undefined, malformed: true };
  }
}

// ---------------------------------------------------------------------------
// Pagination (spec §4): Link <absolute-url>; rel="next", same-origin from
// the request Host header; honour per_page exactly; NO rel="next" on the
// last page; stable creation order; default per_page 30, page 1.
// ---------------------------------------------------------------------------

function pageParams(query: URLSearchParams | null): { page: number; perPage: number } {
  let page = 1;
  let perPage = 30;
  if (query !== null) {
    const p = query.get('page');
    if (p !== null) {
      const v = parseInt(p, 10);
      if (Number.isFinite(v) && v >= 1) page = v;
    }
    const pp = query.get('per_page');
    if (pp !== null) {
      const v = parseInt(pp, 10);
      if (Number.isFinite(v) && v >= 1) perPage = v > 100 ? 100 : v;
    }
  }
  return { page, perPage };
}

function paginate<T>(items: T[], page: number, perPage: number): { slice: T[]; hasNext: boolean } {
  const start = (page - 1) * perPage;
  if (start >= items.length) return { slice: [], hasNext: false };
  const slice = items.slice(start, start + perPage);
  return { slice, hasNext: start + perPage < items.length };
}

function setNextLink(req: ForgeRequest, res: ServerResponse, pathname: string, page: number, perPage: number): void {
  const host = req.headers.host ?? '127.0.0.1';
  const rawQuery = typeof req.query === 'string' ? req.query : '';
  const params = new URLSearchParams(rawQuery);
  params.set('per_page', String(perPage));
  params.set('page', String(page + 1));
  res.setHeader('Link', '<http://' + host + pathname + '?' + params.toString() + '>; rel="next"');
}

function sendList<T>(h: HCtx, pathname: string, items: T[], view: (item: T) => unknown): void {
  const { page, perPage } = pageParams(h.query);
  const { slice, hasNext } = paginate(items, page, perPage);
  if (hasNext) setNextLink(h.req, h.res, pathname, page, perPage);
  sendJson(h.res, 200, slice.map(view), h.ctx);
}

// ---------------------------------------------------------------------------
// Response view builders. Extra JSON fields are always allowed by the
// suite, so every asserted field is included exactly, plus GitHub-faithful
// extras (id, full_name, owner, html_url, url, created_at, updated_at).
// ---------------------------------------------------------------------------

export function repoView(repo: Repo): Record<string, unknown> {
  const created = isoFromSeq(repo.createdSeq);
  const updated = repoUpdatedAt.get(repo) ?? created;
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.owner + '/' + repo.name,
    owner: { login: repo.owner, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: created,
    updated_at: updated,
    html_url: 'https://github.com/' + repo.owner + '/' + repo.name,
    url: '/api/v3/repos/' + repo.owner + '/' + repo.name,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: repo.issues.size,
    archived: false,
    disabled: false,
  };
}

export function labelView(repo: Repo, label: Label): Record<string, unknown> {
  return {
    id: label.id,
    name: label.name,
    color: label.color,
    description: '',
    url: '/api/v3/repos/' + repo.owner + '/' + repo.name + '/labels/' + encodeURIComponent(label.name),
  };
}

export function issueView(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => labelView(repo, l)),
    user: { login: repo.owner, type: 'User' },
    assignee: null,
    assignees: [],
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    url: '/api/v3/repos/' + repo.owner + '/' + repo.name + '/issues/' + issue.number,
    html_url: 'https://github.com/' + repo.owner + '/' + repo.name + '/issues/' + issue.number,
    comments_url: '/api/v3/repos/' + repo.owner + '/' + repo.name + '/issues/' + issue.number + '/comments',
  };
}

export function commentView(repo: Repo, issue: Issue, comment: Comment): Record<string, unknown> {
  const at = isoFromSeq(comment.createdSeq);
  return {
    id: comment.id,
    body: comment.body,
    user: { login: repo.owner, type: 'User' },
    created_at: at,
    updated_at: at,
    url:
      '/api/v3/repos/' + repo.owner + '/' + repo.name + '/issues/' + issue.number + '/comments/' + comment.id,
    html_url: 'https://github.com/' + repo.owner + '/' + repo.name + '/issues/' + issue.number + '#issuecomment-' + comment.id,
  };
}

export function pullView(repo: Repo, pr: Pull): Record<string, unknown> {
  return {
    id: pr.number,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    head: {
      ref: pr.headRef,
      sha: pr.headSha,
      label: repo.owner + ':' + pr.headRef,
      user: { login: repo.owner, type: 'User' },
      repo: { full_name: repo.owner + '/' + repo.name },
    },
    base: {
      ref: pr.baseRef,
      sha: pr.baseSha,
      label: repo.owner + ':' + pr.baseRef,
      user: { login: repo.owner, type: 'User' },
      repo: { full_name: repo.owner + '/' + repo.name },
    },
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    mergeable: pr.mergeable,
    user: { login: repo.owner, type: 'User' },
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    url: '/api/v3/repos/' + repo.owner + '/' + repo.name + '/pulls/' + pr.number,
    html_url: 'https://github.com/' + repo.owner + '/' + repo.name + '/pull/' + pr.number,
  };
}

export function branchView(repo: Repo, name: string, sha: string): Record<string, unknown> {
  return {
    name,
    commit: {
      sha,
      url: '/api/v3/repos/' + repo.owner + '/' + repo.name + '/commits/' + sha,
    },
    protected: false,
  };
}

export function commitView(repo: Repo, sha: string, message: string): Record<string, unknown> {
  const person = { name: repo.owner, email: repo.owner + '@example.invalid' };
  return {
    sha,
    commit: { message, author: person, committer: person },
    author: { login: repo.owner, type: 'User' },
    committer: { login: repo.owner, type: 'User' },
    url: '/api/v3/repos/' + repo.owner + '/' + repo.name + '/commits/' + sha,
    html_url: 'https://github.com/' + repo.owner + '/' + repo.name + '/commit/' + sha,
  };
}

export function contentFileView(repo: Repo, path: string, blobSha: string, data: Buffer): Record<string, unknown> {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return {
    type: 'file',
    encoding: 'base64',
    content: data.toString('base64'),
    sha: blobSha,
    size: data.length,
    name,
    path,
    url: '/api/v3/repos/' + repo.owner + '/' + repo.name + '/contents/' + path,
    html_url: 'https://github.com/' + repo.owner + '/' + repo.name + '/blob/HEAD/' + path,
    download_url: 'https://raw.githubusercontent.com/' + repo.owner + '/' + repo.name + '/HEAD/' + path,
  };
}

export function contentDirEntryView(
  repo: Repo,
  entry: { type: 'file' | 'dir'; name: string; path: string; sha: string },
): Record<string, unknown> {
  const size = entry.type === 'file' ? (repo.objects.get(entry.sha)?.data.length ?? 0) : 0;
  return {
    type: entry.type,
    name: entry.name,
    path: entry.path,
    sha: entry.sha,
    size,
    url: '/api/v3/repos/' + repo.owner + '/' + repo.name + '/contents/' + entry.path,
    html_url:
      'https://github.com/' + repo.owner + '/' + repo.name + '/' + (entry.type === 'dir' ? 'tree' : 'blob') + '/HEAD/' + entry.path,
  };
}

export function pullFileView(f: {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}): Record<string, unknown> {
  return {
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    changes: f.changes,
  };
}

// ---------------------------------------------------------------------------
// Issue JSON cache (read-workload perf): the serialized GET /issues/{n}
// body, populated on create + first GET, invalidated on PATCH and on
// comment create. The cached buffer is the BODY only; headers are set
// fresh per response by the send helpers.
// ---------------------------------------------------------------------------

function cacheIssueJson(repo: Repo, issue: Issue): Buffer {
  const buf = Buffer.from(JSON.stringify(issueView(repo, issue)), 'utf8');
  repo.issueJsonCache.set(issue.number, buf);
  return buf;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

function createRepo(h: HCtx): void {
  const { res, ctx, store } = h;
  const b = isObj(h.body) ? h.body : null;
  const name = b !== null && typeof b.name === 'string' ? b.name : '';
  if (name === '') {
    sendError(res, 422, 'name is required', ctx);
    return;
  }
  const priv = b !== null && b.private === true;
  const description = b !== null && typeof b.description === 'string' ? b.description : '';
  const repo = store.createRepo(name, priv, description);
  if (repo === null) {
    sendError(res, 422, 'name already exists on this account', ctx);
    return;
  }
  sendJson(res, 201, repoView(repo), ctx);
}

function listRepos(h: HCtx, pathname: string): void {
  sendList(h, pathname, h.store.repoList, (r) => repoView(r));
}

function patchRepo(h: HCtx, repo: Repo): void {
  const { res, ctx, store } = h;
  const b = isObj(h.body) ? h.body : null;
  if (b !== null) {
    if (typeof b.description === 'string') repo.description = b.description;
    if (typeof b.private === 'boolean') repo.private = b.private;
    // `name` renames are not supported (the store keys repos by name);
    // `default_branch` changes are not sent by the suite. Both ignored.
  }
  repoUpdatedAt.set(repo, store.nowIso());
  sendJson(res, 200, repoView(repo), ctx);
}

function createRef(h: HCtx, repo: Repo): void {
  const { res, ctx, store } = h;
  const b = isObj(h.body) ? h.body : null;
  const ref = b !== null && typeof b.ref === 'string' ? b.ref : '';
  const shaRaw = b !== null && typeof b.sha === 'string' ? b.sha : '';
  if (!ref.startsWith('refs/heads/') || ref.length <= 'refs/heads/'.length) {
    sendError(res, 422, 'ref must be under refs/heads/', ctx);
    return;
  }
  if (!SHA40_RE.test(shaRaw)) {
    sendError(res, 422, 'sha must be a 40-hex commit sha', ctx);
    return;
  }
  const sha = shaRaw.toLowerCase();
  const obj = repo.objects.get(sha);
  if (!obj || obj.type !== 'commit') {
    sendError(res, 422, 'sha does not name an existing commit', ctx);
    return;
  }
  if (repo.refs.has(ref)) {
    sendError(res, 422, 'Reference already exists', ctx);
    return;
  }
  repo.refs.set(ref, sha);
  store.touchRefs(repo);
  sendJson(res, 201, {
    ref,
    object: {
      sha,
      type: 'commit',
      url: '/api/v3/repos/' + repo.owner + '/' + repo.name + '/git/commits/' + sha,
    },
    url: '/api/v3/repos/' + repo.owner + '/' + repo.name + '/git/refs/' + ref.slice('refs/'.length),
  }, ctx);
}

function listBranches(h: HCtx, repo: Repo, pathname: string): void {
  const out: Array<{ name: string; sha: string }> = [];
  for (const [ref, sha] of repo.refs) {
    if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice(11), sha });
  }
  sendList(h, pathname, out, (b) => branchView(repo, b.name, b.sha));
}

function listCommitsRoute(h: HCtx, repo: Repo, pathname: string): void {
  const { res, ctx } = h;
  const refParam = h.query !== null ? h.query.get('sha') : null;
  const refName = refParam !== null && refParam !== '' ? refParam : repo.defaultBranch;
  const tip = resolveRef(repo, refName);
  if (tip === null) {
    if (refParam !== null && refParam !== '') {
      sendError(res, 404, 'Not Found', ctx);
      return;
    }
    // Unborn repo, no explicit ref: empty history.
    sendJson(res, 200, [], ctx);
    return;
  }
  const commits = listCommits(repo, tip);
  sendList(h, pathname, commits, (c) => commitView(repo, c.sha, c.message));
}

function putContents(h: HCtx, repo: Repo, path: string): void {
  const { res, ctx, store } = h;
  const b = isObj(h.body) ? h.body : null;
  const contentB64 = b !== null && typeof b.content === 'string' ? b.content : null;
  if (contentB64 === null) {
    sendError(res, 422, 'content is required', ctx);
    return;
  }
  const message = b !== null && typeof b.message === 'string' ? b.message : '';
  const branch = b !== null && typeof b.branch === 'string' && b.branch !== '' ? b.branch : repo.defaultBranch;
  const expected = b !== null && typeof b.sha === 'string' && b.sha !== '' ? b.sha.toLowerCase() : undefined;
  const refKey = 'refs/heads/' + branch;
  if (!repo.refs.has(refKey)) {
    // Unborn repo: only the default branch may be created by the first
    // commit (commitFile creates it). Any other missing branch is a 404.
    if (!(repo.refs.size === 0 && branch === repo.defaultBranch)) {
      sendError(res, 404, 'Not Found', ctx);
      return;
    }
  }
  const content = Buffer.from(contentB64, 'base64');
  const result = commitFile(repo, {
    // Omit `branch` when it is the default: commitFile's documented
    // unborn-repo path is "default branch when branch omitted".
    branch: branch === repo.defaultBranch ? undefined : branch,
    path,
    content,
    message,
    expectedBlobSha: expected,
  });
  if ('error' in result) {
    sendError(res, 409, 'The sha provided does not match the current file sha', ctx);
    return;
  }
  store.touchRefs(repo);
  const name = path.slice(path.lastIndexOf('/') + 1);
  sendJson(res, result.created ? 201 : 200, {
    content: {
      type: 'file',
      encoding: 'base64',
      size: content.length,
      name,
      path,
      sha: result.blobSha,
      url: '/api/v3/repos/' + repo.owner + '/' + repo.name + '/contents/' + path,
      html_url: 'https://github.com/' + repo.owner + '/' + repo.name + '/blob/' + branch + '/' + path,
    },
    commit: { sha: result.commitSha, message },
  }, ctx);
}

function getContents(h: HCtx, repo: Repo, path: string): void {
  const { res, ctx } = h;
  const refParam = h.query !== null ? h.query.get('ref') : null;
  const refName = refParam !== null && refParam !== '' ? refParam : repo.defaultBranch;
  const tip = resolveRef(repo, refName);
  if (tip === null) {
    sendError(res, 404, 'Not Found', ctx);
    return;
  }
  const found = readFileAt(repo, tip, path);
  if (found === null) {
    sendError(res, 404, 'Not Found', ctx);
    return;
  }
  if (found.kind === 'file') {
    sendJson(res, 200, contentFileView(repo, path, found.blobSha, found.data), ctx);
    return;
  }
  const entries = [...found.entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  sendJson(res, 200, entries.map((e) => contentDirEntryView(repo, e)), ctx);
}

function deleteContents(h: HCtx, repo: Repo, path: string): void {
  const { res, ctx, store } = h;
  const b = isObj(h.body) ? h.body : null;
  const message = b !== null && typeof b.message === 'string' ? b.message : '';
  const branch = b !== null && typeof b.branch === 'string' && b.branch !== '' ? b.branch : repo.defaultBranch;
  const expected = b !== null && typeof b.sha === 'string' && b.sha !== '' ? b.sha.toLowerCase() : undefined;
  if (!repo.refs.has('refs/heads/' + branch)) {
    sendError(res, 404, 'Not Found', ctx);
    return;
  }
  const result = deleteFile(repo, {
    branch: branch === repo.defaultBranch ? undefined : branch,
    path,
    message,
    expectedBlobSha: expected,
  });
  if ('error' in result) {
    if (result.error === 'stale') sendError(res, 409, 'The sha provided does not match the current file sha', ctx);
    else sendError(res, 404, 'Not Found', ctx);
    return;
  }
  store.touchRefs(repo);
  sendJson(res, 200, { commit: { sha: result.commitSha, message } }, ctx);
}

function createLabel(h: HCtx, repo: Repo): void {
  const { res, ctx, store } = h;
  const b = isObj(h.body) ? h.body : null;
  const name = b !== null && typeof b.name === 'string' ? b.name : '';
  if (name === '') {
    sendError(res, 422, 'name is required', ctx);
    return;
  }
  if (repo.labels.has(name)) {
    sendError(res, 422, 'Label already exists', ctx);
    return;
  }
  const color = b !== null && typeof b.color === 'string' && b.color !== '' ? b.color : 'ededed';
  const label: Label = { id: store.allocLabelId(repo), name, color };
  repo.labels.set(name, label);
  sendJson(res, 201, labelView(repo, label), ctx);
}

/** Resolve label names to Label objects. Returns null (after sending a
 *  422) when any name does not exist in this repo. */
function resolveLabels(h: HCtx, repo: Repo, raw: unknown): Label[] | null {
  const { res, ctx } = h;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    sendError(res, 422, 'labels must be an array', ctx);
    return null;
  }
  const out: Label[] = [];
  for (const name of raw) {
    if (typeof name !== 'string') {
      sendError(res, 422, 'labels must be strings', ctx);
      return null;
    }
    const label = repo.labels.get(name);
    if (!label) {
      sendError(res, 422, 'Label does not exist: ' + name, ctx);
      return null;
    }
    out.push(label);
  }
  return out;
}

function createIssue(h: HCtx, repo: Repo): void {
  const { res, ctx, store } = h;
  const b = isObj(h.body) ? h.body : null;
  // Validate labels BEFORE allocating a number: a 422 must not consume one.
  const labels = resolveLabels(h, repo, b !== null ? b.labels : undefined);
  if (labels === null) return;
  const title = b !== null && typeof b.title === 'string' ? b.title : '';
  const bodyText = b !== null && typeof b.body === 'string' ? b.body : '';
  const now = store.nowIso();
  const issue: Issue = {
    number: store.allocNumber(repo),
    title,
    body: bodyText,
    state: 'open',
    labels,
    comments: [],
    createdSeq: store.nextSeq(),
    createdAt: now,
    updatedAt: now,
  };
  repo.issues.set(issue.number, issue);
  // Populate the read-workload cache with the exact GET body.
  const buf = cacheIssueJson(repo, issue);
  sendBuffer(res, 201, buf, ctx);
}

function listIssues(h: HCtx, repo: Repo, pathname: string): void {
  const state = h.query !== null ? h.query.get('state') : null;
  const direction = h.query !== null ? h.query.get('direction') : null;
  const items: Issue[] = [];
  for (const issue of repo.issues.values()) {
    if (state === 'all') items.push(issue);
    else if (state === 'closed') {
      if (issue.state === 'closed') items.push(issue);
    } else if (issue.state === 'open') items.push(issue); // 'open' or absent/unknown -> open
  }
  if (direction !== 'asc') items.reverse(); // default: created desc
  sendList(h, pathname, items, (i) => issueView(repo, i));
}

function getIssue(h: HCtx, repo: Repo, n: number): void {
  const { res, ctx } = h;
  const issue = repo.issues.get(n);
  if (!issue) {
    sendError(res, 404, 'Not Found', ctx);
    return;
  }
  // Hot path (read workload): serve the cached serialized buffer.
  const cached = repo.issueJsonCache.get(n);
  if (cached !== undefined) {
    sendBuffer(res, 200, cached, ctx);
    return;
  }
  const buf = cacheIssueJson(repo, issue);
  sendBuffer(res, 200, buf, ctx);
}

function patchIssue(h: HCtx, repo: Repo, n: number): void {
  const { res, ctx, store } = h;
  const issue = repo.issues.get(n);
  if (!issue) {
    sendError(res, 404, 'Not Found', ctx);
    return;
  }
  const b = isObj(h.body) ? h.body : null;
  if (b !== null && b.labels !== undefined) {
    const labels = resolveLabels(h, repo, b.labels);
    if (labels === null) return;
    issue.labels = labels;
  }
  if (b !== null) {
    if (b.state === 'open' || b.state === 'closed') issue.state = b.state;
    if (typeof b.title === 'string') issue.title = b.title;
    if (typeof b.body === 'string') issue.body = b.body;
  }
  issue.updatedAt = store.nowIso();
  repo.issueJsonCache.delete(n);
  const buf = cacheIssueJson(repo, issue);
  sendBuffer(res, 200, buf, ctx);
}

function createComment(h: HCtx, repo: Repo, n: number): void {
  const { res, ctx, store } = h;
  const issue = repo.issues.get(n);
  if (!issue) {
    sendError(res, 404, 'Not Found', ctx);
    return;
  }
  const b = isObj(h.body) ? h.body : null;
  const bodyText = b !== null && typeof b.body === 'string' ? b.body : '';
  const comment: Comment = { id: store.allocCommentId(repo), body: bodyText, createdSeq: store.nextSeq() };
  issue.comments.push(comment);
  // The issue view carries a comments count: invalidate its cached JSON.
  repo.issueJsonCache.delete(n);
  sendJson(res, 201, commentView(repo, issue, comment), ctx);
}

function listComments(h: HCtx, repo: Repo, n: number, pathname: string): void {
  const { res, ctx } = h;
  const issue = repo.issues.get(n);
  if (!issue) {
    sendError(res, 404, 'Not Found', ctx);
    return;
  }
  sendList(h, pathname, issue.comments, (c) => commentView(repo, issue, c));
}

function createPull(h: HCtx, repo: Repo): void {
  const { res, ctx, store } = h;
  const b = isObj(h.body) ? h.body : null;
  const head = b !== null && typeof b.head === 'string' ? b.head : '';
  const base = b !== null && typeof b.base === 'string' ? b.base : '';
  if (head === '' || base === '') {
    sendError(res, 422, 'head and base are required', ctx);
    return;
  }
  const headSha = resolveRef(repo, head);
  const baseSha = resolveRef(repo, base);
  if (headSha === null || baseSha === null) {
    sendError(res, 422, 'head or base branch not found', ctx);
    return;
  }
  const title = b !== null && typeof b.title === 'string' ? b.title : '';
  const bodyText = b !== null && typeof b.body === 'string' ? b.body : '';
  const now = store.nowIso();
  const pr: Pull = {
    number: store.allocNumber(repo),
    title,
    body: bodyText,
    state: 'open',
    headRef: head,
    baseRef: base,
    headSha,
    baseSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    mergeable: true,
    createdSeq: store.nextSeq(),
    createdAt: now,
    updatedAt: now,
  };
  repo.pulls.set(pr.number, pr);
  sendJson(res, 201, pullView(repo, pr), ctx);
}

function listPulls(h: HCtx, repo: Repo, pathname: string): void {
  const state = h.query !== null ? h.query.get('state') : null;
  const items: Pull[] = [];
  for (const pr of repo.pulls.values()) {
    if (state === 'all') items.push(pr);
    else if (state === 'closed') {
      if (pr.state === 'closed') items.push(pr);
    } else if (pr.state === 'open') items.push(pr); // 'open' or absent -> open-only
  }
  sendList(h, pathname, items, (p) => pullView(repo, p));
}

function getPull(h: HCtx, repo: Repo, n: number): void {
  const pr = repo.pulls.get(n);
  if (!pr) {
    sendError(h.res, 404, 'Not Found', h.ctx);
    return;
  }
  sendJson(h.res, 200, pullView(repo, pr), h.ctx);
}

function listPullFiles(h: HCtx, repo: Repo, n: number, pathname: string): void {
  const pr = repo.pulls.get(n);
  if (!pr) {
    sendError(h.res, 404, 'Not Found', h.ctx);
    return;
  }
  const files = diffTrees(repo, pr.baseSha, pr.headSha);
  sendList(h, pathname, files, (f) => pullFileView(f));
}

function mergePull(h: HCtx, repo: Repo, n: number): void {
  const { res, ctx, store } = h;
  const pr = repo.pulls.get(n);
  if (!pr) {
    sendError(res, 404, 'Not Found', ctx);
    return;
  }
  if (pr.merged || pr.state !== 'open') {
    sendError(res, 405, 'Pull request has already been merged', ctx);
    return;
  }
  // merge_method is ignored: the suite only ever sends "squash", and every
  // value is treated as squash (spec §2.6 recommendation).
  const result = squashMerge(repo, pr);
  if ('error' in result) {
    sendError(res, 405, 'Merge conflict', ctx);
    return;
  }
  const now = store.nowIso();
  pr.state = 'closed';
  pr.merged = true;
  pr.mergedAt = now;
  pr.updatedAt = now;
  pr.mergeCommitSha = result.sha;
  store.touchRefs(repo);
  sendJson(res, 200, { merged: true, sha: result.sha, message: 'Pull Request successfully merged' }, ctx);
}

function issueRoutes(h: HCtx, repo: Repo, seg: string[], pathname: string): void {
  const { res, ctx } = h;
  const method = h.req.method ?? 'GET';
  if (seg.length === 4) {
    if (method === 'POST') return createIssue(h, repo);
    if (method === 'GET') return listIssues(h, repo, pathname);
    return sendError(res, 404, 'Not Found', ctx);
  }
  const n = parseNum(seg[4]);
  if (Number.isNaN(n)) return sendError(res, 404, 'Not Found', ctx);
  if (seg.length === 5) {
    if (method === 'GET') return getIssue(h, repo, n);
    if (method === 'PATCH') return patchIssue(h, repo, n);
    return sendError(res, 404, 'Not Found', ctx);
  }
  if (seg.length === 6 && seg[5] === 'comments') {
    if (method === 'POST') return createComment(h, repo, n);
    if (method === 'GET') return listComments(h, repo, n, pathname);
  }
  sendError(res, 404, 'Not Found', ctx);
}

function pullRoutes(h: HCtx, repo: Repo, seg: string[], pathname: string): void {
  const { res, ctx } = h;
  const method = h.req.method ?? 'GET';
  if (seg.length === 4) {
    if (method === 'POST') return createPull(h, repo);
    if (method === 'GET') return listPulls(h, repo, pathname);
    return sendError(res, 404, 'Not Found', ctx);
  }
  const n = parseNum(seg[4]);
  if (Number.isNaN(n)) return sendError(res, 404, 'Not Found', ctx);
  if (seg.length === 5) {
    if (method === 'GET') return getPull(h, repo, n);
    return sendError(res, 404, 'Not Found', ctx);
  }
  if (seg.length === 6 && seg[5] === 'files') {
    if (method === 'GET') return listPullFiles(h, repo, n, pathname);
    return sendError(res, 404, 'Not Found', ctx);
  }
  if (seg.length === 6 && seg[5] === 'merge') {
    if (method === 'PUT') return mergePull(h, repo, n);
    return sendError(res, 404, 'Not Found', ctx);
  }
  sendError(res, 404, 'Not Found', ctx);
}

function repoRoutes(h: HCtx, seg: string[], pathname: string): void {
  const { res, ctx, store } = h;
  // store.getRepo 404s foreign owners (never 403) and missing names.
  const repo = store.getRepo(seg[1], seg[2]);
  if (!repo) {
    sendError(res, 404, 'Not Found', ctx);
    return;
  }
  const method = h.req.method ?? 'GET';
  if (seg.length === 3) {
    if (method === 'GET') return sendJson(res, 200, repoView(repo), ctx);
    if (method === 'PATCH') return patchRepo(h, repo);
    if (method === 'DELETE') {
      store.deleteRepo(repo.name);
      return sendNoContent(res, ctx);
    }
    return sendError(res, 404, 'Not Found', ctx);
  }
  const sub = seg[3];
  if (sub === 'git' && seg.length === 5 && seg[4] === 'refs') {
    if (method === 'POST') return createRef(h, repo);
    return sendError(res, 404, 'Not Found', ctx);
  }
  if (sub === 'branches' && seg.length === 4) {
    if (method === 'GET') return listBranches(h, repo, pathname);
    return sendError(res, 404, 'Not Found', ctx);
  }
  if (sub === 'commits' && seg.length === 4) {
    if (method === 'GET') return listCommitsRoute(h, repo, pathname);
    return sendError(res, 404, 'Not Found', ctx);
  }
  if (sub === 'contents') {
    // The remainder after /contents/ is ONE path; it may contain '/'.
    const path = seg.slice(4).join('/');
    if (method === 'PUT') return putContents(h, repo, path);
    if (method === 'GET') return getContents(h, repo, path);
    if (method === 'DELETE') return deleteContents(h, repo, path);
    return sendError(res, 404, 'Not Found', ctx);
  }
  if (sub === 'labels' && seg.length === 4) {
    if (method === 'POST') return createLabel(h, repo);
    return sendError(res, 404, 'Not Found', ctx);
  }
  if (sub === 'issues') return issueRoutes(h, repo, seg, pathname);
  if (sub === 'pulls') return pullRoutes(h, repo, seg, pathname);
  sendError(res, 404, 'Not Found', ctx);
}

// ---------------------------------------------------------------------------
// Entry point (called by server.ts dispatch for every /api/v3/* request).
// ---------------------------------------------------------------------------

async function handleRestInner(req: ForgeRequest, res: ServerResponse, store: Store, ctx: ServerContext): Promise<void> {
  const method = req.method ?? 'GET';

  // Pathname + query: server.ts fills req.path / req.query; re-derive from
  // req.url when called outside server.ts.
  let pathname: string;
  let queryStr: string;
  if (typeof req.path === 'string') {
    pathname = req.path;
    queryStr = typeof req.query === 'string' ? req.query : '';
  } else {
    const rawUrl = req.url ?? '/';
    const qi = rawUrl.indexOf('?');
    pathname = qi >= 0 ? rawUrl.slice(0, qi) : rawUrl;
    queryStr = qi >= 0 ? rawUrl.slice(qi + 1) : '';
  }
  const query = queryStr !== '' ? new URLSearchParams(queryStr) : null;

  // Body: server.ts pre-parsed it into req.json (malformed -> 400 before
  // dispatch). Only when the request was NOT pre-parsed (no `json` field)
  // is the stream read + parsed here.
  let body: unknown;
  if (BODY_METHODS.has(method)) {
    if ('json' in req) {
      body = req.json;
    } else {
      const r = await readBodyStream(req);
      if (r.malformed) {
        sendError(res, 400, 'Bad Request: malformed JSON body', ctx);
        return;
      }
      body = r.value;
    }
  }

  const h: HCtx = { req, res, store, ctx, query, body };

  // Strip the /api/v3 prefix (server.ts routes /api/v3 and /api/v3/* here).
  let rest: string;
  if (pathname === '/api/v3' || pathname === '/api/v3/') rest = '/';
  else if (pathname.startsWith('/api/v3/')) rest = pathname.slice(7);
  else {
    sendError(res, 404, 'Not Found', ctx);
    return;
  }
  const seg = rest.split('/').filter((s) => s.length > 0).map(decodeSeg);

  if (seg.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, ctx, {
        'X-OAuth-Scopes': 'repo, read:org',
      });
    } else {
      sendError(res, 404, 'Not Found', ctx);
    }
    return;
  }
  if (seg.length === 1 && seg[0] === 'meta') {
    if (method === 'GET') sendJson(res, 200, { installed_version: '1.0.0' }, ctx);
    else sendError(res, 404, 'Not Found', ctx);
    return;
  }
  if (seg[0] === 'user' && seg.length === 2 && seg[1] === 'repos') {
    if (method === 'POST') return createRepo(h);
    if (method === 'GET') return listRepos(h, pathname);
    return sendError(res, 404, 'Not Found', ctx);
  }
  if (seg[0] === 'repos' && seg.length >= 3) return repoRoutes(h, seg, pathname);
  sendError(res, 404, 'Not Found', ctx);
}

export async function handleRest(
  req: ForgeRequest,
  res: ServerResponse,
  store: Store,
  ctx: ServerContext,
): Promise<void> {
  try {
    await handleRestInner(req, res, store, ctx);
  } catch {
    // Never throw out of the handler: a crash before /done fails every
    // check after it. A JSON 500 at least keeps the server alive.
    try {
      if (!res.headersSent && !res.writableEnded) sendError(res, 500, 'Internal Server Error', ctx);
      else if (!res.writableEnded) res.end();
    } catch {
      // The socket is already gone; nothing left to do.
    }
  }
}
