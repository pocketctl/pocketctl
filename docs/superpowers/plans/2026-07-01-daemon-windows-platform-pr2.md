# daemon Windows 平台抽象层 PR2（业务接入 interface）实现计划 — 设计骨架

> **状态：骨架阶段。** task 分解 + 关键决策已定，待用户确认方向后展开每个 task 的完整改写代码（step + verbatim 代码）。最终 plan 无 placeholder。

**Goal:** 把业务代码从直接调平台机制（creack/pty、syscall、net.Listen unix、flock、Setsid）改成调 PR1 建好的 `internal/platform` interface；顺手用 build-tag 分文件清掉 `discovery`/`watcher` 的 Windows build 障碍。**终态：全项目 `GOOS=windows go build ./...` 通过 + Unix daemon 行为零回归。**

**Architecture:** `session`/`approval`/`main` 改调 platform interface（依赖注入）；`daemon.pid.go`/`instance_*.go` 公共 API 保留、内部委托 platform（main.go 调用点零改动，最小回归）；`discovery`/`watcher` 用 build-tag 分文件（不引入 platform 依赖，保持包独立）。

**Tech Stack:** Go 1.25.0；消费 PR1 的 `internal/platform`（不改 platform 包）。

## Global Constraints

- **Unix daemon 行为零回归（硬门禁）**：每个 task 后 `go build ./...` + `go test ./...` + `node test-all.js`（端到端）全绿。PR2 改的是活代码，靠编译 + 端到端 + 关键 task 人工跑真实 daemon 三重保障。
- **全项目 `GOOS=windows go build ./...` 通过**是 PR2 终态验收（PR1 只到 platform 包三平台编译）。
- **不改 `internal/platform/`**（PR1 已定稿，PR2 只消费 interface）。
- **不改业务逻辑**：PR2 是「换调用方式」（直接 syscall → platform interface），不改 daemon/session 的行为语义。
- macOS Sequoia：PR2 产出新二进制后若实跑 `daemon start`，需 `codesign --force --sign - ~/go/bin/pocketctl`（见 memory）。

## File Structure（PR2 改动文件清单）

| 文件 | PR2 改动 | 风险 |
|---|---|---|
| `internal/discovery/discovery.go` + 新 `_unix.go`/`_windows.go` | `owned()` 的 `syscall.Stat_t` 抽成平台分文件 | 低（独立） |
| `internal/watcher/process.go` + 新 `_unix.go`/`_windows.go` | `IsProcessAlive` 的 `syscall.Kill` 抽成平台分文件 | 低（独立） |
| `internal/session/pty.go` | `startPTYCli` 改用 `platform.PTYProvider.Start`，返回 `platform.PTY` | 高 |
| `internal/session/manager.go` | `ProcessState.PTY: *os.File→platform.PTY`；9 处 PTY R/W/Close；`isProcessAlive`/`KillSession` SIGKILL；`NewSessionManager` 加 platform 参数 | **最高** |
| `internal/approval/server.go` | `net.Listen("unix")` 改 `platform.IPCListener.Listen` | 中 |
| `internal/daemon/pid.go` | `IsRunning`/`Stop` 内部改委托 `platform.ProcessController`（公共 API 签名不变） | 中 |
| `internal/daemon/instance_unix.go` + `instance_windows.go` | `AcquireInstanceLock` 内部改委托 `platform.InstanceLocker`（公共 API 不变） | 中 |
| `cmd/pocketctl/main.go` | daemonize fork(@719) + restart(@1688) 改 `platform.Daemonizer`；service(@171/195/203) 改 `platform.ServiceManager`；signal(@1100) 平台分文件；构造 platform 注入 `session.NewManager` | 高 |

## 关键设计决策（请用户确认）

**决策 1：`daemon` 包公共 API 保留，内部委托 platform** ⭐
- `daemon.IsRunning()`/`Stop()`/`AcquireInstanceLock()` 签名不变（main.go 6 个调用点零改动）。
- 内部改用 `platform.NewProcessController()`/`NewInstanceLocker()`。
- 理由：(a) `daemon.Stop()` 是 `SIGTERM→轮询→SIGKILL` 组合，platform 没有等价；(b) 最小化 main.go 改动 = 最小回归风险；(c) 符合 spec「Unix 零回归硬门禁」。
- 取代 spec §5.5 暗示的「main.go 直接调 platform.New*()」——那条对 session.Manager 注入成立，对 daemon 进程控制不成立。

**决策 2：`session.NewSessionManager` 加 platform 参数（依赖注入）**
- 新签名：`NewSessionManager(outputCh, ptyProvider platform.PTYProvider, proc platform.ProcessController)`。
- main.go 构造 platform 实例传入。可测试性提升（可 mock）。

**决策 3：`session.ProcessState.PTY: *os.File → platform.PTY`**
- 9 处调用点（Read/Write/Close）interface 兼容，编译期适配。
- 已确认（探索报告 A2）：无 `ps.PTY.Fd()` 等 `*os.File` 特有方法调用，纯 R/W/Close → 改类型安全。

**决策 4：`discovery`/`watcher` 用 build-tag 分文件，不引 platform 依赖**
- 这俩包不是 daemon 核心平台机制，引入 platform 依赖过度。各自 `*_unix.go`/`*_windows.go` 分文件最简。
- `watcher.IsProcessAlive` 和 `platform.ProcessController.IsAlive` 功能重复但分属不同抽象层，不强求统一。

**决策 5：main.go signal 处理平台分文件**
- `signal.Notify(sigCh, SIGINT, SIGTERM)`（@1100）是 daemon 主进程**收**信号（不是发），Windows 无 SIGTERM。
- 抽成 `main_unix.go`/`main_windows.go` 分文件（unix 用 SIGINT/SIGTERM，windows 先 stub——真正的 Windows 优雅停止靠 PR4 的控制通道）。

## Task 分解（7 task，每 task 含完整 TDD step + verbatim 改写代码，待展开）

| Task | 范围 | 风险 | 依赖 |
|---|---|---|---|
| **Task 1** | `discovery.owned` + `watcher.IsProcessAlive` 平台分文件（清 Windows build 障碍） | 低 | 无（最独立，先做） |
| **Task 2** | `session.ProcessState.PTY` 类型改 + `startPTYCli` 接入 `platform.PTYProvider` + 9 处 PTY 调用点 + `NewSessionManager` 加 PTYProvider 参数 | **最高** | PR1 |
| **Task 3** | `session.isProcessAlive` + `KillSession` SIGKILL 接入 `platform.ProcessController`（+ NewSessionManager 加 ProcessController 参数） | 高 | Task 2 |
| **Task 4** | `approval.Server` 接入 `platform.IPCListener`（构造注入或内部 New） | 中 | PR1 |
| **Task 5** | `daemon.pid.go`（IsRunning/Stop）+ `instance_*.go`（AcquireInstanceLock）内部委托 platform；公共 API 不变 | 中 | PR1 |
| **Task 6** | `main.go` daemonize/restart 接入 `platform.Daemonizer`；service 接入 `platform.ServiceManager`；signal 平台分文件；构造 platform 实例注入 session.NewManager | 高 | Task 2/3（NewManager 签名） |
| **Task 7** | 集成验证：全项目 `GOOS=windows go build ./...` 通过 + Unix `test-all.js` 端到端 + go vet + 人工跑真实 daemon | — | 全部 |

## 验证策略（PR2 风险保障）
- 每 task：`go build ./...` + `go test ./...` + `go vet ./...`
- Task 2/3（session PTY 改造，最高风险）：额外跑 `node test-all.js`（端到端真实 daemon + session + PTY）
- Task 7：全项目 `GOOS=windows go build ./...`（PR2 终态里程碑）+ 人工 `pocketctl daemon start` + 创建 session + 发消息验证行为
- 回归红线：任何 task 后 Unix 测试/端到端不绿 → 不进下一个 task

---

## 执行模式

PR2 因高风险（改活代码 + Unix 零回归硬门禁）采用**逐 task 展开 + 执行**：每个 task 执行前把该 task 的完整改写代码（verbatim）写进本 plan，再 task-brief → implementer → review。这比「一次写完 7 task 再执行」更稳——每个 task 的实际产出反馈到下一个 task 的 plan。

---

## Task 1: discovery + watcher Windows build 障碍清除（平台分文件）

**Files:**
- Modify: `internal/discovery/discovery.go`（`owned` 闭包 → 调 `fileOwnedByCurrentUser`；删 `syscall` import）
- Create: `internal/discovery/owned_unix.go`（`//go:build !windows`）
- Create: `internal/discovery/owned_windows.go`（`//go:build windows`）
- Modify: `internal/watcher/process.go`（删 `IsProcessAlive` + `syscall` import，留 ProcessStateChange/ProcessMonitor）
- Create: `internal/watcher/process_unix.go`（`//go:build !windows`）
- Create: `internal/watcher/process_windows.go`（`//go:build windows`）

**Interfaces:** Consumes 无；Produces 无（build-tag 分文件，不碰 platform interface，保持 discovery/watcher 包独立）。

- [ ] **Step 1: 创建 `internal/discovery/owned_unix.go`**

```go
//go:build !windows

package discovery

import (
	"os"
	"syscall"
)

// fileOwnedByCurrentUser reports whether the file at path is owned by the
// current OS user. Used to decide if an agent binary is manageable (can be
// upgraded in place). Unix-only concept (uid).
func fileOwnedByCurrentUser(path string) bool {
	info, err := os.Stat(path)
	if err != nil {
		return false
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	return ok && int(st.Uid) == os.Getuid()
}
```

- [ ] **Step 2: 创建 `internal/discovery/owned_windows.go`**

```go
//go:build windows

package discovery

// fileOwnedByCurrentUser on Windows always returns false: Windows has no uid
// concept, and in-place agent-upgrade manageability is determined elsewhere.
// Native Windows upgrade path lands in a later PR.
func fileOwnedByCurrentUser(path string) bool {
	return false
}
```

- [ ] **Step 3: 改 `internal/discovery/discovery.go`**

把 `ResolveAgent` 里的 `owned` 闭包（当前 :139-146）整块替换为对 `fileOwnedByCurrentUser` 的引用：

当前：
```go
	owned := func(real string) bool {
		info, err := os.Stat(real)
		if err != nil {
			return false
		}
		st, ok := info.Sys().(*syscall.Stat_t)
		return ok && int(st.Uid) == os.Getuid()
	}
	return resolveFrom(cands, statReal, owned)
```

改为：
```go
	return resolveFrom(cands, statReal, fileOwnedByCurrentUser)
```

然后删掉 discovery.go 顶部的 `"syscall"` import（该文件不再直接用 syscall；确认无其它 syscall 用法后删除，若 go vet 报 unused 即对）。

- [ ] **Step 4: 创建 `internal/watcher/process_unix.go`**

```go
//go:build !windows

package watcher

import "syscall"

// IsProcessAlive checks if a process with the given PID is still running.
func IsProcessAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil
}
```

- [ ] **Step 5: 创建 `internal/watcher/process_windows.go`**

```go
//go:build windows

package watcher

// IsProcessAlive on Windows: native impl (OpenProcess) lands in a later PR.
// Returns false for now so ProcessMonitor treats registered pids as dead on
// next check — acceptable since daemon-side Windows PTY sessions are stubbed
// (PR1) and terminal-session monitoring on Windows is a later concern.
func IsProcessAlive(pid int) bool {
	return false
}
```

- [ ] **Step 6: 改 `internal/watcher/process.go`**

删掉 `IsProcessAlive` 函数（当前 :16-20）+ 删掉顶部 `"syscall"` import。保留 `ProcessStateChange`、`ProcessMonitor` 及其所有方法不变。改后 process.go 的 import 块应只剩 `"context"`、`"time"`。

当前 process.go 顶部：
```go
package watcher

import (
	"context"
	"syscall"
	"time"
)

// ProcessStateChange ...
```

改为：
```go
package watcher

import (
	"context"
	"time"
)

// ProcessStateChange ...
```

并删除：
```go
// IsProcessAlive checks if a process with the given PID is still running.
func IsProcessAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil
}
```

- [ ] **Step 7: 验证 discovery + watcher 三平台编译**

Run: `GOOS=darwin go build ./internal/discovery/ ./internal/watcher/ && GOOS=linux go build ./internal/discovery/ ./internal/watcher/ && GOOS=windows go build ./internal/discovery/ ./internal/watcher/`
Expected: 三平台全过（这俩包的 Windows 障碍已清）。

- [ ] **Step 8: 验证 Unix 全项目零回归**

Run: `go build ./... && go test ./... && go vet ./...`
Expected: 全绿（仅平台分文件重构，行为零变化）。

- [ ] **Step 9: Commit**

```bash
git add internal/discovery/discovery.go internal/discovery/owned_unix.go internal/discovery/owned_windows.go internal/watcher/process.go internal/watcher/process_unix.go internal/watcher/process_windows.go
git commit -m "feat(platform): discovery/watcher syscall 抽平台分文件,清 Windows build 障碍 (PR2/7)"
```

> 注意:全项目 `GOOS=windows go build ./...` 此刻仍过不了(session/daemon/main 的 syscall 障碍未清,Task 2-6 处理)。Task 1 只负责清 discovery/watcher 这两个独立包。

---

## Task 2-7: 待逐 task 展开

执行到该 task 时,把完整改写代码(verbatim 当前→改后)写进本节,再 task-brief → implementer → review。

---

## Task 2: session PTY 接入 platform.PTYProvider（最高风险）

**设计调整（偏离决策 2，已评估）：** 探索发现 `NewSessionManager` 有 **21 个调用点**（20 test + main.go:888，含 `internal/e2e/e2e_test.go` 4 处，e2e 有 pre-existing vet fail）。构造注入（加参数）要改 21 处 + 撞 e2e 风险。改用 **package-level default + `SetProviders` setter**：`NewSessionManager(outputCh)` 签名不变，session 包内部用 `defaultPTYProvider`/`defaultProc`（`platform.NewPTYProvider()`/`NewProcessController()`），main.go 与 21 个 test **零改动**。test 要 mock 时调 `sm.SetProviders(...)`。Unix 行为零变化（default provider 就是 creack/pty 包装）。

**Files:**
- Modify: `internal/session/manager.go`（import platform；`ProcessState.PTY: *os.File→platform.PTY`；SessionManager 加 `ptyProvider`/`proc` 字段；package-level defaults；`NewSessionManager` 用 default；新增 `SetProviders`；CreateSession :875 传 `sm.ptyProvider`）
- Modify: `internal/session/pty.go`（`startPTYCli` 加 `provider` 参数、返回 `platform.PTY`、删 `creack/pty` import、内部改 `provider.Start`）
- 不改：main.go（用 default，零改动）、9 处 PTY R/W/Close 调用点（类型改后 interface 自动适配）、所有 `_test.go`（21 调用点零改）

**Interfaces:**
- Consumes: `platform.PTYProvider.Start(cmd, *Size) (PTY, error)`、`platform.PTY`（io.ReadWriteCloser + SetSize）、`platform.Size`、`platform.ProcessController`（Task 3 用，本 task 一起注入）
- Produces: `session.SessionManager.SetProviders(pty, proc)`；session 不再直接 import `creack/pty`

- [ ] **Step 1: manager.go 加 platform import + package-level defaults + SessionManager 字段 + SetProviders**

manager.go 顶部 import 块加 `"github.com/pocketctl/pocketctl/internal/platform"`。

在 `type SessionManager struct {...}`（:229）**之前**插入 package-level defaults：

```go
// Platform providers used by default for new SessionManagers. Override per-
// instance via SetProviders (e.g. tests inject mocks). Unix: real creack/pty
// + signal backend; Windows: stubs returning ErrUnsupported (PR4 fills these).
// PR2: replaces session's direct creack/pty + syscall dependency.
var (
	defaultPTYProvider = platform.NewPTYProvider()
	defaultProc        = platform.NewProcessController()
)
```

`SessionManager` struct 加两个字段（紧挨现有字段，建议放 `outputCh` 附近）：

```go
	ptyProvider platform.PTYProvider      // PR2: daemon-session PTY backend (was direct creack/pty)
	proc        platform.ProcessController // PR2: process alive/kill (was syscall; used by Task 3)
```

- [ ] **Step 2: NewSessionManager 用 default + 新增 SetProviders**

`NewSessionManager`（:256）签名不变，body 加 default 赋值：

```go
func NewSessionManager(outputCh chan protocol.DaemonEvent) *SessionManager {
	return &SessionManager{
		sessions:    make(map[string]*ProcessState),
		outputCh:    outputCh,
		childPids:   make(map[int]bool),
		cwdSessions: make(map[string]map[string]struct{}),
		fileLocks:   filelock.New(),
		ptyProvider: defaultPTYProvider,
		proc:        defaultProc,
	}
}

// SetProviders overrides the platform providers, for tests injecting mocks.
// Must be called before any session is created. Not needed in production
// (NewSessionManager wires the real platform defaults).
func (sm *SessionManager) SetProviders(pty platform.PTYProvider, proc platform.ProcessController) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	sm.ptyProvider = pty
	sm.proc = proc
}
```

- [ ] **Step 3: ProcessState.PTY 类型改 platform.PTY**

`ProcessState`（:45）：

当前：
```go
	PTY              *os.File             // interactive-web-session D1: daemon session 的 PTY master（写 stdin 驱动 interactive claude）
```

改为：
```go
	PTY              platform.PTY         // interactive-web-session D1: daemon session 的 PTY master（写 stdin 驱动 interactive claude）。PR2: platform.PTY interface (was *os.File)
```

> 注：9 处 `ps.PTY.Write/Read/Close`（:91/:141/:184/:952/:1045/:1198）和 `ptyFile := ps.PTY`（:1082/:1636/:1919）类型自动从 `*os.File` 变 `platform.PTY`，interface 的 Read/Write/Close 签名兼容，**这些调用点不用改代码**。`:892 PTY: ptmx` 也自动匹配（ptmx 现在是 platform.PTY）。

- [ ] **Step 4: pty.go 改 startPTYCli**

`internal/session/pty.go` import 块：删 `"github.com/creack/pty"`，加 `"github.com/pocketctl/pocketctl/internal/platform"`。

`startPTYCli`（:20）当前：
```go
func startPTYCli(cliPath string, args []string, cwd string, extraEnv []string, agentType string) (*os.File, *exec.Cmd, error) {
	cmd := exec.Command(cliPath, args...)
	if cwd != "" {
		cmd.Dir = cwd
	}
	env := sanitizePTYEnv(os.Environ(), agentType)
	env = append(env, extraEnv...)
	env = ensureTERM(env, "xterm-256color")
	cmd.Env = env

	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: 24, Cols: 80})
	if err != nil {
		return nil, nil, fmt.Errorf("pty start: %w", err)
	}
	return ptmx, cmd, nil
}
```

改为：
```go
func startPTYCli(provider platform.PTYProvider, cliPath string, args []string, cwd string, extraEnv []string, agentType string) (platform.PTY, *exec.Cmd, error) {
	cmd := exec.Command(cliPath, args...)
	if cwd != "" {
		cmd.Dir = cwd
	}
	env := sanitizePTYEnv(os.Environ(), agentType)
	env = append(env, extraEnv...)
	env = ensureTERM(env, "xterm-256color")
	cmd.Env = env

	// PR2: PTY 启动走 platform.PTYProvider（Unix=creack/pty, Windows=stub），
	// 替代直接 pty.StartWithSize。env sanitize / TERM 仍是 session 业务逻辑。
	ptmx, err := provider.Start(cmd, &platform.Size{Rows: 24, Cols: 80})
	if err != nil {
		return nil, nil, fmt.Errorf("pty start: %w", err)
	}
	return ptmx, cmd, nil
}
```

> pty.go 的 `sanitizePTYEnv`/`ensureTERM` 不变（业务逻辑，不碰平台）。

- [ ] **Step 5: manager.go CreateSession :875 传 provider**

当前（:875）：
```go
		ptmx, cmd, err := startPTYCli(cliPath, args, resolvedCwd, extraEnv, config.Agent)
```

改为：
```go
		ptmx, cmd, err := startPTYCli(sm.ptyProvider, cliPath, args, resolvedCwd, extraEnv, config.Agent)
```

- [ ] **Step 6: 验证编译 + 全项目 Unix 零回归**

Run: `go build ./... && go vet ./... && go test ./...`
Expected: 全绿。21 个 `NewSessionManager(outputCh)` 调用点零改动（签名没变）；9 处 PTY 调用点类型自动适配；session 包不再 import creack/pty。

- [ ] **Step 7: 端到端验证（PTY 改造高风险，必跑）**

Run: `node test-all.js`（若环境支持真实 claude + relay）
Expected: 通过——daemon 启动、创建 daemon session、发消息、PTY 驱动 claude 行为与改造前一致。
> 若 test-all.js 因环境（无真实 claude/relay）跑不了，**必须**至少 `go test ./internal/session/...` 全绿 + 手动 `pocketctl daemon start`（codesign 后）创建一个 session 发条消息确认 PTY 仍工作。

- [ ] **Step 8: Commit**

```bash
git add internal/session/manager.go internal/session/pty.go
git commit -m "feat(platform): session PTY 接入 platform.PTYProvider,ProcessState.PTY 改 interface (PR2/7)"
```

> 注意：Task 2 后 session 包 Windows 仍编译失败（manager.go :1894/:1943 的 syscall.Kill/SIGKILL 未清，那是 Task 3）。本 task 只保证 Unix 零回归 + session 不再依赖 creack/pty。

---

## Task 3: session isProcessAlive/KillSession 接入 ProcessController

**Files:**
- Modify: `internal/session/manager.go`（`isProcessAlive` 改用 `defaultProc.IsAlive`；`KillSession` 强杀改用 `defaultProc.Kill`；删 `"syscall"` import）

**Interfaces:**
- Consumes: `defaultProc`（Task 2 加的 package-level `platform.ProcessController`）的 `IsAlive(pid)`/`Kill(pid)`
- Produces: session 包不再 import `syscall`；session 包 Windows 编译障碍清除（creack/pty Task2 清 + syscall Task3 清）

- [ ] **Step 1: isProcessAlive 改用 defaultProc.IsAlive**

当前（manager.go `isProcessAlive` func）：
```go
// isProcessAlive checks if a process with the given PID is running.
func isProcessAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil
}
```
改为：
```go
// isProcessAlive checks if a process with the given PID is running.
// PR2: delegates to the platform ProcessController (was syscall.Kill), so
// session no longer imports syscall.
func isProcessAlive(pid int) bool {
	return defaultProc.IsAlive(pid)
}
```

- [ ] **Step 2: KillSession 强杀改用 defaultProc.Kill**

当前（`KillSession` 内 deadline 分支）：
```go
			case <-deadline:
				// Force kill if still running
				if ps.Cmd.Process != nil {
					ps.Cmd.Process.Signal(syscall.SIGKILL)
				}
```
改为：
```go
			case <-deadline:
				// Force kill if still running (PR2: via platform ProcessController, was syscall.SIGKILL)
				if ps.Cmd.Process != nil {
					_ = defaultProc.Kill(ps.Cmd.Process.Pid)
				}
```

- [ ] **Step 3: 删 manager.go 的 `"syscall"` import**

Step 1/2 后 manager.go 不再用 `syscall`。删 import 块里的 `"syscall"`（先 `go build` 确认无 "imported and not used" 之外的错误；若 vet 报 unused 即删；若发现还有其它 syscall 用法，报告 DONE_WITH_CONCERNS 不要猜）。

- [ ] **Step 4: 验证 Unix 零回归 + session 包 Windows 编译**

Run: `go build ./... && go vet ./... && go test ./...`
Expected: 全绿。`grep -n 'syscall' internal/session/manager.go` 应无命中。

Run: `GOOS=windows go build ./internal/session/`
Expected: **通过**（Task 2 删 creack/pty + Task 3 删 syscall → session 包 Windows 编译障碍清除，这是 PR2 的一个里程碑）。

- [ ] **Step 5: Commit**

```bash
git add internal/session/manager.go
git commit -m "feat(platform): session isProcessAlive/KillSession 接入 ProcessController,删 syscall (PR2/7)"
```

---

## Task 4: approval.Server 接入 platform.IPCListener

**Files:**
- Modify: `internal/approval/server.go`（import platform；package-level `defaultIPCListener`；Server 加 `ipc` 字段；NewServer 用 default；Start 的 os.Remove+net.Listen+os.Chmod 三行 → `s.ipc.Listen` 一行）

**设计**：和 Task 2 同策略——`NewServer(socketPath, logger)` 签名不变，approval 包用 package-level `defaultIPCListener = platform.NewIPCListener()`，7 个 NewServer 调用点（main.go:902 + 6 test）零改。PR1 的 `unixIPCListener.Listen` 内部已含 stale-socket removal + net.Listen + 0600 chmod，所以 Start 的三步收敛为一行。

**Interfaces:**
- Consumes: `platform.IPCListener.Listen(name) (net.Listener, error)`
- Produces: approval 包不再直接 `net.Listen("unix", ...)`

- [ ] **Step 1: server.go 加 platform import + package default + Server 加 ipc 字段**

import 块加 `"github.com/pocketctl/pocketctl/internal/platform"`。

在 `type Server struct {...}`（:84）**之前**插入：

```go
// defaultIPCListener is the platform IPC listener (unix domain socket on Unix,
// named pipe on Windows). PR2: replaces approval's direct net.Listen("unix").
var defaultIPCListener = platform.NewIPCListener()
```

`Server` struct 加 `ipc` 字段（紧挨 `socketPath`/`logger`，或在 `ln` 前）：

```go
	ipc        platform.IPCListener  // PR2: 本地 IPC 监听 (unix socket/named pipe)，替代 net.Listen("unix")
```

- [ ] **Step 2: NewServer 用 default**

当前（:114-123）：
```go
func NewServer(socketPath string, logger *slog.Logger) *Server {
	if logger == nil {
		logger = slog.Default()
	}
	return &Server{
		socketPath: socketPath,
		logger:     logger,
		pending:    make(map[string]*pendingEntry),
	}
}
```
改为（签名不变，加 `ipc: defaultIPCListener`）：
```go
func NewServer(socketPath string, logger *slog.Logger) *Server {
	if logger == nil {
		logger = slog.Default()
	}
	return &Server{
		socketPath: socketPath,
		logger:     logger,
		ipc:        defaultIPCListener,
		pending:    make(map[string]*pendingEntry),
	}
}
```

- [ ] **Step 3: Start() 三行收敛为 s.ipc.Listen**

当前（:161-172 的开头）：
```go
func (s *Server) Start() error {
	// Clean up a stale socket from a previous daemon run.
	if err := os.Remove(s.socketPath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove stale approval socket: %w", err)
	}
	ln, err := net.Listen("unix", s.socketPath)
	if err != nil {
		return fmt.Errorf("listen approval socket: %w", err)
	}
	// Restrict to the owning user — approval requests carry no secret, but the
	// socket should not be world-writable.
	_ = os.Chmod(s.socketPath, 0600)

	s.ln = ln
```
改为：
```go
func (s *Server) Start() error {
	// PR2: IPC listen via platform.IPCListener (unix socket on Unix, named pipe
	// on Windows). platform.Listen handles stale-socket removal + 0600 chmod
	// internally — replaces the old direct net.Listen("unix", ...) + os.Remove
	// + os.Chmod trio.
	ln, err := s.ipc.Listen(s.socketPath)
	if err != nil {
		return err
	}

	s.ln = ln
```

> Start 后续（`s.wg.Add(1); go s.acceptLoop(); logger.Info(...); return nil`）不变。
> 改后 server.go 仍 import `net`（:88 `ln net.Listener`、:264 `handleConn(conn net.Conn)`）和 `os`（Close :205 `os.Remove`）。`net.Listen` 调用消失但 `net` 包类型仍用，不要删 net import。

- [ ] **Step 4: 验证 Unix 零回归 + approval Windows 编译**

Run: `go build ./... && go vet ./... && go test ./...`
Expected: 全绿。7 个 NewServer 调用点零改。

Run: `GOOS=windows go build ./internal/approval/`
Expected: 通过（approval 包 Windows 编译障碍清除）。

- [ ] **Step 5: Commit**

```bash
git add internal/approval/server.go
git commit -m "feat(platform): approval.Server 接入 platform.IPCListener,net.Listen unix 收敛 (PR2/7)"
```

---

## Task 5: daemon pid/instance 内部委托 platform（公共 API 不变）

**决策 1 落地**：`daemon.IsRunning`/`Stop`/`AcquireInstanceLock` 公共 API 签名不变（main.go 6 调用点零改），内部改委托 `platform.ProcessController`/`InstanceLocker`。删 `instance_unix.go`+`instance_windows.go`（其功能被 platform 接管），合并成无 build-tag 的 `instance.go`。

**Files:**
- Modify: `internal/daemon/pid.go`（加 platform import + package-level `defaultProc`/`defaultLocker`；IsRunning/Stop 改用 defaultProc；删 syscall import）
- Delete: `internal/daemon/instance_unix.go`
- Delete: `internal/daemon/instance_windows.go`
- Create: `internal/daemon/instance.go`（`AcquireInstanceLock` 调 `defaultLocker.Acquire`，无 build tag）

**Interfaces:**
- Consumes: `platform.NewProcessController()`（IsAlive/Terminate/Kill）、`platform.NewInstanceLocker()`（Acquire）
- Produces: daemon 包 IsRunning/Stop/AcquireInstanceLock 内部走 platform；main.go 6 调用点零改；daemon 不再用 syscall signal / unix.Flock

- [ ] **Step 1: pid.go 加 platform import + package defaults**

pid.go import 块：删 `"syscall"`，加 `"github.com/pocketctl/pocketctl/internal/platform"`。

在 import 块后、`const pidDir` 前（或 pid.go 顶部常量区前）插入 package defaults：

```go
// PR2 platform defaults: daemon 进程控制 + 单实例锁走 platform interface
// (was direct syscall signal / unix.Flock). 公共 API(IsRunning/Stop/
// AcquireInstanceLock) 签名不变,main.go 调用点零改。
var (
	defaultProc   = platform.NewProcessController()
	defaultLocker = platform.NewInstanceLocker()
)
```

- [ ] **Step 2: pid.go IsRunning 改用 defaultProc.IsAlive**

当前（:78-92）：
```go
func IsRunning() (int, bool) {
	pid, err := ReadPID()
	if err != nil {
		return 0, false
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return pid, false
	}
	// Signal 0 does not send a signal but checks if the process exists
	if err := proc.Signal(syscall.Signal(0)); err != nil {
		return pid, false
	}
	return pid, true
}
```
改为：
```go
func IsRunning() (int, bool) {
	pid, err := ReadPID()
	if err != nil {
		return 0, false
	}
	// PR2: 进程存活检查走 platform.ProcessController（was syscall signal 0）
	return pid, defaultProc.IsAlive(pid)
}
```

- [ ] **Step 3: pid.go Stop 改用 defaultProc（保留 SIGTERM→轮询5s→SIGKILL 组合逻辑）**

当前（:96-148）整段 `Stop` 函数体替换。注意组合语义必须等价（Terminate=SIGTERM，Kill=SIGKILL，IsAlive=signal-0 probe）：

```go
func Stop() error {
	pid, err := ReadPID()
	if err != nil {
		return err
	}

	// Check if process is actually running (PR2: via platform.ProcessController, was signal 0)
	if !defaultProc.IsAlive(pid) {
		os.Remove(PIDPath())
		return fmt.Errorf("daemon process not running (stale pid file removed)")
	}

	// Send SIGTERM (PR2: via platform.ProcessController.Terminate)
	if err := defaultProc.Terminate(pid); err != nil {
		return fmt.Errorf("send SIGTERM: %w", err)
	}

	// Wait for process to exit with timeout
	deadline := time.After(5 * time.Second)
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-deadline:
			// Process didn't exit in time, SIGKILL it (PR2: via platform.ProcessController.Kill)
			if err := defaultProc.Kill(pid); err != nil {
				return fmt.Errorf("process did not exit after SIGTERM and SIGKILL failed: %w", err)
			}
			os.Remove(PIDPath())
			// NOTE: do NOT remove StatePath() here — daemon.state 持久化 daemon_id,
			// 必须跨 stop/start 存活(同物理主机保持一个稳定 ID)。
			return nil
		case <-ticker.C:
			// Check if process has exited
			if !defaultProc.IsAlive(pid) {
				// Process is gone — clean up
				os.Remove(PIDPath())
				return nil
			}
		}
	}
}
```

> 保留了原 Stop 关于 StatePath 的注释语义（虽然原代码注释在 SIGKILL 分支，这里移到 Kill 分支保持提醒）。逻辑等价：IsAlive↔signal-0、Terminate↔SIGTERM、Kill↔SIGKILL。

- [ ] **Step 4: 删 instance_unix.go + instance_windows.go，建 instance.go**

删除 `internal/daemon/instance_unix.go` 和 `internal/daemon/instance_windows.go`（git rm）。

创建 `internal/daemon/instance.go`（**无 build tag**——platform 自己处理平台分支）：

```go
package daemon

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// AcquireInstanceLock takes an exclusive, non-blocking lock ensuring only one
// daemon process runs per host. PR2: delegates to platform.InstanceLocker
// (was direct unix.Flock in the former instance_unix.go). The lock is released
// when the returned Closer is closed — and, critically, is ALSO released
// automatically by the OS the moment the process dies (even via SIGKILL or a
// crash), making it race-free vs the PID-file check.
//
// Public API unchanged — main.go calls daemon.AcquireInstanceLock() with zero
// modification. Replaces the former instance_unix.go / instance_windows.go
// build-tag split (platform now owns the platform split).
func AcquireInstanceLock() (io.Closer, error) {
	if err := os.MkdirAll(pidDir, 0o755); err != nil {
		return nil, fmt.Errorf("create %s: %w", pidDir, err)
	}
	path := filepath.Join(pidDir, "daemon.lock")
	lock, err := defaultLocker.Acquire(path)
	if err != nil {
		return nil, err // platform 已包装 "another pocketctl daemon is already running..."
	}
	return lock, nil
}
```

- [ ] **Step 5: 验证 Unix 零回归 + daemon Windows 编译**

Run: `go build ./... && go vet ./... && go test ./...`
Expected: 全绿。main.go 的 `daemon.IsRunning()`/`Stop()`/`AcquireInstanceLock()` 6 个调用点零改。pid.go 不再 import syscall。

Run: `GOOS=windows go build ./internal/daemon/`
Expected: 通过（pid.go 无 syscall；instance.go 无 build tag；platform_windows.go 的 stub 接管锁/进程）。若 machineid.go/wsl.go 等还有 Windows 障碍，报告 DONE_WITH_CONCERNS 列出（不硬堵，可在 Task 7 处理）。

- [ ] **Step 6: Commit**

```bash
git add internal/daemon/pid.go internal/daemon/instance.go
git rm internal/daemon/instance_unix.go internal/daemon/instance_windows.go
git commit -m "feat(platform): daemon pid/instance 内部委托 platform,公共 API 不变 (PR2/7)"
```

---

## Task 6: main.go 接入 Daemonizer/ServiceManager + signal 分文件

PR2 最复杂 task（main.go 1695 行 × 4 处）。**分 3 个 step 组、每组独立 commit**（回归隔离）。每组后 `go build ./... && go test ./...` 全绿才进下一组。用 sonnet implementer。

**Files (整个 Task 6):**
- Create: `cmd/pocketctl/signal_unix.go`（`//go:build !windows`）
- Create: `cmd/pocketctl/signal_windows.go`（`//go:build windows`）
- Modify: `cmd/pocketctl/main.go`（package defaults daemonizer/serviceMgr；daemonize+restart 改 Daemonizer；signal 改 installSignalHandler；service 改 ServiceManager；import 演进：加 platform，B 后删 syscall，C 后删 service）

### Step 组 A: signal 平台分文件

- [ ] **A1: 创建 `cmd/pocketctl/signal_unix.go`**

```go
//go:build !windows

package main

import (
	"os"
	"syscall"
)

// installSignalHandler registers the daemon's graceful-shutdown signals. Unix:
// SIGINT + SIGTERM. PR2: extracted from main.go to a build-tag split file so
// main.go no longer references syscall.SIGTERM (absent on Windows).
func installSignalHandler(sigCh chan<- os.Signal) {
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
}
```

> 需在 import 块加 `"os/signal"`（signal.Notify）。或 main.go 已 import signal——本文件独立 import。

- [ ] **A2: 创建 `cmd/pocketctl/signal_windows.go`**

```go
//go:build windows

package main

import (
	"os"
	"os/signal"
)

// installSignalHandler on Windows: only os.Interrupt (Ctrl+C) is deliverable.
// A detached daemon has no console, so this is a placeholder — real Windows
// graceful stop uses the named-pipe control channel (PR4). Kept so main.go
// compiles cross-platform without syscall.SIGTERM.
func installSignalHandler(sigCh chan<- os.Signal) {
	signal.Notify(sigCh, os.Interrupt)
}
```

- [ ] **A3: main.go :1099-1100 改用 installSignalHandler**

当前：
```go
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
```
改为：
```go
	sigCh := make(chan os.Signal, 1)
	installSignalHandler(sigCh) // PR2: 平台分文件（Unix SIGINT/SIGTERM, Windows os.Interrupt）
```

> main.go 此时仍 import `syscall`（daemonize/restart 的 SysProcAttr 还在，Step 组 B 才删）+ `signal`（若 main.go 别处还用 signal 则保留；若仅 :1100 用，A3 后可删 signal import——确认后处理）。先 `go build` 看 vet 提示。

- [ ] **A4: 验证 + commit A**

Run: `go build ./... && go vet ./... && go test ./...` — 全绿。
```bash
git add cmd/pocketctl/signal_unix.go cmd/pocketctl/signal_windows.go cmd/pocketctl/main.go
git commit -m "feat(platform): main signal 处理抽平台分文件 (PR2/7 A)"
```

### Step 组 B: daemonize + restart 接入 Daemonizer

- [ ] **B1: main.go 加 platform import + package defaults**

import 块加 `"github.com/pocketctl/pocketctl/internal/platform"`。在 import 后（或合适位置）加：

```go
// PR2 platform defaults for the daemon entry: daemonize + service via platform
// interface (was direct syscall.SysProcAttr{Setsid} + internal/service).
var (
	daemonizer = platform.NewDaemonizer()
	serviceMgr = platform.NewServiceManager()
)
```

- [ ] **B2: daemonize fork 段（:712-722）改用 daemonizer.ForkDetached**

当前：
```go
		child := &exec.Cmd{
			Path:   exe,
			Args:   os.Args,
			Env:    childEnv,
			Stdin:  nil,
			Stdout: nil,
			Stderr: nil,
			SysProcAttr: &syscall.SysProcAttr{
				Setsid: true,
			},
		}
		if err := child.Start(); err != nil {
			fmt.Fprintln(os.Stderr, i18n.T("error.daemonize", err))
			os.Exit(1)
		}
```
改为：
```go
		// PR2: daemonize fork via platform.Daemonizer (was direct exec.Cmd + SysProcAttr{Setsid}).
		proc, err := daemonizer.ForkDetached(exe, os.Args[1:], childEnv)
		if err != nil {
			fmt.Fprintln(os.Stderr, i18n.T("error.daemonize", err))
			os.Exit(1)
		}
```

> ForkDetached 内部 `Args: append([]string{self}, args...)`，传 `os.Args[1:]` + self=exe → 等价原 `Args: os.Args`。返回 `*os.Process`。

- [ ] **B3: daemonize 启动动画里的 `child.Process.Pid`（:755）改 `proc.Pid`**

当前（:755 附近）：
```go
		fmt.Println(i18n.T("daemon.started", preForkID, child.Process.Pid))
```
改为：
```go
		fmt.Println(i18n.T("daemon.started", preForkID, proc.Pid))
```

> 动画逻辑（spinner + 等 IsRunning/Connected，:728-754）不变——它用 `daemon.IsRunning()`/`daemon.ReadState()`，不碰 child 对象。

- [ ] **B4: restart 段（:1684-1692）改用 daemonizer.Restart**

当前：
```go
			cmd := exec.Command(exe, os.Args[1:]...)
			cmd.Stdout = nil
			cmd.Stderr = nil
			cmd.Stdin = nil
			cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
			if err := cmd.Start(); err != nil {
				logger.Error("daemon restart failed: spawn", "error", err)
				return
			}
			logger.Info("new daemon spawned, exiting", "newPID", cmd.Process.Pid)
```
改为：
```go
			// PR2: restart via platform.Daemonizer (was exec.Command + SysProcAttr{Setsid}).
			if err := daemonizer.Restart(exe, os.Args[1:]); err != nil {
				logger.Error("daemon restart failed: spawn", "error", err)
				return
			}
			logger.Info("new daemon spawned, exiting")
```

> Restart 不返回 pid（platform 接口设计）；日志去掉 newPID 字段。可接受（info 级日志）。

- [ ] **B5: 删 main.go 的 `"syscall"` import**

B2/B4 后 main.go 不再用 `syscall.SysProcAttr`/`syscall.SIG*`（signal 已 A 组抽走）。`go build` 确认 syscall unused 后删 `"syscall"` import。若 main.go 还有 `runtime.GOOS` 等其它用法（不属 syscall 包），不受影响。

- [ ] **B6: 验证 + commit B**

Run: `go build ./... && go vet ./... && go test ./...` — 全绿。`grep -n 'syscall\.' cmd/pocketctl/main.go` → 无命中（注释除外）。
```bash
git add cmd/pocketctl/main.go
git commit -m "feat(platform): main daemonize/restart 接入 Daemonizer,删 syscall (PR2/7 B)"
```

### Step 组 C: service 接入 ServiceManager

- [ ] **C1: main.go service 调用改用 serviceMgr**

:171 当前：
```go
	cfg := service.Config{ExePath: exe, Args: daemonArgs, LogPath: daemon.ServiceBootLogPath()}
```
改为：
```go
	cfg := platform.ServiceOpts{ExePath: exe, Args: daemonArgs, LogPath: daemon.ServiceBootLogPath()}
```

:180 当前：
```go
	if err := service.Install(cfg); err != nil {
```
改为：
```go
	if err := serviceMgr.Install(cfg); err != nil {
```

:185 当前：
```go
	info, _ := service.Status()
```
改为：
```go
	info, _ := serviceMgr.Status()
```

:195（cmdServiceUninstall）当前：
```go
	if err := service.Uninstall(); err != nil {
```
改为：
```go
	if err := serviceMgr.Uninstall(); err != nil {
```

:203（cmdServiceStatus）当前：
```go
	info, err := service.Status()
```
改为：
```go
	info, err := serviceMgr.Status()
```

> `info` 类型从 `service.Info` 变 `platform.ServiceStatus`——字段名相同（Installed/Running/UnitPath/Detail），main.go 后续用法（:186-190/:208-223）零改。

- [ ] **C2: 删 main.go 的 `"github.com/pocketctl/pocketctl/internal/service"` import**

C1 后 main.go 不再直接用 `service.*`（platform.ServiceManager 内部委托 service）。`go build` 确认 service unused 后删 import。

- [ ] **C3: 验证 + commit C + Task 6 收尾**

Run: `go build ./... && go vet ./... && go test ./...` — 全绿。
Run: `GOOS=windows go build ./cmd/pocketctl/` — **应通过**（main.go 无 syscall、signal 分文件、daemonize/restart/service 走 platform stub）。这是 PR2「全项目 Windows build」的最后一块。
```bash
git add cmd/pocketctl/main.go
git commit -m "feat(platform): main service 接入 ServiceManager,删 service import (PR2/7 C)"
```

> Task 6 完成后，全项目 `GOOS=windows go build ./...` 应通过（Task 7 验证）。
