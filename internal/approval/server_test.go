package approval

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/platform"
)

// testIPCPath returns a cross-platform IPC path for test approval servers.
// On Unix it creates a temp dir and returns a socket path inside it (keeps
// the path short for macOS's ~104 char sun_path limit and avoids the
// pocketctl/ subdirectory which production Listen doesn't auto-create).
// On Windows it uses a named pipe name.
func testIPCPath(t *testing.T) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		return platform.NewIPCListener().DefaultPath(fmt.Sprintf("approval-test-%d", os.Getpid()))
	}
	d, err := os.MkdirTemp("", "pcat")
	if err != nil {
		t.Fatalf("mkdtemp: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(d) })
	return filepath.Join(d, fmt.Sprintf("approval-test-%d.sock", os.Getpid()))
}

// TestEnsureAndRemoveHooks verifies the daemon injects a tagged PreToolUse hook
// into settings.local.json and strips only its own entry on cleanup, leaving a
// user's hand-written hooks untouched.
func TestEnsureAndRemoveHooks(t *testing.T) {
	dir := t.TempDir()
	settingsPath := filepath.Join(dir, ".claude", "settings.local.json")

	// Simulate a user with an existing PreToolUse hook.
	if err := os.MkdirAll(filepath.Dir(settingsPath), 0755); err != nil {
		t.Fatal(err)
	}
	existing := map[string]any{
		"hooks": map[string]any{
			"PreToolUse": []any{
				map[string]any{"matcher": ".git", "description": "user-hook"},
			},
		},
	}
	data, _ := json.Marshal(existing)
	if err := os.WriteFile(settingsPath, data, 0644); err != nil {
		t.Fatal(err)
	}

	if err := EnsureHooks(dir, "/usr/local/bin/pocketctl"); err != nil {
		t.Fatalf("EnsureHooks: %v", err)
	}

	// Idempotent: a second call must not duplicate the entry.
	if err := EnsureHooks(dir, "/usr/local/bin/pocketctl"); err != nil {
		t.Fatalf("EnsureHooks (2nd): %v", err)
	}

	got, err := os.ReadFile(settingsPath)
	if err != nil {
		t.Fatal(err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(got, &parsed); err != nil {
		t.Fatal(err)
	}
	hooks, _ := parsed["hooks"].(map[string]any)
	arr, _ := hooks["PreToolUse"].([]any)

	var userCount, managedCount int
	for _, e := range arr {
		m, _ := e.(map[string]any)
		if m["description"] == "user-hook" {
			userCount++
		}
		if m["description"] == HookMarker {
			managedCount++
			cmds, _ := m["hooks"].([]any)
			if len(cmds) != 1 {
				t.Errorf("expected 1 hook command, got %d", len(cmds))
			}
			// Claude Code requires the hook "command" to be a STRING, not an
			// argv array — an array makes Claude reject settings.json and pop a
			// blocking startup menu. Lock that in.
			if hc, _ := cmds[0].(map[string]any); hc != nil {
				cmd, isStr := hc["command"].(string)
				if !isStr {
					t.Errorf("hook command must be a string, got %T (%v)", hc["command"], hc["command"])
				}
				if !strings.Contains(cmd, "__hook") {
					t.Errorf("hook command missing __hook subcommand: %q", cmd)
				}
			}
		}
	}
	if userCount != 1 {
		t.Errorf("user hook not preserved: got %d, want 1", userCount)
	}
	if managedCount != 1 {
		t.Errorf("managed hook not exactly one: got %d, want 1", managedCount)
	}

	// Remove only the daemon's entry.
	if err := RemoveHooks(dir); err != nil {
		t.Fatalf("RemoveHooks: %v", err)
	}
	got, _ = os.ReadFile(settingsPath)
	parsed = map[string]any{}
	_ = json.Unmarshal(got, &parsed)
	hooks, _ = parsed["hooks"].(map[string]any)
	arr, _ = hooks["PreToolUse"].([]any)
	for _, e := range arr {
		m, _ := e.(map[string]any)
		if m["description"] == HookMarker {
			t.Errorf("managed hook not removed on cleanup")
		}
		if m["description"] == "user-hook" {
			return // user hook preserved ✓
		}
	}
	t.Errorf("user hook missing after RemoveHooks")
}

// TestServerResolveRoundTrip verifies the core broker path: a request blocks,
// Resolve unblocks it with the client's decision, and unknown ids error.
func TestServerResolveRoundTrip(t *testing.T) {
	srv := NewServer(testIPCPath(t), nil)

	received := make(chan Request, 1)
	srv.SetOnRequest(func(req Request) { received <- req })

	// Simulate the server's request path: register a pending entry as
	// handleConn would, then resolve it.
	reqID := "req-123"
	ch := make(chan Response, 1)
	srv.mu.Lock()
	srv.pending[reqID] = &pendingEntry{ch: ch, sessionID: "s1"}
	srv.mu.Unlock()

	if err := srv.Resolve(reqID, true); err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	select {
	case resp := <-ch:
		if !resp.Allow {
			t.Errorf("expected allow=true")
		}
	default:
		t.Fatal("Resolve did not deliver to channel")
	}

	// Resolving again must error (already drained).
	if err := srv.Resolve(reqID, true); err == nil {
		t.Error("expected error resolving drained request")
	}
}

// TestServerDrainSession verifies DrainSession denies all pending requests for
// a session so their hook processes exit.
func TestServerDrainSession(t *testing.T) {
	srv := NewServer(testIPCPath(t), nil)
	srv.SetOnRequest(func(Request) {})

	ch1 := make(chan Response, 1)
	ch2 := make(chan Response, 1)
	srv.mu.Lock()
	srv.pending["r1"] = &pendingEntry{ch: ch1, sessionID: "s1"}
	srv.pending["r2"] = &pendingEntry{ch: ch2, sessionID: "s2"}
	srv.mu.Unlock()

	srv.DrainSession("s1")

	select {
	case resp := <-ch1:
		if resp.Allow {
			t.Error("drained request should be denied")
		}
	default:
		t.Error("s1 request not drained")
	}

	// s2 must remain pending.
	srv.mu.Lock()
	_, s2pending := srv.pending["r2"]
	srv.mu.Unlock()
	if !s2pending {
		t.Error("s2 should still be pending after draining s1")
	}
}

// TestServerLocalResolveCancels verifies the terminal-race path: when the hook
// answers locally it sends a {"resolved":...} line and closes; the server must
// drop the pending entry and fire OnCancel with the local decision instead of
// blocking on an App response that will never come.
func TestServerLocalResolveCancels(t *testing.T) {
	// Use platform-specific IPC path (Unix socket on Unix, named pipe on Windows).
	sock := testIPCPath(t)
	defer os.Remove(sock)
	srv := NewServer(sock, nil)

	gotReq := make(chan Request, 1)
	srv.SetOnRequest(func(req Request) { gotReq <- req })

	type cancel struct {
		reqID, sessionID string
		allow            *bool
	}
	gotCancel := make(chan cancel, 1)
	srv.SetOnCancel(func(reqID, sessionID string, allow *bool) {
		gotCancel <- cancel{reqID, sessionID, allow}
	})

	if err := srv.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer srv.Close()

	conn := dialIPC(t, sock)
	defer conn.Close()

	// Send the request line, as the hook does.
	req, _ := json.Marshal(hookRequest{SessionID: "s1", Tool: "Bash", PermMode: "default"})
	if _, err := conn.Write(append(req, '\n')); err != nil {
		t.Fatalf("write request: %v", err)
	}

	// Wait for the server to register + surface the request.
	select {
	case r := <-gotReq:
		if r.SessionID != "s1" {
			t.Fatalf("unexpected session: %q", r.SessionID)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("OnRequest never fired")
	}

	// Answer locally: send the resolved line, then close.
	resolved, _ := json.Marshal(map[string]any{"resolved": true, "allow": true})
	if _, err := conn.Write(append(resolved, '\n')); err != nil {
		t.Fatalf("write resolved: %v", err)
	}
	conn.Close()

	select {
	case c := <-gotCancel:
		if c.reqID == "" {
			t.Errorf("cancel reqID empty")
		}
		if c.sessionID != "s1" {
			t.Errorf("cancel session: got %q want s1", c.sessionID)
		}
		if c.allow == nil || !*c.allow {
			t.Errorf("cancel allow: got %v want true", c.allow)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("OnCancel never fired after local resolve")
	}

	// The pending entry must be gone, so a late App response no-ops.
	srv.mu.Lock()
	n := len(srv.pending)
	srv.mu.Unlock()
	if n != 0 {
		t.Errorf("pending not drained after local resolve: %d", n)
	}
}

func TestServerFinishedLifecycle(t *testing.T) {
	srv := NewServer("unused", nil)
	finished := make(chan Finished, 4)
	srv.SetOnFinished(func(result Finished) { finished <- result })

	srv.pending["approve"] = &pendingEntry{ch: make(chan Response, 1), sessionID: "s1"}
	if err := srv.Resolve("approve", true); err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	result := <-finished
	if result.RequestID != "approve" || result.Reason != FinishApproved || result.Approved == nil || !*result.Approved {
		t.Fatalf("approve result=%#v", result)
	}

	srv.pending["drain"] = &pendingEntry{ch: make(chan Response, 1), sessionID: "s1"}
	srv.pending["other"] = &pendingEntry{ch: make(chan Response, 1), sessionID: "s2"}
	srv.DrainSession("s1")
	result = <-finished
	if result.RequestID != "drain" || result.Reason != FinishSessionDrained || result.Approved != nil {
		t.Fatalf("drain result=%#v", result)
	}
	srv.mu.Lock()
	_, otherPending := srv.pending["other"]
	srv.mu.Unlock()
	if !otherPending {
		t.Fatal("DrainSession removed another session's request")
	}

	if err := srv.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	result = <-finished
	if result.RequestID != "other" || result.Reason != FinishServerShutdown {
		t.Fatalf("shutdown result=%#v", result)
	}
}

func TestServerFinishRaceHasSingleWinner(t *testing.T) {
	for i := 0; i < 100; i++ {
		srv := NewServer("unused", nil)
		var mu sync.Mutex
		var results []Finished
		srv.SetOnFinished(func(result Finished) {
			mu.Lock()
			results = append(results, result)
			mu.Unlock()
		})
		srv.pending["race"] = &pendingEntry{ch: make(chan Response, 1), sessionID: "s1"}

		start := make(chan struct{})
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			<-start
			_ = srv.Resolve("race", true)
		}()
		go func() {
			defer wg.Done()
			<-start
			srv.DrainSession("s1")
		}()
		close(start)
		wg.Wait()

		mu.Lock()
		count := len(results)
		mu.Unlock()
		if count != 1 {
			t.Fatalf("iteration %d produced %d finish callbacks", i, count)
		}
	}
}

func TestServerTimeoutEmitsFinished(t *testing.T) {
	sock := testIPCPath(t)
	defer os.Remove(sock)
	srv := NewServer(sock, nil)
	srv.timeout = 20 * time.Millisecond
	requests := make(chan Request, 1)
	finished := make(chan Finished, 1)
	srv.SetOnRequest(func(request Request) { requests <- request })
	srv.SetOnFinished(func(result Finished) { finished <- result })
	if err := srv.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer srv.Close()

	conn := dialIPC(t, sock)
	defer conn.Close()
	payload, _ := json.Marshal(hookRequest{SessionID: "s1", Tool: "Bash", PermMode: "default"})
	if _, err := conn.Write(append(payload, '\n')); err != nil {
		t.Fatalf("write request: %v", err)
	}
	request := <-requests
	select {
	case result := <-finished:
		if result.RequestID != request.RequestID || result.Reason != FinishTimedOut || result.Approved != nil {
			t.Fatalf("timeout result=%#v", result)
		}
	case <-time.After(time.Second):
		t.Fatal("timeout did not emit OnFinished")
	}
}

// TestHookOutputs verifies the two Claude hook output shapes the hook can emit:
// a continue (no opinion, used in bypassPermissions) and an allow/deny decision.
// Both must be valid JSON Claude can parse.
func TestHookOutputs(t *testing.T) {
	t.Run("writeContinue emits a no-opinion continue", func(t *testing.T) {
		var buf bytes.Buffer
		orig := os.Stdout
		r, w, _ := os.Pipe()
		os.Stdout = w
		writeContinue()
		w.Close()
		os.Stdout = orig
		buf.ReadFrom(r)

		var out map[string]any
		if err := json.Unmarshal(buf.Bytes(), &out); err != nil {
			t.Fatalf("writeContinue produced invalid JSON: %v (%s)", err, buf.String())
		}
		if cont, _ := out["continue"].(bool); !cont {
			t.Errorf("expected continue=true, got %v", out["continue"])
		}
	})

	t.Run("writeDecision emits allow with a reason", func(t *testing.T) {
		var buf bytes.Buffer
		orig := os.Stdout
		r, w, _ := os.Pipe()
		os.Stdout = w
		writeDecision(true, "approved by user")
		w.Close()
		os.Stdout = orig
		buf.ReadFrom(r)

		var out struct {
			HookSpecificOutput struct {
				PermissionDecision       string `json:"permissionDecision"`
				PermissionDecisionReason string `json:"permissionDecisionReason"`
			} `json:"hookSpecificOutput"`
		}
		if err := json.Unmarshal(buf.Bytes(), &out); err != nil {
			t.Fatalf("writeDecision produced invalid JSON: %v (%s)", err, buf.String())
		}
		if out.HookSpecificOutput.PermissionDecision != "allow" {
			t.Errorf("expected allow, got %q", out.HookSpecificOutput.PermissionDecision)
		}
		if out.HookSpecificOutput.PermissionDecisionReason != "approved by user" {
			t.Errorf("unexpected reason: %q", out.HookSpecificOutput.PermissionDecisionReason)
		}
	})

	t.Run("writeDecision emits deny", func(t *testing.T) {
		var buf bytes.Buffer
		orig := os.Stdout
		r, w, _ := os.Pipe()
		os.Stdout = w
		writeDecision(false, "denied")
		w.Close()
		os.Stdout = orig
		buf.ReadFrom(r)

		var out struct {
			HookSpecificOutput struct {
				PermissionDecision string `json:"permissionDecision"`
			} `json:"hookSpecificOutput"`
		}
		_ = json.Unmarshal(buf.Bytes(), &out)
		if out.HookSpecificOutput.PermissionDecision != "deny" {
			t.Errorf("expected deny, got %q", out.HookSpecificOutput.PermissionDecision)
		}
	})
}
