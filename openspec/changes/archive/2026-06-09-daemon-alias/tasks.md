## 1. 数据库层（relay）

- [x] 1.1 `relay/src/db.ts` — initDB 新增 migration：`ALTER TABLE daemons ADD COLUMN IF NOT EXISTS alias VARCHAR(64)`
- [x] 1.2 `relay/src/db.ts` — 新增 `upsertDaemonAlias(pool, userId, daemonId, alias)` 函数（alias 为 null/空时设为 NULL）
- [x] 1.3 `relay/src/db.ts` — 修改 `upsertDaemon` 返回值，包含 alias 字段

## 2. Relay API

- [x] 2.1 `relay/src/server.ts` — 新增 `PUT /api/daemons/:daemonId/alias` 端点，验证 user_id 归属，调用 `upsertDaemonAlias`
- [x] 2.2 `relay/src/server.ts` — 端点返回 `{ success: true, alias: "..." }` 或错误码 403/404

## 3. WebSocket 同步

- [x] 3.1 `relay/src/router.ts` — `daemon_status` 广播 payload 中注入 `alias` 字段
- [x] 3.2 `relay/src/db.ts` — `listSessionsByUser` 等查询关联返回 daemon alias

## 4. iOS 模型层

- [x] 4.1 `Daemon.swift` — struct 新增 `alias: String?` 字段，更新 `from(event:)` 解析
- [x] 4.2 `KeychainStorage.swift` — 新增 `daemonAliases` 本地缓存（可选优化）

## 5. iOS DaemonCard UI

- [x] 5.1 `DaemonListView.swift` — DaemonCard 新增 `@State` 编辑状态：`isEditing`、`editText`
- [x] 5.2 DaemonCard card-top 行：编辑按钮（✏️）、别名 badge、"恢复默认"按钮
- [x] 5.3 DaemonCard rename-row：内联输入框 + 确认（✓）/ 取消（✗）按钮
- [x] 5.4 DaemonCard 显示逻辑：有别名显示别名 + badge，无别名显示 hostname

## 6. iOS API 集成

- [x] 6.1 `APIClient.swift` — 新增 `setDaemonAlias(daemonId:alias:)` 方法
- [x] 6.2 `DaemonListViewModel.swift` — 新增 `setAlias(daemonId:alias:)` 方法，乐观更新 + API 调用
- [x] 6.3 DaemonListViewModel 排序逻辑改用 `alias ?? hostname`

## 7. 构建验证

- [x] 7.1 重新构建 relay Docker 镜像，验证 migration 执行
- [x] 7.2 Xcode 构建验证，无编译错误
