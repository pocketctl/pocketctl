package watcher

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestSubAgentDiscovererEmitsEvent(t *testing.T) {
	// Construct temp parent session JSONL path + subagents dir + meta.json
	dir := t.TempDir()
	parentJSONL := filepath.Join(dir, "parent-sid.jsonl")
	if err := os.WriteFile(parentJSONL, []byte(`{"type":"user","sessionId":"parent-sid"}`+"\n"), 0644); err != nil {
		t.Fatal(err)
	}
	subDir := filepath.Join(dir, "parent-sid", "subagents")
	if err := os.MkdirAll(subDir, 0755); err != nil {
		t.Fatal(err)
	}
	meta := `{"agentType":"Explore","description":"find foo","toolUseId":"call_xyz"}`
	if err := os.WriteFile(filepath.Join(subDir, "agent-abc.meta.json"), []byte(meta), 0644); err != nil {
		t.Fatal(err)
	}

	outputCh := make(chan protocol.DaemonEvent, 8)
	d := NewSubAgentDiscoverer(parentJSONL, "parent-sid", outputCh, 20*time.Millisecond)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go d.Run(ctx)

	select {
	case ev := <-outputCh:
		if ev.Type != "subagent_discovered" {
			t.Fatalf("type = %q, want subagent_discovered", ev.Type)
		}
		if ev.AgentID != "abc" {
			t.Errorf("AgentID = %q, want abc", ev.AgentID)
		}
		if ev.CallID != "call_xyz" {
			t.Errorf("CallID(toolUseId) = %q, want call_xyz", ev.CallID)
		}
		if ev.SubAgentType != "Explore" {
			t.Errorf("SubAgentType = %q, want Explore", ev.SubAgentType)
		}
		if ev.ParentSessionID != "parent-sid" || !ev.IsSubagent || ev.RootSessionID != "parent-sid" {
			t.Errorf("relation fields wrong: parent=%q isSub=%v root=%q", ev.ParentSessionID, ev.IsSubagent, ev.RootSessionID)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout waiting for subagent_discovered")
	}

	// Second poll: should NOT emit duplicate for the same agent
	select {
	case ev := <-outputCh:
		t.Errorf("expected no duplicate event, got %+v", ev)
	case <-time.After(120 * time.Millisecond):
		// good — no dup
	}
}

// TestSubAgentDiscovererTriggersTailer (I1) is an end-to-end integration test:
// discoverer discovers a child AND starts a SubAgentTailer that emits
// subagent_usage. This test would have caught C1 (tailer never started in production).
func TestSubAgentDiscovererTriggersTailer(t *testing.T) {
	dir := t.TempDir()
	parentJSONL := filepath.Join(dir, "parent-sid.jsonl")
	if err := os.WriteFile(parentJSONL, []byte(`{"type":"user","sessionId":"parent-sid"}`+"\n"), 0644); err != nil {
		t.Fatal(err)
	}
	subDir := filepath.Join(dir, "parent-sid", "subagents")
	if err := os.MkdirAll(subDir, 0755); err != nil {
		t.Fatal(err)
	}
	// meta.json for the child agent
	meta := `{"agentType":"Explore","description":"find foo","toolUseId":"call_xyz"}`
	if err := os.WriteFile(filepath.Join(subDir, "agent-x.meta.json"), []byte(meta), 0644); err != nil {
		t.Fatal(err)
	}
	// child jsonl with ONE usage-bearing assistant line (reads from start for P0)
	childLine := `{"type":"assistant","sessionId":"parent-sid","message":{"role":"assistant","model":"claude-3","content":[{"type":"text","text":"done"}],"usage":{"input_tokens":100,"output_tokens":200,"cache_read_input_tokens":50}}}` + "\n"
	childPath := filepath.Join(subDir, "agent-x.jsonl")
	if err := os.WriteFile(childPath, []byte(childLine), 0644); err != nil {
		t.Fatal(err)
	}

	outputCh := make(chan protocol.DaemonEvent, 16)
	d := NewSubAgentDiscoverer(parentJSONL, "parent-sid", outputCh, 20*time.Millisecond)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go d.Run(ctx)

	// Drain events with a timeout loop: discovery first, then the tailer's first poll emits usage.
	deadline := time.After(3 * time.Second)
	var gotDiscovered, gotUsage bool
loop:
	for {
		select {
		case ev := <-outputCh:
			t.Logf("got event: type=%q agentID=%q sessionID=%q usage=%+v",
				ev.Type, ev.AgentID, ev.SessionID, ev.Usage)
			switch ev.Type {
			case "subagent_discovered":
				gotDiscovered = true
				if ev.AgentID != "x" {
					t.Errorf("discovered AgentID = %q, want x", ev.AgentID)
				}
				if ev.CallID != "call_xyz" {
					t.Errorf("discovered CallID = %q, want call_xyz", ev.CallID)
				}
			case "subagent_usage":
				gotUsage = true
				if ev.AgentID != "x" {
					t.Errorf("usage AgentID = %q, want x", ev.AgentID)
				}
				if ev.Usage == nil || ev.Usage.InputTokens != 100 || ev.Usage.OutputTokens != 200 || ev.Usage.CacheRead != 50 {
					t.Errorf("usage wrong: %+v", ev.Usage)
				}
				if ev.ParentSessionID != "parent-sid" {
					t.Errorf("ParentSessionID = %q, want parent-sid", ev.ParentSessionID)
				}
				// Both events arrived — we're done
				if gotDiscovered {
					break loop
				}
			}
		case <-deadline:
			break loop
		}
	}
	if !gotDiscovered {
		t.Error("expected subagent_discovered event within deadline")
	}
	if !gotUsage {
		t.Error("expected subagent_usage event within deadline")
	}
}
