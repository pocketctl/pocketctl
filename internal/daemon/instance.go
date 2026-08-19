package daemon

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/pocketctl/pocketctl/internal/platform"
)

var (
	ErrRuntimeStatusUncertain = errors.New("daemon runtime status is uncertain")
	ErrInstanceOwnerMismatch  = errors.New("daemon instance owner does not match pidfile")
)

type instanceOwner struct {
	PID                  int    `json:"pid"`
	RuntimeToken         string `json:"runtime_token"`
	ProcessStartIdentity string `json:"process_start_identity,omitempty"`
}

var processStartIdentity = platform.ProcessStartIdentity

func instanceLockPath() string {
	dir, err := secureRuntimeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "daemon.lock")
}

// InstanceLockHeld non-destructively verifies that a daemon process owns the
// single-instance authority. A free lock is acquired only long enough to prove
// it is free, then immediately released.
func InstanceLockHeld() (bool, error) {
	return instanceLockHeldAt(instanceLockPath())
}

func instanceLockHeldAt(path string) (bool, error) {
	lock, err := defaultLocker.Acquire(path)
	if err != nil {
		if errors.Is(err, platform.ErrInstanceLockHeld) {
			return true, nil
		}
		return false, err
	}
	if err := lock.Close(); err != nil {
		return false, fmt.Errorf("release daemon instance lock probe: %w", err)
	}
	return false, nil
}

// InstanceLockOwnedBy verifies that the held singleton lock's owner metadata
// names expectedPID. A free lock is a certain "not running"; held but missing,
// corrupt, or mismatched metadata is uncertainty and must fail closed.
func InstanceLockOwnedBy(expectedPID int) (bool, error) {
	owner, held, err := instanceLockOwner()
	if err != nil || !held {
		return false, err
	}
	if owner.PID != expectedPID {
		return false, instanceOwnerMismatchError(owner, expectedPID, "")
	}
	return true, nil
}

// InstanceLockIdentityMatches binds a state snapshot to one lock acquisition,
// not merely to a PID that the operating system may later reuse.
func InstanceLockIdentityMatches(expectedPID int, expectedToken string) (bool, error) {
	return instanceLockIdentityMatchesAt(instanceLockPath(), expectedPID, expectedToken)
}

func instanceLockIdentityMatchesAt(path string, expectedPID int, expectedToken string) (bool, error) {
	if expectedToken == "" {
		return false, fmt.Errorf("%w: state has no runtime instance token", ErrRuntimeStatusUncertain)
	}
	owner, held, err := instanceLockOwnerAt(path)
	if err != nil || !held {
		return false, err
	}
	if owner.PID != expectedPID || owner.RuntimeToken != expectedToken {
		return false, instanceOwnerMismatchError(owner, expectedPID, expectedToken)
	}
	return true, nil
}

func instanceLockOwner() (instanceOwner, bool, error) {
	return instanceLockOwnerAt(instanceLockPath())
}

func instanceLockOwnerAt(path string) (instanceOwner, bool, error) {
	if path == "" {
		return instanceOwner{}, false, fmt.Errorf("%w: daemon instance lock path is unavailable", ErrRuntimeStatusUncertain)
	}
	return stableInstanceOwnerSnapshot(
		path,
		instanceLockHeldAt,
		readInstanceOwner,
		processStartIdentity,
	)
}

func stableInstanceOwnerSnapshot(
	path string,
	probe func(string) (bool, error),
	read func(string) (instanceOwner, error),
	queryProcessStartIdentity func(int) (string, error),
) (instanceOwner, bool, error) {
	held, err := probe(path)
	if err != nil {
		return instanceOwner{}, false, fmt.Errorf("%w: probe daemon instance lock: %v", ErrRuntimeStatusUncertain, err)
	}
	if !held {
		return instanceOwner{}, false, nil
	}
	first, err := read(path)
	if err != nil {
		return instanceOwner{}, false, fmt.Errorf("%w: read daemon instance owner: %v", ErrRuntimeStatusUncertain, err)
	}
	if err := verifyOwnerProcessStartIdentity(first, queryProcessStartIdentity); err != nil {
		return instanceOwner{}, false, err
	}
	held, err = probe(path)
	if err != nil {
		return instanceOwner{}, false, fmt.Errorf("%w: re-probe daemon instance lock: %v", ErrRuntimeStatusUncertain, err)
	}
	if !held {
		return instanceOwner{}, false, fmt.Errorf("%w: daemon instance owner exited during snapshot", ErrRuntimeStatusUncertain)
	}
	second, err := read(path)
	if err != nil {
		return instanceOwner{}, false, fmt.Errorf("%w: re-read daemon instance owner: %v", ErrRuntimeStatusUncertain, err)
	}
	if first != second {
		return instanceOwner{}, false, fmt.Errorf("%w: daemon instance owner changed during snapshot", ErrRuntimeStatusUncertain)
	}
	if err := verifyOwnerProcessStartIdentity(second, queryProcessStartIdentity); err != nil {
		return instanceOwner{}, false, err
	}
	return first, true, nil
}

func verifyOwnerProcessStartIdentity(
	owner instanceOwner,
	query func(int) (string, error),
) error {
	if owner.ProcessStartIdentity == "" {
		return fmt.Errorf(
			"%w: daemon instance owner metadata has no process start identity",
			ErrRuntimeStatusUncertain,
		)
	}
	currentIdentity, err := query(owner.PID)
	if err != nil {
		return fmt.Errorf(
			"%w: query process start identity for daemon owner: %w",
			ErrRuntimeStatusUncertain,
			err,
		)
	}
	if currentIdentity == "" {
		return fmt.Errorf(
			"%w: current process start identity for daemon owner is empty",
			ErrRuntimeStatusUncertain,
		)
	}
	if currentIdentity != owner.ProcessStartIdentity {
		return fmt.Errorf(
			"%w: daemon owner metadata does not match the current OS process instance",
			ErrRuntimeStatusUncertain,
		)
	}
	return nil
}

func instanceOwnerMismatchError(owner instanceOwner, expectedPID int, expectedToken string) error {
	return fmt.Errorf(
		"%w: %w: lock owner pid %d, expected pid %d, runtime token match=%t",
		ErrRuntimeStatusUncertain, ErrInstanceOwnerMismatch,
		owner.PID, expectedPID, owner.RuntimeToken == expectedToken,
	)
}

// CurrentInstanceToken returns the token written by this process while it owns
// the singleton lock. Callers use it in the initial daemon state snapshot.
func CurrentInstanceToken() (string, error) {
	owner, err := readInstanceOwner(instanceLockPath())
	if err != nil {
		return "", err
	}
	if owner.PID != os.Getpid() {
		return "", instanceOwnerMismatchError(owner, os.Getpid(), "")
	}
	return owner.RuntimeToken, nil
}

// AcquireInstanceLock takes an exclusive, non-blocking lock ensuring only one
// daemon process runs per host. PR2: delegates to platform.InstanceLocker
// (was direct unix.Flock in the former instance_unix.go). The lock is released
// when the returned Closer is closed — and, critically, is ALSO released
// automatically by the OS the moment the process dies (even via SIGKILL or a
// crash), making it race-free vs the PID-file check.
//
// Public API unchanged — main.go calls daemon.AcquireInstanceLock() with zero
// modification. Replaces the former instance_unix.go / instance_windows.go
// build-tag split (platform now owns the platform split).
func AcquireInstanceLock() (io.Closer, error) {
	dir, err := secureRuntimeDir()
	if err != nil {
		return nil, err
	}
	return AcquireInstanceLockAt(filepath.Join(dir, "daemon.lock"))
}

// AcquireInstanceLockAt is the path-selectable form used by restart ownership
// handoff and process-level tests.
func AcquireInstanceLockAt(path string) (io.Closer, error) {
	if path == "" {
		return nil, fmt.Errorf("daemon instance lock path is unavailable")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("create %s: %w", filepath.Dir(path), err)
	}
	lock, err := defaultLocker.Acquire(path)
	if err != nil {
		return nil, err // platform 已包装 "another pocketctl daemon is already running..."
	}
	startIdentity, err := processStartIdentity(os.Getpid())
	if err != nil {
		_ = lock.Close()
		return nil, fmt.Errorf("read current process start identity: %w", err)
	}
	if startIdentity == "" {
		_ = lock.Close()
		return nil, fmt.Errorf("read current process start identity: empty identity")
	}
	token, err := newRuntimeInstanceToken()
	if err != nil {
		_ = lock.Close()
		return nil, fmt.Errorf("generate daemon runtime token: %w", err)
	}
	if err := writeInstanceOwner(path, instanceOwner{
		PID:                  os.Getpid(),
		RuntimeToken:         token,
		ProcessStartIdentity: startIdentity,
	}); err != nil {
		_ = lock.Close()
		return nil, fmt.Errorf("write daemon instance owner: %w", err)
	}
	return lock, nil
}

func newRuntimeInstanceToken() (string, error) {
	var token [16]byte
	if _, err := rand.Read(token[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(token[:]), nil
}

func writeInstanceOwner(path string, owner instanceOwner) error {
	if owner.PID <= 0 {
		return fmt.Errorf("invalid owner pid %d", owner.PID)
	}
	if owner.RuntimeToken == "" {
		return fmt.Errorf("missing owner runtime token")
	}
	if owner.ProcessStartIdentity == "" {
		return fmt.Errorf("missing owner process start identity")
	}
	data, err := json.Marshal(owner)
	if err != nil {
		return err
	}
	data = append(data, '\n')
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if err := f.Chmod(0o600); err != nil {
		_ = f.Close()
		return err
	}
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		return err
	}
	return f.Close()
}

func readInstanceOwner(path string) (instanceOwner, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return instanceOwner{}, err
	}
	if len(data) == 0 || len(data) > 4<<10 {
		return instanceOwner{}, fmt.Errorf("invalid owner metadata size %d", len(data))
	}
	var owner instanceOwner
	if err := json.Unmarshal(data, &owner); err != nil {
		return instanceOwner{}, err
	}
	if owner.PID <= 0 {
		return instanceOwner{}, fmt.Errorf("invalid owner pid %d", owner.PID)
	}
	if owner.RuntimeToken == "" {
		return instanceOwner{}, fmt.Errorf("missing owner runtime token")
	}
	return owner, nil
}
