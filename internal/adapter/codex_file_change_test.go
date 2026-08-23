package adapter

import (
	"reflect"
	"strings"
	"testing"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestCodexPatchApplyProjectsFileChangesDeterministically(t *testing.T) {
	t.Setenv("POCKETCTL_CODEX_EDITED_FILES", "1")
	line := `{"type":"event_msg","payload":{"type":"patch_apply_end","call_id":"call_9","turn_id":"turn_4","success":true,"status":"completed","changes":{"z.go":{"type":"update","unified_diff":"@@\n-old\n+new\n","move_path":""},"a.go":{"type":"add","content":"first\n"},"d.go":{"type":"delete","content":"gone\nnext\n"}}}}`

	first, err := NewCodexJSONLParser().Parse(line)
	if err != nil {
		t.Fatalf("first parse: %v", err)
	}
	second, err := NewCodexJSONLParser().Parse(line)
	if err != nil {
		t.Fatalf("second parse: %v", err)
	}

	if !reflect.DeepEqual(first, second) {
		t.Fatalf("fresh parsers produced different events:\nfirst=%+v\nsecond=%+v", first, second)
	}
	if len(first) != 3 {
		t.Fatalf("events=%+v, want three file changes", first)
	}

	want := []struct {
		path      string
		kind      string
		index     int
		diff      string
		additions int
		deletions int
	}{
		{path: "a.go", kind: protocol.FileChangeCreate, index: 0, diff: "--- /dev/null\n+++ b/a.go\n@@ -0,0 +1 @@\n+first\n", additions: 1},
		{path: "d.go", kind: protocol.FileChangeDelete, index: 1, diff: "--- a/d.go\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-gone\n-next\n", deletions: 2},
		{path: "z.go", kind: protocol.FileChangeUpdate, index: 2, diff: "@@\n-old\n+new\n", additions: 1, deletions: 1},
	}
	for i, expected := range want {
		got := first[i]
		if got.Type != "agent_file_change" || got.Path != expected.path ||
			got.ChangeKind != expected.kind || got.ChangeIndex != expected.index ||
			got.ChangeTotal != 3 || got.Diff != expected.diff || got.Additions != expected.additions ||
			got.Deletions != expected.deletions || got.ChangeSetID != "native:call_9" ||
			got.TurnID != "turn_4" || got.CallID != "call_9" || got.Status != "completed" {
			t.Fatalf("event %d=%+v", i, got)
		}
		if !strings.HasPrefix(got.EventID, "codex:file-change:") {
			t.Fatalf("event %d has unstable namespace: %q", i, got.EventID)
		}
	}
	if first[0].EventID == first[1].EventID {
		t.Fatalf("distinct changes share event id %q", first[0].EventID)
	}
}

func TestCodexPatchApplyNormalizesKindsAndMovePath(t *testing.T) {
	t.Setenv("POCKETCTL_CODEX_EDITED_FILES", "1")
	tests := []struct {
		name     string
		source   string
		movePath string
		want     string
	}{
		{name: "add", source: "add", want: protocol.FileChangeCreate},
		{name: "create", source: "create", want: protocol.FileChangeCreate},
		{name: "update", source: "update", want: protocol.FileChangeUpdate},
		{name: "modify", source: "modify", want: protocol.FileChangeUpdate},
		{name: "delete", source: "delete", want: protocol.FileChangeDelete},
		{name: "remove", source: "remove", want: protocol.FileChangeDelete},
		{name: "move kind", source: "move", want: protocol.FileChangeMove},
		{name: "rename kind", source: "rename", want: protocol.FileChangeMove},
		{name: "move path overrides unknown kind", source: "future-kind", movePath: "new.go", want: protocol.FileChangeMove},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			line := `{"type":"event_msg","payload":{"type":"patch_apply_end","call_id":"call_kind","turn_id":"turn_kind","success":true,"status":"completed","changes":{"old.go":{"type":"` + tt.source + `","unified_diff":"@@\n-old\n+new\n","move_path":"` + tt.movePath + `"}}}}`
			events := codexParse(t, line)
			if len(events) != 1 {
				t.Fatalf("events=%+v, want one file change", events)
			}
			got := events[0]
			if got.ChangeKind != tt.want || got.MovePath != tt.movePath {
				t.Fatalf("kind=%q move_path=%q, want kind=%q move_path=%q", got.ChangeKind, got.MovePath, tt.want, tt.movePath)
			}
		})
	}
}

func TestCodexPatchApplyPreservesMissingTrailingNewlineInGeneratedDiff(t *testing.T) {
	t.Setenv("POCKETCTL_CODEX_EDITED_FILES", "1")
	line := `{"type":"event_msg","payload":{"type":"patch_apply_end","call_id":"call_no_newline","turn_id":"turn_no_newline","success":true,"status":"completed","changes":{"last.txt":{"type":"add","content":"last"}}}}`
	events := codexParse(t, line)
	if len(events) != 1 {
		t.Fatalf("events=%+v, want one file change", events)
	}
	wantDiff := "--- /dev/null\n+++ b/last.txt\n@@ -0,0 +1 @@\n+last\n\\ No newline at end of file\n"
	if events[0].Diff != wantDiff || events[0].Additions != 1 || events[0].Deletions != 0 {
		t.Fatalf("event=%+v, want diff %q", events[0], wantDiff)
	}
}

func TestCodexPatchApplyFiltersInvalidChangesBeforeIndexing(t *testing.T) {
	t.Setenv("POCKETCTL_CODEX_EDITED_FILES", "1")
	line := `{"type":"event_msg","payload":{"type":"patch_apply_end","call_id":"call_filter","turn_id":"turn_filter","success":true,"status":"completed","changes":{"bad.go":{"type":"future-kind","unified_diff":"@@\n+bad\n"},"good.go":{"type":"modify","unified_diff":"@@\n+good\n"}}}}`
	events := codexParse(t, line)
	if len(events) != 1 {
		t.Fatalf("events=%+v, want only the valid change", events)
	}
	if got := events[0]; got.Path != "good.go" || got.ChangeIndex != 0 || got.ChangeTotal != 1 {
		t.Fatalf("filtered event=%+v", got)
	}
}

func TestCodexPatchApplyRejectsIncompleteOrFailedPayloads(t *testing.T) {
	t.Setenv("POCKETCTL_CODEX_EDITED_FILES", "1")
	tests := []struct {
		name string
		line string
	}{
		{
			name: "unsuccessful",
			line: `{"type":"event_msg","payload":{"type":"patch_apply_end","call_id":"call_1","turn_id":"turn_1","success":false,"status":"completed","changes":{"a.go":{"type":"update","unified_diff":"@@\n+x\n"}}}}`,
		},
		{
			name: "failed status",
			line: `{"type":"event_msg","payload":{"type":"patch_apply_end","call_id":"call_1","turn_id":"turn_1","success":true,"status":"failed","changes":{"a.go":{"type":"update","unified_diff":"@@\n+x\n"}}}}`,
		},
		{
			name: "declined status",
			line: `{"type":"event_msg","payload":{"type":"patch_apply_end","call_id":"call_1","turn_id":"turn_1","success":true,"status":"declined","changes":{"a.go":{"type":"update","unified_diff":"@@\n+x\n"}}}}`,
		},
		{
			name: "missing status",
			line: `{"type":"event_msg","payload":{"type":"patch_apply_end","call_id":"call_1","turn_id":"turn_1","success":true,"changes":{"a.go":{"type":"update","unified_diff":"@@\n+x\n"}}}}`,
		},
		{
			name: "missing turn id",
			line: `{"type":"event_msg","payload":{"type":"patch_apply_end","call_id":"call_1","success":true,"status":"completed","changes":{"a.go":{"type":"update","unified_diff":"@@\n+x\n"}}}}`,
		},
		{
			name: "missing call id",
			line: `{"type":"event_msg","payload":{"type":"patch_apply_end","turn_id":"turn_1","success":true,"status":"completed","changes":{"a.go":{"type":"update","unified_diff":"@@\n+x\n"}}}}`,
		},
		{
			name: "empty path",
			line: `{"type":"event_msg","payload":{"type":"patch_apply_end","call_id":"call_1","turn_id":"turn_1","success":true,"status":"completed","changes":{"":{"type":"update","unified_diff":"@@\n+x\n"}}}}`,
		},
		{
			name: "empty changes",
			line: `{"type":"event_msg","payload":{"type":"patch_apply_end","call_id":"call_1","turn_id":"turn_1","success":true,"status":"completed","changes":{}}}`,
		},
		{
			name: "unknown kind",
			line: `{"type":"event_msg","payload":{"type":"patch_apply_end","call_id":"call_1","turn_id":"turn_1","success":true,"status":"completed","changes":{"a.go":{"type":"future-kind","unified_diff":"@@\n+x\n"}}}}`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if events := codexParse(t, tt.line); len(events) != 0 {
				t.Fatalf("events=%+v, want none", events)
			}
		})
	}
}

func TestCodexPatchApplyHonorsEditedFilesKillSwitch(t *testing.T) {
	t.Setenv("POCKETCTL_CODEX_EDITED_FILES", "0")
	line := `{"type":"event_msg","payload":{"type":"patch_apply_end","call_id":"call_1","turn_id":"turn_1","success":true,"status":"completed","changes":{"a.go":{"type":"update","unified_diff":"@@\n+x\n"}}}}`
	if events := codexParse(t, line); len(events) != 0 {
		t.Fatalf("events=%+v, want none while disabled", events)
	}
}
