package daemon

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/pocketctl/pocketctl/internal/platform"
)

// PR2 platform defaults: daemon 进程控制 + 单实例锁走 platform interface
// (was direct syscall signal / unix.Flock). 公共 API(IsRunning/Stop/
// AcquireInstanceLock) 签名不变,main.go 调用点零改。
var (
	defaultProc   = platform.NewProcessController()
	defaultLocker = platform.NewInstanceLocker()
)

const pidDir = "/tmp/pocketctl"

var (
	stopGracePeriod           = 5 * time.Second
	stopPollInterval          = 100 * time.Millisecond
	stopOwnershipSettlePeriod = 500 * time.Millisecond
)

func PIDPath() string {
	return filepath.Join(pidDir, "daemon.pid")
}

// logPrefix is the filename prefix for dated daemon log files
// (<prefix>-YYYY-MM-DD.log).
const logPrefix = "daemon"

// LogPrefix returns the dated-log filename prefix.
func LogPrefix() string { return logPrefix }

// LogDir returns the directory holding daemon log files, split by date:
// ~/.pocketctl/logs. Falls back to /tmp/pocketctl/logs only if the home
// directory can't be resolved.
func LogDir() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return filepath.Join(pidDir, "logs")
	}
	return filepath.Join(home, ".pocketctl", "logs")
}

// LogPath returns the path of today's daemon log file
// (~/.pocketctl/logs/daemon-YYYY-MM-DD.log). Kept for callers that want "the
// current log" (status banner, `daemon logs`).
func LogPath() string {
	return filepath.Join(LogDir(), logPrefix+"-"+time.Now().Format("2006-01-02")+".log")
}

// ServiceBootLogPath is a STATIC path (~/.pocketctl/logs/service-boot.log) used
// as the launchd/systemd StandardOut/Error target. It must be static because a
// service unit's log path is baked in at install time and can't rotate daily;
// it only captures early-boot stdout/stderr before the daemon installs its own
// date-rotating logger (which then owns fd 1/2 in foreground mode).
func ServiceBootLogPath() string {
	return filepath.Join(LogDir(), "service-boot.log")
}

func StatePath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".pocketctl", "daemon.state")
}

func WritePID(pid int) error {
	if err := os.MkdirAll(pidDir, 0755); err != nil {
		return err
	}
	return os.WriteFile(PIDPath(), []byte(strconv.Itoa(pid)), 0644)
}

func ReadPID() (int, error) {
	data, err := os.ReadFile(PIDPath())
	if err != nil {
		return 0, fmt.Errorf("daemon not running (no pid file)")
	}
	var pid int
	if _, err := fmt.Sscanf(string(data), "%d", &pid); err != nil {
		return 0, fmt.Errorf("invalid pid file")
	}
	return pid, nil
}

// IsRunning checks if the daemon process is alive by reading the PID file
// and sending signal 0 to the process.
func IsRunning() (int, bool) {
	pid, err := ReadPID()
	if err != nil {
		return 0, false
	}
	// PR2: 进程存活检查走 platform.ProcessController（was syscall signal 0）
	return pid, defaultProc.IsAlive(pid)
}

// Stop sends SIGTERM to the daemon, waits up to 5s for graceful exit,
// then sends SIGKILL if the process hasn't exited.
func Stop() error {
	intent, err := BeginExplicitStopTransaction()
	if err != nil {
		return fmt.Errorf("write stop intent: %w", err)
	}
	pid, err := ReadPID()
	if err != nil {
		if cleanupErr := CleanupOpenCodeServeAfterForcedStop(); cleanupErr != nil {
			return cleanupErr
		}
		if completeErr := CompleteExplicitStopTransaction(intent.Token); completeErr != nil {
			return completeErr
		}
		return err
	}
	stoppedAny := false
	for attempts := 0; attempts < 4; attempts++ {
		if defaultProc.IsAlive(pid) {
			if err := stopDaemonProcess(pid, defaultProc); err != nil {
				return err
			}
			stoppedAny = true
		}
		if current, ok := waitForReplacementPID(pid); ok {
			pid = current
			continue
		}
		break
	}
	_ = os.Remove(PIDPath())
	if err := CleanupOpenCodeServeAfterForcedStop(); err != nil {
		return fmt.Errorf("daemon stopped but opencode cleanup failed: %w", err)
	}
	if err := CompleteExplicitStopTransaction(intent.Token); err != nil {
		return err
	}
	if !stoppedAny {
		return fmt.Errorf("daemon process not running (stale pid file removed)")
	}
	return nil
}

func waitForReplacementPID(previous int) (int, bool) {
	deadline := time.Now().Add(stopOwnershipSettlePeriod)
	for time.Now().Before(deadline) {
		if current, err := ReadPID(); err == nil && current != previous && defaultProc.IsAlive(current) {
			return current, true
		}
		time.Sleep(stopPollInterval)
	}
	return 0, false
}

func stopDaemonProcess(pid int, proc platform.ProcessController) error {
	if err := proc.Terminate(pid); err != nil {
		if !proc.IsAlive(pid) {
			return nil
		}
		if killErr := proc.Kill(pid); killErr != nil {
			return fmt.Errorf("terminate failed (%v) and kill failed: %w", err, killErr)
		}
		return nil
	}
	deadline := time.Now().Add(stopGracePeriod)
	for time.Now().Before(deadline) {
		if !proc.IsAlive(pid) {
			return nil
		}
		time.Sleep(stopPollInterval)
	}
	if !proc.IsAlive(pid) {
		return nil
	}
	if err := proc.Kill(pid); err != nil {
		return fmt.Errorf("process did not exit after terminate and kill failed: %w", err)
	}
	return nil
}
