package main

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/session"
	"github.com/pocketctl/pocketctl/internal/watcher"
)

func TestUpgradeGateDecision(t *testing.T) {
	cases := []struct {
		name        string
		found       bool
		manageable  bool
		agentName   string
		path        string
		wantProceed bool
		wantStatus  string
		wantReason  string
		wantErr     string
	}{
		{
			name:        "not installed",
			found:       false,
			manageable:  false,
			agentName:   "claude-code",
			path:        "",
			wantProceed: false,
			wantStatus:  "failed",
			wantReason:  "",
			wantErr:     "claude-code 未安装",
		},
		{
			name:        "system root-owned install",
			found:       true,
			manageable:  false,
			agentName:   "claude-code",
			path:        "/usr/local/bin/claude",
			wantProceed: false,
			wantStatus:  "failed",
			wantReason:  protocol.ReasonPermissionDenied,
			wantErr:     "/usr/local/bin/claude 为系统(root)安装，pocketctl 无法升级，请自行 sudo-free 升级",
		},
		{
			name:        "manageable user install proceeds",
			found:       true,
			manageable:  true,
			agentName:   "claude-code",
			path:        "/Users/me/.local/bin/claude",
			wantProceed: true,
			wantStatus:  "",
			wantReason:  "",
			wantErr:     "",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			proceed, status, reason, errMsg := upgradeGateDecision(tc.found, tc.manageable, tc.agentName, tc.path)
			if proceed != tc.wantProceed {
				t.Errorf("proceed = %v, want %v", proceed, tc.wantProceed)
			}
			if status != tc.wantStatus {
				t.Errorf("status = %q, want %q", status, tc.wantStatus)
			}
			if reason != tc.wantReason {
				t.Errorf("reason = %q, want %q", reason, tc.wantReason)
			}
			if errMsg != tc.wantErr {
				t.Errorf("errMsg = %q, want %q", errMsg, tc.wantErr)
			}
		})
	}

	// reason must be permission_denied ONLY for the !manageable case.
	if _, _, reason, _ := upgradeGateDecision(false, false, "x", ""); reason != "" {
		t.Errorf("!found reason should be empty, got %q", reason)
	}
	if _, _, reason, _ := upgradeGateDecision(true, false, "x", "/p"); reason != protocol.ReasonPermissionDenied {
		t.Errorf("!manageable reason should be permission_denied, got %q", reason)
	}
}

func TestIsPermissionDenied(t *testing.T) {
	for _, s := range []string{"npm ERR! EACCES", "Error: EPERM", "permission denied", "Insufficient permissions"} {
		if !isPermissionDenied(s) {
			t.Errorf("expected permission-denied for %q", s)
		}
	}
	for _, s := range []string{"network timeout", "404 not found", ""} {
		if isPermissionDenied(s) {
			t.Errorf("unexpected permission-denied for %q", s)
		}
	}
}

func TestClassifyCreateErrorBadCwd(t *testing.T) {
	for _, msg := range []string{
		"工作目录不存在: /Users/me/projcts/pocketctl-test",
		"工作目录创建失败: /Users/me/projcts/pocketctl-test (mkdir /Users/me/projcts: permission denied)",
		"工作目录无法访问: /Users/me/repo (permission denied)",
	} {
		if got := classifyCreateError(msg); got != "bad_cwd" {
			t.Errorf("classifyCreateError(%q) = %q, want bad_cwd", msg, got)
		}
	}
}

// TestStartSpinnerNonTTY verifies the spinner degrades cleanly when stdout is
// not a terminal: it prints the message once (no escape codes), and the
// returned stop function is safe to call.
func TestStartSpinnerNonTTY(t *testing.T) {
	// In `go test`, os.Stdout is a pipe (not a char device), so startSpinner
	// takes the non-TTY branch.
	stop := startSpinner("starting test")
	if stop == nil {
		t.Fatal("startSpinner returned nil stop func")
	}
	stop() // must not panic or block
}

func TestPruneOrphanSpools(t *testing.T) {
	dir := t.TempDir()
	mk := func(name string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	const id = "daemon-abc123"
	mk(id + ".log")         // current — keep
	mk(id + ".log.tmp")     // current's transient rewrite — keep
	mk("daemon-old111.log") // orphan — remove
	mk("daemon-old222.log") // orphan — remove
	mk("notes.txt")         // unrelated — keep

	pruneOrphanSpools(dir, id, slog.New(slog.NewTextHandler(io.Discard, nil)))

	got := map[string]bool{}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		got[e.Name()] = true
	}
	for _, want := range []string{id + ".log", id + ".log.tmp", "notes.txt"} {
		if !got[want] {
			t.Errorf("expected %q kept, but it was removed", want)
		}
	}
	for _, gone := range []string{"daemon-old111.log", "daemon-old222.log"} {
		if got[gone] {
			t.Errorf("expected orphan %q removed, but it remains", gone)
		}
	}
}

func TestReconnectDiscoveryEventIsMarkedAsResync(t *testing.T) {
	event := reconnectDiscoveryEvent(session.SessionInfo{
		SessionID: "session-a",
		Cwd:       "/tmp/project",
		Status:    protocol.StatusCompleted,
		Agent:     "codex",
		Model:     "gpt-5.3-codex",
	})

	if event.Type != "session_discovered" || !event.Resync {
		t.Fatalf("event = %#v, want resync session_discovered", event)
	}
	if event.SessionID != "session-a" || event.Source != "terminal" {
		t.Fatalf("event = %#v, want session identity and source preserved", event)
	}
}

func TestCodexSubagentDiscoveryEvent(t *testing.T) {
	tests := []struct {
		name     string
		session  watcher.DiscoveredSession
		wantDesc string
	}{
		{
			name:     "nickname",
			session:  watcher.DiscoveredSession{SessionID: "child", RootSessionID: "root", AgentNickname: "Newton", AgentPath: "/root/task"},
			wantDesc: "Newton",
		},
		{
			name:     "agent path basename",
			session:  watcher.DiscoveredSession{SessionID: "child", RootSessionID: "root", AgentPath: "/root/keyboard_task2_impl"},
			wantDesc: "keyboard_task2_impl",
		},
		{
			name:     "short id",
			session:  watcher.DiscoveredSession{SessionID: "019f4ad3-342e-7213-a51f-2758edf9ec6b", RootSessionID: "root"},
			wantDesc: "edf9ec6b",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := codexSubagentDiscoveryEvent(tt.session)
			if got.Type != "subagent_discovered" || got.SessionID != "root" ||
				got.EventID != "codex-subagent:"+tt.session.SessionID+":discovery" ||
				got.AgentID != tt.session.SessionID || got.ParentSessionID != "root" ||
				got.RootSessionID != "root" || !got.IsSubagent || got.Agent != adapter.AgentCodex ||
				got.SubAgentType != adapter.AgentCodex || got.SubAgentDesc != tt.wantDesc {
				t.Fatalf("event = %+v", got)
			}
		})
	}
}
