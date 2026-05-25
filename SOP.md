---
title: Obsidian Sync SOP
type: sop
status: active
owner: TBD
created: 2026-04-15
updated: 2026-04-15
related_docs:
  - README.md
  - docs/需求文档.md
  - docs/架构设计.md
  - docs/模块设计.md
  - docs/API设计.md
  - docs/开发计划.md
  - docs/测试与验收计划.md
  - docs/部署与运维手册.md
  - docs/Beta发布手册.md
tags:
  - sop
  - obsidian-sync
  - development-process
  - documentation
  - sync-api
  - operations
  - ai-todo-integration
---

# Obsidian Sync SOP

> 统一 SOP 文件。本文参考 `oneID/SOP.md` 的“根目录唯一 SOP + 文档先行 + 开发验证闭环”方式，结合当前 Obsidian 自建同步服务的 Fastify / PostgreSQL / S3(MinIO) / Obsidian 插件形态制定。
> 适用范围：需求、调研、API 设计、同步协议、服务端开发、插件开发、测试、备份恢复、部署发布，以及后续服务端对服务端接入（例如 AITodo）。

---

## A. 开发与文档治理 SOP

> 状态：生效
> 生效日期：2026-04-15
> 核心原则：同步协议先设计，数据一致性先验证，服务端和插件端一起闭环。

---

## 1. 当前项目结构结论

`obsidianSync` 是自建 Obsidian 同步系统，正式事实入口以根目录 `README.md`、本 SOP 和 `docs/` 下的需求 / 架构 / API / 运维文档为主。

```text
obsidianSync/
├── apps/
│   ├── sync-api/          # Fastify 同步服务端
│   │   ├── migrations/    # PostgreSQL schema 迁移
│   │   └── src/           # API、同步事务、对象存储、鉴权
│   └── obsidian-plugin/   # Obsidian 客户端插件
├── packages/shared/       # 共享类型 / 常量
├── infra/                 # Docker Compose、监控与生产环境样例
├── scripts/               # 冒烟、回归、备份恢复、部署、压测脚本
├── docs/                  # 正式文档
├── releases/              # Beta / 发布执行材料
├── README.md              # 仓库总入口
└── SOP.md                 # 统一 SOP
```

当前文档主线：

- 需求：`docs/需求文档.md`
- 架构：`docs/架构设计.md`
- 模块：`docs/模块设计.md`
- API：`docs/API设计.md`
- 计划与进度：`docs/开发计划.md`、`docs/开发进度.md`
- 测试：`docs/测试与验收计划.md`
- 运维：`docs/部署与运维手册.md`
- 发布：`docs/Beta发布手册.md`
- 质量：`docs/代码评审报告.md`

后续如新增 `docs/requirements/`、`docs/plans/`、`docs/tests/`、`docs/summary/` 等细分目录，必须先更新 `README.md`、本 SOP 和相关索引，避免同一事实源分散。

## 2. 总原则

1. **中文优先**：文档正文、说明性注释、任务总结默认使用中文；API 字段、协议名、错误码、库名保留原文。
2. **协议先行**：任何同步 API、文件写入 API、冲突策略和 checkpoint 语义变化，必须先更新 `docs/API设计.md` 与相关设计文档。
3. **一致性优先**：文件内容、`contentHash`、`file_versions`、`change_events`、`vault_sync_state` 必须保持一致。
4. **事务边界清晰**：PostgreSQL 元数据变更必须在事务内完成；对象存储写入必须先于 metadata commit 或有明确补偿策略。
5. **兼容优先**：已发布 `/api/v1` 字段不随意删除或改语义；破坏性变更必须进入新版本或提供迁移策略。
6. **不绕过同步协议**：插件、脚本、外部系统默认通过 API 写入，不直接改数据库和对象桶。
7. **验证后声明完成**：完成说明必须包含构建、测试、回归、冒烟或手工验证证据。
8. **安全默认收敛**：生产凭据不入库、不入文档、不入日志；生产端口暴露遵循最小暴露策略。

---

## 3. 任务类型与必备材料

| 任务类型 | 触发场景 | 必备材料 | 完成标准 |
| --- | --- | --- | --- |
| 需求 / 范围 | 新同步能力、外部系统接入、移动端体验变化 | 更新 `docs/需求文档.md` 或新增主题文档 | 背景、范围、不做项、验收标准明确 |
| API / 协议设计 | 新接口、字段、错误码、checkpoint 或冲突策略变化 | 更新 `docs/API设计.md`、必要时更新模块 / 架构文档 | 请求、响应、错误、幂等、兼容策略明确 |
| 服务端开发 | Fastify 路由、同步事务、对象存储、鉴权、迁移 | 关联 API / 模块设计和测试计划 | typecheck、测试、回归脚本通过 |
| 插件开发 | 本地扫描、应用远端变更、冲突 UI、设置页 | 关联模块设计和插件测试 | 插件测试和必要手工验证通过 |
| 数据迁移 | 新表、字段、索引、约束 | migration + 回滚/兼容说明 | `npm run migrate` 和相关测试通过 |
| 运维 / 发布 | 部署、备份恢复、监控、压测、Beta | 更新运维 / 发布文档 | 健康检查、ready、备份恢复或回归证据完整 |
| 外部集成 | AITodo 等系统写入 Vault 文件 | 服务端 API 设计 + 凭据 / 权限 / 幂等 / 冲突策略 | 外部系统可写入文件，并由插件同步到本地 |

---

## 4. 标准开发流程

### 4.1 Step 0：任务分流

收到任务后先判断类型：

1. **只调研 / 只设计**：先补 `docs/`，不改代码。
2. **同步协议变化**：先改 API 文档和测试预期，再改实现。
3. **服务端写入能力变化**：先确认对象存储、元数据事务和 checkpoint 推进策略。
4. **插件行为变化**：先确认本地状态、失败重试和冲突体验。
5. **外部系统接入**：先确认它是“同步客户端”还是“服务端文件写入者”，不要让外部系统直写数据库。

### 4.2 Step 1：需求和 API 输入

需求 / API 文档至少包含：

1. 背景与目标
2. 本期范围和明确不做
3. API 路径、方法、认证、请求、响应
4. 错误码和客户端动作
5. 幂等语义
6. checkpoint / version / conflict 语义
7. 对象存储读写方式
8. 权限和审计边界
9. 验收标准

涉及 AITodo 等服务端系统写入 Vault 文件时，必须额外写清：

- 写入方身份、设备名、权限边界和 token 管理。
- 文件路径前缀，例如 `AI-Todo/`。
- 按 path 写文件时如何判断 create / update / delete。
- 是否允许覆盖用户本地编辑。
- 冲突返回格式和重试策略。
- 是否需要返回 `fileId/version/contentHash` 供写入方持久化。

### 4.3 Step 2：计划拆解

开发前计划至少包含：

1. 关联需求 / API 文档
2. 服务端、插件端、脚本、文档影响范围
3. migration 或兼容性影响
4. 测试策略：单元、API 回归、冒烟、手工插件验证
5. 风险与不做项

小修可不新增计划文件，但最终说明必须写清验证结果。

### 4.4 Step 3：实现

服务端实现规则：

1. 优先复用 `apps/sync-api/src/routes/sync.ts` 现有同步事务逻辑。
2. 新写入接口必须维护：
   - `object_blobs`
   - `file_entries`
   - `file_versions`
   - `changesets`
   - `change_events`
   - `vault_sync_state`
   - `idempotency_keys`
3. 新内容对象必须校验 `sha256:<64 lowercase hex>`。
4. 新接口必须校验 vault ownership。
5. commit / 文件写入必须支持幂等，避免重试重复创建文件。
6. 错误信息在 production 不泄露内部堆栈、SQL、密钥或对象 URL。

插件实现规则：

1. 本地状态变更必须通过 `LocalStateStore`。
2. 远端变更应用必须保持 `fileId/path/version/contentHash` 索引一致。
3. 写本地文件前处理路径冲突和父目录创建。
4. 弱网、重复 pull、checkpoint 回退和冲突都要有可恢复路径。

### 4.5 Step 4：测试与验证

默认验证命令：

```bash
npm run typecheck
npm test
```

服务端 API 相关任务还应按需运行：

```bash
npm run migrate
scripts/smoke-api.sh
scripts/regression-sync-api.sh
```

发布前检查：

```bash
scripts/pre-beta-check.sh
```

备份恢复或数据一致性任务应按需运行：

```bash
scripts/drill-backup-restore.sh
```

如果无法运行某项验证，最终说明必须写明原因、风险和替代验证。

### 4.6 Step 5：总结与归档

任务完成后，最终说明至少包含：

1. 修改了哪些文件
2. API / 数据模型 / 同步语义变化
3. 执行了哪些验证
4. 未覆盖风险
5. 后续建议

发布、Beta、恢复演练或重大主题完成后，应在 `releases/` 或 `docs/` 中留下执行记录。

---

## B. 本地服务与发布语义 SOP

## 5. 本地环境变量

服务端本地环境：

```bash
cp apps/sync-api/.env.example apps/sync-api/.env
```

生产基础设施环境：

```bash
cp infra/.env.prod.example infra/.env.prod
```

规则：

1. `.env`、`.env.prod` 是本机 / 部署私有配置，禁止提交真实密钥。
2. `.env.example` 和 `.env.prod.example` 只保留模板、默认开发值和变量说明。
3. 新增变量必须同步更新样例文件、`README.md` 和运维文档。
4. 生产环境端口暴露默认最小化：
   - PostgreSQL 绑定 `127.0.0.1`
   - MinIO Console 绑定 `127.0.0.1`
   - MinIO API 按需求开放

## 6. 本地启动语义

安装依赖：

```bash
npm install
```

启动基础设施：

```bash
docker compose -f infra/docker-compose.yml up -d
```

迁移：

```bash
npm run migrate
```

启动 API：

```bash
npm run dev:api
```

插件开发：

```bash
npm run dev:plugin
```

语义边界：

- “本地启动 / 重启”只影响本机服务，不等同发布。
- “迁移”必须说明目标数据库和是否兼容旧版本服务。
- “发布 / 上线 / 部署到服务器”必须有验证记录、目标环境、回滚方式和健康检查。
- “备份恢复”包含破坏性风险，必须显式声明目标库 / 目标桶，禁止误操作生产数据。

---

## C. AITodo 接入专项规矩

AITodo 后续需要把任务数据保存到 Obsidian 服务器，并通过本同步服务同步到本地 Obsidian。该方向采用长期路线：先在 `obsidianSync` 增加服务端对服务端友好的文件 API，再由 AITodo 调用。

### 7. 集成边界

1. `obsidianSync` 是 Vault 文件同步事实源，不承载 AITodo 的业务关系数据库语义。
2. AITodo 不直接写 `obsidianSync` PostgreSQL 或 MinIO/S3；必须通过 API。
3. AITodo 写入的文件统一放在 `AI-Todo/` 前缀下。
4. 新 API 必须返回足够信息，让 AITodo 保存 `fileId/path/version/contentHash` 绑定。
5. 新 API 必须保持与现有插件 pull/apply 流程兼容：写入后本地 Obsidian 插件应能按 checkpoint 拉到变更。

### 8. 推荐新增 API 能力

优先补齐以下长期能力：

1. **当前文件快照**

```http
GET /api/v1/vaults/{vaultId}/files?prefix=AI-Todo/
```

用于外部系统读取当前 Vault 文件索引，避免从 `checkpoint=0` 重放全部事件。

2. **按 path 读文件**

```http
GET /api/v1/vaults/{vaultId}/files/by-path/{path}
```

返回文件元数据和可选内容下载信息。

3. **按 path 写文件**

```http
PUT /api/v1/vaults/{vaultId}/files/by-path/{path}
```

请求支持内容、`baseVersion`、`idempotencyKey` 和冲突策略；服务端内部复用同步事务。

4. **按 path 删除文件**

```http
DELETE /api/v1/vaults/{vaultId}/files/by-path/{path}
```

必须写 tombstone、`change_events` 并推进 checkpoint。

### 9. 文件写入事务要求

按 path 写入 API 必须做到：

1. 根据 path 判断 create / update。
2. 校验 baseVersion，冲突时返回明确错误。
3. 将内容写入对象存储并校验 hash。
4. 在数据库事务内写入元数据、版本、事件和 checkpoint。
5. 使用 idempotency key 防止重复写。
6. 响应返回：

```json
{
  "fileId": "...",
  "path": "AI-Todo/tasks/<task_id>.md",
  "version": 3,
  "contentHash": "sha256:...",
  "checkpoint": "cp_1025",
  "op": "create"
}
```

### 10. 验收标准

AITodo 接入能力在 `obsidianSync` 侧完成前必须证明：

1. AITodo 可通过 API 写入 `AI-Todo/tasks/*.md`。
2. 本地 Obsidian 插件可以同步看到该文件。
3. 重复请求不会重复创建文件。
4. 更新文件会递增 version 并产生 pull 可见的 `change_events`。
5. 删除文件会产生 tombstone 和 delete 事件。
6. 文件快照 API 可按 prefix 返回当前活跃文件。
7. 权限、认证、日志和错误响应符合现有安全边界。

---

## D. 执行检查清单

### 需求 / API 设计前

- [ ] 是否先看 `README.md`、本 SOP、`docs/需求文档.md`、`docs/API设计.md` 和相关设计文档？
- [ ] 是否明确本期范围和不做项？
- [ ] 是否明确 checkpoint、version、contentHash、幂等和冲突语义？
- [ ] 是否确认插件端兼容性？

### 开发 / 交付前

- [ ] 是否有 API / 设计依据？
- [ ] 是否没有引入未批准的新依赖？
- [ ] 是否同步更新迁移、类型、服务端路由、插件调用和测试？
- [ ] 是否运行并记录适用验证命令？
- [ ] 是否说明未覆盖风险？

从本 SOP 生效后，后续所有 Obsidian Sync 需求、调研、API 设计、开发、测试、运维、发布和 AITodo 集成任务默认按本文执行。
