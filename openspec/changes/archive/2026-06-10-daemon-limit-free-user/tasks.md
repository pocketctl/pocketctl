## 1. Relay — 用户 Plan + 白名单数据库

- [x] 1.1 在 `relay/src/db.ts` 的 `initDB` 中新增迁移：`ALTER TABLE users ADD COLUMN IF NOT EXISTS plan VARCHAR(16) DEFAULT 'free'`
- [x] 1.2 在 `relay/src/db.ts` 的 `initDB` 中新增迁移：`ALTER TABLE users ADD COLUMN IF NOT EXISTS whitelist BOOLEAN DEFAULT false`
- [x] 1.3 在 `relay/src/db.ts` 新增 `getUserPlanAndWhitelist(pool, userId)` 函数：查询用户 plan 和 whitelist，返回 `{ plan: string, whitelist: boolean }`

## 2. Relay — Daemon 限流

- [x] 2.1 在 `relay/src/router.ts` 的 `registerDaemon` 方法中，注册前调用 `getUserPlanAndWhitelist` 检查用户 plan 和白名单状态
- [x] 2.2 如果用户 whitelist 为 true，跳过限制检查，直接注册
- [x] 2.3 如果用户 plan 为 'free' 且 whitelist 为 false，统计 `this.daemons` Map 中同一 userId 的在线 daemon 数量，如果 >= 1，获取当前在线 daemon 的 hostname，发送 error 事件 `{ type: "error", error: "免费版仅支持1台主机。当前在线: {hostname}。请先在 {hostname} 上运行 pocketctl daemon stop", code: "DAEMON_LIMIT_REACHED", limit: 1, plan: "free", current_host: "{hostname}" }`，然后关闭连接
- [x] 2.4 pro 用户跳过限制检查，直接注册

## 3. Go Daemon — 错误处理

- [x] 3.1 在 `internal/ws/client.go` 的 `readPump` 中，解析 error 事件后检查 `code` 字段
- [x] 3.2 如果 `code` 为 `DAEMON_LIMIT_REACHED`，将 error 消息打印到 stderr，然后调用 `os.Exit(1)`
- [x] 3.3 其他 error 事件保持现有行为（丢入 channel）

## 4. Go Daemon — 连接地址

- [x] 4.1 修改 `cmd/pocketctl/main.go` 中默认 relay 地址为 `wss://pocketctl.me/ws`（当前是 `ws://localhost:8080/ws`）
- [x] 4.2 保留 `--relay` 参数和环境变量 `POCKETCTL_RELAY_URL` 可覆盖默认值
- [x] 4.3 本地开发时通过 `--relay ws://localhost:8080/ws` 使用本地连接

## 5. 验证

- [ ] 5.1 启动 relay，用 free 用户连接第一个 daemon，验证成功
- [ ] 5.2 用同一 free 用户连接第二个 daemon，验证收到 DAEMON_LIMIT_REACHED 错误并退出
- [ ] 5.3 停止第一个 daemon，再启动第二个，验证成功
- [ ] 5.4 将用户 plan 改为 'pro'，验证可以连接多个 daemon
- [ ] 5.5 将用户 whitelist 设为 true，验证 free plan 也能连接多个 daemon
