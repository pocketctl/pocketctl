## Why

用户通常有多台开发机（如 MacBook、Dev Server、CI Runner），它们的主机名往往是系统默认的（如 `MacBook-Pro`、`ubuntu-vm-01`），难以区分。允许用户为主机设置自定义别名，可以提升主机列表的可读性和管理效率。设计稿 `screens-daemon-list.html` 已定义了内联重命名的完整交互。

## What Changes

- **数据库**：`daemons` 表新增 `alias` 列（可空 VARCHAR），按 `user_id` 隔离
- **Relay API**：新增 `PUT /api/daemons/:daemonId/alias` 端点，用于设置/清除别名
- **WebSocket**：`daemon_status` 事件和 session 列表数据中携带 `alias` 字段
- **iOS Daemon 模型**：`Daemon` struct 新增 `alias: String?` 字段
- **iOS DaemonCard**：实现设计稿的内联编辑 UI——编辑按钮、输入框、确认/取消、别名 badge、"恢复默认"按钮
- **iOS 存储**：`KeychainStorage` 新增 `daemonAliases` 用于本地缓存

## Capabilities

### New Capabilities
- `daemon-alias`: 主机自定义别名的完整生命周期——服务端存储、API 读写、WebSocket 同步、iOS 内联编辑 UI

### Modified Capabilities
- `relay-routing`: `daemon_status` 事件需携带 `alias` 字段；session 相关数据需返回 daemon alias

## Impact

- **relay/src/db.ts**：数据库 migration + 新增 `upsertDaemonAlias`、`getDaemonAlias` 方法
- **relay/src/server.ts**：新增 PUT API 端点
- **relay/src/router.ts**：daemon_status 和 session 数据注入 alias
- **ios/Pocketctl/Models/Daemon.swift**：新增 alias 字段
- **ios/Pocketctl/Views/DaemonListView.swift**：DaemonCard 内联编辑 UI
- **ios/Pocketctl/ViewModels/DaemonListViewModel.swift**：别名管理逻辑
- **ios/Pocketctl/Services/KeychainStorage.swift**：本地缓存支持
