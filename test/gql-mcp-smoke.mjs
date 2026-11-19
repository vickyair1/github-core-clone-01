// Smoke test for the GraphQL + MCP surfaces (graphql.ts / mcp.ts).
//
// Spins a tiny node:http server routing /api/graphql and /mcp to the real
// handlers (no auth — server.ts owns that) and exercises every suite
// document and MCP flow end to end, including cross-surface store effects.
//
// Run (needs src/git.ts to exist — it is built by the GIT builder):
//   node --experimental-strip-types test/gql-mcp-smoke.mjs
// Exit code 0 = all checks passed.
//
// NOTE: until git.ts lands in repo/src, run this from the verify copy with a
// contract-faithful stub git.ts (see the coordinator's integration notes).

import http from 'node:http';
import { Store } from '../src/store.ts';
import { handleGraphql } from '../src/graphql.ts';
import { handleMcp } from '../src/mcp.ts';
import { writeObject, buildTree, buildCommit, resolveRef } from '../src/git.ts';

const VIEWER = 'testviewer';
const store = new Store(VIEWER);

let reqCounter = 0;
const ctx = { requestId: () => `req-${++reqCounter}` };

const server = http.createServer((req, res) => {
  if (req.url === '/api/graphql') void handleGraphql(req, res, store, ctx);
  else if (req.url === '/mcp') void handleMcp(req, res, store, ctx);
  else if (req.url === '/api/graphql-preparsed' || req.url === '/mcp-preparsed') {
    // Simulate a server.ts that pre-parses JSON and attaches req.body.
    void (async () => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      try {
        req.body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        req.bodyParseError = true;
      }
      if (req.url === '/api/graphql-preparsed') await handleGraphql(req, res, store, ctx);
      else await handleMcp(req, res, store, ctx);
    })();
  } else if (req.url === '/mcp-rawbody') {
    // Simulate a server.ts that attaches the raw body text.
    void (async () => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      req.rawBody = Buffer.concat(chunks).toString('utf8');
      await handleMcp(req, res, store, ctx);
    })();
  } else if (req.url === '/mcp-parsefail') {
    // Simulate a server.ts that reports its own JSON parse failure.
    req.bodyParseError = true;
    void handleMcp(req, res, store, ctx);
  } else {
    res.statusCode = 404;
    res.end(JSON.stringify({ message: 'Not Found' }));
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;

// --- tiny assert framework ---------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
function eq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// --- HTTP helpers ------------------------------------------------------------

async function gql(query, variables = {}) {
  const r = await fetch(`${BASE}/api/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  return { status: r.status, body: await r.json() };
}

async function gqlRaw(bodyText) {
  const r = await fetch(`${BASE}/api/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: bodyText,
  });
  return { status: r.status, body: await r.json() };
}

let rpcId = 0;
async function mcp(method, params = {}, id = ++rpcId) {
  const r = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  return { status: r.status, body: await r.json() };
}

async function mcpRaw(bodyText) {
  const r = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: bodyText,
  });
  const text = await r.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch { /* leave null */ }
  return { status: r.status, body, text };
}

// --- the 18 documents, verbatim from the spec --------------------------------

const VIEWER_LOGIN = `query ViewerLogin {
  viewer {
    login
  }
}`;

const REPOSITORY_FIELDS = `query RepositoryFields($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    id
    databaseId
    name
    owner {
      login
    }
    defaultBranchRef {
      name
    }
    viewerPermission
    hasIssuesEnabled
  }
}`;

const ISSUE_FIELDS = `query Issue_fields {
  Issue: __type(name: "Issue") {
    fields(includeDeprecated: true) {
      name
    }
  }
}`;

const TYPE_FIELDS = `query PullRequestAndRepositoryFields {
  PullRequest: __type(name: "PullRequest") {
    fields(includeDeprecated: true) {
      name
    }
  }
  Repository: __type(name: "Repository") {
    fields(includeDeprecated: true) {
      name
    }
  }
}`;

const SEARCH_TYPE_ENUM_VALUES = `query SearchType_enumValues {
  SearchType: __type(name: "SearchType") {
    enumValues(includeDeprecated: true) {
      name
    }
  }
}`;

const OPEN_ISSUES = `query OpenIssues($owner: String!, $name: String!, $first: Int!) {
  repository(owner: $owner, name: $name) {
    issues(first: $first, states: [OPEN], orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes {
        number
        title
        state
        id
      }
    }
  }
}`;

const ISSUE_BY_NUMBER = `query IssueByNumber($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      number
      title
      state
      id
      body
    }
  }
}`;

const CREATE_ISSUE = `mutation IssueCreate($input: CreateIssueInput!) {
  createIssue(input: $input) {
    issue {
      number
      id
    }
  }
}`;

const CLOSE_ISSUE = `mutation IssueClose($input: CloseIssueInput!) {
  closeIssue(input: $input) {
    issue {
      number
      id
      state
    }
  }
}`;

const PULL_REQUESTS = `query PullRequests($owner: String!, $name: String!, $first: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: $first) {
      nodes {
        number
        headRefName
        baseRefName
        mergeable
        state
      }
    }
  }
}`;

const PULL_REQUEST_FILES = `query PullRequestFiles($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      files(first: 10) {
        nodes {
          path
        }
      }
    }
  }
}`;

const PULL_REQUEST_ID = `query PullRequestId($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id
      number
    }
  }
}`;

const CREATE_PULL_REQUEST = `mutation PullRequestCreate($input: CreatePullRequestInput!) {
  createPullRequest(input: $input) {
    pullRequest {
      number
      id
      state
      headRefName
      baseRefName
    }
  }
}`;

const MERGE_PULL_REQUEST = `mutation MergePullRequest($input: MergePullRequestInput!) {
  mergePullRequest(input: $input) {
    pullRequest {
      number
      merged
      state
    }
  }
}`;

const ADD_COMMENT = `mutation AddComment($input: AddCommentInput!) {
  addComment(input: $input) {
    commentEdge {
      node {
        id
        body
      }
    }
  }
}`;

const INVALID_FIELD = `query ViewerInvalidField {
  viewer {
    login
    noSuchFieldOnViewer
  }
}`;

const NODE_REPOSITORY = `query NodeRepository($id: ID!) {
  node(id: $id) {
    id
    ... on Repository {
      name
      nameWithOwner
    }
  }
}`;

const ISSUES_PAGE = `query IssuesPage($owner: String!, $name: String!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(first: $first, after: $after) {
      nodes {
        number
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}`;

// --- seed: repo + git history (base commit + two head branches) --------------

const repo = store.createRepo('smoke-repo', false, 'smoke test repo');
const blobA = writeObject(repo, 'blob', Buffer.from('hello\n'));
const treeA = writeObject(repo, 'tree', buildTree([{ mode: '100644', name: 'a.txt', sha: blobA }]));
const ident = 'A U Thor <a@example.com> 1735689601 +0000';
const commitA = writeObject(repo, 'commit', buildCommit(treeA, [], ident, ident, 'base commit\n'));
repo.refs.set('refs/heads/main', commitA);

const blobB = writeObject(repo, 'blob', Buffer.from('world\n'));
const treeB = writeObject(
  repo,
  'tree',
  buildTree([
    { mode: '100644', name: 'a.txt', sha: blobA },
    { mode: '100644', name: 'b.txt', sha: blobB },
  ]),
);
const commitB = writeObject(repo, 'commit', buildCommit(treeB, [commitA], ident, ident, 'add b.txt\n'));
repo.refs.set('refs/heads/feature', commitB);

const blobC = writeObject(repo, 'blob', Buffer.from('third\n'));
const treeC = writeObject(
  repo,
  'tree',
  buildTree([
    { mode: '100644', name: 'a.txt', sha: blobA },
    { mode: '100644', name: 'c.txt', sha: blobC },
  ]),
);
const commitC = writeObject(repo, 'commit', buildCommit(treeC, [commitA], ident, ident, 'add c.txt\n'));
repo.refs.set('refs/heads/feature2', commitC);

// Pagination repo: exactly 7 issues, inserted directly into the store.
const pagesRepo = store.createRepo('smoke-pages', false, 'pagination repo');
for (let i = 1; i <= 7; i++) {
  const now = store.nowIso();
  const n = store.allocNumber(pagesRepo);
  pagesRepo.issues.set(n, {
    number: n,
    title: `page ${i}`,
    body: 'seeded body',
    state: 'open',
    labels: [],
    comments: [],
    createdSeq: store.nextSeq(),
    createdAt: now,
    updatedAt: now,
  });
}

console.log('== GraphQL ==');

// 1. viewer-login
{
  const r = await gql(VIEWER_LOGIN);
  check('1 viewer-login', r.status === 200 && r.body.data?.viewer?.login === VIEWER, JSON.stringify(r.body));
}

// 2. repository-fields
let repoGid;
{
  const r = await gql(REPOSITORY_FIELDS, { owner: VIEWER, name: 'smoke-repo' });
  const d = r.body.data?.repository;
  repoGid = d?.id;
  check(
    '2 repository-fields',
    r.status === 200 &&
      typeof d?.id === 'string' && d.id !== '' &&
      d.databaseId === repo.id &&
      d.name === 'smoke-repo' &&
      d.owner?.login === VIEWER &&
      d.defaultBranchRef?.name === 'main' &&
      ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'].includes(d.viewerPermission) &&
      d.hasIssuesEnabled === true,
    JSON.stringify(r.body),
  );
}

// 3. introspection-issue
{
  const r = await gql(ISSUE_FIELDS);
  const names = (r.body.data?.Issue?.fields ?? []).map((f) => f.name);
  check(
    '3 introspection-issue',
    r.status === 200 && ['id', 'number', 'title', 'state', 'body'].every((f) => names.includes(f)),
    JSON.stringify(names),
  );
}

// 4. introspection-types + search enum
{
  const r1 = await gql(TYPE_FIELDS);
  const prNames = (r1.body.data?.PullRequest?.fields ?? []).map((f) => f.name);
  const repoNames = (r1.body.data?.Repository?.fields ?? []).map((f) => f.name);
  const r2 = await gql(SEARCH_TYPE_ENUM_VALUES);
  const enumNames = (r2.body.data?.SearchType?.enumValues ?? []).map((f) => f.name);
  check(
    '4 introspection-types',
    ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'].every((f) => prNames.includes(f)) &&
      ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'].every((f) => repoNames.includes(f)) &&
      enumNames.includes('ISSUE'),
    JSON.stringify({ prNames, repoNames, enumNames }),
  );
}

// 7+8 (create issues first, so 5/6 have fixtures): 3 open + 1 closed
const created = [];
for (let i = 1; i <= 3; i++) {
  const r = await gql(CREATE_ISSUE, { input: { repositoryId: repoGid, title: `smoke open ${i}`, body: 'seeded body' } });
  created.push(r.body.data?.createIssue?.issue);
}
check(
  '7 create-issue',
  created.every((c) => c && Number.isInteger(c.number) && c.number > 0 && typeof c.id === 'string' && c.id !== '') &&
    repo.issues.get(created[0].number)?.title === 'smoke open 1' &&
    repo.issues.get(created[0].number)?.state === 'open',
  JSON.stringify(created),
);
let closedNumber;
let closedGid;
{
  const r = await gql(CREATE_ISSUE, { input: { repositoryId: repoGid, title: 'smoke closed', body: 'seeded body' } });
  const issue = r.body.data?.createIssue?.issue;
  closedNumber = issue.number;
  const c = await gql(CLOSE_ISSUE, { input: { issueId: issue.id } });
  closedGid = issue.id;
  check(
    '8 close-issue',
    c.body.data?.closeIssue?.issue?.number === closedNumber &&
      c.body.data?.closeIssue?.issue?.state === 'CLOSED' &&
      repo.issues.get(closedNumber)?.state === 'closed',
    JSON.stringify(c.body),
  );
}

// 5. issues-open-order
{
  const r = await gql(OPEN_ISSUES, { owner: VIEWER, name: 'smoke-repo', first: 10 });
  const nodes = r.body.data?.repository?.issues?.nodes ?? [];
  const nums = nodes.map((n) => n.number);
  const nonIncreasing = nums.every((n, i) => i === 0 || n <= nums[i - 1]);
  check(
    '5 issues-open-order',
    nodes.length === 3 &&
      nodes.every((n) => n.state === 'OPEN' && typeof n.title === 'string' && typeof n.id === 'string' && n.id !== '') &&
      nonIncreasing &&
      !nums.includes(closedNumber) &&
      created.every((c) => nums.includes(c.number)),
    JSON.stringify(nodes),
  );
}

// 6. issue-by-number
{
  const r = await gql(ISSUE_BY_NUMBER, { owner: VIEWER, name: 'smoke-repo', number: created[0].number });
  const d = r.body.data?.repository?.issue;
  check(
    '6 issue-by-number',
    d?.number === created[0].number && d?.state === 'OPEN' && d?.title === 'smoke open 1' &&
      d?.body === 'seeded body' && typeof d?.id === 'string' && d.id !== '',
    JSON.stringify(r.body),
  );
}

// 11. create-pull-request (GraphQL)
let gqlPrNumber;
let gqlPrGid;
{
  const r = await gql(CREATE_PULL_REQUEST, {
    input: { repositoryId: repoGid, baseRefName: 'main', headRefName: 'feature', title: 'smoke pr over graphql' },
  });
  const d = r.body.data?.createPullRequest?.pullRequest;
  gqlPrNumber = d?.number;
  gqlPrGid = d?.id;
  const stored = repo.pulls.get(gqlPrNumber);
  check(
    '11 create-pull-request',
    Number.isInteger(gqlPrNumber) && gqlPrNumber > 0 && typeof gqlPrGid === 'string' && gqlPrGid !== '' &&
      d?.state === 'OPEN' && d?.headRefName === 'feature' && d?.baseRefName === 'main' &&
      stored?.headRef === 'feature' && stored?.baseRef === 'main',
    JSON.stringify(r.body),
  );
}

// 9. pull-requests-list
{
  const r = await gql(PULL_REQUESTS, { owner: VIEWER, name: 'smoke-repo', first: 5 });
  const nodes = r.body.data?.repository?.pullRequests?.nodes ?? [];
  const hit = nodes.find((n) => n.number === gqlPrNumber);
  check(
    '9 pull-requests-list',
    nodes.length <= 5 && hit?.headRefName === 'feature' && hit?.baseRefName === 'main' &&
      hit?.state === 'OPEN' && ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'].includes(hit?.mergeable),
    JSON.stringify(nodes),
  );
}

// 10. pull-request-files
{
  const r = await gql(PULL_REQUEST_FILES, { owner: VIEWER, name: 'smoke-repo', number: gqlPrNumber });
  const paths = (r.body.data?.repository?.pullRequest?.files?.nodes ?? []).map((n) => n.path);
  check(
    '10 pull-request-files',
    r.body.data?.repository?.pullRequest?.number === gqlPrNumber && paths.includes('b.txt'),
    JSON.stringify(paths),
  );
}

// 12. merge-pull-request (GraphQL) — via PULL_REQUEST_ID first, like the harness
{
  const idRes = await gql(PULL_REQUEST_ID, { owner: VIEWER, name: 'smoke-repo', number: gqlPrNumber });
  const prId = idRes.body.data?.repository?.pullRequest?.id;
  const mainBefore = resolveRef(repo, 'main');
  const r = await gql(MERGE_PULL_REQUEST, { input: { pullRequestId: prId, mergeMethod: 'SQUASH' } });
  const d = r.body.data?.mergePullRequest?.pullRequest;
  const stored = repo.pulls.get(gqlPrNumber);
  check(
    '12 merge-pull-request',
    d?.merged === true && d?.number === gqlPrNumber &&
      stored?.merged === true && stored?.state === 'closed' &&
      resolveRef(repo, 'main') !== mainBefore,
    JSON.stringify(r.body),
  );
}

// 13. add-comment
{
  const r = await gql(ADD_COMMENT, { input: { subjectId: created[0].id, body: 'smoke comment body' } });
  const node = r.body.data?.addComment?.commentEdge?.node;
  const comments = repo.issues.get(created[0].number)?.comments ?? [];
  check(
    '13 add-comment',
    node?.body === 'smoke comment body' && typeof node?.id === 'string' && node.id !== '' &&
      comments.some((c) => c.body === 'smoke comment body'),
    JSON.stringify(r.body),
  );
}

// 14. invalid-field
{
  const r = await gql(INVALID_FIELD);
  check(
    '14 invalid-field',
    r.status === 200 && Array.isArray(r.body.errors) && r.body.errors.length > 0 &&
      r.body.errors.some((e) => typeof e.message === 'string' && e.message.includes('noSuchFieldOnViewer')),
    JSON.stringify(r.body),
  );
}

// 16. node-repository (inline fragment)
{
  const r = await gql(NODE_REPOSITORY, { id: repoGid });
  const d = r.body.data?.node;
  check(
    '16 node-repository',
    d?.id === repoGid && d?.name === 'smoke-repo' && d?.nameWithOwner === `${VIEWER}/smoke-repo`,
    JSON.stringify(r.body),
  );
}

// 17. unknown-repository
{
  const r = await gql(REPOSITORY_FIELDS, { owner: VIEWER, name: 'smoke-repo-missing' });
  check(
    '17 unknown-repository',
    r.status === 200 && (!r.body.errors || r.body.errors.length === 0) &&
      r.body.data && typeof r.body.data === 'object' && r.body.data.repository === null,
    JSON.stringify(r.body),
  );
}

// 18. batched-operations
{
  const r = await gqlRaw(JSON.stringify([
    { query: VIEWER_LOGIN, variables: {} },
    { query: ISSUE_FIELDS, variables: {} },
  ]));
  check(
    '18 batched-operations',
    r.status === 200 && Array.isArray(r.body) && r.body.length === 2 &&
      r.body[0].data?.viewer?.login === VIEWER &&
      Array.isArray(r.body[1].data?.Issue?.fields) && r.body[1].data.Issue.fields.length > 0,
    JSON.stringify(r.body),
  );
}

// 19. global-id-stability
{
  const r1 = await gql(REPOSITORY_FIELDS, { owner: VIEWER, name: 'smoke-repo' });
  const r2 = await gql(REPOSITORY_FIELDS, { owner: VIEWER, name: 'smoke-repo' });
  const i1 = await gql(ISSUE_BY_NUMBER, { owner: VIEWER, name: 'smoke-repo', number: created[0].number });
  const i2 = await gql(ISSUE_BY_NUMBER, { owner: VIEWER, name: 'smoke-repo', number: created[0].number });
  const repoId1 = r1.body.data?.repository?.id;
  const repoId2 = r2.body.data?.repository?.id;
  const dbId = r1.body.data?.repository?.databaseId;
  const issueId1 = i1.body.data?.repository?.issue?.id;
  const issueId2 = i2.body.data?.repository?.issue?.id;
  check(
    '19 global-id-stability',
    typeof repoId1 === 'string' && repoId1 !== '' && repoId1 === repoId2 && repoId1 !== String(dbId) &&
      typeof issueId1 === 'string' && issueId1 !== '' && issueId1 === issueId2 && issueId1 !== String(created[0].number),
    JSON.stringify({ repoId1, repoId2, dbId, issueId1, issueId2 }),
  );
}

// 20. issues-pagination (7 issues, 5 + 2)
{
  const p1 = await gql(ISSUES_PAGE, { owner: VIEWER, name: 'smoke-pages', first: 5, after: null });
  const n1 = (p1.body.data?.repository?.issues?.nodes ?? []).map((n) => n.number);
  const pi1 = p1.body.data?.repository?.issues?.pageInfo;
  const p2 = await gql(ISSUES_PAGE, { owner: VIEWER, name: 'smoke-pages', first: 5, after: pi1?.endCursor });
  const n2 = (p2.body.data?.repository?.issues?.nodes ?? []).map((n) => n.number);
  const pi2 = p2.body.data?.repository?.issues?.pageInfo;
  const all = [...n1, ...n2];
  check(
    '20 issues-pagination',
    n1.length === 5 && pi1?.hasNextPage === true && typeof pi1?.endCursor === 'string' && pi1.endCursor !== '' &&
      n2.length === 2 && pi2?.hasNextPage === false &&
      new Set(all).size === 7 && all.every((n) => n >= 1 && n <= 7),
    JSON.stringify({ n1, pi1, n2, pi2 }),
  );
}

console.log('== MCP ==');

// 1+2. modern discover
{
  const r = await mcp('server/discover', {}, 'discover-1');
  const res = r.body.result;
  check(
    'MCP discover (modern)',
    r.status === 200 && r.body.id === 'discover-1' &&
      Array.isArray(res?.supportedVersions) && res.supportedVersions.includes('2026-07-28') &&
      typeof res?.serverInfo?.name === 'string' && res.serverInfo.name.trim() !== '' &&
      typeof res?.serverInfo?.version === 'string' && res.serverInfo.version.trim() !== '' &&
      typeof res?.capabilities?.tools === 'object' && res.capabilities.tools !== null,
    JSON.stringify(r.body),
  );
}

// Legacy initialize (first offered revision answered with a result)
{
  const r = await mcp('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '1.0.0' },
  }, 'initialize-1');
  const res = r.body.result;
  check(
    'MCP initialize (legacy)',
    r.status === 200 && r.body.id === 'initialize-1' &&
      res?.protocolVersion === '2025-11-25' &&
      typeof res?.serverInfo?.name === 'string' && res.serverInfo.name !== '' &&
      typeof res?.capabilities?.tools === 'object',
    JSON.stringify(r.body),
  );
}

// notifications/initialized: no id, 2xx, no JSON-RPC body required
{
  const r = await mcpRaw(JSON.stringify({
    jsonrpc: '2.0', method: 'notifications/initialized', params: {},
  }));
  check('MCP notification', r.status >= 200 && r.status < 300, `status ${r.status}`);
}

// 3+4+13. tools/list: 6 canonical tools, schemas, byte-identical twice
let toolNames = [];
{
  const a = await mcp('tools/list', {});
  const b = await mcp('tools/list', {});
  const toolsA = a.body.result?.tools ?? [];
  const toolsB = b.body.result?.tools ?? [];
  toolNames = toolsA.map((t) => t.name);
  const wanted = ['create_repo', 'get_repo', 'create_issue', 'list_issues', 'create_pull_request', 'merge_pull_request'];
  check(
    'MCP tools-list (6 canonical)',
    toolsA.length >= 6 && wanted.every((w) => toolNames.includes(w)),
    JSON.stringify(toolNames),
  );
  check(
    'MCP tool-schemas',
    toolsA.length > 0 && toolsA.every((t) => typeof t.description === 'string' && t.description.trim() !== '' && t.inputSchema?.type === 'object'),
    JSON.stringify(toolsA.map((t) => t.name)),
  );
  check(
    'MCP tools-list-idempotent',
    toolsA.length === toolsB.length && JSON.stringify(toolsA) === JSON.stringify(toolsB),
    'second list differed',
  );
}

// 14a. create_repo over MCP, then visible in the store
{
  const r = await mcp('tools/call', {
    name: 'create_repo',
    arguments: { name: 'mcp-repo', description: 'created over mcp', private: true },
  });
  const sc = r.body.result?.structuredContent;
  const createdRepo = store.getRepo(VIEWER, 'mcp-repo');
  check(
    'MCP create-repo',
    !r.body.error && r.body.result?.isError !== true &&
      sc?.full_name === `${VIEWER}/mcp-repo` && sc?.name === 'mcp-repo' &&
      createdRepo !== null && createdRepo.private === true,
    JSON.stringify(r.body),
  );
}

// 5+14b. create_issue over MCP, visible in the store
let mcpIssueNumber;
{
  const r = await mcp('tools/call', {
    name: 'create_issue',
    arguments: { owner: VIEWER, repo: 'mcp-repo', title: 'mcp issue title', body: 'mcp issue body' },
  });
  const sc = r.body.result?.structuredContent;
  mcpIssueNumber = sc?.number;
  const stored = typeof mcpIssueNumber === 'number' ? store.getRepo(VIEWER, 'mcp-repo')?.issues.get(mcpIssueNumber) : null;
  check(
    'MCP create-issue',
    !r.body.error && r.body.result?.isError !== true &&
      Number.isInteger(mcpIssueNumber) && stored?.title === 'mcp issue title' && stored?.state === 'open',
    JSON.stringify(r.body),
  );
}

// 6. list_issues: result text contains the title
{
  const r = await mcp('tools/call', {
    name: 'list_issues',
    arguments: { owner: VIEWER, repo: 'mcp-repo', state: 'open' },
  });
  const text = (r.body.result?.content ?? []).map((c) => c.text ?? '').join('\n');
  check(
    'MCP list-issues',
    !r.body.error && r.body.result?.isError !== true &&
      text.includes('mcp issue title') && new RegExp(`"number"\\s*:\\s*${mcpIssueNumber}(?!\\d)`).test(text),
    text.slice(0, 300),
  );
}

// 7. create_pull_request over MCP (head feature2 on smoke-repo)
let mcpPrNumber;
{
  const r = await mcp('tools/call', {
    name: 'create_pull_request',
    arguments: { owner: VIEWER, repo: 'smoke-repo', title: 'mcp pr title', body: 'mcp pr body', head: 'feature2', base: 'main' },
  });
  const sc = r.body.result?.structuredContent;
  mcpPrNumber = sc?.number;
  const stored = typeof mcpPrNumber === 'number' ? repo.pulls.get(mcpPrNumber) : null;
  check(
    'MCP create-pull-request',
    !r.body.error && r.body.result?.isError !== true &&
      Number.isInteger(mcpPrNumber) && stored?.headRef === 'feature2' && stored?.baseRef === 'main',
    JSON.stringify(r.body),
  );
}

// 8. merge_pull_request over MCP
{
  const r = await mcp('tools/call', {
    name: 'merge_pull_request',
    arguments: { owner: VIEWER, repo: 'smoke-repo', pull_number: mcpPrNumber },
  });
  const stored = repo.pulls.get(mcpPrNumber);
  check(
    'MCP merge-pull-request',
    !r.body.error && r.body.result?.isError !== true && stored?.merged === true,
    JSON.stringify(r.body),
  );
}

// 9. unknown-tool
{
  const r = await mcp('tools/call', { name: 'mcp_no_such_tool_abcdef01', arguments: {} });
  check(
    'MCP unknown-tool',
    r.status !== 500 && r.body.error && (r.body.error.code === -32602 || r.body.error.code === -32601),
    JSON.stringify(r.body),
  );
}

// 10. parse-error: truncated JSON -> HTTP 400 + -32700
{
  const r = await mcpRaw('{"jsonrpc": "2.0", "id": 424242, "method": "tools/list"');
  check(
    'MCP parse-error',
    r.status === 400 && r.body && 'id' in r.body && r.body.error?.code === -32700,
    `status ${r.status} body ${r.text.slice(0, 200)}`,
  );
}

// 11. missing-arguments: create_issue with {} -> -32602 or isError
{
  const r = await mcp('tools/call', { name: 'create_issue', arguments: {} });
  check(
    'MCP missing-arguments',
    (r.body.error && r.body.error.code === -32602) || r.body.result?.isError === true,
    JSON.stringify(r.body),
  );
}

// 12. concurrent-calls: ids echo exactly, no crossed responses
{
  const [l, rgt] = await Promise.all([
    mcp('tools/call', { name: 'get_repo', arguments: { owner: VIEWER, repo: 'smoke-repo' } }, 'concurrent-left-abcdef01'),
    mcp('tools/call', { name: 'get_repo', arguments: { owner: VIEWER, repo: 'mcp-repo' } }, 'concurrent-right-abcdef01'),
  ]);
  const textL = (l.body.result?.content ?? []).map((c) => c.text ?? '').join('\n');
  const textR = (rgt.body.result?.content ?? []).map((c) => c.text ?? '').join('\n');
  check(
    'MCP concurrent-calls',
    l.body.id === 'concurrent-left-abcdef01' && rgt.body.id === 'concurrent-right-abcdef01' &&
      !l.body.error && !rgt.body.error &&
      textL.includes('smoke-repo') && textR.includes('mcp-repo'),
    JSON.stringify({ l: l.body.id, r: rgt.body.id }),
  );
}

// Alias + prefix tool-name matching (defensive)
{
  const r = await mcp('tools/call', {
    name: 'github__create_issue',
    arguments: { owner: VIEWER, repo: 'mcp-repo', title: 'prefixed alias issue', body: '' },
  });
  check(
    'MCP tool-name prefix match',
    !r.body.error && r.body.result?.isError !== true && Number.isInteger(r.body.result?.structuredContent?.number),
    JSON.stringify(r.body),
  );
}

console.log('== body-channel fallbacks (server.ts handoff) ==');

// GraphQL with a pre-parsed req.body (server.ts consumed the stream).
{
  const r = await fetch(`${BASE}/api/graphql-preparsed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: VIEWER_LOGIN, variables: {} }),
  });
  const body = await r.json();
  check('GQL pre-parsed req.body', r.status === 200 && body.data?.viewer?.login === VIEWER, JSON.stringify(body));
}

// MCP with a pre-parsed req.body.
{
  const r = await fetch(`${BASE}/mcp-preparsed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'pp-1', method: 'tools/list', params: {} }),
  });
  const body = await r.json();
  check('MCP pre-parsed req.body', r.status === 200 && body.id === 'pp-1' && Array.isArray(body.result?.tools) && body.result.tools.length === 6, JSON.stringify(body));
}

// MCP with a rawBody string attached.
{
  const r = await fetch(`${BASE}/mcp-rawbody`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'rb-1', method: 'server/discover', params: {} }),
  });
  const body = await r.json();
  check('MCP rawBody channel', r.status === 200 && body.id === 'rb-1' && body.result?.supportedVersions?.includes('2026-07-28'), JSON.stringify(body));
}

// MCP when server.ts flags its own parse failure: still HTTP 400 + -32700.
{
  const r = await fetch(`${BASE}/mcp-parsefail`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"jsonrpc": "2.0", "id": 1, "method": "tools/list"',
  });
  const body = await r.json();
  check('MCP bodyParseError flag', r.status === 400 && 'id' in body && body.error?.code === -32700, JSON.stringify(body));
}

// GraphQL malformed JSON over the stream: 400 {message}.
{
  const r = await gqlRaw('{"query": "query { viewer { login } }"');
  check('GQL malformed JSON', r.status === 400 && typeof r.body.message === 'string' && r.body.message !== '', JSON.stringify(r.body));
}

console.log(`\n${passed} passed, ${failed} failed${failures.length ? ` — failures: ${failures.join(', ')}` : ''}`);
server.close();
process.exit(failed === 0 ? 0 : 1);
