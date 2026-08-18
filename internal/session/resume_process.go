package session

import (
	"context"
	"fmt"
	"io"
	"os/exec"
	"sync"
	"time"
)

// resumeLaunchSpec describes one daemon-owned one-shot resume process
// (claude -p --resume / codex exec resume).
type resumeLaunchSpec struct {
	Path string
	Args []string
	Dir  string
	Env  []string
}

// resumeProcess is the narrow process seam behind dormant-session resume.
// Production uses startExecResumeProcess; tests inject fakes so no real
// agent CLI, shim, or PocketCtl launcher is ever spawned.
type resumeProcess interface {
	PID() int
	Stdout() io.Reader
	Wait() error
	Kill() error
}

// resumeStarter starts a resume process under the given context. Canceling
// the context must terminate the process.
type resumeStarter func(context.Context, resumeLaunchSpec) (resumeProcess, error)

// ownedResume is one registered daemon-owned one-shot resume. The goroutine
// that drains the process output owns the single Wait call and reports
// completion through finishOwnedResume. Generation protects the registry
// slot: an older resume finishing after a newer one started for the same
// session must not delete the newer entry.
type ownedResume struct {
	sessionID  string
	generation uint64
	cancel     context.CancelFunc
	process    resumeProcess
	done       chan struct{}
	waitErr    error
	waitOnce   sync.Once
}

// resumeShutdownFinalWait bounds the final reaping pass after force kill.
const resumeShutdownFinalWait = time.Second

// execResumeProcess adapts *exec.Cmd to the resumeProcess seam.
type execResumeProcess struct {
	cmd    *exec.Cmd
	stdout io.Reader
}

// startExecResumeProcess is the production starter: exec.CommandContext with
// cwd/env applied, stdout piped before start, started exactly once.
func startExecResumeProcess(ctx context.Context, spec resumeLaunchSpec) (resumeProcess, error) {
	cmd := exec.CommandContext(ctx, spec.Path, spec.Args...)
	if spec.Dir != "" {
		cmd.Dir = spec.Dir
	}
	if spec.Env != nil {
		cmd.Env = spec.Env
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("stdout pipe: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start process: %w", err)
	}
	return &execResumeProcess{cmd: cmd, stdout: stdout}, nil
}

func (p *execResumeProcess) PID() int {
	if p.cmd.Process == nil {
		return 0
	}
	return p.cmd.Process.Pid
}

func (p *execResumeProcess) Stdout() io.Reader { return p.stdout }

// Wait is the single terminal Wait owner for the underlying command.
func (p *execResumeProcess) Wait() error { return p.cmd.Wait() }

func (p *execResumeProcess) Kill() error {
	if p.cmd.Process == nil {
		return nil
	}
	return p.cmd.Process.Kill()
}

// resumeProcessCmd extracts the underlying *exec.Cmd so legacy ProcessState
// fields keep working. Nil for injected fakes.
func resumeProcessCmd(proc resumeProcess) *exec.Cmd {
	if ep, ok := proc.(*execResumeProcess); ok {
		return ep.cmd
	}
	return nil
}

// startResumeProcess launches a one-shot resume through the manager's
// starter seam (test-injectable; production uses startExecResumeProcess).
func (sm *SessionManager) startResumeProcess(ctx context.Context, spec resumeLaunchSpec) (resumeProcess, error) {
	sm.mu.RLock()
	starter := sm.resumeStarter
	sm.mu.RUnlock()
	if starter == nil {
		starter = startExecResumeProcess
	}
	return starter(ctx, spec)
}

// setResumeStarter overrides the resume starter. Test-only: the daemon always
// uses the exec-based starter.
func (sm *SessionManager) setResumeStarter(starter resumeStarter) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	sm.resumeStarter = starter
}

// registerOwnedResume records a started resume process under the next
// generation for sessionID. If a previous entry is still live it is canceled
// (product behavior serializes resumes via the busy check, so this is a
// defensive path only); its goroutine still finishes safely because removal
// compares the entry pointer.
func (sm *SessionManager) registerOwnedResume(sessionID string, cancel context.CancelFunc, process resumeProcess) *ownedResume {
	sm.mu.Lock()
	sm.resumeNextGen++
	entry := &ownedResume{
		sessionID:  sessionID,
		generation: sm.resumeNextGen,
		cancel:     cancel,
		process:    process,
		done:       make(chan struct{}),
	}
	if old := sm.resumeProcesses[sessionID]; old != nil {
		select {
		case <-old.done:
		default:
			if old.cancel != nil {
				old.cancel()
			}
		}
	}
	sm.resumeProcesses[sessionID] = entry
	sm.mu.Unlock()
	return entry
}

// finishOwnedResume is called exactly once by the single Wait owner after the
// process exited. It closes done and removes the registry entry only when it
// is still the current (sessionID, generation) owner.
func (sm *SessionManager) finishOwnedResume(entry *ownedResume, waitErr error) {
	entry.waitOnce.Do(func() {
		entry.waitErr = waitErr
		close(entry.done)
	})
	sm.mu.Lock()
	if current := sm.resumeProcesses[entry.sessionID]; current == entry {
		delete(sm.resumeProcesses, entry.sessionID)
	}
	sm.mu.Unlock()
}

func (sm *SessionManager) ownedResumeForSession(sessionID string) *ownedResume {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	return sm.resumeProcesses[sessionID]
}

// SetResumeCleanupRecorder installs a content-free recorder for resume
// lifecycle outcomes ("resume_cancelled", "resume_force_killed"). The daemon
// wires this to agentcontrol telemetry without creating a package dependency.
func (sm *SessionManager) SetResumeCleanupRecorder(rec func(reason string)) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	sm.resumeCleanupRecorder = rec
}

func (sm *SessionManager) recordResumeCleanup(reason string) {
	sm.mu.RLock()
	rec := sm.resumeCleanupRecorder
	sm.mu.RUnlock()
	if rec != nil {
		rec(reason)
	}
}

// ShutdownResumeProcesses cancels, waits for, and if necessary force kills
// every daemon-owned one-shot resume registered by this SessionManager. It
// never inspects or kills arbitrary system processes; terminal-discovered
// native agents are not in the registry and are never touched.
//
// The aggregated error describes counts only — never session IDs, paths, or
// prompts. Duplicate calls and already-exited processes are tolerated.
func (sm *SessionManager) ShutdownResumeProcesses(ctx context.Context) error {
	sm.mu.Lock()
	entries := make([]*ownedResume, 0, len(sm.resumeProcesses))
	for _, entry := range sm.resumeProcesses {
		entries = append(entries, entry)
	}
	sm.mu.Unlock()
	if len(entries) == 0 {
		return nil
	}

	canceled := make(map[*ownedResume]bool, len(entries))
	for _, entry := range entries {
		select {
		case <-entry.done:
			continue // already exited
		default:
		}
		if entry.cancel != nil {
			entry.cancel()
			canceled[entry] = true
		}
	}

	pending := make([]*ownedResume, 0, len(entries))
	for _, entry := range entries {
		select {
		case <-entry.done:
			// Graceful cancellation worked: exactly one outcome per entry.
			if canceled[entry] {
				sm.recordResumeCleanup("resume_cancelled")
			}
		case <-ctx.Done():
			pending = append(pending, entry)
		}
	}

	unreaped := 0
	if len(pending) > 0 {
		for _, entry := range pending {
			_ = entry.process.Kill()
			sm.recordResumeCleanup("resume_force_killed")
		}
		finalCtx, finalCancel := context.WithTimeout(context.Background(), resumeShutdownFinalWait)
		defer finalCancel()
		for _, entry := range pending {
			select {
			case <-entry.done:
			case <-finalCtx.Done():
				unreaped++
			}
		}
	}
	if unreaped > 0 {
		return fmt.Errorf("resume shutdown: %d of %d owned processes were not reaped", unreaped, len(entries))
	}
	return nil
}
