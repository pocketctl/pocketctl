package session

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/approval"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestClaudeResumeWiresManagedApproval(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix sentinel CLI fixture")
	}
	for _, live := range []bool{false, true} {
		for _, mode := range []string{"default", "plan", "bypassPermissions", ""} {
			name := mode
			if live {
				name += "/idle-terminal"
			} else {
				name += "/historical"
			}
			t.Run(name, func(t *testing.T) {
				cwd := t.TempDir()
				installSentinelResumeCLI(t, "claude")
				t.Setenv("POCKETCTL_SESSION_ID", "stale-parent")
				t.Setenv("POCKETCTL_APPROVAL_SOCK", "stale-socket")
				t.Setenv("POCKETCTL_PERM_MODE", "bypassPermissions")
				sm := NewSessionManager(make(chan protocol.DaemonEvent, 32))
				server := approval.NewServer(filepath.Join(cwd, "approval.sock"), nil)
				sm.SetApprovalServer(server, "/fixture/pocketctl")
				ps := &ProcessState{SessionID: "resume-approval", Agent: adapter.AgentClaude, Source: "terminal", Status: protocol.StatusExited, Cwd: cwd}
				if live {
					ps.Pid, ps.Status = os.Getpid(), protocol.StatusIdle
				}
				if mode != "" {
					ps.Permission = &protocol.PermissionConfig{Agent: adapter.AgentClaude, Mode: mode}
				}
				sm.sessions[ps.SessionID] = ps
				starter := newRecordingResumeStarter()
				sm.setResumeStarter(starter.call)
				t.Cleanup(starter.finishAll)
				if err := sm.SendMessage(context.Background(), ps.SessionID, "resume fixture"); err != nil {
					t.Fatal(err)
				}
				specs, _ := starter.snapshot()
				if len(specs) != 1 {
					t.Fatalf("starts=%d", len(specs))
				}
				wantMode := mode
				if wantMode == "" {
					wantMode = "acceptEdits"
				}
				for key, want := range map[string]string{"POCKETCTL_SESSION_ID": ps.SessionID, "POCKETCTL_APPROVAL_SOCK": server.SocketPath(), "POCKETCTL_PERM_MODE": wantMode} {
					count := 0
					for _, entry := range specs[0].Env {
						if strings.HasPrefix(entry, key+"=") {
							count++
							if entry != key+"="+want {
								t.Errorf("%s = %q, want %q", key, entry, want)
							}
						}
					}
					if count != 1 {
						t.Errorf("%s entries=%d, want exactly one", key, count)
					}
				}
				if !strings.Contains(strings.Join(specs[0].Args, " "), "--permission-mode "+wantMode) {
					t.Errorf("permission args=%v", specs[0].Args)
				}
				data, err := os.ReadFile(filepath.Join(cwd, ".claude", "settings.local.json"))
				if err != nil || !strings.Contains(string(data), approval.HookMarker) {
					t.Errorf("managed hook missing: %v", err)
				}
			})
		}
	}
}

func TestClaudeResumeDoesNotStartWithoutApprovalHook(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix sentinel CLI fixture")
	}
	for _, live := range []bool{false, true} {
		t.Run(map[bool]string{false: "historical", true: "idle-terminal"}[live], func(t *testing.T) {
			cwd := t.TempDir()
			if err := os.WriteFile(filepath.Join(cwd, ".claude"), []byte("not a directory"), 0600); err != nil {
				t.Fatal(err)
			}
			installSentinelResumeCLI(t, "claude")
			sm := NewSessionManager(make(chan protocol.DaemonEvent, 32))
			sm.SetApprovalServer(approval.NewServer(filepath.Join(cwd, "approval.sock"), nil), "/fixture/pocketctl")
			ps := &ProcessState{SessionID: "blocked", Agent: adapter.AgentClaude, Source: "terminal", Status: protocol.StatusExited, Cwd: cwd}
			if live {
				ps.Pid, ps.Status = os.Getpid(), protocol.StatusIdle
			}
			sm.sessions[ps.SessionID] = ps
			starter := newRecordingResumeStarter()
			sm.setResumeStarter(starter.call)
			t.Cleanup(starter.finishAll)
			if err := sm.SendMessage(context.Background(), ps.SessionID, "do not launch"); err == nil {
				t.Error("expected hook installation failure")
			}
			if specs, _ := starter.snapshot(); len(specs) != 0 {
				t.Error("started without an approval hook")
			}
		})
	}
}

func TestClaudeResumeIgnoresTerminalWatcherIdle(t *testing.T) {
	output := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(output)
	sm.sessions["owned"] = &ProcessState{SessionID: "owned", Agent: adapter.AgentClaude, Source: "terminal", Status: protocol.StatusRunning, Cwd: t.TempDir()}
	entry := mustRegisterOwnedResume(t, sm, "owned", func() {}, newFakeResumeProcess(os.Getpid(), ""))
	defer sm.finishOwnedResume(entry, nil)
	// Claude -p advertises sdk-cli and briefly idle during startup. Its stdout
	// result/Wait owns completion; this watcher observation is not turn evidence.
	if sm.SyncLiveTerminalSession("owned", "", os.Getpid(), "", protocol.StatusIdle, adapter.AgentClaude) {
		t.Error("watcher took ownership of active resume")
	}
	if sm.sessions["owned"].Status != protocol.StatusRunning {
		t.Error("watcher prematurely completed active resume")
	}
	select {
	case event := <-output:
		t.Errorf("unexpected watcher lifecycle event: %s/%s", event.Type, event.Status)
	default:
	}
}
