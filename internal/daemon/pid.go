package daemon

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
	"time"
)

const pidDir = "/tmp/pocketctl"

func PIDPath() string {
	return filepath.Join(pidDir, "daemon.pid")
}

func LogPath() string {
	return filepath.Join(pidDir, "daemon.log")
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

// Stop sends SIGTERM to the daemon, waits up to 5s for graceful exit,
// then sends SIGKILL if the process hasn't exited.
func Stop() error {
	pid, err := ReadPID()
	if err != nil {
		return err
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return fmt.Errorf("find process: %w", err)
	}

	// Check if process is actually running
	if err := proc.Signal(syscall.Signal(0)); err != nil {
		os.Remove(PIDPath())
		return fmt.Errorf("daemon process not running (stale pid file removed)")
	}

	// Send SIGTERM
	if err := proc.Signal(syscall.SIGTERM); err != nil {
		return fmt.Errorf("send SIGTERM: %w", err)
	}

	// Wait for process to exit with timeout
	deadline := time.After(5 * time.Second)
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-deadline:
			// Process didn't exit in time, SIGKILL it
			if err := proc.Signal(syscall.SIGKILL); err != nil {
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
			if err := proc.Signal(syscall.Signal(0)); err != nil {
				// Process is gone — clean up
				os.Remove(PIDPath())
				// NOTE: keep StatePath() (see SIGKILL branch above) so the
				// daemon_id survives restarts.
				return nil
			}
		}
	}
}
