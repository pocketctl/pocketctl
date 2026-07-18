package main

import "testing"

func TestOpenCodeLauncherInvocation(t *testing.T) {
	tests := []struct {
		argv0 string
		args  []string
		want  bool
	}{
		{"/Users/me/.pocketctl/bin/opencode", nil, true},
		{"opencode.exe", nil, true},
		{"pocketctl", []string{"__agent-launch", "opencode", "-c"}, true},
		{"pocketctl", []string{"daemon", "start"}, false},
	}
	for _, tt := range tests {
		if got := isOpenCodeLauncherInvocation(tt.argv0, tt.args); got != tt.want {
			t.Fatalf("argv0=%q args=%q got=%v want=%v", tt.argv0, tt.args, got, tt.want)
		}
	}
}

func TestCodexLauncherInvocation(t *testing.T) {
	tests := []struct {
		argv0 string
		args  []string
		want  bool
	}{
		{"/Users/me/.pocketctl/bin/codex", nil, true},
		{"codex.exe", nil, true},
		{"pocketctl", []string{"__agent-launch", "codex", "resume", "id"}, true},
		{"pocketctl", []string{"__agent-launch", "opencode"}, false},
	}
	for _, tt := range tests {
		if got := isCodexLauncherInvocation(tt.argv0, tt.args); got != tt.want {
			t.Fatalf("argv0=%q args=%q got=%v want=%v", tt.argv0, tt.args, got, tt.want)
		}
	}
}
