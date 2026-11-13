package codexapp

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"testing"
	"time"
)

func TestStdioClientRPCAndDisconnect(t *testing.T) {
	local, peer := net.Pipe()
	defer peer.Close()
	client := NewStdioClient(local, local)
	defer client.Close()
	peerErr := make(chan error, 1)
	go func() {
		defer peer.Close()
		scanner := bufio.NewScanner(peer)
		receive := func(method string) (json.RawMessage, error) {
			var msg struct {
				ID     json.RawMessage `json:"id"`
				Method string          `json:"method"`
			}
			if !scanner.Scan() || json.Unmarshal(scanner.Bytes(), &msg) != nil || msg.Method != method {
				return nil, fmt.Errorf("expected %s, got %s", method, scanner.Text())
			}
			return msg.ID, nil
		}
		id, err := receive("initialize")
		if err == nil {
			_, err = fmt.Fprintf(peer, "{\"id\":%s,\"result\":{\"ok\":true}}\n", id)
		}
		if err == nil {
			_, err = receive("initialized")
		}
		if err == nil {
			_, err = fmt.Fprintln(peer, `{"id":"approval","method":"item/commandExecution/requestApproval"}`)
		}
		if err == nil {
			id, err = receive("")
			if err == nil && string(id) != `"approval"` {
				err = fmt.Errorf("wrong server-request response ID: %s", id)
			}
		}
		if err == nil {
			_, err = receive("thread/list")
		}
		peerErr <- err
	}()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	var initialized struct{ OK bool }
	if err := client.Initialize(ctx, nil, &initialized); err != nil || !initialized.OK {
		t.Fatalf("initialize = %+v, %v", initialized, err)
	}
	event := receiveInbound(t, client.Events())
	if event.ID == nil || event.Method != "item/commandExecution/requestApproval" {
		t.Fatalf("unexpected event %+v", event)
	}
	if err := client.Respond(*event.ID, map[string]string{"decision": "decline"}, nil); err != nil {
		t.Fatal(err)
	}
	if err := client.Call(ctx, "thread/list", nil, nil); err == nil || errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected disconnect, got %v", err)
	}
	if err := <-peerErr; err != nil {
		t.Fatal(err)
	}
}

func TestStdioClientWriteHonorsRPCDeadline(t *testing.T) {
	local, peer := net.Pipe()
	defer peer.Close()
	client := NewStdioClient(local, local)
	defer client.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	result := make(chan error, 1)
	go func() { result <- client.Call(ctx, "thread/list", nil, nil) }()
	select {
	case err := <-result:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("expected write deadline, got %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("blocked stdio write exceeded RPC deadline")
	}
	select {
	case <-client.Done():
	case <-time.After(time.Second):
		t.Fatal("transport remained usable after ambiguous write")
	}
}
