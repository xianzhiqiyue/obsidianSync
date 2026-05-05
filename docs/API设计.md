# Obsidian 自建同步系统 API 设计（v1）

## 1. 约定
- Base URL：`https://sync.example.com/api/v1`
- 认证：`Authorization: Bearer <access_token>`
- 内容类型：`application/json`
- 幂等键：`commit` 请求体中的 `idempotencyKey` 字段（UUID）。
- 时间格式：`ISO 8601 UTC`
- `contentHash` 必须使用 `sha256:<64位小写十六进制>` 格式，服务端会在 commit 前校验对象内容。

## 2. 认证与设备

### 2.1 登录并注册/更新设备
- `POST /auth/login`

请求：
```json
{
  "email": "admin@example.com",
  "password": "********",
  "deviceName": "Nova-MacBook",
  "platform": "macos",
  "pluginVersion": "0.1.0"
}
```

响应：
```json
{
  "deviceId": "550e8400-e29b-41d4-a716-446655440000",
  "accessToken": "xxx",
  "refreshToken": "xxx",
  "expiresIn": 3600
}
```

### 2.2 刷新 token
- `POST /auth/token/refresh`

### 2.3 撤销设备
- `POST /auth/device/revoke`

## 3. Vault 管理

### 3.1 查询 Vault 列表
- `GET /vaults`

### 3.2 创建 Vault
- `POST /vaults`

请求：
```json
{
  "name": "KnowledgeBase"
}
```

响应：
```json
{
  "vaultId": "550e8400-e29b-41d4-a716-446655440010",
  "name": "KnowledgeBase",
  "createdAt": "2026-02-18T12:00:00Z"
}
```

## 4. 同步接口

### 4.1 获取同步状态
- `GET /vaults/{vaultId}/sync/state`

响应：
```json
{
  "checkpoint": "cp_1024",
  "serverTime": "2026-02-18T12:00:00.000Z"
}
```

### 4.2 预提交本地变更
- `POST /vaults/{vaultId}/sync/prepare`

请求：
```json
{
  "baseCheckpoint": 1024,
  "changes": [
    {
      "op": "update",
      "fileId": "550e8400-e29b-41d4-a716-446655440001",
      "path": "notes/a.md",
      "baseVersion": 3,
      "contentHash": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    }
  ]
}
```

响应：
```json
{
  "prepareId": "550e8400-e29b-41d4-a716-446655440002",
  "uploadTargets": [
    {
      "contentHash": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "uploadUrl": "https://obj.example.com/presigned-xxx"
    }
  ],
  "conflicts": []
}
```

说明：
- 仅返回“服务端缺失对象”的上传地址。
- 若存在版本冲突，`conflicts` 返回冲突项，客户端不得继续 commit。

### 4.3 提交变更
- `POST /vaults/{vaultId}/sync/commit`

请求：
```json
{
  "prepareId": "550e8400-e29b-41d4-a716-446655440002",
  "idempotencyKey": "4dbcbf6d-2048-4d8e-a4c6-fdb2f6cfc111"
}
```

响应：
```json
{
  "changesetId": "550e8400-e29b-41d4-a716-446655440003",
  "newCheckpoint": "cp_1025",
  "appliedChanges": 1
}
```

### 4.4 拉取远端增量
- `GET /vaults/{vaultId}/sync/pull?fromCheckpoint=1024&limit=200`

响应：
```json
{
  "fromCheckpoint": "cp_1024",
  "toCheckpoint": "cp_1025",
  "changes": [
    {
      "op": "update",
      "fileId": "550e8400-e29b-41d4-a716-446655440001",
      "path": "notes/a.md",
      "version": 4,
      "contentHash": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    }
  ],
  "hasMore": false
}
```

### 4.5 获取下载地址
- `POST /vaults/{vaultId}/objects/download-urls`

请求：
```json
{
  "contentHashes": ["sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"]
}
```

响应：
```json
{
  "items": [
    {
      "contentHash": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "downloadUrl": "https://obj.example.com/presigned-download-1"
    }
  ]
}
```

## 5. 冲突与恢复接口

### 5.1 查询冲突记录
- `GET /vaults/{vaultId}/conflicts?limit=50`

### 5.2 恢复误删文件
- `POST /vaults/{vaultId}/recovery/restore`

请求：
```json
{
  "fileId": "file_1",
  "targetPath": "notes/a-restored.md"
}
```


## 6. 管理后台历史数据接口

管理后台接口用于服务端历史数据管理，必须经过服务端鉴权与 Vault 权限校验。接口前缀统一为 `/admin`，不得由前端直连数据库。

### 6.1 查询文件列表
- `GET /admin/vaults/{vaultId}/files?query=&status=active|deleted|all&limit=50&cursor=...`

响应：
```json
{
  "items": [
    {
      "fileId": "550e8400-e29b-41d4-a716-446655440001",
      "path": "notes/a.md",
      "headVersion": 4,
      "deleted": false,
      "deletedAt": null,
      "latestCheckpoint": "cp_1025",
      "updatedAt": "2026-05-05T10:00:00.000Z"
    }
  ],
  "nextCursor": null
}
```

### 6.2 查询文件详情与历史版本
- `GET /admin/vaults/{vaultId}/files/{fileId}`

响应包含：
- 当前文件状态。
- `file_versions` 历史版本。
- `tombstones` 删除墓碑。
- `change_events` 同步事件。
- 管理操作审计记录。

### 6.3 预览管理操作
- `POST /admin/vaults/{vaultId}/files/{fileId}/actions/preview`

请求：
```json
{
  "action": "restore",
  "version": 3,
  "targetPath": "notes/a-restored.md"
}
```

响应：
```json
{
  "previewId": "preview_123",
  "confirmToken": "one-time-token",
  "action": "restore",
  "fileId": "550e8400-e29b-41d4-a716-446655440001",
  "current": {
    "path": "notes/a.md",
    "headVersion": 4,
    "deleted": true
  },
  "target": {
    "version": 3,
    "contentHash": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "path": "notes/a-restored.md"
  },
  "pathConflict": false,
  "pathConflictFileId": null,
  "willCreateVersion": 5,
  "willCreateCheckpoint": "cp_1026",
  "retention": {
    "historyRetentionDays": 90,
    "policy": "历史版本与删除墓碑默认保留三个月"
  }
}
```

说明：
- `confirmToken` 有短有效期，只能用于同一操作参数。
- 路径冲突、对象缺失、版本不存在时必须在预览阶段暴露。

### 6.4 恢复误删文件
- `POST /admin/vaults/{vaultId}/files/{fileId}/restore`

请求：
```json
{
  "version": 3,
  "targetPath": "notes/a.md",
  "reason": "开发期间误删除，按历史版本恢复",
  "confirmToken": "one-time-token"
}
```

响应：
```json
{
  "operationId": "550e8400-e29b-41d4-a716-446655440090",
  "changesetId": "550e8400-e29b-41d4-a716-446655440091",
  "newVersion": 5,
  "newCheckpoint": "cp_1026"
}
```

### 6.5 指定历史版本为当前版本
- `POST /admin/vaults/{vaultId}/files/{fileId}/set-current-version`

请求：
```json
{
  "version": 2,
  "targetPath": "notes/a.md",
  "reason": "回滚到稳定版本",
  "confirmToken": "one-time-token"
}
```

语义：
- 创建一个新版本号，内容哈希等于目标历史版本。
- 插入管理来源的同步事件并推进 checkpoint。
- 客户端通过 `sync/pull` 收到后按当前版本更新本地文件。

### 6.6 软删除文件
- `POST /admin/vaults/{vaultId}/files/{fileId}/soft-delete`

请求：
```json
{
  "reason": "清理错误生成的文件",
  "confirmToken": "one-time-token"
}
```

语义：
- 设置 `file_entries.deleted_at`。
- 写入 `tombstones`。
- 插入删除同步事件。
- 推进 checkpoint。

### 6.7 查询管理操作历史
- `GET /admin/vaults/{vaultId}/operations?fileId=&limit=50&cursor=...`

响应展示操作人、操作原因、操作前后状态、关联 changeset 和 checkpoint。

### 6.8 管理事件客户端兼容
- 服务端可在 `sync/pull` 的 change item 中新增 `source`、`reason`、`adminOperationId` 字段。
- 旧客户端必须能忽略新增字段。
- 若新增 `restore`、`admin_set_current` op，旧客户端应按 `update` 语义兼容；若无法保证兼容，第一阶段使用 `update/delete` 表达管理操作。

## 7. 错误码

| HTTP | code | 含义 | 客户端动作 |
| --- | --- | --- | --- |
| 400 | `INVALID_REQUEST` | 参数错误 | 修正参数，不重试 |
| 401 | `TOKEN_EXPIRED` | token 过期 | 刷新 token 后重试 |
| 403 | `DEVICE_REVOKED` | 设备被撤销 | 中止同步并提示重新登录 |
| 404 | `VAULT_NOT_FOUND` | Vault 不存在或无权限 | 中止并提示 |
| 409 | `VERSION_CONFLICT` | base_version 不匹配 | 走冲突流程 |
| 409 | `CHECKPOINT_MISMATCH` | checkpoint 过旧或不连续 | 重拉状态并重试 |
| 429 | `RATE_LIMITED` | 请求过快 | 指数退避重试 |
| 409 | `ADMIN_PATH_CONFLICT` | 管理操作目标路径冲突 | 重新选择路径或取消操作 |
| 409 | `ADMIN_CONFIRM_REQUIRED` | 缺少有效预览确认 | 重新预览后确认 |
| 404 | `FILE_VERSION_NOT_FOUND` | 历史版本不存在或对象不可用 | 停止操作并提示 |
| 500 | `INTERNAL_ERROR` | 服务端异常 | 可重试并上报日志 |

## 8. 幂等与一致性
- 写接口必须带 `Idempotency-Key`。
- 相同 key 的重复请求返回首次提交结果。
- `prepare` 有有效期（建议 10 分钟），超时后必须重新 prepare。

## 9. 版本策略
- API 采用路径版本：`/api/v1`。
- 兼容性原则：
  - 可新增字段，不删除已发布字段。
  - 破坏性变更必须进入 `v2`。

## 10. 系统与观测接口

### 10.1 健康检查
- `GET /health`
- `GET /ready`

### 10.2 指标导出
- `GET /metrics`
- 格式：Prometheus text format (`text/plain; version=0.0.4`)
