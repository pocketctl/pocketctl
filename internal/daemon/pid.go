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

var (
	stopGracePeriod           = 5 * time.Second
	stopPollInterval          = 100 * time.Millisecond
	stopOwnershipSettlePeriod = 500 * time.Millisecond
)

// RuntimeDir returns this user's private runtime directory, creating and
// hardening it (0700, euid-owned, non-symlink) when necessary. Callers that
// only need a best-effort path for reads may use PIDPath()/instanceLockPath()
// which degrade to "" when the secure dir cannot be established.
func RuntimeDir() (string, error) {
	return secureRuntimeDir()
}

func PIDPath() string {
	dir, err := secureRuntimeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "daemon.pid")
}

// logPrefix is the filename prefix for dated daemon log files
// (<prefix>-YYYY-MM-DD.log).
const logPrefix = "daemon"

// LogPrefix returns the dated-log filename prefix.
func LogPrefix() string { return logPrefix }

// LogDir returns the directory holding daemon log files, split by date:
// ~/.pocketctl/logs. Falls back to the private runtime dir's logs/ only if
// the home directory can't be resolved.
func LogDir() string {
	home, err := config.HomeDir()
	if err != nil || home == "" {
		if dir, dirErr := secureRuntimeDir(); dirErr == nil {
			return filepath.Join(dir, "logs")
		}
		return filepath.Join(os.TempDir(), fmt.Sprintf("pocketctl-%d-logs", os.Getuid()))
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
	dir, err := secureRuntimeDir()
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "daemon.pid"), []byte(strconv.Itoa(pid)), 0o600)
}

func ReadPID() (int, error) {
	return readPIDAt(PIDPath())
}

func readPIDAt(path string) (int, error) {
	if path == "" {
		return 0, fmt.Errorf("daemon not running (pid path unavailable)")
	}
	data, err := os.ReadFile(path)
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

// RuntimeStatus returns the verified singleton owner. A missing PID file can
// be recovered from matching lock and state identities without rewriting it.
// A free lock is stopped; unverifiable ownership fails closed.
func RuntimeStatus() (int, bool, error) {
	pid, _, running, err := runtimeIdentityStatus()
	return pid, running, err
}

type runtimeIdentity struct {
	PID          int
	RuntimeToken string
	Dir          string
}

func runtimeIdentityStatus() (int, string, bool, error) {
	dirs, err := runtimeDirectories()
	if err != nil {
		return 0, "", false, err
	}
	identity, running, err := runtimeIdentityAcross(dirs...)
	return identity.PID, identity.RuntimeToken, running, err
}

func runtimeDirectories() ([]string, error) {
	currentDir, err := secureRuntimeDir()
	if err != nil {
		return nil, err
	}
	legacyDirs, err := legacyRuntimeDirs()
	if err != nil {
		return nil, fmt.Errorf("%w: validate legacy runtime directory: %v", ErrRuntimeStatusUncertain, err)
	}
	dirs := []string{currentDir}
	for _, dir := range legacyDirs {
		if dir != currentDir {
			dirs = append(dirs, dir)
		}
	}
	return dirs, nil
}

func runtimeIdentityAcross(dirs ...string) (runtimeIdentity, bool, error) {
	var result runtimeIdentity
	running := false
	for _, dir := range dirs {
		if dir == "" {
			continue
		}
		if running {
			// A compatibility lock held by the already verified primary is an
			// alias, not a second runtime. Its old pidfile is not authoritative.
			owner, held, err := instanceLockOwnerAt(filepath.Join(dir, "daemon.lock"))
			if err != nil {
				return runtimeIdentity{}, false, err
			}
			if !held {
				continue
			}
			if owner.PID != result.PID || owner.RuntimeToken != result.RuntimeToken {
				return runtimeIdentity{}, false, fmt.Errorf("%w: current and legacy daemon runtime locks are both held by different instances", ErrRuntimeStatusUncertain)
			}
			continue
		}
		identity, active, err := runtimeIdentityStatusAt(dir)
		if err != nil {
			return runtimeIdentity{}, false, err
		}
		if active {
			result = identity
			running = true
		} else {
			result = identity
		}
	}
	return result, running, nil
}

func runtimeIdentityStatusAt(dir string) (runtimeIdentity, bool, error) {
	pidPath := filepath.Join(dir, "daemon.pid")
	lockPath := filepath.Join(dir, "daemon.lock")
	pid, err := readPIDAt(pidPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			_, held, statusErr := instanceLockOwnerAt(lockPath)
			if statusErr != nil || !held {
				return runtimeIdentity{}, false, statusErr
			}
			owner, recoveryErr := verifiedRuntimeOwnerFromStateAt(dir)
			if recoveryErr != nil {
				return runtimeIdentity{}, false, fmt.Errorf("%w: pidfile missing; cannot verify daemon from instance lock and state: %v", ErrRuntimeStatusUncertain, recoveryErr)
			}
			return runtimeIdentity{PID: owner.PID, RuntimeToken: owner.RuntimeToken, Dir: dir}, true, nil
		}
		return runtimeIdentity{}, false, fmt.Errorf("%w: %v", ErrRuntimeStatusUncertain, err)
	}
	token, running, err := verifyRuntimeIdentitySnapshotAt(dir, pid)
	if errors.Is(err, ErrInstanceOwnerMismatch) {
		owner, recoveryErr := verifiedRuntimeOwnerFromStateAt(dir)
		if recoveryErr != nil {
			return runtimeIdentity{PID: pid, Dir: dir}, false, recoveryErr
		}
		return runtimeIdentity{PID: owner.PID, RuntimeToken: owner.RuntimeToken, Dir: dir}, true, nil
	}
	return runtimeIdentity{PID: pid, RuntimeToken: token, Dir: dir}, running, err
}

// verifiedRuntimeOwnerFromState recovers from a missing or stale pidfile when the
// live lock owner and the daemon state independently name the same per-run
// identity. The lock snapshot verifies the owner's OS process-start identity,
// so this cannot turn a reused PID into an authorized daemon.
func verifiedRuntimeOwnerFromState() (instanceOwner, error) {
	dir, err := secureRuntimeDir()
	if err != nil {
		return instanceOwner{}, err
	}
	return verifiedRuntimeOwnerFromStateAt(dir)
}

func verifiedRuntimeOwnerFromStateAt(dir string) (instanceOwner, error) {
	lockPath := filepath.Join(dir, "daemon.lock")
	owner, held, err := instanceLockOwnerAt(lockPath)
	if err != nil {
		return instanceOwner{}, err
	}
	if !held {
		return instanceOwner{}, fmt.Errorf("%w: daemon instance lock was released during pidfile recovery", ErrRuntimeStatusUncertain)
	}
	state, err := ReadState()
	if err != nil {
		return instanceOwner{}, fmt.Errorf("%w: read daemon state for pidfile recovery: %v", ErrRuntimeStatusUncertain, err)
	}
	if state.PID != owner.PID || state.RuntimeInstanceToken != owner.RuntimeToken {
		return instanceOwner{}, fmt.Errorf("%w: daemon state does not match the verified instance owner", ErrRuntimeStatusUncertain)
	}
	matched, err := instanceLockIdentityMatchesAt(lockPath, owner.PID, owner.RuntimeToken)
	if err != nil {
		return instanceOwner{}, err
	}
	if !matched {
		return instanceOwner{}, fmt.Errorf("%w: daemon instance owner changed during pidfile recovery", ErrRuntimeStatusUncertain)
	}
	return owner, nil
}

// VerifyRuntimePID re-reads the pidfile around the owner probe so callers can
// validate a previously observed state snapshot without accepting a PID change.
func VerifyRuntimePID(expectedPID int) (bool, error) {
	pid, _, running, err := runtimeIdentityStatus()
	if err != nil || !running {
		return false, err
	}
	if pid != expectedPID {
		return false, fmt.Errorf("%w: runtime owner pid %d, expected %d", ErrRuntimeStatusUncertain, pid, expectedPID)
	}
	return true, nil
}

func verifyRuntimeIdentitySnapshot(expectedPID int) (string, bool, error) {
	dir, err := secureRuntimeDir()
	if err != nil {
		return "", false, err
	}
	return verifyRuntimeIdentitySnapshotAt(dir, expectedPID)
}

func verifyRuntimeIdentitySnapshotAt(dir string, expectedPID int) (string, bool, error) {
	if expectedPID <= 0 {
		return "", false, fmt.Errorf("%w: invalid expected pid %d", ErrRuntimeStatusUncertain, expectedPID)
	}
	pidPath := filepath.Join(dir, "daemon.pid")
	lockPath := filepath.Join(dir, "daemon.lock")
	before, err := readPIDAt(pidPath)
	if err != nil {
		return "", false, fmt.Errorf("%w: re-read pidfile before owner probe: %v", ErrRuntimeStatusUncertain, err)
	}
	if before != expectedPID {
		return "", false, fmt.Errorf("%w: pidfile changed from %d to %d", ErrRuntimeStatusUncertain, expectedPID, before)
	}
	owner, held, err := instanceLockOwnerAt(lockPath)
	if err != nil || !held {
		return "", false, err
	}
	if owner.PID != expectedPID {
		return "", false, instanceOwnerMismatchError(owner, expectedPID, "")
	}
	after, err := readPIDAt(pidPath)
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
	pid, token, running, err := runtimeIdentityStatus()
	if err != nil || !running {
		return false, err
	}
	if pid != expectedPID || token != expectedToken {
		return false, instanceOwnerMismatchError(instanceOwner{PID: pid, RuntimeToken: token}, expectedPID, expectedToken)
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
	removeRuntimePIDFiles()
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

func removeRuntimePIDFiles() {
	dirs, err := runtimeDirectories()
	if err != nil {
		return
	}
	for _, dir := range dirs {
		_ = os.Remove(filepath.Join(dir, "daemon.pid"))
	}
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
