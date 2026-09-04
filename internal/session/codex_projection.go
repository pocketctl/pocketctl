package session

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"sync"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/codexapp"
	"github.com/pocketctl/pocketctl/internal/memorycontext"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/turn"
)

// logicalCodexTurnID derives the PocketCtl logical id from the native turn id.
// Both the managed app-server projection and the registry use this single
// derivation so the two can never disagree (plan stage 3).
func logicalCodexTurnID(threadID, nativeTurnID string) string {
	return turn.LogicalTurnID(adapter.AgentCodex, threadID, "", "native", nativeTurnID)
}

// stampTurnIdentity binds native turn identity onto an event. status is only
// set for turn_status lifecycle events; content events carry identity only.
func stampTurnIdentity(ev *protocol.DaemonEvent, threadID, nativeTurnID, status string) {
	if ev == nil || nativeTurnID == "" {
		return
	}
	ev.TurnID = logicalCodexTurnID(threadID, nativeTurnID)
	ev.SourceTurnID = nativeTurnID
	ev.TurnOrigin = protocol.TurnOriginNative
	ev.TurnConfidence = protocol.TurnConfidenceNative
	if status != "" {
		ev.TurnStatus = status
	}
}

// codexProjection converts one app-server generation's native notifications
// into Pocketctl's stable event contract. It deliberately owns mutable item
// state: app-server deltas are append-only, while item/completed is the
// authoritative full snapshot used to converge clients after missed deltas.
type codexProjection struct {
	mu             sync.Mutex
	generation     uint64
	seen           map[string]struct{}
	activeTurn     map[string]string
	completedTurn  map[string]struct{}
	threadStatus   map[string]string
	threadRevision map[string]uint64
	parts          map[string]codexProjectedPart
}

type codexProjectedPart struct {
	text      string
	revision  int
	eventID   string
	streamID  string
	finalized bool
}

type codexThreadStatus struct {
	Type string `json:"type"`
}

type codexThreadItem struct {
	ID               string          `json:"id"`
	Type             string          `json:"type"`
	Text             string          `json:"text,omitempty"`
	Phase            string          `json:"phase,omitempty"`
	Content          json.RawMessage `json:"content,omitempty"`
	Command          string          `json:"command,omitempty"`
	Cwd              string          `json:"cwd,omitempty"`
	Status           string          `json:"status,omitempty"`
	AggregatedOutput *string         `json:"aggregatedOutput,omitempty"`
	ExitCode         *int            `json:"exitCode,omitempty"`
	Changes          []codexFileEdit `json:"changes,omitempty"`
	Server           string          `json:"server,omitempty"`
	Tool             string          `json:"tool,omitempty"`
	Arguments        json.RawMessage `json:"arguments,omitempty"`
	Result           json.RawMessage `json:"result,omitempty"`
	Error            json.RawMessage `json:"error,omitempty"`
	Summary          []string        `json:"summary,omitempty"`
}

type codexUserInput struct {
	Type string `json:"type"`
	Text string `json:"text,omitempty"`
	Role string `json:"role,omitempty"`
	Tag  string `json:"tag,omitempty"`
}

type codexFileEdit struct {
	Path     string              `json:"path"`
	Kind     codexFileChangeKind `json:"kind"`
	Diff     string              `json:"diff"`
	MovePath string              `json:"movePath,omitempty"`
}

func newCodexProjection(generation uint64) *codexProjection {
	return &codexProjection{
		generation:     generation,
		seen:           make(map[string]struct{}),
		activeTurn:     make(map[string]string),
		completedTurn:  make(map[string]struct{}),
		threadStatus:   make(map[string]string),
		threadRevision: make(map[string]uint64),
		parts:          make(map[string]codexProjectedPart),
	}
}

func (p *codexProjection) Project(in codexapp.Inbound) []protocol.DaemonEvent {
	return p.project(in, false)
}

// ProjectHistorical hydrates persisted turn content into a fresh projector
// without presenting historical lifecycle transitions as live events.
func (p *codexProjection) ProjectHistorical(in codexapp.Inbound) []protocol.DaemonEvent {
	events := p.project(in, true)
	for i := range events {
		events[i].Resync = true
	}
	return events
}

func (p *codexProjection) project(in codexapp.Inbound, historical bool) []protocol.DaemonEvent {
	p.mu.Lock()
	defer p.mu.Unlock()
	if in.ID != nil { // server requests are handled by the interaction broker.
		return nil
	}
	switch in.Method {
	case "thread/started":
		return p.projectThreadStarted(in.Params)
	case "thread/status/changed":
		return p.projectThreadStatus(in.Params)
	case "turn/started", "turn/completed":
		return p.projectTurn(in.Method, in.Params, historical)
	case "item/started", "item/completed":
		return p.projectItem(in.Method, in.Params, historical)
	case "item/agentMessage/delta":
		return p.projectTextDelta(in.Method, "agent_text", in.Params)
	case "item/reasoning/summaryTextDelta", "item/reasoning/textDelta", "item/plan/delta":
		return p.projectTextDelta(in.Method, "agent_reasoning", in.Params)
	case "item/commandExecution/outputDelta":
		return p.projectOutputDelta(in.Params)
	case "thread/tokenUsage/updated":
		return p.projectUsage(in.Params)
	default:
		return nil
	}
}

func (p *codexProjection) projectThreadStarted(raw json.RawMessage) []protocol.DaemonEvent {
	var params struct {
		Thread struct {
			ID     string            `json:"id"`
			Cwd    string            `json:"cwd"`
			Name   *string           `json:"name"`
			Status codexThreadStatus `json:"status"`
		} `json:"thread"`
	}
	if json.Unmarshal(raw, &params) != nil || params.Thread.ID == "" {
		return nil
	}
	key := p.key("thread/started", params.Thread.ID, digest(raw))
	if !p.mark(key) {
		return nil
	}
	title := ""
	if params.Thread.Name != nil {
		title = *params.Thread.Name
	}
	if params.Thread.Status.Type != "" {
		p.threadStatus[params.Thread.ID] = params.Thread.Status.Type
	}
	return []protocol.DaemonEvent{{
		Type: "session_discovered", SessionID: params.Thread.ID, Cwd: params.Thread.Cwd,
		Title: title, Status: mapCodexThreadStatus(params.Thread.Status.Type),
		Source: "terminal", Agent: adapter.AgentCodex, ControlMode: protocol.ControlManaged,
		Capabilities: []string{CodexCapabilityMessageAcceptance},
	}}
}

func (p *codexProjection) projectThreadStatus(raw json.RawMessage) []protocol.DaemonEvent {
	var params struct {
		ThreadID string            `json:"threadId"`
		Status   codexThreadStatus `json:"status"`
	}
	if json.Unmarshal(raw, &params) != nil || params.ThreadID == "" || params.Status.Type == "" {
		return nil
	}
	p.threadRevision[params.ThreadID]++
	if p.threadStatus[params.ThreadID] == params.Status.Type {
		return nil
	}
	p.threadStatus[params.ThreadID] = params.Status.Type
	return []protocol.DaemonEvent{{Type: "session_status", SessionID: params.ThreadID, Status: mapCodexThreadStatus(params.Status.Type)}}
}

func (p *codexProjection) projectTurn(method string, raw json.RawMessage, historical bool) []protocol.DaemonEvent {
	var params struct {
		ThreadID string `json:"threadId"`
		Turn     struct {
			ID     string `json:"id"`
			Status string `json:"status"`
		} `json:"turn"`
	}
	if json.Unmarshal(raw, &params) != nil || params.ThreadID == "" || params.Turn.ID == "" {
		return nil
	}
	provenance := "live"
	if historical {
		provenance = "historical"
	}
	key := p.key(method, provenance, params.ThreadID, params.Turn.ID, params.Turn.Status)
	if !p.mark(key) {
		return nil
	}
	if method == "turn/started" {
		p.activeTurn[params.ThreadID] = params.Turn.ID
		delete(p.completedTurn, params.ThreadID+"\x00"+params.Turn.ID)
		if historical {
			return nil
		}
		// The turn_status lifecycle event precedes the session status on the
		// wire (plan §3.3) and carries the full native identity.
		statusEvent := p.turnStatusEvent(params.ThreadID, params.Turn.ID, protocol.TurnStateRunning, "")
		return []protocol.DaemonEvent{
			statusEvent,
			{Type: "session_status", SessionID: params.ThreadID, Status: protocol.StatusRunning},
		}
	}
	delete(p.activeTurn, params.ThreadID)
	p.completedTurn[params.ThreadID+"\x00"+params.Turn.ID] = struct{}{}
	if historical {
		return nil
	}
	turnState, turnReason := mapNativeTurnCompletion(params.Turn.Status)
	terminal := p.turnStatusEvent(params.ThreadID, params.Turn.ID, turnState, turnReason)
	switch params.Turn.Status {
	case "inProgress":
		return []protocol.DaemonEvent{terminal, {Type: "session_status", SessionID: params.ThreadID, Status: protocol.StatusRunning}}
	case "failed":
		return []protocol.DaemonEvent{
			terminal,
			{Type: "error", SessionID: params.ThreadID, Error: "Codex turn failed"},
			{Type: "session_status", SessionID: params.ThreadID, Status: protocol.StatusIdle},
		}
	default:
		return []protocol.DaemonEvent{terminal, {Type: "session_status", SessionID: params.ThreadID, Status: protocol.StatusIdle}}
	}
}

// mapNativeTurnCompletion maps the native turn/completed status onto the
// frozen PocketCtl turn vocabulary. The completion notification itself is the
// authoritative terminal evidence; unknown native values record their raw form
// as the reason instead of being guessed into a different state.
func mapNativeTurnCompletion(native string) (state, reason string) {
	switch native {
	case "failed":
		return protocol.TurnStateFailed, "native_turn_failed"
	case "interrupted", "cancelled", "canceled":
		return protocol.TurnStateInterrupted, "native_turn_interrupted"
	case "":
		return protocol.TurnStateCompleted, "native_turn_completed"
	default:
		return protocol.TurnStateCompleted, "native:" + native
	}
}

func (p *codexProjection) turnStatusEvent(threadID, nativeTurnID, state, reason string) protocol.DaemonEvent {
	ev := protocol.DaemonEvent{
		Type:              protocol.EventTypeTurnStatus,
		SessionID:         threadID,
		EventID:           turn.StatusEventID(logicalCodexTurnID(threadID, nativeTurnID), state),
		ActorScope:        protocol.ActorScopeRoot,
		FlowScope:         protocol.FlowScopeAuxiliary,
		ContentClass:      protocol.ContentClassLifecycle,
		ClassifierVersion: protocol.ClassifierVersionV1,
	}
	stampTurnIdentity(&ev, threadID, nativeTurnID, state)
	if reason != "" {
		ev.TurnReason = reason
	}
	return ev
}

func (p *codexProjection) projectTextDelta(method, eventType string, raw json.RawMessage) []protocol.DaemonEvent {
	var params struct {
		ThreadID string `json:"threadId"`
		TurnID   string `json:"turnId"`
		ItemID   string `json:"itemId"`
		Delta    string `json:"delta"`
	}
	if json.Unmarshal(raw, &params) != nil || params.ThreadID == "" || params.TurnID == "" || params.ItemID == "" || params.Delta == "" {
		return nil
	}
	events := p.synthesizeActiveTurn(params.ThreadID, params.TurnID, false)
	partKey := p.partKey(params.ThreadID, params.TurnID, params.ItemID, eventType)
	state := p.parts[partKey]
	state.revision++
	state.text += params.Delta
	if state.streamID == "" {
		state.streamID = p.contentStreamID(eventType, params.ThreadID, params.TurnID, params.ItemID)
	}
	eventID := p.key("part", digest([]byte(partKey)), fmt.Sprint(state.revision), digest([]byte(state.text)))
	deltaEvent := protocol.DaemonEvent{
		Type: eventType, SessionID: params.ThreadID, PartID: params.ItemID,
		Text: params.Delta, Snapshot: state.text,
		StreamID: state.streamID, Streaming: true, Revision: state.revision,
		EventID: eventID, PreviousEventID: state.eventID,
	}
	stampTurnIdentity(&deltaEvent, params.ThreadID, params.TurnID, "")
	events = append(events, deltaEvent)
	state.eventID = eventID
	p.parts[partKey] = state
	return events
}

func (p *codexProjection) projectOutputDelta(raw json.RawMessage) []protocol.DaemonEvent {
	var params struct {
		ThreadID string `json:"threadId"`
		TurnID   string `json:"turnId"`
		ItemID   string `json:"itemId"`
		Delta    string `json:"delta"`
	}
	if json.Unmarshal(raw, &params) != nil || params.ThreadID == "" || params.TurnID == "" || params.ItemID == "" || params.Delta == "" {
		return nil
	}
	events := p.synthesizeActiveTurn(params.ThreadID, params.TurnID, false)
	partKey := p.partKey(params.ThreadID, params.TurnID, params.ItemID, "tool_result")
	state := p.parts[partKey]
	state.text += params.Delta
	if state.streamID == "" {
		state.streamID = p.contentStreamID("tool_result", params.ThreadID, params.TurnID, params.ItemID)
	}
	eventID := p.key("command-output", params.ThreadID, params.TurnID, params.ItemID, digest(raw))
	outputEvent := protocol.DaemonEvent{
		Type: "tool_result", SessionID: params.ThreadID, CallID: params.ItemID,
		Tool: "commandExecution", Output: params.Delta, StreamID: state.streamID, Streaming: true,
		EventID: eventID, PreviousEventID: state.eventID,
	}
	stampTurnIdentity(&outputEvent, params.ThreadID, params.TurnID, "")
	events = append(events, outputEvent)
	state.eventID = eventID
	p.parts[partKey] = state
	return events
}

func (p *codexProjection) projectItem(method string, raw json.RawMessage, historical bool) []protocol.DaemonEvent {
	var params struct {
		ThreadID string          `json:"threadId"`
		TurnID   string          `json:"turnId"`
		Item     codexThreadItem `json:"item"`
	}
	if json.Unmarshal(raw, &params) != nil || params.ThreadID == "" || params.TurnID == "" || params.Item.ID == "" || params.Item.Type == "" {
		return nil
	}
	key := p.key(method, params.ThreadID, params.TurnID, params.Item.ID, digest(raw))
	if !p.mark(key) {
		return nil
	}
	events := p.synthesizeActiveTurn(params.ThreadID, params.TurnID, historical)
	event, ok := p.convertItem(method, params.ThreadID, params.TurnID, params.Item)
	if ok {
		stampTurnIdentity(&event, params.ThreadID, params.TurnID, "")
		events = append(events, event)
		if method == "item/completed" && params.Item.Type == "fileChange" {
			events = append(events, p.projectManagedFileChanges(
				params.ThreadID, params.TurnID, params.Item,
			)...)
		}
	}
	return events
}

func (p *codexProjection) convertItem(method, threadID, turnID string, item codexThreadItem) (protocol.DaemonEvent, bool) {
	switch item.Type {
	case "userMessage":
		if method != "item/completed" {
			return protocol.DaemonEvent{}, false
		}
		var contentItems []codexUserInput
		_ = json.Unmarshal(item.Content, &contentItems)
		var texts []string
		for _, content := range contentItems {
			if content.Type == "text" && content.Text != "" {
				// Phase 2 no-recursive-capture: the synthetic developer
				// context item is dropped by explicit tag, never by matching
				// user text (plan 11.4).
				if content.Role == "developer" && content.Tag == memorycontext.CodexDeveloperItemTag {
					continue
				}
				texts = append(texts, content.Text)
			}
		}
		if len(texts) == 0 {
			return protocol.DaemonEvent{}, false
		}
		text := strings.Join(texts, "\n")
		return protocol.DaemonEvent{
			Type: "user_text", SessionID: threadID, PartID: item.ID, Text: text, Snapshot: text,
			Revision: 1, EventID: p.key("user", threadID, turnID, item.ID, digest([]byte(text))),
		}, true

	case "agentMessage":
		if method != "item/completed" || item.Text == "" {
			return protocol.DaemonEvent{}, false
		}
		return p.finalText(threadID, turnID, item.ID, "agent_text", item.Text), true

	case "reasoning", "plan":
		if method != "item/completed" {
			return protocol.DaemonEvent{}, false
		}
		text := item.Text
		if text == "" {
			var reasoningContent []string
			_ = json.Unmarshal(item.Content, &reasoningContent)
			text = strings.Join(append(append([]string(nil), item.Summary...), reasoningContent...), "\n")
		}
		if text == "" {
			return protocol.DaemonEvent{}, false
		}
		return p.finalText(threadID, turnID, item.ID, "agent_reasoning", text), true

	case "commandExecution":
		if method == "item/started" {
			input, _ := json.Marshal(map[string]string{"command": item.Command, "cwd": item.Cwd})
			return protocol.DaemonEvent{
				Type: "tool_call", SessionID: threadID, CallID: item.ID, PartID: item.ID,
				Tool: "commandExecution", Input: input, Status: item.Status,
				EventID: p.key("command", threadID, turnID, item.ID, item.Status),
			}, true
		}
		output := ""
		if item.AggregatedOutput != nil {
			output = *item.AggregatedOutput
		}
		event := p.finalToolResult(
			threadID, turnID, item.ID, "commandExecution", output, item.Status,
			p.key("command", threadID, turnID, item.ID, item.Status, digest([]byte(output))),
		)
		event.PartID = item.ID
		return event, true

	case "fileChange":
		if method != "item/completed" {
			return protocol.DaemonEvent{}, false
		}
		files := make([]string, 0, len(item.Changes))
		var output strings.Builder
		for _, change := range item.Changes {
			files = append(files, change.Path)
			if change.Diff != "" {
				if output.Len() > 0 {
					output.WriteByte('\n')
				}
				output.WriteString(change.Diff)
			}
		}
		event := p.finalToolResult(
			threadID, turnID, item.ID, "fileChange", output.String(), item.Status,
			p.key("file", threadID, turnID, item.ID, item.Status, digest([]byte(output.String()))),
		)
		event.PartID = item.ID
		event.Files = files
		return event, true

	case "mcpToolCall", "dynamicToolCall":
		tool := item.Tool
		if item.Server != "" {
			tool = item.Server + "/" + tool
		}
		if method == "item/started" {
			return protocol.DaemonEvent{
				Type: "tool_call", SessionID: threadID, CallID: item.ID, PartID: item.ID,
				Tool: tool, Input: item.Arguments, Status: item.Status,
				EventID: p.key("tool", threadID, turnID, item.ID, item.Status),
			}, true
		}
		output := strings.TrimSpace(string(item.Result))
		if len(item.Error) > 0 && string(item.Error) != "null" {
			output = strings.TrimSpace(string(item.Error))
		}
		event := p.finalToolResult(
			threadID, turnID, item.ID, tool, output, item.Status,
			p.key("tool", threadID, turnID, item.ID, item.Status, digest([]byte(output))),
		)
		event.PartID = item.ID
		return event, true
	}
	return protocol.DaemonEvent{}, false
}

func (p *codexProjection) finalText(threadID, turnID, itemID, eventType, text string) protocol.DaemonEvent {
	partKey := p.partKey(threadID, turnID, itemID, eventType)
	state := p.parts[partKey]
	state.revision++
	if state.streamID == "" {
		state.streamID = p.contentStreamID(eventType, threadID, turnID, itemID)
	}
	if !strings.HasPrefix(text, state.text) && state.text != "" {
		state.streamID = p.contentStreamID(eventType+"-correction", threadID, turnID, itemID, digest([]byte(text)))
	}
	eventID := p.key("part", digest([]byte(partKey)), "final", digest([]byte(text)))
	event := protocol.DaemonEvent{
		Type: eventType, SessionID: threadID, PartID: itemID, Text: text, Snapshot: text,
		StreamID: state.streamID, Streaming: true, Final: true,
		TotalBytes: len([]byte(text)), ContentHash: digest([]byte(text)),
		Revision: state.revision, Replace: state.revision > 1,
		EventID: eventID, PreviousEventID: state.eventID,
	}
	state.text, state.eventID, state.finalized = text, eventID, true
	p.parts[partKey] = state
	return event
}

func (p *codexProjection) finalToolResult(
	threadID, turnID, itemID, tool, output, status, eventID string,
) protocol.DaemonEvent {
	partKey := p.partKey(threadID, turnID, itemID, "tool_result")
	state := p.parts[partKey]
	if state.streamID == "" {
		state.streamID = p.contentStreamID("tool_result", threadID, turnID, itemID)
	}
	if !strings.HasPrefix(output, state.text) && state.text != "" {
		state.streamID = p.contentStreamID(
			"tool_result-correction", threadID, turnID, itemID, digest([]byte(output)),
		)
	}
	previousEventID := state.eventID
	state.text, state.eventID, state.finalized = output, eventID, true
	p.parts[partKey] = state
	return protocol.DaemonEvent{
		Type: "tool_result", SessionID: threadID, CallID: itemID,
		Tool: tool, Output: output, Status: status,
		StreamID: state.streamID, Streaming: true, Final: true,
		TotalBytes: len([]byte(output)), ContentHash: digest([]byte(output)),
		EventID: eventID, PreviousEventID: previousEventID,
	}
}

func (p *codexProjection) projectUsage(raw json.RawMessage) []protocol.DaemonEvent {
	var params struct {
		ThreadID   string `json:"threadId"`
		TurnID     string `json:"turnId"`
		TokenUsage struct {
			Last struct {
				InputTokens           int `json:"inputTokens"`
				CachedInputTokens     int `json:"cachedInputTokens"`
				OutputTokens          int `json:"outputTokens"`
				ReasoningOutputTokens int `json:"reasoningOutputTokens"`
				TotalTokens           int `json:"totalTokens"`
			} `json:"last"`
		} `json:"tokenUsage"`
	}
	if json.Unmarshal(raw, &params) != nil || params.ThreadID == "" {
		return nil
	}
	key := p.key("usage", params.ThreadID, params.TurnID, digest(raw))
	if !p.mark(key) {
		return nil
	}
	usageEvent := protocol.DaemonEvent{
		Type: "agent_text", SessionID: params.ThreadID, EventID: key,
		Usage: &protocol.ContextUsage{
			InputTokens:     params.TokenUsage.Last.InputTokens,
			OutputTokens:    params.TokenUsage.Last.OutputTokens,
			CacheRead:       params.TokenUsage.Last.CachedInputTokens,
			ReasoningTokens: params.TokenUsage.Last.ReasoningOutputTokens,
			TotalTokens:     params.TokenUsage.Last.TotalTokens,
		},
	}
	stampTurnIdentity(&usageEvent, params.ThreadID, params.TurnID, "")
	return []protocol.DaemonEvent{usageEvent}
}

func (p *codexProjection) synthesizeActiveTurn(threadID, turnID string, historical bool) []protocol.DaemonEvent {
	if _, completed := p.completedTurn[threadID+"\x00"+turnID]; completed {
		return nil
	}
	if p.activeTurn[threadID] == turnID {
		return nil
	}
	p.activeTurn[threadID] = turnID
	provenance := "live"
	if historical {
		provenance = "historical"
	}
	key := p.key("synthesized-turn", provenance, threadID, turnID)
	if !p.mark(key) {
		return nil
	}
	if provenance == "historical" {
		return nil
	}
	return []protocol.DaemonEvent{{Type: "session_status", SessionID: threadID, Status: protocol.StatusRunning}}
}

func (p *codexProjection) CurrentThreadStatus(threadID string) string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.threadStatus[threadID]
}

func (p *codexProjection) ThreadStatusRevision(threadID string) uint64 {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.threadRevision[threadID]
}

func (p *codexProjection) ProjectResumedThread(raw json.RawMessage, threadID string, baseline uint64, overrideStatus string) ([]protocol.DaemonEvent, string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	var thread map[string]any
	if json.Unmarshal(raw, &thread) != nil {
		return nil, ""
	}
	status := ""
	if native, ok := thread["status"].(map[string]any); ok {
		status, _ = native["type"].(string)
	}
	if overrideStatus != "" {
		status = overrideStatus
		thread["status"] = map[string]any{"type": status}
	} else if p.threadRevision[threadID] != baseline && p.threadStatus[threadID] != "" {
		status = p.threadStatus[threadID]
		thread["status"] = map[string]any{"type": status}
	}
	params, _ := json.Marshal(map[string]any{"thread": thread})
	events := p.projectThreadStarted(params)
	for i := range events {
		events[i].Resync = true
	}
	return events, status
}

func (p *codexProjection) mark(key string) bool {
	if _, exists := p.seen[key]; exists {
		return false
	}
	p.seen[key] = struct{}{}
	return true
}

func (p *codexProjection) key(parts ...string) string {
	return fmt.Sprintf("codex:%d:%s", p.generation, strings.Join(parts, ":"))
}

func (p *codexProjection) partKey(threadID, turnID, itemID, eventType string) string {
	return strings.Join([]string{threadID, turnID, itemID, eventType}, "\x00")
}

func (p *codexProjection) contentStreamID(eventType, threadID, turnID, itemID string, suffix ...string) string {
	parts := []string{"stream", eventType, threadID, turnID, itemID}
	parts = append(parts, suffix...)
	return p.key(parts...)
}

func mapCodexThreadStatus(status string) string {
	switch status {
	case "active":
		return protocol.StatusRunning
	case "idle":
		return protocol.StatusIdle
	case "systemError":
		return protocol.StatusError
	case "notLoaded":
		return protocol.StatusDisconnected
	default:
		return status
	}
}

func digest(raw []byte) string {
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:8])
}
