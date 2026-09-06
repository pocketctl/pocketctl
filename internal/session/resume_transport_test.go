package session

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/protocol"
	wsclient "github.com/pocketctl/pocketctl/internal/ws"
)

func TestRelaySocketReconnectDoesNotCancelOwnedResume(t *testing.T) {
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	var connections atomic.Int32
	reconnected := make(chan struct{}, 1)
	closeNow := make(chan struct{})
	serverShutdown := make(chan struct{})
	var closeOnce sync.Once
	t.Cleanup(func() { closeOnce.Do(func() { close(closeNow) }) })
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		_, _, err = conn.ReadMessage() // daemon register
		if err != nil {
			return
		}
		_ = conn.WriteJSON(protocol.RegisterAckMessage{Type: "register_ack", Status: "ok"})
		if connections.Add(1) == 1 {
			_ = conn.WriteJSON(protocol.ClientMessage{
				Type: "user_message", SessionID: "transport-resume", Content: "fixture input",
				RequestID: "req-transport", MsgID: "msg-transport",
			})
			<-closeNow
			_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseGoingAway, "fixture disconnect"), time.Now().Add(time.Second))
			return
		}
		select {
		case reconnected <- struct{}{}:
		case <-serverShutdown:
			return
		}
		<-serverShutdown
	}))
	defer server.Close()
	defer close(serverShutdown)

	daemonCtx, stopDaemon := context.WithCancel(context.Background())
	defer stopDaemon()
	transportOutput := make(chan protocol.DaemonEvent, 8)
	client := wsclient.NewClient(strings.Replace(server.URL, "http://", "ws://", 1), "token", "daemon-transport", []string{adapter.AgentClaude}, nil, nil, transportOutput, slog.New(slog.NewTextHandler(io.Discard, nil)))
	go func() { _ = client.Run(daemonCtx) }()

	sessionOutput := make(chan protocol.DaemonEvent, 32)
	sm := NewSessionManager(sessionOutput)
	sm.RegisterTerminalSession("transport-resume", t.TempDir(), os.Getpid(), "/dev/ttys-fixture", protocol.StatusIdle, adapter.AgentClaude)
	installSentinelResumeCLI(t, "claude")
	proc := newFakeResumeProcess(43001, "")
	launchCanceled := make(chan error, 1)
	sm.setResumeStarter(func(ctx context.Context, _ resumeLaunchSpec) (resumeProcess, error) {
		go func() {
			<-ctx.Done()
			cause := ctx.Err()
			launchCanceled <- cause
			proc.release(cause)
		}()
		return proc, nil
	})

	var command protocol.ClientMessage
	select {
	case command = <-client.CommandCh:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for loopback user_message")
	}
	if err := sm.SendMessageWithInput(daemonCtx, UserMessageInput{
		SessionID: command.SessionID, Content: command.Content, RequestID: command.RequestID, MsgID: command.MsgID,
	}); err != nil {
		t.Fatal(err)
	}
	ownedBeforeClose := sm.ownedResumeForSession(command.SessionID)
	if ownedBeforeClose == nil || ownedBeforeClose.process != proc {
		t.Fatal("dispatch returned before the expected fake child was attached")
	}
	closeOnce.Do(func() { close(closeNow) })
	select {
	case <-reconnected:
	case <-time.After(3 * time.Second):
		t.Fatal("real ws.Client did not reconnect after loopback close")
	}
	if ownedAfterReconnect := sm.ownedResumeForSession(command.SessionID); ownedAfterReconnect != ownedBeforeClose || ownedAfterReconnect.process != proc {
		t.Fatal("transport disconnect removed the daemon-owned resume")
	}
	select {
	case cause := <-launchCanceled:
		t.Fatalf("transport disconnect canceled the child context: %v", cause)
	default:
	}
	select {
	case <-proc.killed:
		t.Fatal("transport disconnect killed the child")
	default:
	}
	assertNoExecutionFailure(t, sessionOutput)

	if err := sm.KillSession(command.SessionID); err != nil {
		t.Fatal(err)
	}
	select {
	case cause := <-launchCanceled:
		if cause != context.Canceled {
			t.Fatalf("explicit cancellation cause=%v, want context.Canceled", cause)
		}
	case <-time.After(time.Second):
		t.Fatal("explicit KillSession did not cancel the child context")
	}
	waitForKilledWithoutExecutionFailure(t, sessionOutput)
}

func assertNoExecutionFailure(t *testing.T, events <-chan protocol.DaemonEvent) {
	t.Helper()
	for {
		select {
		case event := <-events:
			if event.Type == "error" && event.Operation == "user_message" && event.Reason == "execution_failed" {
				t.Fatalf("unexpected execution failure: %+v", event)
			}
		default:
			return
		}
	}
}

func waitForKilledWithoutExecutionFailure(t *testing.T, events <-chan protocol.DaemonEvent) {
	t.Helper()
	deadline := time.NewTimer(time.Second)
	defer deadline.Stop()
	for {
		select {
		case event := <-events:
			if event.Type == "error" && event.Operation == "user_message" && event.Reason == "execution_failed" {
				t.Fatalf("explicit cancellation published execution failure: %+v", event)
			}
			if event.Type == "session_status" && event.Status == protocol.StatusKilled {
				// sendToIdleTerminal publishes failure (if any) before this terminal
				// status, so observing killed crosses the asynchronous publisher.
				return
			}
		case <-deadline.C:
			t.Fatal("timed out waiting for killed terminal status")
		}
	}
}
