package sessiondocument

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestCaptureQueueIsNonBlockingBoundedPerSessionAndDeduplicatesPendingCandidates(t *testing.T) {
	started := make(chan string, 2)
	release := make(chan struct{})
	results := make(chan CaptureResult, 2)
	queue := NewCaptureQueue(CaptureQueueOptions{
		MaxDocumentBytes: 100, PerSessionDepth: 1, MaxSessions: 2,
		ResolveRoot: func(string) (string, string) { return "/unused", "" },
		Capture: func(_ string, candidate Candidate, _ int) CaptureResult {
			started <- candidate.SourceEventID
			<-release
			return unavailableResult(candidate, protocol.SessionDocumentReasonReadFailed)
		},
		OnResult: func(result CaptureResult) { results <- result },
	})
	defer queue.Stop()

	first := qualifiedEvent("first.md", protocol.FileChangeCreate)
	second := qualifiedEvent("second.md", protocol.FileChangeUpdate)
	second.EventID = "event-2"
	third := qualifiedEvent("third.md", protocol.FileChangeUpdate)
	third.EventID = "event-3"

	begin := time.Now()
	if !queue.SubmitEvent(first) || time.Since(begin) > 100*time.Millisecond {
		t.Fatal("first submission blocked or was rejected")
	}
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("capture did not start")
	}
	if !queue.SubmitEvent(first) {
		t.Fatal("pending duplicate should converge with the accepted candidate")
	}
	if !queue.SubmitEvent(second) {
		t.Fatal("one queued candidate should fit")
	}
	diagnostics := queue.Diagnostics()
	if diagnostics.QueueDepth != 1 || diagnostics.PendingCandidates != 2 || diagnostics.MaxQueueDepth < 1 {
		t.Fatalf("unexpected queue diagnostics: %+v", diagnostics)
	}
	if queue.SubmitEvent(third) {
		t.Fatal("per-session queue exceeded its bound")
	}
	if diagnostics = queue.Diagnostics(); diagnostics.RejectedBackpressure != 1 {
		t.Fatalf("backpressure rejection not counted: %+v", diagnostics)
	}
	close(release)
	for range 2 {
		select {
		case <-results:
		case <-time.After(time.Second):
			t.Fatal("capture result missing")
		}
	}
	select {
	case extra := <-results:
		t.Fatalf("duplicate produced an extra result: %+v", extra)
	case <-time.After(20 * time.Millisecond):
	}
	if diagnostics = queue.Diagnostics(); diagnostics.QueueDepth != 0 || diagnostics.PendingCandidates != 0 {
		t.Fatalf("queue did not drain: %+v", diagnostics)
	}
}

func TestCaptureQueueFailsClosedWithoutRootAndStopsWorkers(t *testing.T) {
	var mu sync.Mutex
	results := make([]CaptureResult, 0, 1)
	queue := NewCaptureQueue(CaptureQueueOptions{
		MaxDocumentBytes: 100, PerSessionDepth: 2, MaxSessions: 1,
		ResolveRoot: func(string) (string, string) {
			return "", protocol.SessionDocumentReasonPathOutsideRoot
		},
		OnResult: func(result CaptureResult) {
			mu.Lock()
			results = append(results, result)
			mu.Unlock()
		},
	})
	if !queue.SubmitEvent(qualifiedEvent("report.md", protocol.FileChangeUpdate)) {
		t.Fatal("qualified event rejected")
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		count := len(results)
		mu.Unlock()
		if count == 1 {
			break
		}
		time.Sleep(time.Millisecond)
	}
	queue.Stop()
	queue.Stop()
	if queue.SubmitEvent(qualifiedEvent("later.md", protocol.FileChangeCreate)) {
		t.Fatal("stopped queue accepted work")
	}
	mu.Lock()
	defer mu.Unlock()
	if len(results) != 1 || results[0].Reason != protocol.SessionDocumentReasonPathOutsideRoot || len(results[0].Bytes) != 0 {
		t.Fatalf("unexpected unavailable result: %+v", results)
	}
}

func TestCaptureQueueIgnoresUntrustedProducerShapes(t *testing.T) {
	queue := NewCaptureQueue(CaptureQueueOptions{
		MaxDocumentBytes: 100, PerSessionDepth: 1, MaxSessions: 1,
		ResolveRoot: func(string) (string, string) { return t.TempDir(), "" },
		OnResult:    func(CaptureResult) { t.Error("untrusted event triggered capture") },
	})
	defer queue.Stop()

	events := []protocol.DaemonEvent{
		{Type: "tool_result", Output: "wrote secret.md"},
		{Type: "agent_text", Text: "created secret.md"},
		{Type: "tool_result", URL: "file:///tmp/secret.md"},
		{Type: "agent_file_change", SessionID: "s", TurnID: "t", ChangeSetID: "c", EventID: "e", Status: "completed", ChangeKind: protocol.FileChangeDelete, Path: "secret.md"},
		{Type: "agent_file_change", SessionID: "s", TurnID: "t", ChangeSetID: "c", EventID: "e", Status: "completed", ChangeKind: protocol.FileChangeUpdate, Path: "secret.md", Source: "observer", Agent: "zcode"},
	}
	for _, event := range events {
		if queue.SubmitEvent(event) {
			t.Fatalf("untrusted event accepted: %+v", event)
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	<-ctx.Done()
}
