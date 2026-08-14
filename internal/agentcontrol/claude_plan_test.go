package agentcontrol

import (
	"reflect"
	"testing"
)

// TestPlanClaudeChannelEligibleIntents verifies the channel-eligible
// interactive shapes enumerated by design §Task 3.
func TestPlanClaudeChannelEligibleIntents(t *testing.T) {
	tests := []struct {
		name      string
		args      []string
		intent    string
		sessionID string
	}{
		{"empty interactive", nil, IntentNew, ""},
		{"bare prompt", []string{"fix the bug"}, IntentNew, ""},
		{"continue", []string{"--continue"}, IntentContinue, ""},
		{"resume id", []string{"--resume", "abc-123"}, IntentResume, "abc-123"},
		{"resume eq form", []string{"--resume=xyz"}, IntentResume, "xyz"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			plan := PlanClaude(tt.args, "/repo")
			if plan.Mode != LaunchChannel {
				t.Fatalf("mode=%v want LaunchChannel (plan=%+v)", plan.Mode, plan)
			}
			if plan.Intent != tt.intent {
				t.Fatalf("intent=%q want %q", plan.Intent, tt.intent)
			}
			if plan.SessionID != tt.sessionID {
				t.Fatalf("sessionID=%q want %q", plan.SessionID, tt.sessionID)
			}
			if !reflect.DeepEqual(plan.ChannelArgs, tt.args) {
				t.Fatalf("channel args mutated: got=%v want=%v", plan.ChannelArgs, tt.args)
			}
		})
	}
}

// TestPlanClaudeNativeOnlyCommandsAndFlags verifies every native-only escape
// enumerated by design §3.3 produces LaunchNative with no probe and the
// user argv preserved verbatim.
func TestPlanClaudeNativeOnlyCommandsAndFlags(t *testing.T) {
	nativeCases := []struct {
		name string
		args []string
		want []string // expected NativeArgs (verbatim, except --native stripped)
	}{
		{"native alone", []string{"--native"}, nil},
		{"native with resume", []string{"--native", "--resume", "X"}, []string{"--resume", "X"}},
		{"native with prompt", []string{"--native", "fix"}, []string{"fix"}},
		{"help", []string{"--help"}, []string{"--help"}},
		{"help short", []string{"-h"}, []string{"-h"}},
		{"version", []string{"--version"}, []string{"--version"}},
		{"version short", []string{"-v"}, []string{"-v"}},
		{"print short", []string{"-p", "do thing"}, []string{"-p", "do thing"}},
		{"print long", []string{"--print", "do thing"}, []string{"--print", "do thing"}},
		{"bare", []string{"--bare", "do thing"}, []string{"--bare", "do thing"}},
		{"safe-mode", []string{"--safe-mode"}, []string{"--safe-mode"}},
		{"dangerously-skip-permissions", []string{"--dangerously-skip-permissions"}, []string{"--dangerously-skip-permissions"}},
		{"permission-mode bypass space", []string{"--permission-mode", "bypassPermissions"}, []string{"--permission-mode", "bypassPermissions"}},
		{"permission-mode bypass eq", []string{"--permission-mode=bypassPermissions"}, []string{"--permission-mode=bypassPermissions"}},
		{"permission-mode default NOT native", nil, nil}, // sentinel, skipped below
	}
	for _, tt := range nativeCases {
		if tt.args == nil && tt.name == "permission-mode default NOT native" {
			continue
		}
		t.Run(tt.name, func(t *testing.T) {
			plan := PlanClaude(tt.args, "/repo")
			if plan.Mode != LaunchNative {
				t.Fatalf("mode=%v want LaunchNative", plan.Mode)
			}
			if !reflect.DeepEqual(plan.NativeArgs, tt.want) {
				t.Fatalf("native args got=%v want=%v", plan.NativeArgs, tt.want)
			}
		})
	}

	// Native-only subcommands. Design §3.3:
	// "auth, login, logout, mcp, plugin, doctor, update, agents".
	for _, cmd := range []string{"auth", "login", "logout", "mcp", "plugin", "doctor", "update", "agents"} {
		t.Run("subcommand/"+cmd, func(t *testing.T) {
			args := []string{cmd, "sub-arg"}
			plan := PlanClaude(args, "/repo")
			if plan.Mode != LaunchNative || !reflect.DeepEqual(plan.NativeArgs, args) {
				t.Fatalf("plan=%+v", plan)
			}
		})
	}
}

// TestPlanClaudeResumePickerIsNative verifies `claude --resume` without an
// id opens the picker and must run native (no injection).
func TestPlanClaudeResumePickerIsNative(t *testing.T) {
	tests := [][]string{
		{"--resume"},
		{"--resume", "--option"},
		{"--resume="},
	}
	for _, args := range tests {
		plan := PlanClaude(args, "/repo")
		if plan.Mode != LaunchNative {
			t.Fatalf("args=%v mode=%v want LaunchNative", args, plan.Mode)
		}
	}
}

// TestPlanClaudeUnknownFlagFallsBackNative verifies an unknown top-level flag
// falls back to native so the launcher never breaks user args.
func TestPlanClaudeUnknownFlagFallsBackNative(t *testing.T) {
	args := []string{"--some-new-claude-flag", "prompt"}
	plan := PlanClaude(args, "/repo")
	if plan.Mode != LaunchNative || !reflect.DeepEqual(plan.NativeArgs, args) {
		t.Fatalf("plan=%+v", plan)
	}
}

func TestPlanClaudeDoesNotStripNativeAfterDoubleDash(t *testing.T) {
	args := []string{"--", "--native"}
	plan := PlanClaude(args, "/repo")
	if plan.Mode != LaunchNative || !reflect.DeepEqual(plan.NativeArgs, args) {
		t.Fatalf("literal prompt args mutated: plan=%+v want=%v", plan, args)
	}
}

// TestPlanClaudePermissionModeDefaultIsChannelEligible verifies
// `--permission-mode default` does NOT force native (only bypassPermissions
// does). Design §3.3: --permission-mode bypassPermissions is the only
// permission-mode value that forces native.
func TestPlanClaudePermissionModeDefaultIsChannelEligible(t *testing.T) {
	args := []string{"--permission-mode", "default"}
	plan := PlanClaude(args, "/repo")
	// "default" with no prompt is an interactive new session: channel-eligible.
	if plan.Mode != LaunchChannel {
		t.Fatalf("mode=%v want LaunchChannel (plan=%+v)", plan.Mode, plan)
	}
}

// TestPlanClaudePromptWithSessionOptionFallsBackNative verifies a prompt
// combined with a session option (continue/resume) is ambiguous and falls
// back native.
func TestPlanClaudePromptWithSessionOptionFallsBackNative(t *testing.T) {
	args := []string{"fix the bug", "--resume", "abc"}
	plan := PlanClaude(args, "/repo")
	if plan.Mode != LaunchNative {
		t.Fatalf("mode=%v want LaunchNative (ambiguous prompt+session)", plan.Mode)
	}
}
