// Smoke test for src/rest.ts (github-core-clone-01).
//
// git.ts is built in parallel by another agent, so this test sandboxes:
// it copies src/store.ts + src/rest.ts into /tmp and pairs them with a
// STUB git.ts (embedded below via String.raw) that implements the
// ARCHITECTURE.md git.ts contract with REAL git object ids (sha1 over
// "<type> <len>\0" + data), real trees/commits, and a real three-way
// squash merge. Nothing is written into repo/ except this file itself;
// the stub never leaves /tmp.
//
// The harness mimics server.ts dispatch: it sets req.path / req.query /
// req.json (the production path) and a ctx with sendJson / sendError /
// sendBuffer mirroring server.ts's createContext, plus the up-front
// X-GitHub-Request-Id. A few requests run in "stream" mode (no req.json
// set) to exercise rest.ts's own stream-read + JSON-parse fallback,
// including the malformed-body 400.
//
// Run from repo/:
//   node --experimental-strip-types test/rest-smoke.mjs
// Against the REAL git.ts (once the git builder has landed it) instead of
// the stub:
//   REST_SMOKE_REAL_GIT=1 node --experimental-strip-types test/rest-smoke.mjs
// Exit code 0 = all checks passed.

import { createServer } from 'node:http';
import { mkdtemp, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// --- Stub git.ts (test scaffolding ONLY; lives in /tmp, never in repo/) ---
// No backticks / ${} in here: it is embedded via String.raw.
const STUB_GIT_TS = String.raw`// STUB git.ts — test scaffolding for the REST smoke test only.
// Implements the ARCHITECTURE.md git.ts contract with real git object ids.
import { createHash } from 'node:crypto';

const NUL = String.fromCharCode(0);

export function hashObject(type, data) {
  const h = createHash('sha1');
  h.update(type + ' ' + data.length + NUL);
  h.update(data);
  return h.digest('hex');
}

export function writeObject(repo, type, data) {
  const sha = hashObject(type, data);
  if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data });
  return sha;
}

export function parseCommit(data) {
  const text = data.toString('utf8');
  const nl = text.indexOf('\n\n');
  const header = nl >= 0 ? text.slice(0, nl) : text;
  const message = nl >= 0 ? text.slice(nl + 2) : '';
  let tree = '';
  let author = '';
  let committer = '';
  const parents = [];
  const lines = header.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function parseTree(data) {
  const entries = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(32, off);
    const mode = data.toString('utf8', off, sp);
    const nul = data.indexOf(0, sp + 1);
    const name = data.toString('utf8', sp + 1, nul);
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    off = nul + 21;
  }
  return entries;
}

export function buildTree(entries) {
  const sorted = entries.slice().sort(function (a, b) {
    if (a.name < b.name) return -1;
    if (a.name > b.name) return 1;
    return 0;
  });
  const parts = [];
  for (let i = 0; i < sorted.length; i++) {
    parts.push(Buffer.from(sorted[i].mode + ' ' + sorted[i].name + NUL, 'utf8'));
    parts.push(Buffer.from(sorted[i].sha, 'hex'));
  }
  return Buffer.concat(parts);
}

export function buildCommit(tree, parents, author, committer, message) {
  let s = 'tree ' + tree + '\n';
  for (let i = 0; i < parents.length; i++) s += 'parent ' + parents[i] + '\n';
  s += 'author ' + author + '\ncommitter ' + committer + '\n\n' + message;
  return Buffer.from(s, 'utf8');
}

// commit sha -> Map<path, Buffer> (the stub's file-map index, kept in sync
// with the real tree objects commitFile builds).
const fileMaps = new WeakMap();
function mapsFor(repo) {
  let m = fileMaps.get(repo);
  if (!m) {
    m = new Map();
    fileMaps.set(repo, m);
  }
  return m;
}

let epochTick = 0;
function identity(repo) {
  epochTick += 1;
  return repo.owner + ' <' + repo.owner + '@example.invalid> ' + (1735689600 + epochTick) + ' +0000';
}

// Write nested tree objects for a flat path->content map; returns the root tree sha.
function writeTrees(repo, files) {
  function rec(paths) {
    const entries = [];
    const subdirs = new Map();
    for (let i = 0; i < paths.length; i++) {
      const p = paths[i][0];
      const buf = paths[i][1];
      const slash = p.indexOf('/');
      if (slash === -1) {
        entries.push({ mode: '100644', name: p, sha: writeObject(repo, 'blob', buf) });
      } else {
        const dir = p.slice(0, slash);
        if (!subdirs.has(dir)) subdirs.set(dir, []);
        subdirs.get(dir).push([p.slice(slash + 1), buf]);
      }
    }
    const dirs = Array.from(subdirs.keys()).sort();
    for (let i = 0; i < dirs.length; i++) {
      entries.push({ mode: '40000', name: dirs[i], sha: rec(subdirs.get(dirs[i])) });
    }
    return writeObject(repo, 'tree', buildTree(entries));
  }
  return rec(Array.from(files.entries()));
}

export function resolveRef(repo, ref) {
  if (typeof ref !== 'string' || ref === '') return null;
  if (repo.refs.has(ref)) return repo.refs.get(ref);
  const full = 'refs/heads/' + ref;
  if (repo.refs.has(full)) return repo.refs.get(full);
  if (/^[0-9a-f]{40}$/i.test(ref)) {
    const lower = ref.toLowerCase();
    const obj = repo.objects.get(lower);
    if (obj && obj.type === 'commit') return lower;
  }
  return null;
}

export function commitFile(repo, opts) {
  const branch = opts.branch === undefined ? repo.defaultBranch : opts.branch;
  const refKey = 'refs/heads/' + branch;
  const tip = repo.refs.get(refKey) || null;
  const maps = mapsFor(repo);
  const current = tip ? maps.get(tip) || new Map() : new Map();
  const existed = current.has(opts.path);
  if (opts.expectedBlobSha !== undefined) {
    if (!existed) return { error: 'stale' };
    const curSha = hashObject('blob', current.get(opts.path));
    if (curSha !== opts.expectedBlobSha.toLowerCase()) return { error: 'stale' };
  }
  const next = new Map(current);
  const blobSha = writeObject(repo, 'blob', opts.content);
  next.set(opts.path, opts.content);
  const treeSha = writeTrees(repo, next);
  const ident = identity(repo);
  const commitSha = writeObject(
    repo,
    'commit',
    buildCommit(treeSha, tip ? [tip] : [], ident, ident, opts.message),
  );
  repo.refs.set(refKey, commitSha);
  maps.set(commitSha, next);
  return { blobSha, commitSha, created: !existed };
}

export function deleteFile(repo, opts) {
  const branch = opts.branch === undefined ? repo.defaultBranch : opts.branch;
  const refKey = 'refs/heads/' + branch;
  const tip = repo.refs.get(refKey) || null;
  if (!tip) return { error: 'not-found' };
  const maps = mapsFor(repo);
  const current = maps.get(tip) || new Map();
  if (!current.has(opts.path)) return { error: 'not-found' };
  if (opts.expectedBlobSha !== undefined) {
    const curSha = hashObject('blob', current.get(opts.path));
    if (curSha !== opts.expectedBlobSha.toLowerCase()) return { error: 'stale' };
  }
  const next = new Map(current);
  next.delete(opts.path);
  const treeSha = writeTrees(repo, next);
  const ident = identity(repo);
  const commitSha = writeObject(
    repo,
    'commit',
    buildCommit(treeSha, [tip], ident, ident, opts.message),
  );
  repo.refs.set(refKey, commitSha);
  maps.set(commitSha, next);
  return { commitSha };
}

export function readFileAt(repo, ref, path) {
  const tip = resolveRef(repo, ref);
  if (!tip) return null;
  const files = mapsFor(repo).get(tip);
  if (!files) return null;
  let p = path;
  while (p.startsWith('/')) p = p.slice(1);
  while (p.endsWith('/') && p.length > 0) p = p.slice(0, -1);
  if (files.has(p)) {
    const data = files.get(p);
    return { kind: 'file', blobSha: hashObject('blob', data), data };
  }
  const prefix = p === '' ? '' : p + '/';
  const children = new Map();
  let found = false;
  for (const [fp, buf] of files) {
    if (prefix !== '' && !fp.startsWith(prefix)) continue;
    const rest = fp.slice(prefix.length);
    if (rest === '') continue;
    found = true;
    const slash = rest.indexOf('/');
    if (slash === -1) {
      children.set(rest, { type: 'file', sha: hashObject('blob', buf) });
    } else if (!children.has(rest.slice(0, slash))) {
      const dir = rest.slice(0, slash);
      const sub = new Map();
      for (const [fp2, buf2] of files) {
        if (fp2.startsWith(prefix + dir + '/')) {
          sub.set(fp2.slice(prefix.length + dir.length + 1), buf2);
        }
      }
      children.set(dir, { type: 'dir', sha: writeTrees(repo, sub) });
    }
  }
  if (!found) return null;
  const entries = [];
  for (const [name, v] of children) {
    entries.push({ type: v.type, name, path: prefix + name, sha: v.sha });
  }
  entries.sort(function (a, b) {
    if (a.name < b.name) return -1;
    if (a.name > b.name) return 1;
    return 0;
  });
  return { kind: 'dir', entries };
}

export function listCommits(repo, ref) {
  const out = [];
  const seen = new Set();
  let cur = resolveRef(repo, ref);
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'commit') break;
    const parsed = parseCommit(obj.data);
    out.push({ sha: cur, message: parsed.message });
    cur = parsed.parents.length > 0 ? parsed.parents[0] : null;
  }
  return out;
}

function splitLines(buf) {
  if (buf.length === 0) return [];
  const parts = buf.toString('utf8').split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

function diffLineCounts(aBuf, bBuf) {
  const a = splitLines(aBuf);
  const b = splitLines(bBuf);
  const n = a.length;
  const m = b.length;
  const dp = [];
  for (let i = 0; i <= n; i++) dp.push(new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const lcs = dp[0][0];
  return { additions: m - lcs, deletions: n - lcs };
}

export function diffTrees(repo, baseSha, headSha) {
  const maps = mapsFor(repo);
  const base = maps.get(baseSha) || new Map();
  const head = maps.get(headSha) || new Map();
  const paths = new Set();
  for (const k of base.keys()) paths.add(k);
  for (const k of head.keys()) paths.add(k);
  const out = [];
  const sorted = Array.from(paths).sort();
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    const inBase = base.has(p);
    const inHead = head.has(p);
    if (inBase && !inHead) {
      const d = splitLines(base.get(p)).length;
      out.push({ filename: p, status: 'removed', additions: 0, deletions: d, changes: d });
    } else if (!inBase && inHead) {
      const a = splitLines(head.get(p)).length;
      out.push({ filename: p, status: 'added', additions: a, deletions: 0, changes: a });
    } else if (!base.get(p).equals(head.get(p))) {
      const c = diffLineCounts(base.get(p), head.get(p));
      out.push({ filename: p, status: 'modified', additions: c.additions, deletions: c.deletions, changes: c.additions + c.deletions });
    }
  }
  return out;
}

export function mergeBase(repo, a, b) {
  const ancA = new Set();
  const q = [a];
  while (q.length > 0) {
    const s = q.shift();
    if (!s || ancA.has(s)) continue;
    ancA.add(s);
    const obj = repo.objects.get(s);
    if (obj && obj.type === 'commit') {
      const ps = parseCommit(obj.data).parents;
      for (let i = 0; i < ps.length; i++) q.push(ps[i]);
    }
  }
  const q2 = [b];
  const seen = new Set();
  while (q2.length > 0) {
    const s = q2.shift();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    if (ancA.has(s)) return s;
    const obj = repo.objects.get(s);
    if (obj && obj.type === 'commit') {
      const ps = parseCommit(obj.data).parents;
      for (let i = 0; i < ps.length; i++) q2.push(ps[i]);
    }
  }
  return null;
}

export function isAncestor(repo, anc, desc) {
  if (anc === desc) return true;
  const q = [desc];
  const seen = new Set();
  while (q.length > 0) {
    const s = q.shift();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    if (s === anc) return true;
    const obj = repo.objects.get(s);
    if (obj && obj.type === 'commit') {
      const ps = parseCommit(obj.data).parents;
      for (let i = 0; i < ps.length; i++) q.push(ps[i]);
    }
  }
  return false;
}

export function squashMerge(repo, pr) {
  const baseTip = resolveRef(repo, pr.baseRef);
  const headTip = pr.headSha;
  if (!baseTip || !headTip) return { error: 'conflict' };
  const base = mergeBase(repo, headTip, baseTip);
  const maps = mapsFor(repo);
  const baseMap = base ? maps.get(base) || new Map() : new Map();
  const headMap = maps.get(headTip) || new Map();
  const tipMap = maps.get(baseTip) || new Map();
  const changed = new Set();
  const all = new Set();
  for (const k of baseMap.keys()) all.add(k);
  for (const k of headMap.keys()) all.add(k);
  for (const p of all) {
    const bv = baseMap.get(p);
    const hv = headMap.get(p);
    if (bv === undefined && hv === undefined) continue;
    if (bv === undefined || hv === undefined || !bv.equals(hv)) changed.add(p);
  }
  for (const p of changed) {
    const bv = baseMap.get(p);
    const hv = headMap.get(p);
    const tv = tipMap.get(p);
    const tipChanged =
      (tv === undefined) !== (bv === undefined) || (tv !== undefined && bv !== undefined && !tv.equals(bv));
    if (tipChanged) {
      const sameAsHead =
        (tv === undefined && hv === undefined) ||
        (tv !== undefined && hv !== undefined && tv.equals(hv));
      if (!sameAsHead) return { error: 'conflict' };
    }
  }
  const next = new Map(tipMap);
  for (const p of changed) {
    const hv = headMap.get(p);
    if (hv === undefined) next.delete(p);
    else next.set(p, hv);
  }
  const treeSha = writeTrees(repo, next);
  const ident = identity(repo);
  const msg =
    'Merge pull request #' + pr.number + ' from ' + repo.owner + '/' + pr.headRef + '\n\n' + pr.title;
  const sha = writeObject(repo, 'commit', buildCommit(treeSha, [baseTip], ident, ident, msg));
  repo.refs.set('refs/heads/' + pr.baseRef, sha);
  maps.set(sha, next);
  return { sha };
}

export function handleGit() {
  throw new Error('stub: handleGit not implemented');
}
`;

// --- Sandbox setup: copy the real store.ts + rest.ts, add the stub git.ts ---
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const sandbox = await mkdtemp(join(tmpdir(), 'rest-smoke-'));
await mkdir(join(sandbox, 'src'), { recursive: true });
await copyFile(join(repoRoot, 'src', 'store.ts'), join(sandbox, 'src', 'store.ts'));
await copyFile(join(repoRoot, 'src', 'rest.ts'), join(sandbox, 'src', 'rest.ts'));
const useRealGit = process.env.REST_SMOKE_REAL_GIT === '1';
if (useRealGit) {
  await copyFile(join(repoRoot, 'src', 'git.ts'), join(sandbox, 'src', 'git.ts'));
  console.log('INFO using REAL src/git.ts (REST_SMOKE_REAL_GIT=1)');
} else {
  await writeFile(join(sandbox, 'src', 'git.ts'), STUB_GIT_TS);
  console.log('INFO using stub git.ts (set REST_SMOKE_REAL_GIT=1 for the real one)');
}

let handleRest;
let Store;
try {
  ({ handleRest } = await import(pathToFileURL(join(sandbox, 'src', 'rest.ts')).href));
  ({ Store } = await import(pathToFileURL(join(sandbox, 'src', 'store.ts')).href));
} catch (e) {
  console.error('IMPORT FAILED (run with --experimental-strip-types):', e.message);
  process.exit(2);
}

const store = new Store('adaiversen');

// ctx mirroring server.ts's createContext, plus the up-front
// X-GitHub-Request-Id the real server sets on every reply.
let reqCounter = 0;
const ctx = {
  token: 'test-token',
  requestId: () => 'req-' + (++reqCounter),
  sendJson(res, status, obj) {
    if (res.writableEnded) return;
    if (status === 204) {
      res.writeHead(204, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end();
      return;
    }
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  },
  sendError(res, status, message) {
    ctx.sendJson(res, status, { message });
  },
  sendBuffer(res, status, body) {
    if (res.writableEnded) return;
    if (status === 204 || body.length === 0) {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end();
      return;
    }
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.length,
    });
    res.end(body);
  },
};

// Body mode for the NEXT request (requests are sequential, so a module
// flag is safe): 'parsed' = harness parses JSON into req.json (the
// production server.ts path); 'stream' = leave the stream untouched so
// rest.ts's own fallback reads + parses it.
let bodyMode = 'parsed';

async function readStream(req) {
  const chunks = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

const server = createServer(async (req, res) => {
  res.setHeader('X-GitHub-Request-Id', ctx.requestId());
  const rawUrl = req.url || '/';
  const qi = rawUrl.indexOf('?');
  req.path = qi >= 0 ? rawUrl.slice(0, qi) : rawUrl;
  req.query = qi >= 0 ? rawUrl.slice(qi + 1) : '';
  const method = req.method || 'GET';
  if (bodyMode === 'parsed') {
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const buf = await readStream(req);
      req.body = buf;
      req.json = buf.length > 0 ? JSON.parse(buf.toString('utf8')) : undefined;
    } else {
      req.body = Buffer.alloc(0);
      req.json = undefined;
    }
  }
  // 'stream' mode: req.json / req.body are never set — rest.ts falls back
  // to reading the stream itself.
  await handleRest(req, res, store, ctx);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;

// --- Check + request helpers ------------------------------------------------

let failures = 0;
let checks = 0;
function check(name, cond, extra) {
  checks += 1;
  if (cond) console.log('PASS ' + name);
  else {
    failures += 1;
    console.log('FAIL ' + name + (extra !== undefined ? ' :: ' + extra : ''));
  }
}

async function api(method, path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  let body;
  if (opts.raw !== undefined) body = opts.raw;
  else if (opts.body !== undefined) body = JSON.stringify(opts.body);
  bodyMode = opts.stream === true ? 'stream' : 'parsed';
  const res = await fetch(base + path, { method, headers, body });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, text, json };
}

const SHA40 = /^[0-9a-f]{40}$/;
const OWNER = 'adaiversen';
const REPO = 'smoke-repo';
const R = '/api/v3/repos/' + OWNER + '/' + REPO;
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const unb64 = (s) => Buffer.from((s || '').replace(/\s+/g, ''), 'base64').toString('utf8');

// --- Root + meta -------------------------------------------------------------

{
  const r = await api('GET', '/api/v3/');
  check('root 200', r.status === 200, String(r.status));
  check('root X-OAuth-Scopes', r.headers.get('x-oauth-scopes') === 'repo, read:org', r.headers.get('x-oauth-scopes'));
  check('root request id present', (r.headers.get('x-github-request-id') || '') !== '');
  const m = await api('GET', '/api/v3/meta');
  check(
    'meta 200 + installed_version',
    m.status === 200 && typeof m.json?.installed_version === 'string' && m.json.installed_version !== '',
    JSON.stringify(m.json),
  );
}

// --- Repos: create / duplicate / pagination ---------------------------------

const created = await api('POST', '/api/v3/user/repos', {
  body: { name: REPO, private: true, description: 'smoke' },
});
check('create repo 201', created.status === 201, created.status + ' ' + created.text);
check('create repo default_branch main', created.json?.default_branch === 'main', JSON.stringify(created.json));
check('create repo private true', created.json?.private === true);
check('create repo name echo', created.json?.name === REPO);

const dup = await api('POST', '/api/v3/user/repos', {
  body: { name: REPO, private: true, description: 'x' },
});
check('duplicate repo 422', dup.status === 422, String(dup.status));
check('422 body has non-empty message', typeof dup.json?.message === 'string' && dup.json.message !== '');
check('422 request id present', (dup.headers.get('x-github-request-id') || '') !== '');
check('422 content-type json', (dup.headers.get('content-type') || '').includes('application/json'));

await api('POST', '/api/v3/user/repos', { body: { name: 'smoke-b', private: true, description: 'b' } });
await api('POST', '/api/v3/user/repos', { body: { name: 'smoke-c', private: true, description: 'c' } });
await api('POST', '/api/v3/user/repos', { body: { name: 'smoke-del', private: true, description: 'd' } });

{
  const seen = [];
  let url = '/api/v3/user/repos?per_page=1';
  let pages = 0;
  let next = null;
  do {
    const r = await api('GET', url);
    pages += 1;
    check('pagination page ' + pages + ' <= 1 item', Array.isArray(r.json) && r.json.length <= 1, JSON.stringify(r.json));
    for (const repo of r.json || []) seen.push(repo.name);
    const link = r.headers.get('link') || '';
    const m = link.match(/<([^>]*)>;\s*rel="next"/);
    next = m ? m[1] : null;
    if (next) {
      const u = new URL(next);
      url = u.pathname + u.search;
      check('pagination next is same-origin', u.origin === base, next);
    }
  } while (next && pages < 10);
  check('pagination walked 4 pages', pages === 4, 'pages=' + pages);
  check(
    'pagination saw all 4 repos',
    ['smoke-repo', 'smoke-b', 'smoke-c', 'smoke-del'].every((n) => seen.includes(n)),
    seen.join(','),
  );
  check('pagination no duplicates', new Set(seen).size === seen.length, seen.join(','));
}

// --- Contents: unborn PUT, round-trip, update, stale sha, directory --------

const content1 = 'lichen\nkelp victor\nuniform india\n';
const put1 = await api('PUT', R + '/contents/config/token.css', {
  body: { message: 'Tidy issue pagination', content: b64(content1) },
});
check('PUT first file on unborn repo 201', put1.status === 201, put1.status + ' ' + put1.text);
check('PUT content.sha 40-hex', SHA40.test(put1.json?.content?.sha || ''), JSON.stringify(put1.json));
check('PUT content.encoding base64', put1.json?.content?.encoding === 'base64');
check('PUT commit.sha 40-hex', SHA40.test(put1.json?.commit?.sha || ''));
const blobSha0 = put1.json.content.sha;
const commitSha0 = put1.json.commit.sha;

const get1 = await api('GET', R + '/contents/config/token.css');
check('GET file 200', get1.status === 200, get1.status + ' ' + get1.text);
check('GET file round-trips bytes', unb64(get1.json?.content) === content1);
check('GET file sha matches PUT', (get1.json?.sha || '').toLowerCase() === blobSha0.toLowerCase());
check('GET file size is byte length', get1.json?.size === Buffer.byteLength(content1), 'size=' + get1.json?.size);
check('GET file type/encoding', get1.json?.type === 'file' && get1.json?.encoding === 'base64');

const content2 = 'nickel\ncharlie\ngranite\n';
const put2 = await api('PUT', R + '/contents/config/token.css', {
  body: { message: 'update', content: b64(content2), sha: blobSha0 },
});
check('PUT update 200', put2.status === 200, put2.status + ' ' + put2.text);
check('PUT update changes blob sha', (put2.json?.content?.sha || '').toLowerCase() !== blobSha0.toLowerCase());
const blobSha1 = put2.json.content.sha;

const putStale = await api('PUT', R + '/contents/config/token.css', {
  body: { message: 'stale', content: b64(content1), sha: blobSha0 },
});
check('PUT stale sha 409', putStale.status === 409, putStale.status + ' ' + putStale.text);
const getAfterStale = await api('GET', R + '/contents/config/token.css');
check('stale PUT did not change file', (getAfterStale.json?.sha || '').toLowerCase() === blobSha1.toLowerCase());

await api('PUT', R + '/contents/config/one.txt', { body: { message: 'one', content: b64('one\n') } });
await api('PUT', R + '/contents/config/two.txt', { body: { message: 'two', content: b64('two\n') } });
const dir = await api('GET', R + '/contents/config');
const dirNames = (dir.json || []).map((e) => e.name);
check('GET dir 200 array', dir.status === 200 && Array.isArray(dir.json), String(dir.status));
check(
  'GET dir lists all three files',
  ['token.css', 'one.txt', 'two.txt'].every((n) => dirNames.includes(n)),
  dirNames.join(','),
);
check('GET dir entries have 40-hex sha', (dir.json || []).every((e) => SHA40.test(e.sha || '')), JSON.stringify(dir.json));

// --- Labels (via the stream-read fallback path) ------------------------------

const label = await api('POST', R + '/labels', { body: { name: 'bug', color: 'ededed' }, stream: true });
check('POST label 201 (stream fallback)', label.status === 201, label.status + ' ' + label.text);
check('label name echo', label.json?.name === 'bug');
const labelDup = await api('POST', R + '/labels', { body: { name: 'bug', color: 'ededed' } });
check('duplicate label 422', labelDup.status === 422, String(labelDup.status));

// --- Issues: create, bad label (no number consumed), get/cache, patch -------

const issue1 = await api('POST', R + '/issues', {
  body: { title: 'Incorrect GraphQL node ids', body: 'A minimal case is attached.', labels: ['bug'] },
});
check('POST issue 201', issue1.status === 201, issue1.status + ' ' + issue1.text);
check('issue number 1', issue1.json?.number === 1, JSON.stringify(issue1.json));
check('issue state open', issue1.json?.state === 'open');
check('issue labels include bug', (issue1.json?.labels || []).some((l) => l.name === 'bug'));

const badLabel = await api('POST', R + '/issues', {
  body: { title: 'x', body: 'y', labels: ['bug-not-a-label'] },
});
check('issue with unknown label 422', badLabel.status === 422, String(badLabel.status));
const issue2 = await api('POST', R + '/issues', { body: { title: 'second', body: 'b2' } });
check('422 did not consume a number (issue2 == 2)', issue2.json?.number === 2, JSON.stringify(issue2.json));
const issue3 = await api('POST', R + '/issues', { body: { title: 'third', body: 'b3' } });
check('issue3 number 3', issue3.json?.number === 3, JSON.stringify(issue3.json));

const g1a = await api('GET', R + '/issues/1');
const g1b = await api('GET', R + '/issues/1');
check('GET issue 200', g1a.status === 200 && g1b.status === 200, g1a.status + '/' + g1b.status);
check('GET issue bodies identical (cache path)', g1a.text === g1b.text);
check(
  'GET issue title/body echo',
  g1a.json?.title === 'Incorrect GraphQL node ids' && g1a.json?.body === 'A minimal case is attached.',
);

const patched = await api('PATCH', R + '/issues/1', { body: { state: 'closed' } });
check('PATCH close 200 + closed', patched.status === 200 && patched.json?.state === 'closed', patched.status + ' ' + patched.text);
const g1c = await api('GET', R + '/issues/1');
check('close persists on GET (cache invalidated)', g1c.json?.state === 'closed');

const listOpen = await api('GET', R + '/issues?state=open&per_page=100');
check(
  'list state=open excludes closed',
  (listOpen.json || []).every((i) => i.state === 'open') && !(listOpen.json || []).some((i) => i.number === 1),
  JSON.stringify(listOpen.json),
);
const listAsc = await api('GET', R + '/issues?state=all&sort=created&direction=asc&per_page=100');
check(
  'list sort asc is creation order',
  JSON.stringify((listAsc.json || []).map((i) => i.number)) === '[1,2,3]',
  JSON.stringify(listAsc.json),
);
const listDesc = await api('GET', R + '/issues?state=all&sort=created&direction=desc&per_page=100');
check(
  'list sort desc is reverse creation order',
  JSON.stringify((listDesc.json || []).map((i) => i.number)) === '[3,2,1]',
  JSON.stringify(listDesc.json),
);
const listDefault = await api('GET', R + '/issues?per_page=100');
check('list default is open-only', (listDefault.json || []).every((i) => i.state === 'open'));

// --- Comments ----------------------------------------------------------------

const comment = await api('POST', R + '/issues/1/comments', { body: { body: 'The same flow works over the API.' } });
check('POST comment 201', comment.status === 201, comment.status + ' ' + comment.text);
check(
  'comment id >= 1 + body echo',
  Number.isInteger(comment.json?.id) && comment.json.id >= 1 && comment.json?.body === 'The same flow works over the API.',
  JSON.stringify(comment.json),
);
const comments = await api('GET', R + '/issues/1/comments');
check(
  'GET comments contains it',
  (comments.json || []).some((c) => c.id === comment.json.id && c.body === comment.json.body),
  JSON.stringify(comments.json),
);
const g1d = await api('GET', R + '/issues/1');
check('issue comments count updated after comment', g1d.json?.comments === 1, JSON.stringify(g1d.json));

// --- Branches + commits ------------------------------------------------------

const branch = await api('POST', R + '/git/refs', { body: { ref: 'refs/heads/develop', sha: commitSha0 } });
check('POST git/refs 201', branch.status === 201, branch.status + ' ' + branch.text);
check('git/refs echoes ref', branch.json?.ref === 'refs/heads/develop');
const branches = await api('GET', R + '/branches');
const branchNames = (branches.json || []).map((b) => b.name);
check('branches include main + develop', branchNames.includes('main') && branchNames.includes('develop'), branchNames.join(','));
const developTip = (branches.json || []).find((b) => b.name === 'develop')?.commit?.sha;
check('develop tip == initial commit', (developTip || '').toLowerCase() === commitSha0.toLowerCase());

const devContent = 'alpha\nbeta\ngamma\n';
const putDev = await api('PUT', R + '/contents/config/token-dev.css', {
  body: { message: 'dev file', content: b64(devContent), branch: 'develop' },
});
check('PUT new file on branch 201', putDev.status === 201, putDev.status + ' ' + putDev.text);
const commitsDev = await api('GET', R + '/commits?sha=develop');
check(
  'commits?sha=develop contains dev commit with exact message',
  (commitsDev.json || []).some((c) => c.sha === putDev.json.commit.sha && c.commit.message === 'dev file'),
  JSON.stringify(commitsDev.json),
);
const commitsMain = await api('GET', R + '/commits');
check(
  'commits (default) excludes dev commit',
  !(commitsMain.json || []).some((c) => c.sha === putDev.json.commit.sha),
  JSON.stringify(commitsMain.json),
);
const branches2 = await api('GET', R + '/branches');
const developTip2 = (branches2.json || []).find((b) => b.name === 'develop')?.commit?.sha;
const mainTip = (branches2.json || []).find((b) => b.name === 'main')?.commit?.sha;

// --- Pulls: create, files, squash merge --------------------------------------

const pr = await api('POST', R + '/pulls', {
  body: { head: 'develop', base: 'main', title: 'Improve MCP tool schemas', body: 'It works on a fresh repository.' },
});
check('POST pulls 201', pr.status === 201, pr.status + ' ' + pr.text);
check('PR number is 4 (shared issue+PR counter)', pr.json?.number === 4, JSON.stringify(pr.json));
check('PR head.ref/base.ref', pr.json?.head?.ref === 'develop' && pr.json?.base?.ref === 'main');
check('PR head.sha == develop tip', (pr.json?.head?.sha || '').toLowerCase() === (developTip2 || '').toLowerCase());
check('PR base.sha == main tip', (pr.json?.base?.sha || '').toLowerCase() === (mainTip || '').toLowerCase());
const prNum = pr.json.number;

const files = await api('GET', R + '/pulls/' + prNum + '/files');
check(
  'PR files lists dev file as added with additions >= 1',
  (files.json || []).some((f) => f.filename === 'config/token-dev.css' && f.status === 'added' && f.additions >= 1),
  JSON.stringify(files.json),
);

const merge = await api('PUT', R + '/pulls/' + prNum + '/merge', { body: { merge_method: 'squash' } });
check('merge 200', merge.status === 200, merge.status + ' ' + merge.text);
check('merge body merged:true + 40-hex sha', merge.json?.merged === true && SHA40.test(merge.json?.sha || ''), JSON.stringify(merge.json));
const mergeSha = merge.json.sha;
const prAfter = await api('GET', R + '/pulls/' + prNum);
check(
  'PR closed + merged after merge',
  prAfter.json?.state === 'closed' && prAfter.json?.merged === true,
  JSON.stringify(prAfter.json),
);
check('PR merged_at non-empty', typeof prAfter.json?.merged_at === 'string' && prAfter.json.merged_at !== '');
check(
  'PR merge_commit_sha == merge sha',
  (prAfter.json?.merge_commit_sha || '').toLowerCase() === mergeSha.toLowerCase(),
);
const commitsMain2 = await api('GET', R + '/commits?sha=main');
check(
  'merge commit is in main history',
  (commitsMain2.json || []).some((c) => c.sha.toLowerCase() === mergeSha.toLowerCase()),
  JSON.stringify(commitsMain2.json),
);
const mergedContent = await api('GET', R + '/contents/config/token-dev.css?ref=main');
check('merged content on base branch', unb64(mergedContent.json?.content) === devContent, mergedContent.status + ' ' + mergedContent.text);
const mergeAgain = await api('PUT', R + '/pulls/' + prNum + '/merge', { body: { merge_method: 'squash' } });
check('re-merge already-merged PR 405', mergeAgain.status === 405, String(mergeAgain.status));

// --- Merge conflict: two branches update the same file differently -----------

{
  const mainTipNow = (await api('GET', R + '/branches')).json.find((b) => b.name === 'main').commit.sha;
  await api('POST', R + '/git/refs', { body: { ref: 'refs/heads/c1', sha: mainTipNow } });
  await api('POST', R + '/git/refs', { body: { ref: 'refs/heads/c2', sha: mainTipNow } });
  const cur = await api('GET', R + '/contents/config/token.css?ref=c1');
  const curSha = cur.json.sha;
  const p1 = await api('PUT', R + '/contents/config/token.css', {
    body: { message: 'A', content: b64('content-A\n'), branch: 'c1', sha: curSha },
  });
  const p2 = await api('PUT', R + '/contents/config/token.css', {
    body: { message: 'B', content: b64('content-B\n'), branch: 'c2', sha: curSha },
  });
  check('conflict setup PUTs 200', p1.status === 200 && p2.status === 200, p1.status + '/' + p2.status);
  const pr1 = await api('POST', R + '/pulls', { body: { head: 'c1', base: 'main', title: 'c1', body: '' } });
  const pr2 = await api('POST', R + '/pulls', { body: { head: 'c2', base: 'main', title: 'c2', body: '' } });
  const m1 = await api('PUT', R + '/pulls/' + pr1.json.number + '/merge', { body: { merge_method: 'squash' } });
  check('first conflict-PR merge 200', m1.status === 200, m1.status + ' ' + m1.text);
  const m2 = await api('PUT', R + '/pulls/' + pr2.json.number + '/merge', { body: { merge_method: 'squash' } });
  check('second conflict-PR merge 405 (not 409)', m2.status === 405, m2.status + ' ' + m2.text);
  const pr2After = await api('GET', R + '/pulls/' + pr2.json.number);
  check('conflicted PR stays open + unmerged', pr2After.json?.state === 'open' && pr2After.json?.merged === false);
  const allPulls = await api('GET', R + '/pulls?state=all&per_page=100');
  const numsAll = (allPulls.json || []).map((p) => p.number);
  check('pulls state=all lists merged + open', numsAll.includes(prNum) && numsAll.includes(pr2.json.number), numsAll.join(','));
  const openPulls = await api('GET', R + '/pulls?per_page=100');
  const numsOpen = (openPulls.json || []).map((p) => p.number);
  check('pulls default is open-only', !numsOpen.includes(prNum) && numsOpen.includes(pr2.json.number), numsOpen.join(','));
}

// --- Contents DELETE ----------------------------------------------------------

const oneSha = (await api('GET', R + '/contents/config/one.txt')).json.sha;
const delFile = await api('DELETE', R + '/contents/config/one.txt', { body: { message: 'rm one', sha: oneSha } });
check('DELETE contents 200 + commit sha', delFile.status === 200 && SHA40.test(delFile.json?.commit?.sha || ''), delFile.status + ' ' + delFile.text);
const getDeleted = await api('GET', R + '/contents/config/one.txt');
check('GET deleted file 404', getDeleted.status === 404, String(getDeleted.status));

// --- Errors + misc ------------------------------------------------------------

const foreign = await api('GET', '/api/v3/repos/olgabauer/' + REPO);
check('foreign owner 404 (never 403)', foreign.status === 404, String(foreign.status));
const unknown = await api('GET', '/api/v3/no-such-route/' + REPO);
check(
  'unknown route 404 JSON',
  unknown.status === 404 && typeof unknown.json?.message === 'string' && unknown.json.message !== '',
  unknown.status + ' ' + unknown.text,
);
check('unknown route request id present', (unknown.headers.get('x-github-request-id') || '') !== '');
const unknownPr = await api('GET', R + '/pulls/999999999');
check('unknown PR GET 404', unknownPr.status === 404, String(unknownPr.status));
const unknownMerge = await api('PUT', R + '/pulls/999999999/merge', { body: { merge_method: 'squash' } });
check('unknown PR merge 404', unknownMerge.status === 404, String(unknownMerge.status));
const unknownIssue = await api('GET', R + '/issues/999999');
check('unknown issue GET 404', unknownIssue.status === 404, String(unknownIssue.status));
const badBranch = await api('GET', R + '/commits?sha=no-such-branch');
check('commits unknown ref 404', badBranch.status === 404, String(badBranch.status));
const badPr = await api('POST', R + '/pulls', { body: { head: 'nope', base: 'main', title: 't', body: '' } });
check('PR unknown head branch 422', badPr.status === 422, String(badPr.status));
const malformed = await api('POST', '/api/v3/user/repos', { raw: '{"name":', stream: true });
check('malformed JSON 400 (stream fallback)', malformed.status === 400, malformed.status + ' ' + malformed.text);

// --- Repo PATCH + DELETE ------------------------------------------------------

const patchedRepo = await api('PATCH', R, { body: { description: 'the tooling behind the thing (updated)' } });
check(
  'PATCH repo 200 + new description',
  patchedRepo.status === 200 && patchedRepo.json?.description === 'the tooling behind the thing (updated)',
  patchedRepo.status + ' ' + patchedRepo.text,
);
const getRepo = await api('GET', R);
check('GET repo shows patched description', getRepo.json?.description === 'the tooling behind the thing (updated)');
const delRepo = await api('DELETE', '/api/v3/repos/' + OWNER + '/smoke-del');
check('DELETE repo 204 no body', delRepo.status === 204 && delRepo.text === '', delRepo.status + ' ' + JSON.stringify(delRepo.text));
const getDelRepo = await api('GET', '/api/v3/repos/' + OWNER + '/smoke-del');
check('GET deleted repo 404', getDelRepo.status === 404, String(getDelRepo.status));

// --- Read-workload sanity: 200 sequential GETs of the same issue -------------

{
  const t0 = Date.now();
  let ok = 0;
  let first = null;
  let drift = false;
  for (let i = 0; i < 200; i++) {
    const r = await api('GET', R + '/issues/2');
    if (r.status === 200) ok += 1;
    if (first === null) first = r.text;
    else if (r.text !== first) drift = true;
  }
  const ms = Date.now() - t0;
  check('200x GET same issue all 200', ok === 200, 'ok=' + ok);
  check('200x GET bodies stable', !drift);
  console.log('INFO read-workload sanity: 200 sequential GETs in ' + ms + ' ms (' + (ms / 200).toFixed(2) + ' ms/req)');
}

server.close();
console.log('\n' + (checks - failures) + '/' + checks + ' checks passed' + (failures > 0 ? ' — ' + failures + ' FAILED' : ''));
process.exit(failures > 0 ? 1 : 0);
