//go:build windows

package platform

import (
	"fmt"
	"net"
	"os"
	"os/exec"
	"syscall"

	"github.com/Microsoft/go-winio"
	gopsprocess "github.com/shirou/gopsutil/v3/process"
	"golang.org/x/sys/windows"
)

// NewPTYProvider 返回 Windows PTY provider（PR1 stub）。
// ConPTY 真实实现见 PR4；PR1 全部返回 ErrUnsupported，调用方降级处理。
func NewPTYProvider() PTYProvider { return windowsPTYProvider{} }

func NewProcessInspector() ProcessInspector { return windowsProcessInspector{} }

type windowsProcessInspector struct{}

func (windowsProcessInspector) List() ([]ProcessSnapshot, error) {
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

type windowsPTYProvider struct{}

func (windowsPTYProvider) Start(*exec.Cmd, *Size) (PTY, error) {
	return nil, ErrUnsupported
}

// NewIPCListener 返回 Windows named pipe IPC listener。
// PR4: 用 go-winio ListenPipe,语义对齐 unix socket(本地、ACL、不占端口)。
func NewIPCListener() IPCListener { return windowsIPCListener{} }

type windowsIPCListener struct{}

func (windowsIPCListener) Listen(name string) (net.Listener, error) {
	sid, err := currentWindowsUserSID()
	if err != nil {
		return nil, fmt.Errorf("resolve current user SID for named pipe: %w", err)
	}
	config := &winio.PipeConfig{SecurityDescriptor: windowsPipeSecurityDescriptor(sid)}
	ln, err := winio.ListenPipe(name, config)
	if err != nil {
		return nil, fmt.Errorf("listen named pipe: %w", err)
	}
	return ln, nil
}

func windowsPipeSecurityDescriptor(userSID string) string {
	// Protected DACL: only LocalSystem and the daemon's current user can open
	// the pipe. In particular, do not inherit the Windows default named-pipe ACL,
	// which can include broader local principals depending on the host policy.
	return "D:P(A;;GA;;;SY)(A;;GA;;;" + userSID + ")"
}

func (windowsIPCListener) DefaultPath(name string) string {
	return `\\.\pipe\pocketctl-` + name
}

// NewInstanceLocker 返回基于全局命名 Mutex 的单实例锁。
// PR4: 替代 PR1 stub。Global\pocketctl-daemon 跨进程互斥,进程退出 OS 自动释放
// (race-free,等价 Unix flock)。
func NewInstanceLocker() InstanceLocker { return windowsLocker{} }

// NewLogicalLocker preserves the legacy fixed-name daemon instance mutex while
// providing an alias-independent, per-user kernel mutex for a logical lock.
func NewLogicalLocker(logicalID string) InstanceLocker {
	return windowsLogicalLocker{logicalID: logicalID}
}

type windowsLocker struct{}

type windowsLogicalLocker struct{ logicalID string }

var currentWindowsUserSID = func() (string, error) {
	token, err := windows.OpenCurrentProcessToken()
	if err != nil {
		return "", fmt.Errorf("open current process token: %w", err)
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil {
		return "", fmt.Errorf("read current token user: %w", err)
	}
	if user == nil || user.User.Sid == nil {
		return "", fmt.Errorf("current token has no user SID")
	}
	sid := user.User.Sid.String()
	if sid == "" {
		return "", fmt.Errorf("format current user SID")
	}
	return sid, nil
}

func (l windowsLogicalLocker) mutexName(_ string) (string, error) {
	sid, err := currentWindowsUserSID()
	if err != nil {
		return "", fmt.Errorf("resolve current user SID for logical lock %q: %w", l.logicalID, err)
	}
	return logicalLockKernelName(l.logicalID, sid)
}

func (l windowsLogicalLocker) Acquire(path string) (Lock, error) {
	mutexName, err := l.mutexName(path)
	if err != nil {
		return nil, err
	}
	name := windows.StringToUTF16Ptr(mutexName)
	handle, err := windows.CreateMutex(nil, false, name)
	if err != nil {
		if err == windows.ERROR_ALREADY_EXISTS {
			if handle != 0 {
				_ = windows.CloseHandle(handle)
			}
			return nil, fmt.Errorf("another process holds logical lock %q", l.logicalID)
		}
		return nil, fmt.Errorf("create logical mutex %q: %w", l.logicalID, err)
	}
	return &mutexLock{handle: handle}, nil
}

func (windowsLocker) Acquire(path string) (Lock, error) {
	// path 是 Unix 锁文件路径语义;Windows 忽略它,用固定 Global mutex 名
	// (pocketctl 单例是 per-machine,不 per-path)。
	name := windows.StringToUTF16Ptr(`Global\pocketctl-daemon`)
	handle, err := windows.CreateMutex(nil, false, name)
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

// NewProcessController 返回 Windows 进程控制器（PR1 stub）。
// PR4 实现：IsAlive=OpenProcess，Kill=TerminateProcess，Terminate=控制通道命令。
func NewProcessController() ProcessController { return windowsProcessController{} }

type windowsProcessController struct{}

func (windowsProcessController) IsAlive(pid int) bool {
	// OpenProcess 成功即存活;进程已退出 → OpenProcess 失败 → false。
	// Windows 无 Unix zombie(进程退出即消失),检测可靠。
	handle, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return false
	}
	_ = windows.CloseHandle(handle)
	return true
}

func (windowsProcessController) Kill(pid int) error {
	handle, err := windows.OpenProcess(windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		return fmt.Errorf("open process: %w", err)
	}
	defer windows.CloseHandle(handle)
	if err := windows.TerminateProcess(handle, 1); err != nil {
		return fmt.Errorf("terminate process: %w", err)
	}
	return nil
}

// ControlPipeName 返回 daemon 控制通道 named pipe 名(基于 pid)。
// daemon 启动开此 pipe;ProcessController.Terminate(pid) 连它发 stop。
func ControlPipeName(pid int) string {
	return fmt.Sprintf(`\\.\pipe\pocketctl-control-%d`, pid)
}

func (windowsProcessController) Terminate(pid int) error {
	// 连 daemon 控制通道 named pipe,发 stop(优雅退出)。
	// daemon 不在/pipe 不存在 → 错误(调用方 daemon.Stop 会 fallback Kill)。
	conn, err := winio.DialPipe(ControlPipeName(pid), nil)
	if err != nil {
		return fmt.Errorf("dial control pipe (daemon not running?): %w", err)
	}
	defer conn.Close()
	if _, err := conn.Write([]byte("stop\n")); err != nil {
		return fmt.Errorf("send stop: %w", err)
	}
	return nil
}

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

// NewServiceManager 返回 Windows 服务管理器（PR1 stub）。PR4 实现 Windows Service（SCM）。
func NewServiceManager() ServiceManager { return windowsServiceManager{} }

type windowsServiceManager struct{}

func (windowsServiceManager) Install(ServiceOpts) error      { return ErrUnsupported }
func (windowsServiceManager) Uninstall() error               { return ErrUnsupported }
func (windowsServiceManager) Status() (ServiceStatus, error) { return ServiceStatus{}, ErrUnsupported }
