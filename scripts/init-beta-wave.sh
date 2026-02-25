#!/usr/bin/env bash
set -euo pipefail

RELEASE_TAG="${RELEASE_TAG:-}"
FEEDBACK_ROOT="${FEEDBACK_ROOT:-reports/beta-feedback}"
RELEASES_DIR="${RELEASES_DIR:-releases}"
WAVES="${WAVES:-wave1,wave2,wave3}"
FORCE_REWRITE="${FORCE_REWRITE:-0}"

if [ -z "$RELEASE_TAG" ]; then
  echo "RELEASE_TAG is required" >&2
  exit 1
fi

release_feedback_root="$FEEDBACK_ROOT/$RELEASE_TAG"
release_artifact_root="$RELEASES_DIR/$RELEASE_TAG"
rollout_plan="$release_artifact_root/rollout-plan.md"

mkdir -p "$release_feedback_root"
mkdir -p "$release_artifact_root"

IFS=',' read -r -a wave_list <<< "$WAVES"

for wave in "${wave_list[@]}"; do
  wave_dir="$release_feedback_root/$wave"
  mkdir -p "$wave_dir"

  participants_csv="$wave_dir/participants.csv"
  if [ "$FORCE_REWRITE" = "1" ] || [ ! -f "$participants_csv" ]; then
    cat > "$participants_csv" <<CSV
user_id,platform,status,joined_at,last_sync_at,notes
CSV
  fi

  daily_md="$wave_dir/daily-log.md"
  if [ "$FORCE_REWRITE" = "1" ] || [ ! -f "$daily_md" ]; then
    cat > "$daily_md" <<MARKDOWN
# ${RELEASE_TAG} ${wave} 每日记录

## 今日结论
- 

## 指标观察
- 5xx:
- commit failed:
- prepare conflicts:

## 反馈摘要
- 总反馈数：
- 未关闭 P0/P1：
- 重点问题：

## 决策
- [ ] 继续当前波次
- [ ] 阻断放量并修复
- [ ] 进入下一波
MARKDOWN
  fi

  wave_readme="$wave_dir/README.md"
  if [ "$FORCE_REWRITE" = "1" ] || [ ! -f "$wave_readme" ]; then
    cat > "$wave_readme" <<MARKDOWN
# ${RELEASE_TAG} ${wave}

## 使用说明
1. 在 participants.csv 维护灰度用户名单与状态。
2. 每次收到反馈用脚本登记：
   - RELEASE_TAG=${RELEASE_TAG} WAVE=${wave} TITLE="..." SEVERITY=P2 ISSUE_TYPE=功能异常 scripts/new-beta-feedback.sh

3. 跟进反馈状态与修复记录：
   - RELEASE_TAG=${RELEASE_TAG} WAVE=${wave} FEEDBACK_ID=BF-xxxx STATUS=修复中 OWNER=dev-a node scripts/update-beta-feedback.mjs

4. 每日汇总与门禁：
   - RELEASE_TAG=${RELEASE_TAG} WAVE=${wave} node scripts/summarize-beta-feedback.mjs
   - RELEASE_TAG=${RELEASE_TAG} WAVE=${wave} scripts/check-wave-gate.sh

5. 需要推进下一波时执行：
   - RELEASE_TAG=${RELEASE_TAG} WAVE=${wave} MIN_FEEDBACK_COUNT=3 MIN_UNIQUE_REPORTERS=3 scripts/advance-beta-wave.sh

6. 将结论写入 daily-log.md。
MARKDOWN
  fi

done

if [ "$FORCE_REWRITE" = "1" ] || [ ! -f "$rollout_plan" ]; then
  cat > "$rollout_plan" <<MARKDOWN
# ${RELEASE_TAG} 灰度放量计划

## 波次与目标
- wave1：3 名内部用户，验证基础可用性与 P0/P1 风险。
- wave2：10 名高频用户，验证稳定性与性能。
- wave3：全部 Beta 用户，观察一周稳定性。

## 放量门禁
- 指标检查通过（scripts/check-metrics.sh）。
- 未关闭 P0/P1 = 0。
- 最小反馈量达到要求（可通过 MIN_FEEDBACK_COUNT 控制）。
- 最小反馈用户数达到要求（可通过 MIN_UNIQUE_REPORTERS 控制）。

## 建议门槛
- wave1 -> wave2：MIN_FEEDBACK_COUNT=3 MIN_UNIQUE_REPORTERS=3
- wave2 -> wave3：MIN_FEEDBACK_COUNT=10 MIN_UNIQUE_REPORTERS=8

## 执行命令示例
- RELEASE_TAG=${RELEASE_TAG} WAVE=wave1 MIN_FEEDBACK_COUNT=3 MIN_UNIQUE_REPORTERS=3 scripts/check-wave-gate.sh
- RELEASE_TAG=${RELEASE_TAG} WAVE=wave2 MIN_FEEDBACK_COUNT=10 MIN_UNIQUE_REPORTERS=8 scripts/check-wave-gate.sh
- RELEASE_TAG=${RELEASE_TAG} WAVE=wave1 MIN_FEEDBACK_COUNT=3 MIN_UNIQUE_REPORTERS=3 scripts/advance-beta-wave.sh
MARKDOWN
fi

echo "BETA_WAVE_INIT_RELEASE=$RELEASE_TAG"
echo "BETA_WAVE_FEEDBACK_ROOT=$release_feedback_root"
echo "BETA_WAVE_ROLLOUT_PLAN=$rollout_plan"
