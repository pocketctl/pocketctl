//go:build !windows

package session

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestZcodeManagedRuntimeVerticalCreateStreamInterruptAndClose(t *testing.T) {
	root := t.TempDir()
	script := filepath.Join(root, "zcode")
	body := "#!/bin/sh\nexec '" + os.Args[0] + "' -test.run='^TestZcodeManagedFakeAppServer$'\n"
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	callLog := filepath.Join(root, "calls.log")
	t.Setenv("POCKETCTL_ZCODE_FAKE_SERVER", "1")
	t.Setenv("POCKETCTL_ZCODE_FAKE_CALL_LOG", callLog)

	output := make(chan protocol.DaemonEvent, 64)
	sm := NewSessionManager(output)
	policy, err := NewCwdPolicy([]string{root})
	if err != nil {
		t.Fatal(err)
	}
	sm.SetCwdPolicy(policy)
	sm.createDeps.resolveAgentCLI = func(protocol.SessionConfig) (string, error) { return script, nil }
	t.Cleanup(func() { _ = sm.ShutdownZcodeManaged() })

	sessionID, err := sm.CreateSession(context.Background(), protocol.SessionConfig{
		Agent:  adapter.AgentZcodeManaged,
		Cwd:    root,
		Force:  true,
		Prompt: "hello",
	})
	if err != nil {
		t.Fatal(err)
	}
	if sessionID != "zses_vertical" {
		t.Fatalf("session id = %q", sessionID)
	}
	textEvent := waitForZcodeEvent(t, output, func(event protocol.DaemonEvent) bool {
		return event.Type == "agent_text" && event.Text == "hello from zcode"
	})
	if textEvent.TurnID == "" || textEvent.TurnID == "turn-vertical" || textEvent.SourceTurnID != "turn-vertical" {
		t.Fatalf("turn identity = logical %q, source %q", textEvent.TurnID, textEvent.SourceTurnID)
	}
	waitForZcodeEvent(t, output, func(event protocol.DaemonEvent) bool {
		return event.Type == "session_status" && event.Status == protocol.StatusIdle
	})

	if err := sm.SendMessageWithInput(context.Background(), UserMessageInput{SessionID: sessionID, Content: "wait"}); err != nil {
		t.Fatal(err)
	}
	waitForZcodeEvent(t, output, func(event protocol.DaemonEvent) bool {
		return event.Type == "session_status" && event.Status == protocol.StatusRunning
	})
	if err := sm.InterruptSession(sessionID); err != nil {
		t.Fatal(err)
	}
	waitForZcodeEvent(t, output, func(event protocol.DaemonEvent) bool {
		return event.Type == protocol.EventTypeTurnStatus && event.TurnStatus == protocol.TurnStateInterrupted
	})
	if err := sm.KillSession(sessionID); err != nil {
		t.Fatal(err)
	}
	if err := sm.ShutdownZcodeManaged(); err != nil {
		t.Fatal(err)
	}

	calls, err := os.ReadFile(callLog)
	if err != nil {
		t.Fatal(err)
	}
	got := string(calls)
	for _, method := range []string{"runtime/capabilities", "session/create", "session/subscribe", "session/send", "session/stop", "session/close"} {
		if !strings.Contains(got, method+"\n") {
			t.Errorf("fake runtime call log missing %s:\n%s", method, got)
		}
	}
}

func waitForZcodeEvent(t *testing.T, events <-chan protocol.DaemonEvent, match func(protocol.DaemonEvent) bool) protocol.DaemonEvent {
	t.Helper()
	timer := time.NewTimer(3 * time.Second)
	defer timer.Stop()
	for {
		select {
		case event := <-events:
			if match(event) {
				return event
			}
		case <-timer.C:
			t.Fatal("timed out waiting for managed ZCode event")
		}
	}
}

func TestZcodeManagedFakeAppServer(t *testing.T) {
	if os.Getenv("POCKETCTL_ZCODE_FAKE_SERVER") != "1" {
		return
	}
	logFile, err := os.OpenFile(os.Getenv("POCKETCTL_ZCODE_FAKE_CALL_LOG"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		os.Exit(2)
	}
	defer logFile.Close()
	encoder := json.NewEncoder(os.Stdout)
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		var request struct {
			ID     json.RawMessage        `json:"id"`
			Method string                 `json:"method"`
			Params map[string]interface{} `json:"params"`
		}
		if json.Unmarshal(scanner.Bytes(), &request) != nil {
			os.Exit(3)
		}
		_, _ = fmt.Fprintln(logFile, request.Method)
		switch request.Method {
		case "runtime/capabilities":
			_ = encoder.Encode(map[string]interface{}{"id": request.ID, "result": map[string]interface{}{}})
		case "session/create":
			_ = encoder.Encode(map[string]interface{}{"id": request.ID, "result": map[string]interface{}{"session": map[string]interface{}{"sessionId": "zses_vertical", "status": "idle"}}})
		case "session/subscribe":
			_ = encoder.Encode(map[string]interface{}{"id": request.ID, "result": map[string]interface{}{"sessionId": "zses_vertical", "eventSeq": 0, "events": []interface{}{}}})
		case "session/send":
			_ = encoder.Encode(map[string]interface{}{"id": request.ID, "result": map[string]interface{}{"accepted": true}})
			_ = encoder.Encode(zcodeFakeEvent("turn.started", map[string]interface{}{}))
			if request.Params["content"] == "hello" {
				_ = encoder.Encode(zcodeFakeEvent("model.streaming", map[string]interface{}{"kind": "text_delta", "assistantMessageId": "msg_1", "partId": "part_1", "delta": "hello from zcode"}))
				_ = encoder.Encode(zcodeFakeEvent("model.streaming", map[string]interface{}{"kind": "text_end", "assistantMessageId": "msg_1", "partId": "part_1"}))
				_ = encoder.Encode(zcodeFakeEvent("turn.completed", map[string]interface{}{"resultType": "success"}))
			}
		case "session/stop":
			_ = encoder.Encode(map[string]interface{}{"id": request.ID, "result": map[string]interface{}{}})
			_ = encoder.Encode(zcodeFakeEvent("turn.completed", map[string]interface{}{"resultType": "cancelled"}))
		case "session/close":
			_ = encoder.Encode(map[string]interface{}{"id": request.ID, "result": map[string]interface{}{}})
		default:
			_ = encoder.Encode(map[string]interface{}{"id": request.ID, "error": map[string]interface{}{"code": -32601, "message": "unknown method"}})
		}
	}
	os.Exit(0)
}

func zcodeFakeEvent(eventType string, payload map[string]interface{}) map[string]interface{} {
	return map[string]interface{}{
		"method": "session/event",
		"params": map[string]interface{}{
			"eventId":   "event-" + eventType,
			"sessionId": "zses_vertical",
			"turnId":    "turn-vertical",
			"type":      eventType,
			"payload":   payload,
		},
	}
}
