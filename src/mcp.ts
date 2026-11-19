// MCP (Model Context Protocol) endpoint for the github-core-clone-01 forge.
//
// Serves POST /mcp as JSON-RPC 2.0 over Streamable HTTP, answering plain JSON
// (never SSE). BOTH eras are implemented:
//  - Modern (2026-07-28): server/discover returns supportedVersions +
//    capabilities + serverInfo; no session, no handshake.
//  - Legacy (2025-11-25 -> 2024-11-05): initialize accepts the FIRST offered
//    revision with a result (never -32602, which would only advance the walk);
//    no Mcp-Session-Id is issued (optional), notifications are 202'd.
// The suite's connect() probes discover first, so in practice the era is
// modern; initialize exists so a legacy-only client still connects.
//
// INTEGRATION CONTRACT (server.ts — real, verified against repo/src/server.ts):
// - Auth is enforced by server.ts before dispatch; this module never checks it.
// - Handlers receive server.ts's ForgeRequest (the IncomingMessage plus
//   `path`, `query`, `body: Buffer` (raw bytes) and `json` (parsed body)).
//   This handler reads the request JSON from `json` first (already parsed),
//   then `body` (Buffer/string/object), then `rawBody`/`raw`, then the
//   request stream itself — so it also works standalone (smoke test) and
//   under any future server.ts that attaches a pre-parsed body.
// - Replies go through ctx.sendJson when server.ts provides it (its helper
//   sets Content-Type + Content-Length); otherwise a local fallback.
// - ⚠️ PARSE-ERROR CAVEAT (MCP check 10): server.ts currently answers
//   malformed JSON on ALL API routes with 400 {message} BEFORE dispatch,
//   so this handler never sees a malformed MCP body. Check 10 requires
//   HTTP 400 + JSON-RPC error -32700 with an `id` key — the generic
//   {message} body FAILS it. server.ts must special-case /mcp: either
//   answer the -32700 envelope itself in the JSON-parse catch, or set
//   (req as any).bodyParseError = true and dispatch to this handler
//   anyway (this handler then emits the -32700 answer — see the
//   getRequestJson flag check). Until that lands, check 10 fails through
//   the real server even though this module answers -32700 correctly
//   when it does the parsing itself (proven by the smoke test).
//
// Tools mutate the same store REST uses, so cross-surface effects are visible
// over REST (checks 5/7/8/14). tools/list is a frozen constant: byte-identical
// across calls (check 13). No Date.now()/Math.random()/UUIDs anywhere.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store, Repo, Issue, Pull } from './store.ts';
import { resolveRef, squashMerge } from './git.ts';

export interface HandlerCtx {
  token?: string;
  requestId?: () => string;
  body?: unknown;
  bodyParseError?: boolean;
  /** server.ts's reply helper (Content-Type + Content-Length); used when present. */
  sendJson?: (res: ServerResponse, status: number, obj: unknown) => void;
}

// ---------------------------------------------------------------------------
// Small HTTP helpers (duplicated in graphql.ts on purpose: decoupled modules)
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 10 * 1024 * 1024;

type BodyRead =
  | { status: 'ok'; value: unknown }
  | { status: 'parse-error' }
  | { status: 'empty' };

async function readStreamBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buf.length;
    if (total > MAX_BODY_BYTES) break;
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseJsonText(text: string): BodyRead {
  if (text.length === 0) return { status: 'empty' };
  try {
    return { status: 'ok', value: JSON.parse(text) };
  } catch {
    return { status: 'parse-error' };
  }
}

/** Resolve the request JSON body from every channel server.ts might use. */
async function getRequestJson(req: IncomingMessage, ctx: HandlerCtx): Promise<BodyRead> {
  const r = req as unknown as Record<string, unknown>;
  if (r.bodyParseError === true || ctx.bodyParseError === true) return { status: 'parse-error' };
  // server.ts's ForgeRequest carries the already-parsed body as `json`.
  if (r.json !== undefined) return { status: 'ok', value: r.json };
  const pre = r.body !== undefined ? r.body : r.parsedBody !== undefined ? r.parsedBody : ctx.body;
  if (pre !== undefined) {
    if (typeof pre === 'string') return parseJsonText(pre);
    if (Buffer.isBuffer(pre)) return parseJsonText(pre.toString('utf8'));
    return { status: 'ok', value: pre };
  }
  const raw = r.rawBody !== undefined ? r.rawBody : r.raw;
  if (raw !== undefined) {
    if (typeof raw === 'string') return parseJsonText(raw);
    if (Buffer.isBuffer(raw)) return parseJsonText(raw.toString('utf8'));
    return { status: 'parse-error' };
  }
  return parseJsonText(await readStreamBody(req));
}

function sendJson(res: ServerResponse, status: number, obj: unknown, ctx: HandlerCtx): void {
  if (typeof ctx.sendJson === 'function') {
    ctx.sendJson(res, status, obj);
    return;
  }
  if (res.writableEnded) return;
  res.statusCode = status;
  if (!res.hasHeader('content-type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (!res.hasHeader('x-github-request-id') && typeof ctx.requestId === 'function') {
    try {
      res.setHeader('X-GitHub-Request-Id', ctx.requestId());
    } catch {
      // header already sent or ctx broken: the body still goes out
    }
  }
  if (status === 204) {
    res.end();
    return;
  }
  res.end(JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// Identity / protocol
// ---------------------------------------------------------------------------

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const MODERN_REVISION = '2026-07-28';
const FALLBACK_LEGACY_REVISION = '2025-11-25';

const REVISION_RE = /^\d{4}-\d{2}-\d{2}$/;

// JSON-RPC error codes used by the suite.
const ERR_PARSE = -32700;
const ERR_INVALID_REQUEST = -32600;
const ERR_METHOD_NOT_FOUND = -32601;
const ERR_INVALID_PARAMS = -32602;

type JsonRpcId = string | number | null;

function rpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

// ---------------------------------------------------------------------------
// Tools: exactly the six canonical names, fixed order, frozen schemas.
// tools/list returns this constant verbatim, so two calls are byte-identical.
// `required` lists ONLY properties the suite can fill (mapArguments trap).
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        private: { type: 'boolean' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        state: { type: 'string' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        head: { type: 'string' },
        base: { type: 'string' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        pull_number: { type: 'integer' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const REQUIRED: Record<string, string[]> = {
  create_repo: ['name'],
  get_repo: ['owner', 'repo'],
  create_issue: ['owner', 'repo', 'title'],
  list_issues: ['owner', 'repo'],
  create_pull_request: ['owner', 'repo', 'title', 'head', 'base'],
  merge_pull_request: ['owner', 'repo', 'pull_number'],
};

/** Accepted aliases per the suite's MCP_TOOL_ALIASES (same matching rule). */
const TOOL_ALIASES: Record<string, string[]> = {
  create_repo: ['create_repository', 'repo_create', 'repos_create', 'repository_create'],
  get_repo: ['get_repository', 'repo_get', 'repos_get', 'repository_get'],
  create_issue: ['issue_create', 'issues_create'],
  list_issues: ['issues_list', 'issue_list'],
  create_pull_request: ['pull_request_create', 'pulls_create', 'create_pr', 'pr_create'],
  merge_pull_request: ['pull_request_merge', 'pulls_merge', 'merge_pr', 'pr_merge'],
};

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Resolve a tools/call name to a canonical tool, using the suite's own
 * findTool() rule: exact normalized match (canonical or alias) first, then
 * the server-prefix suffix rule (a longer normalized name ending with a
 * canonical name, e.g. github__create_issue).
 */
function resolveTool(name: string): string | null {
  const norm = normalizeName(name);
  if (norm === '') return null;
  for (const tool of TOOLS) {
    if (normalizeName(tool.name) === norm) return tool.name;
    for (const alias of TOOL_ALIASES[tool.name] ?? []) {
      if (normalizeName(alias) === norm) return tool.name;
    }
  }
  for (const tool of TOOLS) {
    const canon = normalizeName(tool.name);
    if (norm.length > canon.length && norm.endsWith(canon)) return tool.name;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tool result shapes (B.6): text block carrying the full JSON AND
// structuredContent carrying the same object, so the suite's resultText and
// resultJson helpers both find what they need.
// ---------------------------------------------------------------------------

function toolOkResult(obj: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(obj) }],
    structuredContent: obj,
    isError: false,
  };
}

function toolErrorResult(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// Argument helpers (canonical names first; synonyms + full_name defensively)
// ---------------------------------------------------------------------------

type Args = Record<string, unknown>;

function strArg(args: Args, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const v = args[key];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

/** owner/repo from canonical args, synonym args, or a "owner/repo" full_name. */
function repoRef(args: Args): { owner: string; repo: string } | null {
  let owner = strArg(args, 'owner', 'owner_login', 'org', 'organization', 'user', 'login');
  let repo = strArg(args, 'repo', 'repository', 'repo_name', 'repository_name');
  if (!repo && typeof args.full_name === 'string') {
    const idx = args.full_name.indexOf('/');
    if (idx > 0) {
      if (!owner) owner = args.full_name.slice(0, idx);
      repo = args.full_name.slice(idx + 1);
    }
  }
  if (!owner || !repo) return null;
  return { owner, repo };
}

function intArg(args: Args, ...keys: string[]): number | null {
  for (const key of keys) {
    const v = args[key];
    if (typeof v === 'number' && Number.isInteger(v)) return v;
    if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Domain writes (same store, same numbering as REST/GraphQL)
// ---------------------------------------------------------------------------

function createIssueInRepo(store: Store, repo: Repo, title: string, body: string): Issue {
  const now = store.nowIso();
  const issue: Issue = {
    number: store.allocNumber(repo),
    title,
    body,
    state: 'open',
    labels: [],
    comments: [],
    createdSeq: store.nextSeq(),
    createdAt: now,
    updatedAt: now,
  };
  repo.issues.set(issue.number, issue);
  repo.issueJsonCache.delete(issue.number);
  return issue;
}

function createPullInRepo(
  store: Store,
  repo: Repo,
  title: string,
  body: string,
  headRef: string,
  baseRef: string,
): Pull {
  const now = store.nowIso();
  const pr: Pull = {
    number: store.allocNumber(repo),
    title,
    body,
    state: 'open',
    headRef,
    baseRef,
    headSha: resolveRef(repo, headRef) ?? '',
    baseSha: resolveRef(repo, baseRef) ?? '',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    mergeable: true,
    createdSeq: store.nextSeq(),
    createdAt: now,
    updatedAt: now,
  };
  repo.pulls.set(pr.number, pr);
  return pr;
}

// REST-flavoured view built from the domain object (NOT rest.ts's builder).
function repoObject(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function issueObject(issue: Issue): Record<string, unknown> {
  return {
    id: issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
  };
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

function runTool(canonical: string, args: Args, store: Store): Record<string, unknown> {
  switch (canonical) {
    case 'create_repo': {
      const name = strArg(args, 'name') ?? '';
      const description = typeof args.description === 'string' ? args.description : '';
      const priv = args.private === true;
      const repo = store.createRepo(name, priv, description);
      if (!repo) return toolErrorResult(`Repository "${name}" already exists.`);
      return toolOkResult(repoObject(repo));
    }
    case 'get_repo': {
      const ref = repoRef(args);
      if (!ref) return toolErrorResult('Missing owner/repo.');
      const repo = store.getRepo(ref.owner, ref.repo);
      if (!repo) return toolErrorResult(`Repository ${ref.owner}/${ref.repo} not found.`);
      return toolOkResult(repoObject(repo));
    }
    case 'create_issue': {
      const ref = repoRef(args);
      if (!ref) return toolErrorResult('Missing owner/repo.');
      const repo = store.getRepo(ref.owner, ref.repo);
      if (!repo) return toolErrorResult(`Repository ${ref.owner}/${ref.repo} not found.`);
      const issue = createIssueInRepo(
        store,
        repo,
        strArg(args, 'title') ?? '',
        typeof args.body === 'string' ? args.body : '',
      );
      return toolOkResult(issueObject(issue));
    }
    case 'list_issues': {
      const ref = repoRef(args);
      if (!ref) return toolErrorResult('Missing owner/repo.');
      const repo = store.getRepo(ref.owner, ref.repo);
      if (!repo) return toolErrorResult(`Repository ${ref.owner}/${ref.repo} not found.`);
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'all';
      let list = [...repo.issues.values()];
      if (state === 'open') list = list.filter((i) => i.state === 'open');
      else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
      list.sort((a, b) => b.number - a.number);
      const items = list.map((i) => issueObject(i));
      return {
        content: [{ type: 'text', text: JSON.stringify(items) }],
        structuredContent: { issues: items },
        isError: false,
      };
    }
    case 'create_pull_request': {
      const ref = repoRef(args);
      if (!ref) return toolErrorResult('Missing owner/repo.');
      const repo = store.getRepo(ref.owner, ref.repo);
      if (!repo) return toolErrorResult(`Repository ${ref.owner}/${ref.repo} not found.`);
      const pr = createPullInRepo(
        store,
        repo,
        strArg(args, 'title') ?? '',
        typeof args.body === 'string' ? args.body : '',
        strArg(args, 'head', 'head_ref', 'head_branch') ?? '',
        strArg(args, 'base', 'base_ref', 'base_branch') ?? '',
      );
      return toolOkResult({
        id: pr.number,
        number: pr.number,
        title: pr.title,
        body: pr.body,
        state: 'open',
        head: pr.headRef,
        base: pr.baseRef,
        merged: false,
      });
    }
    case 'merge_pull_request': {
      const ref = repoRef(args);
      if (!ref) return toolErrorResult('Missing owner/repo.');
      const repo = store.getRepo(ref.owner, ref.repo);
      if (!repo) return toolErrorResult(`Repository ${ref.owner}/${ref.repo} not found.`);
      const n = intArg(args, 'pull_number', 'pull_request_number', 'pr_number', 'number');
      if (n === null) return toolErrorResult('pull_number must be an integer.');
      const pr = repo.pulls.get(n);
      if (!pr) return toolErrorResult(`Pull request #${n} not found.`);
      if (pr.merged) {
        return toolOkResult({ number: pr.number, merged: true, state: 'closed' });
      }
      const result = squashMerge(repo, pr);
      if ('error' in result) {
        return toolErrorResult(`Merge conflict: pull request #${n} cannot be merged.`);
      }
      pr.merged = true;
      pr.mergedAt = store.nowIso();
      pr.mergeCommitSha = result.sha;
      pr.state = 'closed';
      pr.updatedAt = pr.mergedAt;
      repo.refsVersion++;
      return toolOkResult({
        number: pr.number,
        merged: true,
        state: 'closed',
        merge_commit_sha: result.sha,
      });
    }
    default:
      return toolErrorResult(`Unknown tool: ${canonical}`);
  }
}

function callTool(id: JsonRpcId, params: Record<string, unknown>, store: Store): Record<string, unknown> {
  const name = typeof params.name === 'string' ? params.name : '';
  const rawArgs = params.arguments;
  const args: Args =
    rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? (rawArgs as Args) : {};
  const canonical = resolveTool(name);
  // Unknown tool: JSON-RPC error -32602 (check 9 accepts -32602 or -32601).
  // An isError result here would FAIL the check — it must be a protocol error.
  if (!canonical) return rpcError(id, ERR_INVALID_PARAMS, `Unknown tool: ${name}`);
  const missing = (REQUIRED[canonical] ?? []).filter((k) => args[k] === undefined || args[k] === null);
  if (missing.length > 0) {
    return rpcError(id, ERR_INVALID_PARAMS, `Missing required argument(s): ${missing.join(', ')}`);
  }
  try {
    return rpcResult(id, runTool(canonical, args, store));
  } catch (err) {
    // A tool must never crash the handler or 500: report a tool-level error.
    const message = err instanceof Error ? err.message : String(err);
    return rpcResult(id, toolErrorResult(message));
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC dispatch (one message; returns null for notifications)
// ---------------------------------------------------------------------------

function dispatchRpc(msg: unknown, store: Store): Record<string, unknown> | null {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return rpcError(null, ERR_INVALID_REQUEST, 'Invalid Request');
  }
  const m = msg as Record<string, unknown>;
  const hasId = Object.prototype.hasOwnProperty.call(m, 'id');
  const id: JsonRpcId = hasId && (typeof m.id === 'string' || typeof m.id === 'number') ? m.id : null;
  const method = m.method;
  if (typeof method !== 'string') {
    if (!hasId) return null;
    return rpcError(id, ERR_INVALID_REQUEST, 'Invalid Request: missing method.');
  }
  if (!hasId) {
    // Notification (e.g. notifications/initialized): no response body.
    return null;
  }
  const params: Record<string, unknown> =
    m.params && typeof m.params === 'object' && !Array.isArray(m.params)
      ? (m.params as Record<string, unknown>)
      : {};
  switch (method) {
    case 'server/discover':
      // Modern era: we speak the preferred revision, so never -32022.
      return rpcResult(id, {
        supportedVersions: [MODERN_REVISION],
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    case 'initialize': {
      // Legacy era: accept the FIRST offered revision with a result. Only a
      // -32602 advances the client's revision walk; any other error aborts
      // the handshake, so never refuse here.
      const offered = params.protocolVersion;
      const negotiated =
        typeof offered === 'string' && REVISION_RE.test(offered) ? offered : FALLBACK_LEGACY_REVISION;
      return rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case 'tools/list':
      // Single page, no nextCursor; the same constant every time.
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call':
      return callTool(id, params, store);
    case 'ping':
      return rpcResult(id, {});
    default:
      return rpcError(id, ERR_METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

export async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  ctx: HandlerCtx,
): Promise<void> {
  if (req.method === 'DELETE') {
    // Legacy session close: best-effort, client ignores the answer.
    sendJson(res, 204, null, ctx);
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, rpcError(null, ERR_METHOD_NOT_FOUND, 'Method not allowed.'), ctx);
    return;
  }
  const body = await getRequestJson(req, ctx);
  if (body.status === 'parse-error' || body.status === 'empty') {
    // Check 10 (modern era): HTTP 400 + JSON-RPC -32700, id key present.
    sendJson(res, 400, rpcError(null, ERR_PARSE, 'Parse error'), ctx);
    return;
  }
  if (Array.isArray(body.value)) {
    // JSON-RPC batch (never sent by the suite; handled defensively).
    const out: Array<Record<string, unknown>> = [];
    for (const item of body.value) {
      const r = dispatchRpc(item, store);
      if (r) out.push(r);
    }
    if (out.length === 0) {
      // Batch of notifications only: HTTP 2xx, no JSON-RPC body.
      sendJson(res, 202, {}, ctx);
      return;
    }
    sendJson(res, 200, out, ctx);
    return;
  }
  const response = dispatchRpc(body.value, store);
  if (response === null) {
    // Notification: HTTP 2xx; the client ignores the answer.
    sendJson(res, 202, {}, ctx);
    return;
  }
  sendJson(res, 200, response, ctx);
}
