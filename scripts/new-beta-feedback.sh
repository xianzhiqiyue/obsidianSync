#!/usr/bin/env bash
set -euo pipefail

RELEASE_TAG="${RELEASE_TAG:-}"
WAVE="${WAVE:-wave1}"
FEEDBACK_ROOT="${FEEDBACK_ROOT:-reports/beta-feedback}"
SEVERITY="${SEVERITY:-P2}"
STATUS="${STATUS:-待确认}"
ISSUE_TYPE="${ISSUE_TYPE:-功能异常}"
TITLE="${TITLE:-}"
REPORTER="${REPORTER:-unknown}"
PLATFORM="${PLATFORM:-unknown}"
PLUGIN_VERSION="${PLUGIN_VERSION:-unknown}"
API_VERSION="${API_VERSION:-unknown}"
DESCRIPTION="${DESCRIPTION:-}"
EXPECTED="${EXPECTED:-}"
ACTUAL="${ACTUAL:-}"
REPRO_STEPS="${REPRO_STEPS:-}"
ATTACHMENTS="${ATTACHMENTS:-}"

if [ -z "$RELEASE_TAG" ]; then
  echo "RELEASE_TAG is required" >&2
  exit 1
fi

if [ -z "$TITLE" ]; then
  echo "TITLE is required" >&2
  exit 1
fi

case "$SEVERITY" in
  P0|P1|P2|P3) ;;
  *)
    echo "invalid SEVERITY: $SEVERITY (expected P0|P1|P2|P3)" >&2
    exit 1
    ;;
esac

safe_slug="$(printf '%s' "$TITLE" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-//;s/-$//')"
if [ -z "$safe_slug" ]; then
  safe_slug="feedback"
fi

feedback_dir="$FEEDBACK_ROOT/$RELEASE_TAG/$WAVE"
mkdir -p "$feedback_dir"

seq_no="$(find "$feedback_dir" -maxdepth 1 -name '*.md' | wc -l | tr -d '[:space:]')"
seq_no=$((seq_no + 1))
feedback_id="BF-$(date -u +%Y%m%d)-$(printf '%03d' "$seq_no")"
file_name="$(date -u +%Y%m%dT%H%M%SZ)-${safe_slug}.md"
file_path="$feedback_dir/$file_name"

cat > "$file_path" <<MARKDOWN
---
id: $feedback_id
releaseTag: $RELEASE_TAG
wave: $WAVE
severity: $SEVERITY
status: $STATUS
type: $ISSUE_TYPE
reporter: $REPORTER
platform: $PLATFORM
pluginVersion: $PLUGIN_VERSION
apiVersion: $API_VERSION
createdAt: $(date -u +%Y-%m-%dT%H:%M:%SZ)
---

# $TITLE

## 现象
$DESCRIPTION

## 期望行为
$EXPECTED

## 实际行为
$ACTUAL

## 复现步骤
$REPRO_STEPS

## 附件
$ATTACHMENTS

## 处理记录
- 受理人：
- 状态：$STATUS
- 关联任务/提交：
- 结论：
MARKDOWN

echo "BETA_FEEDBACK_ID=$feedback_id"
echo "BETA_FEEDBACK_FILE=$file_path"
