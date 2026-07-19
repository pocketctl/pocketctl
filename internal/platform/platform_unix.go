//go:build !windows

package platform

import (
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"

	"github.com/creack/pty"
	"github.com/pocketctl/pocketctl/internal/service"
	gopsprocess "github.com/shirou/gopsutil/v3/process"
	"golang.org/x/sys/unix"
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

// NewIPCListener 返回 Unix domain socket IPC listener。
func NewIPCListener() IPCListener { return unixIPCListener{} }

type unixIPCListener struct{}

func (unixIPCListener) Listen(name string) (net.Listener, error) {
	// 确保父目录存在(DefaultPath 嵌套 pocketctl/ 子目录,net.Listen 需父目录)。
	// PR5 prod bugfix: PR1 Task3 遗漏 MkdirAll,子目录不存在时 net.Listen 失败。
	if err := os.MkdirAll(filepath.Dir(name), 0o755); err != nil {
		return nil, fmt.Errorf("create ipc socket dir: %w", err)
	}
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

// NewInstanceLocker 返回基于 flock 的单实例锁。行为对齐现有 daemon.AcquireInstanceLock
// （PR2 接入时由 daemon 传入同样的锁文件路径，无缝替换）。
func NewInstanceLocker() InstanceLocker { return unixLocker{} }

// NewLogicalLocker uses the supplied filesystem path for flock on Unix. The
// logical ID is used by platforms whose kernel locks are not path-backed.
func NewLogicalLocker(_ string) InstanceLocker { return unixLocker{} }

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

// NewProcessController 返回基于 Unix signal 的进程控制器。对齐现有 daemon.pid.go
// 的 IsRunning/Stop 逻辑（PR2 接入时替换）。
func NewProcessController() ProcessController { return unixProcessController{} }

func NewProcessInspector() ProcessInspector { return unixProcessInspector{} }

type unixProcessInspector struct{}

func (unixProcessInspector) List() ([]ProcessSnapshot, error) {
	processes, err := gopsprocess.Processes()
	if err != nil {
		return nil, err
	}
	out := make([]ProcessSnapshot, 0, len(processes))
	for _, process := range processes {
		args, _ := process.CmdlineSlice()
		cwd, _ := process.Cwd()
		executable, _ := process.Exe()
		out = append(out, ProcessSnapshot{PID: int(process.Pid), Executable: executable, Args: args, CWD: cwd})
	}
	return out, nil
}

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
