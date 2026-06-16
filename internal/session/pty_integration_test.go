package session

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

// TestPTYSessionIntegration (interactive-web-session 3.3/9.3) verifies the full
// daemon PTY loop end-to-end: CreateSession spawns an interactive claude under
// PTY (cleaned env + --session-id), the tailer picks up its JSONL output, and a
// plain prompt round-trips to an agent_text response on outputCh.
//
// Skipped under -short. Requires the claude CLI and network access to the model.
func TestPTYSessionIntegration(t *testing.T) {
	if testing.Short() {
		t.Skip("integration test requires live claude CLI")
	}
	outputCh := make(chan protocol.DaemonEvent, 64)
	sm := NewSessionManager(outputCh)

	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Second)
	defer cancel()

	sid, err := sm.CreateSession(ctx, protocol.SessionConfig{
		Agent:  "claude-code",
		Cwd:    "/Users/muwenbin/projects/pocketctl",
		Prompt: "Reply with exactly the word PONG and nothing else.",
	})
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	t.Logf("created daemon PTY session: %s", sid)
	defer sm.KillSession(sid)

	// Drain outputCh looking for an assistant agent_text containing PONG.
	// (CreateSession also emits an early user_text; the tailer forwards claude's
	// JSONL records: assistant text, tool calls, turn_duration → idle.)
	timeout := time.After(140 * time.Second)
	var sawIdle bool
	for {
		select {
		case evt := <-outputCh:
			t.Logf("event: type=%s text=%q status=%s", evt.Type, truncateLog(evt.Text), evt.Status)
			if evt.Type == "agent_text" && strings.Contains(strings.ToUpper(evt.Text), "PONG") {
				t.Logf("PASS: got PONG via PTY → JSONL → tailer → outputCh")
				return
			}
			if evt.Type == "session_status" && evt.Status == protocol.StatusIdle {
				sawIdle = true
			}
		case <-timeout:
			t.Fatalf("timeout waiting for PONG (sawIdle=%v)", sawIdle)
		}
	}
}

func truncateLog(s string) string {
	s = strings.ReplaceAll(s, "\n", " ")
	if len(s) > 120 {
		return s[:120] + "..."
	}
	return s
}
