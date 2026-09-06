package session

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/memorycontext"
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
	stderr   string
	exitCode int
}

func (p *fakeResumeProcess) ResumeDiagnostic() ResumeProcessDiagnostic {
	return ResumeProcessDiagnostic{ExitCode: p.exitCode, Stderr: p.stderr}
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
	body := "#!/bin/sh\nprintf '%s\\n' \"$1\"\nhead -c 5000 /dev/zero | tr '\\000' 'e' >&2\nexit 7\n"
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
	diagnostic, ok := proc.(interface {
		ResumeDiagnostic() ResumeProcessDiagnostic
	})
	if !ok {
		t.Fatal("real resume process did not expose bounded diagnostics")
	}
	if got := diagnostic.ResumeDiagnostic(); got.ExitCode != 7 || len(got.Stderr) != resumeStderrLimit {
		t.Fatalf("diagnostic exit=%d stderr=%d bytes, want exit=7 stderr=%d", got.ExitCode, len(got.Stderr), resumeStderrLimit)
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

func mustRegisterOwnedResume(t *testing.T, sm *SessionManager, sessionID string, cancel context.CancelFunc, process resumeProcess) *ownedResume {
	t.Helper()
	entry, err := sm.registerOwnedResume(sessionID, cancel, process)
	if err != nil {
		t.Fatal(err)
	}
	return entry
}

func TestResumeRegistryOldGenerationCannotDeleteNewProcess(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 8))
	p1 := newFakeResumeProcess(101, "")
	p2 := newFakeResumeProcess(102, "")
	entry1 := mustRegisterOwnedResume(t, sm, "sid", func() {}, p1)
	sm.finishOwnedResume(entry1, nil)
	entry2 := mustRegisterOwnedResume(t, sm, "sid", func() {}, p2)

	// A stale duplicate cleanup from the old generation cannot remove the new
	// current entry.
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

func TestSendMessageRejectsSecondLiveResume(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix sentinel CLI fixture")
	}
	output := make(chan protocol.DaemonEvent, 32)
	sm := NewSessionManager(output)
	sm.RegisterTerminalSession("live-resume-sid", t.TempDir(), 9999999, "", protocol.StatusExited, adapter.AgentClaude)
	installSentinelResumeCLI(t, "claude")
	starter := newRecordingResumeStarter()
	sm.setResumeStarter(starter.call)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := sm.SendMessage(ctx, "live-resume-sid", "first"); err != nil {
		t.Fatal(err)
	}
	if err := sm.SendMessage(ctx, "live-resume-sid", "second"); err == nil || !strings.Contains(err.Error(), "busy") {
		t.Fatalf("second live resume error=%v, want busy rejection", err)
	}
	specs, procs := starter.snapshot()
	if len(specs) != 1 || len(procs) != 1 {
		t.Fatalf("resume starts=%d, want exactly one", len(specs))
	}
	procs[0].release(nil)
	entry := sm.ownedResumeForSession("live-resume-sid")
	if entry != nil {
		select {
		case <-entry.done:
		case <-time.After(time.Second):
			t.Fatal("first resume did not finish")
		}
	}
}

func TestClaudeDormantResumeCarriesHiddenContextOutsideVisiblePrompt(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix sentinel CLI fixture")
	}
	output := make(chan protocol.DaemonEvent, 32)
	sm := NewSessionManager(output)
	sm.RegisterTerminalSession("claude-context-sid", t.TempDir(), 9999999, "", protocol.StatusExited, adapter.AgentClaude)
	installSentinelResumeCLI(t, "claude")
	starter := newRecordingResumeStarter()
	sm.setResumeStarter(starter.call)

	const visible = "keep this prompt byte-identical"
	hidden := &memorycontext.PreparedContext{StableText: "private stable memory", DynamicText: "private dynamic memory"}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := sm.dispatchUserMessageWithContext(ctx, "claude-context-sid", visible, hidden); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(starter.finishAll)

	specs, _ := starter.snapshot()
	if len(specs) != 1 {
		t.Fatalf("resume starts=%d, want exactly one", len(specs))
	}
	args := specs[0].Args
	promptIndex := -1
	contextIndex := -1
	for i, arg := range args {
		switch arg {
		case "-p":
			promptIndex = i
		case "--append-system-prompt":
			contextIndex = i
		}
	}
	if promptIndex < 0 || promptIndex+1 >= len(args) || args[promptIndex+1] != visible {
		t.Fatalf("resume args %v changed visible prompt %q", args, visible)
	}
	if contextIndex < 0 || contextIndex+1 >= len(args) {
		t.Fatalf("resume args %v missing hidden system prompt", args)
	}
	if got := args[contextIndex+1]; !strings.Contains(got, hidden.StableText) || !strings.Contains(got, hidden.DynamicText) {
		t.Fatalf("hidden system prompt %q missing prepared context", got)
	}
}

func TestIdleTerminalResumePreservesWaitError(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix sentinel CLI fixture")
	}
	output := make(chan protocol.DaemonEvent, 32)
	sm := NewSessionManager(output)
	sm.RegisterTerminalSession("idle-resume-sid", t.TempDir(), os.Getpid(), "/dev/ttys-test", protocol.StatusIdle, adapter.AgentClaude)
	installSentinelResumeCLI(t, "claude")
	starter := newRecordingResumeStarter()
	sm.setResumeStarter(starter.call)
	notified := make(chan struct{}, 1)
	sm.OnNotifyTerminal = func(_, _ string) { notified <- struct{}{} }

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := sm.SendMessage(ctx, "idle-resume-sid", "fail this resume"); err != nil {
		t.Fatal(err)
	}
	_, procs := starter.snapshot()
	if len(procs) != 1 {
		t.Fatalf("resume processes=%d, want one", len(procs))
	}
	entry := sm.ownedResumeForSession("idle-resume-sid")
	if entry == nil {
		t.Fatal("resume was not registered")
	}
	wantErr := errors.New("resume exit failure")
	procs[0].release(wantErr)

	var terminalStatus string
	deadline := time.After(time.Second)
	for terminalStatus == "" {
		select {
		case event := <-output:
			if event.Type == "session_status" && event.Status != protocol.StatusRunning {
				terminalStatus = event.Status
			}
		case <-deadline:
			t.Fatal("timed out waiting for terminal resume status")
		}
	}
	if terminalStatus != protocol.StatusError {
		t.Fatalf("terminal status=%q, want error", terminalStatus)
	}
	select {
	case <-entry.done:
	case <-time.After(time.Second):
		t.Fatal("failed resume was not reaped")
	}
	if !errors.Is(entry.waitErr, wantErr) {
		t.Fatalf("recorded Wait error=%v, want %v", entry.waitErr, wantErr)
	}
	select {
	case <-notified:
		t.Fatal("failed resume triggered success notification")
	case <-time.After(50 * time.Millisecond):
	}
}

func TestIdleTerminalResumePublishesCorrelatedSanitizedExecutionFailure(t *testing.T) {
	output := make(chan protocol.DaemonEvent, 32)
	sm := NewSessionManager(output)
	sm.RegisterTerminalSession("failed-resume-sid", t.TempDir(), os.Getpid(), "/dev/ttys-test", protocol.StatusIdle, adapter.AgentClaude)
	installSentinelResumeCLI(t, "claude")
	starter := newRecordingResumeStarter()
	sm.setResumeStarter(starter.call)

	err := sm.SendMessageWithInput(context.Background(), UserMessageInput{
		SessionID: "failed-resume-sid", Content: "secret prompt", RequestID: "req-failure", MsgID: "msg-failure",
	})
	if err != nil {
		t.Fatal(err)
	}
	_, procs := starter.snapshot()
	procs[0].stderr = "provider exploded with secret prompt\n"
	procs[0].exitCode = 17
	procs[0].release(errors.New("exit status 17"))

	deadline := time.After(time.Second)
	for {
		select {
		case event := <-output:
			if event.Type != "error" || event.Operation != "user_message" {
				continue
			}
			if event.SessionID != "failed-resume-sid" || event.RequestID != "req-failure" || event.MsgID != "msg-failure" {
				t.Fatalf("uncorrelated execution failure: %+v", event)
			}
			if event.Reason != "execution_failed" || event.Error == "" || strings.Contains(event.Error, "secret prompt") {
				t.Fatalf("unsafe or unstable execution failure: %+v", event)
			}
			return
		case <-deadline:
			t.Fatal("timed out waiting for correlated execution failure")
		}
	}
}

func TestDormantResumePublishesCorrelatedExecutionFailure(t *testing.T) {
	output := make(chan protocol.DaemonEvent, 32)
	sm := NewSessionManager(output)
	sm.RegisterTerminalSession("dormant-resume-sid", t.TempDir(), 0, "", protocol.StatusExited, adapter.AgentClaude)
	installSentinelResumeCLI(t, "claude")
	starter := newRecordingResumeStarter()
	sm.setResumeStarter(starter.call)
	if err := sm.SendMessageWithInput(context.Background(), UserMessageInput{
		SessionID: "dormant-resume-sid", Content: "private input", RequestID: "req-dormant", MsgID: "msg-dormant",
	}); err != nil {
		t.Fatal(err)
	}
	_, procs := starter.snapshot()
	procs[0].exitCode = 23
	procs[0].release(errors.New("exit status 23"))
	deadline := time.After(time.Second)
	for {
		select {
		case event := <-output:
			if event.Type == "error" && event.Operation == "user_message" {
				if event.RequestID != "req-dormant" || event.MsgID != "msg-dormant" || event.Reason != "execution_failed" {
					t.Fatalf("failure=%+v", event)
				}
				return
			}
		case <-deadline:
			t.Fatal("timed out waiting for dormant resume failure")
		}
	}
}

func TestShutdownResumeProcessesCancelsInFlightStart(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix sentinel CLI fixture")
	}
	output := make(chan protocol.DaemonEvent, 32)
	sm := NewSessionManager(output)
	sm.RegisterTerminalSession("starting-resume-sid", t.TempDir(), 9999999, "", protocol.StatusExited, adapter.AgentClaude)
	installSentinelResumeCLI(t, "claude")
	starterEntered := make(chan struct{})
	starterCanceled := make(chan struct{})
	var enteredOnce sync.Once
	var canceledOnce sync.Once
	sm.setResumeStarter(func(ctx context.Context, _ resumeLaunchSpec) (resumeProcess, error) {
		enteredOnce.Do(func() { close(starterEntered) })
		<-ctx.Done()
		canceledOnce.Do(func() { close(starterCanceled) })
		return nil, ctx.Err()
	})

	requestCtx, requestCancel := context.WithCancel(context.Background())
	defer requestCancel()
	sendDone := make(chan error, 1)
	go func() {
		sendDone <- sm.SendMessage(requestCtx, "starting-resume-sid", "hello")
	}()
	<-starterEntered

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), time.Second)
	defer shutdownCancel()
	shutdownErr := sm.ShutdownResumeProcesses(shutdownCtx)
	select {
	case <-starterCanceled:
	default:
		requestCancel()
		<-sendDone
		t.Fatal("shutdown returned without canceling the admitted in-flight start")
	}
	if shutdownErr != nil {
		t.Fatalf("shutdown error=%v", shutdownErr)
	}
	if err := <-sendDone; !errors.Is(err, context.Canceled) {
		t.Fatalf("SendMessage error=%v, want context cancellation", err)
	}
	if got := sm.ownedResumeForSession("starting-resume-sid"); got != nil {
		t.Fatalf("failed start remained registered: %+v", got)
	}
}

func TestShutdownResumeProcessesCancelsAndWaits(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 8))
	cancelObserved := make(chan struct{})
	var cancelOnce sync.Once
	cancel := func() { cancelOnce.Do(func() { close(cancelObserved) }) }
	proc := newFakeResumeProcess(201, "")

	entry := mustRegisterOwnedResume(t, sm, "sid-a", cancel, proc)
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
	entry := mustRegisterOwnedResume(t, sm, "sid-b", func() {}, proc)
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
	entry := mustRegisterOwnedResume(t, sm, "sid-c", func() {}, proc)

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
	entry := mustRegisterOwnedResume(t, sm, "kill-sid", func() {
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
	var mu sync.Mutex
	var reasons []string
	recorder := func(reason string) {
		mu.Lock()
		defer mu.Unlock()
		reasons = append(reasons, reason)
	}

	// Graceful path: cancel is observed and the fake finishes.
	gracefulManager := NewSessionManager(make(chan protocol.DaemonEvent, 8))
	gracefulManager.SetResumeCleanupRecorder(recorder)
	proc1 := newFakeResumeProcess(701, "")
	cancelObserved := make(chan struct{})
	var cancelOnce sync.Once
	entry1 := mustRegisterOwnedResume(t, gracefulManager, "rec-a", func() {
		cancelOnce.Do(func() { close(cancelObserved) })
	}, proc1)
	go func() {
		<-cancelObserved
		proc1.release(nil)
		gracefulManager.finishOwnedResume(entry1, proc1.Wait())
	}()
	gracefulCtx, gracefulCancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer gracefulCancel()
	if err := gracefulManager.ShutdownResumeProcesses(gracefulCtx); err != nil {
		t.Fatalf("graceful shutdown error=%v", err)
	}

	// Shutdown permanently closes admission on a manager, so exercise the
	// independent force-kill outcome on a second lifecycle instance.
	forceManager := NewSessionManager(make(chan protocol.DaemonEvent, 8))
	forceManager.SetResumeCleanupRecorder(recorder)
	proc2 := &killableFakeResumeProcess{fakeResumeProcess: newFakeResumeProcess(702, "")}
	entry2 := mustRegisterOwnedResume(t, forceManager, "rec-b", func() {}, proc2)
	go func() {
		forceManager.finishOwnedResume(entry2, proc2.Wait())
	}()
	deadlineCtx, deadlineCancel := context.WithTimeout(context.Background(), time.Millisecond)
	defer deadlineCancel()
	if err := forceManager.ShutdownResumeProcesses(deadlineCtx); err != nil {
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
