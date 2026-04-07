# Obsidian Sync (Self-hosted)

一款自建托管的 Obsidian 笔记同步解决方案，支持多设备实时同步、版本冲突自动处理、离线优先架构。

## 项目简介

Obsidian 官方同步服务在国内访问不稳定，且需要付费订阅。本项目提供一套完整的自建同步方案，让你可以在自己的服务器上部署专属的 Obsidian 同步服务，数据完全自主可控。

### 核心特性

- **端到端加密**：支持客户端加密，服务端仅存储加密后的内容
- **离线优先**：无网环境下可正常编辑，联网后自动同步冲突处理
- **版本控制**：基于 checkpoint 的增量同步，支持历史版本回溯
- **多 Vault 管理**：一个账号可管理多个知识库，灵活切换
- **设备授权**：基于 JWT 的设备注册与撤销机制，安全可控
- **冲突自动合并**：智能识别文件级冲突，提供可视化合并界面

### 技术架构

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Obsidian 客户端 │◄───►│   Sync API      │◄───►│   PostgreSQL    │
│   (插件)        │     │  (Fastify)      │     │   (元数据存储)   │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                               │
                               ▼
                        ┌─────────────────┐
                        │   MinIO / S3    │
                        │  (对象存储)      │
                        └─────────────────┘
```

### 项目结构

- `apps/sync-api`: 同步服务端，Fastify + PostgreSQL + S3(MinIO)
- `apps/obsidian-plugin`: Obsidian 客户端插件
- `infra/`: Docker Compose 编排配置与监控组件
- `docs/`: 架构设计、API 文档、运维手册
- `scripts/`: 开发、测试、部署、运维脚本集合

---

## 快速开始

P1 基础设施阶段代码：
- `apps/sync-api`: Fastify + PostgreSQL + S3(Minio) 基础服务
- `apps/obsidian-plugin`: Obsidian 插件骨架 + 设置页 + 本地状态存储
- `infra/docker-compose.yml`: 本地依赖（PostgreSQL + MinIO）

## 1. 安装依赖

```bash
npm install
```

## 2. 启动基础设施

```bash
docker compose -f infra/docker-compose.yml up -d
```

生产环境建议（端口最小暴露 + 自定义凭据）：

```bash
cp infra/.env.prod.example infra/.env.prod
# 修改 infra/.env.prod 中的凭据与端口绑定后执行
docker compose --env-file infra/.env.prod -f infra/docker-compose.yml -f infra/docker-compose.prod.yml up -d
```

当前阿里云单机环境若采用 `/home/admin/obsidianSync` + `nohup node dist/index.js` 方式运行 `sync-api`，可直接使用：

```bash
python3 scripts/deploy-sync-api-aliyun.py
```

该脚本会同步 `sync-api` 和 `packages/shared` 的最小运行集、远端重建并重启 `sync-api`，最后执行 `health/ready` 检查。

`.env.prod` 推荐最小暴露策略：
- `POSTGRES_PORT_BIND=127.0.0.1:5432:5432`
- `MINIO_API_PORT_BIND=0.0.0.0:9000:9000`
- `MINIO_CONSOLE_PORT_BIND=127.0.0.1:9001:9001`

`infra/docker-compose.prod.yml` 仅承载生产通用策略（如 `restart`），端口策略统一由 `.env.prod` 控制，避免 compose 叠加时端口覆盖歧义。

可选：使用 `ufw` 进一步收口主机入站端口（默认 dry-run）：

```bash
scripts/harden-firewall.sh
APPLY=1 scripts/harden-firewall.sh
```

脚本默认会同时写入 `DOCKER-USER` 链丢弃规则（对 `DENY_PORTS`），防止 Docker 端口转发绕过主机防火墙策略。

## 3. 配置 API 环境

```bash
cp apps/sync-api/.env.example apps/sync-api/.env
```

## 4. 执行迁移与种子账号

```bash
npm run migrate
```

默认种子账号（可通过 `.env` 覆盖）：
- email: `admin@example.com`
- password: `admin123456`

## 5. 启动服务

```bash
npm run dev:api
```

健康检查：
- `GET http://localhost:3000/api/v1/health`
- `GET http://localhost:3000/api/v1/ready`
- `GET http://localhost:3000/api/v1/metrics`

## 6. 构建插件

```bash
npm run dev:plugin
```

插件构建输出目录：
- `apps/obsidian-plugin/dist/main.js`
- `apps/obsidian-plugin/dist/manifest.json`
- `apps/obsidian-plugin/dist/styles.css`

插件单元测试：

```bash
npm run --workspace @obsidian-sync/plugin test
```

## 7. API 冒烟验证

```bash
scripts/smoke-api.sh
```

可通过环境变量覆盖默认参数：

```bash
BASE_URL=http://localhost:3000/api/v1 EMAIL=admin@example.com PASSWORD=admin123456 scripts/smoke-api.sh
```

## 8. API 回归验证（冲突/rename/幂等）

```bash
scripts/regression-sync-api.sh
```

可通过环境变量覆盖默认参数：

```bash
BASE_URL=http://localhost:3000/api/v1 EMAIL=admin@example.com PASSWORD=admin123456 scripts/regression-sync-api.sh
```

## 9. 指标与告警检查

获取 Prometheus 指标：

```bash
curl -sS http://localhost:3000/api/v1/metrics
```

执行阈值检查脚本：

```bash
scripts/check-metrics.sh
```

覆盖默认阈值：

```bash
MAX_COMMIT_FAILED_TOTAL=0 MAX_HTTP_5XX_TOTAL=0 MAX_PREPARE_CONFLICTS_TOTAL=200 scripts/check-metrics.sh
```

## 10. 备份与恢复演练

PostgreSQL 备份（默认输出到 `backups/postgres/`）：

```bash
scripts/backup-postgres.sh
```

PostgreSQL 恢复（破坏性操作，必须显式允许）：

```bash
ALLOW_DROP=1 POSTGRES_BACKUP_FILE=backups/postgres/obsidian_sync-xxxx.sql.gz TARGET_DB_NAME=obsidian_sync_restore scripts/restore-postgres.sh
```

MinIO 备份（默认输出到 `backups/minio/`）：

```bash
scripts/backup-minio.sh
```

MinIO 恢复（可选清理目标桶多余对象）：

```bash
MINIO_BACKUP_DIR=backups/minio/obsidian-sync-xxxx TARGET_S3_BUCKET=obsidian-sync-restore REMOVE_EXTRA=1 scripts/restore-minio.sh
```

一键备份恢复演练（会自动写入一条同步数据并校验恢复结果）：

```bash
scripts/drill-backup-restore.sh
```

演练脚本默认保留恢复目标库和恢复目标桶用于核查，设置 `CLEANUP_VERIFY_TARGETS=1` 可在验证后自动清理。

## 11. 监控可视化（Prometheus + Grafana）

启动监控栈：

```bash
docker compose -f infra/docker-compose.yml -f infra/docker-compose.monitoring.yml up -d
```

访问地址：
- Prometheus: `http://localhost:9090`
- Grafana: `http://localhost:3001`（默认账号密码：`admin` / `admin`）

默认采集目标：
- `host.docker.internal:3000/api/v1/metrics`

如需调整保留期或 Grafana 管理员账号，可覆盖：

```bash
PROMETHEUS_RETENTION=30d GRAFANA_ADMIN_USER=admin GRAFANA_ADMIN_PASSWORD=change-me \
docker compose -f infra/docker-compose.yml -f infra/docker-compose.monitoring.yml up -d
```

## 12. 并发与弱网压测

单场景压测（直接输出 JSON 报告）：

```bash
SCENARIO=concurrency-baseline USERS=10 DURATION_SEC=60 node scripts/load-sync-api.mjs
```

弱网场景（客户端注入延迟/超时/丢包模拟）：

```bash
SCENARIO=weak-network WEAK_MODE=1 USERS=8 DURATION_SEC=60 \
WEAK_DELAY_MIN_MS=300 WEAK_DELAY_MAX_MS=800 WEAK_TIMEOUT_RATE=0.2 WEAK_DROP_RATE=0.05 \
node scripts/load-sync-api.mjs
```

一键执行并发+弱网两场景并生成汇总报告：

```bash
scripts/run-perf-suite.sh
```

输出目录默认：
- `reports/perf/*-concurrency-baseline.json`
- `reports/perf/*-weak-network.json`
- `reports/perf/*-summary.md`

## 13. Beta 发布（P5）

发布前检查（构建 + 测试 + API 回归 + 指标阈值）：

```bash
scripts/pre-beta-check.sh
```

生成 Beta 安装包：

```bash
scripts/package-plugin-beta.sh
```

初始化 Wave 执行目录（推荐）：

```bash
RELEASE_TAG=beta-xxxx scripts/init-beta-wave.sh
```

刷新已存在的 Wave 模板（会覆盖 README/daily-log/participants/rollout-plan）：

```bash
RELEASE_TAG=beta-xxxx FORCE_REWRITE=1 scripts/init-beta-wave.sh
```

登记灰度反馈（脚本化）：

```bash
RELEASE_TAG=beta-xxxx WAVE=wave1 TITLE="Android 同步失败" SEVERITY=P1 ISSUE_TYPE=功能异常 scripts/new-beta-feedback.sh
```

批量创建试用账号（写入数据库并更新 participants，账号凭据落到 `.secrets/`）：

```bash
RELEASE_TAG=beta-xxxx WAVE=wave2 COUNT=10 APPLY=1 POSTGRES_MODE=docker POSTGRES_PASSWORD=xxxx scripts/provision-beta-users.sh
```

更新反馈状态（修复闭环）：

```bash
RELEASE_TAG=beta-xxxx WAVE=wave1 FEEDBACK_ID=BF-20260219-001 STATUS=已修复 OWNER=dev-a LINKED_TASK=fix/commit-409 node scripts/update-beta-feedback.mjs
```

汇总反馈并执行放量门禁：

```bash
RELEASE_TAG=beta-xxxx WAVE=wave1 scripts/check-wave-gate.sh
```

记录并推进波次决策（通过后自动生成下一波就绪文件）：

```bash
RELEASE_TAG=beta-xxxx WAVE=wave1 MIN_FEEDBACK_COUNT=3 MIN_UNIQUE_REPORTERS=3 scripts/advance-beta-wave.sh
```

生成某一波的对外投放说明（安装包 + 校验值 + API 地址 + 运维清单）：

```bash
RELEASE_TAG=beta-xxxx WAVE=wave2 SYNC_API_BASE_URL=http://47.122.112.210:3000/api/v1 scripts/prepare-wave-rollout.sh
```

查看发布手册与反馈模板：
- `docs/Beta发布手册.md`
- `docs/灰度反馈模板.md`
