#!/usr/bin/env bash
set -euo pipefail

METRICS_URL="${METRICS_URL:-http://localhost:3000/api/v1/metrics}"
MAX_COMMIT_FAILED_TOTAL="${MAX_COMMIT_FAILED_TOTAL:-0}"
MAX_HTTP_5XX_TOTAL="${MAX_HTTP_5XX_TOTAL:-0}"
MAX_PREPARE_CONFLICTS_TOTAL="${MAX_PREPARE_CONFLICTS_TOTAL:-200}"

metrics="$(curl -fsS "$METRICS_URL")"

metric_sum() {
  local pattern="$1"
  printf '%s\n' "$metrics" | awk -v pat="$pattern" '$0 ~ pat {sum += $NF} END {print sum + 0}'
}

commit_failed_total="$(metric_sum '^sync_api_sync_commit_total\\{.*result="failed".*\\}[[:space:]]')"
http_5xx_total="$(metric_sum '^sync_api_http_requests_total\\{.*status="5[0-9][0-9]".*\\}[[:space:]]')"
prepare_conflicts_total="$(metric_sum '^sync_api_sync_prepare_conflicts_total([[:space:]]|\\{)')"

status=0

if [ "$commit_failed_total" -gt "$MAX_COMMIT_FAILED_TOTAL" ]; then
  echo "ALERT: sync commit failed total=$commit_failed_total threshold=$MAX_COMMIT_FAILED_TOTAL"
  status=1
fi

if [ "$http_5xx_total" -gt "$MAX_HTTP_5XX_TOTAL" ]; then
  echo "ALERT: http 5xx total=$http_5xx_total threshold=$MAX_HTTP_5XX_TOTAL"
  status=1
fi

if [ "$prepare_conflicts_total" -gt "$MAX_PREPARE_CONFLICTS_TOTAL" ]; then
  echo "ALERT: sync prepare conflicts total=$prepare_conflicts_total threshold=$MAX_PREPARE_CONFLICTS_TOTAL"
  status=1
fi

echo "METRICS_CHECK: commit_failed_total=$commit_failed_total http_5xx_total=$http_5xx_total prepare_conflicts_total=$prepare_conflicts_total"

exit "$status"
