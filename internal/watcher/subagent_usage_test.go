package watcher

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

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
