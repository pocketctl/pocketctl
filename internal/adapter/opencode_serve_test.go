package adapter

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/platform"
)

func TestOpenCodeProbePerMessageSystemRequiresLiveSchemaEvidence(t *testing.T) {
	tests := []struct {
		name string
		doc  string
		want bool
	}{
		{name: "supported", doc: `{"paths":{"/session/{sessionID}/message":{"post":{"requestBody":{"content":{"application/json":{"schema":{"properties":{"system":{"type":"string"}}}}}}}}}}`, want: true},
		{name: "supported through local schema ref", doc: `{"paths":{"/session/{sessionID}/message":{"post":{"requestBody":{"content":{"application/json":{"schema":{"$ref":"#/components/schemas/MessageInput"}}}}}}},"components":{"schemas":{"MessageInput":{"type":"object","properties":{"system":{"type":"string"}}}}}}`, want: true},
		{name: "missing field", doc: `{"paths":{"/session/{sessionID}/message":{"post":{"requestBody":{"content":{"application/json":{"schema":{"properties":{"parts":{"type":"array"}}}}}}}}}}`, want: false},
		{name: "response field is not request capability", doc: `{"paths":{"/session/{sessionID}/message":{"post":{"responses":{"200":{"content":{"application/json":{"schema":{"properties":{"system":{"type":"string"}}}}}}}}}}}`, want: false},
		{name: "get request is not post capability", doc: `{"paths":{"/session/{sessionID}/message":{"get":{"requestBody":{"content":{"application/json":{"schema":{"properties":{"system":{"type":"string"}}}}}}}}}}`, want: false},
		{name: "non-string system is unsupported", doc: `{"paths":{"/session/{sessionID}/message":{"post":{"requestBody":{"content":{"application/json":{"schema":{"properties":{"system":{"type":"object"}}}}}}}}}}`, want: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/doc" {
					http.NotFound(w, r)
					return
				}
				fmt.Fprint(w, tt.doc)
			}))
			defer server.Close()
			srv := NewOpencodeServer("unused")
			srv.baseURL = server.URL
			if got := srv.ProbePerMessageSystem(context.Background()); got != tt.want {
				t.Fatalf("probe=%v, want %v", got, tt.want)
			}
		})
	}
}

func TestOpenCodeGetMessagesUsesSessionDirectory(t *testing.T) {
	const directory = "/tmp/opencode-cli-project"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/session/ses_cli/message" {
			http.NotFound(w, r)
			return
		}
		if got := r.URL.Query().Get("directory"); got != directory {
			http.Error(w, "wrong project directory", http.StatusBadRequest)
			return
		}
		fmt.Fprint(w, `[{"info":{"id":"msg_cli","role":"assistant"},"parts":[{"id":"part_cli","type":"text","text":"synced"}]}]`)
	}))
	defer server.Close()

	srv := NewOpencodeServer("unused")
	srv.baseURL = server.URL
	messages, err := srv.GetMessages(context.Background(), "ses_cli", directory)
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) != 1 || messages[0].Info.ID != "msg_cli" || len(messages[0].Parts) != 1 || messages[0].Parts[0].Text != "synced" {
		t.Fatalf("messages=%+v", messages)
	}
}

func TestOpenCodeReserveMessageIDIsMonotonicAndDispatchSafe(t *testing.T) {
	baselineMillis := time.Now().Add(-10*time.Millisecond).UnixMilli() & (1<<36 - 1)
	baseline := OpencodeMessageWithParts{}
	baseline.Info.ID = fmt.Sprintf("msg_%012x00000000000000", (baselineMillis<<12)|1)

	id, err := ReserveOpencodeMessageID(context.Background(), []OpencodeMessageWithParts{baseline})
	if err != nil {
		t.Fatal(err)
	}
	reservedMillis, ok := opencodeMessageIDMillis(id)
	if !ok || reservedMillis <= baselineMillis {
		t.Fatalf("reserved id %q timestamp=%d, baseline=%d", id, reservedMillis, baselineMillis)
	}
	if time.Now().UnixMilli()&(1<<36-1) <= reservedMillis {
		t.Fatalf("reservation returned before dispatch-safe clock barrier: now=%d id=%d", time.Now().UnixMilli()&(1<<36-1), reservedMillis)
	}
}

func TestOpenCodeReserveMessageIDClassifiesCrossEpochHistory(t *testing.T) {
	const timestampMask = int64(1<<36) - 1
	oldCycle := OpencodeMessageWithParts{}
	oldCycle.Info.ID = fmt.Sprintf("msg_%012x00000000000000", ((timestampMask-1000)<<12)|1)
	oldCycle.Info.Time.Created = time.Now().Add(-30 * 24 * time.Hour).UnixMilli()

	_, err := ReserveOpencodeMessageID(context.Background(), []OpencodeMessageWithParts{oldCycle})
	if err == nil || !strings.Contains(err.Error(), "crosses the 36-bit message-id epoch") {
		t.Fatalf("cross-epoch reservation error = %v, want explicit epoch classification", err)
	}
}

func TestOpenCodeListSessionsUsesBoundedDiscoveryLimit(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/session" {
			http.NotFound(w, r)
			return
		}
		if got := r.URL.Query().Get("limit"); got != "1000" {
			t.Fatalf("discovery limit = %q, want 1000", got)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []any{map[string]any{"id": "ses_old", "title": "old session"}},
		})
	}))
	defer server.Close()
	srv := NewOpencodeServer("")
	srv.baseURL = server.URL
	sessions, err := srv.ListSessions(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 1 || sessions[0].ID != "ses_old" {
		t.Fatalf("sessions = %+v", sessions)
	}
}

func TestOpenCodeGetSessionAcceptsLocationDirectory(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/session/ses_location" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{
			"id": "ses_location", "agent": "build",
			"location": map[string]string{"directory": "/repo/from-location"},
			"model":    map[string]string{"providerID": "opencode", "id": "x-preview-f-free"},
		}})
	}))
	defer server.Close()
	srv := NewOpencodeServer("")
	srv.baseURL = server.URL
	info, err := srv.GetSession(context.Background(), "ses_location")
	if err != nil {
		t.Fatal(err)
	}
	if info.Directory != "/repo/from-location" {
		t.Fatalf("directory = %q, want location.directory", info.Directory)
	}
}

func TestOpenCodePromptUsesAndVerifiesReservedSourceID(t *testing.T) {
	const sourceID = "msg_019c123456781234567890abcd"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/session/ses_prompt/message" {
			http.NotFound(w, r)
			return
		}
		var body struct {
			MessageID string `json:"messageID"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if body.MessageID != sourceID {
			http.Error(w, "missing reserved source id", http.StatusBadRequest)
			return
		}
		fmt.Fprintf(w, `{"info":{"id":"msg_assistant","sessionID":"ses_prompt","role":"assistant","parentID":%q},"parts":[]}`, sourceID)
	}))
	defer server.Close()

	srv := NewOpencodeServer("unused")
	srv.baseURL = server.URL
	result, err := srv.Prompt(context.Background(), "ses_prompt", "openai/gpt-5", sourceID, "hello")
	if err != nil || result.Info.ParentID != sourceID {
		t.Fatalf("result=%+v err=%v", result, err)
	}
}

func TestOpenCodePromptRejectsMismatchedDispatchSource(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"info":{"id":"msg_assistant","role":"assistant","parentID":"msg_competitor"},"parts":[]}`)
	}))
	defer server.Close()
	srv := NewOpencodeServer("unused")
	srv.baseURL = server.URL
	if _, err := srv.Prompt(context.Background(), "ses_prompt", "", "msg_expected", "hello"); err == nil {
		t.Fatal("mismatched assistant parent must fail dispatch-source verification")
	}
}

func TestOpenCodeHTTPStatusErrorPreservesActualStatus(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "misleading body status 404:", http.StatusInternalServerError)
	}))
	defer server.Close()
	srv := NewOpencodeServer("unused")
	srv.baseURL = server.URL

	requests := []func() error{
		func() error { _, err := srv.GetSession(context.Background(), "ses_1"); return err },
		func() error { return srv.post(context.Background(), "/session", nil, nil) },
	}
	for _, request := range requests {
		err := request()
		var statusErr *OpencodeHTTPStatusError
		if !errors.As(err, &statusErr) {
			t.Fatalf("error %T %v is not OpencodeHTTPStatusError", err, err)
		}
		if statusErr.StatusCode != http.StatusInternalServerError {
			t.Fatalf("status=%d, want 500", statusErr.StatusCode)
		}
		if !strings.Contains(statusErr.Body, "status 404:") || len(statusErr.Body) > 2048 {
			t.Fatalf("bounded body context invalid: %q", statusErr.Body)
		}
		if strings.Contains(statusErr.Error(), "\n") {
			t.Fatalf("error contains unsafe raw newline: %q", statusErr.Error())
		}
	}
}

func TestResolveDefaultModelRequiresConnectedProvider(t *testing.T) {
	tests := []struct {
		name, configured, want string
		connected              []string
		wantErr                bool
	}{
		{"configured connected", "p/a", "p/a", []string{"p"}, false},
		{"same provider fallback", "p/missing", "p/a", []string{"p"}, false},
		{"free fallback", "q/model", "opencode/deepseek-v4-flash-free", []string{"opencode"}, false},
		{"any connected fallback", "q/model", "r/usable", []string{"r"}, false},
		{"none connected", "q/model", "", nil, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/api/model":
					fmt.Fprint(w, `{"data":[{"providerID":"p","id":"a"},{"providerID":"p","id":"other"},{"providerID":"opencode","id":"deepseek-v4-flash-free"},{"providerID":"r","id":"usable"}]}`)
				case "/config":
					fmt.Fprintf(w, `{"model":%q}`, tt.configured)
				case "/provider":
					b, _ := json.Marshal(map[string]any{"connected": tt.connected})
					w.Write(b)
				default:
					http.NotFound(w, r)
				}
			})
			listener, err := net.Listen("tcp4", "127.0.0.1:0")
			if err != nil {
				t.Skipf("local listener unavailable in this sandbox: %v", err)
			}
			srv := &http.Server{Handler: handler}
			go srv.Serve(listener)
			defer srv.Close()
			op := NewOpencodeServer("test")
			op.baseURL = "http://" + listener.Addr().String()
			got, err := op.ResolveDefaultModel(context.Background())
			if tt.wantErr {
				if err == nil {
					t.Fatalf("expected error, got %q", got)
				}
				return
			}
			if err != nil || got != tt.want {
				t.Fatalf("got %q, err=%v; want %q", got, err, tt.want)
			}
		})
	}
}

func TestResolveDefaultModelProviderFallbackAndAllConnected(t *testing.T) {
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/model":
			fmt.Fprint(w, `{"data":[{"providerID":"p","id":"m"}]}`)
		case "/config":
			fmt.Fprint(w, `{"model":"p/m"}`)
		case "/provider":
			http.NotFound(w, r)
		case "/api/provider":
			fmt.Fprint(w, `{"all":[{"id":"p","connected":true}]}`)
		default:
			http.NotFound(w, r)
		}
	})
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Skipf("listener unavailable: %v", err)
	}
	srv := &http.Server{Handler: h}
	go srv.Serve(ln)
	defer srv.Close()
	op := NewOpencodeServer("test")
	op.baseURL = "http://" + ln.Addr().String()
	got, err := op.ResolveDefaultModel(context.Background())
	if err != nil || got != "p/m" {
		t.Fatalf("got %q err %v", got, err)
	}
}

func TestOpenCodeRestartAttachValidatesPIDAuthAndVersion(t *testing.T) {
	const password = "handoff-secret"
	proc := fakeSleepCommand(30)
	proc.Env = append(os.Environ(), "OPENCODE_SERVER_PASSWORD="+password)
	if err := proc.Start(); err != nil {
		t.Fatal(err)
	}
	defer proc.Process.Kill()
	health := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, pass, ok := r.BasicAuth()
		if !ok || user != "opencode" || pass != password {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if r.URL.Path != "/global/health" {
			http.NotFound(w, r)
			return
		}
		fmt.Fprint(w, `{"healthy":true,"version":"1.2.3"}`)
	}))
	defer health.Close()

	ctx := context.Background()
	srv, err := AttachOpencodeServer(ctx, health.URL, password, proc.Process.Pid, "1.2.3", time.Now())
	if err != nil {
		t.Fatalf("healthy attach: %v", err)
	}
	if srv.BaseURL() != health.URL || srv.PID() != proc.Process.Pid || srv.Version() != "1.2.3" {
		t.Fatalf("attached server=%+v", srv)
	}
	if _, err := AttachOpencodeServer(ctx, health.URL, "wrong", proc.Process.Pid, "1.2.3", time.Now()); err == nil {
		t.Fatal("wrong password attached")
	}
	if _, err := AttachOpencodeServer(ctx, health.URL, password, 99999999, "1.2.3", time.Now()); err == nil {
		t.Fatal("dead pid attached")
	}
	if _, err := AttachOpencodeServer(ctx, health.URL, password, proc.Process.Pid, "2.0.0", time.Now()); err == nil {
		t.Fatal("incompatible version attached")
	}
}

func TestOpenCodeRestartDetectsInstalledVersion(t *testing.T) {
	cli := filepath.Join(t.TempDir(), "opencode")
	cli = writeFakeCommandFixture(t, cli,
		"#!/bin/sh\necho 'bun warning: ABI 9.8.7' >&2\necho 'opencode version 1.2.3-beta.4'\n",
		"@echo off\n(>&2 echo bun warning: ABI 9.8.7)\necho opencode version 1.2.3-beta.4\n",
	)
	got, err := DetectOpencodeVersion(context.Background(), cli)
	if err != nil {
		t.Fatal(err)
	}
	if got != "1.2.3-beta.4" {
		t.Fatalf("version=%q want prerelease", got)
	}
}

func TestOpenCodeRestartAttachRejectsNonCanonicalURLsAndRedirects(t *testing.T) {
	ctx := context.Background()
	for _, raw := range []string{
		"https://127.0.0.1:1234", "http://127.0.0.1", "http://127.0.0.1:0",
		"http://user@127.0.0.1:1234", "http://localhost:1234/path",
		"http://localhost:1234?q=1", "http://localhost:1234#frag",
		"http://127.0.0.2:1234", "http://localhost.:1234",
	} {
		if _, err := AttachOpencodeServer(ctx, raw, "secret", os.Getpid(), "1.2.3", time.Now()); err == nil {
			t.Errorf("accepted %q", raw)
		}
	}
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"healthy":true,"version":"1.2.3"}`)
	}))
	defer target.Close()
	redirect := httptest.NewServer(http.RedirectHandler(target.URL, http.StatusFound))
	defer redirect.Close()
	if _, err := AttachOpencodeServer(ctx, redirect.URL, "secret", os.Getpid(), "1.2.3", time.Now()); err == nil {
		t.Fatal("followed health redirect")
	}
}

func TestOpenCodeRestartServeOutputSurvivesDetach(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/health" {
			fmt.Fprint(w, `{"healthy":true}`)
			return
		}
		if r.URL.Path == "/global/health" {
			fmt.Fprint(w, `{"healthy":true,"version":"1.2.3"}`)
			return
		}
		http.NotFound(w, r)
	}))
	defer httpServer.Close()
	cli := filepath.Join(t.TempDir(), "opencode")
	cli = writeFakeCommandFixture(t, cli,
		fmt.Sprintf("#!/bin/sh\necho 'opencode server listening on %s'\nsleep 0.2\necho late-after-detach\nwhile :; do sleep 1; done\n", httpServer.URL),
		fmt.Sprintf("@echo off\necho opencode server listening on %s\ntimeout /t 1 /nobreak >nul\necho late-after-detach\n:loop\ntimeout /t 1 /nobreak >nul\ngoto loop\n", httpServer.URL),
	)
	srv := NewOpencodeServer(cli)
	if err := srv.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer srv.Stop()
	srv.Detach()
	// The release gate runs many race-enabled packages concurrently. This is a
	// fixture-observation deadline, not a serve latency requirement, so leave
	// enough time for the child shell to be scheduled before judging delivery.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		data, _ := os.ReadFile(srv.OutputPath())
		if strings.Contains(string(data), "late-after-detach") {
			if !srv.Healthy(context.Background()) {
				t.Fatal("serve unhealthy after late detached log")
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("late child output did not reach persistent sink")
}

func TestOpenCodeConcurrentStartsDoNotReadAnotherServersListenURL(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell synchronization fixture is Unix-only")
	}
	t.Setenv("HOME", t.TempDir())

	serverA := httptest.NewServer(opencodeHealthHandler("1.2.3"))
	defer serverA.Close()
	serverB := httptest.NewServer(opencodeHealthHandler("1.2.3"))
	defer serverB.Close()

	dir := t.TempDir()
	readyA := filepath.Join(dir, "a-ready")
	cliA := filepath.Join(dir, "opencode-a")
	cliB := filepath.Join(dir, "opencode-b")
	scriptA := fmt.Sprintf("#!/bin/sh\ntouch %q\nsleep 0.3\necho 'opencode server listening on %s'\nwhile :; do sleep 1; done\n", readyA, serverA.URL)
	scriptB := fmt.Sprintf("#!/bin/sh\necho 'opencode server listening on %s'\nwhile :; do sleep 1; done\n", serverB.URL)
	if err := os.WriteFile(cliA, []byte(scriptA), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cliB, []byte(scriptB), 0o755); err != nil {
		t.Fatal(err)
	}

	opA := NewOpencodeServer(cliA)
	opB := NewOpencodeServer(cliB)
	t.Cleanup(func() { _ = opA.Stop(); _ = opB.Stop() })
	errA := make(chan error, 1)
	go func() { errA <- opA.Start(context.Background()) }()
	// readyA only proves that the first fixture process has been scheduled. The
	// isolation assertion starts below, after both servers publish their own
	// listen URLs, so do not turn host process-start latency into a false gate.
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(readyA); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("first fake serve did not start")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := opB.Start(context.Background()); err != nil {
		t.Fatalf("start B: %v", err)
	}
	if err := <-errA; err != nil {
		t.Fatalf("start A: %v", err)
	}
	if opA.BaseURL() != serverA.URL || opB.BaseURL() != serverB.URL {
		t.Fatalf("crossed listen URLs: A=%q want %q, B=%q want %q", opA.BaseURL(), serverA.URL, opB.BaseURL(), serverB.URL)
	}
	if opA.OutputPath() == "" || opA.OutputPath() == opB.OutputPath() {
		t.Fatalf("serve output paths are not isolated: A=%q B=%q", opA.OutputPath(), opB.OutputPath())
	}
}

func opencodeHealthHandler(version string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/health":
			fmt.Fprint(w, `{"healthy":true}`)
		case "/global/health":
			fmt.Fprintf(w, `{"healthy":true,"version":%q}`, version)
		default:
			http.NotFound(w, r)
		}
	})
}

func TestOpencodeServerHealthChecksUseGlobalEndpoint(t *testing.T) {
	var apiHealthCalls atomic.Int32
	httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/global/health":
			fmt.Fprint(w, `{"healthy":true,"version":"1.18.5"}`)
		case "/api/health":
			apiHealthCalls.Add(1)
			http.Error(w, "project-scoped health unavailable", http.StatusServiceUnavailable)
		default:
			http.NotFound(w, r)
		}
	}))
	defer httpServer.Close()

	srv := &OpencodeServer{
		baseURL:  httpServer.URL,
		password: "secret",
		http:     newHTTPClient(time.Second),
		httpLong: newHTTPClient(0),
	}
	if !srv.Healthy(context.Background()) {
		t.Fatal("Healthy rejected a healthy global endpoint")
	}
	if err := srv.waitHealthy(context.Background(), 100*time.Millisecond); err != nil {
		t.Fatalf("waitHealthy: %v", err)
	}
	if got := apiHealthCalls.Load(); got != 0 {
		t.Fatalf("project-scoped /api/health calls=%d, want 0", got)
	}
}

func writeFakeCommandFixture(t *testing.T, basePath, unixScript, windowsScript string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		if filepath.Ext(basePath) == "" {
			basePath += ".cmd"
		}
		if err := os.WriteFile(basePath, []byte(windowsScript), 0o700); err != nil {
			t.Fatal(err)
		}
		return basePath
	}
	if err := os.WriteFile(basePath, []byte(unixScript), 0o700); err != nil {
		t.Fatal(err)
	}
	return basePath
}

func fakeSleepCommand(seconds int) *exec.Cmd {
	if runtime.GOOS == "windows" {
		return exec.Command("cmd", "/C", "timeout", "/T", strconv.Itoa(seconds), "/NOBREAK")
	}
	return exec.Command("sleep", strconv.Itoa(seconds))
}

func TestOpenCodeRestartStopDoesNotKillOnEndpointIdentityMismatch(t *testing.T) {
	cmd := fakeSleepCommand(30)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer cmd.Process.Kill()
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"healthy":true,"version":"1.2.3"}`)
	}))
	defer endpoint.Close()
	srv := &OpencodeServer{baseURL: endpoint.URL, password: "wrong", pid: cmd.Process.Pid, version: "1.2.3", identityNotAfter: time.Now().Add(-time.Hour), http: newHTTPClient(time.Second), httpLong: newHTTPClient(0)}
	if err := srv.Stop(); err == nil {
		t.Fatal("expected unverifiable identity error")
	}
	if !platform.NewProcessController().IsAlive(cmd.Process.Pid) {
		t.Fatal("identity mismatch killed unrelated pid")
	}
}

func TestOpenCodeRestartStopTreatsExitedLocalChildAsClean(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/health" {
			fmt.Fprint(w, `{"healthy":true}`)
			return
		}
		if r.URL.Path == "/global/health" {
			fmt.Fprint(w, `{"healthy":true,"version":"1.2.3"}`)
			return
		}
	}))
	defer httpServer.Close()
	cli := filepath.Join(t.TempDir(), "opencode")
	cli = writeFakeCommandFixture(t, cli,
		fmt.Sprintf("#!/bin/sh\necho 'opencode server listening on %s'\nsleep 0.1\n", httpServer.URL),
		fmt.Sprintf("@echo off\necho opencode server listening on %s\ntimeout /t 1 /nobreak >nul\n", httpServer.URL),
	)
	srv := NewOpencodeServer(cli)
	if err := srv.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	time.Sleep(250 * time.Millisecond)
	if err := srv.Stop(); err != nil {
		t.Fatalf("exited child cleanup: %v", err)
	}
}

func TestParsePermissionAsked(t *testing.T) {
	cases := []struct {
		name             string
		props            string
		wantOK           bool
		wantID, wantSess string
		wantTool         string
	}{
		{
			name:     "flat shape",
			props:    `{"id":"per_123","sessionID":"ses_abc","type":"bash","metadata":{"command":"ls"}}`,
			wantOK:   true,
			wantID:   "per_123",
			wantSess: "ses_abc",
			wantTool: "bash",
		},
		{
			name:     "nested under permission",
			props:    `{"permission":{"id":"per_9","sessionID":"ses_z","toolName":"edit","title":"Edit foo.go"}}`,
			wantOK:   true,
			wantID:   "per_9",
			wantSess: "ses_z",
			wantTool: "edit",
		},
		{
			name:     "requestID alias",
			props:    `{"requestID":"req_7","sessionID":"ses_q","type":"bash"}`,
			wantOK:   true,
			wantID:   "req_7",
			wantSess: "ses_q",
			wantTool: "bash",
		},
		{name: "missing id", props: `{"sessionID":"ses_x","type":"bash"}`, wantOK: false},
		{name: "missing session", props: `{"id":"per_1","type":"bash"}`, wantOK: false},
		{name: "garbage", props: `not json`, wantOK: false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			pa, ok := ParsePermissionAsked(json.RawMessage(c.props))
			if ok != c.wantOK {
				t.Fatalf("ok=%v want %v (pa=%+v)", ok, c.wantOK, pa)
			}
			if !c.wantOK {
				return
			}
			if pa.ID != c.wantID || pa.SessionID != c.wantSess || pa.Tool != c.wantTool {
				t.Fatalf("got %+v, want id=%s sess=%s tool=%s", pa, c.wantID, c.wantSess, c.wantTool)
			}
		})
	}
}

// TestOpencodeServerSmoke exercises the serve-client lifecycle against a real
// `opencode serve` process: start, create a session, fetch it back, stop. It is
// an opt-in integration test for the dedicated official-CLI compatibility
// workflow and makes no LLM call (session creation is free). Uses temp XDG dirs
// to avoid touching the user's real opencode data.
func TestOpencodeServerSmoke(t *testing.T) {
	if os.Getenv("POCKETCTL_OPENCODE_SMOKE") != "1" {
		t.Skip("set POCKETCTL_OPENCODE_SMOKE=1 to run the real OpenCode CLI smoke test")
	}
	cli, err := exec.LookPath("opencode")
	if err != nil {
		t.Skip("opencode not installed; skipping integration smoke test")
	}
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("XDG_STATE_HOME", t.TempDir())

	for _, contract := range []struct {
		args  []string
		flags []string
	}{
		{args: []string{"serve", "--help"}},
		{args: []string{"attach", "--help"}, flags: []string{"--dir", "--session", "--fork"}},
		{args: []string{"run", "--help"}, flags: []string{"--attach", "--dir"}},
	} {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		out, err := exec.CommandContext(ctx, cli, contract.args...).CombinedOutput()
		cancel()
		if err != nil {
			t.Skipf("installed opencode does not expose managed CLI contract %v: %v", contract.args, err)
		}
		for _, flag := range contract.flags {
			if !strings.Contains(string(out), flag) {
				t.Skipf("installed opencode %v does not expose %s", contract.args, flag)
			}
		}
	}

	srv := NewOpencodeServer(cli)
	startCtx, startCancel := context.WithTimeout(context.Background(), 40*time.Second)
	err = srv.Start(startCtx)
	startCancel()
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer srv.Stop()

	if srv.BaseURL() == "" {
		t.Fatal("BaseURL empty after Start")
	}
	healthCtx, healthCancel := context.WithTimeout(context.Background(), 10*time.Second)
	healthy := srv.Healthy(healthCtx)
	healthCancel()
	if !healthy {
		t.Fatal("server not healthy after Start")
	}

	createCtx, createCancel := context.WithTimeout(context.Background(), 15*time.Second)
	sid, err := srv.CreateSession(createCtx, nil, "")
	createCancel()
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if sid == "" {
		t.Fatal("CreateSession returned empty id")
	}

	getCtx, getCancel := context.WithTimeout(context.Background(), 15*time.Second)
	info, err := srv.GetSession(getCtx, sid)
	getCancel()
	if err != nil {
		t.Fatalf("GetSession: %v", err)
	}
	if info.ID != sid {
		t.Fatalf("GetSession id mismatch: got %q want %q", info.ID, sid)
	}
}
