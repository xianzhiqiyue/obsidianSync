#!/usr/bin/env bash
set -euo pipefail

RELEASE_TAG="${RELEASE_TAG:-}"
WAVE="${WAVE:-wave1}"
RUN_METRICS_CHECK="${RUN_METRICS_CHECK:-1}"
METRICS_SOFT_FAIL="${METRICS_SOFT_FAIL:-0}"
FEEDBACK_ROOT="${FEEDBACK_ROOT:-reports/beta-feedback}"
MIN_FEEDBACK_COUNT="${MIN_FEEDBACK_COUNT:-1}"
MIN_UNIQUE_REPORTERS="${MIN_UNIQUE_REPORTERS:-1}"

if [ -z "$RELEASE_TAG" ]; then
  echo "RELEASE_TAG is required" >&2
  exit 1
fi

status=0

if [ "$RUN_METRICS_CHECK" = "1" ]; then
  if ! scripts/check-metrics.sh; then
    if [ "$METRICS_SOFT_FAIL" = "1" ]; then
      echo "WAVE_GATE_WARN=metrics check failed (soft fail)" >&2
    else
      echo "WAVE_GATE_FAIL=metrics check failed" >&2
      status=1
    fi
  fi
fi

if ! RELEASE_TAG="$RELEASE_TAG" WAVE="$WAVE" FEEDBACK_ROOT="$FEEDBACK_ROOT" node scripts/summarize-beta-feedback.mjs; then
  echo "WAVE_GATE_FAIL=feedback summary failed" >&2
  status=1
fi

summary_json="$FEEDBACK_ROOT/$RELEASE_TAG/$WAVE/summary.json"
if [ ! -f "$summary_json" ]; then
  echo "WAVE_GATE_FAIL=summary json not found: $summary_json" >&2
  status=1
fi

feedback_total="$(node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(String(j.totals?.all ?? 0));' "$summary_json")"
open_high="$(node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(String(j.totals?.openHigh ?? 0));' "$summary_json")"
unique_reporters="$(node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(String(j.totals?.uniqueReporters ?? 0));' "$summary_json")"

if [ "$open_high" -gt 0 ]; then
  echo "WAVE_GATE_FAIL=open high severity feedback exists (count=$open_high)" >&2
  status=1
fi

if [ "$feedback_total" -lt "$MIN_FEEDBACK_COUNT" ]; then
  echo "WAVE_GATE_FAIL=insufficient feedback count (got=$feedback_total need>=$MIN_FEEDBACK_COUNT)" >&2
  status=1
fi

if [ "$unique_reporters" -lt "$MIN_UNIQUE_REPORTERS" ]; then
  echo "WAVE_GATE_FAIL=insufficient unique reporters (got=$unique_reporters need>=$MIN_UNIQUE_REPORTERS)" >&2
  status=1
fi

echo "WAVE_GATE_FEEDBACK_TOTAL=$feedback_total"
echo "WAVE_GATE_OPEN_HIGH=$open_high"
echo "WAVE_GATE_UNIQUE_REPORTERS=$unique_reporters"

if [ "$status" -eq 0 ]; then
  echo "WAVE_GATE=PASS"
else
  echo "WAVE_GATE=FAIL"
fi

exit "$status"
