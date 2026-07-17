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

type ProcessSnapshot struct {
	PID        int
	Executable string
	Args       []string
	CWD        string
}

// ProcessInspector returns best-effort process metadata used to distinguish
// native terminal agents from launchers attached to a managed runtime.
type ProcessInspector interface {
	List() ([]ProcessSnapshot, error)
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

// SleepInhibitor 阻止系统进入休眠。Acquire 持有锁直到 Release 调用；
// daemon 崩溃/退出时锁随进程或线程状态自动失效（race-free，无需显式清理）。
// 仅 macOS/Windows 提供真实实现；其他平台返回 ErrUnsupported（受控降级）。
type SleepInhibitor interface {
	// Acquire 开始阻止休眠。幂等：重复 Acquire 由实现保证安全（no-op）。
	Acquire() error
	// Release 停止阻止休眠。幂等：未持有状态下 Release 不报错。
	Release() error
}

// PowerSource 报告当前电源状态。用于 keep-awake 的电池保护逻辑：
// 检测到电池供电时自动关闭抑制，避免电量耗尽导致强制关机。
type PowerSource interface {
	// IsOnBattery 返回 true 表示当前由电池供电；false 表示接外接电源。
	// 无法判定时返回 error（调用方应保守处理，不触发自动关闭）。
	IsOnBattery() (bool, error)
}

// 构造函数 New* 由 platform_unix.go / platform_windows.go 按平台实现，
// 本文件不提供默认实现（任一实际构建总有一个平台文件在场）。
