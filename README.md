[![bounty](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/vickyair1/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard)
[![reward](https://make.fun/badge/github-core-clone-01/vickyair1/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

# github-core-clone-01 — a GitHub-compatible git forge

A standalone git forge in a single Node process, standard library only: no git
binary, no dependencies, no install step. Built for the
[github-core-clone-01](https://make.fun/bounty/github-core-clone-01) bounty on
make.fun.

## Surfaces

- **Git smart HTTP** — `/{owner}/{repo}.git`: upload-pack protocol v2
  (`ls-refs`, `fetch`, shallow) with a v0 fallback, receive-pack v0 with
  report-status. Packfiles are built and parsed in pure TypeScript
  (`node:zlib` + `node:crypto`); objects are real SHA-1 git objects.
- **REST v3** — `/api/v3`: repos, branches, commits, contents, labels, issues,
  comments, pull requests (squash merge with three-way conflict detection),
  pagination via `Link` headers.
- **GraphQL v4** — `/api/graphql`: a targeted executor for the documents `gh`
  and `github-mcp-server` send, plus the introspection subset.
- **MCP** — `/mcp`: JSON-RPC 2.0 Streamable HTTP, both the modern
  `server/discover` era and the legacy `initialize` revision walk.
- **Lifecycle** — binds an ephemeral port, registers with
  `$MAKEFUN_ENV_URL`, polls `/done`, exits 0. `/healthz` takes no auth;
  every API call requires `Bearer $MAKEFUN_SHOP_TOKEN`.

## Layout

```
main.ts            entrypoint: lifecycle + dev mode (PORT, default 3000)
src/store.ts       in-memory data model: repos, objects, refs, issues, PRs
src/scenario.ts    deterministic scenario port (viewer/stranger logins)
src/server.ts      node:http server, router, auth, body parsing, headers
src/git.ts         git objects, packs, protocol, smart-HTTP handlers
src/rest.ts        all /api/v3 handlers
src/graphql.ts     /api/graphql targeted executor
src/mcp.ts         /mcp JSON-RPC 2.0 handler
test/              smoke tests + local grading scripts
```

## Design notes

- **In-memory everything.** No disk I/O per request, no fsync. All state is
  fresh per process start.
- **Deterministic.** Ids and numbers come from counters; timestamps come from
  a logical clock (fixed epoch + sequence). No `Date.now()`, no randomness,
  no UUIDs in any observable behaviour — a replay reproduces the same state.
- **Fast paths.** The depth-1 clone pack and the ref advertisement are cached
  per tip / ref version; issue JSON is cached per issue (invalidated on
  write); the router is hand-rolled string-prefix matching; request ids are a
  counter, not UUIDs.

## Local grading

```sh
# Fast loop: the sealed suite against a dev server (conformance + perf).
bash test/local-grade.sh --perf --json --strict

# Full sealed trial: register, boot, phases, exports, scorer.
bash test/local-grade.sh --full
```

Local results (this VM, `sdk/run.ts --perf`): **120/120 checks**,
feature 600 + agent 200 + perf 191 = **score 991**, p50 212,658 µs.
Full sealed trial: 120/120, score 994, p50 197,972 µs.

## License

MIT.
