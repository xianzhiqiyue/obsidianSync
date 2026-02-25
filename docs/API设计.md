# Obsidian 自建同步系统 API 设计（v1）

## 1. 约定
- Base URL：`https://sync.example.com/api/v1`
- 认证：`Authorization: Bearer <access_token>`
- 内容类型：`application/json`
- 幂等头：`Idempotency-Key: <uuid>`（对写接口必填）
- 时间格式：`ISO 8601 UTC`

## 2. 认证与设备

### 2.1 设备注册
- `POST /auth/device/register`

请求：
```json
{
  "deviceName": "Nova-MacBook",
  "platform": "macos",
  "pluginVersion": "0.1.0"
}
```

响应：
```json
{
  "deviceId": "dev_123",
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
  "vaultId": "vault_123",
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
  "checkpoint": "cp_0001024",
  "serverTime": "2026-02-18T12:00:00Z"
}
```

### 4.2 预提交本地变更
- `POST /vaults/{vaultId}/sync/prepare`

请求：
```json
{
  "deviceId": "dev_123",
  "baseCheckpoint": "cp_0001024",
  "changes": [
    {
      "op": "update",
      "fileId": "file_1",
      "path": "notes/a.md",
      "baseVersion": 3,
      "contentHash": "sha256:abc"
    }
  ]
}
```

响应：
```json
{
  "prepareId": "prep_123",
  "uploadTargets": [
    {
      "contentHash": "sha256:abc",
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
  "prepareId": "prep_123",
  "deviceId": "dev_123",
  "idempotencyKey": "4dbcbf6d-2048-4d8e-a4c6-fdb2f6cfc111"
}
```

响应：
```json
{
  "changesetId": "chg_456",
  "newCheckpoint": "cp_0001025",
  "appliedChanges": 1
}
```

### 4.4 拉取远端增量
- `GET /vaults/{vaultId}/sync/pull?fromCheckpoint=cp_0001024&limit=200`

响应：
```json
{
  "fromCheckpoint": "cp_0001024",
  "toCheckpoint": "cp_0001025",
  "changes": [
    {
      "op": "update",
      "fileId": "file_1",
      "path": "notes/a.md",
      "version": 4,
      "contentHash": "sha256:abc"
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
  "contentHashes": ["sha256:abc", "sha256:def"]
}
```

响应：
```json
{
  "items": [
    {
      "contentHash": "sha256:abc",
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

## 6. 错误码

| HTTP | code | 含义 | 客户端动作 |
| --- | --- | --- | --- |
| 400 | `INVALID_REQUEST` | 参数错误 | 修正参数，不重试 |
| 401 | `TOKEN_EXPIRED` | token 过期 | 刷新 token 后重试 |
| 403 | `DEVICE_REVOKED` | 设备被撤销 | 中止同步并提示重新登录 |
| 404 | `VAULT_NOT_FOUND` | Vault 不存在或无权限 | 中止并提示 |
| 409 | `VERSION_CONFLICT` | base_version 不匹配 | 走冲突流程 |
| 409 | `CHECKPOINT_MISMATCH` | checkpoint 过旧或不连续 | 重拉状态并重试 |
| 429 | `RATE_LIMITED` | 请求过快 | 指数退避重试 |
| 500 | `INTERNAL_ERROR` | 服务端异常 | 可重试并上报日志 |

## 7. 幂等与一致性
- 写接口必须带 `Idempotency-Key`。
- 相同 key 的重复请求返回首次提交结果。
- `prepare` 有有效期（建议 10 分钟），超时后必须重新 prepare。

## 8. 版本策略
- API 采用路径版本：`/api/v1`。
- 兼容性原则：
  - 可新增字段，不删除已发布字段。
  - 破坏性变更必须进入 `v2`。

## 9. 系统与观测接口

### 9.1 健康检查
- `GET /health`
- `GET /ready`

### 9.2 指标导出
- `GET /metrics`
- 格式：Prometheus text format (`text/plain; version=0.0.4`)
