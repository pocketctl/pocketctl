package sessionmcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

type fakeRelayReader struct {
	request IpcReadRequest
	result  protocol.SessionHistoryReadResult
	err     error
}

func (f *fakeRelayReader) Read(_ context.Context, request IpcReadRequest) (protocol.SessionHistoryReadResult, error) {
	f.request = request
	return f.result, f.err
}

func TestMCPExposesOneReadOnlyToolAndReturnsUntrustedTranscript(t *testing.T) {
	reader := &fakeRelayReader{result: protocol.SessionHistoryReadResult{
		Type: "session_history_read_result", SourceSessionID: "source-a", TargetSessionID: "target-b",
		Messages:               []protocol.SessionHistoryMessage{{EventID: "1", Role: "assistant", Content: "hello"}},
		SnapshotThroughEventID: "1", UntrustedContent: true,
	}}
	stdin := strings.NewReader(strings.Join([]string{
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`,
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"pocketctl_read_session_history","arguments":{"target_session_id":"target-b"}}}`,
	}, "\n") + "\n")
	stdout := &bytes.Buffer{}
	server := &MCPServer{Reader: reader, SourceSessionID: "source-a", Stdin: stdin, Stdout: stdout}
	if err := server.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if strings.Count(stdout.String(), "\n") != 3 {
		t.Fatalf("responses=%q", stdout.String())
	}
	if !strings.Contains(stdout.String(), `"name":"pocketctl_read_session_history"`) {
		t.Fatalf("tool not listed: %s", stdout.String())
	}
	if !strings.Contains(stdout.String(), `\"untrusted_content\":true`) {
		t.Fatalf("result missing trust marker: %s", stdout.String())
	}
	if reader.request.SourceSessionID != "source-a" || reader.request.TargetSessionID != "target-b" {
		t.Fatalf("request=%+v", reader.request)
	}
}

func TestMCPRejectsUnknownToolsWithoutCallingRelay(t *testing.T) {
	reader := &fakeRelayReader{}
	stdout := &bytes.Buffer{}
	server := &MCPServer{
		Reader: reader,
		Stdin:  strings.NewReader(`{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"send_message","arguments":{}}}` + "\n"),
		Stdout: stdout,
	}
	if err := server.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stdout.String(), `"isError":true`) || !strings.Contains(stdout.String(), "tool_not_allowed") {
		t.Fatalf("unexpected response: %s", stdout.String())
	}
	if reader.request.SourceSessionID != "" {
		t.Fatal("unknown tool reached relay reader")
	}
}

type fakeControlSender struct{ sent chan any }

func (f *fakeControlSender) SendMsg(value any) { f.sent <- value }

func TestWsBrokerCorrelatesReadResultsAndBoundsErrors(t *testing.T) {
	sender := &fakeControlSender{sent: make(chan any, 1)}
	broker := NewWsBroker(sender)
	resultCh := make(chan protocol.SessionHistoryReadResult, 1)
	errCh := make(chan error, 1)
	go func() {
		result, err := broker.Read(context.Background(), IpcReadRequest{
			SourceSessionID: "source-a", TargetSessionID: "target-b",
		})
		resultCh <- result
		errCh <- err
	}()
	var sent any
	select {
	case sent = <-sender.sent:
	case <-time.After(time.Second):
		t.Fatal("request was not sent")
	}
	wire, err := json.Marshal(sent)
	if err != nil {
		t.Fatal(err)
	}
	var request protocol.SessionHistoryReadRequest
	if err := json.Unmarshal(wire, &request); err != nil {
		t.Fatal(err)
	}
	broker.Dispatch(protocol.ClientMessage{
		Type: "session_history_read_result", RequestID: request.RequestID,
		SourceSessionID: "source-a", TargetSessionID: "target-b",
		SessionHistoryMessages: []protocol.SessionHistoryMessage{{EventID: "1", Role: "user", Content: "hi"}},
		SnapshotThroughEventID: "1", UntrustedContent: true,
	})
	if err := <-errCh; err != nil {
		t.Fatal(err)
	}
	if result := <-resultCh; len(result.Messages) != 1 || result.Messages[0].Content != "hi" {
		t.Fatalf("result=%+v", result)
	}
}

func TestIPCServerAndSourceRoundTripWithoutCredentials(t *testing.T) {
	reader := &fakeRelayReader{result: protocol.SessionHistoryReadResult{
		Type: "session_history_read_result", SourceSessionID: "source-a", TargetSessionID: "target-b",
		Messages:               []protocol.SessionHistoryMessage{{EventID: "1", Role: "assistant", Content: "hello"}},
		SnapshotThroughEventID: "1", UntrustedContent: true,
	}}
	client, daemon := net.Pipe()
	defer client.Close()
	server := &IPCServer{Reader: reader, Timeout: time.Second}
	go server.serveOne(context.Background(), daemon)
	source := &IPCSource{
		SocketPath: "unused",
		Dial:       func(context.Context, string) (net.Conn, error) { return client, nil },
	}
	result, err := source.Read(context.Background(), IpcReadRequest{
		SourceSessionID: "source-a", TargetSessionID: "target-b",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Messages) != 1 || result.Messages[0].Content != "hello" {
		t.Fatalf("result=%+v", result)
	}
	if reader.request.SourceSessionID != "source-a" || reader.request.TargetSessionID != "target-b" {
		t.Fatalf("request=%+v", reader.request)
	}
}

func TestIPCServerRejectsOversizedFramesBeforeRelayRead(t *testing.T) {
	reader := &fakeRelayReader{}
	client, daemon := net.Pipe()
	server := &IPCServer{Reader: reader, Timeout: time.Second}
	go server.serveOne(context.Background(), daemon)
	_, _ = client.Write([]byte(strings.Repeat("x", maxIPCFrameBytes+1) + "\n"))
	_ = client.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
	_, _ = bufio.NewReader(client).ReadString('\n')
	_ = client.Close()
	if reader.request.SourceSessionID != "" {
		t.Fatal("oversized frame reached Relay reader")
	}
}
