#!/usr/bin/env bash
set -euo pipefail

RELEASE_TAG="${RELEASE_TAG:-}"
WAVE="${WAVE:-wave1}"
NEXT_WAVE="${NEXT_WAVE:-}"
RELEASES_DIR="${RELEASES_DIR:-releases}"
FEEDBACK_ROOT="${FEEDBACK_ROOT:-reports/beta-feedback}"
MIN_FEEDBACK_COUNT="${MIN_FEEDBACK_COUNT:-1}"
MIN_UNIQUE_REPORTERS="${MIN_UNIQUE_REPORTERS:-1}"
RUN_METRICS_CHECK="${RUN_METRICS_CHECK:-1}"
METRICS_SOFT_FAIL="${METRICS_SOFT_FAIL:-0}"
GENERATE_ROLLOUT_BRIEF="${GENERATE_ROLLOUT_BRIEF:-1}"
SYNC_API_BASE_URL="${SYNC_API_BASE_URL:-https://sync.example.com/api/v1}"
DOWNLOAD_URL="${DOWNLOAD_URL:-}"

if [ -z "$RELEASE_TAG" ]; then
  echo "RELEASE_TAG is required" >&2
  exit 1
fi

if [ -z "$NEXT_WAVE" ]; then
  case "$WAVE" in
    wave1) NEXT_WAVE="wave2" ;;
    wave2) NEXT_WAVE="wave3" ;;
    *) NEXT_WAVE="" ;;
  esac
fi

decision_file="$RELEASES_DIR/$RELEASE_TAG/wave-decisions.md"
mkdir -p "$(dirname "$decision_file")"

gate_output=""
gate_status=0
set +e
gate_output="$(
  RELEASE_TAG="$RELEASE_TAG" \
  WAVE="$WAVE" \
  FEEDBACK_ROOT="$FEEDBACK_ROOT" \
  MIN_FEEDBACK_COUNT="$MIN_FEEDBACK_COUNT" \
  MIN_UNIQUE_REPORTERS="$MIN_UNIQUE_REPORTERS" \
  RUN_METRICS_CHECK="$RUN_METRICS_CHECK" \
  METRICS_SOFT_FAIL="$METRICS_SOFT_FAIL" \
  scripts/check-wave-gate.sh 2>&1
)"
gate_status=$?
set -e

printf '%s\n' "$gate_output"

extract_value() {
  local key="$1"
  printf '%s\n' "$gate_output" | awk -F= -v key="$key" '$1 == key { print $2; exit }'
}

gate_result="$(extract_value WAVE_GATE)"
feedback_total="$(extract_value WAVE_GATE_FEEDBACK_TOTAL)"
open_high="$(extract_value WAVE_GATE_OPEN_HIGH)"
unique_reporters="$(extract_value WAVE_GATE_UNIQUE_REPORTERS)"

[ -n "$gate_result" ] || gate_result=$([ "$gate_status" -eq 0 ] && echo "PASS" || echo "FAIL")
[ -n "$feedback_total" ] || feedback_total="unknown"
[ -n "$open_high" ] || open_high="unknown"
[ -n "$unique_reporters" ] || unique_reporters="unknown"

timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if [ ! -f "$decision_file" ]; then
  cat > "$decision_file" <<MARKDOWN
# $RELEASE_TAG Wave 决策记录

MARKDOWN
fi

{
  echo "## $timestamp $WAVE"
  echo "- gate: $gate_result"
  echo "- feedback_total: $feedback_total"
  echo "- open_high: $open_high"
  echo "- unique_reporters: $unique_reporters"
  echo "- thresholds: min_feedback=$MIN_FEEDBACK_COUNT, min_unique_reporters=$MIN_UNIQUE_REPORTERS"
  echo "- metrics_check: run=$RUN_METRICS_CHECK, soft_fail=$METRICS_SOFT_FAIL"
  if [ "$gate_result" = "PASS" ] && [ -n "$NEXT_WAVE" ]; then
    echo "- decision: 允许进入 $NEXT_WAVE"
  elif [ "$gate_result" = "PASS" ]; then
    echo "- decision: 当前已是最后波次，可准备 Beta 收敛结项"
  else
    echo "- decision: 继续当前波次并修复问题"
  fi
  echo ""
} >> "$decision_file"

if [ "$gate_result" = "PASS" ] && [ -n "$NEXT_WAVE" ]; then
  next_wave_dir="$FEEDBACK_ROOT/$RELEASE_TAG/$NEXT_WAVE"
  ready_file="$next_wave_dir/ready-for-rollout.md"
  mkdir -p "$next_wave_dir"
  cat > "$ready_file" <<MARKDOWN
# $RELEASE_TAG $NEXT_WAVE 准备就绪

- generatedAt: $timestamp
- previousWave: $WAVE
- gateResult: PASS

## 下一步
1. 更新 ${NEXT_WAVE} participants.csv。
2. 通知试用用户安装当前 Beta 包。
3. 每日执行反馈汇总和门禁检查。
MARKDOWN
  echo "BETA_NEXT_WAVE_READY_FILE=$ready_file"

  if [ "$GENERATE_ROLLOUT_BRIEF" = "1" ] && [ -x "scripts/prepare-wave-rollout.sh" ]; then
    RELEASE_TAG="$RELEASE_TAG" \
    WAVE="$NEXT_WAVE" \
    RELEASES_DIR="$RELEASES_DIR" \
    FEEDBACK_ROOT="$FEEDBACK_ROOT" \
    SYNC_API_BASE_URL="$SYNC_API_BASE_URL" \
    DOWNLOAD_URL="$DOWNLOAD_URL" \
    scripts/prepare-wave-rollout.sh
  fi
fi

echo "BETA_WAVE_DECISION_FILE=$decision_file"
echo "BETA_WAVE_GATE=$gate_result"

exit "$gate_status"
