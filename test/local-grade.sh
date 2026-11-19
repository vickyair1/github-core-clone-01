#!/usr/bin/env bash
# Local grading for the github-core-clone-01 forge. Two runners:
#
#   (A) sdk/run.ts (default) — the fast loop. Starts the dev server on a
#       fixed port, runs the real 120 checks against it, optionally with
#       the four benchmark workloads (--perf). No lifecycle: no register,
#       no boot budget, no exports.
#   (B) --full — the full sealed trial. Starts program/env/server.mjs,
#       waits for $STATE/ready, starts the entry with the real lifecycle
#       (listen(0) -> register -> poll /done -> exit 0), SIGTERMs the env
#       once the entry exits, then reads $STATE/export/state.json +
#       perf.json and scores them with program/scorer/score.mjs. This is
#       the pre-submit verification: it exercises register, the 20 s boot
#       budget, /healthz x2, the phase budgets, the exports, and the
#       scorer — everything (A) skips.
#
# NOTE on exit status: sdk/run.ts exits 0 whenever /healthz answers —
# failing checks NEVER change its exit status. This script therefore
# prints the pass/fail counts itself, and --strict exits 1 unless all
# 120 checks pass.
#
# Usage:
#   test/local-grade.sh [--perf] [--json] [--strict] [--port N]
#                       [--token TOK] [--timeout-ms N]
#   test/local-grade.sh --full [--token TOK] [--env-port N]
#                       [--state DIR] [--wall SECONDS]
#
# Env overrides: KIT_DIR (default: ../github-core-clone-01-kit next to
# the repo), TOKEN (default test-token-1), GRADE_JSON (where --json
# writes; default /tmp/gh-grade.json).
set -u

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KIT_DIR="${KIT_DIR:-$(cd "$REPO_ROOT/.." && pwd)/github-core-clone-01-kit}"
TOKEN="${TOKEN:-test-token-1}"
PORT="${PORT:-18099}"
ENV_PORT="${ENV_PORT:-18080}"
STATE="${STATE:-/tmp/gh-trial-state}"
SCORES="${SCORES:-/tmp/gh-scores}"
GRADE_JSON="${GRADE_JSON:-/tmp/gh-grade.json}"
WALL="${WALL:-}"
TIMEOUT_MS="${TIMEOUT_MS:-}"

MODE="sdk"
PERF=0
JSON=0
STRICT=0

usage() {
  cat <<'EOF'
usage: test/local-grade.sh [--perf] [--json] [--strict] [--port N] [--token TOK] [--timeout-ms N]
       test/local-grade.sh --full [--token TOK] [--env-port N] [--state DIR] [--wall SECONDS]

  (A) sdk/run.ts fast loop (default):
    --perf          also run the four benchmark workloads
    --json          print the run as one JSON object (saved to $GRADE_JSON)
    --strict        exit 1 unless all 120 checks pass (implies --json)
    --port N        dev server port (default 18099)
    --timeout-ms N  longest one check may take (default 15000, clamped 5000..15000)
  (B) full sealed trial:
    --full          run the whole trial via program/env/server.mjs + scorer
    --env-port N    env listen port (default 18080)
    --state DIR     env state dir, wiped first (default /tmp/gh-trial-state)
    --wall SECONDS  MAKEFUN_TRIAL_WALL_BUDGET_SEC (default: the env's 900)
  both:
    --token TOK     bearer token (default test-token-1)
    --help          this text
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --perf) PERF=1 ;;
    --json) JSON=1 ;;
    --strict) STRICT=1; JSON=1 ;;
    --full) MODE="full" ;;
    --port) PORT="$2"; shift ;;
    --token) TOKEN="$2"; shift ;;
    --timeout-ms) TIMEOUT_MS="$2"; shift ;;
    --env-port) ENV_PORT="$2"; shift ;;
    --state) STATE="$2"; shift ;;
    --wall) WALL="$2"; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

[ -d "$KIT_DIR/sdk" ] || { echo "kit not found at $KIT_DIR (set KIT_DIR)" >&2; exit 2; }
[ -n "$TOKEN" ] || { echo "token must not be empty" >&2; exit 2; }
command -v node >/dev/null || { echo "node not found in PATH" >&2; exit 2; }
command -v curl >/dev/null || { echo "curl not found in PATH" >&2; exit 2; }

# Print a compact summary of a --json grade file, and exit 1 unless
# every check passed (used by --strict).
summarize_json() {
  node -e '
const fs = require("fs");
const g = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const c = g.counts, cols = g.columns;
console.log(`checks: ${c.passed}/${c.manifest_total} passed (${c.registered} registered)`);
for (const [group, v] of Object.entries(c.by_group)) console.log(`  ${group}: ${v.passed}/${v.total}`);
const failed = g.checks.filter((r) => !r.ok);
if (failed.length > 0) {
  console.log("failed checks:");
  for (const r of failed) console.log(`  ${r.id} (${r.group}): ${r.detail}`);
}
console.log(`feature ${cols.feature}  agent ${cols.agent}  perf ${cols.perf}  score ${cols.score}  working ${cols.working}`);
if (g.perf) {
  for (const w of g.perf.workloads) console.log(`benchmark ${w.name}: p50 ${w.p50_ms} ms -> ${w.points} pts${w.error ? ` (${w.error})` : ""}`);
  console.log(`perf points_total ${g.perf.points_total}/200; perf_p50_us ${g.perf.perf_p50_us}`);
}
process.exitCode = failed.length > 0 ? 1 : 0;
' "$1"
}

# --- (A) sdk/run.ts fast loop -------------------------------------------
run_sdk() {
  local server_log="/tmp/gh-entry-sdk.log"
  local runner_args=(--url "http://127.0.0.1:$PORT" --token "$TOKEN")
  [ "$PERF" -eq 1 ] && runner_args+=(--perf)
  [ "$JSON" -eq 1 ] && runner_args+=(--json)
  [ -n "$TIMEOUT_MS" ] && runner_args+=(--timeout-ms "$TIMEOUT_MS")

  echo "starting dev server on port $PORT ..."
  cd "$REPO_ROOT"
  PORT="$PORT" MAKEFUN_SHOP_TOKEN="$TOKEN" node --experimental-strip-types main.ts >"$server_log" 2>&1 &
  local server_pid=$!
  trap 'kill "$server_pid" 2>/dev/null || true' EXIT

  local up=0
  for _ in $(seq 1 75); do
    if curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then up=1; break; fi
    sleep 0.2
  done
  if [ "$up" -ne 1 ]; then
    echo "server did not answer /healthz on port $PORT (see $server_log):" >&2
    tail -20 "$server_log" >&2
    exit 1
  fi

  echo "running sdk/run.ts against http://127.0.0.1:$PORT ..."
  local runner_code=0
  if [ "$JSON" -eq 1 ]; then
    node --experimental-strip-types "$KIT_DIR/sdk/run.ts" "${runner_args[@]}" >"$GRADE_JSON" || runner_code=$?
    if [ "$runner_code" -ne 0 ]; then
      echo "sdk/run.ts failed (exit $runner_code); output:" >&2
      cat "$GRADE_JSON" >&2
      exit 1
    fi
    echo "full JSON: $GRADE_JSON"
    if summarize_json "$GRADE_JSON"; then
      [ "$STRICT" -eq 1 ] && echo "strict: all 120 checks passed"
      exit 0
    else
      [ "$STRICT" -eq 1 ] && echo "strict: NOT all checks passed" >&2
      [ "$STRICT" -eq 1 ] && exit 1 || exit 0
    fi
  else
    node --experimental-strip-types "$KIT_DIR/sdk/run.ts" "${runner_args[@]}" || runner_code=$?
    if [ "$runner_code" -ne 0 ]; then
      echo "sdk/run.ts failed (exit $runner_code): /healthz did not answer or usage error" >&2
      exit 1
    fi
    # The runner exits 0 whenever /healthz answered — failing checks
    # never change the exit status. Say so, so a green exit is not
    # misread as a green run.
    echo "note: exit 0 means the run happened, not that all checks passed — read the table above."
    exit 0
  fi
}

# --- (B) full sealed trial ----------------------------------------------
run_full() {
  case "$STATE" in ""|"/") echo "refusing to use STATE=$STATE" >&2; exit 2 ;; esac
  rm -rf "$STATE"; mkdir -p "$STATE"
  mkdir -p "$SCORES"
  [ -n "$WALL" ] && export MAKEFUN_TRIAL_WALL_BUDGET_SEC="$WALL"

  echo "starting sealed env on port $ENV_PORT (state $STATE) ..."
  MAKEFUN_STATE_DIR="$STATE" MAKEFUN_ENV_HOST=127.0.0.1 MAKEFUN_ENV_PORT="$ENV_PORT" \
    MAKEFUN_SHOP_TOKEN="$TOKEN" \
    node "$KIT_DIR/program/env/server.mjs" >"$STATE/env.log" 2>&1 &
  local env_pid=$!
  trap 'kill -TERM "$env_pid" 2>/dev/null || true; [ -n "${entry_pid:-}" ] && kill "$entry_pid" 2>/dev/null || true' EXIT

  # Wait for the ready file (the harness's own signal), up to 30 s.
  local ready=0
  for _ in $(seq 1 150); do
    if [ -f "$STATE/ready" ]; then ready=1; break; fi
    sleep 0.2
  done
  if [ "$ready" -ne 1 ]; then
    echo "env did not write $STATE/ready (see $STATE/env.log):" >&2
    tail -20 "$STATE/env.log" >&2
    exit 1
  fi
  cat "$STATE/ready"; echo

  echo "starting entry (real lifecycle: listen(0) -> register -> poll /done) ..."
  cd "$REPO_ROOT"
  # Guard against a wedged entry: the trial wall is 900 s, so the entry
  # must exit well before 950 s or something is broken.
  local entry_cmd=(node --experimental-strip-types main.ts)
  if command -v timeout >/dev/null; then entry_cmd=(timeout 950 "${entry_cmd[@]}"); fi
  MAKEFUN_ENV_URL="http://127.0.0.1:$ENV_PORT" MAKEFUN_SHOP_TOKEN="$TOKEN" \
    "${entry_cmd[@]}" >"$STATE/entry.log" 2>&1 &
  entry_pid=$!
  wait "$entry_pid"
  local entry_code=$?
  echo "entry exited $entry_code"
  if [ "$entry_code" -ne 0 ]; then
    echo "--- entry log (tail) ---"; tail -30 "$STATE/entry.log"
    echo "--- env log (tail) ---"; tail -30 "$STATE/env.log"
  fi

  # The env keeps serving after /done until SIGTERM.
  kill -TERM "$env_pid" 2>/dev/null || true
  wait "$env_pid" 2>/dev/null || true
  trap - EXIT

  if [ ! -f "$STATE/export/state.json" ] || [ ! -f "$STATE/export/perf.json" ]; then
    echo "no exports at $STATE/export (see $STATE/env.log)" >&2
    exit 1
  fi
  echo "--- state.json ---"
  node -e '
const s = require("fs").readFileSync(process.argv[1], "utf8");
const j = JSON.parse(s);
console.log(`working ${j.working}; passed ${j.counts.passed}/${j.counts.total}`);
for (const [g, v] of Object.entries(j.counts.byGroup)) console.log(`  ${g}: ${v.passed}/${v.total}`);
if (j.notes && j.notes.length) console.log("notes:", JSON.stringify(j.notes));
' "$STATE/export/state.json"
  echo "--- perf.json ---"
  node -e '
const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
for (const w of j.workloads) console.log(`  ${w.name}: p50 ${w.p50_ms} ms -> ${w.points} pts${w.error ? ` (${w.error})` : ""}`);
console.log(`points_total ${j.points_total}/200; perf_p50_us ${j.perf_p50_us}`);
' "$STATE/export/perf.json"
  echo "--- scores.json ---"
  MAKEFUN_EXPORT_DIR="$STATE/export" MAKEFUN_SCORES_DIR="$SCORES" \
    node "$KIT_DIR/program/scorer/score.mjs" || { echo "scorer failed" >&2; exit 1; }
  cat "$SCORES/scores.json"
  echo "logs: $STATE/env.log $STATE/entry.log"
  [ "$entry_code" -eq 0 ]
}

if [ "$MODE" = "full" ]; then run_full; else run_sdk; fi
