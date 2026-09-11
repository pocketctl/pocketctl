package daemon

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/pocketctl/pocketctl/internal/platform"
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

func TestRuntimeMigrationRecognizesDeletedLegacyPID(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	current, formerTemp, original := t.TempDir(), t.TempDir(), t.TempDir()
	lock, token := writeHeldRuntimeIdentity(t, formerTemp)
	defer lock.Close()
	if err := WriteState(&DaemonState{PID: os.Getpid(), RuntimeInstanceToken: token}); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(formerTemp, "daemon.pid")); err != nil {
		t.Fatal(err)
	}
	identity, running, err := runtimeIdentityAcross(current, formerTemp, original)
	if err != nil || !running || identity.Dir != formerTemp || identity.RuntimeToken != token {
		t.Fatalf("legacy recovery=(%+v, %v, %v)", identity, running, err)
	}
	// A live legacy owner, even without its PID, must block acquisition in the new location.
	if replacement, err := acquireRuntimeLocks([]string{current, formerTemp, original}); err == nil {
		_ = replacement.Close()
		t.Fatal("new daemon acquired ownership while legacy owner was alive")
	}
	probe, err := AcquireInstanceLockAt(filepath.Join(current, "daemon.lock"))
	if err != nil {
		t.Fatalf("failed migration leaked new lock: %v", err)
	}
	_ = probe.Close()
}

func TestRuntimeMigrationGuardsLegacyStartsUntilClose(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	dirs := []string{t.TempDir(), t.TempDir(), t.TempDir()}
	lock, err := acquireRuntimeLocks(dirs)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	owner, err := readInstanceOwner(filepath.Join(dirs[0], "daemon.lock"))
	if err != nil {
		t.Fatal(err)
	}
	if err := WriteState(&DaemonState{PID: os.Getpid(), RuntimeInstanceToken: owner.RuntimeToken}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dirs[0], "daemon.pid"), []byte(strconv.Itoa(os.Getpid())), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, dir := range dirs[1:] {
		legacy, err := AcquireInstanceLockAt(filepath.Join(dir, "daemon.lock"))
		if err == nil {
			_ = legacy.Close()
			t.Fatal("old binary could acquire legacy lock while new daemon owns runtime")
		}
		if !errors.Is(err, platform.ErrInstanceLockHeld) {
			t.Fatal(err)
		}
	}
	identity, running, err := runtimeIdentityAcross(dirs...)
	if err != nil || !running || identity.Dir != dirs[0] || identity.RuntimeToken != owner.RuntimeToken {
		t.Fatalf("migration aliases misidentified: (%+v, %v, %v)", identity, running, err)
	}
	// The primary PID + lock remain authoritative if the auxiliary state is
	// unavailable. Stale files in compatibility directories must not poison it.
	if err := os.Remove(StatePath()); err != nil {
		t.Fatal(err)
	}
	for _, dir := range dirs[1:] {
		if err := os.WriteFile(filepath.Join(dir, "daemon.pid"), []byte("old-corrupt-pid"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if identity, running, err := runtimeIdentityAcross(dirs...); err != nil || !running || identity.Dir != dirs[0] {
		t.Fatalf("compatibility aliases overrode primary authority: (%+v, %v, %v)", identity, running, err)
	}
	if err := lock.Close(); err != nil {
		t.Fatal(err)
	}
	if err := lock.Close(); err != nil {
		t.Fatalf("close must be idempotent: %v", err)
	}
	for _, dir := range dirs {
		probe, err := AcquireInstanceLockAt(filepath.Join(dir, "daemon.lock"))
		if err != nil {
			t.Fatalf("lock leaked after close: %v", err)
		}
		_ = probe.Close()
	}
}
