---
title: AITodo Obsidian-native 协作边界
type: integration-boundary
status: active
owner: TBD
created: 2026-04-15
updated: 2026-04-15
related_docs:
  - ../SOP.md
  - AITodo接入服务端文件API设计.md
  - ../../AITodo/docs/obsidian-native模式架构设计.md
tags:
  - obsidian-sync
  - aitodo
  - obsidian-native
  - boundary
---

# AITodo Obsidian-native 协作边界

## 1. 结论

`obsidianSync` 不承载 AITodo 业务逻辑。即使 AITodo 进入 Obsidian-native 模式，`obsidianSync` 的职责仍然是：

- Vault 文件存储
- 文件版本
- 对象存储
- checkpoint
- change events
- 多端同步

AITodo 的职责是：

- Markdown schema
- 任务解析
- 任务查询
- AI 规划
- MCP / REST 网关
- 缓存索引
- 通知与后台任务

## 2. obsidianSync 提供的能力

必须稳定提供：

```http
GET /vaults/{vaultId}/files
GET /vaults/{vaultId}/files/by-path/{path}
PUT /vaults/{vaultId}/files/by-path/{path}
DELETE /vaults/{vaultId}/files/by-path/{path}
GET /vaults/{vaultId}/sync/pull
POST /vaults/{vaultId}/objects/download-urls
```

这些能力足以让 AITodo：

1. 写入任务 Markdown。
2. 读取当前文件快照。
3. 下载变更文件。
4. 根据 checkpoint 做增量索引。

## 3. obsidianSync 不做的事

不做：

- 理解 `aitodo_id`。
- 解析任务 front matter。
- 计算 ready-to-start。
- 维护任务依赖业务语义。
- 生成今日建议。
- 发送 AITodo 通知。
- 帮 AITodo 做 Markdown 合并。

## 4. 数据一致性边界

AITodo 写文件时，`obsidianSync` 保证：

- contentHash 与对象内容一致。
- file version 递增。
- change_events 可被插件和 AITodo pull 到。
- checkpoint 单调推进。
- delete 写 tombstone。
- idempotency key 重放返回首次响应。

AITodo 自己保证：

- Markdown schema 合法。
- `AI-Todo/` 路径约束。
- 冲突后不静默覆盖。
- 解析失败有降级状态。

## 5. Obsidian-native 模式对 obsidianSync 的后续要求

后续可能需要增强：

1. 下载地址批量接口继续保持稳定。
2. `GET /files` 支持按 `updatedAt` 或 checkpoint 辅助分页。
3. idempotency request hash 校验，识别同 key 不同 body。
4. 可选提供文件内容直读接口，简化服务端索引器。

这些增强仍然是文件能力，不进入 AITodo 业务层。
