package session

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/turn"
	"github.com/pocketctl/pocketctl/internal/zcodeapp"
)

var ErrZcodeSessionBusy = errors.New("zcode session is generating a response")

type zcodeRuntimeClient interface {
	Call(context.Context, string, any, any) error
	Respond(zcodeapp.RequestID, any, *zcodeapp.RPCError) error
	Inbound() <-chan zcodeapp.Inbound
	Done() <-chan struct{}
	Err() error
	Close() error
}

type zcodeCoordinator struct {
	sm *SessionManager

	mu       sync.Mutex
	client   zcodeRuntimeClient
	binary   string
	stopping bool
	start    func(context.Context, string) (zcodeRuntimeClient, error)
}

func newZcodeCoordinator(sm *SessionManager) *zcodeCoordinator {
	return &zcodeCoordinator{sm: sm, start: startZcodeAppServer}
}

func (sm *SessionManager) ensureZcodeManaged() *zcodeCoordinator {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	if sm.zcodeManaged == nil {
		sm.zcodeManaged = newZcodeCoordinator(sm)
	}
	return sm.zcodeManaged
}

func (sm *SessionManager) createZcodeManagedSession(ctx context.Context, config protocol.SessionConfig, binary string) (string, error) {
	resolvedCwd := config.Cwd
	provisionalID := uuid.NewString()
	worktreePath, worktreeBranch := "", ""
	if config.Worktree {
		path, branch, err := createWorktree(resolvedCwd, provisionalID)
		if err != nil {
			return "", fmt.Errorf("工作目录 worktree 创建失败: %w", err)
		}
		worktreePath, worktreeBranch, resolvedCwd = path, branch, path
	} else if config.AutoCreateDir {
		if err := os.MkdirAll(resolvedCwd, 0o755); err != nil {
			return "", fmt.Errorf("工作目录创建失败: %w", err)
		}
	}
	sm.mu.RLock()
	policy := sm.cwdPolicy
	sm.mu.RUnlock()
	if policy == nil {
		return "", ErrCwdNotAuthorized
	}
	if err := policy.Allows(resolvedCwd); err != nil {
		return "", err
	}
	if err := validateCwd(resolvedCwd); err != nil {
		return "", err
	}
	if !config.Force {
		if count := sm.CwdSessionCount(resolvedCwd); count > 0 {
			return "", fmt.Errorf("目录已被占用: %s (当前已有 %d 个活跃会话；如需继续请在客户端勾选\"强制创建\"后重试)", resolvedCwd, count)
		}
	}

	coord := sm.ensureZcodeManaged()
	backend := &zcodeBackend{coord: coord, binary: binary}
	cfg := config
	cfg.Cwd = resolvedCwd
	sessionID, err := backend.Start(ctx, cfg)
	if err != nil {
		return "", fmt.Errorf("create managed ZCode session: %w", err)
	}
	now := time.Now()
	state := &ProcessState{
		SessionID: sessionID, Status: protocol.StatusIdle,
		StartedAt: now, LastActivityAt: now,
		Cwd: resolvedCwd, Agent: adapter.AgentZcodeManaged, Source: "daemon",
		Model: config.Model, Backend: backend, ControlMode: protocol.ControlManaged,
		WorktreePath: worktreePath, WorktreeBranch: worktreeBranch,
	}
	if config.DeferInitialPrompt {
		state.DeferredInitialPrompt = config.Prompt
	}
	sm.mu.Lock()
	sm.sessions[sessionID] = state
	sm.mu.Unlock()
	sm.registerCwd(sessionID, resolvedCwd)
	if config.Prompt != "" && !config.DeferInitialPrompt {
		if err := sm.SendMessageWithInput(ctx, UserMessageInput{SessionID: sessionID, Content: config.Prompt}); err != nil {
			return sessionID, err
		}
	}
	return sessionID, nil
}

func (sm *SessionManager) ShutdownZcodeManaged() error {
	sm.mu.Lock()
	coord := sm.zcodeManaged
	sm.mu.Unlock()
	if coord == nil {
		return nil
	}
	return coord.shutdown()
}

func (c *zcodeCoordinator) ensureStarted(ctx context.Context, binary string) (zcodeRuntimeClient, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.client != nil {
		select {
		case <-c.client.Done():
			c.client = nil
		default:
			return c.client, nil
		}
	}
	client, err := c.start(ctx, binary)
	if err != nil {
		return nil, err
	}
	probeCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	var capabilities map[string]any
	if err := client.Call(probeCtx, "runtime/capabilities", map[string]any{}, &capabilities); err != nil {
		_ = client.Close()
		return nil, fmt.Errorf("probe ZCode app-server: %w", err)
	}
	c.client = client
	c.binary = binary
	c.stopping = false
	go c.inboundLoop(client)
	return client, nil
}

func (c *zcodeCoordinator) inboundLoop(client zcodeRuntimeClient) {
	for inbound := range client.Inbound() {
		if inbound.ID != nil {
			c.handleReverseRequest(client, inbound)
			continue
		}
		if inbound.Method == "session/event" {
			c.handleSessionEvent(inbound.Params)
		}
	}
	<-client.Done()
	c.mu.Lock()
	stopping := c.stopping
	if c.client == client {
		c.client = nil
	}
	c.mu.Unlock()
	if stopping {
		return
	}
	slog.Default().Warn("ZCode managed app-server exited", "error", client.Err())
	c.sm.mu.RLock()
	var sessions []string
	for id, state := range c.sm.sessions {
		if state.Agent == "zcode-managed" && state.ControlMode == protocol.ControlManaged {
			sessions = append(sessions, id)
		}
	}
	c.sm.mu.RUnlock()
	for _, id := range sessions {
		c.sm.outputCh <- protocol.DaemonEvent{Type: "error", SessionID: id, Error: "ZCode managed runtime disconnected"}
		c.sm.SetSessionStatus(id, protocol.StatusDisconnected)
	}
}

func (c *zcodeCoordinator) handleReverseRequest(client zcodeRuntimeClient, inbound zcodeapp.Inbound) {
	if inbound.ID == nil {
		return
	}
	if inbound.Method == "session/requestRuntimePreferences" {
		_ = client.Respond(*inbound.ID, map[string]any{
			"nativeSearchEnhancementsEnabled":      false,
			"memoryEnabled":                        false,
			"askUserQuestionAutoResolutionEnabled": true,
			"modelContextBudgetStrategy":           "preflight-v1",
		}, nil)
		return
	}
	_ = client.Respond(*inbound.ID, nil, &zcodeapp.RPCError{
		Code: -32601, Message: "PocketCtl does not support this ZCode host interaction",
	})
}

type zcodeSessionEvent struct {
	EventID   string          `json:"eventId"`
	SessionID string          `json:"sessionId"`
	TurnID    string          `json:"turnId"`
	Seq       int             `json:"seq"`
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
}

func (c *zcodeCoordinator) handleSessionEvent(raw json.RawMessage) {
	var event zcodeSessionEvent
	if json.Unmarshal(raw, &event) != nil || event.SessionID == "" {
		return
	}
	key := turn.ActorKey{SessionID: event.SessionID}
	if event.Type == "turn.started" && event.TurnID != "" {
		if active, ok := c.sm.turns.Active(key); ok {
			_, _ = c.sm.turns.BindSource(key, active.TurnID, event.TurnID)
		}
	}
	base := protocol.DaemonEvent{SessionID: event.SessionID, EventID: event.EventID, SourceTurnID: event.TurnID}
	if active, ok := c.sm.turns.Active(key); ok && (active.SourceTurnID == "" || active.SourceTurnID == event.TurnID) {
		base.TurnID = active.TurnID
	}
	switch event.Type {
	case "turn.started":
		c.sm.SetSessionStatus(event.SessionID, protocol.StatusRunning)
	case "turn.completed":
		var payload struct {
			ResultType string `json:"resultType"`
			Response   string `json:"response"`
		}
		_ = json.Unmarshal(event.Payload, &payload)
		if payload.ResultType != "" && payload.ResultType != "success" && payload.ResultType != "cancelled" {
			base.Type, base.Code, base.Error = "error", payload.ResultType, payload.Response
			if base.Error == "" {
				base.Error = "ZCode turn ended with " + payload.ResultType
			}
			c.sm.outputCh <- base
		}
		c.finishTurn(event.SessionID, payload.ResultType)
	case "turn.failed":
		var payload struct {
			Error struct {
				Message string `json:"message"`
				Code    string `json:"code"`
			} `json:"error"`
		}
		_ = json.Unmarshal(event.Payload, &payload)
		base.Type, base.Error, base.Code = "error", payload.Error.Message, payload.Error.Code
		c.sm.outputCh <- base
		c.finishTurn(event.SessionID, "failed")
	case "model.streaming":
		var payload struct {
			Kind               string          `json:"kind"`
			Delta              string          `json:"delta"`
			AssistantMessageID string          `json:"assistantMessageId"`
			PartID             string          `json:"partId"`
			ToolCallID         string          `json:"toolCallId"`
			ToolName           string          `json:"toolName"`
			Input              json.RawMessage `json:"input"`
		}
		if json.Unmarshal(event.Payload, &payload) != nil {
			return
		}
		base.StreamID, base.MessageID, base.PartID = payload.AssistantMessageID+":"+payload.PartID, payload.AssistantMessageID, payload.PartID
		switch payload.Kind {
		case "text_delta":
			base.Type, base.Text, base.Streaming = "agent_text", payload.Delta, true
		case "reasoning_delta":
			base.Type, base.Text, base.Streaming = "agent_reasoning", payload.Delta, true
		case "text_end":
			base.Type, base.Streaming, base.Final = "agent_text", true, true
		case "reasoning_end":
			base.Type, base.Streaming, base.Final = "agent_reasoning", true, true
		default:
			return
		}
		c.sm.outputCh <- base
	case "tool.updated":
		var payload struct {
			Kind       string          `json:"kind"`
			ToolCallID string          `json:"toolCallId"`
			ToolName   string          `json:"toolName"`
			Input      json.RawMessage `json:"input"`
			Result     json.RawMessage `json:"result"`
			Error      struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(event.Payload, &payload) != nil {
			return
		}
		base.CallID, base.Tool = payload.ToolCallID, payload.ToolName
		switch payload.Kind {
		case "scheduled", "started":
			base.Type, base.Input = "tool_use", payload.Input
		case "result":
			base.Type, base.Output = "tool_result", zcodeResultText(payload.Result)
		case "error":
			base.Type, base.Error = "tool_result", payload.Error.Message
		default:
			return
		}
		c.sm.outputCh <- base
	case "session.titleUpdated":
		var payload struct {
			Title string `json:"title"`
		}
		if json.Unmarshal(event.Payload, &payload) == nil && payload.Title != "" {
			c.sm.UpdateSessionTitle(event.SessionID, payload.Title)
		}
	case "session.closed":
		c.sm.SetSessionExited(event.SessionID, protocol.ExitReasonNormalExit)
	}
}

func (c *zcodeCoordinator) finishTurn(sessionID, resultType string) {
	state, reason := protocol.TurnStateCompleted, "zcode_turn_completed"
	switch resultType {
	case "cancelled", "canceled":
		state, reason = protocol.TurnStateInterrupted, "zcode_turn_cancelled"
	case "", "success":
	default:
		state, reason = protocol.TurnStateFailed, "zcode_turn_failed:"+resultType
	}
	key := turn.ActorKey{SessionID: sessionID}
	if active, ok := c.sm.turns.Active(key); ok {
		c.sm.terminalizeTurn(key, active, state, reason, protocol.TurnConfidenceNative)
	}
	// A failed or cancelled turn does not terminate the reusable ZCode session.
	// The native runtime remains available for the next prompt.
	c.sm.SetSessionStatus(sessionID, protocol.StatusIdle)
}

func zcodeResultText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var value struct {
		Output string `json:"output"`
		Text   string `json:"text"`
	}
	if json.Unmarshal(raw, &value) == nil {
		if value.Output != "" {
			return value.Output
		}
		if value.Text != "" {
			return value.Text
		}
	}
	return string(raw)
}

func (c *zcodeCoordinator) shutdown() error {
	c.mu.Lock()
	c.stopping = true
	client := c.client
	c.client = nil
	c.mu.Unlock()
	if client == nil {
		return nil
	}
	return client.Close()
}

type zcodeBackend struct {
	coord  *zcodeCoordinator
	binary string
}

type zcodeCreateResult struct {
	Session struct {
		SessionID string `json:"sessionId"`
		Title     string `json:"title"`
		Status    string `json:"status"`
	} `json:"session"`
}

func zcodeWorkspaceKey(path string) string {
	sum := sha256.Sum256([]byte(path))
	return "pocketctl:" + hex.EncodeToString(sum[:12])
}

func (b *zcodeBackend) Start(ctx context.Context, config protocol.SessionConfig) (string, error) {
	client, err := b.coord.ensureStarted(ctx, b.binary)
	if err != nil {
		return "", err
	}
	params := map[string]any{
		"workspace": map[string]any{
			"workspacePath": config.Cwd,
			"workspaceKey":  zcodeWorkspaceKey(config.Cwd),
		},
		"persistence": "immediate",
	}
	if config.Model != "" {
		// ZCode model selections are structured provider/model objects. Milestone
		// one leaves selection to ZCode unless a future typed picker supplies one.
		slog.Default().Debug("ignoring untyped ZCode model selection", "model", config.Model)
	}
	var created zcodeCreateResult
	if err := client.Call(ctx, "session/create", params, &created); err != nil {
		return "", err
	}
	if created.Session.SessionID == "" {
		return "", errors.New("ZCode session/create returned no session id")
	}
	var subscribed struct {
		SessionID string              `json:"sessionId"`
		EventSeq  int                 `json:"eventSeq"`
		Events    []zcodeSessionEvent `json:"events"`
		Snapshot  *zcodeCreateResult  `json:"snapshot,omitempty"`
	}
	if err := client.Call(ctx, "session/subscribe", map[string]any{
		"sessionId":       created.Session.SessionID,
		"deliveryKind":    "web-remote-replayable",
		"includeSnapshot": true,
	}, &subscribed); err != nil {
		closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_ = client.Call(closeCtx, "session/close", map[string]any{"sessionId": created.Session.SessionID}, nil)
		cancel()
		return "", err
	}
	for _, event := range subscribed.Events {
		raw, _ := json.Marshal(event)
		b.coord.handleSessionEvent(raw)
	}
	return created.Session.SessionID, nil
}

func (b *zcodeBackend) Send(ctx context.Context, sessionID, content string) error {
	client, err := b.coord.ensureStarted(ctx, b.binary)
	if err != nil {
		return err
	}
	var result struct {
		Accepted bool `json:"accepted"`
	}
	err = client.Call(ctx, "session/send", map[string]any{
		"sessionId": sessionID,
		"inputId":   uuid.NewString(),
		"content":   content,
	}, &result)
	if err != nil {
		var rpcErr *zcodeapp.RPCError
		if errors.As(err, &rpcErr) && rpcErr.Code == -32010 && strings.Contains(strings.ToLower(rpcErr.Message), "running") {
			err = ErrZcodeSessionBusy
		}
		return err
	}
	if !result.Accepted {
		err = errors.New("ZCode rejected the prompt without a protocol error")
		return err
	}
	return nil
}

func (b *zcodeBackend) Interrupt(sessionID string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client, err := b.coord.ensureStarted(ctx, b.binary)
	if err != nil {
		return err
	}
	return client.Call(ctx, "session/stop", map[string]any{"sessionId": sessionID}, nil)
}

func (b *zcodeBackend) Close(sessionID string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client, err := b.coord.ensureStarted(ctx, b.binary)
	if err != nil {
		return err
	}
	return client.Call(ctx, "session/close", map[string]any{"sessionId": sessionID}, nil)
}

type zcodeProcessClient struct {
	*zcodeapp.Client
	cmd      *exec.Cmd
	stdin    io.WriteCloser
	done     chan error
	close    sync.Once
	closeErr error
}

func startZcodeAppServer(_ context.Context, binary string) (zcodeRuntimeClient, error) {
	cmd := exec.Command(binary, "app-server", "--stdio")
	configureZcodeProcess(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr := &zcodeStderrTail{limit: 64 << 10}
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	p := &zcodeProcessClient{cmd: cmd, stdin: stdin, done: make(chan error, 1)}
	p.Client = zcodeapp.NewClient(stdout, stdin, stdin.Close)
	go func() {
		err := cmd.Wait()
		if err != nil {
			slog.Default().Warn("ZCode app-server process exited", "error", err, "stderr", stderr.String())
		}
		p.done <- err
		close(p.done)
	}()
	return p, nil
}

func (p *zcodeProcessClient) Close() error {
	p.close.Do(func() {
		_ = p.Client.Close()
		timer := time.NewTimer(5 * time.Second)
		defer timer.Stop()
		select {
		case p.closeErr = <-p.done:
		case <-timer.C:
			_ = killZcodeProcess(p.cmd)
			p.closeErr = <-p.done
		}
	})
	return p.closeErr
}

type zcodeStderrTail struct {
	mu    sync.Mutex
	limit int
	data  []byte
}

func (w *zcodeStderrTail) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.data = append(w.data, p...)
	if len(w.data) > w.limit {
		w.data = append([]byte(nil), w.data[len(w.data)-w.limit:]...)
	}
	return len(p), nil
}

func (w *zcodeStderrTail) String() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return string(bytes.TrimSpace(w.data))
}
