package session

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/ptyscan"
)

// ResolveInteractivePrompt writes the user's menu choice back to the PTY so the
// agent's blocking selection prompt proceeds. The choice is the on-screen option
// index (e.g. "1"); we append a CR the same way SendMessage submits chat input.
// requestID must match the scanner's currently-active prompt or the response is
// rejected (stale/late answer for an already-resolved or superseded prompt).
func (sm *SessionManager) ResolveInteractivePrompt(sessionID, requestID, choice string) error {
	if choice == "" {
		return fmt.Errorf("empty choice")
	}

	// opencode sessions answer questions via the serve API. choice is the
	// selected option label; opencode expects answers as [[label]].
	if b := sm.opencodeBackendFor(sessionID); b != nil {
		return b.coord.server.ReplyQuestion(context.Background(), sessionID, requestID, [][]string{{choice}})
	}

	sm.mu.Lock()
	ps, ok := sm.sessions[sessionID]
	scanner := ps.PTYScanner
	ptyFile := ps.PTY
	// Validate and claim the pending prompt atomically: a matching requestID
	// clears the scanner's active state so a concurrent/duplicate answer can't
	// write twice.
	if ok && (scanner == nil || scanner.ActiveRequestID() != requestID) {
		active := ""
		if scanner != nil {
			active = scanner.ActiveRequestID()
		}
		sm.mu.Unlock()
		return fmt.Errorf("interactive prompt %q not pending (active=%q)", requestID, active)
	}
	if scanner != nil {
		scanner.Reset()
	}
	sm.mu.Unlock()

	if !ok {
		return fmt.Errorf("session not found: %s", sessionID)
	}
	if ptyFile == nil {
		return fmt.Errorf("session %s PTY already closed", sessionID)
	}
	if _, err := ptyFile.Write([]byte(choice + "\r")); err != nil {
		return fmt.Errorf("write choice to PTY: %w", err)
	}
	return nil
}

func (sm *SessionManager) PendingInteractivePrompt(sessionID string) (protocol.DaemonEvent, bool) {
	sm.mu.RLock()
	ps, ok := sm.sessions[sessionID]
	var prompt *ptyscan.PendingPrompt
	if ok && ps.PTYScanner != nil {
		prompt = ps.PTYScanner.ActivePrompt()
	}
	sm.mu.RUnlock()
	if !ok || prompt == nil {
		return protocol.DaemonEvent{}, false
	}

	input, _ := json.Marshal(map[string]any{
		"prompt":  prompt.PromptText,
		"options": prompt.Options,
	})
	return protocol.DaemonEvent{
		Type:      "interactive_prompt",
		SessionID: sessionID,
		RequestID: prompt.RequestID,
		Input:     input,
	}, true
}

func (sm *SessionManager) readOutput(ctx context.Context, cmd *exec.Cmd, stdout io.Reader, adp adapter.AgentAdapter, ps *ProcessState) {
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)

	initSeen := false
	for scanner.Scan() {
		line := scanner.Text()
		events, err := adp.ParseStreamLine(line)
		if err != nil {
			sm.outputCh <- protocol.DaemonEvent{
				Type: "error", SessionID: ps.SessionID, Error: fmt.Sprintf("parse error: %v", err),
			}
			continue
		}
		if sid := adp.SessionID(); sid != "" {
			sm.mu.RLock()
			oldID := ps.SessionID
			sm.mu.RUnlock()
			if cwd, agent, changed := sm.remapSessionID(oldID, sid); changed {
				sm.outputCh <- protocol.DaemonEvent{
					Type: "session_id_changed", SessionID: sid, OldSessionID: oldID,
				}
				// Trigger title extraction from JSONL for daemon-created sessions
				if sm.OnSessionIDResolved != nil {
					sm.OnSessionIDResolved(sid, cwd, agent)
				}
			}
		}
		// Cache slash commands reported by the agent's init event (emitted once,
		// alongside sessionID) — the authoritative list of commands available in
		// the current (-p) environment.
		if !initSeen && len(adp.SlashCommands()) > 0 {
			initSeen = true
			sm.mu.Lock()
			ps.SlashCommands = adp.SlashCommands()
			sm.mu.Unlock()
		}
		// Update last activity on each received event
		if len(events) > 0 {
			sm.mu.Lock()
			ps.LastActivityAt = time.Now()
			sm.mu.Unlock()
		}
		for _, evt := range events {
			if evt.SessionID == "" {
				evt.SessionID = ps.SessionID
			}
			if evt.Effort != "" {
				sm.SetSessionEffort(ps.SessionID, evt.Effort)
			}
			sm.ObservePermissionEvent(evt)
			sm.outputCh <- evt
		}
	}

	exitErr := cmd.Wait()
	now := time.Now()
	status := protocol.StatusCompleted
	if exitErr != nil {
		if ctx.Err() == context.Canceled {
			status = protocol.StatusKilled
		} else {
			status = protocol.StatusError
		}
	}
	sm.mu.Lock()
	ps.Status = status
	ps.LastActivityAt = now
	sm.mu.Unlock()
	sm.outputCh <- protocol.DaemonEvent{
		Type:           "session_status",
		SessionID:      ps.SessionID,
		Status:         status,
		LastActivityAt: now.UTC().Format(time.RFC3339),
	}
}

func (sm *SessionManager) SendMessage(ctx context.Context, sessionID string, content string) error {
	sm.mu.RLock()
	ps, ok := sm.sessions[sessionID]
	sm.mu.RUnlock()
	if !ok {
		// Not in memory. A daemon restart loses the in-memory map, but a session
		// still shown in the web UI (persisted in the relay DB) usually has its
		// JSONL history on disk. Resume it via `claude --resume` so the user can
		// keep talking instead of hitting "session not found". Registered as
		// source=terminal/status=exited, so the --resume path below drives it.
		// Falls back to "session not found" only if no JSONL exists either.
		if !sm.tryResumeHistorical(sessionID) {
			return fmt.Errorf("session not found: %s", sessionID)
		}
		sm.mu.RLock()
		ps, ok = sm.sessions[sessionID]
		sm.mu.RUnlock()
		if !ok {
			return fmt.Errorf("session not found: %s", sessionID)
		}
	}
	// Server-kind sessions (opencode) are driven via their SessionBackend over
	// HTTP; the reply is forwarded by the SSE demux (owned) or DirWatch (terminal).
	if ps.Backend != nil {
		sm.mu.Lock()
		ps.LastActivityAt = time.Now()
		src := ps.Source
		agent := ps.Agent
		sm.mu.Unlock()
		// Echo the user's message for instant feedback only for owned sessions:
		// the SSE demux skips the user echo, so we supply it here. Terminal
		// sessions get their user_text from DirWatch (storage), so echoing here
		// would duplicate.
		if src != "terminal" && agent != adapter.AgentCodex {
			sm.outputCh <- protocol.DaemonEvent{Type: "user_text", SessionID: sessionID, Text: content}
		}
		return ps.Backend.Send(ctx, sessionID, content)
	}

	// ps is non-nil here — safe to read fields.
	sm.mu.RLock()
	cwd := ps.Cwd
	agentType := ps.Agent
	isRunning := ps.Status == protocol.StatusRunning || ps.Status == "busy"
	isExited := ps.Status == protocol.StatusExited || ps.Status == protocol.StatusCompleted
	source := ps.Source
	pid := ps.Pid
	sm.mu.RUnlock()
	// Update last activity — user sent a message
	sm.mu.Lock()
	ps.LastActivityAt = time.Now()
	sm.mu.Unlock()

	// Terminal session: check if process is still alive
	if source == "terminal" && pid > 0 {
		if isProcessAlive(pid) {
			if isRunning {
				// Terminal Claude is actively working — cannot send
				return fmt.Errorf("session busy in terminal")
			}
			// Terminal Claude is idle (waiting for input) — send via --resume
			return sm.sendToIdleTerminal(ctx, ps, content)
		}
		// Process is dead — resume from exited state or fall through
		if !isExited {
			// Mark as exited first if not already
			sm.SetSessionExited(sessionID, protocol.ExitReasonNormalExit)
		}
		// Fall through to spawn new --resume with stdout capture
	}

	// Terminal session in exited state (process already dead) — resume via new process
	if source == "terminal" && isExited {
		// Will spawn claude --resume below
	}

	// interactive-web-session D1/D4: daemon (web-created) session writes the
	// message to the persistent PTY claude's stdin (CR-terminated). No respawn —
	// the same interactive process handles all messages, preserving context.
	if source == "daemon" {
		sm.mu.RLock()
		ptyFile := ps.PTY
		sm.mu.RUnlock()
		if ptyFile == nil {
			if agentType != adapter.AgentCodex {
				return fmt.Errorf("daemon session interactive pty unavailable (process exited)")
			}
		} else if !isProcessAlive(pid) {
			return fmt.Errorf("daemon session interactive pty unavailable (process exited)")
		} else {
			// Emit user_text for UI (the tailer also forwards claude's own records).
			sm.outputCh <- protocol.DaemonEvent{
				Type:      "user_text",
				SessionID: ps.SessionID,
				Text:      content,
			}
			sm.mu.Lock()
			ps.Status = protocol.StatusRunning
			ps.LastActivityAt = time.Now()
			sm.mu.Unlock()
			// B (web-post-send-feedback): notify web the turn is running. PTY interactive
			// mode previously omitted this, so the UI had no "working" feedback until
			// the adapter emitted Completed at turn end.
			sm.outputCh <- protocol.DaemonEvent{
				Type:           "session_status",
				SessionID:      ps.SessionID,
				Status:         protocol.StatusRunning,
				LastActivityAt: time.Now().UTC().Format(time.RFC3339),
			}
			if _, err := ptyFile.Write([]byte(content + "\r")); err != nil {
				// B: stdin write failed — roll back so web doesn't sit on "running" forever.
				sm.mu.Lock()
				ps.Status = protocol.StatusError
				sm.mu.Unlock()
				sm.outputCh <- protocol.DaemonEvent{
					Type:      "session_status",
					SessionID: ps.SessionID,
					Status:    protocol.StatusError,
				}
				return fmt.Errorf("pty stdin write: %w", err)
			}
			// Record the slash command (if any) so the tailer's JSONLStreamParser
			// can attach it to the next command_receipt (e.g. /compact, /clear).
			if ps.Tailer != nil {
				ps.Tailer.SetPendingCmd(content)
			}
			return nil
		}
	}

	// Below: terminal or daemon-exec session in a dormant state — resume via a
	// new one-shot process (claude -p --resume / codex exec resume).
	if agentType == "" {
		agentType = adapter.AgentClaude
	}
	cliPath, err := findAgentCLI(agentType)
	if err != nil {
		return err
	}
	launcher := adapter.NewLauncher(agentType)
	args := launcher.BuildResumeArgs(content, sessionID, protocol.SessionConfig{Permission: clonePermission(ps.Permission)})
	ctx, cancel := context.WithCancel(ctx)
	cmd := exec.CommandContext(ctx, cliPath, args...)
	if cwd != "" {
		cmd.Dir = cwd
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return fmt.Errorf("stdout pipe: %w", err)
	}
	if err := cmd.Start(); err != nil {
		cancel()
		return fmt.Errorf("start process: %w", err)
	}

	adp := adapter.NewAdapter(agentType, content)
	sm.mu.Lock()
	ps.Cmd = cmd
	ps.Cancel = cancel
	ps.Status = protocol.StatusRunning
	ps.Source = source // Keep original source
	sm.mu.Unlock()

	// claude -p (stream-json) does not echo the user's message, so emit it ourselves.
	sm.outputCh <- protocol.DaemonEvent{
		Type:      "user_text",
		SessionID: ps.SessionID,
		Text:      content,
	}
	go sm.readOutput(ctx, cmd, stdout, adp, ps)
	return nil
}

// RequiresResume reports whether SendMessage would have to recreate a dormant
// root-session process. Relay attaches a resume quota grant only for this path;
// messages written to an already-live PTY/backend stay within the existing slot.
func (sm *SessionManager) RequiresResume(sessionID string) bool {
	sm.mu.RLock()
	ps, ok := sm.sessions[sessionID]
	if !ok {
		sm.mu.RUnlock()
		return true
	}
	backend := ps.Backend
	status := ps.Status
	pid := ps.Pid
	pty := ps.PTY
	source := ps.Source
	sm.mu.RUnlock()
	if backend != nil {
		return false
	}
	if status == protocol.StatusExited || status == protocol.StatusCompleted || status == protocol.StatusError || status == protocol.StatusKilled {
		return true
	}
	if source == "daemon" {
		return pty == nil || pid <= 0 || !isProcessAlive(pid)
	}
	if source == "terminal" {
		return pid <= 0 || !isProcessAlive(pid)
	}
	return false
}

// sendToIdleTerminal sends a message to a terminal session that's idle (alive but waiting for input).
// Uses a one-shot resume (claude --resume / codex exec resume) without stdout capture — the JSONL
// tailer handles event forwarding.
func (sm *SessionManager) sendToIdleTerminal(ctx context.Context, ps *ProcessState, content string) error {
	agentType := ps.Agent
	if agentType == "" {
		agentType = adapter.AgentClaude
	}
	cliPath, err := findAgentCLI(agentType)
	if err != nil {
		return err
	}

	launcher := adapter.NewLauncher(agentType)
	args := launcher.BuildResumeArgs(content, ps.SessionID, protocol.SessionConfig{Permission: clonePermission(ps.Permission)})
	ctx, cancel := context.WithCancel(ctx)
	cmd := exec.CommandContext(ctx, cliPath, args...)
	cmd.Dir = ps.Cwd
	// D1: capture stdout stream-json + adapter (unified command feedback path, like daemon sessions).
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return fmt.Errorf("stdout pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		cancel()
		return fmt.Errorf("start --resume: %w", err)
	}

	adp := adapter.NewAdapter(agentType, content)
	now := time.Now()
	sm.mu.Lock()
	ps.Cmd = cmd
	ps.Cancel = cancel
	ps.Status = protocol.StatusRunning
	ps.LastActivityAt = now
	sm.mu.Unlock()

	// Notify web that session is now running
	sm.outputCh <- protocol.DaemonEvent{
		Type:           "session_status",
		SessionID:      ps.SessionID,
		Status:         protocol.StatusRunning,
		LastActivityAt: time.Now().UTC().Format(time.RFC3339),
	}

	// D2: pause the JSONL tailer while this --resume runs to avoid double-forwarding
	// (stdout adapter covers all events; tailer would re-read the same JSONL lines).
	if ps.Tailer != nil {
		ps.Tailer.Pause()
	}

	// Wait for --resume to finish in background; forward stdout events via adapter.
	go func() {
		defer func() {
			if ps.Tailer != nil {
				ps.Tailer.Resume()
			}
		}()
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 1024*1024), 1024*1024)
		for scanner.Scan() {
			events, perr := adp.ParseStreamLine(scanner.Text())
			if perr != nil {
				continue
			}
			for _, evt := range events {
				if evt.SessionID == "" {
					evt.SessionID = ps.SessionID
				}
				sm.ObservePermissionEvent(evt)
				sm.outputCh <- evt
			}
		}
		cmd.Wait()
		resumeNow := time.Now()
		sm.mu.Lock()
		// Terminal process is still alive, so go back to idle
		ps.Status = protocol.StatusIdle
		ps.LastActivityAt = resumeNow
		sm.mu.Unlock()

		sm.outputCh <- protocol.DaemonEvent{
			Type:           "session_status",
			SessionID:      ps.SessionID,
			Status:         protocol.StatusIdle,
			LastActivityAt: time.Now().UTC().Format(time.RFC3339),
		}

		// Trigger notification callback
		if sm.OnNotifyTerminal != nil {
			sm.OnNotifyTerminal(ps.SessionID, ps.TTY)
		}
	}()

	return nil
}
