## Why

免费用户可以注册无限个 daemon，无法区分免费/付费能力。需要限制免费用户只能连接 1 台 daemon，预留付费扩展。同时统一 daemon 的连接地址（测试用本地、上线用 pocketctl.me）。

## What Changes

- **Relay 限流**: `registerDaemon()` 在注册前检查用户 plan 和在线 daemon 数，超限返回 `DAEMON_LIMIT_REACHED` 错误
- **用户 plan 字段**: users 表新增 `plan` 字段（默认 `free`），`getUserPlan()` 查询用户计划
- **在线 daemon 计数**: 从 router 内存 Map 统计同一 userId 的在线 daemon 数量
- **Go Daemon 错误处理**: `readPump` 收到 error 事件时打印友好提示并退出
- **连接地址**: 测试环境用 `localhost`，生产环境用 `pocketctl.me` 域名
- **白名单机制**: 开发维护人员不受 daemon 数量限制，通过 `daemons` 表 `whitelist` 字段标记
- **错误提示文案**: 免费版仅支持 1 台主机，请先在其他主机上停止 daemon

## Capabilities

### New Capabilities
- `daemon-limit`: 免费用户 daemon 数量限制，支持 plan 扩展

### Modified Capabilities
- `relay-routing`: registerDaemon 新增限流检查逻辑，支持白名单跳过限制

## Impact

- **Relay**: `db.ts`（getUserPlan）、`router.ts`（registerDaemon 限流）
- **Go Daemon**: `ws/client.go`（错误处理）、`cmd/pocketctl/main.go`（连接地址配置）
- **DB**: users 表新增 plan 字段
