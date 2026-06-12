## 1. Watcher 去重修复

- [x] 1.1 在 `handleRemovedFile` 中移除 `delete(sw.knownSessions, sessionId)`，改为注释说明保留原因（watcher.go:192）

## 2. SessionManager 状态更新

- [x] 2.1 修改 `RegisterTerminalSession`：对已存在的 terminal session（`ps.Source == "terminal"`）更新 `Pid`、`Status`、清空 `ExitReason`，更新 `Cwd` 和 `TTY`（如果非空），并返回 `false`（manager.go:166-169）
- [x] 2.2 更新 `RegisterTerminalSession` 的注释，说明三种返回值场景：daemon 进程跳过（false）、已有 terminal 更新（false）、新 session（true）

## 3. Handler 安全网

- [x] 3.1 在 `handleWatcherEvents` 的 discovered 分支中，当 `!registered` 时调用 `sm.SetSessionStatus(evt.Session.SessionID, evt.Session.Status)` 替代纯 `break`（main.go:743-745）

## 4. 验证

- [x] 4.1 运行 `go build ./...` 确认编译通过
- [x] 4.2 运行 `go test ./internal/session/... ./internal/watcher/...` 确认现有测试通过
- [x] 4.3 手动验证：终端 `claude` → `/exit` → `claude --continue`，检查 web 客户端 status 从 "已退出" 恢复为 "运行中"
- [ ] 4.4 手动验证：多次 exit→continue 循环，确认状态正确切换，不产生重复 session
