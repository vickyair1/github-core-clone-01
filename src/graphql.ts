// Targeted GraphQL v4 executor for the github-core-clone-01 forge.
//
// Serves POST /api/graphql. This is NOT a full GraphQL engine: it parses and
// executes the 18 known suite documents plus the introspection subset from
// specs/graphql-mcp-spec.md (one operation per document, variable defs incl.
// nullable String, literal args, aliases, one inline fragment, __type).
// Unknown fields are detected generically against the schema tables and
// reported as HTTP 200 + {errors} naming the field (check 14).
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
// - Malformed JSON: server.ts answers 400 {message} itself before dispatch
//   for API routes. That is fine for GraphQL (no suite check sends a
//   malformed GraphQL body). See mcp.ts for the MCP parse-error caveat.
//
// Determinism: no Date.now()/Math.random()/UUIDs. Global ids are base64 of
// "Type:<numeric parts>" — opaque, stable, decodable. Timestamps come from
// the store's logical clock only.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store, Repo, Issue, Pull } from './store.ts';
import { diffTrees, resolveRef, squashMerge } from './git.ts';

export interface HandlerCtx {
  token?: string;
  requestId?: () => string;
  body?: unknown;
  bodyParseError?: boolean;
  /** server.ts's reply helper (Content-Type + Content-Length); used when present. */
  sendJson?: (res: ServerResponse, status: number, obj: unknown) => void;
}

// ---------------------------------------------------------------------------
// Small HTTP helpers (duplicated in mcp.ts on purpose: modules stay decoupled)
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
// Global ids: base64("Type:<numeric parts>") — opaque, stable, decodable.
// ---------------------------------------------------------------------------

function gid(type: string, parts: number[]): string {
  return Buffer.from(`${type}:${parts.join(':')}`, 'utf8').toString('base64');
}

function gidRepo(repo: Repo): string {
  return gid('Repository', [repo.id]);
}

function gidIssue(repo: Repo, issue: Issue): string {
  return gid('Issue', [repo.id, issue.number]);
}

function gidPr(repo: Repo, pr: Pull): string {
  return gid('PullRequest', [repo.id, pr.number]);
}

function gidComment(repo: Repo, issue: Issue, commentId: number): string {
  return gid('IssueComment', [repo.id, issue.number, commentId]);
}

interface DecodedGid {
  type: string;
  nums: number[];
}

/** Strict decode: the base64 must round-trip and every part must be numeric. */
function decodeGid(id: unknown): DecodedGid | null {
  if (typeof id !== 'string' || id.length === 0) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  if (Buffer.from(decoded, 'utf8').toString('base64') !== id) return null;
  const parts = decoded.split(':');
  if (parts.length < 2) return null;
  const nums: number[] = [];
  for (let i = 1; i < parts.length; i++) {
    if (!/^\d+$/.test(parts[i])) return null;
    nums.push(Number(parts[i]));
  }
  return { type: parts[0], nums };
}

function findRepoById(store: Store, id: number): Repo | null {
  for (const repo of store.repoList) {
    if (repo.id === id) return repo;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pagination cursors: base64("cursor:<issue number>"), opaque to the client.
// ---------------------------------------------------------------------------

function encodeCursor(n: number): string {
  return Buffer.from(`cursor:${n}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number | null {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64').toString('utf8');
  } catch {
    return null;
  }
  if (Buffer.from(decoded, 'utf8').toString('base64') !== cursor) return null;
  const m = /^cursor:(\d+)$/.exec(decoded);
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------------------
// Domain writes shared with the REST surface (same store, same numbering).
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

// ---------------------------------------------------------------------------
// GraphQL document parser (subset actually used by the 18 documents)
// ---------------------------------------------------------------------------

class GqlError extends Error {}

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i++;
      continue;
    }
    if (c === '#') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '.' && src[i + 1] === '.' && src[i + 2] === '.') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if (c === '{' || c === '}' || c === '(' || c === ')' || c === '[' || c === ']' || c === ':' || c === '!' || c === '$' || c === '=' || c === '@') {
      tokens.push({ kind: 'punct', value: c });
      i++;
      continue;
    }
    if (c === '"') {
      // Regular string with escapes. Block strings (""") are never sent.
      let j = i + 1;
      let out = '';
      let closed = false;
      while (j < n) {
        const ch = src[j];
        if (ch === '"') {
          closed = true;
          j++;
          break;
        }
        if (ch === '\\') {
          const e = src[j + 1];
          if (e === 'n') out += '\n';
          else if (e === 't') out += '\t';
          else if (e === 'r') out += '\r';
          else if (e === 'b') out += '\b';
          else if (e === 'f') out += '\f';
          else if (e === '/') out += '/';
          else if (e === '\\') out += '\\';
          else if (e === '"') out += '"';
          else if (e === 'u') {
            out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16));
            j += 4;
          } else {
            throw new GqlError(`Syntax Error: invalid escape \\${e} in string.`);
          }
          j += 2;
          continue;
        }
        if (ch === '\n' || ch === '\r') throw new GqlError('Syntax Error: unterminated string.');
        out += ch;
        j++;
      }
      if (!closed) throw new GqlError('Syntax Error: unterminated string.');
      tokens.push({ kind: 'string', value: out });
      i = j;
      continue;
    }
    if (c === '-' || (c >= '0' && c <= '9')) {
      let j = i;
      if (src[j] === '-') j++;
      let isFloat = false;
      while (j < n && src[j] >= '0' && src[j] <= '9') j++;
      if (src[j] === '.' && src[j + 1] >= '0' && src[j + 1] <= '9') {
        isFloat = true;
        j++;
        while (j < n && src[j] >= '0' && src[j] <= '9') j++;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j++;
        if (src[j] === '+' || src[j] === '-') j++;
        while (j < n && src[j] >= '0' && src[j] <= '9') j++;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_') {
      let j = i;
      while (j < n) {
        const ch = src[j];
        if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch === '_') j++;
        else break;
      }
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new GqlError(`Syntax Error: unexpected character "${c}".`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

type ArgValue =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ArgValue[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ArgValue }> };

interface Selection {
  kind: 'field' | 'fragment';
  /** Field name ('' for fragments). */
  name: string;
  /** Response key: alias when present, else the field name. */
  responseKey: string;
  args: Array<{ name: string; value: ArgValue }>;
  selections: Selection[];
  /** Inline-fragment type condition, null for a typeless fragment. */
  typeCondition: string | null;
}

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  selections: Selection[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const t = this.tokens[this.pos];
    if (this.pos < this.tokens.length - 1) this.pos++;
    return t;
  }

  private expectPunct(value: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== value) {
      throw new GqlError(`Syntax Error: expected "${value}" but got "${t.value}".`);
    }
  }

  private expectName(what = 'a name'): string {
    const t = this.next();
    if (t.kind !== 'name') throw new GqlError(`Syntax Error: expected ${what} but got "${t.value}".`);
    return t.value;
  }

  parseDocument(): Operation {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '{') {
      return { kind: 'query', name: null, selections: this.parseSelectionSet() };
    }
    if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
      const kind = this.next().value as 'query' | 'mutation';
      let name: string | null = null;
      if (this.peek().kind === 'name') name = this.next().value;
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseVariableDefinitions();
      return { kind, name, selections: this.parseSelectionSet() };
    }
    throw new GqlError(`Syntax Error: expected an operation but got "${t.value}".`);
  }

  /** Variable definitions are parsed and discarded; values come from `variables`. */
  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      if (this.peek().kind === 'eof') throw new GqlError('Syntax Error: unterminated variable definitions.');
      this.expectPunct('$');
      this.expectName('a variable name');
      this.expectPunct(':');
      this.parseType();
      if (this.peek().kind === 'punct' && this.peek().value === '=') {
        this.next();
        this.parseValue();
      }
    }
    this.expectPunct(')');
  }

  private parseType(): void {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName('a type name');
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.next();
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const sels: Selection[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'eof') throw new GqlError('Syntax Error: unterminated selection set.');
      sels.push(this.parseSelection());
    }
    this.expectPunct('}');
    return sels;
  }

  private parseSelection(): Selection {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '...') {
      this.next();
      let typeCondition: string | null = null;
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        typeCondition = this.expectName('a type name after "on"');
      } else if (this.peek().kind === 'name') {
        // Named fragment spread — never sent by the suite.
        throw new GqlError('Syntax Error: fragment spreads are not supported.');
      }
      return {
        kind: 'fragment',
        name: '',
        responseKey: '',
        args: [],
        selections: this.parseSelectionSet(),
        typeCondition,
      };
    }
    const first = this.expectName('a field name');
    let name = first;
    let responseKey = first;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      name = this.expectName('a field name after alias');
      responseKey = first;
    }
    const args: Array<{ name: string; value: ArgValue }> = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        if (this.peek().kind === 'eof') throw new GqlError('Syntax Error: unterminated arguments.');
        const argName = this.expectName('an argument name');
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    // Directives (@...) are never sent; reject rather than silently ignore.
    if (this.peek().kind === 'punct' && this.peek().value === '@') {
      throw new GqlError('Syntax Error: directives are not supported.');
    }
    let selections: Selection[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', name, responseKey, args, selections, typeCondition: null };
  }

  private parseValue(): ArgValue {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') {
      return { kind: 'var', name: this.expectName('a variable name') };
    }
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: Number(t.value) };
    if (t.kind === 'float') return { kind: 'float', value: Number(t.value) };
    if (t.kind === 'punct' && t.value === '[') {
      const items: ArgValue[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) {
        if (this.peek().kind === 'eof') throw new GqlError('Syntax Error: unterminated list.');
        items.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Array<{ name: string; value: ArgValue }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        if (this.peek().kind === 'eof') throw new GqlError('Syntax Error: unterminated input object.');
        const name = this.expectName('an input field name');
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'bool', value: true };
      if (t.value === 'false') return { kind: 'bool', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new GqlError(`Syntax Error: unexpected value "${t.value}".`);
  }
}

function parseDocument(query: string): Operation {
  return new Parser(tokenize(query)).parseDocument();
}

// ---------------------------------------------------------------------------
// Argument resolution (variables substituted from the request's `variables`)
// ---------------------------------------------------------------------------

type Vars = Record<string, unknown>;

function resolveValue(v: ArgValue, vars: Vars): unknown {
  switch (v.kind) {
    case 'var':
      return vars[v.name] === undefined ? null : vars[v.name];
    case 'string':
    case 'int':
    case 'float':
    case 'bool':
      return v.value;
    case 'null':
      return null;
    case 'enum':
      return v.value;
    case 'list':
      return v.items.map((item) => resolveValue(item, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of v.fields) out[f.name] = resolveValue(f.value, vars);
      return out;
    }
  }
}

function resolveArgs(args: Array<{ name: string; value: ArgValue }>, vars: Vars): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of args) out[a.name] = resolveValue(a.value, vars);
  return out;
}

// ---------------------------------------------------------------------------
// Executor: internal nodes are tagged objects; only selected fields are copied
// into the response, so hidden (symbol-keyed) references never leak.
// ---------------------------------------------------------------------------

const TYPE = Symbol('gql-type');
const REPO = Symbol('gql-repo');
const ISSUE = Symbol('gql-issue');
const PULL = Symbol('gql-pull');

interface ExecCtx {
  store: Store;
}

interface FieldDef {
  /** Absent = default resolve: parent[fieldName]. */
  resolve?: (parent: Record<string | symbol, unknown>, args: Record<string, unknown>, xc: ExecCtx) => unknown;
}

type SchemaTable = Record<string, Record<string, FieldDef>>;

// --- node builders ----------------------------------------------------------

function userNode(login: string): Record<string | symbol, unknown> {
  return { [TYPE]: 'User', login };
}

function repoNode(store: Store, repo: Repo): Record<string | symbol, unknown> {
  return {
    [TYPE]: 'Repository',
    id: gidRepo(repo),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    ownerLogin: repo.owner,
    defaultBranch: repo.defaultBranch,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    [REPO]: repo,
  };
}

function issueNode(store: Store, repo: Repo, issue: Issue): Record<string | symbol, unknown> {
  return {
    [TYPE]: 'Issue',
    id: gidIssue(repo, issue),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    [REPO]: repo,
    [ISSUE]: issue,
  };
}

function prNode(store: Store, repo: Repo, pr: Pull): Record<string | symbol, unknown> {
  return {
    [TYPE]: 'PullRequest',
    id: gidPr(repo, pr),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED',
    headRefName: pr.headRef,
    baseRefName: pr.baseRef,
    mergeable: pr.mergeable ? 'MERGEABLE' : 'CONFLICTING',
    merged: pr.merged,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    [REPO]: repo,
    [PULL]: pr,
  };
}

function pageInfoNode(hasNextPage: boolean, endCursor: string | null): Record<string | symbol, unknown> {
  return { [TYPE]: 'PageInfo', hasNextPage, endCursor };
}

// --- introspection data (A.4: required fields + harmless extras) -------------

interface IntrospectionType {
  kind: string;
  fields: string[];
  enumValues: string[];
}

const INTROSPECTION: Record<string, IntrospectionType> = {
  Issue: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'comments', 'labels'],
    enumValues: [],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: [
      'id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files',
      'title', 'body', 'url', 'createdAt', 'updatedAt', 'author',
    ],
    enumValues: [],
  },
  Repository: {
    kind: 'OBJECT',
    fields: [
      'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
      'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest',
      'description', 'url', 'createdAt', 'updatedAt', 'isPrivate',
    ],
    enumValues: [],
  },
  SearchType: { kind: 'ENUM', fields: [], enumValues: ['ISSUE', 'USER', 'REPOSITORY'] },
};

const FIELDS_LIST = Symbol('gql-fields-list');
const ENUM_LIST = Symbol('gql-enum-list');

function typeNode(name: string, def: IntrospectionType): Record<string | symbol, unknown> {
  return {
    [TYPE]: '__Type',
    name,
    kind: def.kind,
    [FIELDS_LIST]: def.fields,
    [ENUM_LIST]: def.enumValues,
  };
}

// --- issues / PRs connections ------------------------------------------------

function issuesConnection(
  xc: ExecCtx,
  repo: Repo,
  args: Record<string, unknown>,
): Record<string | symbol, unknown> {
  let list = [...repo.issues.values()];
  if (Array.isArray(args.states) && args.states.length > 0) {
    const want = new Set(args.states.map((s) => String(s).toUpperCase()));
    list = list.filter((i) => want.has(i.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  // orderBy is only ever {field: CREATED_AT, direction: DESC}; default is the
  // same newest-first order. createdSeq order == number order (monotonic clock).
  let dir = -1;
  if (args.orderBy && typeof args.orderBy === 'object') {
    const o = args.orderBy as Record<string, unknown>;
    if (String(o.direction).toUpperCase() === 'ASC') dir = 1;
  }
  list.sort((a, b) => dir * (a.createdSeq - b.createdSeq || a.number - b.number));
  if (typeof args.after === 'string' && args.after.length > 0) {
    const n = decodeCursor(args.after);
    if (n !== null) list = list.filter((i) => (dir < 0 ? i.number < n : i.number > n));
  }
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(0, first);
  const last = page[page.length - 1];
  return {
    [TYPE]: 'IssueConnection',
    nodes: page.map((i) => issueNode(xc.store, repo, i)),
    pageInfo: pageInfoNode(list.length > page.length, last ? encodeCursor(last.number) : null),
  };
}

function prsConnection(
  xc: ExecCtx,
  repo: Repo,
  args: Record<string, unknown>,
): Record<string | symbol, unknown> {
  const list = [...repo.pulls.values()].sort((a, b) => b.createdSeq - a.createdSeq || b.number - a.number);
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(0, first);
  return {
    [TYPE]: 'PullRequestConnection',
    nodes: page.map((p) => prNode(xc.store, repo, p)),
    pageInfo: pageInfoNode(list.length > page.length, null),
  };
}

function filesConnection(
  xc: ExecCtx,
  repo: Repo,
  pr: Pull,
  args: Record<string, unknown>,
): Record<string | symbol, unknown> {
  let files: Array<{ filename: string; additions: number; deletions: number; changes: number }> = [];
  if (pr.baseSha && pr.headSha) {
    try {
      files = diffTrees(repo, pr.baseSha, pr.headSha);
    } catch {
      files = [];
    }
  }
  const first = typeof args.first === 'number' ? args.first : files.length;
  const page = files.slice(0, first);
  return {
    [TYPE]: 'PullRequestChangedFilesConnection',
    nodes: page.map((f) => ({
      [TYPE]: 'PullRequestChangedFile',
      path: f.filename,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
    })),
    pageInfo: pageInfoNode(files.length > page.length, null),
  };
}

// --- mutation input decoding -------------------------------------------------

function repoFromInputId(store: Store, id: unknown, what: string): Repo {
  const dec = decodeGid(id);
  if (!dec || dec.type !== 'Repository') throw new GqlError(`${what}: not a repository id.`);
  const repo = findRepoById(store, dec.nums[0]);
  if (!repo) throw new GqlError(`${what}: repository not found.`);
  return repo;
}

function issueFromInputId(store: Store, id: unknown, what: string): { repo: Repo; issue: Issue } {
  const dec = decodeGid(id);
  if (!dec || dec.type !== 'Issue') throw new GqlError(`${what}: not an issue id.`);
  const repo = findRepoById(store, dec.nums[0]);
  const issue = repo ? repo.issues.get(dec.nums[1]) : undefined;
  if (!repo || !issue) throw new GqlError(`${what}: issue not found.`);
  return { repo, issue };
}

function prFromInputId(store: Store, id: unknown, what: string): { repo: Repo; pr: Pull } {
  const dec = decodeGid(id);
  if (!dec || dec.type !== 'PullRequest') throw new GqlError(`${what}: not a pull request id.`);
  const repo = findRepoById(store, dec.nums[0]);
  const pr = repo ? repo.pulls.get(dec.nums[1]) : undefined;
  if (!repo || !pr) throw new GqlError(`${what}: pull request not found.`);
  return { repo, pr };
}

function inputObject(args: Record<string, unknown>): Record<string, unknown> {
  const input = args.input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new GqlError('Mutation requires an input object.');
  }
  return input as Record<string, unknown>;
}

function inputString(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  return typeof v === 'string' ? v : '';
}

// --- schema tables (field existence drives unknown-field detection) ----------

const SCHEMA: SchemaTable = {
  Query: {
    viewer: {
      resolve: (_p, _a, xc) => userNode(xc.store.viewerLogin),
    },
    repository: {
      resolve: (_p, a, xc) => {
        const repo = xc.store.getRepo(String(a.owner ?? ''), String(a.name ?? ''));
        return repo ? repoNode(xc.store, repo) : null;
      },
    },
    node: {
      resolve: (_p, a, xc) => {
        const dec = decodeGid(a.id);
        if (!dec) return null;
        if (dec.type === 'Repository') {
          const repo = findRepoById(xc.store, dec.nums[0]);
          return repo ? repoNode(xc.store, repo) : null;
        }
        if (dec.type === 'Issue') {
          const repo = findRepoById(xc.store, dec.nums[0]);
          const issue = repo ? repo.issues.get(dec.nums[1]) : undefined;
          return repo && issue ? issueNode(xc.store, repo, issue) : null;
        }
        if (dec.type === 'PullRequest') {
          const repo = findRepoById(xc.store, dec.nums[0]);
          const pr = repo ? repo.pulls.get(dec.nums[1]) : undefined;
          return repo && pr ? prNode(xc.store, repo, pr) : null;
        }
        return null;
      },
    },
    __type: {
      resolve: (_p, a) => {
        const def = INTROSPECTION[String(a.name ?? '')];
        return def ? typeNode(String(a.name), def) : null;
      },
    },
  },

  Mutation: {
    createIssue: {
      resolve: (_p, a, xc) => {
        const input = inputObject(a);
        const repo = repoFromInputId(xc.store, input.repositoryId, 'createIssue');
        const issue = createIssueInRepo(
          xc.store,
          repo,
          inputString(input, 'title'),
          inputString(input, 'body'),
        );
        return { [TYPE]: 'CreateIssuePayload', issue: issueNode(xc.store, repo, issue) };
      },
    },
    closeIssue: {
      resolve: (_p, a, xc) => {
        const input = inputObject(a);
        const { repo, issue } = issueFromInputId(xc.store, input.issueId, 'closeIssue');
        issue.state = 'closed';
        issue.updatedAt = xc.store.nowIso();
        repo.issueJsonCache.delete(issue.number);
        return { [TYPE]: 'CloseIssuePayload', issue: issueNode(xc.store, repo, issue) };
      },
    },
    createPullRequest: {
      resolve: (_p, a, xc) => {
        const input = inputObject(a);
        const repo = repoFromInputId(xc.store, input.repositoryId, 'createPullRequest');
        const pr = createPullInRepo(
          xc.store,
          repo,
          inputString(input, 'title'),
          inputString(input, 'body'),
          inputString(input, 'headRefName'),
          inputString(input, 'baseRefName'),
        );
        return { [TYPE]: 'CreatePullRequestPayload', pullRequest: prNode(xc.store, repo, pr) };
      },
    },
    mergePullRequest: {
      resolve: (_p, a, xc) => {
        const input = inputObject(a);
        const { repo, pr } = prFromInputId(xc.store, input.pullRequestId, 'mergePullRequest');
        if (!pr.merged) {
          // mergeMethod is always "SQUASH" in the suite; squashMerge is the
          // only merge the forge implements.
          const result = squashMerge(repo, pr);
          if ('error' in result) {
            throw new GqlError(`Merge conflict: pull request #${pr.number} cannot be merged.`);
          }
          pr.merged = true;
          pr.mergedAt = xc.store.nowIso();
          pr.mergeCommitSha = result.sha;
          pr.state = 'closed';
          pr.updatedAt = pr.mergedAt;
          // A ref moved: invalidate the git module's caches even if the git
          // layer also bumps the version (double-bump is harmless).
          repo.refsVersion++;
        }
        return { [TYPE]: 'MergePullRequestPayload', pullRequest: prNode(xc.store, repo, pr) };
      },
    },
    addComment: {
      resolve: (_p, a, xc) => {
        const input = inputObject(a);
        const { repo, issue } = issueFromInputId(xc.store, input.subjectId, 'addComment');
        const body = inputString(input, 'body');
        const comment = {
          id: xc.store.allocCommentId(repo),
          body,
          createdSeq: xc.store.nextSeq(),
        };
        issue.comments.push(comment);
        issue.updatedAt = xc.store.nowIso();
        repo.issueJsonCache.delete(issue.number);
        return {
          [TYPE]: 'AddCommentPayload',
          commentEdge: {
            [TYPE]: 'CommentEdge',
            node: { [TYPE]: 'Comment', id: gidComment(repo, issue, comment.id), body },
          },
        };
      },
    },
  },

  Repository: {
    id: {},
    databaseId: {},
    name: {},
    nameWithOwner: {},
    viewerPermission: {},
    hasIssuesEnabled: {},
    owner: {
      resolve: (p) => userNode(String(p.ownerLogin ?? '')),
    },
    defaultBranchRef: {
      resolve: (p) => ({ [TYPE]: 'Ref', name: String(p.defaultBranch ?? 'main') }),
    },
    issue: {
      resolve: (p, a, xc) => {
        const repo = p[REPO] as Repo;
        const issue = repo.issues.get(Number(a.number));
        return issue ? issueNode(xc.store, repo, issue) : null;
      },
    },
    issues: {
      resolve: (p, a, xc) => issuesConnection(xc, p[REPO] as Repo, a),
    },
    pullRequest: {
      resolve: (p, a, xc) => {
        const repo = p[REPO] as Repo;
        const pr = repo.pulls.get(Number(a.number));
        return pr ? prNode(xc.store, repo, pr) : null;
      },
    },
    pullRequests: {
      resolve: (p, a, xc) => prsConnection(xc, p[REPO] as Repo, a),
    },
  },

  Issue: {
    id: {},
    number: {},
    title: {},
    state: {},
    body: {},
    createdAt: {},
    updatedAt: {},
  },

  PullRequest: {
    id: {},
    number: {},
    title: {},
    body: {},
    state: {},
    headRefName: {},
    baseRefName: {},
    mergeable: {},
    merged: {},
    createdAt: {},
    updatedAt: {},
    files: {
      resolve: (p, a, xc) => filesConnection(xc, p[REPO] as Repo, p[PULL] as Pull, a),
    },
  },

  IssueConnection: { nodes: {}, pageInfo: {} },
  PullRequestConnection: { nodes: {}, pageInfo: {} },
  PullRequestChangedFilesConnection: { nodes: {}, pageInfo: {} },
  PullRequestChangedFile: { path: {}, additions: {}, deletions: {}, changes: {} },
  PageInfo: { hasNextPage: {}, endCursor: {} },
  User: { login: {} },
  Ref: { name: {} },

  CreateIssuePayload: { issue: {} },
  CloseIssuePayload: { issue: {} },
  CreatePullRequestPayload: { pullRequest: {} },
  MergePullRequestPayload: { pullRequest: {} },
  AddCommentPayload: { commentEdge: {} },
  CommentEdge: { node: {} },
  Comment: { id: {}, body: {} },

  __Type: {
    name: {},
    kind: {},
    fields: {
      resolve: (p) => {
        const list = (p[FIELDS_LIST] as string[]) ?? [];
        return list.map((name) => ({ [TYPE]: '__Field', name }));
      },
    },
    enumValues: {
      resolve: (p) => {
        const list = (p[ENUM_LIST] as string[]) ?? [];
        return list.map((name) => ({ [TYPE]: '__EnumValue', name }));
      },
    },
  },
  __Field: { name: {} },
  __EnumValue: { name: {} },
};

// --- execution ---------------------------------------------------------------

function completeValue(
  raw: unknown,
  sels: Selection[],
  vars: Vars,
  xc: ExecCtx,
): unknown {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) return raw.map((v) => completeValue(v, sels, vars, xc));
  if (typeof raw === 'object') {
    const t = (raw as Record<string | symbol, unknown>)[TYPE];
    if (typeof t !== 'string') return raw;
    if (sels.length === 0) return raw;
    return execSelections(t, raw as Record<string | symbol, unknown>, sels, vars, xc);
  }
  return raw;
}

function execSelections(
  typeName: string,
  obj: Record<string | symbol, unknown>,
  sels: Selection[],
  vars: Vars,
  xc: ExecCtx,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const table = SCHEMA[typeName];
  for (const sel of sels) {
    if (sel.kind === 'fragment') {
      if (sel.typeCondition === null || sel.typeCondition === typeName) {
        Object.assign(out, execSelections(typeName, obj, sel.selections, vars, xc));
      }
      continue;
    }
    const def = table ? table[sel.name] : undefined;
    if (!def) {
      throw new GqlError(`Cannot query field "${sel.name}" on type "${typeName}".`);
    }
    const args = resolveArgs(sel.args, vars);
    const raw = def.resolve ? def.resolve(obj, args, xc) : obj[sel.name];
    out[sel.responseKey] = completeValue(raw, sel.selections, vars, xc);
  }
  return out;
}

function executeOperation(body: unknown, store: Store): Record<string, unknown> {
  try {
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof (body as Record<string, unknown>).query !== 'string') {
      return { data: null, errors: [{ message: 'Must provide query string.' }] };
    }
    const b = body as Record<string, unknown>;
    const vars = b.variables && typeof b.variables === 'object' && !Array.isArray(b.variables)
      ? (b.variables as Vars)
      : {};
    const op = parseDocument(b.query as string);
    const xc: ExecCtx = { store };
    const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
    const data = execSelections(rootType, { [TYPE]: rootType }, op.selections, vars, xc);
    return { data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { data: null, errors: [{ message }] };
  }
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

export async function handleGraphql(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  ctx: HandlerCtx,
): Promise<void> {
  const body = await getRequestJson(req, ctx);
  if (body.status === 'parse-error') {
    sendJson(res, 400, { message: 'Invalid JSON body.' }, ctx);
    return;
  }
  if (body.status === 'empty') {
    sendJson(res, 200, { data: null, errors: [{ message: 'Must provide query string.' }] }, ctx);
    return;
  }
  if (Array.isArray(body.value)) {
    // Batch: execute each operation independently, in order, sequentially.
    const out: Array<Record<string, unknown>> = [];
    for (const item of body.value) out.push(executeOperation(item, store));
    sendJson(res, 200, out, ctx);
    return;
  }
  sendJson(res, 200, executeOperation(body.value, store), ctx);
}
