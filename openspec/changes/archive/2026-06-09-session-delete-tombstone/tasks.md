## 1. 数据库层

- [x] 1.1 Relay `db.ts`：创建 `deleted_sessions` 表（在 `initDB` 中）
- [x] 1.2 Relay `db.ts`：新增 `deleteSession()` 函数（删除 events + sessions，插入墓碑）
- [x] 1.3 Relay `db.ts`：新增 `isSessionDeleted()` 函数（查询墓碑表）

## 2. Relay 路由层

- [x] 2.1 Relay `router.ts`：新增 `session_delete` 消息处理（删 DB + 写墓碑 + 广播 session_deleted）
- [x] 2.2 Relay `router.ts`：`session_discovered` handler 中增加墓碑检查（存在则跳过）
- [x] 2.3 Relay `router.ts`：`session_deleted` 广播给同 userId 所有客户端

## 3. Watcher 重构

- [x] 3.1 `watcher.go`：将 `knownFiles map[string]DiscoveredSession` 改为 `knownSessions map[string]DiscoveredSession`（sessionId 为 key）
- [x] 3.2 `watcher.go`：新增 `fileToSession map[string]string` 辅助索引（filepath → sessionId）
- [x] 3.3 `watcher.go`：`handleNewFile` — sessionId 已存在时更新 filepath/PID 并发 "changed"，否则发 "discovered"
- [x] 3.4 `watcher.go`：`handleChangedFile` — 改用 sessionId 查询 knownSessions
- [x] 3.5 `watcher.go`：`handleRemovedFile` — 通过 fileToSession 找 sessionId，检查是否还有其他文件，无才发 "removed"
- [x] 3.6 `watcher.go`：`scanExisting` — 按 sessionId 去重，同 ID 多文件保留最新

## 4. iOS 端

- [x] 4.1 `WebSocketEvent.swift`：新增 `sessionDeleted` 事件类型
- [x] 4.2 `SessionListViewModel.swift`：新增 `deleteSession()` 方法（发送 session_delete + 乐观移除本地数据）
- [x] 4.3 `SessionListViewModel.swift`：`handleEvent` 中处理 `sessionDeleted` 事件（从列表移除）
- [x] 4.4 `SessionListView.swift`：新增 `SwipeToDelete` 组件（左滑露出删除按钮）
- [x] 4.5 `SessionListView.swift`：`sessionList` 中对终态 session 使用 `SwipeToDelete` 包装

## 5. 验证

- [ ] 5.1 验证：删除 exited session 后，DB 中 session/events 记录已清除，墓碑已创建
- [ ] 5.2 验证：Daemon 重启后，被删除的 exited session 不会复活
- [ ] 5.3 验证：删除后 `claude --continue`，session 重新出现在 App 中
- [ ] 5.4 验证：`--continue` 不会产生重复 session（Watcher 以 sessionId 去重）
- [ ] 5.5 验证：多设备同步（一台删除，另一台同步移除）
