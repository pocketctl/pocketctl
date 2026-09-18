package adapter

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"testing"

	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/sessiondocument"
)

func documentTool(id, tool, path string) OpencodePart {
	input, _ := json.Marshal(map[string]string{"filePath": path})
	return OpencodePart{ID: id, Type: "tool", Tool: tool, CallID: id, State: &OpencodeToolState{Status: "completed", Input: input}}
}

func TestOpencodeDocumentsFinalWritesAndNativeIdle(t *testing.T) {
	root := t.TempDir()
	messages := []OpencodeMessageWithParts{
		mkMsg("u", "user", "", 1, 0),
		mkMsg("a", "assistant", "", 2, 3, documentTool("first", "write", "report.md"), documentTool("last", "edit", filepath.Join(root, "report.md")), documentTool("html", "write", "report.html")),
	}
	for _, status := range []string{protocol.StatusBusy, protocol.StatusRetry} {
		if got := OpencodeDocumentCandidates("s", root, messages, &OpencodeSessionStatus{Type: status}); len(got) != 0 {
			t.Fatal("captured busy session")
		}
	}
	got := OpencodeDocumentCandidates("s", root, messages, &OpencodeSessionStatus{Type: protocol.StatusIdle})
	if len(got) != 2 {
		t.Fatalf("want two final documents, got %+v", got)
	}
	if got[1].ChangeSetID != "opencode-docset-"+opencodeContentHash("s\x00last") {
		t.Fatal("did not select latest edit")
	}
	for _, candidate := range got {
		_, relative, ok := sessiondocument.ResolvePathWithinRoot(root, candidate.FilePath)
		if !ok {
			t.Fatal("path rejected")
		}
		if _, ok := sessiondocument.CandidateFromPath(candidate.SessionID, candidate.TurnID, candidate.ChangeSetID, candidate.SourceEventID, relative); !ok {
			t.Fatal("cannot enter document pipeline")
		}
	}
	again := OpencodeDocumentCandidates("s", root, messages, nil)
	if again[0] != got[0] || again[1] != got[1] || got[0].SourceEventID == got[1].SourceEventID {
		t.Fatal("unstable or colliding identities")
	}
	messages[1].Info.Finish = "tool-calls"
	if len(OpencodeDocumentCandidates("s", root, messages, nil)) != 0 {
		t.Fatal("captured intermediate tool step")
	}
	messages[1].Info.Finish = ""
	messages[1].Info.Time.Completed = 0
	if len(OpencodeDocumentCandidates("s", root, messages, nil)) != 0 {
		t.Fatal("captured incomplete message")
	}
}

func TestOpencodeDocumentsPatchMoveDeleteAndUntrustedParts(t *testing.T) {
	var patch OpencodePart
	if err := json.Unmarshal([]byte(`{"id":"patch","type":"tool","tool":"apply_patch","state":{"status":"completed","metadata":{"files":[{"filePath":"old.md","type":"move","movePath":"new.html"},{"filePath":"gone.md","type":"delete"},{"filePath":"second.md","type":"add"}]}}}`), &patch); err != nil {
		t.Fatal(err)
	}
	failed := documentTool("failed", "write", "failed.md")
	failed.State.Status = "error"
	running := documentTool("running", "write", "running.md")
	running.State.Status = "running"
	messages := []OpencodeMessageWithParts{
		mkMsg("u", "user", "", 1, 0, documentTool("user", "write", "user.md")),
		mkMsg("a", "assistant", "", 2, 3, documentTool("old", "write", "old.md"), documentTool("gone", "write", "gone.md"), patch, failed, running, documentTool("read", "read", "read.md"), documentTool("code", "write", "code.go")),
	}
	got := OpencodeDocumentCandidates("s", "", messages, nil)
	if len(got) != 2 || got[0].FilePath != "second.md" || got[1].FilePath != "new.html" || got[0].SourceEventID == got[1].SourceEventID {
		t.Fatalf("unexpected documents: %+v", got)
	}
	if len(OpencodeDocumentCandidates("s", "", messages[1:], nil)) != 0 {
		t.Fatal("unanchored writes captured")
	}
}

func TestOpencodeDocumentsBoundedToLatestFifty(t *testing.T) {
	var parts []OpencodePart
	for i := 0; i < 60; i++ {
		parts = append(parts, documentTool(fmt.Sprint(i), "write", fmt.Sprintf("%02d.md", i)))
	}
	got := OpencodeDocumentCandidates("s", "", []OpencodeMessageWithParts{mkMsg("u", "user", "", 1, 0), mkMsg("a", "assistant", "", 2, 3, parts...)}, nil)
	if len(got) != 50 || got[0].FilePath != "59.md" || got[49].FilePath != "10.md" {
		t.Fatalf("unexpected bound: %+v", got)
	}
}

func TestOpencodeDocumentsIgnoreAbandonedOlderTurn(t *testing.T) {
	messages := []OpencodeMessageWithParts{
		mkMsg("old-user", "user", "", 1, 0),
		mkMsg("abandoned", "assistant", "", 2, 0, documentTool("old", "write", "old.md")),
		mkMsg("new-user", "user", "", 3, 0),
		mkMsg("final", "assistant", "", 4, 5, documentTool("new", "write", "new.md")),
	}
	got := OpencodeDocumentCandidates("s", "", messages, nil)
	if len(got) != 1 || got[0].FilePath != "new.md" {
		t.Fatalf("unexpected candidates: %+v", got)
	}
}
