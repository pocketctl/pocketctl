package sessiondocument

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

func qualifiedEvent(path, kind string) protocol.DaemonEvent {
	return protocol.DaemonEvent{
		Type: "agent_file_change", SessionID: "session-1", TurnID: "turn-1",
		ChangeSetID: "changes-1", EventID: "event-1", Status: "completed",
		Path: path, ChangeKind: kind,
	}
}

func TestCandidateFromEventAcceptsOnlyCompletedAttributedDocuments(t *testing.T) {
	for _, extension := range []string{"report.md", "report.MARKDOWN", "report.Html", "report.HTM"} {
		candidate, ok := CandidateFromEvent(qualifiedEvent(extension, protocol.FileChangeCreate))
		if !ok || candidate.RelativePath != extension {
			t.Fatalf("qualified %q rejected: candidate=%+v ok=%v", extension, candidate, ok)
		}
	}

	move := qualifiedEvent("old.md", protocol.FileChangeMove)
	move.MovePath = "docs/new.html"
	if candidate, ok := CandidateFromEvent(move); !ok || candidate.RelativePath != "docs/new.html" {
		t.Fatalf("move destination not selected: %+v ok=%v", candidate, ok)
	}

	invalid := []protocol.DaemonEvent{
		{Type: "tool_result", Path: "report.md", Status: "completed"},
		qualifiedEvent("report.md", protocol.FileChangeDelete),
		qualifiedEvent("report.txt", protocol.FileChangeUpdate),
		qualifiedEvent("/tmp/report.md", protocol.FileChangeCreate),
		qualifiedEvent("../report.md", protocol.FileChangeCreate),
		qualifiedEvent("report.md", protocol.FileChangeCreate),
	}
	invalid[len(invalid)-1].Status = "in_progress"
	for field := range 4 {
		event := qualifiedEvent("report.md", protocol.FileChangeUpdate)
		switch field {
		case 0:
			event.SessionID = ""
		case 1:
			event.TurnID = ""
		case 2:
			event.ChangeSetID = ""
		case 3:
			event.EventID = ""
		}
		invalid = append(invalid, event)
	}
	for index, event := range invalid {
		if _, ok := CandidateFromEvent(event); ok {
			t.Fatalf("invalid candidate %d accepted: %+v", index, event)
		}
	}
}

func TestCaptureAcceptsRootBasenameAndComputesStableMetadata(t *testing.T) {
	root := t.TempDir()
	content := []byte("# report\n你好\n")
	if err := os.WriteFile(filepath.Join(root, "REPORT.MD"), content, 0o600); err != nil {
		t.Fatal(err)
	}
	candidate, ok := CandidateFromEvent(qualifiedEvent("REPORT.MD", protocol.FileChangeCreate))
	if !ok {
		t.Fatal("candidate rejected")
	}
	first := Capture(root, candidate, 2<<20)
	second := Capture(root, candidate, 2<<20)
	if first.Reason != "" || second.Reason != "" {
		t.Fatalf("capture failed: first=%+v second=%+v", first, second)
	}
	if string(first.Bytes) != string(content) || first.ByteSize != len(content) || first.Format != protocol.SessionDocumentFormatMarkdown {
		t.Fatalf("unexpected snapshot: %+v", first)
	}
	if first.DocumentID == "" || first.VersionID == "" || first.SHA256 == "" ||
		first.DocumentID != second.DocumentID || first.VersionID != second.VersionID {
		t.Fatalf("identities are not stable: first=%+v second=%+v", first, second)
	}
}

func TestCaptureRejectsTraversalSymlinksNonRegularOversizeAndInvalidUTF8(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.md"), []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "secret.md"), filepath.Join(root, "final.md")); err != nil {
		if runtime.GOOS == "windows" {
			t.Skipf("symlink unavailable: %v", err)
		}
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "linked")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "directory.md"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "large.md"), []byte("123456"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "bad.md"), []byte{0xff, 0xfe}, 0o600); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		path   string
		limit  int
		reason string
	}{
		{"../secret.md", 100, protocol.SessionDocumentReasonPathOutsideRoot},
		{"final.md", 100, protocol.SessionDocumentReasonPathOutsideRoot},
		{"linked/secret.md", 100, protocol.SessionDocumentReasonPathOutsideRoot},
		{"directory.md", 100, protocol.SessionDocumentReasonUnsupported},
		{"large.md", 5, protocol.SessionDocumentReasonTooLarge},
		{"bad.md", 100, protocol.SessionDocumentReasonInvalidEncoding},
	}
	for _, tc := range cases {
		event := qualifiedEvent(tc.path, protocol.FileChangeUpdate)
		candidate := Candidate{SessionID: event.SessionID, TurnID: event.TurnID,
			ChangeSetID: event.ChangeSetID, SourceEventID: event.EventID, RelativePath: tc.path,
			DisplayName: filepath.Base(tc.path), Format: protocol.SessionDocumentFormatMarkdown}
		result := Capture(root, candidate, tc.limit)
		if result.Reason != tc.reason || len(result.Bytes) != 0 {
			t.Fatalf("%s: got reason=%q bytes=%d", tc.path, result.Reason, len(result.Bytes))
		}
	}
}

func TestCaptureUsesProvidedWorktreeRootOnly(t *testing.T) {
	canonical := t.TempDir()
	worktree := t.TempDir()
	if err := os.WriteFile(filepath.Join(canonical, "report.md"), []byte("canonical secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(worktree, "report.md"), []byte("worktree result"), 0o600); err != nil {
		t.Fatal(err)
	}
	candidate, _ := CandidateFromEvent(qualifiedEvent("report.md", protocol.FileChangeUpdate))
	result := Capture(worktree, candidate, 100)
	if string(result.Bytes) != "worktree result" || strings.Contains(string(result.Bytes), "canonical") {
		t.Fatalf("captured wrong root: %q", result.Bytes)
	}
}
