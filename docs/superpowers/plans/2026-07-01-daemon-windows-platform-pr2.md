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
