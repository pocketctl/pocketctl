package memorymcp

import (
	"bufio"
	"context"
	"net"
	"os"
	"strings"
	"testing"
	"time"
)

// shortSocketDir mirrors the documented macOS 104-char bind limit: use /tmp
// instead of t.TempDir() for unix socket paths.
func shortSocketDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "mcpipc")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

func TestServerAnswersGrantRequestsAndBoundedErrors(t *testing.T) {
	dir := shortSocketDir(t)
	socketPath := dir + "/m.s"
	requests := make(chan struct{}, 4)
	server := &Server{
		SocketPath: socketPath,
		Timeout:    2 * time.Second,
		Request: func(ctx context.Context) (Grant, error) {
			requests <- struct{}{}
			return Grant{
				Token: "g-1", ExpiresAt: time.Now().Add(time.Minute),
				Origin: "https://memory.example", InstallID: "i-1",
			}, nil
		},
	}
	ln, err := server.Start()
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go server.Serve(ctx, ln)
	waitForListener(t, socketPath)

	conn, err := net.Dial("unix", socketPath)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	_, _ = conn.Write([]byte(`{"type":"memory_mcp_grant_request"}` + "\n"))
	line, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	for _, want := range []string{`"grant":"g-1"`, `"provider_public_origin":"https://memory.example"`, `"installation_id":"i-1"`} {
		if !strings.Contains(line, want) {
			t.Fatalf("response missing %s: %s", want, line)
		}
	}

	// A failing requester answers only the bounded code.
	failing := &Server{
		SocketPath: socketPath + "2",
		Timeout:    time.Second,
		Request: func(ctx context.Context) (Grant, error) {
			return Grant{}, errCode("no_installation")
		},
	}
	ln2, err := failing.Start()
	if err != nil {
		t.Fatalf("start2: %v", err)
	}
	go failing.Serve(ctx, ln2)
	waitForListener(t, socketPath+"2")
	conn2, err := net.Dial("unix", socketPath+"2")
	if err != nil {
		t.Fatalf("dial2: %v", err)
	}
	defer conn2.Close()
	_, _ = conn2.Write([]byte(`{"type":"memory_mcp_grant_request"}` + "\n"))
	line2, err := bufio.NewReader(conn2).ReadString('\n')
	if err != nil {
		t.Fatalf("read2: %v", err)
	}
	if !strings.Contains(line2, `"error":"no_installation"`) {
		t.Fatalf("expected bounded error, got %s", line2)
	}
}

func TestServerRejectsMalformedRequests(t *testing.T) {
	dir := shortSocketDir(t)
	socketPath := dir + "/m3.s"
	server := &Server{
		SocketPath: socketPath,
		Timeout:    time.Second,
		Request:    func(ctx context.Context) (Grant, error) { return Grant{}, nil },
	}
	ln, err := server.Start()
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go server.Serve(ctx, ln)
	waitForListener(t, socketPath)
	conn, err := net.Dial("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_, _ = conn.Write([]byte("garbage\n"))
	line, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(line, `"error":"invalid_request"`) {
		t.Fatalf("expected invalid_request, got %s", line)
	}
}

func TestServerRejectsOversizedIPCFramesBeforeGrantMint(t *testing.T) {
	dir := shortSocketDir(t)
	socketPath := dir + "/m4.s"
	called := make(chan struct{}, 1)
	server := &Server{
		SocketPath: socketPath,
		Timeout:    time.Second,
		Request: func(context.Context) (Grant, error) {
			called <- struct{}{}
			return Grant{}, nil
		},
	}
	ln, err := server.Start()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go server.Serve(ctx, ln)
	waitForListener(t, socketPath)
	conn, err := net.Dial("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = conn.Write([]byte(strings.Repeat("x", maxIPCFrameBytes+1) + "\n"))
	_ = conn.Close()
	select {
	case <-called:
		t.Fatal("oversized frame reached grant requester")
	case <-time.After(50 * time.Millisecond):
	}
}

func TestIPCGrantSourceRejectsOversizedResponses(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	go func() {
		defer server.Close()
		_, _ = bufio.NewReader(server).ReadString('\n')
		_, _ = server.Write([]byte(strings.Repeat("x", maxIPCFrameBytes+1) + "\n"))
	}()
	source := &IPCGrantSource{
		SocketPath: "ignored",
		Dial:       func(context.Context, string) (net.Conn, error) { return client, nil },
	}
	if _, err := source.Grant(context.Background()); err == nil || !strings.Contains(err.Error(), "ipc_frame_too_large") {
		t.Fatalf("expected bounded frame error, got %v", err)
	}
}

func waitForListener(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		conn, err := net.Dial("unix", path)
		if err == nil {
			_ = conn.Close()
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("listener %s never became ready", path)
}
