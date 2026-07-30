package codexapp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestClientCallNotificationAndServerRequest(t *testing.T) {
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		_, request, err := conn.ReadMessage()
		if err != nil {
			return
		}
		var envelope map[string]json.RawMessage
		_ = json.Unmarshal(request, &envelope)
		if _, found := envelope["jsonrpc"]; found {
			t.Error("wire message must omit jsonrpc header")
		}
		_ = conn.WriteJSON(map[string]any{"id": json.RawMessage(envelope["id"]), "result": map[string]any{"ok": true}})
		_, initialized, err := conn.ReadMessage()
		if err != nil {
			return
		}
		var initializedEnvelope map[string]json.RawMessage
		_ = json.Unmarshal(initialized, &initializedEnvelope)
		if string(initializedEnvelope["method"]) != `"initialized"` || len(initializedEnvelope["id"]) != 0 {
			t.Errorf("initialize handshake missing notification: %s", initialized)
		}
		_ = conn.WriteJSON(map[string]any{"method": "thread/status/changed", "params": map[string]any{"threadId": "thr_1"}})
		_ = conn.WriteJSON(map[string]any{"id": "approval-1", "method": "item/commandExecution/requestApproval", "params": map[string]any{"threadId": "thr_1"}})
		_, response, err := conn.ReadMessage()
		if err == nil && !strings.Contains(string(response), `"id":"approval-1"`) {
			t.Errorf("unexpected server-request response: %s", response)
		}
	}))
	defer server.Close()

	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	client := NewClient(conn)
	defer client.Close()
	var result struct {
		Ok bool `json:"ok"`
	}
	if err := client.Initialize(context.Background(), map[string]any{"clientInfo": map[string]string{"name": "test"}}, &result); err != nil {
		t.Fatal(err)
	}
	if !result.Ok {
		t.Fatalf("result=%+v", result)
	}

	notification := receiveInbound(t, client.Events())
	if notification.Method != "thread/status/changed" || notification.ID != nil {
		t.Fatalf("notification=%+v", notification)
	}
	request := receiveInbound(t, client.Events())
	if request.ID == nil || request.Method != "item/commandExecution/requestApproval" || request.ID.Key() != `s:approval-1` {
		t.Fatalf("request=%+v", request)
	}
	if err := client.Respond(*request.ID, map[string]any{"decision": "decline"}, nil); err != nil {
		t.Fatal(err)
	}
}

func TestClientDisconnectFailsPendingCall(t *testing.T) {
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		_, _, _ = conn.ReadMessage()
		conn.Close()
	}))
	defer server.Close()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	client := NewClient(conn)
	defer client.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := client.Call(ctx, "thread/list", map[string]any{}, &struct{}{}); err == nil {
		t.Fatal("pending call succeeded after disconnect")
	}
}

func TestClientCloseWhileInboundDeliveryIsBlocked(t *testing.T) {
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		for i := 0; i <= 128; i++ {
			if err := conn.WriteJSON(map[string]any{
				"method": "thread/status/changed",
				"params": map[string]any{"sequence": i},
			}); err != nil {
				return
			}
		}
		<-r.Context().Done()
	}))
	defer server.Close()

	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	client := NewClient(conn)
	deadline := time.Now().Add(time.Second)
	for len(client.events) != cap(client.events) && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if got, want := len(client.events), cap(client.events); got != want {
		t.Fatalf("inbound queue length=%d, want %d", got, want)
	}
	if err := client.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-client.Done():
	case <-time.After(time.Second):
		t.Fatal("client did not close")
	}
}

func receiveInbound(t *testing.T, events <-chan Inbound) Inbound {
	t.Helper()
	select {
	case event := <-events:
		return event
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for inbound message")
		return Inbound{}
	}
}
