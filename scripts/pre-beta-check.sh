#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000/api/v1}"
START_INFRA="${START_INFRA:-1}"
RUN_PERF="${RUN_PERF:-0}"
PERF_QUICK="${PERF_QUICK:-1}"

api_started_by_script=0
api_pid=""

cleanup() {
  if [ "$api_started_by_script" = "1" ] && [ -n "$api_pid" ]; then
    kill "$api_pid" >/dev/null 2>&1 || true
    wait "$api_pid" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [ "$START_INFRA" = "1" ]; then
  docker compose -f infra/docker-compose.yml up -d
  npm run migrate
fi

api_health_ok=0
if curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
  api_health_ok=1
fi

if [ "$api_health_ok" != "1" ]; then
  npm run dev:api >/tmp/obsidian-sync-beta-api.log 2>&1 &
  api_pid=$!
  api_started_by_script=1

  for _ in $(seq 1 90); do
    if curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
      api_health_ok=1
      break
    fi
    sleep 1
  done
fi

if [ "$api_health_ok" != "1" ]; then
  echo "sync-api is not ready: $BASE_URL/health" >&2
  exit 1
fi

npm run build
npm run --workspace @obsidian-sync/plugin test

scripts/smoke-api.sh
scripts/regression-sync-api.sh
scripts/check-metrics.sh

if [ "$RUN_PERF" = "1" ]; then
  if [ "$PERF_QUICK" = "1" ]; then
    PERF_BASELINE_USERS=3 PERF_BASELINE_DURATION_SEC=12 PERF_WEAK_USERS=3 PERF_WEAK_DURATION_SEC=12 scripts/run-perf-suite.sh
  else
    scripts/run-perf-suite.sh
  fi
fi

echo "PRE_BETA_CHECK=PASS"
