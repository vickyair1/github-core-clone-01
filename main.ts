// github-core-clone-01 entrypoint: build the forge, bind it, and live the trial.
//
// Two modes, chosen by MAKEFUN_ENV_URL:
//
//   Trial mode (the env var is set): bind an ephemeral port, POST it to
//   $MAKEFUN_ENV_URL/register, then poll GET $MAKEFUN_ENV_URL/done until
//   the env answers {"done": true}, then close and exit 0. The process
//   NEVER exits before done — an early exit fails every check after it.
//   Register and done polls retry forever with exponential backoff
//   (250 ms -> 2,000 ms cap); only a 400/405 from register is fatal,
//   because that means this program's own request is malformed.
//
//   Dev mode (the env var is unset): listen on PORT (default 3000), log
//   the URL, serve forever. This is what test/local-grade.sh and
//   test/smoke.mjs run against.
//
// Auth token: MAKEFUN_SHOP_TOKEN. Empty/unset means auth is disabled
// (dev convenience); the trial always sets it, and the suite sends no
// Authorization header at all when its own token is empty.
//
// The server binds listen(0) in trial mode — NEVER 8080, which is the
// env's port on the same loopback.

import type http from 'node:http';
import { Store } from './src/store.ts';
import { createContext, createServer } from './src/server.ts';
import { getIdentities } from './src/scenario.ts';

/** The env's origin ('' = dev mode). Trailing slashes stripped. */
const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
/** The bearer token API calls must carry ('' = no auth). */
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
/** Dev-mode listen port. */
const DEV_PORT = (() => {
  const parsed = Number(process.env.PORT);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : 3000;
})();

/** One register/done request may take this long before it is abandoned and retried. */
const REQUEST_TIMEOUT_MS = 30_000;
/** First backoff step between retries, and the longest step. */
const BACKOFF_FIRST_MS = 250;
const BACKOFF_MAX_MS = 2_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Exponential backoff after `failures` consecutive failures: 250, 500, 1000, 2000, 2000, ... */
function backoffMs(failures: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** Math.min(Math.max(0, failures), 3));
}

function log(line: string): void {
  process.stdout.write(`[forge] ${line}\n`);
}

function logError(line: string): void {
  process.stderr.write(`[forge] ${line}\n`);
}

/**
 * Tell the env which port this process bound. 200 is the normal answer;
 * 409 means a first register already won (not this process's to fix) and
 * is equally fine — either way the env knows where to dial. 400/405 are
 * contract errors in this program's own request and are fatal; anything
 * else (network error, another status, timeout) is retried, because the
 * env may still be starting.
 */
async function register(port: number): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register rejected with HTTP ${res.status}: ${await res.text()}`);
      }
      logError(`register answered HTTP ${res.status}; retrying`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register rejected with HTTP ')) throw err;
      logError(`register failed (${err instanceof Error ? err.message : String(err)}); retrying`);
    }
    await sleep(backoffMs(failures));
    failures += 1;
  }
}

/** Poll GET /done until the env answers {"done": true}. Never returns before that. */
async function waitForDone(): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
        failures = 0; // a clean {"done": false} resets the backoff
      }
    } catch (err) {
      logError(`done poll failed (${err instanceof Error ? err.message : String(err)}); retrying`);
    }
    await sleep(backoffMs(failures));
    failures += 1;
  }
}

/** Bind the server and resolve with the port the kernel picked. */
function listen(server: http.Server, port: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the server did not bind a TCP port'));
        return;
      }
      resolve(address.port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port);
  });
}

/** SIGTERM/SIGINT: stop accepting, drop connections, exit 0. */
function installSignalHandlers(server: http.Server): void {
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    server.close(() => process.exit(0));
    server.closeAllConnections();
    // Never hang on a lingering socket: force the exit shortly.
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

/**
 * A stray uncaught error must not kill the trial: request handling
 * already catches handler failures, so anything reaching here is
 * outside a request. Log it and keep serving — exiting would fail
 * every check the suite still has to run.
 */
process.on('uncaughtException', (err) => {
  logError(`uncaught exception (continuing): ${err.stack ?? err.message}`);
});
process.on('unhandledRejection', (reason) => {
  logError(`unhandled rejection (continuing): ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
});

async function run(): Promise<number> {
  const identities = getIdentities();
  const store = new Store(identities.viewer);
  const server = createServer(store, createContext(SHOP_TOKEN));
  installSignalHandlers(server);

  if (ENV_URL === '') {
    const port = await listen(server, DEV_PORT);
    log(`dev mode: listening on http://127.0.0.1:${port} (viewer ${identities.viewer})`);
    // Serve forever; the listening server keeps the process alive.
    await new Promise(() => undefined);
    return 0;
  }

  const port = await listen(server, 0);
  log(`listening on ephemeral port ${port}`);
  await register(port);
  log('registered; waiting for the env to finish');
  await waitForDone();
  log('env done; closing');
  server.close();
  return 0;
}

run().then(
  (code) => process.exit(code),
  (err: unknown) => {
    logError(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(1);
  },
);
