package daemon

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

func TestRuntimeIdentityAcrossUsesVerifiedLegacyOwner(t *testing.T) {
	currentDir := t.TempDir()
	legacyDir := t.TempDir()
	lock, token := writeHeldRuntimeIdentity(t, legacyDir)
	defer lock.Close()

	identity, running, err := runtimeIdentityAcross(currentDir, legacyDir)
	if err != nil {
		t.Fatal(err)
	}
	if !running || identity.PID != os.Getpid() || identity.RuntimeToken != token || identity.Dir != legacyDir {
		t.Fatalf("runtimeIdentityAcross = (%+v, %v), want verified legacy owner", identity, running)
	}
}

func TestRuntimeIdentityAcrossFailsClosedWhenCurrentAndLegacyAreBothRunning(t *testing.T) {
	currentDir := t.TempDir()
	legacyDir := t.TempDir()
	currentLock, _ := writeHeldRuntimeIdentity(t, currentDir)
	defer currentLock.Close()
	legacyLock, _ := writeHeldRuntimeIdentity(t, legacyDir)
	defer legacyLock.Close()

	identity, running, err := runtimeIdentityAcross(currentDir, legacyDir)
	if identity != (runtimeIdentity{}) || running || !errors.Is(err, ErrRuntimeStatusUncertain) {
		t.Fatalf("runtimeIdentityAcross = (%+v, %v, %v), want duplicate-runtime uncertainty", identity, running, err)
	}
}

func writeHeldRuntimeIdentity(t *testing.T, dir string) (io.Closer, string) {
	t.Helper()
	lockPath := filepath.Join(dir, "daemon.lock")
	lock, err := AcquireInstanceLockAt(lockPath)
	if err != nil {
		t.Fatal(err)
	}
	owner, err := readInstanceOwner(lockPath)
	if err != nil {
		_ = lock.Close()
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "daemon.pid"), []byte(strconv.Itoa(owner.PID)), 0o600); err != nil {
		_ = lock.Close()
		t.Fatal(err)
	}
	return lock, owner.RuntimeToken
}
