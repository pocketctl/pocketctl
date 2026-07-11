package adapter

import (
	"fmt"
	"testing"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestValidatePermissionConfigCreationMatrix(t *testing.T) {
	tests := []struct {
		name    string
		agent   string
		cfg     *protocol.PermissionConfig
		wantErr bool
	}{
		{"claude manual", AgentClaude, &protocol.PermissionConfig{Agent: AgentClaude, Mode: "manual"}, false},
		{"claude auto", AgentClaude, &protocol.PermissionConfig{Agent: AgentClaude, Mode: "auto"}, false},
		{"claude accept edits", AgentClaude, &protocol.PermissionConfig{Agent: AgentClaude, Mode: "acceptEdits"}, false},
		{"claude dont ask", AgentClaude, &protocol.PermissionConfig{Agent: AgentClaude, Mode: "dontAsk"}, false},
		{"claude plan", AgentClaude, &protocol.PermissionConfig{Agent: AgentClaude, Mode: "plan"}, false},
		{"claude bypass", AgentClaude, &protocol.PermissionConfig{Agent: AgentClaude, Mode: "bypassPermissions"}, false},
		{"claude legacy default", AgentClaude, &protocol.PermissionConfig{Agent: AgentClaude, Mode: "default"}, true},
		{"claude codex field", AgentClaude, &protocol.PermissionConfig{Agent: AgentClaude, Mode: "plan", SandboxMode: "read-only"}, true},
		{"codex never workspace", AgentCodex, &protocol.PermissionConfig{Agent: AgentCodex, Preset: "custom", ApprovalPolicy: "never", SandboxMode: "workspace-write"}, false},
		{"codex inherited custom", AgentCodex, &protocol.PermissionConfig{Agent: AgentCodex, Preset: "custom"}, false},
		{"codex dangerous", AgentCodex, &protocol.PermissionConfig{Agent: AgentCodex, Preset: "full_access", DangerousBypass: true}, false},
		{"codex conflicting dangerous", AgentCodex, &protocol.PermissionConfig{Agent: AgentCodex, DangerousBypass: true, ApprovalPolicy: "never"}, true},
		{"codex claude field", AgentCodex, &protocol.PermissionConfig{Agent: AgentCodex, Mode: "plan"}, true},
		{"agent mismatch", AgentClaude, &protocol.PermissionConfig{Agent: AgentCodex, Preset: "custom"}, true},
		{"opencode rejects", AgentOpencode, &protocol.PermissionConfig{Agent: AgentOpencode}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidatePermissionConfig(tt.agent, tt.cfg)
			if (err != nil) != tt.wantErr {
				t.Fatalf("ValidatePermissionConfig() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func TestPermissionArgs(t *testing.T) {
	tests := []struct {
		name, agent string
		cfg         protocol.PermissionConfig
		want        []string
	}{
		{"claude", AgentClaude, protocol.PermissionConfig{Agent: AgentClaude, Mode: "plan"}, []string{"--permission-mode", "plan"}},
		{"codex", AgentCodex, protocol.PermissionConfig{Agent: AgentCodex, Preset: "custom", ApprovalPolicy: "never", SandboxMode: "workspace-write"}, []string{"-c", `approval_policy="never"`, "-c", `sandbox_mode="workspace-write"`}},
		{"bypass", AgentCodex, protocol.PermissionConfig{Agent: AgentCodex, Preset: "full_access", DangerousBypass: true}, []string{"--dangerously-bypass-approvals-and-sandbox"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := PermissionArgs(tt.agent, &tt.cfg, CommandCreate)
			if err != nil {
				t.Fatal(err)
			}
			if fmt.Sprint(got) != fmt.Sprint(tt.want) {
				t.Fatalf("got %v want %v", got, tt.want)
			}
		})
	}
}
