## 1. Go Daemon — Health Check 函数

- [x] 1.1 在 `internal/api/client.go` 新增 `HealthCheck(baseURL string) (string, error)` 函数：GET `{baseURL}/health`，返回响应体或错误
- [x] 1.2 在 `internal/api/client.go` 新增 `ParseJWTExpiry(token string) (time.Time, error)` 函数：解析 JWT 的 exp claim（不验证签名，只解码 payload）

## 2. Go Daemon — Doctor 命令

- [x] 2.1 在 `cmd/pocketctl/main.go` 新增 `cmdDoctor()` 函数：依次执行 8 项检查，每项输出 ✅/❌ 状态
- [x] 2.2 检查 1：配置文件 — 读取 `~/.pocketctl/auth.json`，检查是否存在且可解析
- [x] 2.3 检查 2：Token 有效性 — 解析 JWT exp，对比当前时间
- [x] 2.4 检查 3：DNS 解析 — `net.LookupHost` 解析 relay 域名
- [x] 2.5 检查 4：HTTP 连通 — `HealthCheck(relayBaseURL)` 调用 /health 端点
- [x] 2.6 检查 5：WebSocket 连接 — 建立临时 WS 连接，发 register，等 ack，立即关闭
- [x] 2.7 检查 6：Daemon 限制 — 检查 WS 响应是否为 DAEMON_LIMIT_REACHED
- [x] 2.8 在 `cmdDaemon()` switch 中新增 `"doctor"` case

## 3. Go Daemon — 帮助文本

- [x] 3.1 在 `printUsage()` 中新增 `doctor` 命令说明
- [x] 3.2 在 `cmdDaemon()` 的 usage 提示中新增 `doctor`

## 4. 验证

- [x] 4.1 运行 `pocketctl daemon doctor` 验证所有检查项输出格式正确
- [ ] 4.2 断网状态下运行，验证 DNS/HTTP/WS 检查正确报错
- [ ] 4.3 Token 过期后运行，验证 Token 检查正确报错
