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
			// NOTE: do NOT remove StatePath() here — daemon.state carries the
			// persisted daemon_id, which must survive stop/start so the same
			// physical host keeps one stable ID. Removing it forces MachineID()
			// to re-derive the ID on next start, and on WSL2/macOS/Docker that
			// yields a DIFFERENT id (machine-id/MAC/hostname are unstable there),
			// so the relay sees the same host as two daemons (old=offline, new=online).
			return nil
		case <-ticker.C:
			// Check if process has exited
			if !defaultProc.IsAlive(pid) {
				// Process is gone — clean up
				os.Remove(PIDPath())
				// NOTE: keep StatePath() (see SIGKILL branch above) so the
				// daemon_id survives restarts.
				return nil
			}
		}
	}
}
