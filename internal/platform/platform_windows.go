//go:build windows

package platform

import (
	"fmt"
	"net"
	"os"
	"os/exec"
	"syscall"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

// NewPTYProvider 返回 Windows PTY provider（PR1 stub）。
// ConPTY 真实实现见 PR4；PR1 全部返回 ErrUnsupported，调用方降级处理。
func NewPTYProvider() PTYProvider { return windowsPTYProvider{} }

type windowsPTYProvider struct{}

func (windowsPTYProvider) Start(*exec.Cmd, *Size) (PTY, error) {
	return nil, ErrUnsupported
}

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

// NewInstanceLocker 返回基于全局命名 Mutex 的单实例锁。
// PR4: 替代 PR1 stub。Global\pocketctl-daemon 跨进程互斥,进程退出 OS 自动释放
// (race-free,等价 Unix flock)。
func NewInstanceLocker() InstanceLocker { return windowsLocker{} }

type windowsLocker struct{}

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

func (windowsProcessController) IsAlive(int) bool    { return false }
func (windowsProcessController) Terminate(int) error { return ErrUnsupported }
func (windowsProcessController) Kill(int) error      { return ErrUnsupported }

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
