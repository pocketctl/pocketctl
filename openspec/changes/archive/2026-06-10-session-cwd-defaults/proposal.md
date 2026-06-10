## Why

新建 Session 时工作目录（cwd）没有任何默认值或校验。iOS 端 placeholder 显示 `/path/to/project`，暗示必须手动输入绝对路径，但 Mac 上用户可能没有目标目录的权限，拼写错误也会导致进程启动失败。需要让 cwd 在未填写时自动安全回退到用户 home 目录，并支持 `~` 语法。

## What Changes

- **Daemon 路径解析**：新增 `resolveCwd()` 函数，空字符串或 `~` 解析为 `os.UserHomeDir()`，`~/xxx` 解析为 home 下的子目录
- **Daemon 权限校验**：启动进程前检查目录是否存在、是否为目录、是否可读写，校验失败返回友好错误信息
- **iOS placeholder 文案**：从 `/path/to/project` 改为 `~` 或留空提示
- **iOS 启动按钮**：cwd 为空时不再禁用，允许使用默认 home 目录
- **Relay 错误透传**：Daemon 返回的 cwd 校验错误需正确传递给 iOS 端显示

## Capabilities

### New Capabilities
- `cwd-resolution`: 工作目录路径解析与权限校验，支持 `~` 语法和空值默认回退

### Modified Capabilities
- `session-lifecycle`: Session 创建流程新增 cwd 校验步骤，校验失败时拒绝创建并返回错误

## Impact

- **Go Daemon**: `internal/session/manager.go`（CreateSession 增加 resolveCwd + 校验）、`cmd/pocketctl/main.go`（错误处理）
- **iOS**: `NewSessionSheet.swift`（placeholder 文案、按钮逻辑）
- **Relay**: `router.ts`（错误透传，可能无需改动——已有 error 事件转发）
- **协议**: `protocol/types.go`（可能新增错误类型，或复用现有 error 事件）
