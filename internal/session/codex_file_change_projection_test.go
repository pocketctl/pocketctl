package session

import (
	"reflect"
	"strings"
	"testing"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

const managedFileChangeParams = `{
	"threadId":"thr_1","turnId":"turn_1","completedAtMs":4,
	"item":{"id":"patch_1","type":"fileChange","status":"completed","changes":[
		{"path":"z.go","kind":{"type":"update","move_path":null},"diff":"--- a/z.go\n+++ b/z.go\n@@ -1 +1 @@\n-old\n+new\n"},
		{"path":"a.go","kind":{"type":"add"},"diff":"first\nsecond\n"},
		{"path":"old.go","kind":{"type":"update","move_path":"new.go"},"diff":"--- a/old.go\n+++ b/new.go\n@@ -1 +1 @@\n-old name\n+new name\n"}
	]}
}`

func TestCodexProjectionAppendsStructuredFileChangesAfterLegacy(t *testing.T) {
	t.Setenv("POCKETCTL_CODEX_EDITED_FILES", "1")
	p := newCodexProjection(23)
	startManagedFileChangeTurn(t, p)
	notification := codexNotification("item/completed", managedFileChangeParams)

	events := p.Project(notification)
	if len(events) != 4 {
		t.Fatalf("events=%+v, want legacy plus three file changes", events)
	}
	assertManagedLegacyFileChange(t, events[0], []string{"z.go", "a.go", "old.go"},
		"--- a/z.go\n+++ b/z.go\n@@ -1 +1 @@\n-old\n+new\n\n"+
			"first\nsecond\n\n"+
			"--- a/old.go\n+++ b/new.go\n@@ -1 +1 @@\n-old name\n+new name\n")

	want := []struct {
		path      string
		kind      string
		movePath  string
		additions int
		deletions int
	}{
		{path: "z.go", kind: protocol.FileChangeUpdate, additions: 1, deletions: 1},
		{path: "a.go", kind: protocol.FileChangeCreate, additions: 2},
		{path: "old.go", kind: protocol.FileChangeMove, movePath: "new.go", additions: 1, deletions: 1},
	}
	for i, expected := range want {
		got := events[i+1]
		if got.Type != "agent_file_change" || got.SessionID != "thr_1" ||
			got.TurnID != logicalCodexTurnID("thr_1", "turn_1") || got.SourceTurnID != "turn_1" ||
			got.ChangeSetID != "managed:patch_1" ||
			got.CallID != "patch_1" || got.ChangeIndex != i || got.ChangeTotal != 3 ||
			got.Path != expected.path || got.ChangeKind != expected.kind ||
			got.MovePath != expected.movePath || got.Additions != expected.additions ||
			got.Deletions != expected.deletions || got.Status != "completed" {
			t.Fatalf("structured event %d=%+v", i, got)
		}
		if !strings.HasPrefix(got.EventID, "codex:23:file-change:") {
			t.Fatalf("structured event %d id=%q", i, got.EventID)
		}
	}

	p2 := newCodexProjection(23)
	startManagedFileChangeTurn(t, p2)
	replayed := p2.Project(notification)
	if len(replayed) != len(events) {
		t.Fatalf("fresh projection=%+v", replayed)
	}
	for i := 1; i < len(events); i++ {
		if replayed[i].EventID != events[i].EventID {
			t.Fatalf("event %d id changed: first=%q replay=%q", i, events[i].EventID, replayed[i].EventID)
		}
	}

	if duplicate := p.Project(notification); len(duplicate) != 0 {
		t.Fatalf("duplicate item/completed=%+v", duplicate)
	}
}

func TestCodexProjectionFiltersInvalidStructuredFileChangesOnly(t *testing.T) {
	t.Setenv("POCKETCTL_CODEX_EDITED_FILES", "1")
	p := newCodexProjection(24)
	startManagedFileChangeTurn(t, p)
	events := p.Project(codexNotification("item/completed", `{
		"threadId":"thr_1","turnId":"turn_1",
		"item":{"id":"patch_filter","type":"fileChange","status":"completed","changes":[
			{"path":"","kind":"update","diff":"@@\n+empty path\n"},
			{"path":"future.go","kind":"future-kind","diff":"@@\n+unknown\n"},
			{"path":"valid.go","kind":"remove","diff":"gone\n"}
		]}
	}`))

	if len(events) != 2 {
		t.Fatalf("events=%+v, want unchanged legacy plus one valid structured event", events)
	}
	assertManagedLegacyFileChange(t, events[0], []string{"", "future.go", "valid.go"},
		"@@\n+empty path\n\n@@\n+unknown\n\ngone\n")
	if got := events[1]; got.Path != "valid.go" || got.ChangeKind != protocol.FileChangeDelete ||
		got.ChangeIndex != 0 || got.ChangeTotal != 1 || got.Additions != 0 || got.Deletions != 1 {
		t.Fatalf("valid structured event=%+v", got)
	}
}

func TestCodexProjectionNormalizesManagedWholeFileContent(t *testing.T) {
	t.Setenv("POCKETCTL_CODEX_EDITED_FILES", "1")
	p := newCodexProjection(27)
	startManagedFileChangeTurn(t, p)
	events := p.Project(codexNotification("item/completed", `{
		"threadId":"thr_1","turnId":"turn_1",
		"item":{"id":"patch_content","type":"fileChange","status":"completed","changes":[
			{"path":"created.txt","kind":{"type":"add"},"diff":"alpha\nbeta\n"},
			{"path":"deleted.txt","kind":{"type":"delete"},"diff":"gone\n"}
		]}
	}`))

	if len(events) != 3 {
		t.Fatalf("events=%+v, want legacy plus two structured events", events)
	}
	if got := events[1]; got.Diff != "--- /dev/null\n+++ b/created.txt\n@@ -0,0 +1,2 @@\n+alpha\n+beta\n" ||
		got.Additions != 2 || got.Deletions != 0 {
		t.Fatalf("created file event=%+v", got)
	}
	if got := events[2]; got.Diff != "--- a/deleted.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n" ||
		got.Additions != 0 || got.Deletions != 1 {
		t.Fatalf("deleted file event=%+v", got)
	}
}

func TestCodexProjectionTreatsPatchLookingCreateContentAsWholeFile(t *testing.T) {
	t.Setenv("POCKETCTL_CODEX_EDITED_FILES", "1")
	p := newCodexProjection(28)
	startManagedFileChangeTurn(t, p)
	events := p.Project(codexNotification("item/completed", `{
		"threadId":"thr_1","turnId":"turn_1",
		"item":{"id":"patch_looking","type":"fileChange","status":"completed","changes":[
			{"path":"notes.txt","kind":{"type":"add"},"diff":"--- heading\n+++ body\n"}
		]}
	}`))

	if len(events) != 2 {
		t.Fatalf("events=%+v, want legacy plus structured event", events)
	}
	want := "--- /dev/null\n+++ b/notes.txt\n@@ -0,0 +1,2 @@\n+--- heading\n++++ body\n"
	if got := events[1]; got.Diff != want || got.Additions != 2 || got.Deletions != 0 {
		t.Fatalf("patch-looking create event=%+v, want diff %q", got, want)
	}
}

func TestManagedWholeFileDiffEmptyAndNoTrailingNewline(t *testing.T) {
	tests := []struct {
		name    string
		path    string
		kind    string
		content string
		want    string
	}{
		{
			name: "empty create", path: "empty.txt", kind: protocol.FileChangeCreate,
			want: "--- /dev/null\n+++ b/empty.txt\n",
		},
		{
			name: "create without trailing newline", path: "created.txt", kind: protocol.FileChangeCreate,
			content: "alpha", want: "--- /dev/null\n+++ b/created.txt\n@@ -0,0 +1 @@\n+alpha\n\\ No newline at end of file\n",
		},
		{
			name: "delete without trailing newline", path: "deleted.txt", kind: protocol.FileChangeDelete,
			content: "gone", want: "--- a/deleted.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n\\ No newline at end of file\n",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := managedWholeFileDiff(tt.path, tt.kind, tt.content); got != tt.want {
				t.Fatalf("diff=%q, want %q", got, tt.want)
			}
		})
	}
}

func TestCodexProjectionNonCompletedFileChangeKeepsLegacyOnly(t *testing.T) {
	t.Setenv("POCKETCTL_CODEX_EDITED_FILES", "1")
	for i, status := range []string{"failed", "declined", ""} {
		t.Run(status, func(t *testing.T) {
			p := newCodexProjection(uint64(25 + i))
			startManagedFileChangeTurn(t, p)
			events := p.Project(codexNotification("item/completed", `{
				"threadId":"thr_1","turnId":"turn_1",
				"item":{"id":"patch_terminal","type":"fileChange","status":"`+status+`","changes":[
					{"path":"a.go","kind":{"type":"update","move_path":null},"diff":"@@\n-old\n+new\n"}
				]}
			}`))
			if len(events) != 1 || events[0].Type != "tool_result" || events[0].Status != status {
				t.Fatalf("events=%+v, want only legacy result with status %q", events, status)
			}
		})
	}
}

func TestCodexProjectionFileChangeKillSwitchKeepsLegacyOnly(t *testing.T) {
	t.Setenv("POCKETCTL_CODEX_EDITED_FILES", "0")
	p := newCodexProjection(26)
	startManagedFileChangeTurn(t, p)
	events := p.Project(codexNotification("item/completed", managedFileChangeParams))
	if len(events) != 1 {
		t.Fatalf("events=%+v, want exactly the legacy result", events)
	}
	assertManagedLegacyFileChange(t, events[0], []string{"z.go", "a.go", "old.go"},
		"--- a/z.go\n+++ b/z.go\n@@ -1 +1 @@\n-old\n+new\n\n"+
			"first\nsecond\n\n"+
			"--- a/old.go\n+++ b/new.go\n@@ -1 +1 @@\n-old name\n+new name\n")
}

func startManagedFileChangeTurn(t *testing.T, p *codexProjection) {
	t.Helper()
	events := p.Project(codexNotification("turn/started", `{
		"threadId":"thr_1","turn":{"id":"turn_1","status":"inProgress","items":[]}
	}`))
	if len(events) != 2 || events[0].Type != protocol.EventTypeTurnStatus ||
		events[1].Type != "session_status" || events[1].Status != protocol.StatusRunning {
		t.Fatalf("turn start=%+v", events)
	}
}

func assertManagedLegacyFileChange(t *testing.T, got protocol.DaemonEvent, files []string, output string) {
	t.Helper()
	if got.Type != "tool_result" || got.Tool != "fileChange" || got.CallID == "" ||
		got.PartID != got.CallID || got.Output != output || got.Status == "" ||
		!reflect.DeepEqual(got.Files, files) {
		t.Fatalf("legacy fileChange changed: %+v", got)
	}
}
