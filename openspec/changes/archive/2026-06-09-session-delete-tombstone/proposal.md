## Why

用户需要在 App 中清理已结束的 session 记录，保持列表整洁。当前没有删除功能，exited 状态的 session 会一直堆积在列表中。同时，Watcher 的发现逻辑以文件路径（PID）为 key，导致 `claude --continue` 产生重复 session 记录。

## What Changes

- 新增 session 删除功能：仅允许删除 `exited` 状态的 session，删除范围限于 Relay DB，不触碰 daemon/终端
- 新增 `deleted_sessions` 墓碑表：防止 Watcher 自动扫描复活已删除的 session
- 重构 Watcher 发现逻辑：从基于文件路径（PID）改为基于 session ID 去重，解决 `--continue` 产生重复 session 的问题
- 墓碑对 `discovered` 事件生效（拦截自动扫描），对 `changed` 事件不生效（允许用户 `--continue` 恢复）
- 删除操作广播给同 userId 的所有客户端，支持多设备同步

## Capabilities

### New Capabilities
- `session-delete`: App 端右滑删除 exited session，Relay 端删除 DB 数据并写入墓碑，广播 session_deleted 事件
- `watcher-session-id-tracking`: Watcher 从基于文件路径的发现逻辑改为基于 session ID 去重，正确处理 --continue 场景

### Modified Capabilities
<!-- 无现有 spec 需要修改 -->

## Impact

- `relay/src/db.ts`: 新增 `deleted_sessions` 表、`deleteSession()`、`isSessionDeleted()`
- `relay/src/router.ts`: 新增 `session_delete` 消息处理、`session_discovered` 墓碑检查、`session_deleted` 广播
- `internal/watcher/watcher.go`: 重构 `knownFiles` 为 `knownSessions`（session ID 为 key），新增 filepath→sessionId 辅助索引
- `ios/.../SessionListView.swift`: 新增 `SwipeToDelete` 组件
- `ios/.../SessionListViewModel.swift`: 新增 `deleteSession()` 方法
- `ios/.../WebSocketEvent.swift`: 新增 `sessionDeleted` 事件类型
