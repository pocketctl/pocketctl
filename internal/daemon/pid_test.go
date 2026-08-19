package daemon

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/platform"
)

func TestPIDUsesConfiguredRuntimeDirectory(t *testing.T) {
	runtimeDir := t.TempDir()
	t.Setenv("POCKETCTL_RUNTIME_DIR", runtimeDir)

	if err := WritePID(12345); err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(runtimeDir, "daemon.pid")
	if PIDPath() != want {
		t.Fatalf("PIDPath()=%q want %q", PIDPath(), want)
	}
	data, err := os.ReadFile(want)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "12345" {
		t.Fatalf("pid=%q want 12345", data)
	}
}

func TestPIDRejectsNonPositiveValues(t *testing.T) {
	runtimeDir := t.TempDir()
	t.Setenv("POCKETCTL_RUNTIME_DIR", runtimeDir)
	for _, pid := range []int{0, -1} {
		if err := WritePID(pid); err == nil {
			t.Fatalf("WritePID(%d) succeeded", pid)
		}
		if err := os.WriteFile(PIDPath(), []byte(fmt.Sprintf("%d", pid)), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := ReadPID(); err == nil {
			t.Fatalf("ReadPID accepted %d", pid)
		}
		if got, running := IsRunning(); running || got != 0 {
			t.Fatalf("IsRunning with pid %d = (%d, %v)", pid, got, running)
		}
	}
}

func TestIsRunningRejectsReusedPIDWithoutDaemonLock(t *testing.T) {
	t.Setenv("POCKETCTL_RUNTIME_DIR", t.TempDir())
	if err := WritePID(os.Getpid()); err != nil {
		t.Fatal(err)
	}
	if pid, running := IsRunning(); running || pid != os.Getpid() {
		t.Fatalf("IsRunning = (%d, %v), want live reused PID rejected", pid, running)
	}
}

func TestIsRunningAcceptsLivePIDOwnedByDaemonLock(t *testing.T) {
	t.Setenv("POCKETCTL_RUNTIME_DIR", t.TempDir())
	lock, err := AcquireInstanceLock()
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if err := WritePID(os.Getpid()); err != nil {
		t.Fatal(err)
	}
	if pid, running := IsRunning(); !running || pid != os.Getpid() {
		t.Fatalf("IsRunning = (%d, %v), want owned live PID", pid, running)
	}
}

func TestInstanceLockOwnerMetadataMatchesExpectedPID(t *testing.T) {
	t.Setenv("POCKETCTL_RUNTIME_DIR", t.TempDir())
	lock, err := AcquireInstanceLock()
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()

	owned, err := InstanceLockOwnedBy(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	if !owned {
		t.Fatal("held daemon lock did not confirm its owner PID")
	}
	token, err := CurrentInstanceToken()
	if err != nil {
		t.Fatal(err)
	}
	if token == "" {
		t.Fatal("lock owner metadata has no runtime token")
	}
	owner, err := readInstanceOwner(instanceLockPath())
	if err != nil {
		t.Fatal(err)
	}
	if owner.ProcessStartIdentity == "" {
		t.Fatal("lock owner metadata has no process start identity")
	}
	matched, err := InstanceLockIdentityMatches(os.Getpid(), token)
	if err != nil {
		t.Fatal(err)
	}
	if !matched {
		t.Fatal("held daemon lock did not confirm its runtime token")
	}
}

func TestRuntimeTokenChangesForEachLockAcquisition(t *testing.T) {
	t.Setenv("POCKETCTL_RUNTIME_DIR", t.TempDir())
	first, err := AcquireInstanceLock()
	if err != nil {
		t.Fatal(err)
	}
	firstToken, err := CurrentInstanceToken()
	if err != nil {
		t.Fatal(err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}

	second, err := AcquireInstanceLock()
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	secondToken, err := CurrentInstanceToken()
	if err != nil {
		t.Fatal(err)
	}
	if firstToken == secondToken {
		t.Fatalf("runtime token was reused: %q", firstToken)
	}
}

func TestInstanceLockOwnerMismatchIsUncertain(t *testing.T) {
	t.Setenv("POCKETCTL_RUNTIME_DIR", t.TempDir())
	lock, err := AcquireInstanceLock()
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()

	if owned, err := InstanceLockOwnedBy(os.Getpid() + 1); owned ||
		!errors.Is(err, ErrInstanceOwnerMismatch) ||
		!errors.Is(err, ErrRuntimeStatusUncertain) {
		t.Fatalf("owned=%v err=%v", owned, err)
	}
}

func TestInstanceLockHeldWithMissingOrCorruptOwnerIsUncertain(t *testing.T) {
	for _, tt := range []struct {
		name    string
		content []byte
	}{
		{name: "missing"},
		{name: "corrupt", content: []byte("{")},
	} {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("POCKETCTL_RUNTIME_DIR", t.TempDir())
			path := instanceLockPath()
			lock, err := defaultLocker.Acquire(path)
			if err != nil {
				t.Fatal(err)
			}
			defer lock.Close()
			if len(tt.content) > 0 {
				if err := os.WriteFile(path, tt.content, 0o644); err != nil {
					t.Fatal(err)
				}
			}

			if owned, err := InstanceLockOwnedBy(os.Getpid()); owned ||
				!errors.Is(err, ErrRuntimeStatusUncertain) {
				t.Fatalf("owned=%v err=%v", owned, err)
			}
		})
	}
}

func TestInstanceLockFreeIsCertainlyNotOwned(t *testing.T) {
	t.Setenv("POCKETCTL_RUNTIME_DIR", t.TempDir())
	owned, err := InstanceLockOwnedBy(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	if owned {
		t.Fatal("free daemon lock reported an owner")
	}
}

func TestStableInstanceOwnerSnapshotRequiresTwoMatchingHeldReads(t *testing.T) {
	stable := instanceOwner{
		PID:                  101,
		RuntimeToken:         "runtime-a",
		ProcessStartIdentity: "linux:111",
	}
	tests := []struct {
		name       string
		probes     []bool
		probeErrAt int
		owners     []instanceOwner
		readErrAt  int
		wantHeld   bool
		wantErr    bool
	}{
		{
			name: "stable owner",
			probes: []bool{
				true,
				true,
			},
			owners:   []instanceOwner{stable, stable},
			wantHeld: true,
		},
		{
			name:     "free on first probe",
			probes:   []bool{false},
			wantHeld: false,
		},
		{
			name:     "owner exits before second probe",
			probes:   []bool{true, false},
			owners:   []instanceOwner{stable},
			wantErr:  true,
			wantHeld: false,
		},
		{
			name:   "owner replaced between reads",
			probes: []bool{true, true},
			owners: []instanceOwner{stable, {
				PID:                  202,
				RuntimeToken:         "runtime-b",
				ProcessStartIdentity: "linux:222",
			}},
			wantErr:  true,
			wantHeld: false,
		},
		{
			name:       "second probe error",
			probes:     []bool{true},
			probeErrAt: 2,
			owners:     []instanceOwner{stable},
			wantErr:    true,
		},
		{
			name:      "second metadata read fails",
			probes:    []bool{true, true},
			owners:    []instanceOwner{stable},
			readErrAt: 2,
			wantErr:   true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			probeCalls := 0
			readCalls := 0
			probe := func(string) (bool, error) {
				probeCalls++
				if probeCalls == tt.probeErrAt {
					return false, errors.New("probe failed")
				}
				return tt.probes[probeCalls-1], nil
			}
			read := func(string) (instanceOwner, error) {
				readCalls++
				if readCalls == tt.readErrAt {
					return instanceOwner{}, errors.New("read failed")
				}
				return tt.owners[readCalls-1], nil
			}

			owner, held, err := stableInstanceOwnerSnapshot(
				"daemon.lock",
				probe,
				read,
				func(pid int) (string, error) {
					if pid != stable.PID {
						return "linux:222", nil
					}
					return stable.ProcessStartIdentity, nil
				},
			)
			if held != tt.wantHeld || (err != nil) != tt.wantErr {
				t.Fatalf("owner=%+v held=%v err=%v", owner, held, err)
			}
			if tt.wantHeld && owner != stable {
				t.Fatalf("owner=%+v want=%+v", owner, stable)
			}
			if tt.wantErr && !errors.Is(err, ErrRuntimeStatusUncertain) {
				t.Fatalf("error=%v is not runtime uncertainty", err)
			}
		})
	}
}

func TestStableInstanceOwnerSnapshotRejectsStaleMetadataForReusedPID(t *testing.T) {
	stale := instanceOwner{
		PID:                  101,
		RuntimeToken:         "runtime-a",
		ProcessStartIdentity: "linux:111",
	}
	probeCalls := 0
	readCalls := 0
	owner, held, err := stableInstanceOwnerSnapshot(
		"daemon.lock",
		func(string) (bool, error) {
			probeCalls++
			return true, nil
		},
		func(string) (instanceOwner, error) {
			readCalls++
			return stale, nil
		},
		func(pid int) (string, error) {
			if pid != 101 {
				t.Fatalf("queried pid=%d want 101", pid)
			}
			return "linux:222", nil
		},
	)
	if owner != (instanceOwner{}) || held || !errors.Is(err, ErrRuntimeStatusUncertain) {
		t.Fatalf("owner=%+v held=%v err=%v", owner, held, err)
	}
	if probeCalls != 1 || readCalls != 1 {
		t.Fatalf("probe calls=%d read calls=%d", probeCalls, readCalls)
	}
}

func TestStableInstanceOwnerSnapshotProcessIdentityFailuresAreUncertain(t *testing.T) {
	tests := []struct {
		name  string
		owner instanceOwner
		query func(int) (string, error)
	}{
		{
			name: "query failure",
			owner: instanceOwner{
				PID:                  101,
				RuntimeToken:         "runtime-a",
				ProcessStartIdentity: "linux:111",
			},
			query: func(int) (string, error) {
				return "", os.ErrPermission
			},
		},
		{
			name: "legacy metadata has no process start identity",
			owner: instanceOwner{
				PID:          101,
				RuntimeToken: "runtime-a",
			},
			query: func(int) (string, error) {
				t.Fatal("queried OS identity for incomplete legacy metadata")
				return "", nil
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, held, err := stableInstanceOwnerSnapshot(
				"daemon.lock",
				func(string) (bool, error) { return true, nil },
				func(string) (instanceOwner, error) { return tt.owner, nil },
				tt.query,
			)
			if held || !errors.Is(err, ErrRuntimeStatusUncertain) {
				t.Fatalf("held=%v err=%v", held, err)
			}
		})
	}
}

func TestReadInstanceOwnerAcceptsLegacyMetadataWithoutProcessStartIdentity(t *testing.T) {
	path := filepath.Join(t.TempDir(), "daemon.lock")
	if err := os.WriteFile(
		path,
		[]byte(`{"pid":101,"runtime_token":"runtime-a"}`),
		0o644,
	); err != nil {
		t.Fatal(err)
	}
	owner, err := readInstanceOwner(path)
	if err != nil {
		t.Fatal(err)
	}
	if owner.PID != 101 || owner.RuntimeToken != "runtime-a" ||
		owner.ProcessStartIdentity != "" {
		t.Fatalf("owner=%+v", owner)
	}
}

func TestAcquireInstanceLockRequiresCurrentProcessStartIdentityBeforePublishing(t *testing.T) {
	t.Setenv("POCKETCTL_RUNTIME_DIR", t.TempDir())
	oldProcessStartIdentity := processStartIdentity
	processStartIdentity = func(pid int) (string, error) {
		if pid != os.Getpid() {
			t.Fatalf("queried pid=%d want %d", pid, os.Getpid())
		}
		return "", os.ErrPermission
	}
	t.Cleanup(func() {
		processStartIdentity = oldProcessStartIdentity
	})

	if lock, err := AcquireInstanceLock(); err == nil {
		_ = lock.Close()
		t.Fatal("AcquireInstanceLock succeeded without current process start identity")
	}
	probe, err := defaultLocker.Acquire(instanceLockPath())
	if err != nil {
		t.Fatalf("failed acquisition retained singleton lock: %v", err)
	}
	if err := probe.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestRuntimeStatusMissingPIDUsesInstanceAuthority(t *testing.T) {
	tests := []struct {
		name     string
		snapshot func() (instanceOwner, bool, error)
		wantErr  bool
	}{
		{
			name: "free lock is stopped",
			snapshot: func() (instanceOwner, bool, error) {
				return instanceOwner{}, false, nil
			},
		},
		{
			name: "held lock is startup uncertainty",
			snapshot: func() (instanceOwner, bool, error) {
				return instanceOwner{PID: 101, RuntimeToken: "runtime-a"}, true, nil
			},
			wantErr: true,
		},
		{
			name: "probe failure is uncertainty",
			snapshot: func() (instanceOwner, bool, error) {
				return instanceOwner{}, false, errors.New("permission denied")
			},
			wantErr: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			running, err := runtimeStatusWhenPIDMissing(tt.snapshot)
			if running || (err != nil) != tt.wantErr {
				t.Fatalf("running=%v err=%v", running, err)
			}
			if tt.wantErr && !errors.Is(err, ErrRuntimeStatusUncertain) {
				t.Fatalf("error=%v is not runtime uncertainty", err)
			}
		})
	}
}

func TestRuntimeStatusStartupPublicationSequenceNeverLooksStopped(t *testing.T) {
	t.Setenv("POCKETCTL_RUNTIME_DIR", t.TempDir())

	if pid, running, err := RuntimeStatus(); pid != 0 || running || err != nil {
		t.Fatalf("free runtime status=(%d, %v, %v)", pid, running, err)
	}

	lock, err := AcquireInstanceLock()
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if pid, running, err := RuntimeStatus(); pid != 0 || running ||
		!errors.Is(err, ErrRuntimeStatusUncertain) {
		t.Fatalf("pre-pid runtime status=(%d, %v, %v)", pid, running, err)
	}

	if err := WritePID(os.Getpid()); err != nil {
		t.Fatal(err)
	}
	if pid, running, err := RuntimeStatus(); pid != os.Getpid() || !running || err != nil {
		t.Fatalf("published runtime status=(%d, %v, %v)", pid, running, err)
	}
}

func TestRuntimeStatusReturnsDetailedOwnerTruth(t *testing.T) {
	t.Setenv("POCKETCTL_RUNTIME_DIR", t.TempDir())
	lock, err := AcquireInstanceLock()
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if err := WritePID(os.Getpid()); err != nil {
		t.Fatal(err)
	}

	pid, running, err := RuntimeStatus()
	if err != nil {
		t.Fatal(err)
	}
	if !running || pid != os.Getpid() {
		t.Fatalf("RuntimeStatus = (%d, %v, %v)", pid, running, err)
	}
}

func TestRuntimeStatusAndIdentityRecoverVerifiedOwnerWhenPIDFileIsStale(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("POCKETCTL_RUNTIME_DIR", t.TempDir())
	lock, err := AcquireInstanceLock()
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	token, err := CurrentInstanceToken()
	if err != nil {
		t.Fatal(err)
	}
	if err := WritePID(os.Getpid() + 1); err != nil {
		t.Fatal(err)
	}
	if err := WriteState(&DaemonState{
		PID:                  os.Getpid(),
		RuntimeInstanceToken: token,
	}); err != nil {
		t.Fatal(err)
	}

	pid, running, err := RuntimeStatus()
	if err != nil || !running || pid != os.Getpid() {
		t.Fatalf("RuntimeStatus = (%d, %v, %v), want verified lock owner", pid, running, err)
	}
	if running, err := VerifyRuntimeIdentity(os.Getpid(), token); err != nil || !running {
		t.Fatalf("VerifyRuntimeIdentity = (%v, %v), want verified lock owner", running, err)
	}
	if running, err := VerifyRuntimeIdentity(os.Getpid(), "stale-runtime-token"); running ||
		!errors.Is(err, ErrInstanceOwnerMismatch) {
		t.Fatalf("VerifyRuntimeIdentity with stale token = (%v, %v), want owner mismatch", running, err)
	}
}

func TestVerifyRuntimePIDRejectsPIDFileChange(t *testing.T) {
	t.Setenv("POCKETCTL_RUNTIME_DIR", t.TempDir())
	lock, err := AcquireInstanceLock()
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if err := WritePID(os.Getpid() + 1); err != nil {
		t.Fatal(err)
	}

	if running, err := VerifyRuntimePID(os.Getpid()); running ||
		!errors.Is(err, ErrRuntimeStatusUncertain) {
		t.Fatalf("running=%v err=%v", running, err)
	}
}

func TestVerifyRuntimeIdentityRejectsSamePIDWithStaleStateToken(t *testing.T) {
	t.Setenv("POCKETCTL_RUNTIME_DIR", t.TempDir())
	lock, err := AcquireInstanceLock()
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if err := WritePID(os.Getpid()); err != nil {
		t.Fatal(err)
	}
	token, err := CurrentInstanceToken()
	if err != nil {
		t.Fatal(err)
	}

	if running, err := VerifyRuntimeIdentity(os.Getpid(), "stale-state-token"); running ||
		!errors.Is(err, ErrInstanceOwnerMismatch) ||
		!errors.Is(err, ErrRuntimeStatusUncertain) {
		t.Fatalf("stale token running=%v err=%v", running, err)
	}
	if running, err := VerifyRuntimeIdentity(os.Getpid(), ""); running ||
		!errors.Is(err, ErrRuntimeStatusUncertain) {
		t.Fatalf("missing token running=%v err=%v", running, err)
	}
	if running, err := VerifyRuntimeIdentity(os.Getpid(), token); !running || err != nil {
		t.Fatalf("current token running=%v err=%v", running, err)
	}
}

func TestRuntimeStatusCorruptPIDFileIsUncertain(t *testing.T) {
	t.Setenv("POCKETCTL_RUNTIME_DIR", t.TempDir())
	if err := os.MkdirAll(filepath.Dir(PIDPath()), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(PIDPath(), []byte("not-a-pid"), 0o644); err != nil {
		t.Fatal(err)
	}
	if pid, running, err := RuntimeStatus(); pid != 0 || running ||
		!errors.Is(err, ErrRuntimeStatusUncertain) {
		t.Fatalf("RuntimeStatus = (%d, %v, %v)", pid, running, err)
	}
}

func TestStopFailsClosedWhenOwnerMetadataIsMissing(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("POCKETCTL_RUNTIME_DIR", t.TempDir())
	path := instanceLockPath()
	lock, err := defaultLocker.Acquire(path)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if err := WritePID(424242); err != nil {
		t.Fatal(err)
	}

	oldProc, oldGrace, oldPoll := defaultProc, stopGracePeriod, stopPollInterval
	fake := &forcedDaemonProcess{alive: true}
	defaultProc, stopGracePeriod, stopPollInterval = fake, 5*time.Millisecond, time.Millisecond
	t.Cleanup(func() {
		defaultProc, stopGracePeriod, stopPollInterval = oldProc, oldGrace, oldPoll
	})

	if err := Stop(); !errors.Is(err, ErrRuntimeStatusUncertain) {
		t.Fatalf("Stop error=%v", err)
	}
	if fake.terminated || fake.killed {
		t.Fatalf("uncertain owner was signaled: terminate=%v kill=%v", fake.terminated, fake.killed)
	}
}

func TestStopDoesNotSignalSamePIDProcessHoldingLockOverStaleMetadata(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("POCKETCTL_RUNTIME_DIR", t.TempDir())
	const reusedPID = 424242
	path := instanceLockPath()
	lock, err := defaultLocker.Acquire(path)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	staleMetadata := []byte(
		`{"pid":424242,"runtime_token":"runtime-a","process_start_identity":"linux:111"}`,
	)
	if err := os.WriteFile(path, staleMetadata, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := WritePID(reusedPID); err != nil {
		t.Fatal(err)
	}

	oldProc := defaultProc
	oldProcessStartIdentity := processStartIdentity
	fake := &forcedDaemonProcess{alive: true}
	defaultProc = fake
	processStartIdentity = func(pid int) (string, error) {
		if pid != reusedPID {
			t.Fatalf("queried pid=%d want %d", pid, reusedPID)
		}
		return "linux:222", nil
	}
	t.Cleanup(func() {
		defaultProc = oldProc
		processStartIdentity = oldProcessStartIdentity
	})

	if err := Stop(); !errors.Is(err, ErrRuntimeStatusUncertain) {
		t.Fatalf("Stop error=%v", err)
	}
	if fake.terminated || fake.killed {
		t.Fatalf(
			"same-PID replacement was signaled: terminate=%v kill=%v",
			fake.terminated,
			fake.killed,
		)
	}
}

func TestStopRevalidatesRuntimeIdentityImmediatelyBeforeSignal(t *testing.T) {
	var signaled bool
	identityChanged := fmt.Errorf("%w: owner token changed", ErrRuntimeStatusUncertain)
	stopped, err := stopVerifiedRuntimeIdentity(
		101,
		"initial-runtime-token",
		func(pid int, token string) (bool, error) {
			if pid != 101 || token != "initial-runtime-token" {
				t.Fatalf("verify identity=(%d, %q)", pid, token)
			}
			return false, identityChanged
		},
		func(pid int) error {
			signaled = true
			return nil
		},
	)
	if stopped || !errors.Is(err, ErrRuntimeStatusUncertain) {
		t.Fatalf("stopped=%v err=%v", stopped, err)
	}
	if signaled {
		t.Fatal("runtime identity changed before signal, but signal seam was called")
	}
}

type identitySwitchingProcess struct {
	identityChanged bool
	terminateErr    error
	terminateCalls  int
	killCalls       int
}

func (p *identitySwitchingProcess) IsAlive(int) bool { return true }

func (p *identitySwitchingProcess) Terminate(int) error {
	p.terminateCalls++
	p.identityChanged = true
	return p.terminateErr
}

func (p *identitySwitchingProcess) Kill(int) error {
	p.killCalls++
	return nil
}

func TestStopFallbackKillRequiresSameRuntimeIdentity(t *testing.T) {
	for _, tt := range []struct {
		name         string
		terminateErr error
	}{
		{name: "grace period expires"},
		{name: "terminate fails", terminateErr: errors.New("control channel failed")},
	} {
		t.Run(tt.name, func(t *testing.T) {
			proc := &identitySwitchingProcess{terminateErr: tt.terminateErr}
			verifyCalls := 0
			err := stopDaemonProcessWithIdentity(
				101,
				"runtime-a",
				proc,
				func(pid int, token string) (bool, error) {
					verifyCalls++
					if pid != 101 || token != "runtime-a" {
						t.Fatalf("identity=(%d, %q)", pid, token)
					}
					if proc.identityChanged {
						return false, fmt.Errorf("%w: owner replaced", ErrRuntimeStatusUncertain)
					}
					return true, nil
				},
				func(int, platform.ProcessController) bool { return false },
			)
			if !errors.Is(err, ErrRuntimeStatusUncertain) {
				t.Fatalf("error=%v", err)
			}
			if proc.terminateCalls != 1 || proc.killCalls != 0 || verifyCalls != 2 {
				t.Fatalf(
					"terminate=%d kill=%d verify=%d",
					proc.terminateCalls, proc.killCalls, verifyCalls,
				)
			}
		})
	}
}

// --- H-6: per-UID private runtime directory ---

func TestDefaultRuntimeDirIsUIDScoped(t *testing.T) {
	t.Setenv("POCKETCTL_RUNTIME_DIR", "")
	if runtime.GOOS == "windows" {
		t.Skip("unix-scoped default path")
	}
	want := filepath.Join(os.TempDir(), fmt.Sprintf("pocketctl-%d", os.Getuid()))
	if PIDPath() != filepath.Join(want, "daemon.pid") {
		t.Fatalf("PIDPath()=%q want %q", PIDPath(), filepath.Join(want, "daemon.pid"))
	}
	if dir := PIDPath(); strings.Contains(filepath.Dir(dir), "pocketctl") && filepath.Dir(dir) == "/tmp/pocketctl" {
		t.Fatal("runtime dir must not be the shared legacy /tmp/pocketctl")
	}
}

func TestRuntimeDirRejectsRelativeOverride(t *testing.T) {
	t.Setenv("POCKETCTL_RUNTIME_DIR", "relative/path")
	if err := WritePID(42); err == nil {
		t.Fatal("WritePID accepted a relative runtime dir override")
	}
}

func TestRuntimeDirRejectsSymlinkOverrideAndNeverWritesTarget(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink semantics are unix-only here")
	}
	base := t.TempDir()
	target := filepath.Join(base, "target")
	if err := os.Mkdir(target, 0o700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(base, "runtime-link")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	t.Setenv("POCKETCTL_RUNTIME_DIR", link)

	if err := WritePID(42); err == nil {
		t.Fatal("WritePID accepted a symlinked runtime dir")
	}
	if _, err := os.Stat(filepath.Join(target, "daemon.pid")); !os.IsNotExist(err) {
		t.Fatal("write followed the symlink into the target directory")
	}
}

func TestRuntimeDirRejectsPlainFileOverride(t *testing.T) {
	base := t.TempDir()
	plain := filepath.Join(base, "not-a-dir")
	if err := os.WriteFile(plain, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("POCKETCTL_RUNTIME_DIR", plain)
	if err := WritePID(42); err == nil {
		t.Fatal("WritePID accepted a regular-file runtime dir path")
	}
}

func TestRuntimeDirEnforcesPrivateModeAndOwner(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix permission bits")
	}
	t.Setenv("POCKETCTL_RUNTIME_DIR", "")
	if err := WritePID(4242); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Dir(PIDPath())
	info, err := os.Lstat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		t.Fatal("runtime dir resolved through a symlink")
	}
	if info.Mode().Perm() != 0o700 {
		t.Fatalf("runtime dir mode = %o, want 0700", info.Mode().Perm())
	}
	pidInfo, err := os.Lstat(PIDPath())
	if err != nil {
		t.Fatal(err)
	}
	if pidInfo.Mode().Perm() != 0o600 {
		t.Fatalf("pid file mode = %o, want 0600", pidInfo.Mode().Perm())
	}
	assertRuntimeDirOwner(t, info)
}
