package watcher

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestSubAgentTailerCodexStampsRootAndAgent(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "rollout-child.jsonl")
	lines := `{"type":"session_meta","payload":{"id":"child","session_id":"root","thread_source":"subagent"}}` + "\n" +
		`{"type":"event_msg","payload":{"type":"user_message","message":"inspect this"}}` + "\n" +
		`{"type":"event_msg","payload":{"type":"agent_message","message":"done"}}` + "\n"
	if err := os.WriteFile(path, []byte(lines), 0o644); err != nil {
		t.Fatal(err)
	}

	tailer, err := NewSubAgentTailerForAgent(path, "child", "root", adapter.AgentCodex, adapter.AgentCodex)
	if err != nil {
		t.Fatal(err)
	}
	defer tailer.tailer.Close()
	events, err := tailer.TailNewLines()
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 {
		t.Fatalf("events = %+v", events)
	}
	for _, event := range events {
		if event.SessionID != "root" || event.ParentSessionID != "root" || event.RootSessionID != "root" ||
			event.AgentID != "child" || !event.IsSubagent {
			t.Fatalf("unstamped event: %+v", event)
		}
	}
}

func TestSubAgentTailerCodexEmitsUsage(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "rollout-child.jsonl")
	line := `{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"cached_input_tokens":50,"output_tokens":20}}}}` + "\n"
	if err := os.WriteFile(path, []byte(line), 0o644); err != nil {
		t.Fatal(err)
	}

	tailer, err := NewSubAgentTailerForAgent(path, "child", "root", adapter.AgentCodex, adapter.AgentCodex)
	if err != nil {
		t.Fatal(err)
	}
	outputCh := make(chan protocol.DaemonEvent, 8)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go tailer.Run(ctx, outputCh)

	deadline := time.After(2 * time.Second)
	for {
		select {
		case event := <-outputCh:
			if event.Type != "subagent_usage" {
				continue
			}
			if event.SessionID != "root" || event.ParentSessionID != "root" || event.RootSessionID != "root" ||
				event.AgentID != "child" || !event.IsSubagent || event.Usage == nil ||
				event.Usage.InputTokens != 100 || event.Usage.OutputTokens != 20 || event.Usage.CacheRead != 50 {
				t.Fatalf("usage event = %+v", event)
			}
			return
		case <-deadline:
			t.Fatal("timed out waiting for Codex subagent_usage")
		}
	}
}

func TestSubAgentTailerCodexDoesNotCompleteParentSession(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "rollout-child.jsonl")
	line := `{"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"done"}}` + "\n"
	if err := os.WriteFile(path, []byte(line), 0o644); err != nil {
		t.Fatal(err)
	}

	tailer, err := NewSubAgentTailerForAgent(path, "child", "root", adapter.AgentCodex, adapter.AgentCodex)
	if err != nil {
		t.Fatal(err)
	}
	defer tailer.tailer.Close()
	events, err := tailer.TailNewLines()
	if err != nil {
		t.Fatal(err)
	}
	for _, event := range events {
		if event.Type == "session_status" {
			t.Fatalf("child status must not mutate parent session: %+v", event)
		}
	}
}

func TestSubAgentTailerCodexEventIDsAreStableAndDistinct(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "rollout-child.jsonl")
	line := `{"type":"event_msg","payload":{"type":"agent_message","message":"same"}}` + "\n"
	if err := os.WriteFile(path, []byte(line+line), 0o644); err != nil {
		t.Fatal(err)
	}

	readIDs := func() []string {
		tailer, err := NewSubAgentTailerForAgent(path, "child", "root", adapter.AgentCodex, adapter.AgentCodex)
		if err != nil {
			t.Fatal(err)
		}
		defer tailer.tailer.Close()
		events, err := tailer.TailNewLines()
		if err != nil {
			t.Fatal(err)
		}
		if len(events) != 2 {
			t.Fatalf("events = %+v", events)
		}
		return []string{events[0].EventID, events[1].EventID}
	}

	first := readIDs()
	second := readIDs()
	if first[0] == "" || first[1] == "" || first[0] == first[1] {
		t.Fatalf("event IDs must be non-empty and distinct: %v", first)
	}
	if first[0] != second[0] || first[1] != second[1] {
		t.Fatalf("event IDs changed across restart: %v vs %v", first, second)
	}
}

func TestCodexReplaySubAgentTailerFiltersNativeTimestampsAndKeepsStableIDs(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "rollout-child.jsonl")
	cutoff := time.Date(2026, time.July, 29, 2, 0, 0, 0, time.UTC)
	lines := []string{
		`{"timestamp":"2026-07-29T01:59:59Z","type":"event_msg","payload":{"type":"agent_message","message":"old"}}`,
		`{"timestamp":"2026-07-29T02:00:01Z","type":"event_msg","payload":{"type":"agent_message","message":"recent"}}`,
		`{"type":"event_msg","payload":{"type":"agent_message","message":"timestamp-missing"}}`,
	}
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	tailer, err := NewCodexReplaySubAgentTailer(path, "child", "root", adapter.AgentCodex, cutoff, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer tailer.tailer.Close()
	events, err := tailer.TailNewLines()
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 || events[0].Text != "recent" || events[1].Text != "timestamp-missing" {
		t.Fatalf("events = %+v", events)
	}
	for _, event := range events {
		if event.EventID == "" || !event.Resync {
			t.Fatalf("replay event missing stable identity/priority marker: %+v", event)
		}
	}
	if !strings.Contains(events[0].EventID, ":1:0") || !strings.Contains(events[1].EventID, ":2:0") {
		t.Fatalf("event IDs lost source line indexes: %q %q", events[0].EventID, events[1].EventID)
	}
}

func TestRegularFromStartTailerDoesNotAddStableEventID(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "rollout-main.jsonl")
	line := `{"type":"event_msg","payload":{"type":"agent_message","message":"main"}}` + "\n"
	if err := os.WriteFile(path, []byte(line), 0o644); err != nil {
		t.Fatal(err)
	}
	tailer, err := NewJSONLTailerFromStart(path, adapter.AgentCodex)
	if err != nil {
		t.Fatal(err)
	}
	defer tailer.Close()
	events, _, err := tailer.TailNewLines()
	if err != nil || len(events) != 1 {
		t.Fatalf("events=%+v err=%v", events, err)
	}
	if events[0].EventID != "" {
		t.Fatalf("ordinary session gained stable event id: %q", events[0].EventID)
	}
}

func TestSubAgentTailerEmitsUsage(t *testing.T) {
	dir := t.TempDir()
	childPath := filepath.Join(dir, "agent-abc.jsonl")
	// An assistant line with usage (sub-agent jsonl — sessionId is the parent sid).
	line := `{"type":"assistant","sessionId":"parent-sid","message":{"role":"assistant","model":"claude-3","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":100,"output_tokens":200,"cache_read_input_tokens":50}}}` + "\n"
	if err := os.WriteFile(childPath, []byte(line), 0644); err != nil {
		t.Fatal(err)
	}

	tailer, err := NewSubAgentTailer(childPath, "abc", "parent-sid", "Explore")
	if err != nil {
		t.Fatal(err)
	}
	outputCh := make(chan protocol.DaemonEvent, 8)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go tailer.Run(ctx, outputCh)

	// Collect events, expect a subagent_usage event
	deadline := time.After(2 * time.Second)
	var gotUsage bool
loop:
	for {
		select {
		case ev := <-outputCh:
			t.Logf("got event: type=%q agentID=%q sessionID=%q parentSessionID=%q usage=%+v",
				ev.Type, ev.AgentID, ev.SessionID, ev.ParentSessionID, ev.Usage)
			if ev.Type == "subagent_usage" {
				gotUsage = true
				if ev.EventID != "" {
					t.Errorf("Claude usage must keep legacy identity, got %q", ev.EventID)
				}
				if ev.AgentID != "abc" {
					t.Errorf("AgentID = %q, want abc", ev.AgentID)
				}
				if ev.Usage == nil || ev.Usage.InputTokens != 100 || ev.Usage.OutputTokens != 200 || ev.Usage.CacheRead != 50 {
					t.Errorf("usage wrong: %+v", ev.Usage)
				}
				if ev.SessionID != "parent-sid" {
					t.Errorf("SessionID = %q, want parent-sid", ev.SessionID)
				}
				if ev.ParentSessionID != "parent-sid" {
					t.Errorf("ParentSessionID = %q, want parent-sid", ev.ParentSessionID)
				}
				break loop
			}
		case <-deadline:
			break loop
		}
	}
	if !gotUsage {
		t.Fatal("expected subagent_usage event within deadline")
	}
}

func TestSubAgentTailerNoUsageEvent(t *testing.T) {
	// An assistant line WITHOUT usage should NOT produce a subagent_usage event.
	dir := t.TempDir()
	childPath := filepath.Join(dir, "agent-noblock.jsonl")
	line := `{"type":"assistant","sessionId":"parent-sid","message":{"role":"assistant","model":"claude-3","content":[{"type":"text","text":"ok"}]}}` + "\n"
	if err := os.WriteFile(childPath, []byte(line), 0644); err != nil {
		t.Fatal(err)
	}

	tailer, err := NewSubAgentTailer(childPath, "noblock", "parent-sid", "Explore")
	if err != nil {
		t.Fatal(err)
	}
	outputCh := make(chan protocol.DaemonEvent, 8)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go tailer.Run(ctx, outputCh)

	deadline := time.After(2 * time.Second)
loop:
	for {
		select {
		case ev := <-outputCh:
			if ev.Type == "subagent_usage" {
				t.Fatal("unexpected subagent_usage event for line without usage")
			}
		case <-deadline:
			break loop
		}
	}
}
