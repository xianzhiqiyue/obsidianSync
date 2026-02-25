#!/usr/bin/env bash
set -euo pipefail

RELEASE_TAG="${RELEASE_TAG:-}"
WAVE="${WAVE:-wave1}"
RELEASES_DIR="${RELEASES_DIR:-releases}"
FEEDBACK_ROOT="${FEEDBACK_ROOT:-reports/beta-feedback}"
SYNC_API_BASE_URL="${SYNC_API_BASE_URL:-https://sync.example.com/api/v1}"
DOWNLOAD_URL="${DOWNLOAD_URL:-}"
OUTPUT_FILE="${OUTPUT_FILE:-}"

if [ -z "$RELEASE_TAG" ]; then
  echo "RELEASE_TAG is required" >&2
  exit 1
fi

meta_file="$RELEASES_DIR/$RELEASE_TAG/release-meta.json"
wave_dir="$FEEDBACK_ROOT/$RELEASE_TAG/$WAVE"

if [ ! -f "$meta_file" ]; then
  echo "release meta not found: $meta_file" >&2
  exit 1
fi

if [ -z "$OUTPUT_FILE" ]; then
  OUTPUT_FILE="$wave_dir/rollout-brief.md"
fi

mkdir -p "$wave_dir"

plugin_id="$(node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(j.plugin?.id ?? "");' "$meta_file")"
plugin_version="$(node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(j.plugin?.version ?? "");' "$meta_file")"
zip_path="$(node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(j.plugin?.zip ?? "");' "$meta_file")"
sha_path="$(node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(j.plugin?.sha256 ?? "");' "$meta_file")"
created_at="$(node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(j.createdAt ?? "");' "$meta_file")"

if [ -z "$plugin_id" ] || [ -z "$plugin_version" ] || [ -z "$zip_path" ]; then
  echo "invalid release meta: missing plugin id/version/zip" >&2
  exit 1
fi

sha256_value="N/A"
if [ -n "$sha_path" ] && [ -f "$sha_path" ]; then
  sha256_value="$(awk 'NR==1 {print $1}' "$sha_path")"
fi

artifact_hint="$zip_path"
if [ -n "$DOWNLOAD_URL" ]; then
  artifact_hint="$DOWNLOAD_URL"
fi

generated_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

cat > "$OUTPUT_FILE" <<MARKDOWN
# ${RELEASE_TAG} ${WAVE} 投放说明

## 发布信息
- generatedAt: ${generated_at}
- releaseTag: ${RELEASE_TAG}
- wave: ${WAVE}
- pluginId: ${plugin_id}
- pluginVersion: ${plugin_version}
- releaseCreatedAt: ${created_at}

## 安装包与校验
- artifact: ${artifact_hint}
- localArtifactPath: ${zip_path}
- sha256: ${sha256_value}

## 试用配置
- syncApiBaseUrl: ${SYNC_API_BASE_URL}
- 登录账号：按 participants.csv 单独分发（不要共用管理员账号）。

## 试用用户操作清单
1. 安装 Beta 插件（参考 \`docs/Beta发布手册.md\` 的桌面/Android 安装步骤）。
2. 在插件设置中填入 \`syncApiBaseUrl\` 并登录分配账号。
3. 执行 1 次手动同步，确认无错误提示。
4. 在 24 小时内至少完成 1 次“修改 -> 同步 -> 另一端拉取”闭环验证。
5. 发现问题后立即反馈（描述步骤 + 截图 + 日志时间）。

## 运维执行清单
1. 更新 \`${wave_dir}/participants.csv\`（发放状态、首次同步时间）。
2. 记录反馈：
   - \`RELEASE_TAG=${RELEASE_TAG} WAVE=${WAVE} TITLE="..." SEVERITY=P2 ISSUE_TYPE=功能异常 scripts/new-beta-feedback.sh\`
3. 每日汇总：
   - \`RELEASE_TAG=${RELEASE_TAG} WAVE=${WAVE} node scripts/summarize-beta-feedback.mjs\`
4. 门禁判定：
   - \`RELEASE_TAG=${RELEASE_TAG} WAVE=${WAVE} MIN_FEEDBACK_COUNT=3 MIN_UNIQUE_REPORTERS=3 scripts/check-wave-gate.sh\`
MARKDOWN

echo "BETA_WAVE_ROLLOUT_FILE=$OUTPUT_FILE"
echo "BETA_WAVE_RELEASE_META=$meta_file"
