# Obsidian Sync Beta 发布手册（v1）

## 1. 目标与范围
- 发布可安装的 Beta 版本（桌面 + Android 手动安装）。
- 建立灰度反馈闭环，保证问题可追踪、可回滚。

## 2. 发布前检查
- 推荐命令：
  - `scripts/pre-beta-check.sh`
- 检查内容：
  - 全量构建与插件单测。
  - API 冒烟回归（冲突/幂等）。
  - 指标阈值检查。
- 可选：`RUN_PERF=1 scripts/pre-beta-check.sh` 追加快速压测校验。

## 3. 生成 Beta 安装包
- 命令：
  - `scripts/package-plugin-beta.sh`
- 输出目录：
  - `releases/<release-tag>/plugin/<plugin-id>/`
  - `releases/<release-tag>/plugin/<plugin-id>-<version>-<release-tag>.zip`
  - `releases/<release-tag>/plugin/<plugin-id>-<version>-<release-tag>.zip.sha256`
  - `releases/<release-tag>/release-meta.json`

## 3.1 初始化波次执行目录（推荐）
- 命令：
  - `RELEASE_TAG=<tag> scripts/init-beta-wave.sh`
  - `RELEASE_TAG=<tag> FORCE_REWRITE=1 scripts/init-beta-wave.sh`（覆盖刷新已有模板）
- 生成内容：
  - `reports/beta-feedback/<tag>/wave1|wave2|wave3/`
  - 每个波次的 `participants.csv`、`daily-log.md`、`README.md`
  - `releases/<tag>/rollout-plan.md`

## 4. 桌面端安装（macOS/Windows/Linux）
1. 解压安装包，得到 `main.js`、`manifest.json`、`styles.css`。
2. 复制到 Vault 路径：`.obsidian/plugins/custom-sync/`。
3. 打开 Obsidian：`Settings -> Community plugins`。
4. 启用 `Custom Sync`。
5. 在插件设置页填写 API 地址与账号并执行一次手动同步。

## 5. Android 安装
1. 在文件管理器中进入 Vault：`<Vault>/.obsidian/plugins/custom-sync/`。
2. 覆盖复制 `main.js`、`manifest.json`、`styles.css`。
3. 重启 Obsidian Android 或在前后台切换后重新加载插件。
4. 执行一次手动同步并确认无报错。

## 6. 灰度发布节奏（建议）
- Wave 1（1-2 天）：3 名内部用户。
- Wave 2（2-3 天）：10 名高频用户。
- Wave 3（3-7 天）：全部 Beta 用户。

每一波进入下一波前需要满足：
- 无 P0 数据丢失。
- P1 缺陷可回避或已有修复计划。
- 关键指标未明显劣化（5xx、commit 失败率、冲突率）。

## 7. 反馈收集与分级
- 反馈模板：`docs/灰度反馈模板.md`
- 脚本化登记（推荐）：
  - `RELEASE_TAG=<tag> WAVE=wave1 TITLE=\"...\" SEVERITY=P1 ISSUE_TYPE=功能异常 scripts/new-beta-feedback.sh`
- 脚本化汇总：
  - `RELEASE_TAG=<tag> WAVE=wave1 node scripts/summarize-beta-feedback.mjs`
- 缺陷分级建议：
  - P0：数据丢失、不可恢复损坏。
  - P1：核心同步中断或频繁失败。
  - P2：功能可用但体验明显受损。
  - P3：轻微体验问题。

## 7.1 Wave 放量门禁（建议）
- 命令：
  - `RELEASE_TAG=<tag> WAVE=wave1 scripts/check-wave-gate.sh`
- 门禁规则：
  - 指标检查通过（默认执行 `scripts/check-metrics.sh`）。
  - 不存在未关闭的 P0/P1 反馈（基于 `scripts/summarize-beta-feedback.mjs` 输出）。
  - 达到最小反馈量（默认 `MIN_FEEDBACK_COUNT=1`）。
  - 达到最小反馈用户数（默认 `MIN_UNIQUE_REPORTERS=1`）。
- 可按波次设置门槛：
  - `RELEASE_TAG=<tag> WAVE=wave1 MIN_FEEDBACK_COUNT=3 MIN_UNIQUE_REPORTERS=3 scripts/check-wave-gate.sh`
- 通过后可进入下一波（例如 Wave 2）。

## 7.2 反馈修复闭环（推荐）
- 更新反馈状态（按反馈 ID）：
  - `RELEASE_TAG=<tag> WAVE=wave1 FEEDBACK_ID=BF-20260219-001 STATUS=已修复 OWNER=dev-a LINKED_TASK=fix/commit-409 node scripts/update-beta-feedback.mjs`
- 更新反馈状态（按文件路径）：
  - `RELEASE_TAG=<tag> WAVE=wave1 FEEDBACK_FILE=20260219T010203Z-sync-fail.md STATUS=修复中 node scripts/update-beta-feedback.mjs`
- 可更新字段：
  - `STATUS`、`SEVERITY`、`ISSUE_TYPE`
  - `OWNER`、`LINKED_TASK`、`CONCLUSION`、`NOTE`
- 行为说明：
  - 自动更新 front matter（`status/severity/type/updatedAt`）。
  - 自动刷新“处理记录”区块并追加一条“更新”日志。

## 7.3 波次推进决策（推荐）
- 一键执行门禁 + 决策落盘：
  - `RELEASE_TAG=<tag> WAVE=wave1 MIN_FEEDBACK_COUNT=3 MIN_UNIQUE_REPORTERS=3 scripts/advance-beta-wave.sh`
- 产出文件：
  - `releases/<tag>/wave-decisions.md`（每次判定都会追加记录）
  - 通过时自动生成 `reports/beta-feedback/<tag>/wave2/ready-for-rollout.md`
- 可控制项：
  - `RUN_METRICS_CHECK=0` 跳过指标门禁（仅用于离线演练）
  - `METRICS_SOFT_FAIL=1` 指标失败仅告警不阻断
  - `SYNC_API_BASE_URL=https://sync.example.com/api/v1` 透传到下一波投放说明
  - `DOWNLOAD_URL=https://download.example.com/custom-sync.zip` 透传到下一波投放说明

## 7.4 生成投放说明（推荐）
- 命令：
  - `RELEASE_TAG=<tag> WAVE=wave2 SYNC_API_BASE_URL=https://sync.example.com/api/v1 scripts/prepare-wave-rollout.sh`
- 产出文件：
  - `reports/beta-feedback/<tag>/<wave>/rollout-brief.md`
- 用途：
  - 汇总安装包路径、sha256、试用 API 地址、用户/运维执行清单，可直接发给试用用户与运营同学。

## 7.5 批量创建试用账号（推荐）
- 命令（写库）：
  - `RELEASE_TAG=<tag> WAVE=wave2 COUNT=10 APPLY=1 POSTGRES_MODE=docker POSTGRES_PASSWORD=<pg-password> scripts/provision-beta-users.sh`
- 演练命令（不写库）：
  - `RELEASE_TAG=<tag> WAVE=wave2 COUNT=3 APPLY=0 scripts/provision-beta-users.sh`
- 产出文件：
  - 凭据文件：`.secrets/beta-users/<tag>-<wave>-accounts-<timestamp>.csv`（明文密码，注意保密）
  - 参与者文件：`reports/beta-feedback/<tag>/<wave>/participants.csv`（自动补充 invited 用户）
- 注意事项：
  - 默认不允许覆盖已存在邮箱；若需轮换密码可设置 `ALLOW_EXISTING=1`。
  - 建议使用一次性分发渠道下发凭据，试用结束后立即删除凭据文件并重置密码。

## 8. 回滚方案
- 客户端回滚：
  1. 将插件目录替换为上一个稳定包。
  2. 重新启动 Obsidian 并验证同步。
- 服务端回滚：
  1. 回滚 API 镜像版本。
  2. 若涉及 DB 变更，按向后兼容策略执行。

## 9. 发布记录（建议字段）
- `release-tag`
- 插件版本
- 发布日期
- 变更摘要
- 已知问题
- 回滚指引
