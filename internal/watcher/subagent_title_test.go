package watcher

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestSubAgentTailerEmitsTitleRequest(t *testing.T) {
	dir := t.TempDir()
	childPath := filepath.Join(dir, "agent-abc.jsonl")
	// First user message = sub-agent task prompt
	line := `{"type":"user","sessionId":"parent-sid","message":{"role":"user","content":"Review docker-compose.prod.yml for security vulnerabilities"}}` + "\n"
	if err := os.WriteFile(childPath, []byte(line), 0644); err != nil {
		t.Fatal(err)
	}

	tailer, err := NewSubAgentTailer(childPath, "abc", "parent-sid", "security-review")
	if err != nil {
		t.Fatal(err)
	}
	outputCh := make(chan protocol.DaemonEvent, 8)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go tailer.Run(ctx, outputCh)

	deadline := time.After(2 * time.Second)
	var gotTitleReq bool
loop:
	for {
		select {
		case ev := <-outputCh:
			if ev.Type == "generate_subagent_title_request" {
				gotTitleReq = true
				if ev.AgentID != "abc" {
					t.Errorf("AgentID=%q want abc", ev.AgentID)
				}
				if ev.ParentSessionID != "parent-sid" {
					t.Errorf("ParentSessionID=%q want parent-sid", ev.ParentSessionID)
				}
				if ev.SubAgentType != "security-review" {
					t.Errorf("SubAgentType=%q want security-review", ev.SubAgentType)
				}
				if ev.UserMessage == "" {
					t.Error("UserMessage empty")
				}
				if ev.SessionID != "parent-sid" {
					t.Errorf("SessionID=%q want parent-sid", ev.SessionID)
				}
				break loop
			}
		case <-deadline:
			break loop
		}
	}
	if !gotTitleReq {
		t.Fatal("expected generate_subagent_title_request event")
	}
}

func TestSubAgentTailerTitleRequestOnlyOnce(t *testing.T) {
	dir := t.TempDir()
	childPath := filepath.Join(dir, "agent-abc.jsonl")
	// Two user lines — only the first should trigger a title request
	line1 := `{"type":"user","sessionId":"parent-sid","message":{"role":"user","content":"First task"}}` + "\n"
	line2 := `{"type":"user","sessionId":"parent-sid","message":{"role":"user","content":"Second task"}}` + "\n"
	if err := os.WriteFile(childPath, []byte(line1+line2), 0644); err != nil {
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

	deadline := time.After(2 * time.Second)
	var titleCount int
loop:
	for {
		select {
		case ev := <-outputCh:
			if ev.Type == "generate_subagent_title_request" {
				titleCount++
				if ev.UserMessage != "First task" {
					t.Errorf("UserMessage=%q want 'First task'", ev.UserMessage)
				}
				if titleCount > 1 {
					t.Error("title request emitted more than once")
					break loop
				}
			}
		case <-deadline:
			break loop
		}
	}
	if titleCount != 1 {
		t.Fatalf("expected exactly 1 title request, got %d", titleCount)
	}
}

func TestCodexReplayTitleRequestKeepsStableIdentityAndReplayPriority(t *testing.T) {
	dir := t.TempDir()
	childPath := filepath.Join(dir, "rollout-child.jsonl")
	line := `{"timestamp":"2026-07-29T03:00:00Z","type":"event_msg","payload":{"type":"user_message","message":"Replay this task"}}` + "\n"
	if err := os.WriteFile(childPath, []byte(line), 0o644); err != nil {
		t.Fatal(err)
	}
	tailer, err := NewCodexReplaySubAgentTailer(
		childPath, "child", "root", adapter.AgentCodex,
		time.Date(2026, time.July, 29, 2, 0, 0, 0, time.UTC), 0,
	)
	if err != nil {
		t.Fatal(err)
	}
	outputCh := make(chan protocol.DaemonEvent, 4)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go tailer.Run(ctx, outputCh)

	deadline := time.After(2 * time.Second)
	var sourceID string
	for {
		select {
		case event := <-outputCh:
			switch event.Type {
			case "user_text":
				sourceID = event.EventID
			case "generate_subagent_title_request":
				if sourceID == "" || event.EventID != sourceID+":title" || !event.Resync {
					t.Fatalf("title request = %+v, source ID = %q", event, sourceID)
				}
				return
			}
		case <-deadline:
			t.Fatal("timed out waiting for Codex replay title request")
		}
	}
}
