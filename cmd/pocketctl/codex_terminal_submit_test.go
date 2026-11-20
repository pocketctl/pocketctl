package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/session"
)

func TestCodexTerminalSubmitRejectsPipedInput(t *testing.T) {
	in, out, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer in.Close()
	defer out.Close()
	err = runCodexTerminalSubmit([]string{"thread"}, in, io.Discard, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "interactive terminal") {
		t.Fatal(err)
	}
}

func TestCodexTerminalSubmitRelayProtocol(t *testing.T) {
	for _, scenario := range []string{"accepted", "observer", "rejected", "ack without proof"} {
		t.Run(scenario, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer test-token" || r.URL.RequestURI() != "/ws?type=client" {
					t.Errorf("invalid client authentication")
					return
				}
				up := websocket.Upgrader{}
				c, err := up.Upgrade(w, r, nil)
				if err != nil {
					t.Error(err)
					return
				}
				defer c.Close()
				var meta, cmd protocol.ClientMessage
				if err := c.ReadJSON(&meta); err != nil || meta.Type != "get_session_meta" || meta.SessionID != "thread" {
					t.Errorf("missing capability probe")
					return
				}
				ev := protocol.DaemonEvent{Type: "session_meta", SessionID: "thread", RequestID: meta.RequestID, ControlMode: protocol.ControlManaged}
				if scenario != "observer" {
					ev.Capabilities = []string{session.CodexTerminalSubmitCapability}
				}
				if err := c.WriteJSON(ev); err != nil {
					t.Error(err)
					return
				}
				if scenario == "observer" {
					if err := c.ReadJSON(&cmd); err == nil {
						t.Error("sent input to observer")
					}
					return
				}
				if err := c.ReadJSON(&cmd); err != nil || cmd.Type != "user_message" || cmd.SessionID != "thread" || !cmd.TerminalSubmit || cmd.RequestID != "terminal-id" || cmd.MsgID == "" || cmd.Content != "typed" {
					t.Errorf("invalid submission")
					return
				}
				_ = c.WriteJSON(map[string]any{"type": "quota_status", "plan": "free"})
				ev = protocol.DaemonEvent{Type: "user_message_ack", SessionID: cmd.SessionID, RequestID: cmd.RequestID, MsgID: cmd.MsgID}
				if err := c.WriteJSON(ev); err != nil {
					t.Error(err)
					return
				}
				if scenario == "rejected" {
					ev.Type = "user_message_receipt"
					ev.Status = "rejected"
					ev.Reason = "session_busy"
					_ = c.WriteJSON(ev)
					return
				}
				ev.Type = "user_text"
				ev.EventID = "native-input:" + cmd.MsgID
				ev.TurnID = "logical"
				ev.SourceTurnID = "native"
				_ = c.WriteJSON(ev) // a user-looking echo never establishes acceptance on its own
				if scenario == "ack without proof" {
					return
				}
				inputID := protocol.MemoryInputEventID(cmd.SessionID, cmd.RequestID, cmd.MsgID)
				ev.MemorySource = &protocol.MemorySourceProvenance{Version: 1, Producer: "codex", SourceRole: "user", SessionID: "thread", TurnID: "logical", EventID: inputID, InvocationID: inputID, LineageComplete: true, SkillState: "non_skill"}
				_ = c.WriteJSON(ev)
			}))
			defer server.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			turn, err := submitCodexTerminalMessage(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), "test-token", "thread", "typed", "terminal-id")
			if scenario == "accepted" {
				if err != nil || turn != "native" {
					t.Fatalf("turn=%q err=%v", turn, err)
				}
			} else if err == nil {
				t.Fatal("unconfirmed submission accepted")
			}
		})
	}
}
