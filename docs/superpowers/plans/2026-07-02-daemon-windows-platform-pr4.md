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

> Task 调整（vs 骨架表）：go-winio 延后到 Task 3（IPCListener 用时才加，YAGNI）；Task 1 聚焦 InstanceLocker（用 x/sys/windows，不需 go-winio）。

---

## Task 1: InstanceLocker（Mutex）

**Files:** Modify `internal/platform/platform_windows.go`（windowsLocker.Acquire 真实实现 + 加 mutexLock type）

**设计：** Windows 全局命名 Mutex `Global\pocketctl-daemon`。`CreateMutex(initialOwner=false)`：成功=新 mutex（获锁）；返回 `ERROR_ALREADY_EXISTS`=另一 daemon 已持有（失败，但 handle 仍返回需 Close）。进程退出 OS 自动释放 Mutex（race-free，等价 Unix flock）。path 参数忽略（Windows 单例是 per-machine，用固定 Global 名）。

- [ ] **Step 1: 改 platform_windows.go 的 windowsLocker + 加 mutexLock**

当前（PR1 stub）：
```go
// NewInstanceLocker 返回 Windows 单实例锁（PR1 stub）。PR4 用全局命名 Mutex 实现。
func NewInstanceLocker() InstanceLocker { return windowsLocker{} }

type windowsLocker struct{}

func (windowsLocker) Acquire(string) (Lock, error) {
	return nil, ErrUnsupported
}
```

改为：
```go
// NewInstanceLocker 返回基于全局命名 Mutex 的单实例锁。
// PR4: 替代 PR1 stub。Global\pocketctl-daemon 跨进程互斥,进程退出 OS 自动释放
// (race-free,等价 Unix flock)。
func NewInstanceLocker() InstanceLocker { return windowsLocker{} }

type windowsLocker struct{}

func (windowsLocker) Acquire(path string) (Lock, error) {
	// path 是 Unix 锁文件路径语义;Windows 忽略它,用固定 Global mutex 名
	// (pocketctl 单例是 per-machine,不 per-path)。
	handle, err := windows.CreateMutex(nil, false, `Global\pocketctl-daemon`)
	if err != nil {
		if err == windows.ERROR_ALREADY_EXISTS {
			// mutex 已存在(另一 daemon 持有);CreateMutex 仍返回现有 handle,关掉它。
			if handle != 0 {
				_ = windows.CloseHandle(handle)
			}
			return nil, fmt.Errorf("another pocketctl daemon is already running on this host")
		}
		return nil, fmt.Errorf("create mutex: %w", err)
	}
	return &mutexLock{handle: handle}, nil
}

// mutexLock 持有 Mutex handle。Close 关闭 handle;mutex 真正释放在进程退出时(OS 保证)。
type mutexLock struct{ handle windows.Handle }

func (l *mutexLock) Close() error {
	return windows.CloseHandle(l.handle)
}
```

platform_windows.go import 块加 `"fmt"` + `"golang.org/x/sys/windows"`（保留现有 net/os/os/exec）。

- [ ] **Step 2: 三平台编译验证**

Run: `GOOS=darwin go build ./... && GOOS=linux go build ./... && GOOS=windows go build ./...`
Expected: 三平台全过。Unix 零影响（platform_unix.go 没动）；Windows InstanceLocker 现用 CreateMutex。

- [ ] **Step 3: Unix 零回归确认**

Run: `go build ./... && go vet ./... && go test ./...`（macOS）
Expected: 全绿（Windows 代码 build tag 隔离）。

- [ ] **Step 4: Commit**

```bash
git add internal/platform/platform_windows.go
git commit -m "feat(platform): Windows InstanceLocker 真实实现(Mutex) (PR4/7)"
```

> **review 重点**: CreateMutex(initialOwner=false 不抢占)、ERROR_ALREADY_EXISTS 检测、handle 关闭(成功路径由 mutexLock.Close 负责;ALREADY_EXISTS 路径立即 Close)、错误消息与 Unix 一致("another pocketctl daemon...")。运行时验证(真起两个 daemon 看互斥)留 PR5 CI。

---

## Task 2-7: 待逐 task 展开

Task 2(Daemonizer DETACHED) / Task 3(IPCListener named pipe + go-winio) / Task 4(ProcessController IsAlive/Kill) / Task 5(控制通道) / Task 6(ServiceManager SCM) / Task 7(集成验证)。执行到时写完整 Windows 代码。

---

## Task 2: Daemonizer（CREATE_NO_WINDOW|DETACHED_PROCESS）

**Files:** Modify `internal/platform/platform_windows.go`（windowsDaemonizer.ForkDetached/Restart 真实实现）

**设计：** `exec.Cmd.SysProcAttr.CreationFlags = windows.CREATE_NO_WINDOW | windows.DETACHED_PROCESS`。无控制台窗口、脱离父进程控制台（等价 Unix Setsid）。CreationFlags 是标准库 `syscall.SysProcAttr` 的字段（uint32），常量来自 `x/sys/windows`。

- [ ] **Step 1: 改 platform_windows.go windowsDaemonizer**

当前（PR1 stub）：
```go
func NewDaemonizer() Daemonizer { return windowsDaemonizer{} }

type windowsDaemonizer struct{}

func (windowsDaemonizer) ForkDetached(string, []string, []string) (*os.Process, error) {
	return nil, ErrUnsupported
}
func (windowsDaemonizer) Restart(string, []string) error { return ErrUnsupported }
```

改为：
```go
// NewDaemonizer 返回 Windows daemonizer。
// PR4: CREATE_NO_WINDOW|DETACHED_PROCESS 创建无窗口、脱离父控制台的子进程(等价 Unix Setsid)。
func NewDaemonizer() Daemonizer { return windowsDaemonizer{} }

type windowsDaemonizer struct{}

func (windowsDaemonizer) ForkDetached(self string, args []string, env []string) (*os.Process, error) {
	cmd := &exec.Cmd{
		Path: self,
		Args: append([]string{self}, args...),
		Env:  env,
		SysProcAttr: &syscall.SysProcAttr{
			CreationFlags: windows.CREATE_NO_WINDOW | windows.DETACHED_PROCESS,
		},
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("fork detached: %w", err)
	}
	return cmd.Process, nil
}

func (windowsDaemonizer) Restart(self string, args []string) error {
	cmd := exec.Command(self, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: windows.CREATE_NO_WINDOW | windows.DETACHED_PROCESS,
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("restart spawn: %w", err)
	}
	return nil
}
```

platform_windows.go import 加 `"syscall"`（已有 fmt/net/os/os/exec/windows）。

- [ ] **Step 2: 三平台编译验证**

Run: `GOOS=darwin go build ./... && GOOS=linux go build ./... && GOOS=windows go build ./...`
Expected: 三平台全过。Windows Daemonizer 现用 CreationFlags。

- [ ] **Step 3: Unix 零回归**

Run: `go build ./... && go vet ./... && go test ./...`（macOS）— 全绿。

- [ ] **Step 4: Commit**
```bash
git add internal/platform/platform_windows.go
git commit -m "feat(platform): Windows Daemonizer 真实实现(DETACHED_PROCESS) (PR4/7)"
```

> review 重点: CreationFlags 是 syscall.SysProcAttr 字段(uint32)、常量 CREATE_NO_WINDOW(0x08000000)|DETACHED_PROCESS(0x00000008) 来自 x/sys/windows、ForkDetached 返回 cmd.Process、Restart 不返回 pid(同 Unix)。运行验证留 PR5。

---

## Task 3-7: 待逐 task 展开

Task 3(IPCListener named pipe + go-winio) / Task 4(ProcessController IsAlive/Kill) / Task 5(控制通道) / Task 6(ServiceManager SCM) / Task 7(集成验证)。

---

## Task 3: IPCListener（named pipe, go-winio）

**Files:** `go.mod`/`go.sum`（加 `github.com/Microsoft/go-winio`）+ `internal/platform/platform_windows.go`（windowsIPCListener.Listen 真实实现）

**设计：** `winio.ListenPipe(name, nil)` 创建 named pipe listener。返回 `net.Listener`（符合 IPCListener.Listen 签名）。语义对齐 unix socket（本地、ACL、不占端口）。DefaultPath 已在 PR1 stub（`\\.\pipe\pocketctl-` + name）。

- [ ] **Step 1: 加 go-winio 依赖**

Run: `go get github.com/Microsoft/go-winio`
Expected: go.mod/go.sum 更新（加 go-winio）。macOS 上能 get（下载源码，build tag 隔离不影响 Unix 编译）。

- [ ] **Step 2: 改 platform_windows.go windowsIPCListener.Listen**

当前（PR1 stub，Listen 返回 ErrUnsupported）：
```go
func (windowsIPCListener) Listen(string) (net.Listener, error) {
	return nil, ErrUnsupported
}
```
改为：
```go
// NewIPCListener 返回 Windows named pipe IPC listener。
// PR4: 用 go-winio ListenPipe,语义对齐 unix socket(本地、ACL、不占端口)。
func NewIPCListener() IPCListener { return windowsIPCListener{} }

type windowsIPCListener struct{}

func (windowsIPCListener) Listen(name string) (net.Listener, error) {
	ln, err := winio.ListenPipe(name, nil)
	if err != nil {
		return nil, fmt.Errorf("listen named pipe: %w", err)
	}
	return ln, nil
}

func (windowsIPCListener) DefaultPath(name string) string {
	return `\\.\pipe\pocketctl-` + name
}
```

platform_windows.go import 加 `"github.com/Microsoft/go-winio"`（包名 `winio`）。

- [ ] **Step 3: 三平台编译验证**

Run: `GOOS=darwin go build ./... && GOOS=linux go build ./... && GOOS=windows go build ./...`
Expected: 三平台全过。Windows 的 IPCListener.Listen 现用 winio.ListenPipe。Unix 不 import go-winio（build tag 隔离）。

- [ ] **Step 4: Unix 零回归 + go.mod 确认**

Run: `go build ./... && go vet ./... && go test ./...`（macOS）— 全绿。
Run: `go mod tidy && git diff go.mod` — 确认 go-winio 加入（直接依赖）。

- [ ] **Step 5: Commit**
```bash
git add go.mod go.sum internal/platform/platform_windows.go
git commit -m "feat(platform): Windows IPCListener 真实实现(named pipe, go-winio) (PR4/7)"
```

> review 重点: winio.ListenPipe 返回 net.Listener(接口匹配)、pipe 名格式(DefaultPath 已对)、go-winio 不影响 Unix(build tag)、go.mod 直接依赖。运行验证留 PR5。

---

## Task 4-7: 待逐 task 展开

Task 4(ProcessController IsAlive/Kill) / Task 5(控制通道) / Task 6(ServiceManager SCM) / Task 7(集成验证)。
