package approval

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

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
	srv := NewServer("/tmp/nonexistent-approval-test.sock", nil)

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
	srv := NewServer("/tmp/nonexistent-approval-test.sock", nil)
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
