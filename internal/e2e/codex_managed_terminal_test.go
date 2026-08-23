//go:build !windows

package e2e

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pocketctl/pocketctl/internal/agentcontrol"
	"github.com/pocketctl/pocketctl/internal/codexapp"
)

type codexManagedProvider struct {
	endpoint   string
	realBinary string
	mu         sync.Mutex
	acquire    agentcontrol.AcquireRequest
	bound      agentcontrol.LeaseBindRequest
	released   agentcontrol.ReleaseRequest
}

func (p *codexManagedProvider) Acquire(_ context.Context, req agentcontrol.AcquireRequest) (agentcontrol.AcquireResult, error) {
	p.mu.Lock()
	p.acquire = req
	p.mu.Unlock()
	return agentcontrol.AcquireResult{
		Mode: string(agentcontrol.LaunchManaged), RemoteURI: p.endpoint,
		RealBinary: p.realBinary, ResolvedSessionID: "thr_e2e",
		LeaseID: "lease-codex", Generation: 23,
	}, nil
}

func (p *codexManagedProvider) BindLease(_ context.Context, req agentcontrol.LeaseBindRequest) error {
	p.mu.Lock()
	p.bound = req
	p.mu.Unlock()
	return nil
}

func (p *codexManagedProvider) Release(_ context.Context, req agentcontrol.ReleaseRequest) error {
	p.mu.Lock()
	p.released = req
	p.mu.Unlock()
	return nil
}

func (p *codexManagedProvider) Status(context.Context, agentcontrol.RuntimeStatusRequest) (agentcontrol.RuntimeStatusResult, error) {
	return agentcontrol.RuntimeStatusResult{Mode: string(agentcontrol.LaunchManaged), Generation: 23}, nil
}

type fakeCodexConnection struct {
	conn  *websocket.Conn
	write sync.Mutex
}

type fakeCodexAppServer struct {
	server  *httptest.Server
	mu      sync.Mutex
	clients map[*websocket.Conn]*fakeCodexConnection
	pending map[string]map[string]any
}

func newFakeCodexAppServer(t *testing.T) *fakeCodexAppServer {
	t.Helper()
	fake := &fakeCodexAppServer{
		clients: make(map[*websocket.Conn]*fakeCodexConnection),
		pending: make(map[string]map[string]any),
	}
	upgrader := websocket.Upgrader{}
	fake.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		client := &fakeCodexConnection{conn: conn}
		fake.mu.Lock()
		fake.clients[conn] = client
		fake.mu.Unlock()
		go fake.serve(client)
	}))
	t.Cleanup(fake.close)
	return fake
}

func (f *fakeCodexAppServer) endpoint() string {
	return "ws" + strings.TrimPrefix(f.server.URL, "http")
}

func (f *fakeCodexAppServer) serve(client *fakeCodexConnection) {
	defer func() {
		f.mu.Lock()
		delete(f.clients, client.conn)
		f.mu.Unlock()
		_ = client.conn.Close()
	}()
	for {
		_, raw, err := client.conn.ReadMessage()
		if err != nil {
			return
		}
		var envelope map[string]json.RawMessage
		if json.Unmarshal(raw, &envelope) != nil {
			continue
		}
		if len(envelope["method"]) > 0 {
			_ = client.writeJSON(map[string]any{"id": json.RawMessage(envelope["id"]), "result": map[string]any{}})
			var method string
			_ = json.Unmarshal(envelope["method"], &method)
			if method == "thread/resume" {
				f.replayPending(client)
			}
			continue
		}
		id := string(envelope["id"])
		f.mu.Lock()
		_, found := f.pending[id]
		if found {
			delete(f.pending, id)
		}
		f.mu.Unlock()
		if found {
			f.broadcast(map[string]any{
				"method": "serverRequest/resolved",
				"params": map[string]any{"threadId": "thr_e2e", "requestId": json.RawMessage(envelope["id"])},
			})
		}
	}
}

func (c *fakeCodexConnection) writeJSON(value any) error {
	c.write.Lock()
	defer c.write.Unlock()
	return c.conn.WriteJSON(value)
}

func (f *fakeCodexAppServer) broadcastRequest(id int, method string) {
	request := map[string]any{
		"id": id, "method": method,
		"params": map[string]any{
			"threadId": "thr_e2e", "turnId": "turn_e2e", "itemId": "cmd_e2e",
			"command": "git status", "cwd": "/fixture/repo", "availableDecisions": []string{"accept", "decline"},
		},
	}
	rawID, _ := json.Marshal(id)
	f.mu.Lock()
	f.pending[string(rawID)] = request
	f.mu.Unlock()
	f.broadcast(request)
}

func (f *fakeCodexAppServer) replayPending(client *fakeCodexConnection) {
	f.mu.Lock()
	pending := make([]map[string]any, 0, len(f.pending))
	for _, request := range f.pending {
		pending = append(pending, request)
	}
	f.mu.Unlock()
	for _, request := range pending {
		_ = client.writeJSON(request)
	}
}

func (f *fakeCodexAppServer) broadcast(value any) {
	f.mu.Lock()
	clients := make([]*fakeCodexConnection, 0, len(f.clients))
	for _, client := range f.clients {
		clients = append(clients, client)
	}
	f.mu.Unlock()
	for _, client := range clients {
		_ = client.writeJSON(value)
	}
}

func (f *fakeCodexAppServer) waitForClients(t *testing.T, count int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		f.mu.Lock()
		got := len(f.clients)
		f.mu.Unlock()
		if got >= count {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("fake app-server did not receive %d clients", count)
}

func (f *fakeCodexAppServer) close() {
	f.mu.Lock()
	for _, client := range f.clients {
		_ = client.conn.Close()
	}
	f.clients = make(map[*websocket.Conn]*fakeCodexConnection)
	f.mu.Unlock()
	f.server.Close()
}

func TestCodexManagedTerminalSharesAppServerAndWebFirstResolution(t *testing.T) {
	fake := newFakeCodexAppServer(t)
	dir, err := os.MkdirTemp("/tmp", "pocketctl-codex-e2e-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	realBinary := writeRealAgentFixture(t, dir, "codex")
	provider := &codexManagedProvider{endpoint: fake.endpoint(), realBinary: realBinary}
	control := filepath.Join(dir, "control.sock")
	server := agentcontrol.NewServer(control, map[string]agentcontrol.RuntimeProvider{agentcontrol.AgentCodex: provider})
	if err := server.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close() })

	ipc := agentcontrol.NewAgentClient(control, agentcontrol.AgentCodex)
	var executed agentcontrol.ExecSpec
	var tui *codexapp.Client
	launcher := agentcontrol.CodexLauncher{
		Acquire: ipc.Acquire, BindLease: ipc.BindLease, Release: ipc.Release,
		Execute: func(spec agentcontrol.ExecSpec) error {
			executed = spec
			if spec.OnStart == nil {
				t.Fatal("managed Codex did not bind its lease")
			}
			if err := spec.OnStart(4343); err != nil {
				return err
			}
			client, err := codexapp.DialWebSocket(context.Background(), fake.endpoint(), nil)
			if err != nil {
				return err
			}
			tui = client
			return client.Initialize(context.Background(), map[string]any{"clientInfo": map[string]string{"name": "codex-tui"}}, &map[string]any{})
		},
		Environ: func() []string { return []string{"HOME=/fixture/home", "TERM=xterm-256color"} },
		Timeout: time.Second,
	}
	if err := launcher.Run(context.Background(), []string{"resume", "thr_e2e"}, "/fixture/repo"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if tui != nil {
			_ = tui.Close()
		}
	})
	wantArgs := []string{"resume", "thr_e2e", "--remote", fake.endpoint()}
	if executed.Path != realBinary || !reflect.DeepEqual(executed.Args, wantArgs) {
		t.Fatalf("official TUI invocation=%+v", executed)
	}

	daemon := dialAndResumeCodexClient(t, fake.endpoint())
	fake.waitForClients(t, 2)
	fake.broadcastRequest(501, "item/commandExecution/requestApproval")
	tuiRequest := receiveCodexInbound(t, tui, "item/commandExecution/requestApproval")
	daemonRequest := receiveCodexInbound(t, daemon, "item/commandExecution/requestApproval")
	if tuiRequest.ID == nil || daemonRequest.ID == nil || tuiRequest.ID.Key() != daemonRequest.ID.Key() {
		t.Fatalf("request IDs diverged: tui=%+v daemon=%+v", tuiRequest.ID, daemonRequest.ID)
	}
	if err := daemon.Respond(*daemonRequest.ID, map[string]string{"decision": "decline"}, nil); err != nil {
		t.Fatal(err)
	}
	resolved := receiveCodexInbound(t, tui, "serverRequest/resolved")
	if !strings.Contains(string(resolved.Params), `"requestId":501`) {
		t.Fatalf("TUI did not receive authoritative resolution: %s", resolved.Params)
	}

	_ = daemon.Close()
	fake.broadcastRequest(502, "item/commandExecution/requestApproval")
	_ = receiveCodexInbound(t, tui, "item/commandExecution/requestApproval")
	restarted := dialAndResumeCodexClient(t, fake.endpoint())
	defer restarted.Close()
	replayed := receiveCodexInbound(t, restarted, "item/commandExecution/requestApproval")
	if replayed.ID == nil || replayed.ID.Key() != "n:502" {
		t.Fatalf("pending request was not replayed after daemon restart: %+v", replayed)
	}

	provider.mu.Lock()
	acquire, bound, released := provider.acquire, provider.bound, provider.released
	provider.mu.Unlock()
	if acquire.Payload.Intent != agentcontrol.IntentResume || acquire.Payload.SessionID != "thr_e2e" || bound.Payload.PID != 4343 || released.Payload.LeaseID != "lease-codex" {
		t.Fatalf("managed lifecycle acquire=%+v bind=%+v release=%+v", acquire, bound, released)
	}
}

func TestCodexManagedTerminalMissingDaemonPreservesNativeInvocation(t *testing.T) {
	dir, err := os.MkdirTemp("/tmp", "pocketctl-codex-fallback-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	client := agentcontrol.NewAgentClient(filepath.Join(dir, "missing.sock"), agentcontrol.AgentCodex)
	nativeExit := errors.New("fixture exit 29")
	var executed agentcontrol.ExecSpec
	var stderr bytes.Buffer
	launcher := agentcontrol.CodexLauncher{
		Acquire:       client.Acquire,
		ResolveBinary: func() (string, error) { return "/fixture/real-codex", nil },
		Execute:       func(spec agentcontrol.ExecSpec) error { executed = spec; return nativeExit },
		Environ:       func() []string { return []string{"HOME=/fixture/home", "TERM=xterm"} },
		Stderr:        &stderr, Timeout: 200 * time.Millisecond,
	}
	started := time.Now()
	err = launcher.Run(context.Background(), []string{"resume", "thr_native"}, "/fixture/repo")
	if !errors.Is(err, nativeExit) || time.Since(started) > 500*time.Millisecond {
		t.Fatalf("native fallback err=%v elapsed=%v", err, time.Since(started))
	}
	if executed.Path != "/fixture/real-codex" || !reflect.DeepEqual(executed.Args, []string{"resume", "thr_native"}) {
		t.Fatalf("native execution=%+v", executed)
	}
	if strings.Count(strings.TrimSpace(stderr.String()), "\n") != 0 {
		t.Fatalf("fallback diagnostic must stay on one line: %q", stderr.String())
	}
}

func dialAndResumeCodexClient(t *testing.T, endpoint string) *codexapp.Client {
	t.Helper()
	client, err := codexapp.DialWebSocket(context.Background(), endpoint, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Initialize(context.Background(), map[string]any{"clientInfo": map[string]string{"name": "pocketctl-daemon"}}, &map[string]any{}); err != nil {
		client.Close()
		t.Fatal(err)
	}
	if err := client.Call(context.Background(), "thread/resume", map[string]string{"threadId": "thr_e2e"}, &map[string]any{}); err != nil {
		client.Close()
		t.Fatal(err)
	}
	return client
}

func receiveCodexInbound(t *testing.T, client *codexapp.Client, method string) codexapp.Inbound {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		select {
		case event, ok := <-client.Events():
			if !ok {
				t.Fatal("Codex client disconnected while waiting for " + method)
			}
			if event.Method == method {
				return event
			}
		case <-deadline:
			t.Fatal("timed out waiting for " + method)
		}
	}
}
