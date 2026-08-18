package session

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

// fakeResumeProcess is an injectable resume process that never touches
// os/exec. Wait blocks until the test releases it; Kill records the call and
// releases Wait so shutdown paths complete deterministically.
type fakeResumeProcess struct {
	pid      int
	stdout   *bytes.Reader
	wait     chan error
	killOnce sync.Once
	killed   chan struct{}
}

func newFakeResumeProcess(pid int, stdout string) *fakeResumeProcess {
	return &fakeResumeProcess{
		pid:    pid,
		stdout: bytes.NewReader([]byte(stdout)),
		wait:   make(chan error, 1),
		killed: make(chan struct{}),
	}
}

func (p *fakeResumeProcess) PID() int          { return p.pid }
func (p *fakeResumeProcess) Stdout() io.Reader { return p.stdout }
func (p *fakeResumeProcess) Wait() error       { return <-p.wait }

func (p *fakeResumeProcess) Kill() error {
	p.killOnce.Do(func() { close(p.killed) })
	return nil
}

func (p *fakeResumeProcess) release(err error) {
	select {
	case p.wait <- err:
	default:
	}
}

// recordingResumeStarter captures every resumeLaunchSpec and hands out fakes.
type recordingResumeStarter struct {
	mu    sync.Mutex
	specs []resumeLaunchSpec
	procs []*fakeResumeProcess
	pid   int
}

func newRecordingResumeStarter() *recordingResumeStarter {
	return &recordingResumeStarter{pid: 41000}
}

func (r *recordingResumeStarter) call(_ context.Context, spec resumeLaunchSpec) (resumeProcess, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.pid++
	proc := newFakeResumeProcess(r.pid, "")
	r.specs = append(r.specs, spec)
	r.procs = append(r.procs, proc)
	return proc, nil
}

func (r *recordingResumeStarter) snapshot() ([]resumeLaunchSpec, []*fakeResumeProcess) {
	r.mu.Lock()
	defer r.mu.Unlock()
	specs := append([]resumeLaunchSpec(nil), r.specs...)
	procs := append([]*fakeResumeProcess(nil), r.procs...)
	return specs, procs
}

func (r *recordingResumeStarter) finishAll() {
	_, procs := r.snapshot()
	for _, proc := range procs {
		proc.release(nil)
	}
}

func TestStartExecResumeProcess(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix fixture script")
	}
	dir := t.TempDir()
	script := filepath.Join(dir, "fake-agent")
	body := "#!/bin/sh\nprintf '%s\\n' \"$1\"\nexit 7\n"
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	proc, err := startExecResumeProcess(ctx, resumeLaunchSpec{
		Path: script,
		Args: []string{"hello-resume"},
		Dir:  dir,
	})
	if err != nil {
		t.Fatal(err)
	}
	if proc.PID() <= 0 {
		t.Fatalf("PID=%d, want a real process", proc.PID())
	}
	out, readErr := io.ReadAll(proc.Stdout())
	if readErr != nil {
		t.Fatal(readErr)
	}
	if got := strings.TrimSpace(string(out)); got != "hello-resume" {
		t.Fatalf("stdout=%q, want forwarded argv", got)
	}
	waitErr := proc.Wait()
	if waitErr == nil || !strings.Contains(waitErr.Error(), "exit status") {
		t.Fatalf("Wait error=%v, want exit status 7", waitErr)
	}
}

func TestStartExecResumeProcessMissingBinaryFails(t *testing.T) {
	_, err := startExecResumeProcess(context.Background(), resumeLaunchSpec{
		Path: filepath.Join(t.TempDir(), "does-not-exist"),
		Args: []string{"x"},
	})
	if err == nil {
		t.Fatal("missing binary must fail to start")
	}
	if !strings.Contains(err.Error(), "start process") {
		t.Fatalf("error=%v, want start failure", err)
	}
}

// installSentinelResumeCLI puts a fake agent CLI first on PATH that records
// execution via a marker file. Tests assert the marker never appears.
func installSentinelResumeCLI(t *testing.T, cliName string) (marker string) {
	t.Helper()
	dir := t.TempDir()
	marker = filepath.Join(dir, "executed-marker")
	cli := filepath.Join(dir, cliName)
	body := "#!/bin/sh\ntouch " + shellQuotePath(marker) + "\nexit 0\n"
	if err := os.WriteFile(cli, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	return marker
}

func shellQuotePath(path string) string {
	return "'" + strings.ReplaceAll(path, "'", "'\"'\"'") + "'"
}

func assertClaudeResumeSpec(t *testing.T, spec resumeLaunchSpec, sessionID, content string) {
	t.Helper()
	if spec.Path == "" {
		t.Fatal("resume spec has no CLI path")
	}
	if base := filepath.Base(spec.Path); base != "claude" && base != "claude.exe" {
		t.Fatalf("resume CLI=%q, want claude", base)
	}
	joined := fmt.Sprint(spec.Args)
	if !strings.Contains(joined, sessionID) {
		t.Fatalf("resume args %v missing session id %q", spec.Args, sessionID)
	}
	if !strings.Contains(joined, content) {
		t.Fatalf("resume args %v missing prompt %q", spec.Args, content)
	}
}

// killableFakeResumeProcess releases Wait when Kill is called, mirroring how
// a real killed process makes Wait return.
type killableFakeResumeProcess struct {
	*fakeResumeProcess
	killReleased bool
}

func (p *killableFakeResumeProcess) Kill() error {
	p.fakeResumeProcess.killOnce.Do(func() {
		close(p.fakeResumeProcess.killed)
		p.release(nil)
	})
	return nil
}

// countingFakeResumeProcess records how many times Wait was entered so tests
// can prove exactly one Wait owner.
type countingFakeResumeProcess struct {
	*fakeResumeProcess
	waitEntered chan struct{}
}

func newCountingFakeResumeProcess(pid int) *countingFakeResumeProcess {
	return &countingFakeResumeProcess{
		fakeResumeProcess: newFakeResumeProcess(pid, ""),
		waitEntered:       make(chan struct{}, 16),
	}
}

func (p *countingFakeResumeProcess) Wait() error {
	p.waitEntered <- struct{}{}
	return p.fakeResumeProcess.Wait()
}

func TestResumeRegistryOldGenerationCannotDeleteNewProcess(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 8))
	p1 := newFakeResumeProcess(101, "")
	p2 := newFakeResumeProcess(102, "")
	entry1 := sm.registerOwnedResume("sid", func() {}, p1)
	entry2 := sm.registerOwnedResume("sid", func() {}, p2)

	// The old generation's goroutine finishes after the new registration.
	sm.finishOwnedResume(entry1, nil)
	if got := sm.ownedResumeForSession("sid"); got != entry2 {
		t.Fatalf("old generation cleanup removed the newer entry: %v", got)
	}

	sm.finishOwnedResume(entry2, nil)
	if got := sm.ownedResumeForSession("sid"); got != nil {
		t.Fatalf("registry still holds a finished entry: %v", got)
	}
	p1.release(nil)
	p2.release(nil)
}

func TestShutdownResumeProcessesCancelsAndWaits(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 8))
	cancelObserved := make(chan struct{})
	var cancelOnce sync.Once
	cancel := func() { cancelOnce.Do(func() { close(cancelObserved) }) }
	proc := newFakeResumeProcess(201, "")

	entry := sm.registerOwnedResume("sid-a", cancel, proc)
	go func() {
		<-cancelObserved
		proc.release(nil)
		waitErr := proc.Wait()
		sm.finishOwnedResume(entry, waitErr)
	}()

	ctx, cancelCtx := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancelCtx()
	if err := sm.ShutdownResumeProcesses(ctx); err != nil {
		t.Fatalf("shutdown error=%v", err)
	}
	select {
	case <-entry.done:
	default:
		t.Fatal("shutdown returned before the owned resume finished")
	}
}

func TestShutdownResumeProcessesForceKillsAfterDeadline(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 8))
	proc := &killableFakeResumeProcess{fakeResumeProcess: newFakeResumeProcess(202, "")}
	entry := sm.registerOwnedResume("sid-b", func() {}, proc)
	go func() {
		waitErr := proc.Wait()
		sm.finishOwnedResume(entry, waitErr)
	}()

	ctx, cancelCtx := context.WithTimeout(context.Background(), time.Millisecond)
	defer cancelCtx()
	started := time.Now()
	if err := sm.ShutdownResumeProcesses(ctx); err != nil {
		t.Fatalf("shutdown error=%v", err)
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("force-kill shutdown took %v", elapsed)
	}
	select {
	case <-proc.killed:
	default:
		t.Fatal("deadline expiry did not force kill the owned resume")
	}
	select {
	case <-entry.done:
	default:
		t.Fatal("killed resume was not reaped")
	}
}

func TestShutdownResumeProcessesIsIdempotent(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 8))
	proc := newFakeResumeProcess(203, "")
	entry := sm.registerOwnedResume("sid-c", func() {}, proc)

	ctx, cancelCtx := context.WithTimeout(context.Background(), time.Second)
	defer cancelCtx()
	proc.release(nil)
	sm.finishOwnedResume(entry, nil)
	for i := 0; i < 2; i++ {
		if err := sm.ShutdownResumeProcesses(ctx); err != nil {
			t.Fatalf("shutdown call %d error=%v", i+1, err)
		}
	}
	if got := sm.ownedResumeForSession("sid-c"); got != nil {
		t.Fatalf("registry still holds entry: %v", got)
	}
}

func TestKillSessionUsesOwnedResumeHandle(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 8))
	sm.RegisterTerminalSession("kill-sid", "/tmp", 9999999, "", protocol.StatusRunning, "")

	proc := newCountingFakeResumeProcess(301)
	cancelObserved := make(chan struct{})
	var cancelOnce sync.Once
	entry := sm.registerOwnedResume("kill-sid", func() {
		cancelOnce.Do(func() { close(cancelObserved) })
	}, proc)
	// Model the production resume goroutine: the single Wait owner responds to
	// cancellation, reaps via finishOwnedResume, and restores status.
	finalCtx, finalCancel := context.WithCancel(context.Background())
	finalCancel()
	go func() {
		<-cancelObserved
		proc.release(nil)
		waitErr := proc.Wait()
		sm.finishOwnedResume(entry, waitErr)
		sm.mu.RLock()
		ps := sm.sessions["kill-sid"]
		sm.mu.RUnlock()
		if ps != nil {
			sm.finalizeProcessExit(finalCtx, waitErr, ps)
		}
	}()

	if err := sm.KillSession("kill-sid"); err != nil {
		t.Fatalf("KillSession error=%v", err)
	}
	select {
	case <-entry.done:
	default:
		t.Fatal("KillSession did not reap the owned resume")
	}
	select {
	case <-proc.killed:
		t.Fatal("graceful cancel path should not need force kill")
	default:
	}
}

func TestTerminalObservedProcessIsNeverAddedToResumeRegistry(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 8))
	// A terminal-discovered live Claude is registered by observation only.
	sm.RegisterTerminalSession("term-sid", "/tmp", os.Getpid(), "/dev/ttys009", protocol.StatusRunning, "")

	sm.mu.RLock()
	count := len(sm.resumeProcesses)
	sm.mu.RUnlock()
	if count != 0 {
		t.Fatalf("terminal-discovered session entered the resume registry: %d", count)
	}

	ctx, cancelCtx := context.WithTimeout(context.Background(), time.Second)
	defer cancelCtx()
	if err := sm.ShutdownResumeProcesses(ctx); err != nil {
		t.Fatalf("shutdown error=%v", err)
	}
	if isProcessAlive(os.Getpid()) != true {
		t.Fatal("shutdown must never kill terminal-observed processes")
	}
}

func TestResumeCleanupRecorderReceivesCancelAndForceKillOnce(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 8))
	var mu sync.Mutex
	var reasons []string
	sm.SetResumeCleanupRecorder(func(reason string) {
		mu.Lock()
		defer mu.Unlock()
		reasons = append(reasons, reason)
	})

	// Graceful path: cancel is observed and the fake finishes.
	proc1 := newFakeResumeProcess(701, "")
	cancelObserved := make(chan struct{})
	var cancelOnce sync.Once
	entry1 := sm.registerOwnedResume("rec-a", func() {
		cancelOnce.Do(func() { close(cancelObserved) })
	}, proc1)
	go func() {
		<-cancelObserved
		proc1.release(nil)
		sm.finishOwnedResume(entry1, proc1.Wait())
	}()
	gracefulCtx, gracefulCancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer gracefulCancel()
	if err := sm.ShutdownResumeProcesses(gracefulCtx); err != nil {
		t.Fatalf("graceful shutdown error=%v", err)
	}

	// Force-kill path: the fake ignores cancel and only finishes after Kill.
	proc2 := &killableFakeResumeProcess{fakeResumeProcess: newFakeResumeProcess(702, "")}
	entry2 := sm.registerOwnedResume("rec-b", func() {}, proc2)
	go func() {
		sm.finishOwnedResume(entry2, proc2.Wait())
	}()
	deadlineCtx, deadlineCancel := context.WithTimeout(context.Background(), time.Millisecond)
	defer deadlineCancel()
	if err := sm.ShutdownResumeProcesses(deadlineCtx); err != nil {
		t.Fatalf("force-kill shutdown error=%v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(reasons) != 2 {
		t.Fatalf("recorded reasons=%v, want exactly two events", reasons)
	}
	counts := map[string]int{}
	for _, reason := range reasons {
		counts[reason]++
		switch reason {
		case "resume_cancelled", "resume_force_killed":
		default:
			t.Fatalf("unexpected reason %q", reason)
		}
		if strings.Contains(reason, "/") || strings.Contains(reason, "rec-") || strings.Contains(reason, "701") || strings.Contains(reason, "702") {
			t.Fatalf("reason contains an identifier or path: %q", reason)
		}
	}
	if counts["resume_cancelled"] != 1 || counts["resume_force_killed"] != 1 {
		t.Fatalf("reason counts=%v, want one each", counts)
	}
}
