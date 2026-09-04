package session

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/approval"
	"github.com/pocketctl/pocketctl/internal/discovery"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/ptyscan"
	"github.com/pocketctl/pocketctl/internal/watcher"
)

func (sm *SessionManager) CreateSession(ctx context.Context, config protocol.SessionConfig) (string, error) {
	if config.Agent == "" {
		config.Agent = adapter.AgentClaude
	}
	// Observer agents expose read-only historical content only. Reject before
	// permission validation, CLI/cwd resolution, worktree creation, or spawning.
	if err := rejectObserverAgent(config.Agent, ""); err != nil {
		return "", err
	}
	if !adapter.IsCreateCapableAgent(config.Agent) {
		return "", fmt.Errorf("%w: %s", adapter.ErrUnsupportedAgent, config.Agent)
	}
	if config.Permission == nil && (config.Agent == adapter.AgentClaude || config.Agent == adapter.AgentCodex) {
		cfg := adapter.DefaultPermissionConfig(config.Agent)
		config.Permission = &cfg
	}
	if err := adapter.ValidatePermissionConfig(config.Agent, config.Permission); err != nil {
		return "", err
	}
	// H-7: dangerous permission shapes (bypassPermissions, dontAsk,
	// dangerously-bypass, approval never, danger-full-access) are only legal
	// when the daemon operator flipped the local opt-in switch.
	sm.mu.RLock()
	cwdPolicy := sm.cwdPolicy
	remotePolicy := sm.remotePermission
	sm.mu.RUnlock()
	if err := adapter.ValidateRemotePermissionConfigWithPolicy(config.Agent, config.Permission, remotePolicy); err != nil {
		return "", err
	}
	config.Permission = clonePermission(config.Permission)

	// --- Working directory authorization (H-7) -----------------------------
	// The policy gate runs BEFORE any side effect (worktree creation,
	// auto-mkdir, hook install, PTY/agent spawn) and applies to every remote
	// session kind, including server-kind agents. It re-authorizes the
	// canonical path after creation steps below.
	authorizedCwd, err := cwdPolicy.AuthorizeProposed(resolveCwd(config.Cwd))
	if err != nil {
		return "", err
	}
	config.Cwd = authorizedCwd

	cliPath, err := sm.createDeps.resolveAgentCLI(config)
	if err != nil {
		return "", err
	}

	// Server-kind agents (opencode) are driven via a SessionBackend (shared
	// `opencode serve` + SSE), not the PTY spawn flow below.
	if adapter.BackendKindFor(config.Agent) == adapter.BackendServer {
		return sm.createDeps.startOpencode(sm, ctx, config)
	}

	// --- Working directory resolution --------------------------------------
	// Order: authorize (above) → (Scheme D worktree) → (auto-create) →
	// re-authorize canonical → validate → (Scheme A cwd-in-use) → register.
	resolvedCwd := authorizedCwd

	// We need the session id early so the worktree branch/path is deterministic
	// and the cwd registry can record it before any concurrent CreateSession.
	sessionID := uuid.New().String()

	// Scheme D: isolate the session in a git worktree so concurrent sessions on
	// the same repo never touch the same files. The worktree lives at
	// <repo>/.pocketctl/wt-<short> on branch pocketctl/<short>. It is intentionally
	// NOT cleaned up on exit (decision: preserve uncommitted work).
	var worktreePath, worktreeBranch string
	if config.Worktree {
		wtPath, branch, werr := createWorktree(resolvedCwd, sessionID)
		if werr != nil {
			return "", fmt.Errorf("工作目录 worktree 创建失败: %w", werr)
		}
		if werr := cwdPolicy.Allows(wtPath); werr != nil {
			return "", fmt.Errorf("工作目录 worktree 未通过授权复查: %w", werr)
		}
		worktreePath, worktreeBranch = wtPath, branch
		resolvedCwd = wtPath // all downstream logic targets the worktree
	} else if config.AutoCreateDir {
		// Auto-create a missing cwd (only in non-worktree mode; worktrees are
		// created by git). Best-effort: if the dir exists this is a no-op, and
		// permission errors are returned as bad_cwd instead of surfacing later as
		// an opaque PTY/Codex startup failure.
		if err := os.MkdirAll(resolvedCwd, 0o755); err != nil {
			return "", fmt.Errorf("工作目录创建失败: %s (%w)", resolvedCwd, err)
		}
		if err := cwdPolicy.Allows(resolvedCwd); err != nil {
			return "", fmt.Errorf("工作目录未通过授权复查: %w", err)
		}
	}

	if err := validateCwd(resolvedCwd); err != nil {
		return "", err
	}

	jsonlExcludeIDs := map[string]struct{}{}
	if config.Agent == adapter.AgentCodex {
		jsonlExcludeIDs = adapter.CodexRolloutSessionIDsForCwd(resolvedCwd)
	}

	// Scheme A: warn when the target cwd already has active sessions. Clients
	// opt-in to ignoring the warning by sending Force=true (informed consent).
	if !config.Force {
		if n := sm.CwdSessionCount(resolvedCwd); n > 0 {
			return "", fmt.Errorf("目录已被占用: %s (当前已有 %d 个活跃会话；如需继续请在客户端勾选\"强制创建\"后重试)", resolvedCwd, n)
		}
	}

	// Resolve model: prefer the model the client explicitly chose. For Claude,
	// fall back to the host's ~/.claude/settings.json default (opus/sonnet/haiku
	// alias resolution) so legacy clients without a model picker still surface a
	// value. Other agents (codex) don't read ~/.claude — leave model empty and
	// let the agent pick its own default.
	displayModel := config.Model
	if config.Agent == "" || config.Agent == adapter.AgentClaude {
		if config.Model == "" {
			config.Model = resolveCleanModel()
		}
		// config.Model is the alias/name passed to claude's --model (resolves via
		// ANTHROPIC_DEFAULT_*_MODEL, preserving e.g. [1M]). Derive the concrete
		// display name for /model (haiku → glm-4.7).
		displayModel = resolveModelAlias(config.Model)
	}

	if config.Agent == adapter.AgentCodex {
		if sm.createDeps.startCodexManaged != nil {
			if managedID, handled, managedErr := sm.createDeps.startCodexManaged(sm, ctx, config, cliPath, resolvedCwd, displayModel, worktreePath, worktreeBranch); handled {
				return managedID, managedErr
			}
		}
		if config.Permission != nil && config.Permission.ApprovalPolicy != "" && config.Permission.ApprovalPolicy != "never" {
			return "", fmt.Errorf("codex remote approval requires the managed app-server backend")
		}
		return sm.createCodexExecSession(ctx, sessionID, cliPath, resolvedCwd, config, displayModel, worktreePath, worktreeBranch)
	}

	// Build launch args via the agent-specific launcher. Claude takes a pinned
	// --session-id so the JSONL filename is known up front; codex generates its
	// own rollout filename (discovered later by globbing the sessions dir).
	launcher := adapter.NewLauncher(config.Agent)
	args := launcher.BuildInteractiveArgs(config)
	if config.Agent == "" || config.Agent == adapter.AgentClaude {
		args = append([]string{"--session-id", sessionID}, args...)
	}

	// Install the approval PreToolUse hook for Claude daemon sessions only —
	// including bypassPermissions. Rationale: even in bypass mode, a PreToolUse
	// hook in the host's ~/.claude/settings.json can return
	// permissionDecision:"ask", which OVERRIDES bypass and forces a y/n prompt.
	// Since the daemon discards PTY stdout, that prompt would be invisible and
	// deadlock the session. Our hook runs first and, when it has no opinion (the
	// common case), returns continue so Claude's own permission logic (and any
	// host hook) still applies. We only block on the approval socket when a
	// prompt would actually be shown — which the hook decides, not the mode.
	//
	// Other agents (codex) don't have a PreToolUse hook mechanism, so this is
	// skipped — they rely on their own --ask-for-approval flag instead.
	//
	// H-7: for modes that depend on remote approval the hook is mandatory —
	// without it an approval prompt would deadlock the unattended session, so
	// installation failures now fail closed instead of continuing silently.
	var extraEnv []string
	caps := adapter.Capabilities(config.Agent)
	if caps.SupportsApprovalHook && sm.approvalEnabled && sm.approvals != nil {
		if err := approval.EnsureHooks(resolvedCwd, sm.pocketctlPath); err != nil {
			needsApprovalLoop := config.Permission == nil ||
				(config.Permission.Agent == adapter.AgentClaude &&
					config.Permission.Mode != "bypassPermissions" &&
					config.Permission.Mode != "dontAsk")
			if needsApprovalLoop {
				return "", fmt.Errorf("approval hook 安装失败（fail closed）: %w", err)
			}
		} else {
			permMode := ""
			if config.Permission != nil {
				permMode = config.Permission.Mode
			}
			extraEnv = append(extraEnv,
				"POCKETCTL_SESSION_ID="+sessionID,
				"POCKETCTL_APPROVAL_SOCK="+sm.approvals.SocketPath(),
				"POCKETCTL_PERM_MODE="+permMode,
			)
		}
	}

	ctx, cancel := context.WithCancel(ctx)
	ptmx, cmd, err := startPTYCli(sm.ptyProvider, cliPath, args, resolvedCwd, extraEnv, config.Agent)
	if err != nil {
		cancel()
		if cwdErr := validateCwd(resolvedCwd); cwdErr != nil {
			return "", cwdErr
		}
		return "", fmt.Errorf("start pty %s: %w", config.Agent, err)
	}

	now := time.Now()
	ps := &ProcessState{
		SessionID:       sessionID, // real id (not pending-): --session-id pins it
		Cmd:             cmd,
		Cancel:          cancel,
		Status:          protocol.StatusIdle, // PTY up, awaiting first input
		StartedAt:       now,
		LastActivityAt:  now,
		Cwd:             resolvedCwd,
		Agent:           config.Agent,
		Source:          "daemon",
		PTY:             ptmx,
		Permission:      clonePermission(config.Permission),
		Model:           displayModel,
		WorktreePath:    worktreePath,
		WorktreeBranch:  worktreeBranch,
		InitialPrompt:   config.Prompt,
		JSONLExcludeIDs: jsonlExcludeIDs,
	}
	sm.mu.Lock()
	sm.sessions[sessionID] = ps
	if cmd.Process != nil {
		sm.childPids[cmd.Process.Pid] = true
		ps.Pid = cmd.Process.Pid
	}
	sm.mu.Unlock()
	slog.Default().Info("pty session process started",
		"session", sessionID,
		"agent", config.Agent,
		"cwd", resolvedCwd,
		"cli", cliPath,
		"pid", ps.Pid,
	)
	if config.Agent == adapter.AgentCodex {
		logCodexLaunchContext(sessionID, cmd.Env)
	}

	// Scheme A: register the session against its cwd so later CreateSession
	// calls can warn. Worktree sessions register under their worktree path.
	sm.registerCwd(sessionID, resolvedCwd)

	// Emit the initial prompt as user_text for immediate Web/iOS UI feedback.
	// (PTY claude also writes the user record to JSONL; emitting early gives
	// instant UI render while the PTY settles.)
	if config.Prompt != "" {
		sm.emitInitialPrompt(sessionID, config.Agent, config.Prompt)
	}

	// Background lifecycle: wait for JSONL → tailer (output) → initial prompt →
	// crash monitor.
	go sm.servePTYSession(ctx, ps, config.Prompt)
	return sessionID, nil
}

func (sm *SessionManager) createCodexExecSession(ctx context.Context, sessionID, cliPath, resolvedCwd string, config protocol.SessionConfig, displayModel, worktreePath, worktreeBranch string) (string, error) {
	args := []string{"exec", "--json", "--skip-git-repo-check", "-C", resolvedCwd}
	permissionArgs, err := adapter.PermissionArgs(adapter.AgentCodex, config.Permission, adapter.CommandCreate)
	if err != nil {
		return "", err
	}
	args = append(args, permissionArgs...)
	if config.Model != "" {
		args = append(args, "-m", config.Model)
	}
	if config.Prompt != "" {
		args = append(args, config.Prompt)
	}

	ctx, cancel := context.WithCancel(ctx)
	cmd := exec.CommandContext(ctx, cliPath, args...)
	cmd.Dir = resolvedCwd
	env := sanitizePTYEnv(os.Environ(), adapter.AgentCodex)
	env = ensureTERM(env, "xterm-256color")
	env = ensureCodexTerminfo(env)
	env = ensureEnvDefault(env, "COLORTERM", "truecolor")
	env = ensureEnvDefault(env, "PAGER", "cat")
	env = ensureEnvDefault(env, "GIT_PAGER", "cat")
	env = ensureEnvDefault(env, "GH_PAGER", "cat")
	cmd.Env = ensureEnvDefault(env, "TERM_PROGRAM", "pocketctl")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return "", fmt.Errorf("stdout pipe: %w", err)
	}
	if err := cmd.Start(); err != nil {
		cancel()
		return "", fmt.Errorf("start codex exec: %w", err)
	}

	now := time.Now()
	ps := &ProcessState{
		SessionID:      sessionID,
		Cmd:            cmd,
		Cancel:         cancel,
		Status:         protocol.StatusRunning,
		StartedAt:      now,
		LastActivityAt: now,
		Cwd:            resolvedCwd,
		Agent:          config.Agent,
		Source:         "daemon",
		Permission:     clonePermission(config.Permission),
		Model:          displayModel,
		WorktreePath:   worktreePath,
		WorktreeBranch: worktreeBranch,
		CodexPlanState: adapter.NewCodexPlanState(),
	}
	sm.mu.Lock()
	sm.sessions[sessionID] = ps
	if cmd.Process != nil {
		sm.childPids[cmd.Process.Pid] = true
		ps.Pid = cmd.Process.Pid
	}
	sm.mu.Unlock()
	sm.registerCwd(sessionID, resolvedCwd)
	slog.Default().Info("codex exec session process started",
		"session", sessionID,
		"cwd", resolvedCwd,
		"cli", cliPath,
		"pid", ps.Pid,
	)
	logCodexLaunchContext(sessionID, cmd.Env)
	if config.Prompt != "" {
		sm.emitInitialPrompt(sessionID, config.Agent, config.Prompt)
	}
	go sm.readOutput(ctx, cmd, stdout, adapter.NewCodexAdapterWithPlanState(ps.CodexPlanState), ps)
	return sessionID, nil
}

// servePTYSession runs the background lifecycle for a daemon PTY session:
// waits for the JSONL history file to appear, starts the JSONL tailer (the
// structured output channel — interactive-web-session D2), writes the initial
// prompt once the PTY has settled (D4), and monitors the process for exit (D7).
func (sm *SessionManager) servePTYSession(ctx context.Context, ps *ProcessState, initialPrompt string) {
	// Drain PTY stdout continuously. claude's TUI writes constantly (banner,
	// spinner, …); if nobody reads the PTY master, its buffer fills and claude
	// blocks. Structured output still comes via JSONL (D2), but we also feed
	// the bytes to a PTY menu scanner so inline selection prompts the TUI draws
	// (e.g. a host PreToolUse hook's "Do you want to proceed? ❶ Yes ❷ No") are
	// surfaced to clients as interactive_prompt cards instead of being lost.
	ps.PTYScanner = ptyscan.NewScanner(ps.SessionID)
	go sm.drainPTY(ctx, ps)

	// Monitor process exit immediately. Some CLIs can fail during startup before
	// the prompt delay elapses; waiting to call Wait until after the delay makes
	// the logs look like the prompt write caused the crash.
	done := make(chan struct{})
	go func() {
		_ = ps.Cmd.Wait()
		close(done)
	}()
	handleDone := func() {
		if ps.Cancel != nil {
			ps.Cancel()
		}
		sm.handlePTYExit(ps)
	}

	// Submit the initial prompt after the TUI settles (~10s to render banner +
	// plugins). IMPORTANT: do NOT wait for the JSONL file here — claude only
	// writes JSONL after the first turn is processed, so gating the prompt on
	// JSONL existence deadlocks (no message → no turn → no JSONL → no prompt).
	if initialPrompt != "" {
		select {
		case <-ctx.Done():
			return
		case <-done:
			handleDone()
			return
		case <-time.After(10 * time.Second):
		}
		if ps.PTY != nil {
			slog.Default().Info("pty initial prompt write",
				"session", ps.SessionID,
				"agent", ps.Agent,
				"prompt_len", len(initialPrompt),
			)
			n, err := ps.PTY.Write([]byte(initialPrompt + "\r"))
			if err != nil {
				slog.Default().Warn("pty initial prompt write failed",
					"session", ps.SessionID,
					"agent", ps.Agent,
					"bytes", n,
					"error", err,
				)
			} else {
				slog.Default().Info("pty initial prompt written",
					"session", ps.SessionID,
					"agent", ps.Agent,
					"bytes", n,
				)
			}
		}
	}

	// Start the JSONL tailer once the file appears (after the first turn). Runs
	// concurrently so it's ready whenever the agent writes.
	go func() {
		var tailer *watcher.JSONLTailer
		hasInitialPrompt := strings.TrimSpace(initialPrompt) != ""
		maxAttempts := 0
		if hasInitialPrompt {
			maxAttempts = 120 // up to ~60s after the prompt
		}
		sm.mu.RLock()
		tailerSessionID := ps.SessionID
		tailerCwd := ps.Cwd
		tailerAgent := ps.Agent
		sm.mu.RUnlock()
		for i := 0; maxAttempts == 0 || i < maxAttempts; i++ {
			select {
			case <-ctx.Done():
				return
			default:
			}
			// Re-resolve each iteration — the JSONL file only appears after
			// the agent's first turn, and the path resolver returns err until then.
			sm.mu.RLock()
			currentID := ps.SessionID
			currentCwd := ps.Cwd
			currentAgent := ps.Agent
			startedAt := ps.StartedAt
			sm.mu.RUnlock()
			hints := adapter.PTYResolveHints{
				StartedAt:         startedAt,
				InitialPrompt:     ps.InitialPrompt,
				ExcludeSessionIDs: ps.JSONLExcludeIDs,
			}
			if jsonlPath, realID, err := adapter.ResolveJSONLPathForPTY(currentAgent, currentID, currentCwd, hints); err == nil {
				if t, e := watcher.NewJSONLTailerFromStart(jsonlPath, currentAgent); e == nil {
					tailer = t
					tailerSessionID = currentID
					tailerCwd = currentCwd
					tailerAgent = currentAgent
					if realID != "" && realID != currentID {
						oldID := currentID
						if cwd, agent, changed := sm.remapSessionID(oldID, realID); changed {
							tailerSessionID = realID
							tailerCwd = cwd
							tailerAgent = agent
							sm.outputCh <- protocol.DaemonEvent{
								Type: "session_id_changed", SessionID: realID, OldSessionID: oldID,
							}
						}
					}
					break
				}
			}
			time.Sleep(500 * time.Millisecond)
		}
		if tailer == nil {
			if !hasInitialPrompt {
				return
			}
			sm.mu.RLock()
			errorSessionID := ps.SessionID
			errorAgent := ps.Agent
			errorCwd := ps.Cwd
			ptyTail := append([]byte(nil), ps.PTYOutputTail...)
			sm.mu.RUnlock()
			ptySnapshot := ptyscan.TextSnapshot(ptyTail)
			slog.Default().Warn("pty jsonl missing",
				"session", errorSessionID,
				"agent", errorAgent,
				"cwd", errorCwd,
				"pty_tail", ptySnapshot,
			)
			// JSONL file never appeared within 60s. Notify clients instead of
			// leaving the UI stuck on "no response".
			sm.outputCh <- protocol.DaemonEvent{
				Type:      "error",
				SessionID: errorSessionID,
				Error:     jsonlMissingError(errorAgent, ptySnapshot),
			}
			// Also mark the session as errored so the UI doesn't stay in
			// "creating" / "running" limbo.
			sm.mu.Lock()
			if s, ok := sm.sessions[errorSessionID]; ok {
				s.Status = protocol.StatusError
			}
			sm.mu.Unlock()
			if sm.OnStateChanged != nil {
				sm.OnStateChanged()
			}
			sm.outputCh <- protocol.DaemonEvent{
				Type:      "session_status",
				SessionID: errorSessionID,
				Status:    protocol.StatusError,
			}
			return
		}
		sm.SetTailer(tailerSessionID, tailer)
		// If the initial prompt is a slash command, record it so the first
		// command_receipt (if any) carries the correct command name.
		if initialPrompt != "" {
			tailer.SetPendingCmd(initialPrompt)
		}
		tailerEvents := make(chan protocol.DaemonEvent, 32)
		go tailer.Run(ctx, tailerEvents, nil)
		go func() {
			for {
				select {
				case <-ctx.Done():
					return
				case event := <-tailerEvents:
					sm.ObservePermissionEvent(event)
					sm.outputCh <- event
				}
			}
		}()
		if sm.OnSessionIDResolved != nil {
			sm.OnSessionIDResolved(tailerSessionID, tailerCwd, tailerAgent)
		}
		go sm.watchdogBusy(ctx, tailerSessionID)
	}()

	select {
	case <-ctx.Done():
		return
	case <-done:
		handleDone()
	}
}

func jsonlMissingError(agent, ptySnapshot string) string {
	var detail string
	if strings.TrimSpace(ptySnapshot) != "" {
		detail = "\n\n最近的终端输出：\n" + ptySnapshot
	}
	if agent == adapter.AgentCodex {
		return "会话未生成输出（Codex rollout JSONL 文件未创建）。可能原因：codex 启动失败、模型不可用，或 Codex CLI 未写入 ~/.codex/sessions。请检查 codex 是否正确安装及 CODEX_HOME 环境变量。" + detail
	}
	return "会话未生成输出（JSONL 文件未创建）。可能原因：claude 以临时模式运行或启动失败。请检查 claude 是否正确安装且环境变量无冲突。" + detail
}

// watchdogBusy monitors a session for stuck "busy" state. If the session
// remains busy with no JSONL file activity for longer than busyTimeout, it
// forces the status back to idle and notifies clients — preventing the UI
// from being permanently stuck on "executing" when the agent's idle event
// was missed (daemon restart, long tool calls, PTY I/O blockage).
//
// "No activity" is determined by the JSONL file's last modification time,
// NOT LastActivityAt (which is only updated on SendMessage for PTY sessions).
// This correctly distinguishes "agent is thinking (JSONL growing)" from
// "agent is truly stuck (JSONL not changing)".
func (sm *SessionManager) watchdogBusy(ctx context.Context, sessionID string) {
	const busyTimeout = 5 * time.Minute
	const checkInterval = 30 * time.Second

	ticker := time.NewTicker(checkInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			sm.mu.Lock()
			ps, ok := sm.sessions[sessionID]
			if !ok {
				sm.mu.Unlock()
				return
			}
			if ps.Status != protocol.StatusRunning {
				sm.mu.Unlock()
				continue // not busy — nothing to fix
			}
			cwd := ps.Cwd
			agent := ps.Agent
			sm.mu.Unlock()

			// Check JSONL file modification time — the authoritative signal
			// for whether the agent is still producing output.
			jsonlPath, err := adapter.ResolveJSONLPathFor(agent, sessionID, cwd)
			if err != nil {
				continue // can't determine — don't force
			}
			info, err := os.Stat(jsonlPath)
			if err != nil {
				continue // file gone — don't force (process exit handler covers this)
			}
			elapsed := time.Since(info.ModTime())
			if elapsed < busyTimeout {
				continue // JSONL still being written — agent is working normally
			}

			// Stuck: no JSONL activity for >5min while busy → abandoned turn,
			// then back to idle. Never a disguised completed.
			sm.abandonTurnOnActivityTimeout(sessionID)
			sm.mu.Lock()
			ps, ok = sm.sessions[sessionID]
			if !ok || ps.Status != protocol.StatusRunning {
				sm.mu.Unlock()
				continue
			}
			ps.Status = protocol.StatusIdle
			ps.LastActivityAt = time.Now()
			sm.mu.Unlock()

			// Notify clients so the UI un-sticks from "executing".
			sm.outputCh <- protocol.DaemonEvent{
				Type:      "session_status",
				SessionID: sessionID,
				Status:    protocol.StatusIdle,
			}
		}
	}
}

// handlePTYExit records the exit status of a daemon PTY session and notifies
// clients. interactive-web-session D7.
func (sm *SessionManager) handlePTYExit(ps *ProcessState) {
	sm.mu.Lock()
	exitCode := -1
	if ps.Cmd.ProcessState != nil {
		exitCode = ps.Cmd.ProcessState.ExitCode()
	}
	if exitCode == 0 {
		ps.Status = protocol.StatusExited
		ps.ExitReason = protocol.ExitReasonNormalExit
	} else {
		ps.Status = protocol.StatusError
		ps.ExitReason = protocol.ExitReasonProcessCrash
	}
	if ps.PTY != nil {
		_ = ps.PTY.Close()
		ps.PTY = nil
	}
	status := ps.Status
	reason := ps.ExitReason
	sid := ps.SessionID
	cwd := ps.Cwd
	agent := ps.Agent
	ptyTail := append([]byte(nil), ps.PTYOutputTail...)
	wtPath := ps.WorktreePath
	wtBranch := ps.WorktreeBranch
	sm.mu.Unlock()
	// Active turns terminalize (crash → failed / pending interrupt →
	// interrupted / otherwise abandoned) before the exit status is published.
	sm.terminalizeTurnOnExit(sid, reason)
	if sm.OnStateChanged != nil {
		sm.OnStateChanged()
	}
	slog.Default().Warn("pty session process exited",
		"session", sid,
		"agent", agent,
		"cwd", cwd,
		"status", status,
		"exit_reason", reason,
		"exit_code", exitCode,
		"pty_tail", ptyscan.TextSnapshot(ptyTail),
	)

	// Drain any pending tool-use approval so the hook process exits promptly,
	// and remove the PreToolUse hook we injected into the project settings.
	if sm.approvals != nil {
		sm.approvals.DrainSession(sid)
	}
	if cwd != "" {
		_ = approval.RemoveHooks(cwd)
	}
	// Scheme A/C: release the cwd registry slot and all file locks held by
	// this session so other sessions on the same directory can proceed.
	sm.unregisterCwd(sid, cwd)
	if sm.fileLocks != nil {
		sm.fileLocks.ReleaseAll(sid)
	}

	sm.outputCh <- protocol.DaemonEvent{
		Type:           "session_status",
		SessionID:      sid,
		Status:         status,
		ExitReason:     reason,
		WorktreePath:   wtPath,
		WorktreeBranch: wtBranch,
	}
}

// SetSessionExited marks a terminal session as exited (process died).
// AbortSession cancels and cleans up a pending session, killing the claude subprocess.
// Returns true if the session existed and was aborted, false if not found.
// If the session has already resolved to a real ID (not pending-*), returns false
// without killing (the session is already established and should not be aborted).
func (sm *SessionManager) AbortSession(sessionID string) bool {
	aborted, _ := sm.AbortSessionWithError(sessionID)
	return aborted
}

// AbortSessionWithError preserves the legacy boolean result while surfacing a
// typed observer rejection to daemon protocol handlers.
func (sm *SessionManager) AbortSessionWithError(sessionID string) (bool, error) {
	_, release, err := sm.acquireObserverDrive(context.Background(), sessionID)
	if err != nil {
		return false, err
	}
	defer release()
	sm.mu.Lock()
	ps, ok := sm.sessions[sessionID]
	if !ok {
		sm.mu.Unlock()
		return false, nil
	}
	// Don't abort sessions that have resolved to a real ID (not pending-*)
	if !strings.HasPrefix(sessionID, "pending-") {
		sm.mu.Unlock()
		return false, nil
	}
	delete(sm.sessions, sessionID)
	if ps.Cancel != nil {
		ps.Cancel()
	}
	if ps.Cmd != nil && ps.Cmd.Process != nil {
		if sm.proc != nil {
			_ = sm.proc.Kill(ps.Cmd.Process.Pid)
		} else {
			_ = ps.Cmd.Process.Kill()
		}
	}
	if ps.Cmd != nil && ps.Cmd.Process != nil {
		delete(sm.childPids, ps.Cmd.Process.Pid)
	}
	sm.mu.Unlock()
	return true, nil
}

// tryResumeHistorical re-registers a session that exists on disk (JSONL
// history) but isn't in the in-memory map — typically a session from before
// the current daemon process started, still listed in the web UI from the
// relay DB. It locates the JSONL, extracts the cwd, and registers the session
// as terminal/exited so SendMessage's existing --resume path drives it.
// Returns false only if no JSONL exists (genuinely unknown session).
func (sm *SessionManager) tryResumeHistorical(sessionID string) bool {
	type historicalSession struct {
		agent      string
		source     string
		control    string
		cwd        string
		permission *protocol.PermissionConfig
		activityAt time.Time
	}

	var historical *historicalSession
	for _, agentType := range []string{adapter.AgentClaude, adapter.AgentCodex} {
		jsonlPath, err := adapter.ResolveJSONLPathFor(agentType, sessionID, "")
		if err != nil {
			continue
		}
		cwd := ""
		resolvedAgent := agentType
		source := "terminal"
		control := ""
		if agentType == adapter.AgentCodex {
			if meta, metaOK := adapter.ReadCodexRolloutMetadata(jsonlPath); metaOK {
				cwd = meta.Cwd
				classification := adapter.ClassifyCodexOrigin(meta)
				if classification.Classified && adapter.IsObserverAgent(classification.AgentType) {
					resolvedAgent = classification.AgentType
					source = "observer"
					control = protocol.ControlLegacyReadOnly
				}
			}
		} else {
			cwd = extractCwdFromJSONL(jsonlPath)
			if cwd == "" {
				// Fallback: decode cwd from the projects dir name
				// (-Users-foo-bar → /Users/foo/bar).
				cwd = cwdFromProjectsDir(jsonlPath)
			}
		}
		activityAt := time.Now()
		if info, statErr := os.Stat(jsonlPath); statErr == nil {
			activityAt = info.ModTime()
			if now := time.Now(); activityAt.After(now) {
				activityAt = now
			}
		}
		historical = &historicalSession{
			agent: resolvedAgent, source: source, control: control, cwd: cwd, activityAt: activityAt,
		}
		if agentType == adapter.AgentClaude {
			historical.permission = extractClaudePermissionFromJSONL(jsonlPath)
		} else if !adapter.IsObserverAgent(resolvedAgent) {
			cfg := adapter.DefaultPermissionConfig(agentType)
			historical.permission = &cfg
		}
		break
	}
	if historical == nil {
		return false
	}
	now := time.Now()
	sm.mu.Lock()
	defer sm.mu.Unlock()
	// Re-check under lock: another goroutine may have registered it concurrently.
	if _, exists := sm.sessions[sessionID]; exists {
		return true
	}
	sm.sessions[sessionID] = &ProcessState{
		SessionID:      sessionID,
		Status:         protocol.StatusExited,
		Source:         historical.source,
		ControlMode:    historical.control,
		StartedAt:      now,
		LastActivityAt: historical.activityAt,
		Cwd:            historical.cwd,
		Agent:          historical.agent,
		Permission:     clonePermission(historical.permission),
	}
	return true
}

// EnsureSessionLoaded restores JSONL-backed history into the in-memory map so
// metadata requests after a daemon restart still return model and permission.
func (sm *SessionManager) EnsureSessionLoaded(sessionID string) bool {
	sm.mu.RLock()
	_, ok := sm.sessions[sessionID]
	sm.mu.RUnlock()
	if ok {
		return true
	}
	return sm.tryResumeHistorical(sessionID)
}

// EnsureOpencodeSessionLoaded restores a session from the shared OpenCode serve
// before falling back to Claude/Codex JSONL history. The fallback is safe only
// when the serve authoritatively reports that the ID is not an OpenCode session.
func (sm *SessionManager) EnsureOpencodeSessionLoaded(sessionID string) bool {
	loaded, notFound := sm.loadOpencodeSessionFromServe(sessionID)
	if loaded {
		return true
	}
	if notFound {
		return sm.EnsureSessionLoaded(sessionID)
	}
	return false
}

func extractClaudePermissionFromJSONL(path string) *protocol.PermissionConfig {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var mode string
	for _, line := range strings.Split(string(data), "\n") {
		var entry struct {
			Type           string `json:"type"`
			PermissionMode string `json:"permissionMode"`
			Content        string `json:"content"`
		}
		if json.Unmarshal([]byte(line), &entry) == nil && entry.Type == "permission-mode" {
			mode = strings.TrimSpace(entry.PermissionMode)
			if mode == "" {
				mode = strings.TrimSpace(entry.Content)
			}
		}
	}
	if mode == "" {
		return nil
	}
	return &protocol.PermissionConfig{Agent: adapter.AgentClaude, Mode: mode}
}

// isProcessAlive checks if a process with the given PID is running.
// PR2: delegates to the platform ProcessController (was syscall.Kill), so
// session no longer imports syscall.
func isProcessAlive(pid int) bool {
	return defaultProc.IsAlive(pid)
}

func (sm *SessionManager) KillSession(sessionID string) error {
	_, release, err := sm.acquireObserverDrive(context.Background(), sessionID)
	if err != nil {
		return err
	}
	defer release()
	sm.mu.Lock()
	ps, ok := sm.sessions[sessionID]
	cwd := ""
	if ok {
		cwd = ps.Cwd
	}
	sm.mu.Unlock()
	if !ok {
		return fmt.Errorf("session not found: %s", sessionID)
	}
	if ps.Backend != nil {
		if err := ps.Backend.Close(sessionID); err != nil {
			return err
		}
		now := time.Now()
		sm.mu.Lock()
		ps.Status = protocol.StatusKilled
		ps.LastActivityAt = now
		sm.mu.Unlock()
		sm.unregisterCwd(sessionID, cwd)
		if sm.fileLocks != nil {
			sm.fileLocks.ReleaseAll(sessionID)
		}
		sm.outputCh <- protocol.DaemonEvent{
			Type: "session_status", SessionID: sessionID, Status: protocol.StatusKilled,
			LastActivityAt: now.UTC().Format(time.RFC3339),
		}
		return nil
	}
	if ps.Cancel != nil {
		ps.Cancel()
	}
	// Daemon-owned one-shot resume: prefer the registry handle so the single
	// Wait owner reaps the process; never call Wait a second time here.
	if entry := sm.ownedResumeForSession(sessionID); entry != nil {
		select {
		case <-entry.done:
		default:
			if entry.cancel != nil {
				entry.cancel()
			}
			killTimer := time.NewTimer(5 * time.Second)
			select {
			case <-entry.done:
				killTimer.Stop()
			case <-killTimer.C:
				sm.killOwnedResume(entry)
			}
		}
	}
	// Drain any pending tool-use approval so the hook process exits promptly.
	if sm.approvals != nil {
		sm.approvals.DrainSession(sessionID)
	}
	// interactive-web-session D7/6.2: for PTY daemon sessions, try a graceful
	// /exit, then ensure the PTY master is closed on return.
	sm.mu.RLock()
	ptyFile := ps.PTY
	sm.mu.RUnlock()
	if ptyFile != nil {
		_, _ = ptyFile.Write([]byte("/exit\r"))
		defer ptyFile.Close()
	}
	// Wait for the process to exit (readOutput goroutine calls Wait),
	// but with a timeout so we don't block forever.
	deadline := time.After(5 * time.Second)
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		sm.mu.RLock()
		status := ps.Status
		sm.mu.RUnlock()
		if status == protocol.StatusKilled || status == protocol.StatusCompleted || status == protocol.StatusError {
			break
		}
		select {
		case <-ticker.C:
			// keep polling
		case <-deadline:
			// Force kill if still running (PR2: via platform ProcessController, was syscall.SIGKILL)
			if ps.Cmd != nil && ps.Cmd.Process != nil {
				_ = defaultProc.Kill(ps.Cmd.Process.Pid)
			}
			sm.mu.Lock()
			ps.Status = protocol.StatusKilled
			ps.LastActivityAt = time.Now()
			sm.mu.Unlock()
			if cwd != "" {
				_ = approval.RemoveHooks(cwd)
			}
			// Scheme A/C: release cwd registry + file locks on forced kill.
			sm.unregisterCwd(sessionID, cwd)
			if sm.fileLocks != nil {
				sm.fileLocks.ReleaseAll(sessionID)
			}
			return nil
		}
	}
	if cwd != "" {
		_ = approval.RemoveHooks(cwd)
	}
	// Scheme A/C: even on graceful kill, release the cwd slot and file locks.
	// (handlePTYExit may also run for daemon sessions; double release is safe.)
	sm.unregisterCwd(sessionID, cwd)
	if sm.fileLocks != nil {
		sm.fileLocks.ReleaseAll(sessionID)
	}
	return nil
}

// agentCLIName maps pocketctl agent types to the CLI binary name they install.
// Mirrors internal/discovery's knownAgents so there's a single source of truth
// per agent (discovery is the canonical registry; this is the session layer's
// lookup for spawning).
func agentCLIName(agentType string) string {
	switch agentType {
	case adapter.AgentClaude:
		return "claude"
	case adapter.AgentCodex:
		return "codex"
	default:
		// opencode / unknown → use the type as-is (its CLI usually matches).
		return agentType
	}
}

func findAgentCLI(agent string) (string, error) {
	name := agentCLIName(agent)
	path, _, found := discovery.ResolveAgent(name)
	if !found {
		return "", fmt.Errorf("agent CLI not found: %s (%s)", agent, name)
	}
	if agent == adapter.AgentCodex {
		if native := resolveCodexNativeBinary(path); native != "" {
			return native, nil
		}
	}
	return path, nil
}

func resolveCodexNativeBinary(cliPath string) string {
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" && runtime.GOOS != "windows" {
		return ""
	}
	realPath, err := filepath.EvalSymlinks(cliPath)
	if err != nil {
		realPath = cliPath
	}
	if !strings.HasSuffix(filepath.ToSlash(realPath), "/@openai/codex/bin/codex.js") {
		return ""
	}
	var pkg string
	var triple string
	switch runtime.GOOS + "/" + runtime.GOARCH {
	case "darwin/arm64":
		pkg, triple = "@openai/codex-darwin-arm64", "aarch64-apple-darwin"
	case "darwin/amd64":
		pkg, triple = "@openai/codex-darwin-x64", "x86_64-apple-darwin"
	case "linux/arm64":
		pkg, triple = "@openai/codex-linux-arm64", "aarch64-unknown-linux-musl"
	case "linux/amd64":
		pkg, triple = "@openai/codex-linux-x64", "x86_64-unknown-linux-musl"
	case "windows/amd64":
		pkg, triple = "@openai/codex-win32-x64", "x86_64-pc-windows-msvc"
	case "windows/arm64":
		pkg, triple = "@openai/codex-win32-arm64", "aarch64-pc-windows-msvc"
	default:
		return ""
	}
	root := filepath.Dir(filepath.Dir(realPath))
	exe := "codex"
	if runtime.GOOS == "windows" {
		exe = "codex.exe"
	}
	native := filepath.Join(root, "node_modules", pkg, "vendor", triple, "bin", exe)
	if info, err := os.Stat(native); err == nil && !info.IsDir() {
		return native
	}
	return ""
}

func logCodexLaunchContext(sessionID string, env []string) {
	home := envValue(env, "HOME")
	codexHome := envValue(env, "CODEX_HOME")
	if codexHome == "" && home != "" {
		codexHome = filepath.Join(home, ".codex")
	}
	tmpDir := envValue(env, "TMPDIR")
	shell := envValue(env, "SHELL")
	pathValue := envValue(env, "PATH")
	terminfoDirs := envValue(env, "TERMINFO_DIRS")
	slog.Default().Info("codex launch context",
		"session", sessionID,
		"home", home,
		"home_exists", pathExists(home),
		"codex_home", codexHome,
		"codex_home_exists", pathExists(codexHome),
		"sessions_dir_exists", pathExists(filepath.Join(codexHome, "sessions")),
		"tmpdir", tmpDir,
		"tmpdir_exists", pathExists(tmpDir),
		"shell", shell,
		"shell_exists", pathExists(shell),
		"path_has_homebrew", strings.Contains(pathValue, "/opt/homebrew/bin"),
		"path_has_codex_path", strings.Contains(pathValue, "/codex-path"),
		"path_has_codex_shim", strings.Contains(pathValue, "/.codex/tmp/arg0/"),
		"terminfo_dirs_set", terminfoDirs != "",
		"terminfo_dirs", terminfoDirs,
		"term_program", envValue(env, "TERM_PROGRAM"),
		"colorterm_set", envValue(env, "COLORTERM") != "",
		"pager", envValue(env, "PAGER"),
		"mcp_github_token_set", envValue(env, "CODEX_GITHUB_PERSONAL_ACCESS_TOKEN") != "",
		"https_proxy_set", envValue(env, "HTTPS_PROXY") != "" || envValue(env, "https_proxy") != "",
		"http_proxy_set", envValue(env, "HTTP_PROXY") != "" || envValue(env, "http_proxy") != "",
	)
}

func envValue(env []string, key string) string {
	prefix := key + "="
	for _, kv := range env {
		if strings.HasPrefix(kv, prefix) {
			return strings.TrimPrefix(kv, prefix)
		}
	}
	return ""
}

func pathExists(path string) bool {
	if strings.TrimSpace(path) == "" {
		return false
	}
	_, err := os.Stat(path)
	return err == nil
}
