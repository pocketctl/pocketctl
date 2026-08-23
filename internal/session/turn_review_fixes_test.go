package session

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/turn"
)

func TestReviewOpenCodePromptCallbackWaitsForSyncLoopTerminal(t *testing.T) {
	var historyMu sync.Mutex
	var history []adapter.OpencodeMessageWithParts
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/session/opencode-sync-callback/message":
			historyMu.Lock()
			defer historyMu.Unlock()
			_ = json.NewEncoder(w).Encode(history)
		case r.Method == http.MethodGet && r.URL.Path == "/session/status":
			_ = json.NewEncoder(w).Encode(map[string]any{"opencode-sync-callback": map[string]string{"type": "idle"}})
		case r.Method == http.MethodPost && r.URL.Path == "/session/opencode-sync-callback/message":
			var body struct {
				MessageID string `json:"messageID"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			now := time.Now().UnixMilli()
			user := adapter.OpencodeMessageWithParts{}
			user.Info.ID, user.Info.SessionID, user.Info.Role = body.MessageID, "opencode-sync-callback", "user"
			user.Info.Time.Created = now
			assistant := adapter.OpencodeMessageWithParts{}
			assistant.Info.ID, assistant.Info.SessionID, assistant.Info.Role = "msg_assistant_sync_callback", "opencode-sync-callback", "assistant"
			assistant.Info.ParentID = body.MessageID
			assistant.Info.Time.Created, assistant.Info.Time.Completed = now+1, now+2
			assistant.Parts = []adapter.OpencodePart{{ID: "prt_sync_callback", MessageID: assistant.Info.ID, Type: "text", Text: "done"}}
			historyMu.Lock()
			history = []adapter.OpencodeMessageWithParts{user, assistant}
			historyMu.Unlock()
			_ = json.NewEncoder(w).Encode(assistant)
		default:
			_ = json.NewEncoder(w).Encode([]any{})
		}
	})
	serve := startFakeOpenCodeServer(t, handler)
	out := make(chan protocol.DaemonEvent, 64)
	sm := NewSessionManager(out)
	coord := newOpencodeCoordinator(sm)
	coord.mu.Lock()
	coord.server, coord.started = serve, true
	coord.mu.Unlock()
	sm.sessions["opencode-sync-callback"] = &ProcessState{
		SessionID: "opencode-sync-callback", Agent: adapter.AgentOpencode, Source: "daemon",
		Status: protocol.StatusIdle, Model: "openai/gpt-5", Backend: &serverBackend{coord: coord}, ControlMode: protocol.ControlManaged,
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go coord.syncLoop(ctx, "opencode-sync-callback", false)

	if err := sm.SendMessageWithInput(context.Background(), UserMessageInput{
		SessionID: "opencode-sync-callback", Content: "hello", RequestID: "request-sync-callback",
	}); err != nil {
		t.Fatal(err)
	}
	canonicalTurn := turn.LogicalTurnID(adapter.AgentOpencode, "opencode-sync-callback", "", "request", "request-sync-callback")
	deadline := time.After(2500 * time.Millisecond)
	var terminalTurns []string
	var contentTurns []string
	for {
		select {
		case event := <-out:
			if event.Type == protocol.EventTypeTurnStatus && !sm.ObserveTurnStatusEvent(event) {
				continue
			}
			sm.EnrichOutgoingEvent(&event)
			if event.Type == protocol.EventTypeTurnStatus && turn.IsTerminal(event.TurnStatus) {
				terminalTurns = append(terminalTurns, event.TurnID)
			}
			if event.Type == "agent_text" {
				contentTurns = append(contentTurns, event.TurnID)
			}
		case <-deadline:
			if len(terminalTurns) != 1 || terminalTurns[0] != canonicalTurn {
				t.Fatalf("forwarded terminal turns = %v, want one canonical %q", terminalTurns, canonicalTurn)
			}
			if len(contentTurns) == 0 || contentTurns[0] != canonicalTurn {
				t.Fatalf("content turns = %v, want canonical %q", contentTurns, canonicalTurn)
			}
			return
		}
	}
}

func TestReviewOpenCodePromptFailureWaitsForLateSyncSource(t *testing.T) {
	var historyMu sync.Mutex
	var history []adapter.OpencodeMessageWithParts
	var sourceMessageID string
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/session/opencode-sync-failure/message":
			historyMu.Lock()
			defer historyMu.Unlock()
			_ = json.NewEncoder(w).Encode(history)
		case r.Method == http.MethodGet && r.URL.Path == "/session/status":
			_ = json.NewEncoder(w).Encode(map[string]any{"opencode-sync-failure": map[string]string{"type": "idle"}})
		case r.Method == http.MethodPost && r.URL.Path == "/session/opencode-sync-failure/message":
			var body struct {
				MessageID string `json:"messageID"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			sourceMessageID = body.MessageID
			user := adapter.OpencodeMessageWithParts{}
			user.Info.ID, user.Info.SessionID, user.Info.Role = body.MessageID, "opencode-sync-failure", "user"
			user.Info.Time.Created = time.Now().UnixMilli()
			historyMu.Lock()
			history = []adapter.OpencodeMessageWithParts{user}
			historyMu.Unlock()
			http.Error(w, "provider failed after accepting the user message", http.StatusInternalServerError)
		default:
			_ = json.NewEncoder(w).Encode([]any{})
		}
	})
	serve := startFakeOpenCodeServer(t, handler)
	out := make(chan protocol.DaemonEvent, 64)
	sm := NewSessionManager(out)
	coord := newOpencodeCoordinator(sm)
	coord.mu.Lock()
	coord.server, coord.started = serve, true
	coord.mu.Unlock()
	sm.sessions["opencode-sync-failure"] = &ProcessState{
		SessionID: "opencode-sync-failure", Agent: adapter.AgentOpencode, Source: "daemon",
		Status: protocol.StatusIdle, Model: "openai/gpt-5", Backend: &serverBackend{coord: coord}, ControlMode: protocol.ControlManaged,
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go coord.syncLoop(ctx, "opencode-sync-failure", false)

	if err := sm.SendMessageWithInput(context.Background(), UserMessageInput{
		SessionID: "opencode-sync-failure", Content: "hello", RequestID: "request-sync-failure",
	}); err != nil {
		t.Fatal(err)
	}
	canonicalTurn := turn.LogicalTurnID(adapter.AgentOpencode, "opencode-sync-failure", "", "request", "request-sync-failure")
	deadline := time.After(3500 * time.Millisecond)
	var forwardedTurns []string
	for {
		select {
		case event := <-out:
			if event.Type == protocol.EventTypeTurnStatus && !sm.ObserveTurnStatusEvent(event) {
				continue
			}
			sm.EnrichOutgoingEvent(&event)
			if event.Type == protocol.EventTypeTurnStatus {
				forwardedTurns = append(forwardedTurns, event.TurnID+":"+event.TurnStatus)
			}
		case <-deadline:
			if sourceMessageID == "" {
				t.Fatal("prompt did not reserve a native source message id")
			}
			if _, ok := sm.ActiveTurn("opencode-sync-failure"); ok {
				t.Fatalf("late source left a second active turn; forwarded=%v", forwardedTurns)
			}
			last, ok := sm.turns.Last(turn.ActorKey{SessionID: "opencode-sync-failure"})
			if !ok || last.TurnID != canonicalTurn || last.SourceTurnID != sourceMessageID || last.State != protocol.TurnStateFailed {
				t.Fatalf("terminal turn = %+v, want canonical=%q source=%q failed; forwarded=%v", last, canonicalTurn, sourceMessageID, forwardedTurns)
			}
			for _, got := range forwardedTurns {
				if !strings.HasPrefix(got, canonicalTurn+":") {
					t.Fatalf("late source created a second lifecycle identity: %v", forwardedTurns)
				}
			}
			return
		}
	}
}

func TestReviewOpenCodePendingSourceRejectsSecondDispatch(t *testing.T) {
	var postCount atomic.Int32
	firstPostStarted := make(chan struct{})
	releaseFirstPost := make(chan struct{})
	var startedOnce sync.Once
	defer func() {
		select {
		case <-releaseFirstPost:
		default:
			close(releaseFirstPost)
		}
	}()
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/session/opencode-pending-source/message":
			_ = json.NewEncoder(w).Encode([]any{})
		case r.Method == http.MethodPost && r.URL.Path == "/session/opencode-pending-source/message":
			postCount.Add(1)
			var body struct {
				MessageID string `json:"messageID"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			startedOnce.Do(func() { close(firstPostStarted) })
			<-releaseFirstPost
			_ = json.NewEncoder(w).Encode(map[string]any{
				"info":  map[string]any{"id": "msg_assistant_pending", "sessionID": "opencode-pending-source", "role": "assistant", "parentID": body.MessageID},
				"parts": []any{},
			})
		default:
			_ = json.NewEncoder(w).Encode([]any{})
		}
	})
	serve := startFakeOpenCodeServer(t, handler)
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 32))
	coord := newOpencodeCoordinator(sm)
	coord.mu.Lock()
	coord.server, coord.started = serve, true
	coord.mu.Unlock()
	sm.sessions["opencode-pending-source"] = &ProcessState{
		SessionID: "opencode-pending-source", Agent: adapter.AgentOpencode, Source: "daemon",
		Status: protocol.StatusIdle, Model: "openai/gpt-5", Backend: &serverBackend{coord: coord}, ControlMode: protocol.ControlManaged,
	}

	if err := sm.SendMessageWithInput(context.Background(), UserMessageInput{
		SessionID: "opencode-pending-source", Content: "first", RequestID: "request-pending-first",
	}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-firstPostStarted:
	case <-time.After(5 * time.Second):
		t.Fatal("first OpenCode POST did not start")
	}
	err := sm.SendMessageWithInput(context.Background(), UserMessageInput{
		SessionID: "opencode-pending-source", Content: "second", RequestID: "request-pending-second",
	})
	if err == nil || !strings.Contains(err.Error(), "dispatch pending") {
		t.Fatalf("second dispatch error = %v, want pending rejection", err)
	}
	if got := postCount.Load(); got != 1 {
		t.Fatalf("OpenCode POST count = %d, want 1", got)
	}
	close(releaseFirstPost)
}

func TestReviewTurnTerminalMergeDoesNotBlockOnFullOutput(t *testing.T) {
	out := make(chan protocol.DaemonEvent, 1)
	out <- protocol.DaemonEvent{Type: "agent_text", SessionID: "full-output", Text: "older"}
	sm := NewSessionManager(out)
	rec, err := sm.turns.Start(turn.StartInput{
		Actor: turn.ActorKey{SessionID: "full-output"}, Identity: turn.Identity{Agent: adapter.AgentOpencode, RequestID: "request-full-output"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := sm.turns.ExpectSource(rec.Actor, rec.TurnID, "msg_full_output"); err != nil {
		t.Fatal(err)
	}
	if _, err := sm.turns.BindSource(rec.Actor, rec.TurnID, "msg_full_output"); err != nil {
		t.Fatal(err)
	}
	projected := protocol.DaemonEvent{
		Type: protocol.EventTypeTurnStatus, SessionID: "full-output",
		TurnID:       turn.LogicalTurnID(adapter.AgentOpencode, "full-output", "", "source_message", "msg_full_output"),
		SourceTurnID: "msg_full_output", TurnStatus: protocol.TurnStateCompleted,
		TurnOrigin: protocol.TurnOriginSourceMessage, TurnConfidence: protocol.TurnConfidenceDerived,
	}
	done := make(chan bool, 1)
	go func() { done <- sm.ObserveTurnStatusEvent(projected) }()
	select {
	case forwarded := <-done:
		if forwarded {
			t.Fatal("native terminal should be replaced by canonical identity")
		}
	case <-time.After(200 * time.Millisecond):
		<-out
		<-done
		t.Fatal("terminal merge blocked while outputCh was full")
	}

	older := <-out
	if older.Type != "agent_text" || older.Text != "older" {
		t.Fatalf("old buffered event = %+v", older)
	}
	select {
	case canonical := <-out:
		if canonical.Type != protocol.EventTypeTurnStatus || canonical.TurnID != rec.TurnID || canonical.TurnStatus != protocol.TurnStateCompleted {
			t.Fatalf("canonical terminal = %+v", canonical)
		}
	case <-time.After(time.Second):
		t.Fatal("canonical terminal was not queued after output capacity returned")
	}
}

type reviewInitialBackend struct {
	sentSession string
	sentContent string
	sendErr     error
}

func (b *reviewInitialBackend) Start(context.Context, protocol.SessionConfig) (string, error) {
	return "", nil
}
func (b *reviewInitialBackend) Send(_ context.Context, sessionID, content string) error {
	b.sentSession, b.sentContent = sessionID, content
	return b.sendErr
}
func (b *reviewInitialBackend) Interrupt(string) error { return nil }
func (b *reviewInitialBackend) Close(string) error     { return nil }

// --- review P1-1: one real turn, one identity -------------------------------

// Content events from adapter projections are re-bound to the registry's
// active (request-anchored) turn so a real turn never splits into two groups.
func TestReviewIdentityUnificationOnOutgoingContent(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 8))
	sm.sessions["uni-sess"] = &ProcessState{SessionID: "uni-sess", Agent: "claude-code", Source: "daemon", Status: protocol.StatusRunning}
	rec, err := sm.turns.Start(turn.StartInput{
		Actor:    turn.ActorKey{SessionID: "uni-sess"},
		Identity: turn.Identity{Agent: "claude-code", RequestID: "req-uni"},
	})
	if err != nil {
		t.Fatal(err)
	}

	// A claude-projected agent_text carrying a source-message identity gets
	// re-bound to the authoritative request turn.
	projected := protocol.DaemonEvent{
		Type: "agent_text", SessionID: "uni-sess", Text: "reply",
		TurnID: "turn:v1:claude-code:record-9", SourceTurnID: "record-9",
		TurnOrigin: protocol.TurnOriginSourceMessage, TurnConfidence: protocol.TurnConfidenceDerived,
	}
	sm.EnrichOutgoingEvent(&projected)
	if projected.TurnID != rec.TurnID {
		t.Fatalf("content turn id = %q, want the active turn %q", projected.TurnID, rec.TurnID)
	}
	if projected.TurnOrigin != protocol.TurnOriginRequest {
		t.Fatalf("origin = %q, want request", projected.TurnOrigin)
	}
	// The adapter's source evidence is preserved.
	if projected.SourceTurnID != "record-9" {
		t.Fatalf("source evidence lost: %q", projected.SourceTurnID)
	}

	// Unassigned content events pick up the active turn identity too.
	bare := protocol.DaemonEvent{Type: "user_text", SessionID: "uni-sess", Text: "hello"}
	sm.EnrichOutgoingEvent(&bare)
	if bare.TurnID != rec.TurnID {
		t.Fatalf("bare content turn id = %q", bare.TurnID)
	}
	if sm.turnMetrics.Snapshot()["unassigned_events"] != 0 {
		t.Error("active-turn content must not count as unassigned")
	}
}

// A projected terminal fact for a different id closes the active running turn
// (merge) and the projected event itself is dropped.
func TestReviewTerminalMergeClosesActiveTurn(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 8))
	rec, err := sm.turns.Start(turn.StartInput{
		Actor:    turn.ActorKey{SessionID: "merge-sess"},
		Identity: turn.Identity{Agent: "claude-code", RequestID: "req-m"},
	})
	if err != nil {
		t.Fatal(err)
	}
	// Content from the adapter establishes which source-native turn belongs to
	// the request-anchored canonical turn before a terminal fact may close it.
	content := protocol.DaemonEvent{
		Type: "agent_text", SessionID: "merge-sess", Text: "reply",
		TurnID: "turn:v1:claude-code:rec-m", SourceTurnID: "rec-m",
		TurnOrigin: protocol.TurnOriginSourceMessage, TurnConfidence: protocol.TurnConfidenceDerived,
	}
	sm.EnrichOutgoingEvent(&content)
	// The claude JSONL tracker's completed event for its source-message id.
	projected := turn.StatusEvent(turn.TurnRecord{
		Actor:        turn.ActorKey{SessionID: "merge-sess"},
		TurnID:       "turn:v1:claude-code:rec-m",
		SourceTurnID: "rec-m",
		Origin:       protocol.TurnOriginSourceMessage,
		Confidence:   protocol.TurnConfidenceDerived,
	}, protocol.TurnStateCompleted, "result_record")
	if sm.ObserveTurnStatusEvent(projected) {
		t.Fatal("projected terminal event must be dropped after the merge")
	}
	if _, stillActive := sm.ActiveTurn("merge-sess"); stillActive {
		t.Fatal("active turn must be terminalized by the merge")
	}
	last, ok := sm.turns.Last(turn.ActorKey{SessionID: "merge-sess"})
	if !ok || last.TurnID != rec.TurnID || last.State != protocol.TurnStateCompleted {
		t.Fatalf("merged terminal = %+v", last)
	}
}

// A late terminal from an older source-native turn must never close a newer
// request-anchored turn merely because both belong to the same session.
func TestReviewStaleTerminalDoesNotCloseNewActiveTurn(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 8))
	rec, err := sm.turns.Start(turn.StartInput{
		Actor:    turn.ActorKey{SessionID: "stale-terminal-sess"},
		Identity: turn.Identity{Agent: "claude-code", RequestID: "req-new"},
	})
	if err != nil {
		t.Fatal(err)
	}
	staleRunning := turn.StatusEvent(turn.TurnRecord{
		Actor:        turn.ActorKey{SessionID: "stale-terminal-sess"},
		TurnID:       "turn:v1:claude-code:old-record",
		SourceTurnID: "old-record",
		Origin:       protocol.TurnOriginSourceMessage,
		Confidence:   protocol.TurnConfidenceDerived,
	}, protocol.TurnStateRunning, "historical_record")
	if sm.ObserveTurnStatusEvent(staleRunning) {
		t.Fatal("stale projected running event must be dropped")
	}
	active, ok := sm.ActiveTurn("stale-terminal-sess")
	if !ok || active.TurnID != rec.TurnID || active.SourceTurnID != "" {
		t.Fatalf("stale projected running event bound the new turn: %+v", active)
	}
	stale := turn.StatusEvent(turn.TurnRecord{
		Actor:        turn.ActorKey{SessionID: "stale-terminal-sess"},
		TurnID:       "turn:v1:claude-code:old-record",
		SourceTurnID: "old-record",
		Origin:       protocol.TurnOriginSourceMessage,
		Confidence:   protocol.TurnConfidenceDerived,
	}, protocol.TurnStateCompleted, "late_result")
	if sm.ObserveTurnStatusEvent(stale) {
		t.Fatal("uncorrelated stale terminal must be dropped")
	}
	active, ok = sm.ActiveTurn("stale-terminal-sess")
	if !ok || active.TurnID != rec.TurnID || active.State != protocol.TurnStateRunning {
		t.Fatalf("new active turn was closed by stale evidence: %+v", active)
	}
}

func TestReviewOpenCodeErrorOnlyFailureClosesRequestTurn(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 8))
	requestTurn, err := sm.turns.Start(turn.StartInput{
		Actor:    turn.ActorKey{SessionID: "opencode-error-only"},
		Identity: turn.Identity{Agent: "opencode", RequestID: "req-error-only"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := sm.turns.ExpectSource(requestTurn.Actor, requestTurn.TurnID, "source-user-error-only"); err != nil {
		t.Fatal(err)
	}

	user := adapter.OpencodeMessageWithParts{}
	user.Info.ID = "source-user-error-only"
	user.Info.SessionID = "opencode-error-only"
	user.Info.Role = "user"
	user.Info.Time.Created = requestTurn.StartedAt.Add(time.Millisecond).UnixMilli()
	assistant := adapter.OpencodeMessageWithParts{}
	assistant.Info.ID = "assistant-error-only"
	assistant.Info.SessionID = "opencode-error-only"
	assistant.Info.Role = "assistant"
	assistant.Info.Time.Created = user.Info.Time.Created + 1

	sync := adapter.NewOpencodeSync("opencode-error-only", false)
	running := sync.DiffWithNativeStatus(
		[]adapter.OpencodeMessageWithParts{user, assistant},
		&adapter.OpencodeSessionStatus{Type: protocol.StatusBusy},
	)
	for _, event := range running {
		if event.Type == protocol.EventTypeTurnStatus {
			sm.ObserveTurnStatusEvent(event)
			continue
		}
		sm.EnrichOutgoingEvent(&event)
	}
	active, ok := sm.ActiveTurn("opencode-error-only")
	if !ok || active.TurnID != requestTurn.TurnID || active.SourceTurnID != "source-user-error-only" {
		t.Fatalf("request turn after projected running = %+v", active)
	}

	assistant.Info.Error = json.RawMessage(`{"name":"ProviderError","message":"fixture failure"}`)
	failed := sync.DiffWithNativeStatus(
		[]adapter.OpencodeMessageWithParts{user, assistant},
		&adapter.OpencodeSessionStatus{Type: protocol.StatusIdle},
	)
	var projectedError protocol.DaemonEvent
	for _, event := range failed {
		if event.Type == protocol.EventTypeTurnStatus {
			sm.ObserveTurnStatusEvent(event)
			continue
		}
		sm.EnrichOutgoingEvent(&event)
		if event.Type == "error" {
			projectedError = event
		}
	}
	if projectedError.TurnID != requestTurn.TurnID || projectedError.SourceTurnID != "source-user-error-only" {
		t.Fatalf("projected error identity = %+v, want request turn %q", projectedError, requestTurn.TurnID)
	}
	if _, stillActive := sm.ActiveTurn("opencode-error-only"); stillActive {
		t.Fatal("error-only failed projection left the request turn active")
	}
	last, ok := sm.turns.Last(turn.ActorKey{SessionID: "opencode-error-only"})
	if !ok || last.TurnID != requestTurn.TurnID || last.State != protocol.TurnStateFailed {
		t.Fatalf("error-only terminal = %+v", last)
	}
}

// A fresh OpenCode sync replays the full message history. Historical source
// events must not bind to a newer request turn that was reserved while the
// daemon was starting or before the first poll completed.
func TestReviewOpenCodeHistoricalErrorOnlyDoesNotCloseNewRequestTurn(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 8))
	requestTurn, err := sm.turns.Start(turn.StartInput{
		Actor:    turn.ActorKey{SessionID: "opencode-history-race"},
		Identity: turn.Identity{Agent: "opencode", RequestID: "req-new"},
	})
	if err != nil {
		t.Fatal(err)
	}
	user := adapter.OpencodeMessageWithParts{}
	user.Info.ID = "source-user-old"
	user.Info.SessionID = "opencode-history-race"
	user.Info.Role = "user"
	user.Info.Time.Created = requestTurn.StartedAt.Add(-time.Hour).UnixMilli()
	assistant := adapter.OpencodeMessageWithParts{}
	assistant.Info.ID = "assistant-old-error"
	assistant.Info.SessionID = "opencode-history-race"
	assistant.Info.Role = "assistant"
	assistant.Info.Time.Created = user.Info.Time.Created + 1
	assistant.Info.Error = json.RawMessage(`{"name":"ProviderError","message":"historical failure"}`)

	sync := adapter.NewOpencodeSync("opencode-history-race", false)
	events := sync.DiffWithNativeStatus(
		[]adapter.OpencodeMessageWithParts{user, assistant},
		&adapter.OpencodeSessionStatus{Type: protocol.StatusIdle},
	)
	for _, event := range events {
		if event.Type == protocol.EventTypeTurnStatus {
			sm.ObserveTurnStatusEvent(event)
			continue
		}
		sm.EnrichOutgoingEvent(&event)
		if event.Type == "error" && event.TurnID == requestTurn.TurnID {
			t.Fatalf("historical error was rebound to the new request turn: %+v", event)
		}
	}

	active, ok := sm.ActiveTurn("opencode-history-race")
	if !ok || active.TurnID != requestTurn.TurnID || active.State != protocol.TurnStateRunning || active.SourceTurnID != "" {
		t.Fatalf("historical replay changed the new request turn: %+v", active)
	}
}

// A completed OpenCode turn can legitimately contain no text/tool/error
// events. Its reserved native user-message id is sufficient to bind the
// projected terminal fact to the already-reserved request turn.
func TestReviewOpenCodeZeroContentCompletedClosesRequestTurn(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 8))
	requestTurn, err := sm.turns.Start(turn.StartInput{
		Actor:    turn.ActorKey{SessionID: "opencode-zero-content"},
		Identity: turn.Identity{Agent: "opencode", RequestID: "req-zero-content"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := sm.turns.ExpectSource(requestTurn.Actor, requestTurn.TurnID, "source-user-zero-content"); err != nil {
		t.Fatal(err)
	}

	user := adapter.OpencodeMessageWithParts{}
	user.Info.ID = "source-user-zero-content"
	user.Info.SessionID = "opencode-zero-content"
	user.Info.Role = "user"
	user.Info.Time.Created = requestTurn.StartedAt.Add(time.Millisecond).UnixMilli()
	assistant := adapter.OpencodeMessageWithParts{}
	assistant.Info.ID = "assistant-zero-content"
	assistant.Info.SessionID = "opencode-zero-content"
	assistant.Info.Role = "assistant"
	assistant.Info.Time.Created = user.Info.Time.Created + 1
	assistant.Info.Time.Completed = assistant.Info.Time.Created + 1

	sync := adapter.NewOpencodeSync("opencode-zero-content", false)
	events := sync.DiffWithNativeStatus(
		[]adapter.OpencodeMessageWithParts{user, assistant},
		&adapter.OpencodeSessionStatus{Type: protocol.StatusIdle},
	)
	var projectedTerminal protocol.DaemonEvent
	for _, event := range events {
		if event.Type == protocol.EventTypeTurnStatus {
			projectedTerminal = event
			sm.ObserveTurnStatusEvent(event)
			continue
		}
		sm.EnrichOutgoingEvent(&event)
	}
	if projectedTerminal.TurnStatus != protocol.TurnStateCompleted || projectedTerminal.TurnStartedAt == "" {
		t.Fatalf("zero-content terminal lacks source timing evidence: %+v", projectedTerminal)
	}
	if _, stillActive := sm.ActiveTurn("opencode-zero-content"); stillActive {
		t.Fatal("zero-content completed projection left the request turn active")
	}
	last, ok := sm.turns.Last(turn.ActorKey{SessionID: "opencode-zero-content"})
	if !ok || last.TurnID != requestTurn.TurnID || last.State != protocol.TurnStateCompleted || last.SourceTurnID != "source-user-zero-content" {
		t.Fatalf("zero-content terminal = %+v", last)
	}
	select {
	case emitted := <-sm.outputCh:
		if emitted.Type != protocol.EventTypeTurnStatus || emitted.TurnID != requestTurn.TurnID ||
			emitted.TurnStatus != protocol.TurnStateCompleted || emitted.SourceTurnID != "source-user-zero-content" {
			t.Fatalf("canonical terminal emission = %+v", emitted)
		}
		// Exercise the same outgoing chokepoint used by cmd/pocketctl: the
		// projected terminal was dropped above, while the canonical replacement
		// must be claimable exactly once for Relay dispatch.
		if !sm.ObserveTurnStatusEvent(emitted) {
			t.Fatal("canonical terminal replacement was dropped before outbound dispatch")
		}
		if sm.ObserveTurnStatusEvent(emitted) {
			t.Fatal("canonical terminal replacement was dispatchable more than once")
		}
	default:
		t.Fatal("zero-content merge did not emit the canonical terminal event")
	}
}

// Journals written before agent identity was available restore TurnRecord.Agent
// as empty. Once discovery identifies the session as OpenCode, a persisted
// expected native source must still provide exact correlation after restart.
func TestReviewRestoredOpenCodeTurnUsesDiscoveredAgentForTerminalBinding(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 8))
	sm.sessions["opencode-restored-binding"] = &ProcessState{
		SessionID: "opencode-restored-binding",
		Agent:     adapter.AgentOpencode,
		Status:    protocol.StatusRunning,
	}
	startedAt := time.Now().Add(-time.Minute)
	sm.turns.Restore([]turn.JournalEntry{{
		SessionID:            "opencode-restored-binding",
		TurnID:               "turn:v1:opencode:restored-request",
		State:                protocol.TurnStateRunning,
		Origin:               protocol.TurnOriginRequest,
		StartedAt:            startedAt,
		ExpectedSourceTurnID: "source-after-restart",
	}})
	active, ok := sm.ActiveTurn("opencode-restored-binding")
	if !ok || active.Agent != "" || !active.Restored {
		t.Fatalf("legacy restored turn precondition = %+v", active)
	}

	projected := turn.StatusEvent(turn.TurnRecord{
		Actor:        turn.ActorKey{SessionID: "opencode-restored-binding"},
		TurnID:       "turn:v1:opencode:source-after-restart",
		SourceTurnID: "source-after-restart",
		Origin:       protocol.TurnOriginSourceMessage,
		Confidence:   protocol.TurnConfidenceDerived,
	}, protocol.TurnStateCompleted, "message_completed")
	projected.TurnStartedAt = startedAt.Add(time.Second).UTC().Format(time.RFC3339Nano)
	if sm.ObserveTurnStatusEvent(projected) {
		t.Fatal("restored source terminal must merge into the canonical journal turn")
	}
	if _, stillActive := sm.ActiveTurn("opencode-restored-binding"); stillActive {
		t.Fatal("restored OpenCode turn remained active after correlated terminal")
	}
	last, ok := sm.turns.Last(turn.ActorKey{SessionID: "opencode-restored-binding"})
	if !ok || last.TurnID != active.TurnID || last.State != protocol.TurnStateCompleted || last.SourceTurnID != "source-after-restart" {
		t.Fatalf("restored terminal = %+v", last)
	}
}

func TestReviewOpenCodeProjectedSourceBindingRequiresExpectedDispatchIdentity(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 1))
	startedAt := time.Date(2026, 8, 21, 1, 2, 3, 500_000, time.UTC)
	active, err := sm.turns.Start(turn.StartInput{
		Actor:    turn.ActorKey{SessionID: "opencode-binding-guard"},
		Identity: turn.Identity{Agent: adapter.AgentOpencode, RequestID: "request-binding-guard"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := sm.turns.ExpectSource(active.Actor, active.TurnID, "source-actual-dispatch"); err != nil {
		t.Fatal(err)
	}

	competitor := protocol.DaemonEvent{
		Type:          protocol.EventTypeTurnStatus,
		SessionID:     "opencode-binding-guard",
		TurnID:        "turn:v1:opencode:source-competing-client",
		SourceTurnID:  "source-competing-client",
		TurnStatus:    protocol.TurnStateRunning,
		TurnOrigin:    protocol.TurnOriginSourceMessage,
		TurnStartedAt: startedAt.Add(time.Hour).Format(time.RFC3339Nano),
	}
	if sm.openCodeProjectedSourceCanBind(active, competitor) {
		t.Fatal("a newer competing source must not satisfy exact dispatch correlation")
	}
	if sm.ObserveTurnStatusEvent(competitor) {
		t.Fatal("competing running projection should be dropped while a request turn is active")
	}
	stillActive, ok := sm.ActiveTurn("opencode-binding-guard")
	if !ok || stillActive.SourceTurnID != "" || stillActive.ExpectedSourceTurnID != "source-actual-dispatch" {
		t.Fatalf("competitor rewrote reserved source identity: %+v", stillActive)
	}

	actual := competitor
	actual.TurnID = "turn:v1:opencode:source-actual-dispatch"
	actual.SourceTurnID = "source-actual-dispatch"
	actual.TurnStartedAt = "" // exact dispatch identity does not rely on time
	if !sm.openCodeProjectedSourceCanBind(stillActive, actual) {
		t.Fatal("the exact dispatched source identity should permit binding")
	}
	if sm.ObserveTurnStatusEvent(actual) {
		t.Fatal("native running projection should merge into the canonical request turn")
	}
	bound, ok := sm.ActiveTurn("opencode-binding-guard")
	if !ok || bound.SourceTurnID != "source-actual-dispatch" || bound.ExpectedSourceTurnID != "" {
		t.Fatalf("actual dispatch source was not confirmed atomically: %+v", bound)
	}
}

// The production serverBackend reserves an expected source before POST, but
// does not publish it as observed identity. While the real POST is blocked, a
// competing client's source projection must not win; the verified response
// parent confirms the actual source and the real sync loop emits one canonical
// terminal after observing the persisted native messages.
func TestReviewOpenCodeRealDispatchRejectsCompetingSourceBeforeConfirmation(t *testing.T) {
	postStarted := make(chan string, 1)
	releasePost := make(chan struct{})
	var historyMu sync.Mutex
	var history []adapter.OpencodeMessageWithParts
	released := false
	defer func() {
		if !released {
			close(releasePost)
		}
	}()
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/session/opencode-real-dispatch/message":
			historyMu.Lock()
			defer historyMu.Unlock()
			_ = json.NewEncoder(w).Encode(history)
		case r.Method == http.MethodGet && r.URL.Path == "/session/status":
			_ = json.NewEncoder(w).Encode(map[string]any{"opencode-real-dispatch": map[string]string{"type": "idle"}})
		case r.Method == http.MethodPost && r.URL.Path == "/session/opencode-real-dispatch/message":
			var body struct {
				MessageID string `json:"messageID"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			postStarted <- body.MessageID
			<-releasePost
			now := time.Now().UnixMilli()
			user := adapter.OpencodeMessageWithParts{}
			user.Info.ID, user.Info.SessionID, user.Info.Role = body.MessageID, "opencode-real-dispatch", "user"
			user.Info.Time.Created = now
			assistant := adapter.OpencodeMessageWithParts{}
			assistant.Info.ID, assistant.Info.SessionID, assistant.Info.Role = "msg_assistant_dispatch", "opencode-real-dispatch", "assistant"
			assistant.Info.ParentID = body.MessageID
			assistant.Info.Time.Created, assistant.Info.Time.Completed = now+1, now+2
			historyMu.Lock()
			history = []adapter.OpencodeMessageWithParts{user, assistant}
			historyMu.Unlock()
			_ = json.NewEncoder(w).Encode(assistant)
		default:
			_ = json.NewEncoder(w).Encode([]any{})
		}
	})
	serve := startFakeOpenCodeServer(t, handler)
	out := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(out)
	coord := newOpencodeCoordinator(sm)
	coord.mu.Lock()
	coord.server = serve
	coord.started = true
	coord.mu.Unlock()
	sm.sessions["opencode-real-dispatch"] = &ProcessState{
		SessionID: "opencode-real-dispatch", Agent: adapter.AgentOpencode,
		Source: "daemon", Status: protocol.StatusIdle, Model: "openai/gpt-5",
		Backend: &serverBackend{coord: coord}, ControlMode: protocol.ControlManaged,
	}
	syncCtx, cancelSync := context.WithCancel(context.Background())
	defer cancelSync()
	go coord.syncLoop(syncCtx, "opencode-real-dispatch", false)

	if err := sm.SendMessageWithInput(context.Background(), UserMessageInput{
		SessionID: "opencode-real-dispatch", Content: "hello", RequestID: "request-real-dispatch",
	}); err != nil {
		t.Fatal(err)
	}
	var expectedSource string
	select {
	case expectedSource = <-postStarted:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for real OpenCode POST")
	}
	active, ok := sm.ActiveTurn("opencode-real-dispatch")
	if !ok || active.SourceTurnID != "" || active.ExpectedSourceTurnID != expectedSource {
		t.Fatalf("pre-confirmation identity = %+v, POST source=%q", active, expectedSource)
	}

	competitor := protocol.DaemonEvent{
		Type: protocol.EventTypeTurnStatus, SessionID: "opencode-real-dispatch",
		TurnID: "turn:v1:opencode:competing", SourceTurnID: "msg_competing",
		TurnStatus: protocol.TurnStateRunning, TurnOrigin: protocol.TurnOriginSourceMessage,
		TurnStartedAt: time.Now().Add(time.Hour).Format(time.RFC3339Nano),
	}
	if sm.ObserveTurnStatusEvent(competitor) {
		t.Fatal("competing source projection escaped the canonical merge chokepoint")
	}
	active, ok = sm.ActiveTurn("opencode-real-dispatch")
	if !ok || active.SourceTurnID != "" || active.ExpectedSourceTurnID != expectedSource {
		t.Fatalf("competing source changed pre-confirmation identity: %+v", active)
	}

	close(releasePost)
	released = true
	deadline := time.After(5 * time.Second)
	forwardedTerminal := 0
	for forwardedTerminal == 0 {
		select {
		case event := <-out:
			if event.Type != protocol.EventTypeTurnStatus {
				continue
			}
			if !sm.ObserveTurnStatusEvent(event) {
				continue
			}
			if event.TurnStatus == protocol.TurnStateCompleted {
				forwardedTerminal++
				if event.SourceTurnID != expectedSource {
					t.Fatalf("canonical terminal source=%q, want %q", event.SourceTurnID, expectedSource)
				}
			}
		case <-deadline:
			t.Fatal("timed out waiting for canonical outbound terminal")
		}
	}
}

// --- review P1-4: explicit terminal interrupt maps to interrupted -----------

func TestReviewTerminalResumeInterruptIsInterruptedNotFailed(t *testing.T) {
	sm, _ := newTurnTestManager(t)
	// Simulate an in-flight terminal resume: the turn was reserved for the
	// request and the session is now mid-resume (running).
	ps := sm.sessions["turn-sess"]
	ps.Source = "terminal"
	ps.Status = protocol.StatusRunning
	if _, err := sm.turns.Start(turn.StartInput{
		Actor:    turn.ActorKey{SessionID: "turn-sess"},
		Identity: turn.Identity{Agent: "claude-code", RequestID: "req-ti"},
	}); err != nil {
		t.Fatal(err)
	}
	drainEvents(sm.outputCh)

	if err := sm.InterruptSession("turn-sess"); err != nil {
		t.Fatal(err)
	}
	// The turn must be interrupt_requested before the cancel, so the exit
	// mapping lands on interrupted, never failed(signal_kill).
	if rec, ok := sm.ActiveTurn("turn-sess"); ok && rec.State != protocol.TurnStateInterruptRequested {
		t.Fatalf("state before finalize = %s, want interrupt_requested", rec.State)
	}
	sm.finalizeProcessExit(context.Background(), context.Canceled, ps)
	last, ok := sm.turns.Last(turn.ActorKey{SessionID: "turn-sess"})
	if !ok || last.State != protocol.TurnStateInterrupted {
		t.Fatalf("terminal state = %+v, want interrupted", last)
	}
}

// --- review P1-6: restored turns reconcile ------------------------------------

func TestReviewRestoredTurnReconcilesAgainstSessionState(t *testing.T) {
	sm, _ := newTurnTestManager(t)
	// A journal-restored turn for a session that is now idle.
	sm.turns.Restore([]turn.JournalEntry{{
		SessionID: "turn-sess", TurnID: "turn:v1:claude-code:restored-1",
		State: protocol.TurnStateRunning, Origin: protocol.TurnOriginRequest,
	}})
	if rec, ok := sm.ActiveTurn("turn-sess"); !ok || !rec.Restored {
		t.Fatalf("restored turn = %+v", rec)
	}
	// Post-restore reconciliation: session discovered but idle → abandoned.
	sm.ReconcileRestoredTurns()
	if _, stillActive := sm.ActiveTurn("turn-sess"); stillActive {
		t.Fatal("restored turn on an idle session must be abandoned")
	}
	last, _ := sm.turns.Last(turn.ActorKey{SessionID: "turn-sess"})
	if last.State != protocol.TurnStateAbandoned {
		t.Fatalf("state = %s, want abandoned", last.State)
	}

	// A restored turn on a still-running session survives until evidence.
	sm2, _ := newTurnTestManager(t)
	sm2.sessions["turn-sess"].Status = protocol.StatusRunning
	sm2.turns.Restore([]turn.JournalEntry{{
		SessionID: "turn-sess", TurnID: "turn:v1:claude-code:restored-2",
		State: protocol.TurnStateRunning,
	}})
	sm2.ReconcileRestoredTurns()
	if _, ok := sm2.ActiveTurn("turn-sess"); !ok {
		t.Fatal("restored turn on a running session must survive")
	}

	// Reconciliation runs after discovery's grace period. If the session was
	// never rediscovered, the journal record is stale and must not live forever.
	sm3 := NewSessionManager(make(chan protocol.DaemonEvent, 8))
	sm3.turns.Restore([]turn.JournalEntry{{
		SessionID: "missing-sess", TurnID: "turn:v1:claude-code:restored-3",
		State: protocol.TurnStateRunning,
	}})
	sm3.ReconcileRestoredTurns()
	if _, ok := sm3.ActiveTurn("missing-sess"); ok {
		t.Fatal("undiscovered restored turn must be abandoned after reconciliation")
	}
}

// --- review P1-7: pending interactions and child turns ------------------------

func TestReviewDrainClearsPendingInteractionsWithoutGuessingChildRelation(t *testing.T) {
	sm, _ := newTurnTestManager(t)
	sm.turnMode = turnEnrichmentEnforce
	sm.sessions["turn-sess"].PendingPermissions = map[string]PendingOpenCodePermission{
		"pr-1": {RequestID: "pr-1"},
	}
	sm.sessions["turn-sess"].PendingQuestions = map[string]PendingOpenCodeQuestion{
		"qr-1": {RequestID: "qr-1"},
	}
	// Root turn + an active child turn.
	if _, err := sm.turns.Start(turn.StartInput{
		Actor:    turn.ActorKey{SessionID: "turn-sess"},
		Identity: turn.Identity{Agent: "claude-code", RequestID: "req-p7"},
	}); err != nil {
		t.Fatal(err)
	}
	child, err := sm.turns.Start(turn.StartInput{
		Actor:    turn.ActorKey{SessionID: "turn-sess", AgentID: "agent-child"},
		Identity: turn.Identity{Agent: "claude-code", SourceTurnID: "child-native"},
	})
	if err != nil {
		t.Fatal(err)
	}

	key := turn.ActorKey{SessionID: "turn-sess"}
	if _, err := sm.turns.RequestInterrupt(key, protocol.TurnReasonUserRequested); err != nil {
		t.Fatal(err)
	}
	active, _ := sm.ActiveTurn("turn-sess")
	sm.terminalizeTurn(key, active, protocol.TurnStateInterrupted, "confirmed", protocol.TurnConfidenceInferred)

	// Pending interactions resolved through the first-writer-wins path.
	sm.mu.RLock()
	perms := len(sm.sessions["turn-sess"].PendingPermissions)
	quests := len(sm.sessions["turn-sess"].PendingQuestions)
	sm.mu.RUnlock()
	if perms != 0 || quests != 0 {
		t.Fatalf("pending permissions/questions = %d/%d, want drained", perms, quests)
	}
	// Same-session child-looking actors are not enough evidence of parentage.
	// Without an explicit relation this independent child remains active.
	childActive, ok := sm.turns.Active(turn.ActorKey{SessionID: "turn-sess", AgentID: "agent-child"})
	if !ok || childActive.TurnID != child.TurnID || childActive.State != protocol.TurnStateRunning {
		t.Fatalf("unlinked child turn was guessed as a descendant: %+v", childActive)
	}
}

func TestReviewExplicitlyLinkedChildEndsWithParent(t *testing.T) {
	sm, _ := newTurnTestManager(t)
	root, err := sm.turns.Start(turn.StartInput{
		Actor:    turn.ActorKey{SessionID: "turn-sess"},
		Identity: turn.Identity{Agent: "claude-code", RequestID: "req-linked-root"},
	})
	if err != nil {
		t.Fatal(err)
	}
	childKey := turn.ActorKey{SessionID: "turn-sess", AgentID: "agent-linked"}
	child, err := sm.turns.Start(turn.StartInput{
		Actor:        childKey,
		Identity:     turn.Identity{Agent: "claude-code", SourceTurnID: "linked-child-native"},
		ParentTurnID: root.TurnID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := sm.turns.RequestInterrupt(root.Actor, protocol.TurnReasonUserRequested); err != nil {
		t.Fatal(err)
	}
	sm.terminalizeTurn(root.Actor, root, protocol.TurnStateInterrupted, "confirmed", protocol.TurnConfidenceInferred)
	last, ok := sm.turns.Last(childKey)
	if !ok || last.TurnID != child.TurnID || last.State != protocol.TurnStateAbandoned ||
		last.LastReason != protocol.TurnReasonParentTurnInterrupted {
		t.Fatalf("explicitly linked child = %+v", last)
	}
}

func TestReviewTurnEnrichmentOffDoesNotReserveInitialTurn(t *testing.T) {
	t.Setenv("POCKETCTL_TURN_ENRICHMENT", "off")
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 8))
	if _, err := sm.reserveTurnForInitialPrompt("off-initial", "claude-code"); err != nil {
		t.Fatal(err)
	}
	if _, ok := sm.ActiveTurn("off-initial"); ok {
		t.Fatal("turn_enrichment=off must not mutate the turn registry")
	}
}

func TestReviewCodexExecInitialPromptReservesBeforeEcho(t *testing.T) {
	dir := t.TempDir()
	cli := filepath.Join(dir, "fake-codex")
	if err := os.WriteFile(cli, []byte("#!/bin/sh\nsleep 2\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	out := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(out)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if _, err := sm.createCodexExecSession(ctx, "codex-initial", cli, dir, protocol.SessionConfig{
		Agent: "codex", Prompt: "hello",
	}, "", "", ""); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = sm.KillSession("codex-initial") }()

	select {
	case first := <-out:
		if first.Type != protocol.EventTypeTurnStatus || first.TurnStatus != protocol.TurnStateRunning {
			t.Fatalf("first event = %+v, want turn_status running before prompt echo", first)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for initial lifecycle event")
	}
	select {
	case second := <-out:
		if second.Type != "user_text" || second.Text != "hello" || second.TurnID == "" {
			t.Fatalf("second event = %+v, want turn-bound user echo", second)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for initial prompt echo")
	}
}

func TestReviewOpenCodeInitialDispatchUsesTurnAwareSendPath(t *testing.T) {
	out := make(chan protocol.DaemonEvent, 8)
	sm := NewSessionManager(out)
	backend := &reviewInitialBackend{}
	sm.sessions["opencode-initial"] = &ProcessState{
		SessionID: "opencode-initial", Agent: "opencode", Source: "daemon",
		Status: protocol.StatusIdle, Backend: backend, ControlMode: protocol.ControlManaged,
	}
	if err := sm.SendMessageWithInput(context.Background(), UserMessageInput{
		SessionID: "opencode-initial", Content: "hello opencode",
	}); err != nil {
		t.Fatal(err)
	}
	first, second := <-out, <-out
	if first.Type != protocol.EventTypeTurnStatus || first.TurnStatus != protocol.TurnStateRunning {
		t.Fatalf("first event = %+v, want running lifecycle", first)
	}
	if second.Type != "user_text" || second.Text != "hello opencode" {
		t.Fatalf("second event = %+v, want optimistic echo", second)
	}
	if backend.sentSession != "opencode-initial" || backend.sentContent != "hello opencode" {
		t.Fatalf("backend dispatch = %q/%q", backend.sentSession, backend.sentContent)
	}
}

func TestReviewOpenCodeInitialDispatchErrorPrecedesFailedTurn(t *testing.T) {
	out := make(chan protocol.DaemonEvent, 8)
	sm := NewSessionManager(out)
	dispatchErr := errors.New("opencode initial dispatch failed")
	backend := &reviewInitialBackend{sendErr: dispatchErr}
	sm.sessions["opencode-initial-failure"] = &ProcessState{
		SessionID: "opencode-initial-failure", Agent: "opencode", Source: "daemon",
		Status: protocol.StatusIdle, Backend: backend, ControlMode: protocol.ControlManaged,
	}
	err := sm.SendMessageWithInput(context.Background(), UserMessageInput{
		SessionID: "opencode-initial-failure", Content: "hello opencode",
	})
	if !errors.Is(err, dispatchErr) {
		t.Fatalf("dispatch error = %v, want %v", err, dispatchErr)
	}

	events := drainEvents(out)
	errorIndex, failedIndex := -1, -1
	var errorEvent, failedEvent protocol.DaemonEvent
	for i, event := range events {
		switch {
		case event.Type == "error":
			errorIndex, errorEvent = i, event
		case event.Type == protocol.EventTypeTurnStatus && event.TurnStatus == protocol.TurnStateFailed:
			failedIndex, failedEvent = i, event
		}
	}
	if errorIndex < 0 || failedIndex < 0 {
		t.Fatalf("dispatch failure events = %+v, want attributed error and failed turn", events)
	}
	if errorIndex >= failedIndex {
		t.Fatalf("dispatch failure order = error:%d failed:%d, want error before terminal", errorIndex, failedIndex)
	}
	if errorEvent.TurnID == "" || errorEvent.TurnID != failedEvent.TurnID {
		t.Fatalf("dispatch failure identity = error:%q failed:%q", errorEvent.TurnID, failedEvent.TurnID)
	}
	if errorEvent.Error != dispatchErr.Error() {
		t.Fatalf("error payload = %q, want %q", errorEvent.Error, dispatchErr.Error())
	}
}

// --- review P1-5: completion guard blocks in-flight turns ----------------------

func TestReviewCompletionGuardBlocksInFlightTurn(t *testing.T) {
	sm, _ := newTurnTestManager(t)
	// A completed history turn…
	sm.turns.Start(turn.StartInput{
		Actor:    turn.ActorKey{SessionID: "turn-sess"},
		Identity: turn.Identity{Agent: "claude-code", RequestID: "req-old"},
	})
	key := turn.ActorKey{SessionID: "turn-sess"}
	rec, _ := sm.ActiveTurn("turn-sess")
	if _, err := sm.turns.Terminalize(key, rec.TurnID, protocol.TurnStateCompleted, "", ""); err != nil {
		t.Fatal(err)
	}
	// …then a new turn is in flight: side effects must wait, even though the
	// previous turn completed.
	if _, err := sm.turns.Start(turn.StartInput{
		Actor:    key,
		Identity: turn.Identity{Agent: "claude-code", RequestID: "req-new"},
	}); err != nil {
		t.Fatal(err)
	}
	if sm.turnAllowsCompletionSideEffects("turn-sess") {
		t.Fatal("in-flight turn must block completion side effects")
	}
}
