## 1. Go Daemon — 路径解析

- [x] 1.1 在 `internal/session/manager.go` 中新增 `resolveCwd(cwd string) string` 函数：空字符串或 `~` 返回 `os.UserHomeDir()`，`~/xxx` 拼接 home + xxx，其他原样返回
- [x] 1.2 为 `resolveCwd` 编写单元测试（覆盖空、`~`、`~/xxx`、绝对路径四种情况）

## 2. Go Daemon — 权限校验

- [x] 2.1 在 `internal/session/manager.go` 中新增 `validateCwd(cwd string) error` 函数：检查路径存在（`os.Stat`）、是否为目录（`info.IsDir()`）、是否可读写（`os.OpenFile` 测试）
- [x] 2.2 为 `validateCwd` 编写单元测试（覆盖不存在、是文件、无权限、正常目录四种情况）

## 3. Go Daemon — CreateSession 集成

- [x] 3.1 修改 `CreateSession` 方法：在 `cmd.Dir` 设置前调用 `resolveCwd(config.Cwd)` 解析路径
- [x] 3.2 在 `resolveCwd` 之后、`cmd.Start()` 之前调用 `validateCwd` 校验，失败时返回包含目录路径的错误信息
- [x] 3.3 确保解析后的 cwd 存入 `ProcessState.Cwd`，后续 `SendMessage` 使用解析后的路径

## 4. Go Daemon — 错误事件透传

- [x] 4.1 在 `cmd/pocketctl/main.go` 的 `handleCommands` 中，`CreateSession` 返回错误时，发送 `{ type: "error", error: err.Error() }` 事件到 relay（复用现有协议）

## 5. iOS — UI 适配

- [x] 5.1 修改 `ios/Pocketctl/Views/NewSessionSheet.swift`：将 cwd placeholder 从 `/path/to/project` 改为 `~（默认 home 目录）`
- [x] 5.2 移除「启动」按钮对 cwd 非空的依赖（当前只有 prompt 非空即可启动）

## 6. 验证

- [x] 6.1 本地运行 `go test ./internal/session/...` 验证单元测试通过
- [ ] 6.2 启动 daemon，通过 iOS 创建 cwd 为空的 session，验证使用 home 目录启动
- [ ] 6.3 通过 iOS 创建 cwd 为不存在路径的 session，验证返回友好错误信息
