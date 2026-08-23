package session

import (
	"encoding/json"
	"errors"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

type resolvedElsewhereContract interface {
	error
	Code() string
	ResolvedRequestID() string
}

func TestOpenCodeInteractionRaceTerminalResolutionUnblocksInFlightReply(t *testing.T) {
	postStarted := make(chan struct{})
	releasePost := make(chan struct{})
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(releasePost) }) }
	t.Cleanup(release)

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/health":
			_ = json.NewEncoder(w).Encode(map[string]bool{"healthy": true})
		case r.Method == http.MethodPost && r.URL.Path == "/permission/per_race/reply":
			close(postStarted)
			<-releasePost
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodGet && r.URL.Path == "/session/status":
			_ = json.NewEncoder(w).Encode(map[string]any{"ses_1": map[string]any{"type": "idle"}})
		case r.Method == http.MethodGet && r.URL.Path == "/session/ses_1/message":
			_ = json.NewEncoder(w).Encode([]any{})
		default:
			http.NotFound(w, r)
		}
	})

	sm, coord, events := newOpenCodeInteractionRaceManager(t, handler)
	coord.handleInteractionEvent(adapter.SSEEvent{
		ID: "evt_asked", Type: "permission.asked", Directory: "/repo",
		Properties: json.RawMessage(`{"id":"per_race","sessionID":"ses_1","permission":"bash"}`),
	})
	waitDaemonEvent(t, events, "approval_request", "per_race")

	replyDone := make(chan error, 1)
	go func() { replyDone <- sm.ResolveApprovalAction("ses_1", "per_race", "once") }()
	select {
	case <-postStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("remote reply did not reach OpenCode")
	}

	terminalDone := make(chan struct{})
	go func() {
		coord.handleInteractionEvent(adapter.SSEEvent{
			ID: "evt_terminal", Type: "permission.replied", Directory: "/repo",
			Properties: json.RawMessage(`{"sessionID":"ses_1","permissionID":"per_race","response":"always"}`),
		})
		close(terminalDone)
	}()
	select {
	case <-terminalDone:
	case <-time.After(250 * time.Millisecond):
		release()
		<-terminalDone
		<-replyDone
		t.Fatal("terminal resolution blocked behind the in-flight HTTP reply")
	}

	release()
	err := <-replyDone
	assertResolvedElsewhere(t, err, "per_race")
	resolved := waitDaemonEvent(t, events, "approval_resolved", "per_race")
	if resolved.Action != "always" || resolved.Reason != "resolved_elsewhere" {
		t.Fatalf("resolution=%+v", resolved)
	}
	assertNoAdditionalResolution(t, events, "approval_resolved", "per_race")
}

func TestOpenCodeInteractionRaceAuthorityNotPendingConverges(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/health":
			_ = json.NewEncoder(w).Encode(map[string]bool{"healthy": true})
		case r.Method == http.MethodPost && (r.URL.Path == "/permission/per_gone/reply" || r.URL.Path == "/question/que_gone/reply"):
			http.Error(w, "not pending", http.StatusConflict)
		case r.Method == http.MethodGet && (r.URL.Path == "/permission" || r.URL.Path == "/question"):
			_ = json.NewEncoder(w).Encode([]any{})
		case r.Method == http.MethodGet && r.URL.Path == "/session/status":
			_ = json.NewEncoder(w).Encode(map[string]any{"ses_1": map[string]any{"type": "idle"}})
		case r.Method == http.MethodGet && r.URL.Path == "/session/ses_1/message":
			_ = json.NewEncoder(w).Encode([]any{})
		default:
			http.NotFound(w, r)
		}
	})

	sm, coord, events := newOpenCodeInteractionRaceManager(t, handler)
	coord.handleInteractionEvent(adapter.SSEEvent{
		ID: "evt_permission_gone", Type: "permission.asked", Directory: "/repo",
		Properties: json.RawMessage(`{"id":"per_gone","sessionID":"ses_1","permission":"bash"}`),
	})
	coord.handleInteractionEvent(adapter.SSEEvent{
		ID: "evt_question_gone", Type: "question.asked", Directory: "/repo",
		Properties: json.RawMessage(`{"id":"que_gone","sessionID":"ses_1","questions":[{"question":"Continue?","options":[{"label":"Yes"}]}]}`),
	})
	waitDaemonEvent(t, events, "approval_request", "per_gone")
	waitDaemonEvent(t, events, "question_request", "que_gone")

	assertResolvedElsewhere(t, sm.ResolveApprovalAction("ses_1", "per_gone", "once"), "per_gone")
	sm.mu.RLock()
	_, permissionPending := sm.sessions["ses_1"].PendingPermissions["per_gone"]
	_, questionPending := sm.sessions["ses_1"].PendingQuestions["que_gone"]
	sm.mu.RUnlock()
	if permissionPending || !questionPending {
		t.Fatalf("parallel state permission=%v question=%v", permissionPending, questionPending)
	}

	assertResolvedElsewhere(t, sm.ResolveQuestion("ses_1", "que_gone", [][]string{{"Yes"}}), "que_gone")
	if event := waitDaemonEvent(t, events, "approval_resolved", "per_gone"); event.Reason != "resolved_elsewhere" {
		t.Fatalf("permission resolution=%+v", event)
	}
	if event := waitDaemonEvent(t, events, "question_resolved", "que_gone"); event.Reason != "resolved_elsewhere" {
		t.Fatalf("question resolution=%+v", event)
	}
}

func TestOpenCodeInteractionRaceLateRemoteQuestionReplyIsIdempotent(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/health":
			_ = json.NewEncoder(w).Encode(map[string]bool{"healthy": true})
		case r.Method == http.MethodGet && r.URL.Path == "/session/status":
			_ = json.NewEncoder(w).Encode(map[string]any{"ses_1": map[string]any{"type": "idle"}})
		case r.Method == http.MethodGet && r.URL.Path == "/session/ses_1/message":
			_ = json.NewEncoder(w).Encode([]any{})
		default:
			http.NotFound(w, r)
		}
	})

	sm, coord, events := newOpenCodeInteractionRaceManager(t, handler)
	coord.handleInteractionEvent(adapter.SSEEvent{
		ID: "evt_question_late", Type: "question.asked", Directory: "/repo",
		Properties: json.RawMessage(`{"id":"que_late","sessionID":"ses_1","questions":[{"question":"Continue?","options":[{"label":"Yes"}]}]}`),
	})
	waitDaemonEvent(t, events, "question_request", "que_late")
	coord.handleInteractionEvent(adapter.SSEEvent{
		ID: "evt_question_late_answer", Type: "question.replied", Directory: "/repo",
		Properties: json.RawMessage(`{"sessionID":"ses_1","requestID":"que_late","answers":[["Yes"]]}`),
	})
	waitDaemonEvent(t, events, "question_resolved", "que_late")

	assertResolvedElsewhere(t, sm.ResolveQuestion("ses_1", "que_late", [][]string{{"Yes"}}), "que_late")
}

func TestOpenCodeInteractionRaceTerminalQuestionResolutionUnblocksInFlightReject(t *testing.T) {
	postStarted := make(chan struct{})
	releasePost := make(chan struct{})
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(releasePost) }) }
	t.Cleanup(release)
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/health":
			_ = json.NewEncoder(w).Encode(map[string]bool{"healthy": true})
		case r.Method == http.MethodPost && r.URL.Path == "/question/que_reject_race/reject":
			close(postStarted)
			<-releasePost
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodGet && r.URL.Path == "/session/status":
			_ = json.NewEncoder(w).Encode(map[string]any{"ses_1": map[string]any{"type": "idle"}})
		case r.Method == http.MethodGet && r.URL.Path == "/session/ses_1/message":
			_ = json.NewEncoder(w).Encode([]any{})
		default:
			http.NotFound(w, r)
		}
	})

	sm, coord, events := newOpenCodeInteractionRaceManager(t, handler)
	coord.handleInteractionEvent(adapter.SSEEvent{
		ID: "evt_question_reject_race", Type: "question.asked", Directory: "/repo",
		Properties: json.RawMessage(`{"id":"que_reject_race","sessionID":"ses_1","questions":[{"question":"Continue?"}]}`),
	})
	waitDaemonEvent(t, events, "question_request", "que_reject_race")

	rejectDone := make(chan error, 1)
	go func() { rejectDone <- sm.RejectQuestion("ses_1", "que_reject_race") }()
	select {
	case <-postStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("remote rejection did not reach OpenCode")
	}
	terminalDone := make(chan struct{})
	go func() {
		coord.handleInteractionEvent(adapter.SSEEvent{
			ID: "evt_terminal_question", Type: "question.replied", Directory: "/repo",
			Properties: json.RawMessage(`{"sessionID":"ses_1","requestID":"que_reject_race","answers":[["Yes"]]}`),
		})
		close(terminalDone)
	}()
	select {
	case <-terminalDone:
	case <-time.After(250 * time.Millisecond):
		release()
		<-terminalDone
		<-rejectDone
		t.Fatal("terminal question resolution blocked behind the in-flight reject")
	}
	release()
	assertResolvedElsewhere(t, <-rejectDone, "que_reject_race")
	resolved := waitDaemonEvent(t, events, "question_resolved", "que_reject_race")
	if resolved.Rejected || resolved.Reason != "resolved_elsewhere" {
		t.Fatalf("resolution=%+v", resolved)
	}
	assertNoAdditionalResolution(t, events, "question_resolved", "que_reject_race")
}

func TestOpenCodeInteractionRaceConcurrentRemoteClientsConverge(t *testing.T) {
	var postCount atomic.Int32
	bothStarted := make(chan struct{})
	var authorityMu sync.Mutex
	authorityPending := true
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/health":
			_ = json.NewEncoder(w).Encode(map[string]bool{"healthy": true})
		case r.Method == http.MethodPost && r.URL.Path == "/permission/per_clients/reply":
			if postCount.Add(1) == 2 {
				close(bothStarted)
			}
			select {
			case <-bothStarted:
			case <-r.Context().Done():
				return
			}
			authorityMu.Lock()
			won := authorityPending
			if won {
				authorityPending = false
			}
			authorityMu.Unlock()
			if won {
				w.WriteHeader(http.StatusNoContent)
			} else {
				http.Error(w, "not pending", http.StatusConflict)
			}
		case r.Method == http.MethodGet && r.URL.Path == "/permission":
			authorityMu.Lock()
			pending := authorityPending
			authorityMu.Unlock()
			if pending {
				_ = json.NewEncoder(w).Encode([]map[string]any{{"id": "per_clients", "sessionID": "ses_1", "permission": "bash"}})
			} else {
				_ = json.NewEncoder(w).Encode([]any{})
			}
		case r.Method == http.MethodGet && r.URL.Path == "/session/status":
			_ = json.NewEncoder(w).Encode(map[string]any{"ses_1": map[string]any{"type": "idle"}})
		case r.Method == http.MethodGet && r.URL.Path == "/session/ses_1/message":
			_ = json.NewEncoder(w).Encode([]any{})
		default:
			http.NotFound(w, r)
		}
	})

	sm, coord, events := newOpenCodeInteractionRaceManager(t, handler)
	coord.handleInteractionEvent(adapter.SSEEvent{
		ID: "evt_clients", Type: "permission.asked", Directory: "/repo",
		Properties: json.RawMessage(`{"id":"per_clients","sessionID":"ses_1","permission":"bash"}`),
	})
	waitDaemonEvent(t, events, "approval_request", "per_clients")

	results := make(chan error, 2)
	go func() { results <- sm.ResolveApprovalAction("ses_1", "per_clients", "once") }()
	go func() { results <- sm.ResolveApprovalAction("ses_1", "per_clients", "always") }()
	for range 2 {
		err := <-results
		if err == nil {
			continue
		}
		var resolved resolvedElsewhereContract
		if !errors.As(err, &resolved) || resolved.Code() != InteractionResolvedElsewhere {
			t.Fatalf("concurrent reply returned real failure: %T %v", err, err)
		}
	}
	if postCount.Load() != 2 {
		t.Fatalf("authority posts=%d, want 2", postCount.Load())
	}
	waitDaemonEvent(t, events, "approval_resolved", "per_clients")
	assertNoAdditionalResolution(t, events, "approval_resolved", "per_clients")
}

func TestOpenCodeInteractionRaceWebSuccessThenSSEDuplicate(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/health":
			_ = json.NewEncoder(w).Encode(map[string]bool{"healthy": true})
		case r.Method == http.MethodPost && r.URL.Path == "/permission/per_web/reply":
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodGet && r.URL.Path == "/session/status":
			_ = json.NewEncoder(w).Encode(map[string]any{"ses_1": map[string]any{"type": "idle"}})
		case r.Method == http.MethodGet && r.URL.Path == "/session/ses_1/message":
			_ = json.NewEncoder(w).Encode([]any{})
		default:
			http.NotFound(w, r)
		}
	})
	sm, coord, events := newOpenCodeInteractionRaceManager(t, handler)
	coord.handleInteractionEvent(adapter.SSEEvent{
		ID: "evt_web_asked", Type: "permission.asked", Directory: "/repo",
		Properties: json.RawMessage(`{"id":"per_web","sessionID":"ses_1","permission":"bash"}`),
	})
	waitDaemonEvent(t, events, "approval_request", "per_web")
	if err := sm.ResolveApprovalAction("ses_1", "per_web", "once"); err != nil {
		t.Fatal(err)
	}
	waitDaemonEvent(t, events, "approval_resolved", "per_web")
	coord.handleInteractionEvent(adapter.SSEEvent{
		ID: "evt_web_duplicate", Type: "permission.replied", Directory: "/repo",
		Properties: json.RawMessage(`{"sessionID":"ses_1","permissionID":"per_web","response":"once"}`),
	})
	assertNoAdditionalResolution(t, events, "approval_resolved", "per_web")
}

func TestOpenCodeInteractionRaceSnapshotDiscoversTerminalCompletion(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/health":
			_ = json.NewEncoder(w).Encode(map[string]bool{"healthy": true})
		case r.Method == http.MethodGet && (r.URL.Path == "/permission" || r.URL.Path == "/question" || r.URL.Path == "/api/session/ses_1/permission" || r.URL.Path == "/api/session/ses_1/question"):
			_ = json.NewEncoder(w).Encode([]any{})
		case r.Method == http.MethodGet && r.URL.Path == "/session/status":
			_ = json.NewEncoder(w).Encode(map[string]any{"ses_1": map[string]any{"type": "idle"}})
		case r.Method == http.MethodGet && r.URL.Path == "/session/ses_1/message":
			_ = json.NewEncoder(w).Encode([]any{})
		default:
			http.NotFound(w, r)
		}
	})
	_, coord, events := newOpenCodeInteractionRaceManager(t, handler)
	coord.handleInteractionEvent(adapter.SSEEvent{
		ID: "evt_snapshot_asked", Type: "permission.asked", Directory: "/repo",
		Properties: json.RawMessage(`{"id":"per_snapshot","sessionID":"ses_1","permission":"bash"}`),
	})
	waitDaemonEvent(t, events, "approval_request", "per_snapshot")
	coord.reconcileSessionInteractions(t.Context(), "ses_1")
	resolved := waitDaemonEvent(t, events, "approval_resolved", "per_snapshot")
	if resolved.Reason != "no_longer_pending" {
		t.Fatalf("snapshot resolution=%+v", resolved)
	}
	assertNoAdditionalResolution(t, events, "approval_resolved", "per_snapshot")
}

func newOpenCodeInteractionRaceManager(t *testing.T, handler http.Handler) (*SessionManager, *opencodeCoordinator, chan protocol.DaemonEvent) {
	t.Helper()
	server := startFakeOpenCodeServer(t, handler)
	events := make(chan protocol.DaemonEvent, 32)
	sm := NewSessionManager(events)
	coord := newOpencodeCoordinator(sm)
	coord.server = server
	coord.started = true
	backend := &serverBackend{coord: coord}
	sm.opencode = coord
	sm.sessions["ses_1"] = &ProcessState{
		SessionID: "ses_1", Agent: adapter.AgentOpencode, ControlMode: protocol.ControlManaged,
		Status: protocol.StatusIdle, Cwd: "/repo", Backend: backend,
		PendingPermissions: make(map[string]PendingOpenCodePermission),
		PendingQuestions:   make(map[string]PendingOpenCodeQuestion),
	}
	coord.tracked["ses_1"] = func() {}
	return sm, coord, events
}

func assertResolvedElsewhere(t *testing.T, err error, requestID string) {
	t.Helper()
	var resolved resolvedElsewhereContract
	if !errors.As(err, &resolved) {
		t.Fatalf("error=%T %v, want typed resolved_elsewhere", err, err)
	}
	if resolved.Code() != "resolved_elsewhere" || resolved.ResolvedRequestID() != requestID {
		t.Fatalf("resolved code=%q request=%q", resolved.Code(), resolved.ResolvedRequestID())
	}
}

func assertNoAdditionalResolution(t *testing.T, events <-chan protocol.DaemonEvent, eventType, requestID string) {
	t.Helper()
	timer := time.NewTimer(100 * time.Millisecond)
	defer timer.Stop()
	for {
		select {
		case event := <-events:
			if event.Type == eventType && event.RequestID == requestID {
				t.Fatalf("duplicate resolution=%+v", event)
			}
		case <-timer.C:
			return
		}
	}
}
