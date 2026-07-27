package agentcontrol

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestOpenCodeLaunchPlan(t *testing.T) {
	repo := t.TempDir()
	project := filepath.Join(repo, "project")
	if err := os.MkdirAll(project, 0o755); err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name      string
		args      []string
		mode      LaunchMode
		intent    string
		cwd       string
		sessionID string
		fork      bool
		native    []string
		warn      bool
	}{
		{name: "new", mode: LaunchManaged, intent: IntentNew, cwd: repo},
		{name: "project", args: []string{"./project"}, mode: LaunchManaged, intent: IntentNew, cwd: project},
		{name: "continue short", args: []string{"-c"}, mode: LaunchManaged, intent: IntentContinue, cwd: repo},
		{name: "continue long", args: []string{"--continue"}, mode: LaunchManaged, intent: IntentContinue, cwd: repo},
		{name: "resume", args: []string{"-s", "ses_123"}, mode: LaunchManaged, intent: IntentResume, sessionID: "ses_123", cwd: repo},
		{name: "resume equals", args: []string{"--session=ses_123", "--fork"}, mode: LaunchManaged, intent: IntentResume, sessionID: "ses_123", fork: true, cwd: repo},
		{name: "fork without base session", args: []string{"--fork"}, mode: LaunchNative, native: []string{"--fork"}, warn: true},
		{name: "run", args: []string{"run", "fix tests"}, mode: LaunchManaged, intent: IntentRun, cwd: repo},
		{name: "explicit run attach", args: []string{"run", "--attach", "http://127.0.0.1:4096", "fix"}, mode: LaunchNative, native: []string{"run", "--attach", "http://127.0.0.1:4096", "fix"}},
		{name: "serve", args: []string{"serve"}, mode: LaunchNative, native: []string{"serve"}},
		{name: "attach", args: []string{"attach", "http://127.0.0.1:4096"}, mode: LaunchNative, native: []string{"attach", "http://127.0.0.1:4096"}},
		{name: "web", args: []string{"web"}, mode: LaunchNative, native: []string{"web"}},
		{name: "management", args: []string{"mcp", "list"}, mode: LaunchNative, native: []string{"mcp", "list"}},
		{name: "agent management", args: []string{"agent", "list"}, mode: LaunchNative, native: []string{"agent", "list"}},
		{name: "session management", args: []string{"session", "list"}, mode: LaunchNative, native: []string{"session", "list"}},
		{name: "escape", args: []string{"--native", "-c"}, mode: LaunchNative, native: []string{"-c"}},
		{name: "unknown flag", args: []string{"--prompt", "hello"}, mode: LaunchNative, native: []string{"--prompt", "hello"}, warn: true},
		{name: "unknown command", args: []string{"frobnicate"}, mode: LaunchNative, native: []string{"frobnicate"}, warn: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := PlanOpenCode(tt.args, repo)
			if got.Mode != tt.mode || got.Intent != tt.intent || (tt.cwd != "" && got.CWD != tt.cwd) || got.SessionID != tt.sessionID || got.Fork != tt.fork || got.Warn != tt.warn {
				t.Fatalf("plan=%+v", got)
			}
			if !reflect.DeepEqual(got.NativeArgs, tt.native) {
				t.Fatalf("native args=%q, want %q", got.NativeArgs, tt.native)
			}
		})
	}
}

func TestOpenCodeManagedArgs(t *testing.T) {
	repo := t.TempDir()
	result := AcquireResult{BaseURL: "http://127.0.0.1:4096", ResolvedSessionID: "ses_new"}
	interactive := PlanOpenCode([]string{"-c", "--fork"}, repo)
	if got, want := interactive.ManagedArgs(result), []string{"attach", result.BaseURL, "--dir", repo, "--session", "ses_new", "--fork"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("interactive args=%q, want %q", got, want)
	}
	run := PlanOpenCode([]string{"run", "fix tests"}, repo)
	if got, want := run.ManagedArgs(result), []string{"run", "--attach", result.BaseURL, "--dir", repo, "--session", "ses_new", "fix tests"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("run args=%q, want %q", got, want)
	}
	runWithDir := PlanOpenCode([]string{"run", "--dir", "/other", "fix"}, repo)
	if got, want := runWithDir.ManagedArgs(result), []string{"run", "--attach", result.BaseURL, "--session", "ses_new", "--dir", "/other", "fix"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("run args=%q, want %q", got, want)
	}
}
