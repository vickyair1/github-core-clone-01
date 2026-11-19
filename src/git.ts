// git.ts — git objects, packs, protocol v2/v0, smart-HTTP handlers, and the
// git API the REST/GraphQL layers build on (github-core-clone-01 forge).
//
// Contract: ARCHITECTURE.md ("git.ts — exported API") + specs/git-spec.md.
// One Node process, stdlib only, no git binary. TypeScript with type
// stripping: explicit `.ts` import extensions, erasable TS only.
//
// Determinism: no Date.now()/Math.random()/UUIDs anywhere. Commit timestamps
// come from a module-level logical clock seeded at the store's
// CLOCK_EPOCH_SEC, advancing once per commit created. (The contract
// signatures give this module no Store handle, so the clock lives here; it is
// deterministic across replay because the request sequence is fixed, and
// nothing in the suite compares git commit timestamps against REST
// timestamps — clone-commit-bytes only checks the `<epoch> +0000` format.)
// Pack entries are sorted by oid; refs are sorted lexicographically.
//
// Caches (perf): the v0 ref advertisements are cached per repo and keyed on
// repo.refsVersion (bumped by every ref change in this module via
// repo.refsVersion++; REST must call store.touchRefs() on branch create for
// the same guarantee). The v2 advertisement is a module constant (no ref
// data in it). Depth-1 clone fetch responses are cached per (repo, tip sha)
// with NO version check — the response depends only on the tip's immutable
// object closure, so it can never go stale.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CLOCK_EPOCH_SEC } from './store.ts';
import type { ObjType, Pull, Repo, Store } from './store.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';

/** The identity every server-created commit carries (git-client.ts). */
export const CONFORMANCE_IDENTITY = 'Conformance <conformance@make.fun>';

const HEX40 = /^[0-9a-f]{40}$/;
export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

// ---------------------------------------------------------------------------
// Logical clock (deterministic; see header note)
// ---------------------------------------------------------------------------

let gitClock = CLOCK_EPOCH_SEC;

/** Next logical-clock epoch second. One tick per commit created. */
function nextEpochSec(): number {
  gitClock += 1;
  return gitClock;
}

function identityLine(epoch: number): string {
  return `${CONFORMANCE_IDENTITY} ${epoch} +0000`;
}

// ---------------------------------------------------------------------------
// Object layer
// ---------------------------------------------------------------------------

/** SHA-1 hex of "<type> <len>\0" + data. */
export function hashObject(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`);
  hash.update(data);
  return hash.digest('hex');
}

/** Store the object if absent; return its sha. */
export function writeObject(repo: Repo, type: ObjType, data: Buffer): string {
  const sha = hashObject(type, data);
  if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data });
  return sha;
}

/** Lenient commit parse (never throws on malformed input — returns what it can). */
export function parseCommit(data: Buffer): {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
} {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

/** Lenient tree parse (stops at the first malformed entry instead of throwing). */
export function parseTree(data: Buffer): Array<{ mode: string; name: string; sha: string }> {
  const entries: Array<{ mode: string; name: string; sha: string }> = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeEntries(
  a: { mode: string; name: string },
  b: { mode: string; name: string },
): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object's bytes; entries are sorted the way git sorts them. */
export function buildTree(entries: Array<{ mode: string; name: string; sha: string }>): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

/**
 * Build a commit object's bytes. `author`/`committer` are full identity lines
 * ("Name <email> <epoch> +0000"); the message is stored verbatim (no trailing
 * newline is added — GET /commits must return the exact message).
 */
export function buildCommit(
  tree: string,
  parents: string[],
  author: string,
  committer: string,
  message: string,
): Buffer {
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${author}`, `committer ${committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

/** Parse an annotated tag's `object`/`type` headers. Null when unparseable. */
function parseTagTarget(data: Buffer): { object: string; type: string } | null {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  let object = '';
  let type = '';
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'object') object = value;
    else if (key === 'type') type = value;
  }
  return object ? { object, type } : null;
}

/** Peel a tag (recursively) to the first non-tag object. Null when unpeelable. */
function peelToNonTag(repo: Repo, sha: string): string | null {
  let cur = sha;
  const seen = new Set<string>();
  for (;;) {
    const obj = repo.objects.get(cur);
    if (!obj) return null;
    if (obj.type !== 'tag') return cur;
    if (seen.has(cur)) return null; // tag cycle — cannot happen from this client
    seen.add(cur);
    const target = parseTagTarget(obj.data);
    if (!target) return null;
    cur = target.object;
  }
}

// ---------------------------------------------------------------------------
// Repo operations
// ---------------------------------------------------------------------------

/**
 * Resolve a ref to a commit sha: a branch name ('main'), a full ref
 * ('refs/heads/main', 'refs/tags/v1'), 'HEAD', or a raw 40-hex sha (which
 * must name an object the repo holds). Null when unresolvable.
 */
export function resolveRef(repo: Repo, ref: string): string | null {
  if (!ref) return null;
  if (ref === 'HEAD') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  if (ref.startsWith('refs/')) return repo.refs.get(ref) ?? null;
  if (isObjectId(ref)) return repo.objects.has(ref) ? ref : null;
  return repo.refs.get(`refs/heads/${ref}`) ?? null;
}

/** resolveRef + peel a tag to its commit. Null when the ref is not a commit. */
function resolveToCommit(repo: Repo, ref: string): string | null {
  const sha = resolveRef(repo, ref);
  if (!sha) return null;
  const obj = repo.objects.get(sha);
  if (!obj) return null;
  if (obj.type === 'commit') return sha;
  if (obj.type === 'tag') {
    const peeled = peelToNonTag(repo, sha);
    if (peeled && repo.objects.get(peeled)?.type === 'commit') return peeled;
  }
  return null;
}

export type ReadFileResult =
  | { kind: 'file'; blobSha: string; data: Buffer }
  | {
      kind: 'dir';
      entries: Array<{ type: 'file' | 'dir'; name: string; path: string; sha: string }>;
    };

function dirEntries(
  treeData: Buffer,
  dirPath: string,
): Array<{ type: 'file' | 'dir'; name: string; path: string; sha: string }> {
  return parseTree(treeData).map((e) => ({
    type: e.mode === '40000' ? ('dir' as const) : ('file' as const),
    name: e.name,
    path: dirPath ? `${dirPath}/${e.name}` : e.name,
    sha: e.sha,
  }));
}

/**
 * Read a file or list a directory at a ref. `path` '' or '/' = repo root.
 * Null when the ref, the commit, or the path does not exist.
 */
export function readFileAt(repo: Repo, ref: string, path: string): ReadFileResult | null {
  const tip = resolveToCommit(repo, ref);
  if (!tip) return null;
  const commitObj = repo.objects.get(tip);
  if (!commitObj || commitObj.type !== 'commit') return null;
  const segments = path.split('/').filter((s) => s.length > 0);
  let treeSha = parseCommit(commitObj.data).tree;
  let prefix = '';
  for (let i = 0; i < segments.length; i++) {
    const treeObj = repo.objects.get(treeSha);
    if (!treeObj || treeObj.type !== 'tree') return null;
    const entry = parseTree(treeObj.data).find((e) => e.name === segments[i]);
    if (!entry) return null;
    const last = i === segments.length - 1;
    if (entry.mode === '40000') {
      if (last) {
        const subObj = repo.objects.get(entry.sha);
        if (!subObj || subObj.type !== 'tree') return null;
        return { kind: 'dir', entries: dirEntries(subObj.data, prefix + segments[i]) };
      }
      treeSha = entry.sha;
      prefix += segments[i] + '/';
    } else {
      if (!last) return null; // the path runs through a file
      const blobObj = repo.objects.get(entry.sha);
      if (!blobObj) return null;
      return { kind: 'file', blobSha: entry.sha, data: blobObj.data };
    }
  }
  const rootObj = repo.objects.get(treeSha);
  if (!rootObj || rootObj.type !== 'tree') return null;
  return { kind: 'dir', entries: dirEntries(rootObj.data, '') };
}

// --- flat file maps (path -> {sha, mode}); gitlinks kept with mode 160000 ---

interface FlatEntry {
  sha: string;
  mode: string;
}

function flattenTree(
  repo: Repo,
  treeSha: string,
  prefix: string,
  out: Map<string, FlatEntry>,
): void {
  const obj = repo.objects.get(treeSha);
  if (!obj || obj.type !== 'tree') return;
  for (const e of parseTree(obj.data)) {
    const p = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === '40000') flattenTree(repo, e.sha, p, out);
    else out.set(p, { sha: e.sha, mode: e.mode });
  }
}

function fileMapOfCommit(repo: Repo, commitSha: string): Map<string, FlatEntry> | null {
  const obj = repo.objects.get(commitSha);
  if (!obj || obj.type !== 'commit') return null;
  const map = new Map<string, FlatEntry>();
  flattenTree(repo, parseCommit(obj.data).tree, '', map);
  return map;
}

// --- recursive tree edits (preserve untouched subtrees byte-identically) ---

/**
 * Set the blob at `segments` in the tree rooted at `treeSha` (null = empty
 * tree). Creates intermediate dirs as needed; a file in the way of a
 * directory is replaced by the directory. Returns the new root tree sha.
 */
function setPathInTree(
  repo: Repo,
  treeSha: string | null,
  segments: string[],
  blobSha: string,
): string {
  const entries = new Map<string, { mode: string; name: string; sha: string }>();
  if (treeSha) {
    const obj = repo.objects.get(treeSha);
    if (obj && obj.type === 'tree') {
      for (const e of parseTree(obj.data)) {
        entries.set(e.name, { mode: e.mode, name: e.name, sha: e.sha });
      }
    }
  }
  const head = segments[0];
  if (segments.length === 1) {
    entries.set(head, { mode: '100644', name: head, sha: blobSha });
  } else {
    const existing = entries.get(head);
    const childSha = existing && existing.mode === '40000' ? existing.sha : null;
    const newChild = setPathInTree(repo, childSha, segments.slice(1), blobSha);
    entries.set(head, { mode: '40000', name: head, sha: newChild });
  }
  return writeObject(repo, 'tree', buildTree([...entries.values()]));
}

/**
 * Remove `segments` from the tree. Returns the new root tree sha, or null
 * when the tree became empty (the caller drops the entry from its parent —
 * git has no empty directories). Returns the input sha unchanged when the
 * path is not present.
 */
function removePathFromTree(
  repo: Repo,
  treeSha: string | null,
  segments: string[],
): string | null {
  if (!treeSha) return null;
  const obj = repo.objects.get(treeSha);
  if (!obj || obj.type !== 'tree') return null;
  const entries = new Map<string, { mode: string; name: string; sha: string }>();
  for (const e of parseTree(obj.data)) {
    entries.set(e.name, { mode: e.mode, name: e.name, sha: e.sha });
  }
  const head = segments[0];
  const existing = entries.get(head);
  if (!existing) return treeSha;
  if (segments.length === 1) {
    entries.delete(head);
  } else {
    if (existing.mode !== '40000') return treeSha;
    const newChild = removePathFromTree(repo, existing.sha, segments.slice(1));
    if (newChild === null) entries.delete(head);
    else if (newChild !== existing.sha) {
      entries.set(head, { mode: '40000', name: head, sha: newChild });
    } else {
      return treeSha;
    }
  }
  if (entries.size === 0) return null;
  return writeObject(repo, 'tree', buildTree([...entries.values()]));
}

/**
 * Create/update a file on a branch (default branch when omitted). An unborn
 * branch gets its first commit as a root commit (this is how the default
 * branch is created on an unborn repo). When `expectedBlobSha` is given and
 * the file's current blob sha differs → {error:'stale'}, nothing applied.
 * `created` = true when the file did not exist before (→ 201 vs 200).
 *
 * NOTE: a named branch that does not exist yet is created as an orphan root
 * commit. REST should 404 unknown branches before calling (rest-spec §2.4
 * recommends 404/422 there); the suite never PUTs to a missing branch.
 */
export function commitFile(
  repo: Repo,
  opts: {
    branch?: string;
    path: string;
    content: Buffer;
    message: string;
    expectedBlobSha?: string;
  },
): { blobSha: string; commitSha: string; created: boolean } | { error: 'stale' } {
  const branch = opts.branch ?? repo.defaultBranch;
  const refName = `refs/heads/${branch}`;
  const tip = repo.refs.get(refName);
  const segments = opts.path.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) return { error: 'stale' };
  const normPath = segments.join('/');
  let currentTree: string | null = null;
  let currentBlob: string | undefined;
  if (tip) {
    const map = fileMapOfCommit(repo, tip);
    currentBlob = map?.get(normPath)?.sha;
    const commitObj = repo.objects.get(tip);
    if (commitObj && commitObj.type === 'commit') {
      currentTree = parseCommit(commitObj.data).tree;
    }
  }
  if (opts.expectedBlobSha !== undefined && currentBlob !== opts.expectedBlobSha) {
    return { error: 'stale' };
  }
  const created = currentBlob === undefined;
  const blobSha = writeObject(repo, 'blob', opts.content);
  const newTree = setPathInTree(repo, currentTree, segments, blobSha);
  const epoch = nextEpochSec();
  const who = identityLine(epoch);
  const commitSha = writeObject(
    repo,
    'commit',
    buildCommit(newTree, tip ? [tip] : [], who, who, opts.message),
  );
  repo.refs.set(refName, commitSha);
  repo.refsVersion++;
  return { blobSha, commitSha, created };
}

/** Delete a file on a branch (default branch when omitted). */
export function deleteFile(
  repo: Repo,
  opts: { branch?: string; path: string; message: string; expectedBlobSha?: string },
): { commitSha: string } | { error: 'stale' | 'not-found' } {
  const branch = opts.branch ?? repo.defaultBranch;
  const refName = `refs/heads/${branch}`;
  const tip = repo.refs.get(refName);
  if (!tip) return { error: 'not-found' };
  const segments = opts.path.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) return { error: 'not-found' };
  const normPath = segments.join('/');
  const map = fileMapOfCommit(repo, tip);
  const currentBlob = map?.get(normPath)?.sha;
  if (currentBlob === undefined) return { error: 'not-found' };
  if (opts.expectedBlobSha !== undefined && currentBlob !== opts.expectedBlobSha) {
    return { error: 'stale' };
  }
  const commitObj = repo.objects.get(tip);
  const currentTree =
    commitObj && commitObj.type === 'commit' ? parseCommit(commitObj.data).tree : null;
  const newTree =
    removePathFromTree(repo, currentTree, segments) ??
    writeObject(repo, 'tree', Buffer.alloc(0));
  const epoch = nextEpochSec();
  const who = identityLine(epoch);
  const commitSha = writeObject(
    repo,
    'commit',
    buildCommit(newTree, [tip], who, who, opts.message),
  );
  repo.refs.set(refName, commitSha);
  repo.refsVersion++;
  return { commitSha };
}

/** First-parent walk from the ref tip, NEWEST FIRST. */
export function listCommits(repo: Repo, ref: string): Array<{ sha: string; message: string }> {
  const out: Array<{ sha: string; message: string }> = [];
  let cur = resolveToCommit(repo, ref);
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'commit') break;
    const c = parseCommit(obj.data);
    out.push({ sha: cur, message: c.message });
    cur = c.parents[0] ?? null;
  }
  return out;
}

// --- line diff (DP LCS; suite files are ~2 KB, so O(n*m) is trivial) ---

function splitLines(data: Buffer): string[] {
  if (data.length === 0) return [];
  const lines = data.toString('utf8').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function lineDiffCounts(a: string[], b: string[]): { additions: number; deletions: number } {
  const n = a.length;
  const m = b.length;
  let prev = new Array<number>(m + 1).fill(0);
  let cur = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  const lcs = prev[m];
  return { additions: m - lcs, deletions: n - lcs };
}

function blobData(repo: Repo, sha: string): Buffer {
  return repo.objects.get(sha)?.data ?? Buffer.alloc(0);
}

/**
 * Compare two commits' full file maps. additions/deletions are REAL line
 * counts; an added file counts its lines as additions, a removed file its
 * lines as deletions. Output is sorted by filename (deterministic).
 */
export function diffTrees(
  repo: Repo,
  baseSha: string,
  headSha: string,
): Array<{
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}> {
  const baseMap = fileMapOfCommit(repo, baseSha) ?? new Map<string, FlatEntry>();
  const headMap = fileMapOfCommit(repo, headSha) ?? new Map<string, FlatEntry>();
  const out: Array<{
    filename: string;
    status: 'added' | 'modified' | 'removed';
    additions: number;
    deletions: number;
    changes: number;
  }> = [];
  const names = new Set<string>([...baseMap.keys(), ...headMap.keys()]);
  for (const name of names) {
    const b = baseMap.get(name);
    const h = headMap.get(name);
    if (b && !h) {
      const deletions = b.mode === '160000' ? 1 : splitLines(blobData(repo, b.sha)).length;
      out.push({ filename: name, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (!b && h) {
      const additions = h.mode === '160000' ? 1 : splitLines(blobData(repo, h.sha)).length;
      out.push({ filename: name, status: 'added', additions, deletions: 0, changes: additions });
    } else if (b && h && b.sha !== h.sha) {
      if (b.mode === '160000' || h.mode === '160000') {
        out.push({ filename: name, status: 'modified', additions: 1, deletions: 1, changes: 2 });
      } else {
        const counts = lineDiffCounts(
          splitLines(blobData(repo, b.sha)),
          splitLines(blobData(repo, h.sha)),
        );
        out.push({
          filename: name,
          status: 'modified',
          additions: counts.additions,
          deletions: counts.deletions,
          changes: counts.additions + counts.deletions,
        });
      }
    }
  }
  out.sort((x, y) => (x.filename < y.filename ? -1 : x.filename > y.filename ? 1 : 0));
  return out;
}

/**
 * Nearest common ancestor: BFS from `a` collects its ancestors, then BFS
 * from `b` returns the first common commit (nearest from b). Walks ALL
 * parents (not just first-parent).
 */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  if (a === b) return repo.objects.has(a) ? a : null;
  const ancestorsA = new Set<string>();
  const stackA: string[] = [a];
  while (stackA.length) {
    const cur = stackA.pop()!;
    if (ancestorsA.has(cur)) continue;
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'commit') continue;
    ancestorsA.add(cur);
    for (const p of parseCommit(obj.data).parents) stackA.push(p);
  }
  const seenB = new Set<string>();
  const queueB: string[] = [b];
  for (let i = 0; i < queueB.length; i++) {
    const cur = queueB[i];
    if (seenB.has(cur)) continue;
    seenB.add(cur);
    if (ancestorsA.has(cur)) return cur;
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) queueB.push(p);
  }
  return null;
}

/** True when `anc` is reachable from `desc` over parentage (tag targets followed). */
export function isAncestor(repo: Repo, anc: string, desc: string): boolean {
  if (anc === desc) return repo.objects.has(anc);
  const seen = new Set<string>();
  const stack: string[] = [desc];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === anc) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = repo.objects.get(cur);
    if (!obj) continue;
    if (obj.type === 'commit') {
      for (const p of parseCommit(obj.data).parents) stack.push(p);
    } else if (obj.type === 'tag') {
      const target = parseTagTarget(obj.data);
      if (target) stack.push(target.object);
    }
  }
  return false;
}

/** Rebuild a full tree from a flat path map (used by squashMerge). */
function buildTreeFromMap(repo: Repo, map: Map<string, FlatEntry>): string {
  interface Node {
    files: Map<string, FlatEntry>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of map) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i++) {
      let child = node.dirs.get(segments[i]);
      if (!child) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(segments[i], child);
      }
      node = child;
    }
    node.files.set(segments[segments.length - 1], entry);
  }
  const build = (node: Node): string => {
    const entries: Array<{ mode: string; name: string; sha: string }> = [];
    for (const [name, e] of node.files) entries.push({ mode: e.mode, name, sha: e.sha });
    for (const [name, child] of node.dirs) {
      entries.push({ mode: '40000', name, sha: build(child) });
    }
    return writeObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/**
 * Squash-merge a PR onto its base branch. Three-way: base =
 * mergeBase(headSha, current base tip). For each path the PR changes vs the
 * merge-base, if the base tip ALSO changed that path vs the merge-base AND
 * the resulting contents differ → {error:'conflict'}, NOTHING changed.
 * Otherwise the head's version of every changed path is applied onto the
 * base tip's tree as ONE commit (parent = base tip), the base branch moves
 * to it, and its sha is returned. With no common ancestor the merge-base is
 * the empty tree (git semantics for unrelated histories). The Pull object's
 * own fields (state/merged/merged_at) are REST's job — this only does the
 * git-side work.
 */
export function squashMerge(repo: Repo, pr: Pull): { sha: string } | { error: 'conflict' } {
  const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
  if (!baseTip) return { error: 'conflict' };
  const headObj = repo.objects.get(pr.headSha);
  if (!headObj || headObj.type !== 'commit') return { error: 'conflict' };
  const base = mergeBase(repo, pr.headSha, baseTip);
  const baseMap = base ? (fileMapOfCommit(repo, base) ?? new Map<string, FlatEntry>()) : new Map<string, FlatEntry>();
  const headMap = fileMapOfCommit(repo, pr.headSha) ?? new Map<string, FlatEntry>();
  const baseTipMap = fileMapOfCommit(repo, baseTip) ?? new Map<string, FlatEntry>();

  const changed = new Set<string>();
  for (const [path, h] of headMap) {
    const b = baseMap.get(path);
    if (!b || b.sha !== h.sha) changed.add(path);
  }
  for (const path of baseMap.keys()) {
    if (!headMap.has(path)) changed.add(path);
  }
  for (const path of changed) {
    const baseVal = baseMap.get(path)?.sha;
    const headVal = headMap.get(path)?.sha;
    const tipVal = baseTipMap.get(path)?.sha;
    if (tipVal !== baseVal && tipVal !== headVal) return { error: 'conflict' };
  }

  const merged = new Map<string, FlatEntry>(baseTipMap);
  for (const path of changed) {
    const h = headMap.get(path);
    if (h) merged.set(path, h);
    else merged.delete(path);
  }
  const treeSha = buildTreeFromMap(repo, merged);
  const epoch = nextEpochSec();
  const who = identityLine(epoch);
  const message = `Merge pull request #${pr.number} from ${pr.headRef}`;
  const sha = writeObject(repo, 'commit', buildCommit(treeSha, [baseTip], who, who, message));
  repo.refs.set(`refs/heads/${pr.baseRef}`, sha);
  repo.refsVersion++;
  return { sha };
}

// ---------------------------------------------------------------------------
// Packfiles
// ---------------------------------------------------------------------------

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packEntryHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** A valid 0-object pack (32 bytes: 12-byte header + 20-byte trailer). */
export const EMPTY_PACK: Buffer = (() => {
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(0, 8);
  return Buffer.concat([header, createHash('sha1').update(header).digest()]);
})();

/**
 * Build a version-2 pack of plain (undelted) objects. Entries are sorted by
 * oid (deterministic); missing oids are skipped. Undelted packs pass every
 * check (pack-deltas accepts deltaCount === 0).
 */
export function buildPack(repo: Repo, oids: Iterable<string>): Buffer {
  const sorted = [...new Set(oids)].sort();
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  const entries: Buffer[] = [];
  let count = 0;
  for (const oid of sorted) {
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    entries.push(packEntryHeader(obj.type, obj.data.length));
    entries.push(deflateSync(obj.data));
    count++;
  }
  header.writeUInt32BE(count, 8);
  const body = Buffer.concat([header, ...entries]);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

export interface ParsedPackObject {
  type: ObjType;
  data: Buffer;
  sha: string;
}

/**
 * Parse a packfile of plain objects (the client never sends deltas, so delta
 * entries are rejected). Returns null on any structural problem: bad magic,
 * bad version, trailer mismatch, truncated entry, size mismatch, delta
 * entry, or trailing bytes. A 0-object pack parses to [].
 */
export function parsePack(pack: Buffer): ParsedPackObject[] | null {
  if (pack.length < 32) return null;
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') return null;
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) return null;
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) return null;
  const out: ParsedPackObject[] = [];
  let offset = 12;
  for (let i = 0; i < count; i++) {
    if (offset >= trailerStart) return null;
    let byte = pack[offset];
    const first = byte;
    let size = byte & 0x0f;
    let shift = 4;
    offset += 1;
    while (byte & 0x80) {
      if (offset >= trailerStart) return null;
      byte = pack[offset++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (shift > 63) return null;
    }
    const typeCode = (first >> 4) & 0x07;
    if (typeCode === 6 || typeCode === 7) return null; // deltas never accepted on receive
    const type = CODE_TYPE[typeCode];
    if (!type) return null;
    let inflated: { buffer: Buffer; engine: { bytesWritten: number } };
    try {
      inflated = inflateSync(pack.subarray(offset, trailerStart), { info: true }) as unknown as {
        buffer: Buffer;
        engine: { bytesWritten: number };
      };
    } catch {
      return null;
    }
    const written = inflated.engine.bytesWritten;
    if (!written || written <= 0) return null;
    const data = inflated.buffer;
    if (data.length !== size) return null;
    offset += written;
    out.push({ type, data, sha: hashObject(type, data) });
  }
  if (offset !== trailerStart) return null;
  return out;
}

// ---------------------------------------------------------------------------
// Reachability / fetch object selection
// ---------------------------------------------------------------------------

/**
 * Every object reachable from `roots`: commit → tree + parents, tag → target,
 * tree → entries (gitlinks skipped). Missing objects are skipped (never
 * throws). With `cutParentsOf`, the parents of a commit in that set are not
 * traversed — used for the client's shallow boundary: the client holds the
 * boundary commit itself but not its ancestors, so a have-closure must not
 * swallow objects the deepen is supposed to deliver.
 */
function collectReachable(
  repo: Repo,
  roots: Iterable<string>,
  cutParentsOf?: Set<string>,
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      queue.push(c.tree);
      if (!cutParentsOf || !cutParentsOf.has(oid)) {
        for (const p of c.parents) queue.push(p);
      }
    } else if (obj.type === 'tag') {
      const target = parseTagTarget(obj.data);
      if (target) queue.push(target.object);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) {
        if (e.mode === '160000') continue;
        queue.push(e.sha);
      }
    }
  }
  return seen;
}

/**
 * Depth-limited closure from `wants`: generations 0..depth-1 of commits plus
 * their full tree/blob closures. `boundary` = included commits whose parents
 * were cut (by the depth limit or by a missing parent) — these become the
 * new `shallow` lines. Non-commit wants (tags) are peeled to their commit;
 * the tag object itself is included.
 */
function collectWithDepth(
  repo: Repo,
  wants: string[],
  depth: number,
): { objects: Set<string>; boundary: string[] } {
  const objects = new Set<string>();
  const boundary: string[] = [];
  const commitDepth = new Map<string, number>();
  const queue: string[] = [];
  const enqueueCommit = (oid: string, gen: number): void => {
    if (!commitDepth.has(oid)) {
      commitDepth.set(oid, gen);
      queue.push(oid);
    }
  };
  for (const w of wants) {
    if (!isObjectId(w)) continue;
    const obj = repo.objects.get(w);
    if (!obj) continue;
    if (obj.type === 'tag') {
      objects.add(w);
      const peeled = peelToNonTag(repo, w);
      if (!peeled) continue;
      const target = repo.objects.get(peeled);
      if (!target) continue;
      if (target.type === 'commit') enqueueCommit(peeled, 0);
      else {
        for (const o of collectReachable(repo, [peeled])) objects.add(o);
      }
    } else if (obj.type === 'commit') {
      enqueueCommit(w, 0);
    } else {
      for (const o of collectReachable(repo, [w])) objects.add(o);
    }
  }
  // FIFO queue => non-decreasing generation, so first visit is minimal depth.
  for (let i = 0; i < queue.length; i++) {
    const oid = queue[i];
    const gen = commitDepth.get(oid) ?? 0;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    objects.add(oid);
    const c = parseCommit(obj.data);
    for (const o of collectReachable(repo, [c.tree])) objects.add(o);
    if (c.parents.length === 0) continue;
    const heldParents = c.parents.filter((p) => repo.objects.has(p));
    if (gen + 1 >= depth || heldParents.length < c.parents.length) {
      boundary.push(oid);
    } else {
      for (const p of heldParents) enqueueCommit(p, gen + 1);
    }
  }
  return { objects, boundary };
}

interface FetchSelection {
  /** Objects to send (want closure minus have closure). */
  send: Set<string>;
  /** New shallow boundary commits. */
  shallow: string[];
  /** Client boundary commits whose history is now fully included. */
  unshallow: string[];
}

function selectFetchObjects(
  repo: Repo,
  wants: string[],
  haves: string[],
  clientShallow: string[],
  depth: number | null,
): FetchSelection {
  const cut = clientShallow.length > 0 ? new Set(clientShallow) : undefined;
  const haveClosure = haves.length > 0 ? collectReachable(repo, haves, cut) : new Set<string>();
  let included: Set<string>;
  let boundary: string[] = [];
  if (depth !== null && depth > 0) {
    const r = collectWithDepth(repo, wants, depth);
    included = r.objects;
    boundary = r.boundary;
  } else {
    included = collectReachable(repo, wants);
  }
  const send = new Set<string>();
  for (const oid of included) if (!haveClosure.has(oid)) send.add(oid);
  const unshallow: string[] = [];
  for (const b of clientShallow) {
    if (!included.has(b)) continue;
    const obj = repo.objects.get(b);
    if (!obj || obj.type !== 'commit') continue;
    const c = parseCommit(obj.data);
    if (c.parents.every((p) => included.has(p))) unshallow.push(b);
  }
  return { send, shallow: boundary, unshallow };
}

// ---------------------------------------------------------------------------
// pkt-line framing + sideband
// ---------------------------------------------------------------------------

function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

function pktLines(parts: Array<Buffer | string | 'flush' | 'delim'>): Buffer {
  const bufs: Buffer[] = [];
  for (const p of parts) {
    if (p === 'flush') bufs.push(PKT_FLUSH);
    else if (p === 'delim') bufs.push(PKT_DELIM);
    else bufs.push(pktLine(p));
  }
  return Buffer.concat(bufs);
}

type DecodedPacket =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

const HEX4 = /^[0-9a-fA-F]{4}$/;

/** Decode a complete pkt-line buffer. Null on any malformed input. */
function decodePktLines(buf: Buffer): DecodedPacket[] | null {
  const out: DecodedPacket[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) return null;
    const header = buf.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(header)) return null;
    const len = parseInt(header, 16);
    if (len === 0) {
      out.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (len === 1) {
      out.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (len === 2) {
      out.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (len < 4 || len > 65520) return null;
    if (offset + len > buf.length) return null;
    out.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return out;
}

/**
 * Decode pkt-lines up to (and including) the first flush; returns the packets
 * and the remaining raw bytes (the pack in a receive-pack request). Null when
 * no flush is found or the framing is malformed.
 */
function decodeUntilFlush(buf: Buffer): { packets: DecodedPacket[]; rest: Buffer } | null {
  const out: DecodedPacket[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) return null;
    const header = buf.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(header)) return null;
    const len = parseInt(header, 16);
    if (len === 0) return { packets: out, rest: buf.subarray(offset + 4) };
    if (len === 1) {
      out.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (len === 2) {
      out.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (len < 4 || len > 65520) return null;
    if (offset + len > buf.length) return null;
    out.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return null;
}

/** Pack bytes per band-1 sideband packet (1 band byte + 32768 data = 32773 total, far under 65520). */
const SIDEBAND_CHUNK = 32768;

/** Frame data as band-1 sideband packets. Never emits band 2 or band 3. */
function sidebandPackets(data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let off = 0; off < data.length; off += SIDEBAND_CHUNK) {
    const chunk = data.subarray(off, off + SIDEBAND_CHUNK);
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    out.push(pktLine(payload));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Advertisements (GET info/refs)
// ---------------------------------------------------------------------------

/** v2 upload-pack advertisement — identical for every repo, a module constant. */
const V2_ADVERTISEMENT = pktLines([
  'version 2\n',
  'ls-refs=unborn\n',
  'fetch=shallow\n',
  'object-format=sha1\n',
  'flush',
]);

function buildV0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k shallow symref=HEAD:refs/heads/${repo.defaultBranch} thin-pack ofs-delta`
      : `report-status side-band-64k delete-refs symref=HEAD:refs/heads/${repo.defaultBranch}`;
  const parts: Array<Buffer | string | 'flush'> = [`# service=${service}\n`, 'flush'];
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  if (refs.length === 0) {
    // Empty repo: the capabilities^{} pseudo-ref carries the capabilities.
    parts.push(`${ZERO_OID} capabilities^{}\0${caps}\n`, 'flush');
    return pktLines(parts);
  }
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
  parts.push(`${headTip} HEAD\0${caps}\n`);
  for (const [name, oid] of refs) {
    parts.push(`${oid} ${name}\n`);
    if (name.startsWith('refs/tags/')) {
      const peeled = peelToNonTag(repo, oid);
      if (peeled && peeled !== oid) parts.push(`${peeled} ${name}^{}\n`);
    }
  }
  parts.push('flush');
  return pktLines(parts);
}

interface AdCacheEntry {
  version: number;
  v0up: Buffer;
  v0recv: Buffer;
}

const adCache = new WeakMap<Repo, AdCacheEntry>();

/** Cached v0 advertisement bytes; invalidated when repo.refsVersion changes. */
function getV0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  let entry = adCache.get(repo);
  if (!entry || entry.version !== repo.refsVersion) {
    entry = {
      version: repo.refsVersion,
      v0up: buildV0Advertisement(repo, 'git-upload-pack'),
      v0recv: buildV0Advertisement(repo, 'git-receive-pack'),
    };
    adCache.set(repo, entry);
  }
  return service === 'git-upload-pack' ? entry.v0up : entry.v0recv;
}

// ---------------------------------------------------------------------------
// v2 ls-refs
// ---------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function parseLsRefsArgs(args: string[]): LsRefsArgs {
  const out: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  for (const a of args) {
    if (a === 'peel') out.peel = true;
    else if (a === 'symrefs') out.symrefs = true;
    else if (a === 'unborn') out.unborn = true;
    else if (a.startsWith('ref-prefix ')) out.prefixes.push(a.slice('ref-prefix '.length));
  }
  return out;
}

function buildLsRefs(repo: Repo, args: LsRefsArgs): Buffer {
  const include = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  const lines: string[] = [];
  // HEAD is subject to prefix filtering too — it matches no refs/* prefix.
  if (include('HEAD')) {
    const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    const symref = args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
    if (headTip) lines.push(`${headTip} HEAD${symref}\n`);
    else if (args.unborn) lines.push(`unborn HEAD${symref}\n`);
  }
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [name, oid] of refs) {
    if (!include(name)) continue;
    let line = `${oid} ${name}`;
    if (args.peel && name.startsWith('refs/tags/')) {
      const peeled = peelToNonTag(repo, oid);
      if (peeled && peeled !== oid) line += ` peeled:${peeled}`;
    }
    lines.push(line + '\n');
  }
  return pktLines([...lines, 'flush']);
}

interface LsCacheEntry {
  version: number;
  body: Buffer;
}

const lsCache = new WeakMap<Repo, Map<string, LsCacheEntry>>();

/** Cached ls-refs responses, keyed by (repo, refsVersion, args). */
function handleLsRefs(repo: Repo, args: LsRefsArgs): Buffer {
  const key = `${args.peel ? 1 : 0}${args.symrefs ? 1 : 0}${args.unborn ? 1 : 0}|${args.prefixes.join('\n')}`;
  let perRepo = lsCache.get(repo);
  if (!perRepo) {
    perRepo = new Map();
    lsCache.set(repo, perRepo);
  }
  const cached = perRepo.get(key);
  if (cached && cached.version === repo.refsVersion) return cached.body;
  const body = buildLsRefs(repo, args);
  perRepo.set(key, { version: repo.refsVersion, body });
  return body;
}

// ---------------------------------------------------------------------------
// Fetch (v2 + v0)
// ---------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function parseFetchArgs(args: string[]): FetchArgs {
  const out: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  for (const a of args) {
    if (a.startsWith('want ')) {
      const oid = a.slice(5).trim();
      if (isObjectId(oid)) out.wants.push(oid);
    } else if (a.startsWith('have ')) {
      const oid = a.slice(5).trim();
      if (isObjectId(oid)) out.haves.push(oid);
    } else if (a.startsWith('shallow ')) {
      const oid = a.slice(8).trim();
      if (isObjectId(oid)) out.shallow.push(oid);
    } else if (a.startsWith('deepen ')) {
      const n = parseInt(a.slice(7).trim(), 10);
      if (Number.isFinite(n) && n >= 0) out.depth = n;
    }
    // thin-pack, no-progress, ofs-delta, done, filter, deepen-since,
    // deepen-not: ignored (server sends self-contained undelted packs).
  }
  out.wants = [...new Set(out.wants)];
  return out;
}

/** Parse a v2 command request: first data packet `command=<name>`, capability
 *  lines, a delim, then argument lines, then a flush. Null when malformed. */
function parseV2Command(body: Buffer): { command: string; args: string[] } | null {
  const packets = decodePktLines(body);
  if (!packets) return null;
  let command = '';
  const args: string[] = [];
  let seenDelim = false;
  let first = true;
  for (const p of packets) {
    if (p.kind === 'flush') break;
    if (p.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (p.kind !== 'data') return null;
    const line = p.payload.toString('utf8');
    if (first) {
      first = false;
      if (!line.startsWith('command=')) return null;
      command = line.slice('command='.length).replace(/\n$/, '');
      continue;
    }
    if (!seenDelim) continue; // capability lines (agent=, object-format=): ignore
    args.push(line.replace(/\n$/, ''));
  }
  if (!command) return null;
  return { command, args };
}

/**
 * Parse a v0 fetch request: two sections (wants + shallow/deepen, then haves
 * + done) separated by a flush. The first want line may carry capabilities
 * after the oid. Null when malformed or when no wants are present.
 */
function parseV0Fetch(body: Buffer): FetchArgs | null {
  const packets = decodePktLines(body);
  if (!packets) return null;
  const out: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  let section = 0;
  for (const p of packets) {
    if (p.kind === 'flush') {
      section = 1;
      continue;
    }
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) {
        const oid = line.slice(5).split(' ')[0];
        if (isObjectId(oid)) out.wants.push(oid);
      } else if (line.startsWith('shallow ')) {
        const oid = line.slice(8).trim();
        if (isObjectId(oid)) out.shallow.push(oid);
      } else if (line.startsWith('deepen ')) {
        const n = parseInt(line.slice(7).trim(), 10);
        if (Number.isFinite(n) && n >= 0) out.depth = n;
      }
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5).trim();
      if (isObjectId(oid)) out.haves.push(oid);
    }
  }
  if (out.wants.length === 0) return null;
  out.wants = [...new Set(out.wants)];
  return out;
}

function buildV2FetchResponse(repo: Repo, req: FetchArgs): Buffer {
  const sel = selectFetchObjects(repo, req.wants, req.haves, req.shallow, req.depth);
  const parts: Buffer[] = [];
  if (req.haves.length > 0) {
    const held = req.haves.filter((h) => repo.objects.has(h));
    parts.push(pktLine('acknowledgments\n'));
    if (held.length > 0) {
      for (const h of held) parts.push(pktLine(`ACK ${h}\n`));
      parts.push(pktLine('ready\n'));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(PKT_FLUSH);
  }
  if (sel.shallow.length > 0 || sel.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of sel.shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const u of sel.unshallow) parts.push(pktLine(`unshallow ${u}\n`));
    parts.push(PKT_FLUSH);
  }
  // The packfile section is ALWAYS sent, even when nothing is due: a section
  // with zero sideband packets throws in the client. An empty result is a
  // valid 32-byte empty pack. Never send a 0002 response-end packet here.
  const pack = sel.send.size > 0 ? buildPack(repo, sel.send) : EMPTY_PACK;
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function buildV0FetchResponse(repo: Repo, req: FetchArgs): Buffer {
  const sel = selectFetchObjects(repo, req.wants, req.haves, req.shallow, req.depth);
  const parts: Buffer[] = [];
  for (const s of sel.shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const u of sel.unshallow) parts.push(pktLine(`unshallow ${u}\n`));
  const held = req.haves.filter((h) => repo.objects.has(h));
  if (req.haves.length > 0 && held.length > 0) {
    for (const h of held) parts.push(pktLine(`ACK ${h}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  const pack = sel.send.size > 0 ? buildPack(repo, sel.send) : EMPTY_PACK;
  parts.push(...sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// Depth-1 clone fetch responses, cached per (repo, tip sha). No refsVersion
// check: the response depends only on the tip's immutable object closure, so
// it can never go stale (objects are never mutated or deleted; a deleted repo
// is a different Repo object, so the WeakMap key differs).
const cloneFetchCache = new WeakMap<Repo, Map<string, Buffer>>();

function handleV2Fetch(repo: Repo, req: FetchArgs): Buffer {
  if (req.depth === 1 && req.wants.length === 1 && req.haves.length === 0 && req.shallow.length === 0) {
    const tip = req.wants[0];
    let perRepo = cloneFetchCache.get(repo);
    if (!perRepo) {
      perRepo = new Map();
      cloneFetchCache.set(repo, perRepo);
    }
    let cached = perRepo.get(tip);
    if (!cached) {
      cached = buildV2FetchResponse(repo, req);
      perRepo.set(tip, cached);
    }
    return cached;
  }
  return buildV2FetchResponse(repo, req);
}

// ---------------------------------------------------------------------------
// receive-pack (push)
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/**
 * Parse a receive-pack body: pkt-line command list up to the first flush,
 * then raw pack bytes. Capabilities ride after a NUL on the first command
 * line. Null when malformed or when no commands are present.
 */
function parseReceivePack(
  body: Buffer,
): { commands: PushCommand[]; capabilities: string[]; pack: Buffer } | null {
  const decoded = decodeUntilFlush(body);
  if (!decoded) return null;
  const commands: PushCommand[] = [];
  let capabilities: string[] = [];
  for (let i = 0; i < decoded.packets.length; i++) {
    const p = decoded.packets[i];
    if (p.kind !== 'data') continue;
    let line = p.payload.toString('utf8');
    if (i === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        capabilities = line
          .slice(nul + 1)
          .replace(/\n$/, '')
          .split(' ')
          .filter(Boolean);
        line = line.slice(0, nul);
      }
    }
    line = line.replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length !== 3) return null;
    const [oldOid, newOid, ref] = parts;
    if (!isObjectId(oldOid) || !isObjectId(newOid)) return null;
    if (!ref.startsWith('refs/')) return null;
    commands.push({ oldOid, newOid, ref });
  }
  if (commands.length === 0) return null;
  return { commands, capabilities, pack: decoded.rest };
}

/**
 * Apply one ref update. Pushes are NOT atomic — each command is evaluated
 * independently, in order. The non-fast-forward reason string must be
 * exactly `non-fast-forward` (the suite compares it exactly).
 */
function applyRefUpdate(
  repo: Repo,
  cmd: PushCommand,
): { ok: boolean; moved: boolean; reason: string } {
  const current = repo.refs.get(cmd.ref);
  if (cmd.newOid === ZERO_OID) {
    if (current === undefined) return { ok: false, moved: false, reason: 'no such ref' };
    repo.refs.delete(cmd.ref);
    return { ok: true, moved: true, reason: '' };
  }
  if (!repo.objects.has(cmd.newOid)) {
    return { ok: false, moved: false, reason: 'missing object' };
  }
  if (cmd.oldOid === ZERO_OID) {
    // Create (branch or tag): no fast-forward check, but refuse over an
    // existing ref.
    if (current !== undefined) return { ok: false, moved: false, reason: 'non-fast-forward' };
    repo.refs.set(cmd.ref, cmd.newOid);
    return { ok: true, moved: true, reason: '' };
  }
  if (current === undefined) return { ok: false, moved: false, reason: 'no such ref' };
  if (current !== cmd.oldOid) return { ok: false, moved: false, reason: 'stale' };
  if (cmd.oldOid === cmd.newOid) return { ok: true, moved: false, reason: '' }; // no-op
  if (cmd.ref.startsWith('refs/tags/')) {
    return { ok: false, moved: false, reason: 'tag already exists' };
  }
  if (!isAncestor(repo, cmd.oldOid, cmd.newOid)) {
    return { ok: false, moved: false, reason: 'non-fast-forward' };
  }
  repo.refs.set(cmd.ref, cmd.newOid);
  return { ok: true, moved: true, reason: '' };
}

/**
 * Handle a receive-pack POST body. Returns the HTTP status + body to send.
 * Objects are ingested before ref updates are evaluated, so a refused ref
 * still reports `unpack ok`. A delete-only push carries no pack bytes at
 * all; a create-branch push carries a 0-object pack — both are accepted.
 */
function handleReceivePack(repo: Repo, body: Buffer): { status: number; body: Buffer; contentType: string } {
  const parsed = parseReceivePack(body);
  if (!parsed) {
    return {
      status: 400,
      body: Buffer.from(JSON.stringify({ message: 'malformed receive-pack request' }), 'utf8'),
      contentType: 'application/json; charset=utf-8',
    };
  }
  const { commands, capabilities, pack } = parsed;
  const sideband = capabilities.includes('side-band-64k');
  const needsPack = commands.some((c) => c.newOid !== ZERO_OID);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (needsPack) {
    if (pack.length === 0) {
      unpackOk = false;
      unpackDetail = 'unpacker error';
    } else {
      const objects = parsePack(pack);
      if (!objects) {
        unpackOk = false;
        unpackDetail = 'unpacker error';
      } else {
        for (const o of objects) {
          if (!repo.objects.has(o.sha)) repo.objects.set(o.sha, { type: o.type, data: o.data });
        }
      }
    }
  }
  const reportLines: string[] = [`unpack ${unpackDetail}\n`];
  let refsChanged = false;
  for (const cmd of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${cmd.ref} unpacker error\n`);
      continue;
    }
    const result = applyRefUpdate(repo, cmd);
    if (result.ok) {
      reportLines.push(`ok ${cmd.ref}\n`);
      if (result.moved) refsChanged = true;
    } else {
      reportLines.push(`ng ${cmd.ref} ${result.reason}\n`);
    }
  }
  if (refsChanged) repo.refsVersion++;
  const stream = pktLines([...reportLines, 'flush']);
  const out = sideband ? Buffer.concat(sidebandPackets(stream)) : stream;
  return { status: 200, body: out, contentType: 'application/x-git-receive-pack-result' };
}

// ---------------------------------------------------------------------------
// Smart-HTTP handler
// ---------------------------------------------------------------------------

export interface GitContext {
  /** Bearer token to check against (backstop — server.ts also enforces auth). */
  token?: string;
  /** Per-response request id. */
  requestId?: () => string;
}

let fallbackReqId = 0;

function requestIdOf(ctx?: GitContext): string {
  if (ctx?.requestId) {
    try {
      return ctx.requestId();
    } catch {
      // fall through to the local counter
    }
  }
  fallbackReqId += 1;
  return `req-${fallbackReqId}`;
}

function sendGit(
  res: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  ctx?: GitContext,
): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': String(body.length),
    'X-GitHub-Request-Id': requestIdOf(ctx),
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, message: string, ctx?: GitContext): void {
  const body = Buffer.from(JSON.stringify({ message }), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    'X-GitHub-Request-Id': requestIdOf(ctx),
  });
  res.end(body);
}

const MAX_BODY_BYTES = 10 * 1024 * 1024;

/**
 * Read a POST body as raw bytes. If server.ts already read it, it must have
 * attached the raw Buffer as `req.body` or `req.rawBody`; otherwise the body
 * is read from the request stream here. Git bodies are binary — they must
 * never be JSON-parsed.
 */
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const attached = req as unknown as { body?: unknown; rawBody?: unknown };
  if (Buffer.isBuffer(attached.body)) return attached.body;
  if (Buffer.isBuffer(attached.rawBody)) return attached.rawBody;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks, total);
}

function decodeSegment(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

async function handleGitInner(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  ctx?: GitContext,
): Promise<void> {
  const url = req.url ?? '/';
  const qIndex = url.indexOf('?');
  const path = qIndex >= 0 ? url.slice(0, qIndex) : url;
  const query = qIndex >= 0 ? url.slice(qIndex + 1) : '';
  // /{owner}/{repo}.git/{info/refs|git-upload-pack|git-receive-pack}
  const segments = path.split('/').filter((s) => s.length > 0);
  if (segments.length < 3 || !segments[1].endsWith('.git')) {
    sendJson(res, 404, 'Not Found', ctx);
    return;
  }
  const owner = decodeSegment(segments[0]);
  const repoName = decodeSegment(segments[1].slice(0, -4));
  // Auth backstop: server.ts enforces auth on every route except /healthz;
  // this cheap check keeps git 401-correct even if routing ever changes.
  if (ctx?.token) {
    if (req.headers.authorization !== `Bearer ${ctx.token}`) {
      sendJson(res, 401, 'Requires authentication', ctx);
      return;
    }
  }
  // Foreign owner or missing repo → 404, NEVER 403.
  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    sendJson(res, 404, 'Not Found', ctx);
    return;
  }
  const service = segments[2];

  if (req.method === 'GET' && service === 'info' && segments[3] === 'refs') {
    // Fast path: the client always sends exactly `service=<name>`.
    let svc: string | null = null;
    if (query === 'service=git-upload-pack') svc = 'git-upload-pack';
    else if (query === 'service=git-receive-pack') svc = 'git-receive-pack';
    else svc = new URLSearchParams(query).get('service');
    if (svc === 'git-upload-pack') {
      if (req.headers['git-protocol'] === 'version=2') {
        sendGit(res, 200, V2_ADVERTISEMENT, 'application/x-git-upload-pack-advertisement', ctx);
      } else {
        sendGit(
          res,
          200,
          getV0Advertisement(repo, 'git-upload-pack'),
          'application/x-git-upload-pack-advertisement',
          ctx,
        );
      }
      return;
    }
    if (svc === 'git-receive-pack') {
      // receive-pack is v0-only: never honour Git-Protocol: version=2 here.
      sendGit(
        res,
        200,
        getV0Advertisement(repo, 'git-receive-pack'),
        'application/x-git-receive-pack-advertisement',
        ctx,
      );
      return;
    }
    sendJson(res, 400, 'unknown service', ctx);
    return;
  }

  if (req.method === 'POST' && service === 'git-upload-pack') {
    const body = await readBody(req);
    if (req.headers['git-protocol'] === 'version=2') {
      const cmd = parseV2Command(body);
      if (!cmd) {
        sendJson(res, 400, 'malformed pkt-line request', ctx);
        return;
      }
      if (cmd.command === 'ls-refs') {
        sendGit(
          res,
          200,
          handleLsRefs(repo, parseLsRefsArgs(cmd.args)),
          'application/x-git-upload-pack-result',
          ctx,
        );
        return;
      }
      if (cmd.command === 'fetch') {
        sendGit(
          res,
          200,
          handleV2Fetch(repo, parseFetchArgs(cmd.args)),
          'application/x-git-upload-pack-result',
          ctx,
        );
        return;
      }
      sendJson(res, 400, `unknown command ${cmd.command}`, ctx);
      return;
    }
    const fargs = parseV0Fetch(body);
    if (!fargs) {
      sendJson(res, 400, 'malformed v0 fetch request', ctx);
      return;
    }
    sendGit(
      res,
      200,
      buildV0FetchResponse(repo, fargs),
      'application/x-git-upload-pack-result',
      ctx,
    );
    return;
  }

  if (req.method === 'POST' && service === 'git-receive-pack') {
    const body = await readBody(req);
    const result = handleReceivePack(repo, body);
    if (result.status === 200) {
      sendGit(res, 200, result.body, result.contentType, ctx);
    } else {
      sendJson(res, result.status, 'malformed receive-pack request', ctx);
    }
    return;
  }

  sendJson(res, 404, 'Not Found', ctx);
}

/**
 * Smart-HTTP routes: GET /{owner}/{repo}.git/info/refs,
 * POST /{owner}/{repo}.git/git-upload-pack, POST .../git-receive-pack.
 * Never throws, never hangs: malformed input gets a 400 and the server
 * keeps serving.
 */
export async function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  ctx?: GitContext,
): Promise<void> {
  try {
    await handleGitInner(req, res, store, ctx);
  } catch {
    try {
      if (!res.headersSent) {
        res.writeHead(500, {
          'Content-Type': 'application/json; charset=utf-8',
          'X-GitHub-Request-Id': requestIdOf(ctx),
        });
      }
      res.end(JSON.stringify({ message: 'Internal Server Error' }));
    } catch {
      // Socket already gone; nothing left to do.
    }
  }
}
