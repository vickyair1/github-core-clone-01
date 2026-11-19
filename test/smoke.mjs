// End-to-end smoke for the github-core-clone-01 forge.
//
//   node --experimental-strip-types test/smoke.mjs [--port N] [--token TOK] [--kit DIR]
//
// Starts the real entry (main.ts, dev mode) as a child process, then
// exercises it step by step and prints PASS/FAIL/SKIP per step:
//   0. scenario identities match the kit's own buildScenario()
//   1. GET /healthz without auth -> 200 {"ok":true} + request id
//   2. GET /api/v3/ without auth -> 401 JSON {message}
//   3. GET an unknown route with auth -> 404 JSON {message:"Not Found"}
//   4. POST /api/v3/user/repos -> 201 (creates smoke-repo)
//   5. PUT /contents/hello.txt -> 201, then GET it back, bytes equal
//   6. git clone (kit GitClient, depth 1, parsed) -> 3 objects, checksum ok
//   7. POST an issue -> 201, then GET it back, title equal
//
// Exit 0 when every non-skipped step passes, 1 otherwise. Steps that
// need a module the parallel builders have not landed yet (REST, git)
// fail honestly with the status seen — that is the signal, not noise.
//
// The kit path defaults to ../github-core-clone-01-kit next to the repo
// root; set --kit or KIT_DIR to override. Without the kit, steps 0 and
// 6 are SKIPped (the identities are still printed from the port alone).

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const KIT_DIR = process.env.KIT_DIR ?? path.resolve(REPO_ROOT, '..', 'github-core-clone-01-kit');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const PORT = Number(flag('--port', process.env.SMOKE_PORT ?? '18123'));
const TOKEN = flag('--token', process.env.SMOKE_TOKEN ?? 'smoke-token-1');
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
function step(name, status, detail = '') {
  results.push({ name, status, detail });
  console.log(`${status.padEnd(4)} ${name}${detail ? ` — ${detail}` : ''}`);
}
const pass = (name, detail) => step(name, 'PASS', detail);
const fail = (name, detail) => step(name, 'FAIL', detail);
const skip = (name, detail) => step(name, 'SKIP', detail);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealthz(deadlineMs) {
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (res.status === 200) return true;
    } catch {
      // Not up yet.
    }
    if (Date.now() - start > deadlineMs) return false;
    await sleep(200);
  }
}

async function call(method, p, { auth = true, body = undefined, raw = false } = {}) {
  const headers = {};
  if (auth) headers.authorization = `Bearer ${TOKEN}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers,
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, text, json };
}

async function main() {
  // -- 0. scenario identities vs the kit's own buildScenario() --------
  let viewer = null;
  try {
    const { getIdentities } = await import('../src/scenario.ts');
    const mine = getIdentities();
    try {
      const { buildScenario } = await import(path.join(KIT_DIR, 'program/env/src/wire.ts'));
      const kit = buildScenario();
      const pairs = [
        ['viewer', mine.viewer, kit.viewer.login],
        ['stranger', mine.stranger, kit.stranger.login],
        ['teammate', mine.teammate, kit.teammate.login],
        ['org', mine.org, kit.org],
      ];
      const bad = pairs.filter(([, a, b]) => a !== b);
      if (bad.length === 0) pass('0 identities == kit buildScenario()', `viewer=${mine.viewer} stranger=${mine.stranger} teammate=${mine.teammate} org=${mine.org}`);
      else fail('0 identities == kit buildScenario()', bad.map(([n, a, b]) => `${n}: ${a} != ${b}`).join(', '));
    } catch {
      skip('0 identities == kit buildScenario()', `kit not importable at ${KIT_DIR}; port alone says viewer=${mine.viewer} org=${mine.org}`);
    }
    viewer = mine.viewer;
  } catch (err) {
    fail('0 identities == kit buildScenario()', `scenario import failed: ${err.message}`);
    return 1;
  }

  // -- start the server -------------------------------------------------
  const env = { ...process.env, PORT: String(PORT), MAKEFUN_SHOP_TOKEN: TOKEN };
  delete env.MAKEFUN_ENV_URL; // force dev mode even if the shell has it set
  const child = spawn(process.execPath, ['--experimental-strip-types', 'main.ts'], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (d) => { serverLog += d.toString(); });
  child.stderr.on('data', (d) => { serverLog += d.toString(); });
  const stopServer = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await sleep(500);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  };

  try {
    if (!(await waitHealthz(10000))) {
      fail('server boot', `no /healthz within 10 s on port ${PORT}\n${serverLog.slice(-2000)}`);
      return 1;
    }

    // -- 1. /healthz, no auth -------------------------------------------
    {
      const r = await call('GET', '/healthz', { auth: false });
      const rid = r.headers.get('x-github-request-id');
      if (r.status === 200 && r.json?.ok === true && rid) pass('1 GET /healthz (no auth)', `request-id ${rid}`);
      else fail('1 GET /healthz (no auth)', `status ${r.status} body ${r.text.slice(0, 120)} request-id ${rid ?? 'missing'}`);
    }

    // -- 2. unauthenticated API call -> 401 ------------------------------
    {
      const r = await call('GET', '/api/v3/', { auth: false });
      if (r.status === 401 && typeof r.json?.message === 'string' && r.json.message.length > 0) pass('2 GET /api/v3/ (no auth) -> 401', r.json.message);
      else fail('2 GET /api/v3/ (no auth) -> 401', `status ${r.status} body ${r.text.slice(0, 120)}`);
    }

    // -- 3. unknown route -> 404 JSON ------------------------------------
    {
      const r = await call('GET', '/no-such-route-at-all');
      if (r.status === 404 && r.json?.message === 'Not Found') pass('3 GET /no-such-route-at-all -> 404', 'message "Not Found"');
      else fail('3 GET /no-such-route-at-all -> 404', `status ${r.status} body ${r.text.slice(0, 120)}`);
    }

    // -- 4. create a repo -------------------------------------------------
    const repo = 'smoke-repo';
    {
      const r = await call('POST', '/api/v3/user/repos', { body: { name: repo, private: false, description: 'smoke test repo' } });
      if (r.status === 201 && r.json?.name === repo) pass('4 POST /user/repos -> 201', `id ${r.json.id}`);
      else fail('4 POST /user/repos -> 201', `status ${r.status} body ${r.text.slice(0, 200)}`);
    }

    // -- 5. PUT a file, GET it back ---------------------------------------
    const content = 'hello smoke\n';
    const b64 = Buffer.from(content, 'utf8').toString('base64');
    {
      const put = await call('PUT', `/api/v3/repos/${viewer}/${repo}/contents/hello.txt`, {
        body: { message: 'smoke: add hello.txt', content: b64 },
      });
      if (put.status !== 201 && put.status !== 200) {
        fail('5 PUT /contents/hello.txt -> 201', `status ${put.status} body ${put.text.slice(0, 200)}`);
      } else {
        const got = await call('GET', `/api/v3/repos/${viewer}/${repo}/contents/hello.txt`);
        const decoded = got.json?.content ? Buffer.from(String(got.json.content).replace(/\s/g, ''), 'base64').toString('utf8') : null;
        if (got.status === 200 && decoded === content) pass('5 PUT + GET /contents/hello.txt', `round-trip ${content.length} bytes`);
        else fail('5 PUT + GET /contents/hello.txt', `GET status ${got.status} decoded ${JSON.stringify(decoded)}`);
      }
    }

    // -- 6. git clone via the kit's client --------------------------------
    let GitClient = null;
    try {
      ({ GitClient } = await import(path.join(KIT_DIR, 'program/env/src/git-client.ts')));
    } catch {
      skip('6 git clone depth 1 (kit client)', `kit git client not importable at ${KIT_DIR}`);
    }
    if (GitClient !== null) {
      try {
        const git = new GitClient({ baseUrl: BASE, token: TOKEN });
        const cloned = await git.clone(viewer, repo, { depth: 1, parse: true, singleBranch: true });
        if (cloned.packBytes > 0 && cloned.checksumOk && cloned.objects.size === 3) {
          pass('6 git clone depth 1 (kit client)', `protocol v${cloned.protocol}, ${cloned.objects.size} objects, pack ${cloned.packBytes} B`);
        } else {
          fail('6 git clone depth 1 (kit client)', `packBytes ${cloned.packBytes} checksumOk ${cloned.checksumOk} objects ${cloned.objects.size}`);
        }
      } catch (err) {
        fail('6 git clone depth 1 (kit client)', err.message.slice(0, 200));
      }
    }

    // -- 7. create an issue, GET it back ----------------------------------
    {
      const created = await call('POST', `/api/v3/repos/${viewer}/${repo}/issues`, {
        body: { title: 'Smoke issue', body: 'smoke body' },
      });
      const number = created.json?.number;
      if (created.status !== 201 || !Number.isInteger(number) || number <= 0) {
        fail('7 POST /issues -> 201', `status ${created.status} body ${created.text.slice(0, 200)}`);
      } else {
        const got = await call('GET', `/api/v3/repos/${viewer}/${repo}/issues/${number}`);
        if (got.status === 200 && got.json?.title === 'Smoke issue') pass('7 POST + GET /issues', `number ${number}`);
        else fail('7 POST + GET /issues', `GET status ${got.status} body ${got.text.slice(0, 200)}`);
      }
    }
  } finally {
    await stopServer();
  }

  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  const skipped = results.filter((r) => r.status === 'SKIP').length;
  console.log(`\nsmoke: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  return failed > 0 ? 1 : 0;
}

process.exitCode = await main();
