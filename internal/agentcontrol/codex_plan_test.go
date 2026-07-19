package agentcontrol

import (
	"reflect"
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
			wantArgs := append(append([]string(nil), tt.args...), "--remote", "unix:///tmp/pocketctl-codex.sock")
			if got := plan.ManagedArgs("unix:///tmp/pocketctl-codex.sock"); !reflect.DeepEqual(got, wantArgs) {
				t.Fatalf("managed args=%v want %v", got, wantArgs)
			}
		})
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
