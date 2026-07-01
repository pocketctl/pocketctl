# daemon Windows 平台抽象层 PR1（platform 骨架）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新建 `internal/platform/` 包，定义 6 个平台机制 interface（PTY/IPC/InstanceLocker/Process/Daemonizer/Service），提供 Unix 实现 + Windows stub，让 platform 包三平台可编译、Unix 行为零变化——为 PR2（业务代码接入 interface）打地基。

**Architecture:** 平台无关的 interface 集中在 `platform.go`；Unix 实现在 `platform_unix.go`（`//go:build !windows`，重写现有 flock/creack/pty/unix-socket/signal/Setside 逻辑）；Windows stub 在 `platform_windows.go`（`//go:build windows`，全部返回 `ErrUnsupported`，PR4 再填真实实现）。**PR1 不接入业务代码**（不改动 `main.go`/`session`/`daemon`/`approval` 的调用点）——那 是 PR2。ServiceManager 在 Unix 侧套壳委托现有 `internal/service` 包。

**Tech Stack:** Go 1.25.0；`github.com/creack/pty` v1.1.24；`golang.org/x/sys/unix` v0.20.0；`internal/service`（现有）。**PR1 不引入新依赖**（`go-winio` 等是 PR4）。

## Global Constraints

- Go 1.25.0，依赖上限：不新增 go.mod 依赖（PR1 范围内）。
- 抽象边界：**只有平台特定机制进 interface**（PTY/signal/flock/unix-socket/Setsid）。标准库跨平台 API（`os.Stat`/`os.ReadFile`/`gorilla/websocket`/TCP `net`）保持直接调用，不抽象。
- 平台分文件用 `//go:build` tag，不用 feature flag。
- **PR1 不接入业务代码**：禁止改动 `cmd/pocketctl/main.go`、`internal/session/*`、`internal/daemon/*`、`internal/approval/*` 的调用逻辑。本 PR 只新增 `internal/platform/`。
- **Unix 零回归硬门禁**：每个 task 后 `go test ./...`（本机 macOS）全绿，现有行为不变。
- macOS Sequoia 注意：如本 PR 产出新二进制并要 `daemon start` 实跑，需 `codesign --force --sign - ~/go/bin/pocketctl`（见 memory）。但 PR1 只新增包、不接入，不影响已装二进制行为。

## 与 spec 的偏差（plan 作者记录，需执行者知晓）

spec §8「PR1」验收写的是「`GOOS={windows,darwin,linux} go build` 全过；Unix 行为零变化」。**实测发现这不现实**：

- 当前 `GOOS=windows go build ./...` 卡在 `internal/discovery`（`syscall.Stat_t`）、`internal/watcher`（`syscall.Kill`）；
- 修掉它们后会暴露 `internal/session`（creack/pty）、`cmd/pocketctl/main.go`（`syscall.SysProcAttr{Setsid}`、`syscall.SIGTERM`）、`internal/daemon/pid.go`（`syscall.SIGTERM/SIGKILL`）。
- 这些都是**业务代码**的 syscall 依赖，spec 自己规定「PR1 业务代码暂不接入」。两者矛盾——不接入就不可能让全项目 Windows build 过。

**本 plan 的修正**：PR1 验收收紧为——
1. `internal/platform/` 包本身三平台可编译（`GOOS={windows,darwin,linux} go build ./internal/platform/...` 全过）；
2. Unix 全项目 `go build ./...` + `go test ./...` 全绿、行为零变化；
3. 全项目 `GOOS=windows go build ./...` 通过推迟到 **PR2**（接入后 session/main 不再直接碰平台机制，Windows 障碍随之消除；`discovery`/`watcher` 的 syscall 在 PR2/PR3 顺手加 build tag）。

## File Structure

| 文件 | 责任 | 创建者 |
|---|---|---|
| `internal/platform/platform.go` | 平台无关：`ErrUnsupported`、`Size`、6 个 interface、`ServiceOpts`/`ServiceStatus`/`Lock` 辅助类型。无构造函数实现。 | Task 1 |
| `internal/platform/platform_unix.go` | `//go:build !windows`：6 个 `New*` 构造函数 + Unix 实现（flock、creack/pty、unix socket、signal、Setsid、委托 `internal/service`）。 | Task 2–7 逐个追加 |
| `internal/platform/platform_windows.go` | `//go:build windows`：6 个 `New*` 构造函数 + stub（返回 `ErrUnsupported`）。PR4 替换为真实实现。 | Task 2–7 逐个追加 |
| `internal/platform/platform_unix_test.go` | `//go:build !windows`：Unix 实现的单元测试（PTY IO、锁互斥、IPC listen/accept、进程存活）。 | Task 2–5 |

---

## Task 1: platform 包骨架（共享类型 + 6 interface 定义）

**Files:**
- Create: `internal/platform/platform.go`

**Interfaces:**
- Consumes: 无（首个 task）
- Produces: `ErrUnsupported`、`Size`、`PTY`、`PTYProvider`、`IPCListener`、`Lock`、`InstanceLocker`、`ProcessController`、`Daemonizer`、`ServiceOpts`、`ServiceStatus`、`ServiceManager`。后续 task 的 Unix/Windows 实现依赖这些类型名与签名（**不得改名**）。

- [ ] **Step 1: 创建 `internal/platform/platform.go`**

```go
// Package platform 抽象 daemon 依赖的平台机制（PTY、本地 IPC、单实例锁、进程控制、
// daemonize、系统服务），让 internal/daemon、internal/session、cmd/pocketctl 的业务
// 代码平台无关。平台差异通过 build-tag 分文件封死在本包内：
//
//   - platform.go         平台无关的 interface 与共享类型
//   - platform_unix.go    Unix 实现（!windows）
//   - platform_windows.go Windows 实现（windows）
//
// 抽象边界（见 spec §3.3）：只有「Windows 上行为不同或不可用」的平台机制才进本包。
// 标准库跨平台 API（os.Stat / os.ReadFile / gorilla/websocket / TCP net）保持直接调用。
package platform

import (
	"errors"
	"io"
	"net"
	"os"
	"os/exec"
)

// ErrUnsupported 由某平台未实现的机制返回（如 Windows 的 PTY）。调用方必须处理，
// 不得 panic——这是受控降级，不是崩溃。
var ErrUnsupported = errors.New("platform mechanism not supported on this OS")

// Size 是终端窗口尺寸（行列）。
type Size struct {
	Rows uint16
	Cols uint16
}

// PTY 是一个已启动 PTY 主设备的原始字节 IO 句柄。
//
// 业务语义不在此层：Ctrl+C=0x03、Shift+Tab=\x1b[Z、/exit\r、/effort X\r 等
// 「对 Claude TUI 发什么字节」的知识归 session 包。platform 只管原始字节 IO 与
// 窗口尺寸——这样 Windows 未来上 ConPTY 时本层零改动。
type PTY interface {
	io.ReadWriteCloser
	SetSize(rows, cols uint16) error
}

// PTYProvider 启动一个进程并附加到 PTY。cmd 的 Env/Dir 由调用方预先配好
// （env sanitization、TERM 设置是业务逻辑，归 session 层，不进本层）。
type PTYProvider interface {
	Start(cmd *exec.Cmd, size *Size) (PTY, error)
}

// IPCListener 提供本地 IPC 监听：Unix 用 domain socket，Windows 用 named pipe。
// name 的语义由实现解释（Unix=文件路径，Windows=pipe 名）。
type IPCListener interface {
	Listen(name string) (net.Listener, error)
	// DefaultPath 返回给定逻辑名的默认 IPC 地址（Unix=文件路径，Windows=pipe 名）。
	DefaultPath(name string) string
}

// Lock 是已获取的单实例锁；Close 释放。
type Lock interface {
	io.Closer
}

// InstanceLocker 保证每台主机只有一个 daemon 进程。锁在进程退出时自动释放
// （即使 SIGKILL/崩溃）——这是它优于 PID 文件检查的原因。
type InstanceLocker interface {
	// Acquire 获取独占、非阻塞锁。path 在 Unix 是锁文件路径；Windows 实现从 path 派生 Mutex 名。
	Acquire(path string) (Lock, error)
}

// ProcessController 抽象进程存活检查、优雅停止、强杀。
type ProcessController interface {
	IsAlive(pid int) bool
	// Terminate 优雅停止：Unix=SIGTERM；Windows=控制通道命令（见 PR4 Windows 实现）。
	Terminate(pid int) error
	// Kill 强杀：Unix=SIGKILL；Windows=TerminateProcess。
	Kill(pid int) error
}

// Daemonizer 抽象进程后台化与 re-exec 重启。
type Daemonizer interface {
	// ForkDetached 启动脱离终端的子进程运行 self+args，返回子进程。env 为子进程环境。
	ForkDetached(self string, args []string, env []string) (*os.Process, error)
	// Restart re-exec 自身（fork+exec 后由调用方退出）。
	Restart(self string, args []string) error
}

// ServiceOpts 描述如何把 daemon 装成系统服务（映射 internal/service.Config）。
type ServiceOpts struct {
	ExePath string
	Args    []string
	LogPath string
}

// ServiceStatus 是服务状态查询结果（映射 internal/service.Info）。
type ServiceStatus struct {
	Installed bool
	Running   bool
	UnitPath  string
	Detail    string
}

// ServiceManager 安装/卸载/查询系统服务（launchd/systemd/Windows Service）。
type ServiceManager interface {
	Install(opts ServiceOpts) error
	Uninstall() error
	Status() (ServiceStatus, error)
}

// 构造函数 New* 由 platform_unix.go / platform_windows.go 按平台实现，
// 本文件不提供默认实现（任一实际构建总有一个平台文件在场）。
```

- [ ] **Step 2: 验证 platform 包编译通过（仅 interface，无实现）**

Run: `go build ./internal/platform/`
Expected: 无输出（成功）。interface 定义无需实现即可编译。

- [ ] **Step 3: 验证全项目 Unix 仍全绿（未碰任何业务代码）**

Run: `go build ./... && go test ./...`
Expected: 全绿（本 task 只新增文件，零侵入）。

- [ ] **Step 4: Commit**

```bash
git add internal/platform/platform.go
git commit -m "feat(platform): 新增 platform 包骨架与 6 个平台机制 interface (PR1/8)"
```

---

## Task 2: PTYProvider / PTY（Unix 实现 + Windows stub）

**Files:**
- Create: `internal/platform/platform_unix.go`
- Create: `internal/platform/platform_windows.go`
- Create: `internal/platform/platform_unix_test.go`

**Interfaces:**
- Consumes: `PTY`、`PTYProvider`、`Size`、`ErrUnsupported`（来自 Task 1）
- Produces: `NewPTYProvider() PTYProvider`（后续 PR2 的 session 包会用它替代 `startPTYCli`）

- [ ] **Step 1: 写失败测试（Unix）**

创建 `internal/platform/platform_unix_test.go`：

```go
//go:build !windows

package platform

import (
	"io"
	"os/exec"
	"testing"
)

func TestPTYProvider_StartReadWrite(t *testing.T) {
	cmd := exec.Command("cat") // PTY 内回显 stdin
	p := NewPTYProvider()
	pty, err := p.Start(cmd, &Size{Rows: 24, Cols: 80})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer pty.Close()

	if _, err := pty.Write([]byte("hi\n")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	buf := make([]byte, 64)
	n, err := pty.Read(buf)
	if err != nil && err != io.EOF {
		t.Fatalf("Read: %v", err)
	}
	if n == 0 {
		t.Fatal("Read returned no data (PTY echo expected)")
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `go test ./internal/platform/ -run TestPTYProvider -v`
Expected: FAIL，编译错误 `undefined: NewPTYProvider`（还没实现）。

- [ ] **Step 3: 写 Unix 实现**

创建 `internal/platform/platform_unix.go`：

```go
//go:build !windows

package platform

import (
	"fmt"
	"os"
	"os/exec"

	"github.com/creack/pty"
)

// NewPTYProvider 返回 Unix PTY provider（基于 creack/pty）。
func NewPTYProvider() PTYProvider { return unixPTYProvider{} }

type unixPTYProvider struct{}

func (unixPTYProvider) Start(cmd *exec.Cmd, size *Size) (PTY, error) {
	ws := &pty.Winsize{Rows: 24, Cols: 80}
	if size != nil {
		ws.Rows = size.Rows
		ws.Cols = size.Cols
	}
	ptmx, err := pty.StartWithSize(cmd, ws)
	if err != nil {
		return nil, fmt.Errorf("pty start: %w", err)
	}
	return &unixPTY{ptmx: ptmx}, nil
}

type unixPTY struct{ ptmx *os.File }

func (p *unixPTY) Read(b []byte) (int, error)  { return p.ptmx.Read(b) }
func (p *unixPTY) Write(b []byte) (int, error) { return p.ptmx.Write(b) }
func (p *unixPTY) Close() error                { return p.ptmx.Close() }
func (p *unixPTY) SetSize(rows, cols uint16) error {
	return pty.Setsize(p.ptmx, &pty.Winsize{Rows: rows, Cols: cols})
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `go test ./internal/platform/ -run TestPTYProvider -v`
Expected: PASS。

- [ ] **Step 5: 写 Windows stub（同文件追加）**

创建 `internal/platform/platform_windows.go`：

```go
//go:build windows

package platform

import (
	"os/exec"
)

// NewPTYProvider 返回 Windows PTY provider（PR1 stub）。
// ConPTY 真实实现见 PR4；PR1 全部返回 ErrUnsupported，调用方降级处理。
func NewPTYProvider() PTYProvider { return windowsPTYProvider{} }

type windowsPTYProvider struct{}

func (windowsPTYProvider) Start(*exec.Cmd, *Size) (PTY, error) {
	return nil, ErrUnsupported
}
```

- [ ] **Step 6: 验证 platform 包三平台编译**

Run: `go build ./internal/platform/ && GOOS=windows go build ./internal/platform/ && GOOS=linux go build ./internal/platform/`
Expected: 三条都无输出（成功）。

- [ ] **Step 7: 验证 Unix 全项目零回归**

Run: `go build ./... && go test ./...`
Expected: 全绿。

- [ ] **Step 8: Commit**

```bash
git add internal/platform/platform_unix.go internal/platform/platform_windows.go internal/platform/platform_unix_test.go
git commit -m "feat(platform): PTYProvider/PTY Unix 实现 + Windows stub (PR1/8)"
```

---

## Task 3: IPCListener（Unix 实现 + Windows stub）

**Files:**
- Modify: `internal/platform/platform_unix.go`（追加 IPC 段）
- Modify: `internal/platform/platform_windows.go`（追加 IPC stub）
- Modify: `internal/platform/platform_unix_test.go`（追加 IPC 测试）

**Interfaces:**
- Consumes: `IPCListener`（Task 1）
- Produces: `NewIPCListener() IPCListener`

- [ ] **Step 1: 写失败测试（追加到 platform_unix_test.go）**

```go
func TestIPCListener_ListenAccept(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/test.sock"
	l := NewIPCListener()

	ln, err := l.Listen(path)
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	defer ln.Close()

	done := make(chan error, 1)
	go func() {
		c, err := net.Dial("unix", path)
		if err != nil {
			done <- err
			return
		}
		c.Close()
		done <- nil
	}()
	conn, err := ln.Accept()
	if err != nil {
		t.Fatalf("Accept: %v", err)
	}
	conn.Close()
	if err := <-done; err != nil {
		t.Fatalf("Dial: %v", err)
	}
}

func TestIPCListener_DefaultPath(t *testing.T) {
	l := NewIPCListener()
	p := l.DefaultPath("approval")
	if p == "" {
		t.Fatal("DefaultPath returned empty")
	}
}
```

注意：`platform_unix_test.go` 的 import 块需追加 `"net"`（Task 2 只 import 了 io/os/exec/testing）。完整 import 块在本 task Step 3 实现后应为：

```go
import (
	"io"
	"net"
	"os/exec"
	"testing"
)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `go test ./internal/platform/ -run TestIPCListener -v`
Expected: FAIL，`undefined: NewIPCListener`。

- [ ] **Step 3: 追加 Unix 实现到 platform_unix.go**

在文件末尾追加（import 块需补 `"net"`、`"os"`、`"path/filepath"`）：

```go
// NewIPCListener 返回 Unix domain socket IPC listener。
func NewIPCListener() IPCListener { return unixIPCListener{} }

type unixIPCListener struct{}

func (unixIPCListener) Listen(name string) (net.Listener, error) {
	// 清理上次 daemon 残留的 socket 文件。
	if err := os.Remove(name); err != nil && !os.IsNotExist(err) {
		return nil, fmt.Errorf("remove stale ipc socket: %w", err)
	}
	ln, err := net.Listen("unix", name)
	if err != nil {
		return nil, fmt.Errorf("listen ipc socket: %w", err)
	}
	// 仅属主可读写——审批请求本身不含机密，但 socket 不应全局可写。
	_ = os.Chmod(name, 0o600)
	return ln, nil
}

func (unixIPCListener) DefaultPath(name string) string {
	return filepath.Join(os.TempDir(), "pocketctl", name+".sock")
}
```

platform_unix.go 的完整 import 块此时应为：

```go
import (
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/creack/pty"
)
```

- [ ] **Step 4: 跑测试确认通过**

Run: `go test ./internal/platform/ -run TestIPCListener -v`
Expected: PASS。

- [ ] **Step 5: 追加 Windows stub 到 platform_windows.go**

```go
// NewIPCListener 返回 Windows named pipe IPC listener（PR1 stub）。
// PR4 用 github.com/Microsoft/go-winio 实现 named pipe。
func NewIPCListener() IPCListener { return windowsIPCListener{} }

type windowsIPCListener struct{}

func (windowsIPCListener) Listen(string) (net.Listener, error) {
	return nil, ErrUnsupported
}

func (windowsIPCListener) DefaultPath(name string) string {
	return `\\.\pipe\pocketctl-` + name
}
```

platform_windows.go 的 import 块需补 `"net"`：

```go
import (
	"net"
	"os/exec"
)
```

- [ ] **Step 6: 三平台编译 + Unix 零回归**

Run: `go build ./internal/platform/ && GOOS=windows go build ./internal/platform/ && GOOS=linux go build ./internal/platform/ && go test ./...`
Expected: 全绿。

- [ ] **Step 7: Commit**

```bash
git add internal/platform/platform_unix.go internal/platform/platform_windows.go internal/platform/platform_unix_test.go
git commit -m "feat(platform): IPCListener Unix 实现 + Windows stub (PR1/8)"
```

---

## Task 4: InstanceLocker（Unix 实现 + Windows stub）

**Files:**
- Modify: `internal/platform/platform_unix.go`、`platform_windows.go`、`platform_unix_test.go`

**Interfaces:**
- Consumes: `InstanceLocker`、`Lock`（Task 1）
- Produces: `NewInstanceLocker() InstanceLocker`

- [ ] **Step 1: 写失败测试（追加）**

```go
func TestInstanceLocker_Exclusion(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/test.lock"
	locker := NewInstanceLocker()

	l1, err := locker.Acquire(path)
	if err != nil {
		t.Fatalf("first Acquire: %v", err)
	}
	defer l1.Close()

	if _, err := locker.Acquire(path); err == nil {
		t.Fatal("second Acquire should fail (lock already held)")
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `go test ./internal/platform/ -run TestInstanceLocker -v`
Expected: FAIL，`undefined: NewInstanceLocker`。

- [ ] **Step 3: 追加 Unix 实现到 platform_unix.go**

import 块补 `"golang.org/x/sys/unix"`。完整 import 此时为：

```go
import (
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/creack/pty"
	"golang.org/x/sys/unix"
)
```

实现：

```go
// NewInstanceLocker 返回基于 flock 的单实例锁。行为对齐现有 daemon.AcquireInstanceLock
// （PR2 接入时由 daemon 传入同样的锁文件路径，无缝替换）。
func NewInstanceLocker() InstanceLocker { return unixLocker{} }

type unixLocker struct{}

func (unixLocker) Acquire(path string) (Lock, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("create %s: %w", filepath.Dir(path), err)
	}
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		return nil, fmt.Errorf("open lock file: %w", err)
	}
	// LOCK_EX|LOCK_NB：独占、非阻塞。拿不到立即失败，不等。
	// 进程退出（含 SIGKILL/崩溃）时内核自动释放——race-free。
	if err := unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		f.Close()
		return nil, fmt.Errorf("another pocketctl daemon is already running on this host")
	}
	return fileLock{f: f}, nil
}

type fileLock struct{ f *os.File }

func (l fileLock) Close() error { return l.f.Close() }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `go test ./internal/platform/ -run TestInstanceLocker -v`
Expected: PASS。

- [ ] **Step 5: 追加 Windows stub 到 platform_windows.go**

```go
// NewInstanceLocker 返回 Windows 单实例锁（PR1 stub）。PR4 用全局命名 Mutex 实现。
func NewInstanceLocker() InstanceLocker { return windowsLocker{} }

type windowsLocker struct{}

func (windowsLocker) Acquire(string) (Lock, error) {
	return nil, ErrUnsupported
}
```

- [ ] **Step 6: 三平台编译 + Unix 零回归**

Run: `go build ./internal/platform/ && GOOS=windows go build ./internal/platform/ && GOOS=linux go build ./internal/platform/ && go test ./...`
Expected: 全绿。

- [ ] **Step 7: Commit**

```bash
git add internal/platform/platform_unix.go internal/platform/platform_windows.go internal/platform/platform_unix_test.go
git commit -m "feat(platform): InstanceLocker flock 实现 + Windows stub (PR1/8)"
```

---

## Task 5: ProcessController（Unix 实现 + Windows stub）

**Files:**
- Modify: `internal/platform/platform_unix.go`、`platform_windows.go`、`platform_unix_test.go`

**Interfaces:**
- Consumes: `ProcessController`（Task 1）
- Produces: `NewProcessController() ProcessController`

- [ ] **Step 1: 写失败测试（追加）**

```go
func TestProcessController_IsAlive(t *testing.T) {
	pc := NewProcessController()
	if !pc.IsAlive(os.Getpid()) {
		t.Fatal("current process should be alive")
	}
	// 999999 几乎不可能是真实 pid；仅作「不存在」判据。
	if pc.IsAlive(999999) {
		t.Fatal("pid 999999 should not be alive")
	}
}
```

import 块需补 `"os"`（此时 test 文件 import: io, net, os, os/exec, testing）。

- [ ] **Step 2: 跑测试确认失败**

Run: `go test ./internal/platform/ -run TestProcessController -v`
Expected: FAIL，`undefined: NewProcessController`。

- [ ] **Step 3: 追加 Unix 实现到 platform_unix.go**

```go
// NewProcessController 返回基于 Unix signal 的进程控制器。对齐现有 daemon.pid.go
// 的 IsRunning/Stop 逻辑（PR2 接入时替换）。
func NewProcessController() ProcessController { return unixProcessController{} }

type unixProcessController struct{}

func (unixProcessController) IsAlive(pid int) bool {
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	// signal 0 不发信号，仅探测进程是否存在。
	return proc.Signal(unix.Signal(0)) == nil
}

func (unixProcessController) Terminate(pid int) error {
	proc, err := os.FindProcess(pid)
	if err != nil {
		return fmt.Errorf("find process: %w", err)
	}
	return proc.Signal(unix.SIGTERM)
}

func (unixProcessController) Kill(pid int) error {
	proc, err := os.FindProcess(pid)
	if err != nil {
		return fmt.Errorf("find process: %w", err)
	}
	return proc.Signal(unix.SIGKILL)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `go test ./internal/platform/ -run TestProcessController -v`
Expected: PASS。

- [ ] **Step 5: 追加 Windows stub 到 platform_windows.go**

```go
// NewProcessController 返回 Windows 进程控制器（PR1 stub）。
// PR4 实现：IsAlive=OpenProcess，Kill=TerminateProcess，Terminate=控制通道命令。
func NewProcessController() ProcessController { return windowsProcessController{} }

type windowsProcessController struct{}

func (windowsProcessController) IsAlive(int) bool    { return false }
func (windowsProcessController) Terminate(int) error { return ErrUnsupported }
func (windowsProcessController) Kill(int) error      { return ErrUnsupported }
```

- [ ] **Step 6: 三平台编译 + Unix 零回归**

Run: `go build ./internal/platform/ && GOOS=windows go build ./internal/platform/ && GOOS=linux go build ./internal/platform/ && go test ./...`
Expected: 全绿。

- [ ] **Step 7: Commit**

```bash
git add internal/platform/platform_unix.go internal/platform/platform_windows.go internal/platform/platform_unix_test.go
git commit -m "feat(platform): ProcessController signal 实现 + Windows stub (PR1/8)"
```

---

## Task 6: Daemonizer（Unix 实现 + Windows stub）

**Files:**
- Modify: `internal/platform/platform_unix.go`、`platform_windows.go`、`platform_unix_test.go`

**Interfaces:**
- Consumes: `Daemonizer`（Task 1）
- Produces: `NewDaemonizer() Daemonizer`

> 说明：detached 进程的端到端行为（脱离终端、setsid 新会话）很难在单测里稳定验证，留 PR2 接入后由 daemon 启动端到端覆盖。本 task 给「ForkDetached 能启动一个 detached 子进程并返回有效 pid」的最小测试。

- [ ] **Step 1: 写失败测试（追加）**

```go
func TestDaemonizer_ForkDetached(t *testing.T) {
	if _, err := os.Stat("/bin/sleep"); err != nil {
		t.Skip("/bin/sleep 不可用，跳过 detached 测试")
	}
	d := NewDaemonizer()
	proc, err := d.ForkDetached("/bin/sleep", []string{"2"}, os.Environ())
	if err != nil {
		t.Fatalf("ForkDetached: %v", err)
	}
	if proc.Pid <= 0 {
		t.Fatal("返回的 pid 无效")
	}
	// 清理：杀掉 detached sleep，避免泄漏。
	_ = proc.Kill()
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `go test ./internal/platform/ -run TestDaemonizer -v`
Expected: FAIL，`undefined: NewDaemonizer`。

- [ ] **Step 3: 追加 Unix 实现到 platform_unix.go**

import 块补 `"syscall"`（标准库，用于 `SysProcAttr{Setsid}`——和现有 main.go:719/1688 保持一致用标准库 syscall 而非 x/sys/unix）。完整 import 此时为：

```go
import (
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"

	"github.com/creack/pty"
	"golang.org/x/sys/unix"
)
```

实现：

```go
// NewDaemonizer 返回基于 Setsid fork 的 Unix daemonizer。对齐现有 main.go 的
// daemonize（719）与 restart（1688）逻辑（PR2 接入时替换）。
func NewDaemonizer() Daemonizer { return unixDaemonizer{} }

type unixDaemonizer struct{}

func (unixDaemonizer) ForkDetached(self string, args []string, env []string) (*os.Process, error) {
	cmd := &exec.Cmd{
		Path: self,
		Args: append([]string{self}, args...),
		Env:  env,
		// Setsid：新会话，脱离调用方终端。这是「后台化」的核心。
		SysProcAttr: &syscall.SysProcAttr{Setsid: true},
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("fork detached: %w", err)
	}
	return cmd.Process, nil
}

func (unixDaemonizer) Restart(self string, args []string) error {
	cmd := exec.Command(self, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("restart spawn: %w", err)
	}
	return nil
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `go test ./internal/platform/ -run TestDaemonizer -v`
Expected: PASS。

- [ ] **Step 5: 追加 Windows stub 到 platform_windows.go**

import 块补 `"os"`：

```go
import (
	"net"
	"os"
	"os/exec"
)
```

```go
// NewDaemonizer 返回 Windows daemonizer（PR1 stub）。
// PR4 实现：ForkDetached=CREATE_NO_WINDOW|DETACHED_PROCESS。
func NewDaemonizer() Daemonizer { return windowsDaemonizer{} }

type windowsDaemonizer struct{}

func (windowsDaemonizer) ForkDetached(string, []string, []string) (*os.Process, error) {
	return nil, ErrUnsupported
}
func (windowsDaemonizer) Restart(string, []string) error { return ErrUnsupported }
```

- [ ] **Step 6: 三平台编译 + Unix 零回归**

Run: `go build ./internal/platform/ && GOOS=windows go build ./internal/platform/ && GOOS=linux go build ./internal/platform/ && go test ./...`
Expected: 全绿。

- [ ] **Step 7: Commit**

```bash
git add internal/platform/platform_unix.go internal/platform/platform_windows.go internal/platform/platform_unix_test.go
git commit -m "feat(platform): Daemonizer Setsid 实现 + Windows stub (PR1/8)"
```

---

## Task 7: ServiceManager（Unix 套壳 internal/service + Windows stub）

**Files:**
- Modify: `internal/platform/platform_unix.go`、`platform_windows.go`

**Interfaces:**
- Consumes: `ServiceManager`、`ServiceOpts`、`ServiceStatus`（Task 1）；`internal/service`（现有包：`Install(Config)`/`Uninstall()`/`Status()(Info,error)`、`Config{ExePath,Args,LogPath}`、`Info{Installed,Running,UnitPath,Detail}`）
- Produces: `NewServiceManager() ServiceManager`

> 说明：Unix 侧是薄套壳，委托现有 `internal/service` 包（其行为已由 `service_darwin_test.go`/`service_linux_test.go` 覆盖）。本 task 不为套壳写新单测——那会是重复测试。验证靠编译 + Unix 全项目测试绿。

- [ ] **Step 1: 追加 Unix 实现到 platform_unix.go**

import 块补 `"github.com/pocketctl/pocketctl/internal/service"`。完整 import：

```go
import (
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"

	"github.com/creack/pty"
	"golang.org/x/sys/unix"
	"github.com/pocketctl/pocketctl/internal/service"
)
```

实现（追加到文件末尾）：

```go
// NewServiceManager 返回委托 internal/service 的 Unix 服务管理器。
// existing service 包按 darwin(launchd)/linux(systemd)/other(unsupported) 分文件，
// 本套壳在所有 !windows 平台都可用。PR2 接入时替换 main.go 直接调用 service.* 的地方。
func NewServiceManager() ServiceManager { return unixServiceManager{} }

type unixServiceManager struct{}

func (unixServiceManager) Install(opts ServiceOpts) error {
	return service.Install(service.Config{
		ExePath: opts.ExePath,
		Args:    opts.Args,
		LogPath: opts.LogPath,
	})
}

func (unixServiceManager) Uninstall() error { return service.Uninstall() }

func (unixServiceManager) Status() (ServiceStatus, error) {
	info, err := service.Status()
	if err != nil {
		return ServiceStatus{}, err
	}
	return ServiceStatus{
		Installed: info.Installed,
		Running:   info.Running,
		UnitPath:  info.UnitPath,
		Detail:    info.Detail,
	}, nil
}
```

> 注意：`fmt` import 若在本 task 前已用于其它实现则不重复；若 go vet 报 `fmt` unused（不会，前面 task 都用了 fmt.Errorf），删除即可。本 plan 各 task 累积 import，实现者按 `goimports`/编译错误最终对齐。

- [ ] **Step 2: 追加 Windows stub 到 platform_windows.go**

```go
// NewServiceManager 返回 Windows 服务管理器（PR1 stub）。PR4 实现 Windows Service（SCM）。
func NewServiceManager() ServiceManager { return windowsServiceManager{} }

type windowsServiceManager struct{}

func (windowsServiceManager) Install(ServiceOpts) error      { return ErrUnsupported }
func (windowsServiceManager) Uninstall() error               { return ErrUnsupported }
func (windowsServiceManager) Status() (ServiceStatus, error) { return ServiceStatus{}, ErrUnsupported }
```

- [ ] **Step 3: 三平台编译 + Unix 零回归**

Run: `go build ./internal/platform/ && GOOS=windows go build ./internal/platform/ && GOOS=linux go build ./internal/platform/ && go test ./...`
Expected: 全绿。

- [ ] **Step 4: Commit**

```bash
git add internal/platform/platform_unix.go internal/platform/platform_windows.go
git commit -m "feat(platform): ServiceManager 套壳 internal/service + Windows stub (PR1/8)"
```

---

## Task 8: PR1 集成验证 + 收尾

**Files:**
- 无新增/修改（验证 + 文档收尾）

- [ ] **Step 1: platform 包三平台编译最终确认**

Run: `GOOS=darwin go build ./internal/platform/ && GOOS=linux go build ./internal/platform/ && GOOS=windows go build ./internal/platform/`
Expected: 三条全过。

- [ ] **Step 2: platform 包 Unix 全测试**

Run: `go test ./internal/platform/ -v`
Expected: PASS（PTYProvider、IPCListener、InstanceLocker、ProcessController、Daemonizer 五组测试）。

- [ ] **Step 3: Unix 全项目零回归最终确认（硬门禁）**

Run: `go build ./... && go test ./... && go vet ./...`
Expected: 全绿。现有 `test-all.js`/`test-session-bridge.js` 不受影响（PR1 未碰业务代码，可跳过 JS 端到端；若 CI 跑则必绿）。

- [ ] **Step 4: 确认 PR1 未触碰业务代码**

Run: `git diff --stat master..HEAD -- cmd/ internal/session/ internal/daemon/ internal/approval/ internal/discovery/ internal/watcher/ internal/service/`
Expected: 空输出（本 PR 只动了 `internal/platform/` + 本 plan 文档）。若非空，说明越界，回退该改动。

- [ ] **Step 5: 记录 PR1 完成边界（commit message 写明 handed-off 项）**

```bash
git diff --stat master..HEAD
git log master..HEAD --oneline
```

预期看到 8 个 commit（Task 1–8），全部在 `internal/platform/` + plan 文档。

> **PR1 完成后的交接清单（写给 PR2）：**
> 1. `internal/platform/` 已就位，6 interface + Unix 实现 + Windows stub，三平台可编译。
> 2. **未接入**：`cmd/pocketctl/main.go`（Setsid daemonize @719/restart @1688、signal @1100）、`internal/daemon/pid.go`（Stop/IsRunning 用 syscall）、`internal/daemon/instance_*.go`（flock）、`internal/session/pty.go`（startPTYCli）、`internal/approval/server.go`（net.Listen unix @166）仍直接调平台机制——PR2 把它们切到 `platform.New*()`。
> 3. **全项目 `GOOS=windows go build` 尚未通过**：还卡在 `discovery`(Stat_t)、`watcher`(Kill)、`session`(creack/pty)、`main`(Setsid/signal)、`pid.go`(SIGTERM)。这些在 PR2 接入时随调用点切换一并清除（session 不再直接 import creack/pty 后，Windows 编译障碍上移到 platform_windows.go 的 stub，已是 ErrUnsupported）。
> 4. PR2 验收硬门禁：Unix 现有测试 + `test-all.js`/`test-session-bridge.js` 端到端全绿、行为零变化；接入后全项目 `GOOS=windows go build ./...` 通过。

- [ ] **Step 6: Commit（若有文档/收尾改动；否则跳过）**

```bash
git add -A
git commit -m "chore(platform): PR1 集成验证通过，移交 PR2 接入 (PR1/8 done)"
```

---

## Self-Review

**1. Spec 覆盖**（spec §5 platform 抽象层 / §8 PR1）：
- 6 interface（PTY/IPC/Lock/Process/Daemonizer/Service）→ Task 1 定义 + Task 2–7 实现 ✅
- Unix 实现从现有代码迁移（creack/pty、flock、unix socket、signal、Setsid、service 套壳）→ Task 2–7 ✅
- Windows stub（ErrUnsupported）→ Task 2–7 各有 ✅
- PTY 分层（原始 IO，业务语义留 session）→ Task 1 PTY interface 文档 + Task 2 实现仅 Read/Write/Close/SetSize ✅
- 「业务代码暂不接入」→ Global Constraints + Task 8 Step 4 验证 ✅
- 「oom/fd 不套壳」「fs_ops 不做」→ 本 plan 未触及，符合 ✅
- PR1 验收偏差（platform 包三平台 build，非全项目）→ 顶部「与 spec 的偏差」显式记录 ✅

**2. 占位符扫描**：无 TBD/TODO/「适当处理」。每个 step 含完整代码或精确命令。Task 6/7 的「难单测」有明确说明 + 替代验证（编译 + 现有 service 测试 + PR2 端到端），非占位 ✅

**3. 类型一致性**：
- `NewPTYProvider/IPCListener/InstanceLocker/ProcessController/Daemonizer/ServiceManager` 在 Task 1 声明意图、Task 2–7 实现，签名一致 ✅
- `Size{Rows,Cols uint16}` 全程一致 ✅
- `ServiceOpts{ExePath,Args,LogPath}` ↔ `service.Config{ExePath,Args,LogPath}` 字段名对齐（Task 7）✅
- `ServiceStatus{Installed,Running,UnitPath,Detail}` ↔ `service.Info{...}` 对齐（Task 7）✅
- `ErrUnsupported` 单一定义（Task 1），所有 stub 引用它 ✅
- `fileLock`（Task 4）实现 `Lock`（io.Closer），`Close()` 方法接收者一致 ✅

**4. import 累积说明**：plan 各 task 按「当前 import 块应为 X」给出累积状态，避免实现者遗漏。Task 6 的 `syscall`、Task 7 的 `internal/service` 在对应 step 明确追加。

无遗留问题。
