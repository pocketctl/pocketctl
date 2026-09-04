package adapter

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestClassifyCodexOrigin_FromRolloutMetadataFixtures(t *testing.T) {
	tests := []struct {
		name       string
		originator string
		source     string
		wantAgent  string
		classified bool
	}{
		{name: "Codex Desktop plus vscode", originator: "Codex Desktop", source: `"vscode"`, wantAgent: "codex-desktop", classified: true},
		{name: "codex work desktop plus vscode", originator: "codex_work_desktop", source: `"vscode"`, wantAgent: "codex-desktop", classified: true},
		{name: "codex tui plus cli", originator: "codex-tui", source: `"cli"`, wantAgent: "codex", classified: true},
		{name: "codex exec plus exec", originator: "codex_exec", source: `"exec"`, wantAgent: "codex", classified: true},
		{name: "pocketctl plus vscode", originator: "pocketctl", source: `"vscode"`, wantAgent: "codex", classified: true},
		{name: "unknown plus cli", originator: "unknown", source: `"cli"`, wantAgent: "codex", classified: true},
		{name: "missing plus vscode", source: `"vscode"`, wantAgent: "codex", classified: false},
		{name: "normalized Codex Desktop ignores nonstandard source", originator: " \tCoDeX DeSkToP\n", source: `"other"`, wantAgent: "codex-desktop", classified: true},
		{name: "normalized work desktop ignores object source", originator: " CODEX_WORK_DESKTOP ", source: `{"subagent":"review"}`, wantAgent: "codex-desktop", classified: true},
		{name: "codex tui ignores object source", originator: "codex-tui", source: `{"subagent":"review"}`, wantAgent: "codex", classified: true},
		{name: "codex exec ignores vscode source", originator: "codex_exec", source: `"vscode"`, wantAgent: "codex", classified: true},
		{name: "pocketctl ignores object source", originator: "pocketctl", source: `{"subagent":"review"}`, wantAgent: "codex", classified: true},
		{name: "unknown plus exec", originator: "unknown", source: `"exec"`, wantAgent: "codex", classified: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "rollout.jsonl")
			payload := fmt.Sprintf(`{"id":"fixture","originator":%q,"source":%s}`, tt.originator, tt.source)
			if err := os.WriteFile(path, []byte(fmt.Sprintf(`{"type":"session_meta","payload":%s}`+"\n", payload)), 0o644); err != nil {
				t.Fatal(err)
			}

			meta, ok := ReadCodexRolloutMetadata(path)
			if !ok {
				t.Fatal("metadata not parsed")
			}
			got := ClassifyCodexOrigin(meta)
			if got.AgentType != tt.wantAgent || got.Classified != tt.classified {
				t.Fatalf("ClassifyCodexOrigin(%+v) = %+v, want AgentType=%q Classified=%v", meta, got, tt.wantAgent, tt.classified)
			}
		})
	}
}
