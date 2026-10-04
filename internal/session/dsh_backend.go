package session

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/dshapp"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/turn"
)

type dshSummary struct {
	SessionID       string `json:"sessionId"`
	ParentSessionID string `json:"parentSessionId"`
	Origin          string `json:"origin"`
	Cwd             string `json:"cwd"`
	UpdatedAt       int64  `json:"updatedAt"`
	Running         bool   `json:"running"`
	Projections     struct {
		Values struct {
			Title string `json:"title"`
		} `json:"values"`
	} `json:"projections"`
}
type dshPending struct {
	SessionID, Kind, CallID string
	Questions               []protocol.QuestionInfo
}
type dshCoordinator struct {
	sm            *SessionManager
	mu            sync.Mutex
	settingsMu    sync.Mutex
	client        *dshapp.Client
	url, clientID string
	cancel        context.CancelFunc
	started       bool
	ctx           context.Context
	following     map[string]context.CancelFunc
	closed        map[string]bool
	pending       map[string]dshPending
	correlations  map[string]userMessageCorrelation
	approvalCalls map[string]string
	titles        map[string]string
	seenEvents    map[string]int64
	seenChunks    map[string]int
}

func (sm *SessionManager) ensureDSH() *dshCoordinator {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	if sm.dsh == nil {
		ctx, cancel := context.WithCancel(context.Background())
		sm.dsh = &dshCoordinator{
			sm: sm, ctx: ctx, cancel: cancel,
			following: map[string]context.CancelFunc{}, closed: map[string]bool{},
			pending: map[string]dshPending{}, correlations: map[string]userMessageCorrelation{},
			approvalCalls: map[string]string{}, titles: map[string]string{},
			seenEvents: map[string]int64{}, seenChunks: map[string]int{},
		}
	}
	return sm.dsh
}

func (c *dshCoordinator) connect(ctx context.Context) (*dshapp.Client, error) {
	cfg, err := dshapp.LoadConfig()
	if err != nil {
		return nil, fmt.Errorf("DSH is not configured; run pocketctl agent dsh enable --url <native launch URL>")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.client != nil && cfg.URL == c.url {
		return c.client, nil
	}
	client, err := dshapp.Connect(ctx, cfg)
	if err != nil {
		return nil, err
	}
	if c.client != nil {
		c.client.Close()
	}
	c.client, c.url = client, cfg.URL
	return client, nil
}

// Discovery only attaches to the configured Host. Stopping PocketCtl leaves
// that Host and the native client's session running.
func (sm *SessionManager) StartDSHDiscovery() {
	c := sm.ensureDSH()
	c.mu.Lock()
	if c.started {
		c.mu.Unlock()
		return
	}
	c.started = true
	c.mu.Unlock()
	go c.discover()
}

func (sm *SessionManager) ShutdownDSH() {
	sm.mu.RLock()
	c := sm.dsh
	sm.mu.RUnlock()
	if c != nil {
		c.cancel()
	}
}

func (c *dshCoordinator) discover() {
	for c.ctx.Err() == nil {
		client, err := c.connect(c.ctx)
		if err == nil {
			err = c.runHost(client)
		}
		if c.ctx.Err() != nil {
			return
		}
		// An absent configuration is normal; discovery also notices enable later.
		if _, e := dshapp.LoadConfig(); e == nil && err != nil {
			slog.Default().Debug("DSH attach retry", "error", err)
		}
		select {
		case <-c.ctx.Done():
			return
		case <-time.After(3 * time.Second):
		}
	}
}

func (c *dshCoordinator) runHost(client *dshapp.Client) error {
	defer func() {
		c.mu.Lock()
		var disconnected []string
		for id, stop := range c.following {
			disconnected = append(disconnected, id)
			stop()
			delete(c.following, id)
		}
		c.clientID = ""
		c.pending = map[string]dshPending{}
		if c.client == client {
			c.client = nil
			client.Close()
		}
		c.mu.Unlock()
		for _, id := range disconnected {
			c.sm.SetSessionStatus(id, protocol.StatusDisconnected)
		}
	}()
	ctx, cancel := context.WithCancel(c.ctx)
	defer cancel()
	ws, err := client.Mux(ctx)
	if err != nil {
		return err
	}
	defer ws.Close()
	go func() { <-ctx.Done(); ws.Close() }()
	var initial struct {
		Items []dshSummary `json:"items"`
	}
	if err := client.Call(ctx, "session/list", map[string]any{"_request": map[string]any{}}, &initial); err != nil {
		return err
	}
	for _, item := range initial.Items {
		c.attach(item, "terminal")
	}
	if err = dshapp.Open(ws, "events", "$events", map[string]any{}); err != nil {
		return err
	}
	// Polling closes the gap between initial list and event subscription, and
	// picks up native-created sessions without adopting a second runtime.
	done := make(chan struct{})
	go func() {
		defer close(done)
		timer := time.NewTicker(3 * time.Second)
		defer timer.Stop()
		for {
			var list struct {
				Items []dshSummary `json:"items"`
			}
			if err := client.Call(ctx, "session/list", map[string]any{"_request": map[string]any{}}, &list); err != nil {
				ws.Close()
				return
			}
			for _, item := range list.Items {
				c.attach(item, "terminal")
			}
			cfg, err := dshapp.LoadConfig()
			c.mu.Lock()
			same := cfg.URL == c.url
			c.mu.Unlock()
			if err != nil || !same {
				ws.Close()
				return
			}
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
			}
		}
	}()
	defer func() { cancel(); <-done }()
	for {
		var frame struct {
			Type  string          `json:"type"`
			Value json.RawMessage `json:"value"`
		}
		if err := ws.ReadJSON(&frame); err != nil {
			return err
		}
		if frame.Type == "item" {
			c.hostEvent(frame.Value)
		}
	}
}

func (c *dshCoordinator) attach(s dshSummary, source string) {
	if s.SessionID == "" || s.Cwd == "" || s.ParentSessionID != "" || s.Origin == "subagent" {
		return
	}
	c.sm.mu.RLock()
	policy := c.sm.cwdPolicy
	c.sm.mu.RUnlock()
	if policy == nil || policy.Allows(s.Cwd) != nil {
		return
	}
	c.mu.Lock()
	if c.closed[s.SessionID] {
		c.mu.Unlock()
		return
	}
	c.mu.Unlock()
	now := time.Now()
	c.sm.mu.Lock()
	ps, exists := c.sm.sessions[s.SessionID]
	if exists && (ps.Agent != adapter.AgentDSH || ps.Cwd != s.Cwd) {
		c.sm.mu.Unlock()
		return
	}
	if !exists {
		ps = &ProcessState{SessionID: s.SessionID, Agent: adapter.AgentDSH, Cwd: s.Cwd, Source: source, Status: protocol.StatusIdle, ControlMode: protocol.ControlManaged, StartedAt: now, LastActivityAt: now, Backend: &dshBackend{coord: c}}
		if s.Running {
			ps.Status = protocol.StatusRunning
		}
		c.sm.sessions[s.SessionID] = ps
	}
	c.sm.mu.Unlock()
	if !exists {
		c.sm.registerCwd(s.SessionID, s.Cwd)
		c.sm.outputCh <- protocol.DaemonEvent{Type: "session_discovered", SessionID: s.SessionID, Agent: adapter.AgentDSH, Cwd: s.Cwd, Source: source, Status: ps.Status, ControlMode: protocol.ControlManaged, Capabilities: c.sm.SessionCapabilities(s.SessionID), SessionStartedAt: now.UTC().Format(time.RFC3339Nano)}
	}
	if s.Projections.Values.Title != "" {
		c.updateTitle(s.SessionID, s.Projections.Values.Title)
	}
	// Daemon-created sessions apply their initial model/permission settings
	// right after attach; following may start only afterwards so a failing
	// first WebSocket attempt cannot race the creation flow into a
	// disconnected (non-idle) status.
	if source != "daemon" {
		c.startFollowing(s.SessionID)
	}
}

func (c *dshCoordinator) startFollowing(id string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, ok := c.following[id]; !ok {
		ctx, cancel := context.WithCancel(c.ctx)
		c.following[id] = cancel
		go c.follow(ctx, id)
	}
}

type dshBackend struct{ coord *dshCoordinator }

func (sm *SessionManager) createDSHSession(ctx context.Context, cfg protocol.SessionConfig) (string, error) {
	// Worktrees/forks need native workspace identity support; fail explicitly.
	if cfg.Worktree || cfg.ForkFrom != "" {
		return "", fmt.Errorf("DSH worktree/fork creation is not supported")
	}
	if cfg.AutoCreateDir {
		if err := os.MkdirAll(cfg.Cwd, 0755); err != nil {
			return "", err
		}
	}
	sm.mu.RLock()
	policy := sm.cwdPolicy
	sm.mu.RUnlock()
	if policy == nil {
		return "", ErrCwdNotAuthorized
	}
	if err := policy.Allows(cfg.Cwd); err != nil {
		return "", err
	}
	if err := validateCwd(cfg.Cwd); err != nil {
		return "", err
	}
	if !cfg.Force && sm.CwdSessionCount(cfg.Cwd) > 0 {
		return "", fmt.Errorf("目录已被占用: %s", cfg.Cwd)
	}
	sm.StartDSHDiscovery()
	b := &dshBackend{coord: sm.ensureDSH()}
	id, err := b.Start(ctx, cfg)
	if err != nil {
		return "", err
	}
	if cfg.DeferInitialPrompt {
		sm.mu.Lock()
		sm.sessions[id].DeferredInitialPrompt = cfg.Prompt
		sm.mu.Unlock()
	} else if cfg.Prompt != "" {
		err = sm.SendMessageWithInput(ctx, UserMessageInput{SessionID: id, Content: cfg.Prompt})
	}
	return id, err
}

func (b *dshBackend) Start(ctx context.Context, cfg protocol.SessionConfig) (string, error) {
	if cfg.Permission != nil {
		modes, err := b.coord.sm.DSHCreationPermissionModes(ctx)
		if err != nil {
			return "", err
		}
		if indexString(modes, cfg.Permission.Preset) < 0 {
			return "", fmt.Errorf("native permission preset is unavailable or denied by host policy")
		}
	}

	client, err := b.coord.connect(ctx)
	if err != nil {
		return "", err
	}
	var result struct {
		SessionID string `json:"sessionId"`
	}
	if err := client.Call(ctx, "session/create", dshapp.Request(map[string]any{"cwd": cfg.Cwd}), &result); err != nil {
		return "", err
	}
	b.coord.attach(dshSummary{SessionID: result.SessionID, Cwd: cfg.Cwd}, "daemon")
	// Settings must settle before the follow stream can observe the session;
	// defer keeps the ordering on early error returns as well.
	defer b.coord.startFollowing(result.SessionID)
	if cfg.Model != "" {
		if err := b.selectModel(ctx, result.SessionID, cfg.Model, cfg.Effort); err != nil {
			return result.SessionID, err
		}
	}
	if cfg.Permission != nil {
		if err := b.setPermission(ctx, result.SessionID, cfg.Permission); err != nil {
			return result.SessionID, err
		}
	}
	return result.SessionID, nil
}

func (b *dshBackend) Send(ctx context.Context, id, content string) error {
	b.coord.sm.mu.RLock()
	ps := b.coord.sm.sessions[id]
	policy := b.coord.sm.cwdPolicy
	cwd := ""
	if ps != nil {
		cwd = ps.Cwd
	}
	b.coord.sm.mu.RUnlock()
	if policy == nil {
		return ErrCwdNotAuthorized
	}
	if err := policy.Allows(cwd); err != nil {
		return err
	}
	client, err := b.coord.connect(ctx)
	if err != nil {
		return err
	}
	// Adopt through this same Host to activate cold persisted sessions safely.
	if err := client.Call(ctx, "session/create", dshapp.Request(map[string]any{"sessionId": id, "cwd": cwd}), nil); err != nil {
		return err
	}
	corr := userMessageCorrelationFrom(ctx)
	requestID := corr.RequestID
	if requestID == "" {
		requestID = corr.MsgID
	}
	if requestID == "" {
		requestID = uuid.NewString()
	}
	b.coord.mu.Lock()
	b.coord.correlations[requestID] = corr
	b.coord.mu.Unlock()
	mode := "queue"
	if corr.InputMode == protocol.InputModeSteer {
		mode = "steer"
	}
	return client.Call(ctx, "session/prompt", dshapp.Request(map[string]any{"sessionId": id, "requestId": requestID, "mode": mode, "content": []any{map[string]any{"type": "text", "text": content}}}), nil)
}

func (b *dshBackend) Interrupt(id string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	client, err := b.coord.connect(ctx)
	if err != nil {
		return err
	}
	return client.Call(ctx, "session/cancel", dshapp.Request(map[string]any{"sessionId": id}), nil)
}

func (b *dshBackend) Close(id string) error {
	// A remote close cancels current work and detaches; it never destroys the
	// shared Host or deletes native history.
	if err := b.Interrupt(id); err != nil {
		return err
	}
	c := b.coord
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closed[id] = true
	if cancel := c.following[id]; cancel != nil {
		cancel()
		delete(c.following, id)
	}
	return nil
}

func (sm *SessionManager) dshBackendFor(id string) *dshBackend {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	if ps := sm.sessions[id]; ps != nil {
		b, _ := ps.Backend.(*dshBackend)
		return b
	}
	return nil
}

func (b *dshBackend) selectModel(ctx context.Context, id, model string, efforts ...string) error {
	provider, name, ok := strings.Cut(model, "/")
	if !ok || provider == "" || name == "" {
		return fmt.Errorf("DSH model must be provider/model")
	}
	client, err := b.coord.connect(ctx)
	if err != nil {
		return err
	}
	args := map[string]any{"sessionId": id, "provider": provider, "model": name}
	if len(efforts) > 0 && efforts[0] != "" {
		args["reasoningEffort"] = efforts[0]
	}
	var response struct {
		Selected dshModelSelection `json:"selected"`
	}
	if err := client.Call(ctx, "session/selectModel", dshapp.Request(args), &response); err != nil {
		return err
	}
	b.coord.sm.SetSessionModel(id, response.Selected.Provider+"/"+response.Selected.Model)
	b.coord.sm.mu.Lock()
	if ps := b.coord.sm.sessions[id]; ps != nil {
		ps.Effort = response.Selected.ReasoningEffort
	}
	b.coord.sm.mu.Unlock()
	return nil
}

func (c *dshCoordinator) models() []protocol.ModelOption {
	ctx, cancel := context.WithTimeout(c.ctx, 15*time.Second)
	defer cancel()
	client, err := c.connect(ctx)
	if err != nil {
		return nil
	}
	var catalog struct {
		Default dshModelSelection `json:"default"`
		Groups  []struct {
			ID     string `json:"id"`
			Models []struct {
				ID        string `json:"id"`
				Name      string `json:"name"`
				Reasoning struct {
					Efforts []struct {
						ID string `json:"id"`
					} `json:"efforts"`
					Default string `json:"defaultEffort"`
				} `json:"reasoning"`
			} `json:"models"`
		} `json:"groups"`
	}
	if client.Call(ctx, "session/modelCatalog", map[string]any{}, &catalog) != nil {
		return nil
	}
	var models []protocol.ModelOption
	for _, group := range catalog.Groups {
		for _, model := range group.Models {
			option := protocol.ModelOption{Alias: group.ID + "/" + model.ID, Name: model.Name, DefaultReasoningEffort: model.Reasoning.Default, IsDefault: group.ID == catalog.Default.Provider && model.ID == catalog.Default.Model}
			for _, effort := range model.Reasoning.Efforts {
				option.SupportedReasoningEfforts = append(option.SupportedReasoningEfforts, effort.ID)
			}
			models = append(models, option)
		}
	}
	return models
}

type dshEvent struct {
	Type string          `json:"type"`
	Seq  int64           `json:"seq"`
	Data json.RawMessage `json:"data"`
}
type dshRecord struct {
	Type  string   `json:"type"`
	Event dshEvent `json:"event"`
}
type dshChunk struct {
	Type  string `json:"type"`
	Index int    `json:"index"`
	Text  string `json:"text"`
}
type dshCompact struct {
	Type  string   `json:"type"`
	Index int      `json:"index"`
	Texts []string `json:"texts"`
	Args  []string `json:"args"`
	Chunk dshChunk `json:"chunk"`
}
type dshFollow struct {
	AssistantStream struct {
		ActiveAttempt *struct {
			AttemptID string       `json:"attemptId"`
			Turn      int          `json:"turn"`
			Step      int          `json:"step"`
			Stream    []dshCompact `json:"stream"`
		} `json:"activeAttempt"`
	} `json:"assistantStream"`
	Type    string      `json:"type"`
	Cursor  int64       `json:"cursor"`
	Records []dshRecord `json:"records"`
	HasMore bool        `json:"hasMore"`
	Event   dshEvent    `json:"event"`
	Frame   struct {
		Type      string   `json:"type"`
		AttemptID string   `json:"attemptId"`
		Turn      int      `json:"turn"`
		Step      int      `json:"step"`
		Index     int      `json:"index"`
		Chunk     dshChunk `json:"chunk"`
	} `json:"frame"`
}

func (c *dshCoordinator) follow(ctx context.Context, id string) {
	for ctx.Err() == nil {
		err := c.followOnce(ctx, id)
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			c.sm.SetSessionStatus(id, protocol.StatusDisconnected)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(2 * time.Second):
		}
	}
}

func (c *dshCoordinator) followOnce(ctx context.Context, id string) error {
	client, err := c.connect(ctx)
	if err != nil {
		return err
	}
	ws, err := client.Mux(ctx)
	if err != nil {
		return err
	}
	defer ws.Close()
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-ctx.Done():
			ws.Close()
		case <-done:
		}
	}()
	if err := dshapp.Open(ws, id, "session/follow", dshapp.Request(map[string]any{"address": map[string]any{"kind": "session", "sessionId": id}, "assistantStream": true, "maxMessages": 100})); err != nil {
		return err
	}
	currentTurn, step := 0, 0
	for {
		var envelope struct {
			Type  string    `json:"type"`
			Value dshFollow `json:"value"`
		}
		if err := ws.ReadJSON(&envelope); err != nil {
			return err
		}
		if envelope.Type == "error" || envelope.Type == "end" {
			return fmt.Errorf("DSH session follow ended")
		}
		if envelope.Type != "item" {
			continue
		}
		v := envelope.Value
		switch v.Type {
		case "snapshot":
			records := v.Records
			for v.HasMore && len(v.Records) > 0 {
				before := v.Records[0].Event.Seq
				var page struct {
					Records []dshRecord `json:"records"`
					HasMore bool        `json:"hasMore"`
				}
				if err := client.Call(ctx, "session/page", dshapp.Request(map[string]any{"address": map[string]any{"kind": "session", "sessionId": id}, "throughSeq": v.Cursor, "beforeSeq": before, "maxMessages": 100}), &page); err != nil {
					return err
				}
				if len(page.Records) == 0 || page.Records[0].Event.Seq >= before {
					break
				}
				records = append(page.Records, records...)
				v.Records = page.Records
				v.HasMore = page.HasMore
			}
			active := false
			for _, r := range records {
				c.durable(id, r.Event, true, &currentTurn)
				if r.Event.Type == "turn/start" {
					active = true
				}
				if r.Event.Type == "turn/end" {
					active = false
				}
			}
			if active {
				c.startTurn(id, currentTurn)
			} else {
				c.sm.SetSessionStatus(id, protocol.StatusIdle)
			}
			c.publishSettings(id)
			if attempt := v.AssistantStream.ActiveAttempt; attempt != nil {
				currentTurn, step = attempt.Turn, attempt.Step
				index := 0
				for _, record := range attempt.Stream {
					if record.Type == "chunk" {
						c.streamChunk(id, attempt.AttemptID, currentTurn, step, index, record.Chunk)
						index++
						continue
					}
					if record.Type == "tool-call-chunks" {
						index += len(record.Args)
						continue
					}
					kind := "text-delta"
					if record.Type == "reasoning-chunks" {
						kind = "reasoning-delta"
					}
					for _, text := range record.Texts {
						c.streamChunk(id, attempt.AttemptID, currentTurn, step, index, dshChunk{Type: kind, Index: record.Index, Text: text})
						index++
					}
				}
			}
		case "event":
			c.durable(id, v.Event, false, &currentTurn)
		case "assistant-stream":
			f := v.Frame
			if f.Type == "start" {
				currentTurn, step = f.Turn, f.Step
			}
			if f.Type == "chunk" && step > 0 {
				c.streamChunk(id, f.AttemptID, currentTurn, step, f.Index, f.Chunk)
			}
		}
	}
}

func dshStreamID(id string, t, s, index int) string {
	return fmt.Sprintf("dsh:%s:%d:%d:%d", id, t, s, index)
}
func dshTurnID(id string, t int) string {
	if t == 0 {
		return ""
	}
	return turn.LogicalTurnID(adapter.AgentDSH, id, "", "native", strconv.Itoa(t))
}

func (c *dshCoordinator) startTurn(id string, t int) {
	if c.sm.turnEnabled() {
		if rec, err := c.sm.turns.Start(turn.StartInput{Actor: turn.ActorKey{SessionID: id}, Identity: turn.Identity{Agent: adapter.AgentDSH, SourceTurnID: strconv.Itoa(t)}}); err == nil {
			c.sm.emitTurnStatus(rec, protocol.TurnStateRunning, "")
		}
	}
	c.setStatusFromPending(id, protocol.StatusRunning)
}

// Global interactions and per-session snapshots arrive on separate streams.
// Restoring an active turn must not overwrite an already restored waiting card.
func (c *dshCoordinator) setStatusFromPending(id, fallback string) {
	c.mu.Lock()
	status := fallback
	for _, pending := range c.pending {
		if pending.SessionID == id {
			status = protocol.StatusWaitingApproval
			if pending.Kind == "user-questions/request" {
				status = protocol.StatusWaitingQuestion
			}
			break
		}
	}
	c.mu.Unlock()
	c.sm.SetSessionStatus(id, status)
}

type dshMessage struct {
	ID         string `json:"id"`
	ToolCallID string `json:"toolCallId"`
	IsError    bool   `json:"isError"`
	Source     struct {
		Kind  string `json:"kind"`
		RPCID string `json:"rpcId"`
	} `json:"source"`
	Content []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
}

func (c *dshCoordinator) durable(id string, e dshEvent, history bool, currentTurn *int) {
	var data struct {
		Turn  int `json:"turn"`
		Step  int `json:"step"`
		Usage *struct {
			Input      int `json:"inputTokens"`
			Output     int `json:"outputTokens"`
			Total      int `json:"totalTokens"`
			CacheRead  int `json:"cacheReadTokens"`
			CacheWrite int `json:"cacheWriteTokens"`
		} `json:"usage"`
		Stream    []dshCompact    `json:"stream"`
		Message   dshMessage      `json:"message"`
		Title     string          `json:"title"`
		ID        string          `json:"id"`
		Outcome   string          `json:"outcome"`
		CallID    string          `json:"callId"`
		Name      string          `json:"name"`
		Arguments string          `json:"arguments"`
		Reason    json.RawMessage `json:"reason"`
		Header    struct {
			Config struct {
				Provider string `json:"provider"`
				Model    string `json:"model"`
			} `json:"config"`
		} `json:"header"`
	}
	if json.Unmarshal(e.Data, &data) != nil {
		return
	}
	if data.Turn > 0 {
		*currentTurn = data.Turn
	}
	c.mu.Lock()
	previous, seen := c.seenEvents[id]
	if !seen || e.Seq > previous {
		c.seenEvents[id] = e.Seq
	}
	c.mu.Unlock()
	if seen && e.Seq <= previous {
		return
	}
	if !history && (e.Type == "model/selection" || e.Type == "permission/preset" || e.Type == "sandbox/mode" || e.Type == "approval/policy") {
		c.publishSettings(id)
	}
	base := protocol.DaemonEvent{SessionID: id, EventID: fmt.Sprintf("dsh:%s:%d", id, e.Seq), TurnID: dshTurnID(id, *currentTurn)}
	if *currentTurn > 0 {
		base.SourceTurnID = strconv.Itoa(*currentTurn)
		base.TurnOrigin = protocol.TurnOriginNative
		base.TurnConfidence = protocol.TurnConfidenceNative
	}
	switch e.Type {
	case "turn/start":
		if !history {
			c.startTurn(id, data.Turn)
		}
	case "turn/end":
		if !history {
			defer c.publishSettings(id)
		}
		var reason struct {
			Kind string `json:"kind"`
		}
		_ = json.Unmarshal(data.Reason, &reason)
		if !history {
			state := protocol.TurnStateCompleted
			if reason.Kind == "aborted" {
				state = protocol.TurnStateInterrupted
			} else if reason.Kind != "completed" {
				state = protocol.TurnStateFailed
			}
			key := turn.ActorKey{SessionID: id}
			if rec, ok := c.sm.turns.Active(key); ok {
				c.sm.terminalizeTurn(key, rec, state, "dsh_"+reason.Kind, protocol.TurnConfidenceNative)
			}
			c.sm.SetSessionStatus(id, protocol.StatusIdle)
		}
	case "user/message":
		var msg dshMessage
		if json.Unmarshal(e.Data, &msg) != nil || msg.Source.Kind != "user" {
			return
		}
		base.Type = "user_text"
		base.MessageID = msg.ID
		for _, block := range msg.Content {
			if block.Type == "text" {
				base.Text += block.Text
			}
		}
		c.mu.Lock()
		corr := c.correlations[msg.Source.RPCID]
		delete(c.correlations, msg.Source.RPCID)
		c.mu.Unlock()
		base.RequestID, base.MsgID = corr.RequestID, corr.MsgID
		c.sm.outputCh <- base
	case "assistant/message":
		if data.Usage != nil {
			usage := base
			usage.Type = "agent_text"
			usage.EventID += ":usage"
			usage.Usage = &protocol.ContextUsage{InputTokens: data.Usage.Input, OutputTokens: data.Usage.Output, TotalTokens: data.Usage.Total, CacheRead: data.Usage.CacheRead, CacheCreate: data.Usage.CacheWrite}
			c.sm.outputCh <- usage
		}
		for i, block := range data.Message.Content {
			if block.Type != "text" && block.Type != "reasoning" {
				continue
			}
			ev := base
			ev.Type = "agent_text"
			if block.Type == "reasoning" {
				ev.Type = "agent_reasoning"
			}
			ev.EventID += ":" + strconv.Itoa(i)
			ev.MessageID = data.Message.ID
			ev.StreamID = dshStreamID(id, data.Turn, data.Step, i)
			ev.Text = block.Text
			ev.Final = true
			ev.Streaming = true
			ev.TotalBytes = len([]byte(block.Text))
			ev.ContentHash = digest([]byte(block.Text))
			c.sm.outputCh <- ev
		}
	case "assistant/attempt":
		// Cancellation/failure may settle only a partial compact stream.
		partial := map[int]dshChunk{}
		for _, record := range data.Stream {
			if record.Type != "text-chunks" && record.Type != "reasoning-chunks" {
				continue
			}
			block := partial[record.Index]
			block.Type = record.Type
			block.Text += strings.Join(record.Texts, "")
			partial[record.Index] = block
		}
		indices := make([]int, 0, len(partial))
		for index := range partial {
			indices = append(indices, index)
		}
		sort.Ints(indices)
		for _, index := range indices {
			block := partial[index]
			ev := base
			ev.Type = "agent_text"
			if block.Type == "reasoning-chunks" {
				ev.Type = "agent_reasoning"
			}
			ev.EventID += ":" + strconv.Itoa(index)
			ev.StreamID = dshStreamID(id, data.Turn, data.Step, index)
			ev.Text = block.Text
			ev.Streaming = true
			ev.Final = true
			ev.TotalBytes = len([]byte(block.Text))
			ev.ContentHash = digest([]byte(block.Text))
			c.sm.outputCh <- ev
		}
	case "tool/call":
		base.Type = "tool_call"
		base.CallID = data.CallID
		base.Tool = data.Name
		if json.Valid([]byte(data.Arguments)) {
			base.Input = json.RawMessage(data.Arguments)
		}
		c.sm.outputCh <- base
	case "approval/asked":
		c.mu.Lock()
		c.approvalCalls[id+":"+data.ID] = data.CallID
		c.mu.Unlock()
	case "approval/decided":
		c.mu.Lock()
		callID := c.approvalCalls[id+":"+data.ID]
		delete(c.approvalCalls, id+":"+data.ID)
		c.mu.Unlock()
		c.settleInteraction(id, "approval/request", callID, data.Outcome)
	case "tool/result":
		questionOutcome := "answered"
		if data.Message.IsError {
			questionOutcome = "rejected"
		}
		c.settleInteraction(id, "user-questions/request", data.Message.ToolCallID, questionOutcome)
		base.Type = "tool_result"
		base.CallID = data.Message.ToolCallID
		for _, block := range data.Message.Content {
			base.Output += block.Text
		}
		if data.Message.IsError {
			base.Error = base.Output
		}
		c.sm.outputCh <- base
	case "session/title":
		c.updateTitle(id, data.Title)
	case "request/header":
		if !history {
			c.publishSettings(id)
			return
		}
		if data.Header.Config.Model != "" {
			model := data.Header.Config.Provider + "/" + data.Header.Config.Model
			previous, _ := c.sm.GetSessionModel(id)
			c.sm.SetSessionModel(id, model)
			if previous != model {
				base.Type, base.Model = "session_model_changed", model
				c.sm.outputCh <- base
			}
		}
	}
}

func (c *dshCoordinator) updateTitle(id, title string) {
	c.mu.Lock()
	same := c.titles[id] == title
	c.titles[id] = title
	c.mu.Unlock()
	if !same {
		c.sm.UpdateSessionTitle(id, title)
	}
}

func (c *dshCoordinator) streamChunk(id, attempt string, t, step, index int, chunk dshChunk) {
	c.mu.Lock()
	prev, seen := c.seenChunks[attempt]
	if !seen || index > prev {
		c.seenChunks[attempt] = index
	}
	c.mu.Unlock()
	if seen && index <= prev {
		return
	}
	if chunk.Text == "" || (chunk.Type != "text-delta" && chunk.Type != "reasoning-delta") {
		return
	}
	kind := "agent_text"
	if chunk.Type == "reasoning-delta" {
		kind = "agent_reasoning"
	}
	c.sm.outputCh <- protocol.DaemonEvent{Type: kind, SessionID: id, Text: chunk.Text, Streaming: true, StreamID: dshStreamID(id, t, step, chunk.Index), EventID: fmt.Sprintf("dsh:%s:chunk:%s:%d", id, attempt, index), TurnID: dshTurnID(id, t), SourceTurnID: strconv.Itoa(t), TurnOrigin: protocol.TurnOriginNative, TurnConfidence: protocol.TurnConfidenceNative}
}
