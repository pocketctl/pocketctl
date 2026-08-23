package session

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/agentcontrol"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/turn"
)

// CodexAppServerBackend drives daemon-owned Codex threads through the same
// long-running app-server used by official remote TUI clients.
type CodexAppServerBackend struct {
	sm         *SessionManager
	coord      *codexCoordinator
	client     codexRuntimeClient
	generation uint64
}

func newCodexAppServerBackend(sm *SessionManager, coord *codexCoordinator, client codexRuntimeClient, generation uint64) *CodexAppServerBackend {
	return &CodexAppServerBackend{sm: sm, coord: coord, client: client, generation: generation}
}

// tryCreateManagedCodexSession selects app-server only after enablement and a
// fresh capability probe. Returning handled=false is the compatibility gate:
// CreateSession then executes the unchanged codex exec --json backend.
func (sm *SessionManager) tryCreateManagedCodexSession(ctx context.Context, config protocol.SessionConfig, cliPath, cwd, model, worktreePath, worktreeBranch string) (string, bool, error) {
	cfg, err := agentcontrol.LoadConfig()
	if err != nil || cfg.Codex.State != agentcontrol.StateEnabled {
		_ = agentcontrol.RecordCodexFallback(agentcontrol.CodexFallbackDisabled)
		return "", false, nil
	}
	provider := sm.CodexRuntimeProvider()
	binary, version, err := provider.resolve()
	if err != nil || !agentcontrol.SupportsManagedCodexVersion(version) {
		category := agentcontrol.CodexFallbackMissing
		if err == nil {
			category = agentcontrol.CodexFallbackOldVersion
		}
		_ = agentcontrol.RecordCodexFallback(category)
		logCodexManagedFallback(cliPath, version, err)
		return "", false, nil
	}
	capabilities, err := provider.probe(ctx, binary, version)
	if err != nil || !capabilities.Managed() {
		_ = agentcontrol.RecordCodexFallback(agentcontrol.CodexFallbackCapabilities)
		logCodexManagedFallback(binary, version, err)
		return "", false, nil
	}
	snapshot, err := provider.coordinator.ensureStarted(ctx, binary, version, capabilities)
	if err != nil {
		_ = agentcontrol.RecordCodexFallback(agentcontrol.CodexFallbackRuntime)
		logCodexManagedFallback(binary, version, err)
		return "", false, nil
	}
	client, generation, ok := provider.coordinator.backendClient()
	if !ok || generation != snapshot.Generation {
		logCodexManagedFallback(binary, version, fmt.Errorf("runtime client unavailable"))
		return "", false, nil
	}
	backend := newCodexAppServerBackend(sm, provider.coordinator, client, generation)
	managedConfig := config
	managedConfig.Cwd = cwd
	managedConfig.Model = model
	sessionID, err := backend.Start(ctx, managedConfig)
	if err != nil {
		// thread/start may have crossed the process boundary, so do not create a
		// second exec-json thread after an ambiguous RPC failure.
		return "", true, err
	}
	now := time.Now()
	status := protocol.StatusIdle
	if provider.coordinator.currentTurn(sessionID) != "" {
		status = protocol.StatusRunning
	}
	ps := &ProcessState{
		SessionID: sessionID, Status: status, StartedAt: now, LastActivityAt: now,
		Cwd: cwd, Agent: adapter.AgentCodex, Source: "daemon", Permission: clonePermission(config.Permission),
		Model: model, WorktreePath: worktreePath, WorktreeBranch: worktreeBranch,
		Backend: backend, ControlMode: protocol.ControlManaged,
	}
	sm.mu.Lock()
	sm.sessions[sessionID] = ps
	sm.mu.Unlock()
	sm.registerCwd(sessionID, cwd)
	slog.Default().Info("Codex managed session ready", "session", sessionID, "generation", generation, "model", model)
	return sessionID, true, nil
}

func logCodexManagedFallback(binary, version string, err error) {
	attrs := []any{"binary", binary, "version", version, "backend", "exec-json"}
	if err != nil {
		attrs = append(attrs, "reason", err.Error())
	}
	slog.Default().Warn("Codex managed backend unavailable; using compatibility backend", attrs...)
}

func (b *CodexAppServerBackend) Start(ctx context.Context, config protocol.SessionConfig) (string, error) {
	params := map[string]any{"cwd": config.Cwd}
	if config.Model != "" {
		params["model"] = config.Model
	}
	applyCodexPermissionParams(params, config.Permission)
	var response struct {
		Thread struct {
			ID string `json:"id"`
		} `json:"thread"`
	}
	if err := b.client.Call(ctx, "thread/start", params, &response); err != nil {
		return "", fmt.Errorf("Codex thread/start: %w", err)
	}
	if response.Thread.ID == "" {
		return "", fmt.Errorf("Codex thread/start returned no thread id")
	}
	b.coord.markSubscribed(response.Thread.ID)
	if config.Prompt != "" {
		if err := b.startTurn(ctx, response.Thread.ID, config.Prompt, config); err != nil {
			return "", err
		}
	}
	return response.Thread.ID, nil
}

func (b *CodexAppServerBackend) Resume(ctx context.Context, threadID string) error {
	if threadID == "" {
		return fmt.Errorf("Codex thread id is required")
	}
	var response json.RawMessage
	if err := b.client.Call(ctx, "thread/resume", map[string]any{"threadId": threadID}, &response); err != nil {
		return fmt.Errorf("Codex thread/resume: %w", err)
	}
	return nil
}

func (b *CodexAppServerBackend) Send(ctx context.Context, sessionID, content string) error {
	input := []map[string]string{{"type": "text", "text": content}}
	if turnID := b.coord.currentTurn(sessionID); turnID != "" {
		params := map[string]any{"threadId": sessionID, "expectedTurnId": turnID, "input": input}
		if err := b.client.Call(ctx, "turn/steer", params, nil); err != nil {
			return fmt.Errorf("Codex turn/steer: %w", err)
		}
		// Steering binds to the running turn — never a new turn.
		if b.sm != nil && b.sm.turnEnabled() {
			_, _ = b.sm.turns.Addendum(turn.ActorKey{SessionID: sessionID}, "")
		}
		return nil
	}
	config := protocol.SessionConfig{}
	b.sm.mu.RLock()
	if ps := b.sm.sessions[sessionID]; ps != nil {
		config.Cwd = ps.Cwd
		config.Model = ps.Model
		config.Permission = clonePermission(ps.Permission)
	}
	b.sm.mu.RUnlock()
	return b.startTurn(ctx, sessionID, content, config)
}

func (b *CodexAppServerBackend) startTurn(ctx context.Context, threadID, content string, config protocol.SessionConfig) error {
	params := map[string]any{
		"threadId": threadID,
		"input":    []map[string]string{{"type": "text", "text": content}},
	}
	if config.Cwd != "" {
		params["cwd"] = config.Cwd
	}
	if config.Model != "" {
		params["model"] = config.Model
	}
	applyCodexPermissionParams(params, config.Permission)
	var response struct {
		Turn struct {
			ID string `json:"id"`
		} `json:"turn"`
	}
	if err := b.client.Call(ctx, "turn/start", params, &response); err != nil {
		return fmt.Errorf("Codex turn/start: %w", err)
	}
	if response.Turn.ID != "" {
		b.coord.setActiveTurn(threadID, response.Turn.ID)
		b.reserveNativeTurn(threadID, response.Turn.ID)
	}
	return nil
}

// reserveNativeTurn adopts the native turn identity returned by turn/start
// into the registry before any native content notification can arrive. The
// subsequent turn/started notification converges on the same record (single
// derivation, idempotent reconcile).
func (b *CodexAppServerBackend) reserveNativeTurn(threadID, nativeTurnID string) {
	if b.sm == nil || !b.sm.turnEnabled() {
		return
	}
	key := turn.ActorKey{SessionID: threadID}
	logical := logicalCodexTurnID(threadID, nativeTurnID)
	rec, err := b.sm.turns.Start(turn.StartInput{
		Actor:    key,
		Identity: turn.Identity{Agent: adapter.AgentCodex, SourceTurnID: nativeTurnID},
	})
	if err != nil {
		// A registry record from the request phase may already exist (e.g.
		// turn/started arrived first); converge instead of failing.
		if active, ok := b.sm.turns.Active(key); ok && active.TurnID == logical {
			return
		}
		return
	}
	b.sm.emitTurnStatus(rec, protocol.TurnStateRunning, "")
}

// ErrNoActiveCodexTurn is the typed non-retryable outcome for interrupting a
// managed codex session with no active native turn — never a guess about the
// most recent turn (plan stage 3).
var ErrNoActiveCodexTurn = errors.New("no active codex turn to interrupt")

func (b *CodexAppServerBackend) Interrupt(sessionID string) error {
	turnID := b.coord.currentTurn(sessionID)
	if turnID == "" {
		return ErrNoActiveCodexTurn
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := b.client.Call(ctx, "turn/interrupt", map[string]any{"threadId": sessionID, "turnId": turnID}, nil); err != nil {
		return fmt.Errorf("Codex turn/interrupt: %w", err)
	}
	if b.sm != nil && b.sm.turnEnabled() {
		key := turn.ActorKey{SessionID: sessionID}
		if rec, ok := b.sm.turns.Active(key); ok {
			if _, terr := b.sm.turns.RequestInterrupt(key, protocol.TurnReasonUserRequested); terr == nil {
				// The native turn/completed(interrupted) notification drives the
				// terminal state; this event only marks the request.
				b.sm.emitTurnStatus(rec, protocol.TurnStateInterruptRequested, protocol.TurnReasonUserRequested)
			}
		}
	}
	return nil
}

func (b *CodexAppServerBackend) Close(sessionID string) error {
	b.coord.setActiveTurn(sessionID, "")
	return nil
}

func applyCodexPermissionParams(params map[string]any, permission *protocol.PermissionConfig) {
	if permission == nil {
		return
	}
	if permission.DangerousBypass {
		params["approvalPolicy"] = "never"
		params["sandbox"] = "danger-full-access"
		return
	}
	if permission.ApprovalPolicy != "" {
		params["approvalPolicy"] = permission.ApprovalPolicy
	}
	if permission.SandboxMode != "" {
		params["sandbox"] = permission.SandboxMode
	}
}
