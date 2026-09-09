package agentcontrol

import (
	"reflect"
	"strings"
	"testing"
)

func TestPlanCodexManagedOfficialTUIShapes(t *testing.T) {
	tests := []struct {
		name      string
		args      []string
		intent    string
		sessionID string
	}{
		{"empty", nil, IntentNew, ""},
		{"prompt", []string{"explain this repository"}, IntentNew, ""},
		{"resume id", []string{"resume", "019f-thread"}, IntentResume, "019f-thread"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			plan := PlanCodex(tt.args, "/repo")
			if plan.Mode != LaunchManaged || plan.Intent != tt.intent || plan.SessionID != tt.sessionID {
				t.Fatalf("plan=%+v", plan)
			}
			wantArgs := append([]string(nil), tt.args...)
			if tt.intent == IntentNew {
				wantArgs = append(wantArgs, "--cd", "/repo")
			}
			wantArgs = append(wantArgs, "--remote", "unix:///tmp/pocketctl-codex.sock")
			if got := plan.ManagedArgs("unix:///tmp/pocketctl-codex.sock"); !reflect.DeepEqual(got, wantArgs) {
				t.Fatalf("managed args=%v want %v", got, wantArgs)
			}
		})
	}
}

func TestCodexManagedDirectoryOverridesAndArgumentBoundary(t *testing.T) {
	const remote = "unix:///tmp/codex.sock"
	for _, args := range [][]string{
		{"--cd", "/other repo", "hello"},
		{"--cd=../other", "hello"},
		{"-C", "../other", "hello"},
		{"-C../other", "hello"},
		{"-C=../other", "hello"},
		{"resume", "thread-1"},
		{"resume", "thread-1", "--cd", "/other repo"},
	} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			plan := PlanCodex(args, "/launch repo")
			want := append(append([]string(nil), args...), "--remote", remote)
			if got := plan.ManagedArgs(remote); !reflect.DeepEqual(got, want) {
				t.Fatalf("args=%v want=%v", got, want)
			}
		})
	}
	plan := PlanCodex([]string{"--", "--cd=prompt-text"}, "/launch repo")
	want := []string{"--cd", "/launch repo", "--remote", remote, "--", "--cd=prompt-text"}
	if got := plan.ManagedArgs(remote); !reflect.DeepEqual(got, want) {
		t.Fatalf("args=%v want=%v", got, want)
	}
}

func TestPlanCodexKeepsAdministrativeAndNonInteractiveCommandsNative(t *testing.T) {
	commands := []string{
		"exec", "review", "login", "logout", "mcp", "plugin", "mcp-server",
		"app-server", "remote-control", "app", "completion", "update", "doctor",
		"sandbox", "debug", "apply", "archive", "delete", "unarchive", "fork",
		"cloud", "exec-server", "features", "help",
	}
	for _, command := range commands {
		t.Run(command, func(t *testing.T) {
			args := []string{command, "--help"}
			plan := PlanCodex(args, "/repo")
			if plan.Mode != LaunchNative || !reflect.DeepEqual(plan.NativeArgs, args) {
				t.Fatalf("plan=%+v", plan)
			}
		})
	}
}

func TestPlanCodexNativeEscapeAndExistingRemoteAreNotRewritten(t *testing.T) {
	tests := []struct {
		args []string
		want []string
	}{
		{[]string{"--native", "hello"}, []string{"hello"}},
		{[]string{"resume", "id", "--native"}, []string{"resume", "id"}},
		{[]string{"resume", "id", "--remote", "unix:///other.sock"}, []string{"resume", "id", "--remote", "unix:///other.sock"}},
		{[]string{"--help"}, []string{"--help"}},
		{[]string{"resume", "--last"}, []string{"resume", "--last"}},
	}
	for _, tt := range tests {
		plan := PlanCodex(tt.args, "/repo")
		if plan.Mode != LaunchNative || !reflect.DeepEqual(plan.NativeArgs, tt.want) {
			t.Fatalf("args=%v plan=%+v", tt.args, plan)
		}
	}
}
