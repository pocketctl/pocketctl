package zcodeapp

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net"
	"strings"
	"testing"
	"time"
)

func TestClientCallNotificationAndReverseRequest(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	client := NewClient(clientConn, clientConn, clientConn.Close)
	t.Cleanup(func() { _ = client.Close() })

	serverDone := make(chan error, 1)
	go func() {
		decoder := json.NewDecoder(serverConn)
		var request map[string]any
		if err := decoder.Decode(&request); err != nil {
			serverDone <- err
			return
		}
		if request["method"] != "session/create" {
			serverDone <- errors.New("unexpected request method")
			return
		}
		id := request["id"]
		encoder := json.NewEncoder(serverConn)
		if err := encoder.Encode(map[string]any{"id": id, "result": map[string]any{"sessionId": "ses_1"}}); err != nil {
			serverDone <- err
			return
		}
		if err := encoder.Encode(map[string]any{"method": "session/event", "params": map[string]any{"type": "turn.started"}}); err != nil {
			serverDone <- err
			return
		}
		if err := encoder.Encode(map[string]any{"id": 91, "method": "session/requestRuntimePreferences", "params": map[string]any{"sessionId": "ses_1"}}); err != nil {
			serverDone <- err
			return
		}
		var reverseResponse map[string]any
		if err := decoder.Decode(&reverseResponse); err != nil {
			serverDone <- err
			return
		}
		if reverseResponse["id"] != float64(91) || reverseResponse["result"] == nil {
			serverDone <- errors.New("bad reverse response")
			return
		}
		serverDone <- nil
	}()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	var result struct {
		SessionID string `json:"sessionId"`
	}
	if err := client.Call(ctx, "session/create", map[string]any{"workspace": "repo"}, &result); err != nil {
		t.Fatal(err)
	}
	if result.SessionID != "ses_1" {
		t.Fatalf("session = %q", result.SessionID)
	}

	notification := <-client.Inbound()
	if notification.ID != nil || notification.Method != "session/event" {
		t.Fatalf("notification = %+v", notification)
	}
	reverse := <-client.Inbound()
	if reverse.ID == nil || reverse.Method != "session/requestRuntimePreferences" {
		t.Fatalf("reverse request = %+v", reverse)
	}
	if err := client.Respond(*reverse.ID, map[string]any{"memoryEnabled": false}, nil); err != nil {
		t.Fatal(err)
	}
	if err := <-serverDone; err != nil {
		t.Fatal(err)
	}
	_ = serverConn.Close()
}

func TestClientReturnsProtocolError(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	client := NewClient(clientConn, clientConn, clientConn.Close)
	t.Cleanup(func() { _ = client.Close() })
	go func() {
		defer serverConn.Close()
		var request map[string]any
		_ = json.NewDecoder(serverConn).Decode(&request)
		_ = json.NewEncoder(serverConn).Encode(map[string]any{
			"id":    request["id"],
			"error": map[string]any{"code": -32010, "message": "session busy", "data": map[string]any{"retryable": true}},
		})
	}()

	err := client.Call(context.Background(), "session/send", map[string]any{}, nil)
	var rpcErr *RPCError
	if !errors.As(err, &rpcErr) || rpcErr.Code != -32010 || rpcErr.Message != "session busy" {
		t.Fatalf("error = %#v", err)
	}
}

func TestClientCallCancellationDoesNotConsumeLaterResponse(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	client := NewClient(clientConn, clientConn, clientConn.Close)
	t.Cleanup(func() { _ = client.Close() })
	requestRead := make(chan map[string]any, 1)
	go func() {
		var request map[string]any
		_ = json.NewDecoder(serverConn).Decode(&request)
		requestRead <- request
	}()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := client.Call(ctx, "session/read", map[string]any{}, nil)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v", err)
	}
	request := <-requestRead
	if err := json.NewEncoder(serverConn).Encode(map[string]any{"id": request["id"], "result": map[string]any{}}); err != nil {
		t.Fatal(err)
	}
	_ = serverConn.Close()
	select {
	case <-client.Done():
	case <-time.After(time.Second):
		t.Fatal("client did not close after transport EOF")
	}
}

func TestClientRejectsMalformedAndOversizedFrames(t *testing.T) {
	t.Run("malformed", func(t *testing.T) {
		clientConn, serverConn := net.Pipe()
		client := NewClient(clientConn, clientConn, clientConn.Close)
		defer client.Close()
		go func() {
			_, _ = serverConn.Write([]byte("not-json\n"))
			_ = serverConn.Close()
		}()
		select {
		case <-client.Done():
		case <-time.After(time.Second):
			t.Fatal("malformed frame did not close client")
		}
		if client.Err() == nil || !strings.Contains(client.Err().Error(), "decode") {
			t.Fatalf("error = %v", client.Err())
		}
	})

	t.Run("oversized", func(t *testing.T) {
		clientConn, serverConn := net.Pipe()
		client := NewClient(clientConn, clientConn, clientConn.Close)
		defer client.Close()
		go func() {
			writer := bufio.NewWriter(serverConn)
			_, _ = writer.WriteString(strings.Repeat("x", MaxFrameBytes+1) + "\n")
			_ = writer.Flush()
			_ = serverConn.Close()
		}()
		select {
		case <-client.Done():
		case <-time.After(2 * time.Second):
			t.Fatal("oversized frame did not close client")
		}
		if client.Err() == nil {
			t.Fatal("oversized frame must record an error")
		}
	})
}
