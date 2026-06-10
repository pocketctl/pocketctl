## Context

当前 relay 的 `registerDaemon` 没有任何用户级限制。用户计划（plan）信息不存在。Go daemon 的 WebSocket 客户端收到 error 事件后只是丢入 channel，不会打印或退出。

## Goals / Non-Goals

**Goals:**
- 免费用户限制 1 个在线 daemon
- 超限时 daemon 进程退出并打印友好提示
- 连接地址区分测试/生产环境
- 预留 plan 扩展（free / pro 等）

**Non-Goals:**
- 不实现 --force 踢人机制
- 不实现 iOS 端远程停止 daemon
- 不实现订阅系统（plan 字段手动设置）

## Decisions

### D1: 限流在 registerDaemon 内存 Map 中统计

**选择**: 从 `this.daemons` Map 中统计同一 userId 的在线连接数
**理由**: 内存 Map 是在线 daemon 的权威数据源，无需 DB 查询，延迟为零

### D2: users 表加 plan 字段

**选择**: `ALTER TABLE users ADD COLUMN plan VARCHAR(16) DEFAULT 'free'`
**理由**: 简单直接，后续订阅系统 UPDATE 这个字段即可

### D3: 错误事件携带结构化信息

**选择**: `{ type: "error", error: "...", code: "DAEMON_LIMIT_REACHED", limit: 1, plan: "free", current_host: "MacBook-Pro" }`
**理由**: Go daemon 可以根据 code 判断错误类型，展示不同提示

### D4: Go daemon 收到 DAEMON_LIMIT_REACHED 后 os.Exit(1)

**选择**: 在 readPump 中检测 error code，打印提示后调用 os.Exit(1)
**理由**: daemon 进程必须退出，否则会无限重连

### D5: 白名单机制

**选择**: `users` 表新增 `whitelist` boolean 字段（默认 false），whitelist 用户跳过所有 plan 限制
**替代方案**: 特殊 plan 名称（如 'admin'）→ 混淆了权限和计划的概念
**理由**: 白名单是独立于 plan 的权限标记，开发维护人员可以是任何 plan 但仍不受限制

### D6: 连接地址配置

**选择**: 默认 `wss://pocketctl.me/ws`，`--relay` 参数可覆盖，本地开发用 `ws://localhost:8080/ws`
**理由**: 生产环境用域名，开发时可指定本地地址

## Risks / Trade-offs

- **[daemon 断线后重连也算新连接]** → 内存 Map 中断线会 unregisterDaemon，重连时名额已释放，不会误判
- **[relay 重启后内存清空]** → daemon 重连时重新注册，限流重新计数，行为正确
