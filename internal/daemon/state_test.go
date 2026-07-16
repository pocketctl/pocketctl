package daemon

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/platform"
)

func TestOpenCodeServeStateRoundTripIsPrivateAndRemovable(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	want := &OpenCodeServeState{PID: os.Getpid(), BaseURL: "http://127.0.0.1:1234", Password: "secret", Version: "1.2.3", OwnerPID: 42, UpdatedAt: time.Now().UTC().Truncate(time.Second)}
	if err := WriteOpenCodeServeState(want); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(OpenCodeServeStatePath())
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("mode=%o want 600", got)
	}
	got, err := ReadOpenCodeServeState()
	if err != nil {
		t.Fatal(err)
	}
	if got.PID != want.PID || got.BaseURL != want.BaseURL || got.Password != want.Password || got.Version != want.Version || got.OwnerPID != want.OwnerPID || !got.UpdatedAt.Equal(want.UpdatedAt) {
		t.Fatalf("state=%+v want %+v", got, want)
	}
	if err := RemoveOpenCodeServeState(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(OpenCodeServeStatePath()); !os.IsNotExist(err) {
		t.Fatalf("state still exists: %v", err)
	}
}

func TestOpenCodeServeStateForcedDaemonStopCleanup(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	const password = "forced-stop-secret"
	proc := exec.Command("sleep", "30")
	if err := proc.Start(); err != nil {
		t.Fatal(err)
	}
	defer proc.Process.Kill()
	go proc.Wait()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, pass, ok := r.BasicAuth()
		if !ok || user != "opencode" || pass != password {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		fmt.Fprint(w, `{"healthy":true,"version":"1.2.3"}`)
	}))
	defer server.Close()
	if err := WriteOpenCodeServeState(&OpenCodeServeState{PID: proc.Process.Pid, BaseURL: server.URL, Password: password, Version: "1.2.3", OwnerPID: 999, UpdatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	oldProc, oldGrace, oldPoll, oldSettle := defaultProc, stopGracePeriod, stopPollInterval, stopOwnershipSettlePeriod
	fake := &forcedDaemonProcess{alive: true}
	defaultProc, stopGracePeriod, stopPollInterval, stopOwnershipSettlePeriod = fake, 10*time.Millisecond, time.Millisecond, 5*time.Millisecond
	t.Cleanup(func() {
		defaultProc, stopGracePeriod, stopPollInterval, stopOwnershipSettlePeriod = oldProc, oldGrace, oldPoll, oldSettle
		_ = os.Remove(PIDPath())
	})
	if err := WritePID(424242); err != nil {
		t.Fatal(err)
	}
	if err := Stop(); err != nil {
		t.Fatal(err)
	}
	if !fake.terminated || !fake.killed {
		t.Fatalf("forced path terminate=%v kill=%v", fake.terminated, fake.killed)
	}
	deadline := time.Now().Add(2 * time.Second)
	for platform.NewProcessController().IsAlive(proc.Process.Pid) && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if platform.NewProcessController().IsAlive(proc.Process.Pid) {
		t.Fatal("preserved serve survived forced daemon cleanup")
	}
	if _, err := os.Stat(OpenCodeServeStatePath()); !os.IsNotExist(err) {
		t.Fatalf("state survived: %v", err)
	}
}

type forcedDaemonProcess struct {
	terminated, killed bool
	alive              bool
	terminateErr       error
}

func (p *forcedDaemonProcess) IsAlive(pid int) bool    { return p.alive && !p.killed }
func (p *forcedDaemonProcess) Terminate(pid int) error { p.terminated = true; return p.terminateErr }
func (p *forcedDaemonProcess) Kill(pid int) error      { p.killed = true; return nil }

func TestDaemonStopTerminateErrorFallsBackByLiveness(t *testing.T) {
	alive := &forcedDaemonProcess{alive: true, terminateErr: fmt.Errorf("no control pipe")}
	if err := stopDaemonProcess(1, alive); err != nil {
		t.Fatal(err)
	}
	if !alive.killed {
		t.Fatal("alive daemon was not killed after Terminate error")
	}
	dead := &forcedDaemonProcess{alive: false, terminateErr: fmt.Errorf("already gone")}
	if err := stopDaemonProcess(2, dead); err != nil {
		t.Fatal(err)
	}
	if dead.killed {
		t.Fatal("dead daemon was unnecessarily killed")
	}
}

type replacementRaceProcess struct {
	alive   map[int]bool
	stopped []int
}

func (p *replacementRaceProcess) IsAlive(pid int) bool { return p.alive[pid] }
func (p *replacementRaceProcess) Terminate(pid int) error {
	p.alive[pid] = false
	p.stopped = append(p.stopped, pid)
	if pid == 101 {
		p.alive[202] = true
		return WritePID(202)
	}
	return nil
}
func (p *replacementRaceProcess) Kill(pid int) error {
	p.alive[pid] = false
	p.stopped = append(p.stopped, pid)
	return nil
}

func TestDaemonStopIntentStopsReplacementThatClaimedFirst(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	oldProc, oldGrace, oldPoll, oldSettle := defaultProc, stopGracePeriod, stopPollInterval, stopOwnershipSettlePeriod
	fake := &replacementRaceProcess{alive: map[int]bool{101: true}}
	defaultProc, stopGracePeriod, stopPollInterval, stopOwnershipSettlePeriod = fake, 10*time.Millisecond, time.Millisecond, 20*time.Millisecond
	t.Cleanup(func() {
		defaultProc, stopGracePeriod, stopPollInterval, stopOwnershipSettlePeriod = oldProc, oldGrace, oldPoll, oldSettle
		_ = os.Remove(PIDPath())
	})
	if err := WritePID(101); err != nil {
		t.Fatal(err)
	}
	if err := Stop(); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(fake.stopped, []int{101, 202}) {
		t.Fatalf("stopped owners=%v", fake.stopped)
	}
	if _, err := os.Stat(OpenCodeServeStatePath()); !os.IsNotExist(err) {
		t.Fatalf("credential state remains: %v", err)
	}
}

func TestOpenCodeServeStateRejectsCorruptJSON(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	path := OpenCodeServeStatePath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadOpenCodeServeState(); err == nil {
		t.Fatal("expected corrupt JSON error")
	}
}

func TestOpenCodeServeStateRejectsNonPrivateFile(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	path := OpenCodeServeStatePath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"pid":1}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadOpenCodeServeState(); err == nil {
		t.Fatal("expected insecure mode error")
	}
}

func TestOpenCodeServeStateTightensDirectoryAndRejectsSymlink(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir := filepath.Join(home, ".pocketctl")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	state := &OpenCodeServeState{PID: os.Getpid(), BaseURL: "http://127.0.0.1:1234", Password: "secret", Version: "1.2.3"}
	if err := WriteOpenCodeServeState(state); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(dir); err != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("dir mode=%v err=%v", info.Mode().Perm(), err)
	}
	target := filepath.Join(t.TempDir(), "target")
	if err := os.WriteFile(target, []byte(`{"pid":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(OpenCodeServeStatePath()); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, OpenCodeServeStatePath()); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadOpenCodeServeState(); err == nil {
		t.Fatal("accepted symlink state")
	}
}

func TestOpenCodeServeStateOwnerClaimCompareAndSwap(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	initial := &OpenCodeServeState{PID: 1, BaseURL: "http://127.0.0.1:1234", Password: "x", Version: "1.2.3", OwnerPID: 42, UpdatedAt: time.Now()}
	if err := WriteOpenCodeServeState(initial); err != nil {
		t.Fatal(err)
	}
	next := *initial
	next.OwnerPID = 43
	if err := ClaimOpenCodeServeState(99, &next); err == nil {
		t.Fatal("claim with wrong owner succeeded")
	}
	got, err := ReadOpenCodeServeState()
	if err != nil || got.OwnerPID != 42 {
		t.Fatalf("failed CAS changed owner: %+v %v", got, err)
	}
	if err := ClaimOpenCodeServeState(42, &next); err != nil {
		t.Fatal(err)
	}
	got, err = ReadOpenCodeServeState()
	if err != nil || got.OwnerPID != 43 {
		t.Fatalf("claim owner=%+v err=%v", got, err)
	}
}

func TestOpenCodeServeStateRejectsSymlinkSwapDuringRead(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	valid := &OpenCodeServeState{PID: 1, BaseURL: "http://127.0.0.1:1234", Password: "valid", Version: "1.2.3"}
	if err := WriteOpenCodeServeState(valid); err != nil {
		t.Fatal(err)
	}
	path := OpenCodeServeStatePath()
	backup, target := path+".backup", filepath.Join(t.TempDir(), "evil")
	if err := os.WriteFile(target, []byte(`{"pid":1,"password":"evil"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			if os.Rename(path, backup) == nil {
				_ = os.Symlink(target, path)
				_ = os.Remove(path)
				_ = os.Rename(backup, path)
			}
		}
	}()
	for i := 0; i < 1000; i++ {
		if got, err := ReadOpenCodeServeState(); err == nil && got.Password != "valid" {
			close(stop)
			wg.Wait()
			t.Fatalf("accepted swapped state: %+v", got)
		}
	}
	close(stop)
	wg.Wait()
}

func TestDaemonStopIntentPersistsUntilExplicitStartClears(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	intent, err := BeginExplicitStopTransaction()
	if err != nil {
		t.Fatal(err)
	}
	if !ExplicitStopIntentActive() {
		t.Fatal("stop intent not active")
	}
	info, err := os.Stat(StopIntentPath())
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("intent mode=%v err=%v", info.Mode().Perm(), err)
	}
	if err := ClearExplicitStopIntent(); err == nil {
		t.Fatal("cleared ACTIVE intent")
	}
	if err := CompleteExplicitStopTransaction(intent.Token); err != nil {
		t.Fatal(err)
	}
	if err := ClearExplicitStopIntent(); err != nil {
		t.Fatal(err)
	}
	if ExplicitStopIntentActive() {
		t.Fatal("explicit start did not clear intent")
	}
}

func TestDaemonLifecycleTransactionsClosePublicationRaces(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	// 1: start observes none, then Stop publishes ACTIVE.
	observedNone, exists, err := ObserveStopIntent()
	if err != nil || exists {
		t.Fatalf("initial intent=%+v exists=%v err=%v", observedNone, exists, err)
	}
	active1, err := BeginExplicitStopTransaction()
	if err != nil {
		t.Fatal(err)
	}
	if err := PublishDaemonPID(11, false, nil); err == nil {
		t.Fatal("start published after newer stop intent")
	}
	if err := CompleteExplicitStopTransaction(active1.Token); err != nil {
		t.Fatal(err)
	}
	// A later normal start may consume exactly the COMPLETE token it observed.
	complete1, exists, err := ObserveStopIntent()
	if err != nil || !exists || complete1.Status != StopIntentComplete {
		t.Fatalf("complete=%+v exists=%v err=%v", complete1, exists, err)
	}
	if err := PublishDaemonPID(12, false, &complete1); err != nil {
		t.Fatal(err)
	}
	_ = os.Remove(PIDPath())

	// 2: start observes stale COMPLETE T1; Stop rewrites ACTIVE T2 before clear.
	oldIntent, err := BeginExplicitStopTransaction()
	if err != nil {
		t.Fatal(err)
	}
	if err := CompleteExplicitStopTransaction(oldIntent.Token); err != nil {
		t.Fatal(err)
	}
	stale, _, _ := ObserveStopIntent()
	fresh, err := BeginExplicitStopTransaction()
	if err != nil {
		t.Fatal(err)
	}
	if err := PublishDaemonPID(13, false, &stale); err == nil {
		t.Fatal("stale token cleared fresh active stop")
	}
	current, _, _ := ObserveStopIntent()
	if current.Token != fresh.Token || current.Status != StopIntentActive {
		t.Fatalf("fresh intent overwritten: %+v", current)
	}
	if err := CompleteExplicitStopTransaction(fresh.Token); err != nil {
		t.Fatal(err)
	}

	// 3: replacement pauses before publication while Stop completes.
	if err := ClearExplicitStopIntent(); err != nil {
		t.Fatal(err)
	}
	active3, err := BeginExplicitStopTransaction()
	if err != nil {
		t.Fatal(err)
	}
	if err := CompleteExplicitStopTransaction(active3.Token); err != nil {
		t.Fatal(err)
	}
	if err := PublishDaemonPID(14, true, nil); err == nil {
		t.Fatal("replacement published after completed stop")
	}
	if _, err := os.Stat(PIDPath()); !os.IsNotExist(err) {
		t.Fatalf("pid published in stop race: %v", err)
	}
}

func TestDaemonLifecycleLockRemainsExclusiveWhenFileIsEmptyAndOld(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	first, err := acquireLifecycleLock()
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()

	old := time.Now().Add(-time.Hour)
	if err := os.Chtimes(lifecycleLockPath(), old, old); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		lock, err := acquireLifecycleLock()
		if err == nil {
			_ = lock.Close()
		}
		result <- err
	}()
	select {
	case err := <-result:
		t.Fatalf("second lifecycle transaction entered while old empty lock was held: %v", err)
	case <-time.After(250 * time.Millisecond):
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("second lifecycle transaction did not acquire after release: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("second lifecycle transaction remained blocked after release")
	}
}

func TestDaemonLifecycleLockReleasedOnProcessDeath(t *testing.T) {
	if os.Getenv("POCKETCTL_LIFECYCLE_LOCK_HELPER") == "1" {
		lock, err := acquireLifecycleLock()
		if err != nil {
			os.Exit(2)
		}
		defer lock.Close()
		if err := os.WriteFile(os.Getenv("POCKETCTL_LIFECYCLE_LOCK_READY"), []byte("ready"), 0o600); err != nil {
			os.Exit(3)
		}
		for {
			time.Sleep(time.Second)
		}
	}
	home := t.TempDir()
	ready := filepath.Join(t.TempDir(), "ready")
	cmd := exec.Command(os.Args[0], "-test.run=TestDaemonLifecycleLockReleasedOnProcessDeath")
	cmd.Env = append(os.Environ(), "HOME="+home, "POCKETCTL_LIFECYCLE_LOCK_HELPER=1", "POCKETCTL_LIFECYCLE_LOCK_READY="+ready)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	deadline := time.Now().Add(2 * time.Second)
	for {
		if _, err := os.Stat(ready); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("lock holder did not become ready")
		}
		time.Sleep(10 * time.Millisecond)
	}

	t.Setenv("HOME", home)
	result := make(chan error, 1)
	go func() {
		lock, err := acquireLifecycleLock()
		if err == nil {
			_ = lock.Close()
		}
		result <- err
	}()
	select {
	case err := <-result:
		t.Fatalf("parent acquired lifecycle lock while child was alive: %v", err)
	case <-time.After(200 * time.Millisecond):
	}
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	if err := cmd.Wait(); err == nil {
		t.Fatal("killed helper exited successfully")
	}
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("lifecycle lock was not released by process death: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("lifecycle lock remained held after process death")
	}
}
