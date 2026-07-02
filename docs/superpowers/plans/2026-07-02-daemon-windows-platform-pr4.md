# daemon Windows 真实实现 PR4 实现计划 — 骨架

> **状态：骨架阶段。** 用户确认方向后逐 task 展开 Windows 实现代码（verbatim）。

**Goal:** 把 PR1 留的 5 个 Windows stub（InstanceLocker/Daemonizer/ProcessController/IPCListener/ServiceManager）填成真实实现，让 daemon 在 Windows 上非交互链路真能跑（单例锁/审批 IPC/relay/ watcher/Service 安装）。**PTYProvider（ConPTY）保持 stub**，留 v2。本地 macOS 只能 `GOOS=windows go build` 编译验证，运行时验证靠 PR5 CI windows runner。

**Architecture:** `platform_windows.go` 用 `golang.org/x/sys/windows`（Mutex/OpenProcess/TerminateProcess/SCM）+ `github.com/Microsoft/go-winio`（named pipe）。daemon 侧加 Windows-only 控制通道（named pipe 收 stop 命令，替代 SIGTERM）。`platform_unix.go` 零改动。

**Tech Stack:** Go 1.25.0；`golang.org/x/sys/windows`（已有 v0.20.0）；新增 `github.com/Microsoft/go-winio`（named pipe）。

## Global Constraints

- **Windows-only 代码**：所有新实现带 `//go:build windows`（在 platform_windows.go 内，已是 windows build tag）。Unix 侧（platform_unix.go）零改动。
- **验证局限（核心，已与用户确认）**：本地 macOS 只能 `GOOS=windows go build ./...` 编译验证 + 严格代码 review（Windows API 用法）。**不能跑 Windows 测试**。运行时正确性靠 PR5 CI windows runner。接受「编译过、review 过、没真跑过」的中间态——运行 bug 在 PR5 暴露后迭代。
- **ConPTY stub 不动**：PTYProvider 保持 `ErrUnsupported`（spec v2，ConPTY 交互会话不在 PR4 范围）。
- **新依赖 go-winio**：加 go.mod（named pipe）。go.sum 更新。
- **Unix 零回归硬门禁**：`go build ./... && go test ./...`（macOS）全绿。Windows 代码不影响 Unix（build tag 隔离）。
- **三平台编译**：每 task 后 `GOOS=darwin|linux|windows go build ./...` 全过。
- **macOS codesign**：PR4 不改 Unix 二进制行为，不影响已装 daemon。

## File Structure

| 文件 | PR4 改动 | 风险 |
|---|---|---|
| `internal/platform/platform_windows.go` | 5 个 stub → 真实实现（Locker/Daemonizer/Process/IPC/Service）；PTYProvider 保持 stub | 高（Windows API） |
| `internal/platform/control_windows.go`（新）| 控制通道：daemon 侧 named pipe server（收 stop）+ client（发 stop） | 中 |
| `internal/daemon/control_windows.go`（新）| daemon 启动时开控制通道 pipe（Windows-only），主循环 select stop | 中 |
| `go.mod` / `go.sum` | 加 go-winio | 低 |

## 关键设计决策（spec §5.3 + §5.4）

1. **InstanceLocker = 全局命名 Mutex**：`CreateMutex(nil, FALSE, "Global\\pocketctl-daemon")`。已存在（另一 daemon 持有）→ `ERROR_ALREADY_EXISTS` → Acquire 失败。进程退出 OS 自动释放 Mutex。从 path 派生 Mutex 名（保证与 Unix 同语义）。
2. **Daemonizer = CREATE_NO_WINDOW|DETACHED_PROCESS**：`exec.Cmd.SysProcAttr.CreationFlags`。无控制台、不挂父进程。
3. **IPCListener = named pipe（go-winio）**：`winio.ListenPipe(\\.\pipe\pocketctl-approval-{daemonID}, nil)`。语义对齐 unix socket（本地、ACL）。
4. **ProcessController**：
   - `IsAlive(pid)` = `OpenProcess(SYNCHRONIZE, false, pid)` 成功即存活（+ CloseHandle）。
   - `Kill(pid)` = `OpenProcess(PROCESS_TERMINATE, ...) + TerminateProcess`。
   - `Terminate(pid)` = **控制通道**：连 daemon 的 `\\.\pipe\pocketctl-control-{pid}`，发 `"stop\n"`，daemon 收到优雅退出。
5. **ServiceManager = 手写 SCM**（用户 brainstorming 选，不用 kardianos）：`OpenSCManager` + `CreateService/DeleteService`（自启动 + 自动重启）。服务的可执行体是 `pocketctl.exe daemon start --foreground`。
6. **控制通道设计**（spec §5.4②）：
   - daemon 启动开 `\\.\pipe\pocketctl-control-{os.Getpid()}`（Windows-only，daemon/control_windows.go）。
   - 主循环 `select` 收 stop → 优雅退出（cancel context）。
   - ProcessController.Terminate(pid) 在 Windows 实现里连该 pipe 发 stop；超时则 Kill（TerminateProcess）兜底。
   - Unix 不走控制通道（SIGTERM）。

## Task 分解（7 task，低风险先 → 控制通道/SCM 后）

| Task | 范围 | 风险 | 验证 |
|---|---|---|---|
| **Task 1** | go.mod 加 go-winio 依赖 | 低 | `go mod tidy` + build |
| **Task 2** | InstanceLocker（Mutex） | 低 | GOOS=windows build + review |
| **Task 3** | Daemonizer（DETACHED） | 低 | GOOS=windows build + review |
| **Task 4** | IPCListener（named pipe, go-winio） | 中 | GOOS=windows build + review |
| **Task 5** | ProcessController IsAlive/Kill（OpenProcess/TerminateProcess） | 中 | GOOS=windows build + review |
| **Task 6** | 控制通道（daemon 侧 server + ProcessController.Terminate client） | 高 | GOOS=windows build + review（运行 PR5） |
| **Task 7** | ServiceManager（SCM 手写） | 高 | GOOS=windows build + review（运行 PR5） |

> 每 task：写 Windows 实现（verbatim）→ `GOOS=darwin|linux|windows go build ./...` 三平台编译 → 代码 review（Windows API 用法）→ commit。Task 6/7 的运行时行为靠 PR5 CI。

## 验证策略（PR4 特殊）
- **编译门禁**：每 task 后 `GOOS=windows go build ./internal/platform/ ./internal/daemon/ ./cmd/pocketctl/` 全过。
- **代码 review 重点**：Windows API 用法正确性（CreateMutex/OpenProcess/TerminateProcess/CreateService/handle 关闭/错误码）、handle 泄漏、并发安全。
- **Unix 零回归**：`go build ./... && go test ./...`（macOS）全绿（Windows 代码 build tag 隔离）。
- **运行时验证**：明确标注「留 PR5 CI」，不声称「Windows 上跑通」。

## 待展开（用户确认骨架后）
每 task 写完整 Windows 实现代码（verbatim）+ 三平台编译验证 + review 要点。
