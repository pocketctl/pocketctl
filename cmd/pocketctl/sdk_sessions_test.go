package main

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/session"
	"github.com/pocketctl/pocketctl/internal/watcher"
)

func TestIsSDKSpawnedSession(t *testing.T) {
	for _, tc := range []struct {
		entrypoint string
		want       bool
	}{
		{"sdk-py", true},
		{"sdk-ts", true},
		{"sdk", true},
		{"cli", false},
		{"", false},
		{"sdklike", true}, // prefix semantics: future sdk runtimes qualify
		{"ssdk", false},
	} {
		if got := isSDKSpawnedSession(watcher.DiscoveredSession{Entrypoint: tc.entrypoint}); got != tc.want {
			t.Errorf("isSDKSpawnedSession(%q) = %v, want %v", tc.entrypoint, got, tc.want)
		}
	}
}

func TestHandleSDKSpawnedSession(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	const cwd = "/repo"

	// Attachment runs on its own goroutine; shrink the retry cadence so the
	// failure paths return promptly instead of waiting the production budget.
	origInterval, origAttempts := sdkJSONLRetryInterval, sdkJSONLRetryAttempts
	sdkJSONLRetryInterval, sdkJSONLRetryAttempts = 5*time.Millisecond, 3
	t.Cleanup(func() { sdkJSONLRetryInterval, sdkJSONLRetryAttempts = origInterval, origAttempts })

	writeJSONL := func(t *testing.T) string {
		t.Helper()
		path := filepath.Join(t.TempDir(), "sdk-session.jsonl")
		content := `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Review this change for security vulnerabilities."}]},"sessionId":"sdk-1","cwd":"` + cwd + `"}` + "\n"
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		return path
	}

	restoreResolver := func(fn func(string, string) (string, error)) func() {
		orig := resolveSDKJSONLPath
		resolveSDKJSONLPath = fn
		return func() { resolveSDKJSONLPath = orig }
	}

	awaitEvent := func(t *testing.T, out chan protocol.DaemonEvent) protocol.DaemonEvent {
		t.Helper()
		select {
		case ev := <-out:
			return ev
		case <-time.After(2 * time.Second):
			t.Fatal("timed out waiting for subagent_discovered event")
			return protocol.DaemonEvent{}
		}
	}

	assertNoEvent := func(t *testing.T, out chan protocol.DaemonEvent) {
		t.Helper()
		select {
		case ev := <-out:
			t.Fatalf("expected no events, got %q", ev.Type)
		case <-time.After(150 * time.Millisecond):
		}
	}

	registerHost := func() (*session.SessionManager, chan protocol.DaemonEvent) {
		out := make(chan protocol.DaemonEvent, 8)
		sm := session.NewSessionManager(out)
		sm.RegisterTerminalSession("host-1", cwd, 0, "", "busy", adapter.AgentClaude)
		sm.RestoreSessionActivity("host-1", time.Now())
		return sm, out
	}

	t.Run("attaches to host with sdk_session kind and title", func(t *testing.T) {
		jsonlPath := writeJSONL(t)
		defer restoreResolver(func(string, string) (string, error) { return jsonlPath, nil })()

		sm, out := registerHost()
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()

		handleSDKSpawnedSession(ctx, sm, watcher.SessionEvent{Session: watcher.DiscoveredSession{
			SessionID: "sdk-1", Cwd: cwd, Entrypoint: "sdk-py",
		}}, logger, out)

		ev := awaitEvent(t, out)
		if ev.Type != "subagent_discovered" {
			t.Fatalf("event type = %q, want subagent_discovered", ev.Type)
		}
		if ev.SessionID != "host-1" || ev.ParentSessionID != "host-1" || ev.RootSessionID != "host-1" {
			t.Fatalf("host fields = %q/%q/%q, want host-1", ev.SessionID, ev.ParentSessionID, ev.RootSessionID)
		}
		if ev.AgentID != "sdk-1" {
			t.Fatalf("agent id = %q, want sdk-1", ev.AgentID)
		}
		if ev.SubagentKind != sdkSessionSubagentKind {
			t.Fatalf("subagent kind = %q, want %q", ev.SubagentKind, sdkSessionSubagentKind)
		}
		if ev.SubAgentDesc == "" {
			t.Fatal("expected title from first user message")
		}
	})

	t.Run("retries jsonl resolution across the cold-start window", func(t *testing.T) {
		jsonlPath := writeJSONL(t)
		calls := 0
		defer restoreResolver(func(string, string) (string, error) {
			calls++
			if calls < 3 {
				return "", os.ErrNotExist // per-PID file beats jsonl on disk
			}
			return jsonlPath, nil
		})()

		sm, out := registerHost()
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()

		handleSDKSpawnedSession(ctx, sm, watcher.SessionEvent{Session: watcher.DiscoveredSession{
			SessionID: "sdk-1", Cwd: cwd, Entrypoint: "sdk-py",
		}}, logger, out)

		if ev := awaitEvent(t, out); ev.AgentID != "sdk-1" {
			t.Fatalf("agent id = %q, want sdk-1 after retry", ev.AgentID)
		}
	})

	t.Run("drops session when no host is active", func(t *testing.T) {
		defer restoreResolver(func(string, string) (string, error) { return writeJSONL(t), nil })()

		out := make(chan protocol.DaemonEvent, 8)
		sm := session.NewSessionManager(out)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()

		handleSDKSpawnedSession(ctx, sm, watcher.SessionEvent{Session: watcher.DiscoveredSession{
			SessionID: "sdk-2", Cwd: cwd, Entrypoint: "sdk-py",
		}}, logger, out)

		assertNoEvent(t, out)
	})

	t.Run("drops session when jsonl never resolves", func(t *testing.T) {
		defer restoreResolver(func(string, string) (string, error) { return "", os.ErrNotExist })()

		sm, out := registerHost()
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()

		handleSDKSpawnedSession(ctx, sm, watcher.SessionEvent{Session: watcher.DiscoveredSession{
			SessionID: "sdk-3", Cwd: cwd, Entrypoint: "sdk-py",
		}}, logger, out)

		assertNoEvent(t, out)
	})
}

func TestSDKSessionTitle(t *testing.T) {
	longReview := strings.Repeat("Review this change for security vulnerabilities. Changed files: ", 200) // >2000 chars

	for _, tc := range []struct {
		name string
		json string
		want string
	}{
		{
			name: "long string content bypasses interactive-session length filter",
			json: `{"type":"queue-operation"}` + "\n" +
				`{"type":"user","message":{"role":"user","content":"` + longReview + `"}}` + "\n",
			want: truncateSDKTitle(longReview),
		},
		{
			name: "array content text block is used",
			json: `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Review commit a1b2c3d"}]}}` + "\n",
			want: "Review commit a1b2c3d",
		},
		{
			name: "non-user records are skipped",
			json: `{"type":"queue-operation"}` + "\n" +
				`{"type":"assistant","message":{"role":"assistant","content":"nope"}}` + "\n",
			want: "",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "sdk.jsonl")
			if err := os.WriteFile(path, []byte(tc.json), 0o600); err != nil {
				t.Fatal(err)
			}
			if got := sdkSessionTitle(path); got != tc.want {
				t.Fatalf("sdkSessionTitle = %q, want %q", got, tc.want)
			}
		})
	}
}
