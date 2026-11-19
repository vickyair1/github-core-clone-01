// The forge's HTTP front door: node:http only, no framework.
//
// Shape (see ARCHITECTURE.md "server.ts — contract"):
//   - hand-rolled router on the raw URL string: string prefix checks, no
//     regex per request, no middleware chain;
//   - /healthz answers 200 JSON with NO auth; every other known route
//     requires `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>` (401 otherwise);
//   - bodies are read with a 10 MB cap; API routes get JSON-parsed bodies
//     (malformed JSON -> 400), git routes get RAW BINARY bodies, never
//     JSON-parsed;
//   - every reply carries Content-Type application/json (except git
//     responses, which carry their own git content types) and a non-empty
//     X-GitHub-Request-Id: req-<counter> (set here, once per request, so
//     handlers never have to think about it);
//   - keep-alive is node's default; this server NEVER sends
//     Connection: close.
//
// The read benchmark GETs one issue 2,000x on one keep-alive connection,
// so the hot path (route -> auth -> handler -> cached buffer) must do as
// little as possible: one indexOf to split the query, a few startsWith
// checks, one timing-safe token compare, no per-request regex, no UUIDs,
// no Date. Handlers send pre-serialized bodies through ctx.sendBuffer.

import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { Store } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGit } from './git.ts';

/** The content type of every JSON reply (REST, GraphQL, MCP, errors). */
export const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/** Largest request body accepted (packs are ~88 KB, contents ~2 KB). */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

/** Shared empty buffer (avoids allocating one per empty body). */
const EMPTY_BUFFER: Buffer = Buffer.alloc(0);

/**
 * What the surface handlers receive alongside the store. Built once per
 * process by createContext and shared by the server and every handler, so
 * the request-id counter is process-wide and monotonic.
 *
 * Handlers MUST use these helpers to answer (never res.writeHead /
 * res.end directly for JSON): they set the JSON content type and the
 * content length, and they are safe to call after a response was already
 * sent (a no-op then, so a double-send bug degrades to a log line in the
 * server's catch instead of a thrown error).
 */
export interface ServerContext {
  /** The bearer token every API call must carry ('' = auth disabled, dev only). */
  readonly token: string;
  /** The next request id (`req-<counter>`), unique per response. */
  requestId(): string;
  /** Send a JSON object as the response body (status 204 sends no body). */
  sendJson(res: http.ServerResponse, status: number, obj: unknown): void;
  /** Send a JSON `{message}` error body. */
  sendError(res: http.ServerResponse, status: number, message: string): void;
  /** Send a pre-serialized JSON buffer (the issue-JSON cache path). */
  sendBuffer(res: http.ServerResponse, status: number, body: Buffer): void;
}

/**
 * The request object the surface handlers receive: node's IncomingMessage
 * plus the fields the router filled in. `path` is the pathname without
 * the query string; `query` is the raw query string without the leading
 * `?` ('' when absent) — handlers parse it themselves, cheaply, only
 * when they need a parameter. `body` holds the raw request bytes for
 * POST/PUT/PATCH/DELETE (EMPTY_BUFFER when there was no body);
 * `json` holds the parsed JSON body for API routes (undefined when the
 * body was empty). Git handlers read `body` only; API handlers read
 * `json` (and `body` never). `bodyParseError` is true when an /mcp
 * request's body was not parseable JSON: the MCP handler is still
 * dispatched (it answers the JSON-RPC -32700 parse error itself —
 * mcp/parse-error requires HTTP 400 + a -32700 envelope with an `id`
 * key, which the generic 400 {message} body does not have).
 */
export interface ForgeRequest extends http.IncomingMessage {
  path: string;
  query: string;
  body: Buffer;
  json: unknown;
  bodyParseError: boolean;
}

/** A surface handler: REST, GraphQL, MCP, or git smart-HTTP. */
export type SurfaceHandler = (
  req: ForgeRequest,
  res: http.ServerResponse,
  store: Store,
  ctx: ServerContext,
) => Promise<void> | void;

/** Build the shared context for one process. The token comes from the environment. */
export function createContext(token: string): ServerContext {
  let counter = 0;
  const requestId = (): string => {
    counter += 1;
    return `req-${counter}`;
  };
  const sendJson = (res: http.ServerResponse, status: number, obj: unknown): void => {
    if (res.writableEnded) return;
    if (status === 204) {
      // 204: no body, headers still set.
      res.writeHead(204, { 'Content-Type': JSON_CONTENT_TYPE });
      res.end();
      return;
    }
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      'Content-Type': JSON_CONTENT_TYPE,
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  };
  const sendError = (res: http.ServerResponse, status: number, message: string): void => {
    sendJson(res, status, { message });
  };
  const sendBuffer = (res: http.ServerResponse, status: number, body: Buffer): void => {
    if (res.writableEnded) return;
    if (status === 204 || body.length === 0) {
      res.writeHead(status, { 'Content-Type': JSON_CONTENT_TYPE });
      res.end();
      return;
    }
    res.writeHead(status, {
      'Content-Type': JSON_CONTENT_TYPE,
      'Content-Length': body.length,
    });
    res.end(body);
  };
  return { token, requestId, sendJson, sendError, sendBuffer };
}

/**
 * Whether the request carries the right bearer token. Cheap by design:
 * one header lookup, one prefix check, one length check, one
 * timing-safe compare on equal-length buffers. An empty configured
 * token disables auth (dev mode only — the trial always sets a token,
 * and the suite sends no header at all when its token is empty).
 */
function authorized(req: http.IncomingMessage, token: string, tokenBytes: Buffer): boolean {
  if (token === '') return true;
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  if (!header.startsWith('Bearer ')) return false;
  const presented = Buffer.from(header.slice(7));
  if (presented.length !== tokenBytes.length) return false;
  return timingSafeEqual(presented, tokenBytes);
}

class BodyTooLargeError extends Error {}
class BodyReadError extends Error {}

/**
 * Read the whole request body, capped at MAX_BODY_BYTES. Resolves to the
 * raw bytes (EMPTY_BUFFER when there was no body). Rejects with
 * BodyTooLargeError past the cap (the rest of the stream is drained so
 * the socket stays usable) or BodyReadError on a stream error.
 */
function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    let tooLarge = false;
    const finish = (err: Error | null, body: Buffer): void => {
      if (settled) return;
      settled = true;
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      if (err !== null) reject(err);
      else resolve(body);
    };
    const onData = (chunk: Buffer): void => {
      if (tooLarge) return; // keep draining, drop the bytes
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      if (tooLarge) finish(new BodyTooLargeError('request body exceeds the 10 MB cap'), EMPTY_BUFFER);
      else finish(null, size === 0 ? EMPTY_BUFFER : Buffer.concat(chunks, size));
    };
    const onError = (): void => {
      finish(new BodyReadError('the request body could not be read'), EMPTY_BUFFER);
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

/**
 * Whether a pathname is a git smart-HTTP path: `/<owner>/<repo>.git/...`.
 * The owner is the first segment, the repo the second; the repo segment
 * must end in `.git` with at least one character before it.
 */
function isGitPath(path: string): boolean {
  const ownerEnd = path.indexOf('/', 1);
  if (ownerEnd <= 1) return false;
  const repoEnd = path.indexOf('/', ownerEnd + 1);
  const repo = repoEnd === -1 ? path.slice(ownerEnd + 1) : path.slice(ownerEnd + 1, repoEnd);
  return repo.length > 4 && repo.endsWith('.git');
}

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Route one request. The order matters: /healthz first (no auth), then
 * the known API/git prefixes (auth, then body, then the surface
 * handler), then the 404 fallback. An unknown top-level path is a 404
 * without an auth check — GitHub answers 404 for unknown paths
 * regardless of credentials, and the suite's unknown-route check
 * (protocol/unknown-route-json-404) only ever calls /api/v3/* with a
 * token, so no check distinguishes the two orders there.
 */
async function dispatch(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  store: Store,
  ctx: ServerContext,
  tokenBytes: Buffer,
): Promise<void> {
  const rawUrl = req.url ?? '/';
  const queryAt = rawUrl.indexOf('?');
  const path = queryAt === -1 ? rawUrl : rawUrl.slice(0, queryAt);

  // Every reply carries a non-empty request id, including 401s and 404s
  // (protocol/request-id checks the 401 case). Set once, up front.
  res.setHeader('X-GitHub-Request-Id', ctx.requestId());

  // /healthz: the only unauthenticated route. The env GETs it twice
  // during boot; both must answer 200.
  if (path === '/healthz') {
    ctx.sendJson(res, 200, { ok: true });
    return;
  }

  const isRest = path === '/api/v3' || path.startsWith('/api/v3/');
  const isGraphql = path === '/api/graphql' || path === '/api/graphql/';
  const isMcp = path === '/mcp' || path === '/mcp/';
  const isGit = !isRest && !isGraphql && !isMcp && isGitPath(path);
  if (!isRest && !isGraphql && !isMcp && !isGit) {
    ctx.sendError(res, 404, 'Not Found');
    return;
  }

  if (!authorized(req, ctx.token, tokenBytes)) {
    ctx.sendError(res, 401, 'Requires authentication');
    return;
  }

  const forgeReq = req as ForgeRequest;
  forgeReq.path = path;
  forgeReq.query = queryAt === -1 ? '' : rawUrl.slice(queryAt + 1);
  forgeReq.body = EMPTY_BUFFER;
  forgeReq.json = undefined;
  forgeReq.bodyParseError = false;

  // Read the body for methods that carry one. GET/HEAD never have a body
  // in this suite, so the hot read path skips the stream entirely.
  if (req.method !== undefined && BODY_METHODS.has(req.method)) {
    let body: Buffer;
    try {
      body = await readBody(req);
    } catch (err) {
      if (err instanceof BodyTooLargeError) ctx.sendError(res, 413, 'Request body too large');
      else ctx.sendError(res, 400, 'Bad Request');
      return;
    }
    forgeReq.body = body;
    if (!isGit && body.length > 0) {
      // API routes take JSON bodies; a malformed one is a 400
      // (protocol/malformed-body-400). Git bodies are raw binary and
      // are never parsed. EXCEPTION: /mcp. mcp/parse-error requires
      // HTTP 400 + a JSON-RPC -32700 envelope with an `id` key, which
      // the generic {message} body does not carry — so a malformed MCP
      // body is flagged and still dispatched, and handleMcp answers
      // the -32700 envelope itself.
      try {
        forgeReq.json = JSON.parse(body.toString('utf8'));
      } catch {
        if (isMcp) {
          forgeReq.bodyParseError = true;
        } else {
          ctx.sendError(res, 400, 'Problems parsing JSON');
          return;
        }
      }
    }
  }

  if (isRest) await handleRest(forgeReq, res, store, ctx);
  else if (isGraphql) await handleGraphql(forgeReq, res, store, ctx);
  else if (isMcp) await handleMcp(forgeReq, res, store, ctx);
  else await handleGit(forgeReq, res, store, ctx);
}

/**
 * Create the forge's HTTP server. It does not listen — main.ts binds it
 * (listen(0) in trial mode, PORT in dev mode). A handler that throws
 * (sync or async) becomes a 500 JSON reply, never a crashed process:
 * a crash before /done fails every check after it.
 */
export function createServer(store: Store, ctx: ServerContext): http.Server {
  const tokenBytes = Buffer.from(ctx.token);
  const server = http.createServer((req, res) => {
    dispatch(req, res, store, ctx, tokenBytes).catch((err: unknown) => {
      const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
      process.stderr.write(`[server] dispatch failed: ${detail}\n`);
      try {
        if (!res.headersSent && !res.writableEnded) {
          ctx.sendError(res, 500, 'Internal Server Error');
        } else if (!res.writableEnded) {
          res.end();
        }
      } catch {
        // The socket is already gone; nothing left to do.
      }
    });
  });
  // Malformed HTTP from a client: answer JSON, never node's default HTML.
  server.on('clientError', (err, socket) => {
    const body = JSON.stringify({ message: 'Bad Request' });
    socket.end(
      `HTTP/1.1 400 Bad Request\r\nContent-Type: ${JSON_CONTENT_TYPE}\r\n` +
        `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    );
    void err;
  });
  return server;
}
