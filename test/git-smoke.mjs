// test/git-smoke.mjs — smoke test for src/git.ts.
//
// Two parts:
//   1. Unit tests of the pure git API (no HTTP).
//   2. End-to-end over real HTTP, driving handleGit with the suite's OWN
//      GitClient (kit/program/env/src/git-client.ts) through the same flows
//      the 30 conformance checks use: push, ls-refs, clone, incremental
//      fetch, shallow clone + deepen, non-FF refusal, mixed push, branch
//      delete, annotated tag + peel, v0 fallback, unknown-repo 404, and
//      malformed-POST survival.
//
// Run from repo/:
//   node --experimental-strip-types test/git-smoke.mjs
// Exit code 0 only when every check passes.

import { createServer } from 'node:http';
import { Store } from '../src/store.ts';
import * as git from '../src/git.ts';
import {
  GitClient,
  ZERO_OID,
  buildCommit,
  buildTag,
  buildTree,
  hashObject as kitHashObject,
  readPack as kitReadPack,
  writePack as kitWritePack,
} from '../../github-core-clone-01-kit/program/env/src/git-client.ts';

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`);
  }
}
const buf = (s) => Buffer.from(s, 'utf8');

// ===========================================================================
// 1. Unit tests
// ===========================================================================
console.log('== unit: object layer ==');
{
  const hello = buf('hello\n');
  const sha = git.hashObject('blob', hello);
  // sha1("blob 6\0hello\n") — verified against sha1sum.
  check('hashObject matches known git sha', sha === 'ce013625030ba8dba906f756967f9e9ca394464a', sha);
  check('hashObject no-newline variant', git.hashObject('blob', buf('hello')) === 'b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0');
  check('hashObject matches kit hashObject', sha === kitHashObject('blob', hello));
  const store = new Store('testviewer');
  const repo = store.createRepo('u1', false, '');
  const treeSha = git.writeObject(repo, 'tree', git.buildTree([{ mode: '100644', name: 'a.txt', sha }]));
  const commitSha = git.writeObject(
    repo,
    'commit',
    git.buildCommit(treeSha, [], 'Conformance <conformance@make.fun> 1735689601 +0000', 'Conformance <conformance@make.fun> 1735689601 +0000', 'first\n'),
  );
  const parsed = git.parseCommit(repo.objects.get(commitSha).data);
  check('parseCommit round-trip', parsed.tree === treeSha && parsed.parents.length === 0 && parsed.message === 'first\n');
  const entries = git.parseTree(repo.objects.get(treeSha).data);
  check('parseTree round-trip', entries.length === 1 && entries[0].mode === '100644' && entries[0].name === 'a.txt' && entries[0].sha === sha);
  // tree sort: a directory sorts as if suffixed with '/'; '.' (0x2e) < '/'
  // (0x2f) < '0' (0x30), so 'a.txt' < 'a' (as 'a/') < 'a0.txt'.
  const sorted = git.buildTree([
    { mode: '100644', name: 'a.txt', sha },
    { mode: '40000', name: 'a', sha: treeSha },
    { mode: '100644', name: 'a0.txt', sha },
  ]);
  const names = git.parseTree(sorted).map((e) => e.name);
  check('buildTree git-order sort', JSON.stringify(names) === JSON.stringify(['a.txt', 'a', 'a0.txt']), names.join(','));
}

console.log('== unit: commitFile / readFileAt / deleteFile ==');
let repo2;
let c1sha;
let c2sha;
{
  const store = new Store('testviewer');
  repo2 = store.createRepo('u2', false, '');
  // Unborn repo: first commit creates the default branch.
  const r1 = git.commitFile(repo2, { path: 'config/token.css', content: buf('v1\n'), message: 'add token' });
  check('commitFile on unborn repo succeeds', !('error' in r1) && r1.created === true);
  c1sha = r1.commitSha;
  check('default branch created from first commit', git.resolveRef(repo2, 'main') === c1sha);
  check('resolveRef refs/heads/main', git.resolveRef(repo2, 'refs/heads/main') === c1sha);
  check('resolveRef raw sha', git.resolveRef(repo2, c1sha) === c1sha);
  check('resolveRef unknown branch', git.resolveRef(repo2, 'nope') === null);
  const f = git.readFileAt(repo2, 'main', 'config/token.css');
  check('readFileAt file round-trip', f?.kind === 'file' && f.blobSha === r1.blobSha && f.data.toString() === 'v1\n');
  const d = git.readFileAt(repo2, 'main', 'config');
  check(
    'readFileAt dir listing',
    d?.kind === 'dir' && d.entries.length === 1 && d.entries[0].name === 'token.css' && d.entries[0].path === 'config/token.css' && d.entries[0].type === 'file',
  );
  const root = git.readFileAt(repo2, 'main', '');
  check('readFileAt root listing', root?.kind === 'dir' && root.entries.length === 1 && root.entries[0].type === 'dir' && root.entries[0].name === 'config');
  check('readFileAt missing path', git.readFileAt(repo2, 'main', 'nope.txt') === null);
  check('readFileAt unknown ref', git.readFileAt(repo2, 'nope', 'config/token.css') === null);

  // Update with the correct expected sha, then a stale retry.
  const r2 = git.commitFile(repo2, { path: 'config/token.css', content: buf('v2\n'), message: 'update token', expectedBlobSha: r1.blobSha });
  check('commitFile update succeeds', !('error' in r2) && r2.created === false && r2.blobSha !== r1.blobSha);
  c2sha = r2.commitSha;
  const stale = git.commitFile(repo2, { path: 'config/token.css', content: buf('vX\n'), message: 'stale', expectedBlobSha: r1.blobSha });
  check('commitFile stale expected sha', stale.error === 'stale');
  const after = git.readFileAt(repo2, 'main', 'config/token.css');
  check('stale commitFile changes nothing', after?.kind === 'file' && after.data.toString() === 'v2\n');

  // listCommits: newest first.
  const commits = git.listCommits(repo2, 'main');
  check('listCommits newest first', commits.length === 2 && commits[0].sha === c2sha && commits[1].sha === c1sha && commits[0].message === 'update token');

  // deleteFile.
  const del = git.deleteFile(repo2, { path: 'config/token.css', message: 'remove token', expectedBlobSha: r2.blobSha });
  check('deleteFile succeeds', !('error' in del));
  check('file gone after delete', git.readFileAt(repo2, 'main', 'config/token.css') === null);
  check('empty dir pruned after delete', git.readFileAt(repo2, 'main', 'config') === null);
  check('deleteFile missing file', git.deleteFile(repo2, { path: 'config/token.css', message: 'again' }).error === 'not-found');
}

console.log('== unit: diffTrees / mergeBase / isAncestor ==');
{
  const store = new Store('testviewer');
  const repo = store.createRepo('u3', false, '');
  git.commitFile(repo, { path: 'a.txt', content: buf('one\ntwo\n'), message: 'a1' });
  git.commitFile(repo, { path: 'b.txt', content: buf('x\n'), message: 'b1' });
  const c1 = git.resolveRef(repo, 'main');
  git.commitFile(repo, { path: 'a.txt', content: buf('one\nTWO\nthree\n'), message: 'a2' });
  git.deleteFile(repo, { path: 'b.txt', message: 'drop b' });
  git.commitFile(repo, { path: 'c.txt', content: buf('n1\nn2\nn3\n'), message: 'c1' });
  const c2 = git.resolveRef(repo, 'main');
  const diff = git.diffTrees(repo, c1, c2);
  const byName = Object.fromEntries(diff.map((d) => [d.filename, d]));
  check('diffTrees modified real line counts', byName['a.txt']?.status === 'modified' && byName['a.txt'].additions === 2 && byName['a.txt'].deletions === 1 && byName['a.txt'].changes === 3, JSON.stringify(byName['a.txt']));
  check('diffTrees removed counts lines', byName['b.txt']?.status === 'removed' && byName['b.txt'].deletions === 1 && byName['b.txt'].additions === 0);
  check('diffTrees added counts lines', byName['c.txt']?.status === 'added' && byName['c.txt'].additions === 3 && byName['c.txt'].deletions === 0);
  check('diffTrees sorted by filename', diff.map((d) => d.filename).join(',') === 'a.txt,b.txt,c.txt');
  check('diffTrees empty for identical commits', git.diffTrees(repo, c2, c2).length === 0);

  check('isAncestor self', git.isAncestor(repo, c1, c1) === true);
  check('isAncestor ancestor', git.isAncestor(repo, c1, c2) === true);
  check('isAncestor not ancestor', git.isAncestor(repo, c2, c1) === false);
  check('mergeBase linear', git.mergeBase(repo, c1, c2) === c1);
  // Diamond: branch from c1, mergeBase of the two tips is c1.
  repo.refs.set('refs/heads/side', c1);
  repo.refsVersion++;
  git.commitFile(repo, { branch: 'side', path: 's.txt', content: buf('s\n'), message: 'side' });
  const sideTip = git.resolveRef(repo, 'side');
  check('mergeBase diamond', git.mergeBase(repo, c2, sideTip) === c1);
}

console.log('== unit: squashMerge success + conflict ==');
{
  const store = new Store('testviewer');
  const repo = store.createRepo('u4', false, '');
  const mkPr = (number, headRef, baseRef, headSha, baseSha) => ({
    number, title: `pr ${number}`, body: '', state: 'open', headRef, baseRef, headSha, baseSha,
    merged: false, mergedAt: null, mergeCommitSha: null, mergeable: true, createdSeq: number,
    createdAt: '', updatedAt: '',
  });
  git.commitFile(repo, { path: 'f.txt', content: buf('base\nline2\n'), message: 'base' });
  const base = git.resolveRef(repo, 'main');
  repo.refs.set('refs/heads/feature', base);
  repo.refsVersion++;
  git.commitFile(repo, { branch: 'feature', path: 'f.txt', content: buf('feat\nline2\n'), message: 'feat change' });
  git.commitFile(repo, { branch: 'feature', path: 'extra.txt', content: buf('e\n'), message: 'add extra' });
  const featTip = git.resolveRef(repo, 'feature');
  const merged = git.squashMerge(repo, mkPr(1, 'feature', 'main', featTip, base));
  check('squashMerge success', !('error' in merged));
  check('base branch moved to merge commit', git.resolveRef(repo, 'main') === merged.sha);
  const fAfter = git.readFileAt(repo, 'main', 'f.txt');
  check('squashMerge applies head content', fAfter?.kind === 'file' && fAfter.data.toString() === 'feat\nline2\n');
  check('squashMerge applies added file', git.readFileAt(repo, 'main', 'extra.txt')?.kind === 'file');
  const commits = git.listCommits(repo, 'main');
  check('squashMerge commit message', commits[0].sha === merged.sha && commits[0].message === 'Merge pull request #1 from feature', commits[0]?.message);
  check('squashMerge is one commit', commits.length === 2); // base + merge

  // Conflict: two branches change the same file differently from the same base.
  repo.refs.set('refs/heads/b2', base);
  repo.refsVersion++;
  git.commitFile(repo, { branch: 'b2', path: 'f.txt', content: buf('other\nline2\n'), message: 'other change' });
  const b2Tip = git.resolveRef(repo, 'b2');
  const tipBefore = git.resolveRef(repo, 'main');
  const conflicted = git.squashMerge(repo, mkPr(2, 'b2', 'main', b2Tip, base));
  check('squashMerge conflict detected', conflicted.error === 'conflict');
  check('conflicted merge changes nothing', git.resolveRef(repo, 'main') === tipBefore);
  // Same change on both sides is NOT a conflict.
  repo.refs.set('refs/heads/b3', base);
  repo.refsVersion++;
  git.commitFile(repo, { branch: 'b3', path: 'f.txt', content: buf('feat\nline2\n'), message: 'same change' });
  const b3Tip = git.resolveRef(repo, 'b3');
  const sameChange = git.squashMerge(repo, mkPr(3, 'b3', 'main', b3Tip, base));
  check('squashMerge same-change both sides is not a conflict', !('error' in sameChange));
}

console.log('== unit: pack round-trip vs the kit ==');
{
  const store = new Store('testviewer');
  const repo = store.createRepo('u5', false, '');
  const blobSha = git.writeObject(repo, 'blob', buf('pack me\n'));
  const treeSha = git.writeObject(repo, 'tree', git.buildTree([{ mode: '100644', name: 'p.txt', sha: blobSha }]));
  const commitSha = git.writeObject(repo, 'commit', git.buildCommit(treeSha, [], 'A <a@x> 1735689601 +0000', 'A <a@x> 1735689601 +0000', 'pack\n'));
  const mine = git.buildPack(repo, [commitSha, treeSha, blobSha]);
  const kitRead = kitReadPack(mine);
  check('kit readPack parses my pack', kitRead.objects.size === 3 && kitRead.checksumOk && kitRead.deltaCount === 0 && kitRead.declaredCount === 3);
  check('kit readPack object bytes match', kitRead.objects.get(blobSha)?.data.toString() === 'pack me\n' && kitRead.objects.get(commitSha)?.type === 'commit');
  const kitPack = kitWritePack([
    { type: 'blob', data: buf('pack me\n') },
    { type: 'tree', data: repo.objects.get(treeSha).data },
    { type: 'commit', data: repo.objects.get(commitSha).data },
  ]);
  const myRead = git.parsePack(kitPack);
  check('my parsePack parses kit pack', myRead !== null && myRead.length === 3 && myRead.some((o) => o.sha === commitSha && o.type === 'commit'));
  check('empty pack is 32 bytes', git.EMPTY_PACK.length === 32 && git.buildPack(repo, []).length === 32);
  check('empty pack parses to []', git.parsePack(git.EMPTY_PACK)?.length === 0 && kitReadPack(git.EMPTY_PACK).objects.size === 0);
  const corrupt = Buffer.from(mine);
  corrupt[corrupt.length - 1] ^= 0xff;
  check('corrupt trailer rejected', git.parsePack(corrupt) === null);
  check('truncated pack rejected', git.parsePack(mine.subarray(0, 20)) === null);
}

// ===========================================================================
// 2. End-to-end over HTTP with the suite's own GitClient
// ===========================================================================
console.log('== e2e: smart HTTP via the kit GitClient ==');

const TOKEN = 'test-token';
const VIEWER = 'testviewer';
const e2eStore = new Store(VIEWER);

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/api/v3/user/repos') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const created = e2eStore.createRepo(body.name, !!body.private, body.description ?? '');
      if (!created) {
        res.writeHead(422, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'already exists' }));
        return;
      }
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: created.id, name: created.name }));
      return;
    }
    if (req.url && /^\/[^/]+\/[^/]+\.git\//.test(req.url)) {
      await git.handleGit(req, res, e2eStore, { token: TOKEN });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Not Found' }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: String(err) }));
  }
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const baseUrl = `http://127.0.0.1:${port}`;
const client = new GitClient({ baseUrl, token: TOKEN });

try {
  // Build a 3-commit chain with the kit's own builders (scenario-style).
  const mkCommit = (files, parents, message, ts) => {
    const objects = [];
    const entries = [];
    for (const [name, content] of files) {
      const data = buf(content);
      const oid = kitHashObject('blob', data);
      objects.push({ type: 'blob', data });
      entries.push({ mode: '100644', name, oid });
    }
    const treeData = buildTree(entries);
    const treeOid = kitHashObject('tree', treeData);
    objects.push({ type: 'tree', data: treeData });
    const commitData = buildCommit({ tree: treeOid, parents, message, timestamp: ts });
    const commitOid = kitHashObject('commit', commitData);
    objects.push({ type: 'commit', data: commitData });
    return { objects, commitOid, commitData };
  };
  const c1 = mkCommit([['a.txt', 'one\n'], ['b.txt', 'bee\n']], [], 'c1\n', 1700000000);
  const c2 = mkCommit([['a.txt', 'one\ntwo\n'], ['b.txt', 'bee\n']], [c1.commitOid], 'c2\n', 1700000001);
  const c3 = mkCommit([['a.txt', 'one\ntwo\nthree\n'], ['b.txt', 'bee\n']], [c2.commitOid], 'c3\n', 1700000002);

  await client.createRepo(VIEWER, 'smoke1');
  const push1 = await client.push(VIEWER, 'smoke1', [{ oldOid: ZERO_OID, newOid: c1.commitOid, ref: 'refs/heads/main' }], { objects: c1.objects });
  check('e2e push first commit', push1.report?.unpackOk === true && push1.report.refs[0]?.ok === true && push1.sideband === true);

  const ls = await client.lsRefs(VIEWER, 'smoke1', { peel: true, symrefs: true });
  check('e2e ls-refs protocol 2 + HEAD symref', ls.protocol === 2 && ls.headSymref === 'refs/heads/main' && ls.refs.find((r) => r.name === 'refs/heads/main')?.oid === c1.commitOid);

  const ad = await client.advertisement(VIEWER, 'smoke1', 'git-upload-pack');
  check('e2e v2 advertisement has fetch=shallow + ls-refs=unborn', ad.protocol === 2 && ad.capabilities.get('fetch') === 'shallow' && (ad.capabilities.get('ls-refs') ?? '').includes('unborn'));

  const adRecv = await client.advertisement(VIEWER, 'smoke1', 'git-receive-pack');
  check('e2e receive-pack v0 advertisement', adRecv.protocol === 0 && adRecv.capabilities.has('report-status') && adRecv.capabilities.has('side-band-64k') && adRecv.capabilities.has('delete-refs'));

  const clone1 = await client.clone(VIEWER, 'smoke1');
  check('e2e full clone', clone1.objects.size === 4 && clone1.objects.has(c1.commitOid) && clone1.checksumOk, `size=${clone1.objects.size}`);

  const push2 = await client.push(VIEWER, 'smoke1', [{ oldOid: c1.commitOid, newOid: c3.commitOid, ref: 'refs/heads/main' }], {
    objects: [...c2.objects, ...c3.objects].filter((o, i, a) => a.findIndex((x) => kitHashObject(x.type, x.data) === kitHashObject(o.type, o.data)) === i),
  });
  check('e2e push update to c3', push2.report?.refs[0]?.ok === true);

  const inc = await client.fetch(VIEWER, 'smoke1', { wants: [c3.commitOid], haves: [c1.commitOid], haveObjects: clone1.objects });
  check('e2e incremental fetch delivers new, not old', inc.objects.has(c3.commitOid) && inc.objects.has(c2.commitOid) && !inc.objects.has(c1.commitOid));

  const nothing = await client.fetch(VIEWER, 'smoke1', { wants: [c3.commitOid], haves: [c3.commitOid], haveObjects: inc.objects });
  check('e2e fetch nothing new transfers 0 objects', nothing.objects.size === 0 && nothing.packBytes === 32);

  const shallow = await client.clone(VIEWER, 'smoke1', { depth: 1 });
  check('e2e depth-1 clone: tip only', shallow.objects.has(c3.commitOid) && !shallow.objects.has(c2.commitOid) && !shallow.objects.has(c1.commitOid));
  check('e2e depth-1 shallow-info names tip', shallow.shallow.includes(c3.commitOid));

  const deepened = await client.fetch(VIEWER, 'smoke1', { wants: [c3.commitOid], haves: [c3.commitOid], shallow: [c3.commitOid], depth: 2, haveObjects: shallow.objects });
  check('e2e deepen 2 delivers parent only', deepened.objects.has(c2.commitOid) && !deepened.objects.has(c1.commitOid) && !deepened.objects.has(c3.commitOid));
  check('e2e deepen moves boundary', deepened.shallow.includes(c2.commitOid) || deepened.unshallow.includes(c3.commitOid), `shallow=${deepened.shallow} unshallow=${deepened.unshallow}`);

  // Non-fast-forward refusal.
  const sibling = mkCommit([['a.txt', 'sibling\n'], ['b.txt', 'bee\n']], [c1.commitOid], 'sibling\n', 1700000003);
  const nonFf = await client.push(VIEWER, 'smoke1', [{ oldOid: c3.commitOid, newOid: sibling.commitOid, ref: 'refs/heads/main' }], { objects: sibling.objects });
  check('e2e non-FF refused with exact reason', nonFf.report?.unpackOk === true && nonFf.report.refs[0]?.ok === false && nonFf.report.refs[0]?.reason === 'non-fast-forward');
  const lsAfterNonFf = await client.lsRefs(VIEWER, 'smoke1');
  check('e2e non-FF changes nothing', lsAfterNonFf.refs.find((r) => r.name === 'refs/heads/main')?.oid === c3.commitOid);

  // Mixed push (mirrors the real check's setup): side exists at c3 first,
  // then one push advances main (FF) and moves side to a non-FF sibling.
  const sideCreate = await client.push(VIEWER, 'smoke1', [{ oldOid: ZERO_OID, newOid: c3.commitOid, ref: 'refs/heads/side' }], { objects: [] });
  check('e2e mixed-push setup: side created at c3', sideCreate.report?.refs[0]?.ok === true);
  const fwd = mkCommit([['a.txt', 'one\ntwo\nthree\nfour\n'], ['b.txt', 'bee\n']], [c3.commitOid], 'c4\n', 1700000004);
  const mixed = await client.push(VIEWER, 'smoke1', [
    { oldOid: c3.commitOid, newOid: fwd.commitOid, ref: 'refs/heads/main' },
    { oldOid: c3.commitOid, newOid: sibling.commitOid, ref: 'refs/heads/side' },
  ], { objects: [...fwd.objects, ...sibling.objects] });
  check('e2e mixed push: exactly 2 report lines, ok + ng', mixed.report?.refs.length === 2 && mixed.report.refs[0]?.ok === true && mixed.report.refs[1]?.ok === false && mixed.report.refs[1]?.reason === 'non-fast-forward', JSON.stringify(mixed.report?.refs));
  const lsMixed = await client.lsRefs(VIEWER, 'smoke1');
  check('e2e mixed push applies only the ok half', lsMixed.refs.find((r) => r.name === 'refs/heads/main')?.oid === fwd.commitOid && lsMixed.refs.find((r) => r.name === 'refs/heads/side')?.oid === c3.commitOid);

  // Create-branch push carries a 0-object pack; delete push carries no pack.
  const createBranch = await client.push(VIEWER, 'smoke1', [{ oldOid: ZERO_OID, newOid: fwd.commitOid, ref: 'refs/heads/feature' }], { objects: [] });
  check('e2e create-branch with 0-object pack', createBranch.report?.refs[0]?.ok === true);
  const delBranch = await client.push(VIEWER, 'smoke1', [{ oldOid: fwd.commitOid, newOid: ZERO_OID, ref: 'refs/heads/feature' }]);
  check('e2e delete-branch with no pack', delBranch.report?.unpackOk === true && delBranch.report.refs[0]?.ok === true);
  const lsAfterDel = await client.lsRefs(VIEWER, 'smoke1');
  check('e2e branch gone after delete', !lsAfterDel.refs.some((r) => r.name === 'refs/heads/feature'));

  // Annotated tag + peel.
  const tagData = buildTag({ object: fwd.commitOid, type: 'commit', tag: 'v1', message: 'v1\n', timestamp: 1700000005 });
  const tagOid = kitHashObject('tag', tagData);
  const tagPush = await client.push(VIEWER, 'smoke1', [{ oldOid: ZERO_OID, newOid: tagOid, ref: 'refs/tags/v1' }], { objects: [{ type: 'tag', data: tagData }] });
  check('e2e tag push', tagPush.report?.refs[0]?.ok === true);
  const lsTag = await client.lsRefs(VIEWER, 'smoke1', { peel: true, symrefs: true });
  const tagRef = lsTag.refs.find((r) => r.name === 'refs/tags/v1');
  check('e2e ls-refs peeled tag', tagRef?.oid === tagOid && tagRef?.peeled === fwd.commitOid, JSON.stringify(tagRef));
  const cloneTag = await client.clone(VIEWER, 'smoke1');
  check('e2e clone includes tag object', cloneTag.objects.has(tagOid));

  // ref-prefix filtering (server-side; HEAD must not leak).
  const prefixed = await client.lsRefs(VIEWER, 'smoke1', { prefixes: ['refs/heads/'] });
  check('e2e ls-refs-prefix heads only', prefixed.rawRefs.length > 0 && prefixed.rawRefs.every((r) => r.name.startsWith('refs/heads/')));
  const prefixedNone = await client.lsRefs(VIEWER, 'smoke1', { prefixes: ['refs/does-not-exist/'] });
  check('e2e ls-refs-prefix unmatched returns 0', prefixedNone.rawRefs.length === 0);

  // Unknown repo 404s; server stays up.
  const missingUp = await client.infoRefs(VIEWER, 'smoke1-missing', 'git-upload-pack');
  const missingRecv = await client.infoRefs(VIEWER, 'smoke1-missing', 'git-receive-pack');
  check('e2e unknown repo 404 both services', missingUp.status === 404 && missingRecv.status === 404);
  const stillUp = await client.infoRefs(VIEWER, 'smoke1', 'git-upload-pack');
  check('e2e server healthy after 404', stillUp.status === 200);

  // Malformed POST must not crash or corrupt state.
  const raw = await client.postRaw(VIEWER, 'smoke1', 'git-upload-pack', buf('zzzznot-a-pkt-line'));
  check('e2e malformed POST answered (any status)', raw.status === 400, `status=${raw.status}`);
  const afterRaw = await client.clone(VIEWER, 'smoke1');
  check('e2e clone healthy after malformed POST', afterRaw.objects.has(fwd.commitOid) && afterRaw.checksumOk);

  // Empty repo clones empty.
  await client.createRepo(VIEWER, 'smoke-empty');
  const emptyClone = await client.clone(VIEWER, 'smoke-empty');
  check('e2e empty repo clone', emptyClone.objects.size === 0 && emptyClone.packBytes === 0);
  const emptyLs = await client.lsRefs(VIEWER, 'smoke-empty', { peel: true, symrefs: true });
  check('e2e empty repo unborn HEAD', emptyLs.refs.some((r) => r.name === 'HEAD' && r.unborn === true && r.symrefTarget === 'refs/heads/main'));

  // v0 fallback client: advertisement v0 + v0 fetch + v0 clone.
  const v0client = new GitClient({ baseUrl, token: TOKEN, gitProtocol: 0 });
  const v0ad = await v0client.advertisement(VIEWER, 'smoke1', 'git-upload-pack');
  check('e2e v0 advertisement', v0ad.protocol === 0 && v0ad.capabilities.has('side-band-64k') && v0ad.capabilities.has('shallow') && v0ad.headSymref === 'refs/heads/main');
  const v0fetch = await v0client.fetch(VIEWER, 'smoke1', { wants: [fwd.commitOid] });
  check('e2e v0 fetch', v0fetch.protocol === 0 && v0fetch.objects.has(fwd.commitOid) && v0fetch.checksumOk);
  const v0clone = await v0client.clone(VIEWER, 'smoke1', { depth: 1 });
  check('e2e v0 depth-1 clone', v0clone.objects.has(fwd.commitOid) && !v0clone.objects.has(c3.commitOid) && v0clone.shallow.includes(fwd.commitOid));

  // 401 without a token (auth backstop in handleGit).
  const noAuth = await fetch(`${baseUrl}/${VIEWER}/smoke1.git/info/refs?service=git-upload-pack`);
  check('e2e 401 without token', noAuth.status === 401);
} catch (err) {
  failed++;
  console.log(`  FAIL e2e threw: ${err?.stack ?? err}`);
} finally {
  server.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
