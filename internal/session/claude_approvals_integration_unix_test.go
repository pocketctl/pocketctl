//go:build !windows

package session

import (
	"bufio"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/approval"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestClaudeApprovalTwoClientsFirstWriterWins(t *testing.T) {
	t.Setenv("POCKETCTL_CLAUDE_APPROVAL_V2", "1")
	events := make(chan protocol.DaemonEvent, 32)
	sm := NewSessionManager(events)
	sm.sessions["claude-race"] = &ProcessState{
		SessionID: "claude-race",
		Agent:     adapter.AgentClaude,
		Source:    "daemon",
		Status:    protocol.StatusRunning,
	}

	socketDir, err := os.MkdirTemp("", "pcar")
	if err != nil {
		t.Fatalf("temp socket dir: %v", err)
	}
	defer os.RemoveAll(socketDir)
	socketPath := filepath.Join(socketDir, "approval.sock")
	server := approval.NewServer(socketPath, nil)
	sm.SetApprovalServer(server, "pocketctl")
	if err := server.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer server.Close()

	conn, err := net.Dial("unix", socketPath)
	if err != nil {
		t.Fatalf("dial approval socket: %v", err)
	}
	defer conn.Close()
	payload, _ := json.Marshal(map[string]any{
		"session_id": "claude-race",
		"tool":       "Bash",
		"input":      map[string]any{"command": "true"},
		"perm_mode":  "default",
	})
	if _, err := conn.Write(append(payload, '\n')); err != nil {
		t.Fatalf("write hook request: %v", err)
	}
	request := waitDaemonEvent(t, events, "approval_request", "")

	start := make(chan struct{})
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for _, approved := range []bool{true, false} {
		wg.Add(1)
		go func(approved bool) {
			defer wg.Done()
			<-start
			results <- sm.ResolveApproval("claude-race", request.RequestID, approved)
		}(approved)
	}
	close(start)
	wg.Wait()
	close(results)

	var success, elsewhere int
	for result := range results {
		if result == nil {
			success++
			continue
		}
		var resolved *ResolvedElsewhereError
		if errors.As(result, &resolved) {
			elsewhere++
			continue
		}
		t.Fatalf("unexpected resolve result: %v", result)
	}
	if success != 1 || elsewhere != 1 {
		t.Fatalf("success=%d resolved_elsewhere=%d", success, elsewhere)
	}

	resolved := waitDaemonEvent(t, events, "approval_resolved", request.RequestID)
	if resolved.RequestID != request.RequestID {
		t.Fatalf("resolved=%#v", resolved)
	}
	var hookResponse map[string]any
	if err := json.NewDecoder(bufio.NewReader(conn)).Decode(&hookResponse); err != nil {
		t.Fatalf("read hook response: %v", err)
	}
	if _, ok := hookResponse["allow"]; !ok {
		t.Fatalf("hook response missing allow: %#v", hookResponse)
	}
	if pending := sm.PendingClaudeApprovals("claude-race"); len(pending) != 0 {
		t.Fatalf("pending after resolution: %#v", pending)
	}
}
