package daemon

import (
	"errors"
	"fmt"

	"github.com/pocketctl/pocketctl/internal/config"
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

const defaultRuntimeDir = "/tmp/pocketctl"

var (
	stopGracePeriod           = 5 * time.Second
	stopPollInterval          = 100 * time.Millisecond
	stopOwnershipSettlePeriod = 500 * time.Millisecond
)

func PIDPath() string {
	return filepath.Join(runtimeDir(), "daemon.pid")
}

func runtimeDir() string {
	if dir := os.Getenv("POCKETCTL_RUNTIME_DIR"); dir != "" {
		return dir
	}
	return defaultRuntimeDir
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
	home, err := config.HomeDir()
	if err != nil || home == "" {
		return filepath.Join(runtimeDir(), "logs")
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
	home, _ := config.HomeDir()
	return filepath.Join(home, ".pocketctl", "daemon.state")
}

func WritePID(pid int) error {
	if pid <= 0 {
		return fmt.Errorf("invalid pid %d", pid)
	}
	if err := os.MkdirAll(runtimeDir(), 0755); err != nil {
		return err
	}
	return os.WriteFile(PIDPath(), []byte(strconv.Itoa(pid)), 0644)
}

func ReadPID() (int, error) {
	data, err := os.ReadFile(PIDPath())
	if err != nil {
		return 0, fmt.Errorf("daemon not running (no pid file): %w", err)
	}
	var pid int
	if _, err := fmt.Sscanf(string(data), "%d", &pid); err != nil {
		return 0, fmt.Errorf("invalid pid file")
	}
	if pid <= 0 {
		return 0, fmt.Errorf("invalid pid file")
	}
	return pid, nil
}

// IsRunning checks if the daemon process is alive by reading the PID file
// and sending signal 0 to the process.
func IsRunning() (int, bool) {
	pid, running, err := RuntimeStatus()
	return pid, err == nil && running
}

// RuntimeStatus returns the authoritative pidfile PID and whether that exact
// PID owns the singleton lock. Missing state is certainly stopped; corrupt or
// unverifiable state returns ErrRuntimeStatusUncertain.
func RuntimeStatus() (int, bool, error) {
	pid, _, running, err := runtimeIdentityStatus()
	return pid, running, err
}

func runtimeIdentityStatus() (int, string, bool, error) {
	pid, err := ReadPID()
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			running, statusErr := runtimeStatusWhenPIDMissing(instanceLockOwner)
			return 0, "", running, statusErr
		}
		return 0, "", false, fmt.Errorf("%w: %v", ErrRuntimeStatusUncertain, err)
	}
	token, running, err := verifyRuntimeIdentitySnapshot(pid)
	return pid, token, running, err
}

func runtimeStatusWhenPIDMissing(
	snapshot func() (instanceOwner, bool, error),
) (bool, error) {
	_, held, err := snapshot()
	if err != nil {
		return false, fmt.Errorf("%w: verify missing pidfile against instance lock: %v", ErrRuntimeStatusUncertain, err)
	}
	if held {
		return false, fmt.Errorf("%w: daemon instance lock is held before pidfile publication", ErrRuntimeStatusUncertain)
	}
	return false, nil
}

// VerifyRuntimePID re-reads the pidfile around the owner probe so callers can
// validate a previously observed state snapshot without accepting a PID change.
func VerifyRuntimePID(expectedPID int) (bool, error) {
	_, running, err := verifyRuntimeIdentitySnapshot(expectedPID)
	return running, err
}

func verifyRuntimeIdentitySnapshot(expectedPID int) (string, bool, error) {
	if expectedPID <= 0 {
		return "", false, fmt.Errorf("%w: invalid expected pid %d", ErrRuntimeStatusUncertain, expectedPID)
	}
	before, err := ReadPID()
	if err != nil {
		return "", false, fmt.Errorf("%w: re-read pidfile before owner probe: %v", ErrRuntimeStatusUncertain, err)
	}
	if before != expectedPID {
		return "", false, fmt.Errorf("%w: pidfile changed from %d to %d", ErrRuntimeStatusUncertain, expectedPID, before)
	}
	owner, held, err := instanceLockOwner()
	if err != nil || !held {
		return "", false, err
	}
	if owner.PID != expectedPID {
		return "", false, instanceOwnerMismatchError(owner, expectedPID, "")
	}
	after, err := ReadPID()
	if err != nil {
		return "", false, fmt.Errorf("%w: re-read pidfile after owner probe: %v", ErrRuntimeStatusUncertain, err)
	}
	if after != expectedPID {
		return "", false, fmt.Errorf("%w: pidfile changed from %d to %d", ErrRuntimeStatusUncertain, expectedPID, after)
	}
	return owner.RuntimeToken, true, nil
}

// VerifyRuntimeIdentity applies the pidfile-before/owner/pidfile-after check to
// both PID and the per-lock-acquisition token persisted in DaemonState.
func VerifyRuntimeIdentity(expectedPID int, expectedToken string) (bool, error) {
	if expectedPID <= 0 || expectedToken == "" {
		return false, fmt.Errorf("%w: incomplete expected runtime identity", ErrRuntimeStatusUncertain)
	}
	before, err := ReadPID()
	if err != nil {
		return false, fmt.Errorf("%w: re-read pidfile before identity probe: %v", ErrRuntimeStatusUncertain, err)
	}
	if before != expectedPID {
		return false, fmt.Errorf("%w: pidfile changed from %d to %d", ErrRuntimeStatusUncertain, expectedPID, before)
	}
	matched, err := InstanceLockIdentityMatches(expectedPID, expectedToken)
	if err != nil || !matched {
		return matched, err
	}
	after, err := ReadPID()
	if err != nil {
		return false, fmt.Errorf("%w: re-read pidfile after identity probe: %v", ErrRuntimeStatusUncertain, err)
	}
	if after != expectedPID {
		return false, fmt.Errorf("%w: pidfile changed from %d to %d", ErrRuntimeStatusUncertain, expectedPID, after)
	}
	return true, nil
}

// Stop sends SIGTERM to the daemon, waits up to 5s for graceful exit,
// then sends SIGKILL if the process hasn't exited.
func Stop() error {
	pid, runtimeToken, running, statusErr := runtimeIdentityStatus()
	if statusErr != nil {
		return statusErr
	}
	if !running {
		return fmt.Errorf("daemon process not running")
	}
	intent, err := BeginExplicitStopTransaction()
	if err != nil {
		return fmt.Errorf("write stop intent: %w", err)
	}
	stoppedAny := false
	for attempts := 0; attempts < 4; attempts++ {
		stopped, stopErr := stopVerifiedRuntimeIdentity(
			pid,
			runtimeToken,
			VerifyRuntimeIdentity,
			func(pid int) error {
				return stopDaemonProcessWithIdentity(
					pid,
					runtimeToken,
					defaultProc,
					VerifyRuntimeIdentity,
					waitForDaemonProcessExit,
				)
			},
		)
		if stopErr != nil {
			return stopErr
		}
		stoppedAny = stoppedAny || stopped
		currentPID, currentToken, replaced, replacementErr := waitForReplacementIdentity(pid, runtimeToken)
		if replacementErr != nil {
			return replacementErr
		}
		if replaced {
			pid, runtimeToken = currentPID, currentToken
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

func stopVerifiedRuntimeIdentity(
	pid int,
	runtimeToken string,
	verify func(int, string) (bool, error),
	signal func(int) error,
) (bool, error) {
	verified, err := verify(pid, runtimeToken)
	if err != nil || !verified {
		return false, err
	}
	if err := signal(pid); err != nil {
		return false, err
	}
	return true, nil
}

func waitForReplacementIdentity(previousPID int, previousToken string) (int, string, bool, error) {
	deadline := time.Now().Add(stopOwnershipSettlePeriod)
	for time.Now().Before(deadline) {
		currentPID, currentToken, running, err := runtimeIdentityStatus()
		if err != nil {
			return 0, "", false, err
		}
		if running && (currentPID != previousPID || currentToken != previousToken) {
			return currentPID, currentToken, true, nil
		}
		time.Sleep(stopPollInterval)
	}
	return 0, "", false, nil
}

func stopDaemonProcessWithIdentity(
	pid int,
	runtimeToken string,
	proc platform.ProcessController,
	verify func(int, string) (bool, error),
	waitForExit func(int, platform.ProcessController) bool,
) error {
	verified, err := verify(pid, runtimeToken)
	if err != nil {
		return err
	}
	if !verified {
		return fmt.Errorf("%w: daemon identity disappeared before terminate", ErrRuntimeStatusUncertain)
	}
	if err := proc.Terminate(pid); err != nil {
		if !proc.IsAlive(pid) {
			return nil
		}
		verified, verifyErr := verify(pid, runtimeToken)
		if verifyErr != nil {
			return verifyErr
		}
		if !verified {
			return fmt.Errorf("%w: daemon identity changed after terminate failure", ErrRuntimeStatusUncertain)
		}
		if killErr := proc.Kill(pid); killErr != nil {
			return fmt.Errorf("terminate failed (%v) and kill failed: %w", err, killErr)
		}
		return nil
	}
	if waitForExit(pid, proc) {
		return nil
	}
	verified, err = verify(pid, runtimeToken)
	if err != nil {
		return err
	}
	if !verified {
		return fmt.Errorf("%w: daemon identity changed before fallback kill", ErrRuntimeStatusUncertain)
	}
	if err := proc.Kill(pid); err != nil {
		return fmt.Errorf("process did not exit after terminate and kill failed: %w", err)
	}
	return nil
}

func waitForDaemonProcessExit(pid int, proc platform.ProcessController) bool {
	deadline := time.Now().Add(stopGracePeriod)
	for time.Now().Before(deadline) {
		if !proc.IsAlive(pid) {
			return true
		}
		time.Sleep(stopPollInterval)
	}
	return !proc.IsAlive(pid)
}
