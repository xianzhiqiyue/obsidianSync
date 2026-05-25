---
title: AITodo 接入服务端文件 API 设计
type: api-design
status: active
owner: TBD
created: 2026-04-15
updated: 2026-04-15
related_docs:
  - ../SOP.md
  - API设计.md
  - 需求文档.md
  - 模块设计.md
  - 开发计划.md
  - ../../AITodo/SOP.md
  - ../../AITodo/docs/obsidian-sync集成需求文档.md
tags:
  - obsidian-sync
  - aitodo
  - server-file-api
  - api-design
---

# AITodo 接入服务端文件 API 设计

## 1. 背景

当前同步协议面向 Obsidian 插件客户端，写入流程为 `sync/prepare -> 上传对象 -> sync/commit -> sync/pull`。该流程适合本地文件同步，但 AITodo 这类服务端系统更需要按 Vault path 一次性写入 Markdown，并由服务端完成对象存储、元数据事务、checkpoint 推进和绑定信息返回。

## 2. 设计目标

1. 支持外部系统按 path 读取、写入、删除 Vault 文件。
2. 写入后现有 Obsidian 插件仍能通过 `sync/pull` 拉取变更。
3. 写入响应返回 `fileId/path/version/contentHash/checkpoint/op`。
4. 支持幂等，避免重试重复创建文件。
5. 保持 `/api/v1` 兼容性：新增接口，不破坏现有插件同步接口。

## 3. 非目标

- 不允许外部系统直接写 PostgreSQL 或 MinIO/S3。
- 不在文件 API 中引入 AITodo 专属业务字段。
- 不绕过 `change_events` 和 `vault_sync_state`。
- 不在本期实现双向编辑冲突自动合并。

## 4. 通用约定

- Base URL：`https://sync.example.com/api/v1`
- 认证：`Authorization: Bearer <access_token>`
- 内容类型：`application/json`
- `by-path/{path}` 中的 `path` 必须 URL encode。
- path 不允许为空、以 `/` 开头、包含 `..`、包含反斜杠，长度不超过 4096。
- `contentHash` 格式：`sha256:<64位小写十六进制>`。
- `idempotencyKey`：UUID 字符串。

## 5. 数据结构

### 5.1 FileMetadata

```json
{
  "fileId": "550e8400-e29b-41d4-a716-446655440001",
  "path": "AI-Todo/tasks/550e8400-e29b-41d4-a716-446655440000.md",
  "version": 3,
  "contentHash": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "deleted": false,
  "createdAt": "2026-04-15T06:30:00.000Z",
  "updatedAt": "2026-04-15T06:35:00.000Z"
}
```

### 5.2 FileWriteResponse

```json
{
  "fileId": "550e8400-e29b-41d4-a716-446655440001",
  "path": "AI-Todo/tasks/550e8400-e29b-41d4-a716-446655440000.md",
  "version": 3,
  "contentHash": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "checkpoint": "cp_1025",
  "changesetId": "550e8400-e29b-41d4-a716-446655440003",
  "op": "update"
}
```

`op` 取值：`create`、`update`、`delete`。

## 6. 当前文件快照 API

```http
GET /vaults/{vaultId}/files?prefix=AI-Todo/&limit=200&cursor=<cursor>&includeDeleted=false
```

响应：

```json
{
  "checkpoint": "cp_1025",
  "items": [
    {
      "fileId": "550e8400-e29b-41d4-a716-446655440001",
      "path": "AI-Todo/tasks/550e8400-e29b-41d4-a716-446655440000.md",
      "version": 3,
      "contentHash": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "deleted": false,
      "createdAt": "2026-04-15T06:30:00.000Z",
      "updatedAt": "2026-04-15T06:35:00.000Z"
    }
  ],
  "nextCursor": null
}
```

实现建议：

- 从 `file_entries` 查询当前文件。
- 最新内容 hash 通过 `file_versions` 最新版本获取。
- 默认过滤 `deleted_at IS NULL`。
- `checkpoint` 取 `vault_sync_state.latest_checkpoint`。

## 7. 按 path 读取文件 API

```http
GET /vaults/{vaultId}/files/by-path/{path}?includeDownloadUrl=true
```

响应：

```json
{
  "file": {
    "fileId": "550e8400-e29b-41d4-a716-446655440001",
    "path": "AI-Todo/tasks/550e8400-e29b-41d4-a716-446655440000.md",
    "version": 3,
    "contentHash": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "deleted": false,
    "createdAt": "2026-04-15T06:30:00.000Z",
    "updatedAt": "2026-04-15T06:35:00.000Z"
  },
  "downloadUrl": "https://obj.example.com/presigned-download-1"
}
```

错误：

- `404 FILE_NOT_FOUND`：path 不存在或已删除。

## 8. 按 path 写文件 API

```http
PUT /vaults/{vaultId}/files/by-path/{path}
```

请求：

```json
{
  "contentBase64": "LS0tCnNvdXJjZTogYWktdG9kbwotLS0KCiMgVGFzawo=",
  "baseVersion": 2,
  "idempotencyKey": "4dbcbf6d-2048-4d8e-a4c6-fdb2f6cfc111",
  "conflictStrategy": "fail"
}
```

响应：

```json
{
  "fileId": "550e8400-e29b-41d4-a716-446655440001",
  "path": "AI-Todo/tasks/550e8400-e29b-41d4-a716-446655440000.md",
  "version": 3,
  "contentHash": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "checkpoint": "cp_1025",
  "changesetId": "550e8400-e29b-41d4-a716-446655440003",
  "op": "update"
}
```

语义：

1. path 不存在：创建文件，`op=create`，版本为 1。
2. path 存在：更新文件，`op=update`，版本递增。
3. 已存在且 `baseVersion` 不等于当前 `head_version`：返回 `409 VERSION_CONFLICT`。
4. 内容 hash 与最新版本一致：可返回当前元数据，不推进 checkpoint。

## 9. 按 path 删除文件 API

```http
DELETE /vaults/{vaultId}/files/by-path/{path}
```

请求：

```json
{
  "baseVersion": 3,
  "idempotencyKey": "4dbcbf6d-2048-4d8e-a4c6-fdb2f6cfc222"
}
```

响应：

```json
{
  "fileId": "550e8400-e29b-41d4-a716-446655440001",
  "path": "AI-Todo/tasks/550e8400-e29b-41d4-a716-446655440000.md",
  "version": 4,
  "contentHash": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "checkpoint": "cp_1026",
  "changesetId": "550e8400-e29b-41d4-a716-446655440004",
  "op": "delete"
}
```

删除必须更新 `file_entries.deleted_at`、写入 `tombstones`、写入 `file_versions`、写入 `change_events` 并推进 checkpoint。

## 10. 事务与一致性要求

写入或删除文件必须在数据库事务中完成：

1. 锁定 `vault_sync_state` 当前行。
2. 根据 path 查询并锁定 `file_entries`。
3. 写入或确认 `object_blobs`。
4. 写入 `changesets`。
5. 写入 / 更新 `file_entries`。
6. 写入 `file_versions`。
7. 写入 `change_events`。
8. 更新 `vault_sync_state.latest_checkpoint`。
9. 写入 `idempotency_keys`。

对象存储要求：

1. 服务端根据 `contentBase64` 计算 `contentHash`。
2. 若对象不存在，服务端直接写入 S3/MinIO。
3. 对象写入成功后才能提交元数据事务。

## 11. 幂等策略

1. `idempotency_keys` 继续以 `(vault_id, idempotency_key)` 唯一。
2. 重放同一 key 返回首次响应。
3. 同一 key 的请求 body 与首次请求不一致时，建议返回 `409 IDEMPOTENCY_KEY_REUSED`。
4. 写入响应 JSON 存入 `idempotency_keys.response_json`。

## 12. 错误码

| HTTP | code | 含义 | 客户端动作 |
| --- | --- | --- | --- |
| 400 | `INVALID_REQUEST` | 请求体或 path 不合法 | 修正请求 |
| 404 | `FILE_NOT_FOUND` | 文件不存在 | 按需 create 或忽略 |
| 409 | `VERSION_CONFLICT` | baseVersion 不匹配 | 拉取最新元数据后处理冲突 |
| 409 | `PATH_CONFLICT` | path 被其他文件占用 | 换 path 或人工处理 |
| 409 | `IDEMPOTENCY_KEY_REUSED` | 幂等键复用但请求不一致 | 使用新 key 或检查重试逻辑 |
| 413 | `FILE_TOO_LARGE` | 文件超过限制 | 拆分或拒绝 |

## 13. AITodo 推荐调用方式

AITodo 使用固定设备名：

```json
{
  "deviceName": "AI-TODO-SERVER",
  "platform": "linux",
  "pluginVersion": "aitodo-0.1.0"
}
```

首次绑定：

1. `POST /auth/login`
2. `GET /vaults`
3. `GET /vaults/{vaultId}/files?prefix=AI-Todo/`
4. 保存远端现有文件快照与本地绑定。

写任务文件：

1. AITodo 渲染 Markdown。
2. base64 编码内容。
3. 调用 `PUT /files/by-path/AI-Todo%2Ftasks%2F<task_id>.md`。
4. 保存响应中的 `fileId/version/contentHash/checkpoint`。

## 14. 测试策略

必须补充 API 测试：

1. create by path 会写入 `file_entries`、`file_versions`、`change_events` 并推进 checkpoint。
2. update by path 会递增 version。
3. delete by path 会写 tombstone 和 delete 事件。
4. prefix snapshot 只返回匹配前缀文件。
5. version conflict 返回 409。
6. idempotency replay 返回同一响应。
7. 插件端从写入前 checkpoint `pull` 能看到文件 API 产生的变更。

## 15. 实现顺序

1. 增加 path 校验和文件 metadata 查询 helper。
2. 增加对象存储 `putObjectBytes` 能力。
3. 抽取共享文件写入事务。
4. 实现 `GET /files` 和 `GET /files/by-path`。
5. 实现 `PUT /files/by-path`。
6. 实现 `DELETE /files/by-path`。
7. 补测试和文档。
