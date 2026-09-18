package session

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/sessiondocument"
)

func TestOpencodeDocumentsCaptureRetriesAndLatestSnapshot(t *testing.T) {
	root := t.TempDir()
	policy, err := NewCwdPolicy([]string{root})
	if err != nil {
		t.Fatal(err)
	}
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 1))
	sm.SetCwdPolicy(policy)
	sm.sessions["s"] = &ProcessState{Cwd: root, Agent: adapter.AgentOpencode}
	var messages []adapter.OpencodeMessageWithParts
	if err := json.Unmarshal([]byte(`[
	{"info":{"id":"u","role":"user","time":{"created":1}},"parts":[]},
	{"info":{"id":"a","role":"assistant","time":{"created":2,"completed":3}},"parts":[
	{"id":"md","type":"tool","tool":"write","state":{"status":"completed","input":{"filePath":"report.md"}}},
	{"id":"html","type":"tool","tool":"write","state":{"status":"completed","input":{"filePath":"report.html"}}}
	]}]`), &messages); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{"report.md": "# Final report", "report.html": "<h1>Final report</h1>"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	results := make(chan sessiondocument.CaptureResult, 4)
	queue := sessiondocument.NewCaptureQueue(sessiondocument.CaptureQueueOptions{MaxDocumentBytes: 1024, OnResult: func(r sessiondocument.CaptureResult) { results <- r }})
	defer queue.Stop()
	ready, attempts := false, 0
	sm.SetOpencodeDocumentCapture(func(source adapter.OpencodeDocumentCandidate) bool {
		attempts++
		if !ready {
			return false
		}
		captureRoot, candidate, ok := sm.ResolveOpencodeDocumentCandidate(source)
		if !ok {
			t.Fatal("candidate rejected")
		}
		return queue.SubmitCandidateWithRoot(captureRoot, candidate, sessiondocument.TransportLimits{MaxEventBytes: 4096, MaxChunkBytes: 1024})
	})
	accepted := map[string]string{}
	idle := &adapter.OpencodeSessionStatus{Type: protocol.StatusIdle}
	sm.captureOpencodeDocuments("s", messages, &adapter.OpencodeSessionStatus{Type: protocol.StatusBusy}, accepted)
	if attempts != 0 {
		t.Fatal("busy capture")
	}
	sm.captureOpencodeDocuments("s", messages, idle, accepted)
	if attempts != 2 || len(accepted) != 0 {
		t.Fatal("failed admission not retryable")
	}
	ready = true
	sm.captureOpencodeDocuments("s", messages, idle, accepted)
	versions := map[string]string{}
	for i := 0; i < 2; i++ {
		select {
		case result := <-results:
			if result.Reason != "" || len(result.Bytes) == 0 {
				t.Fatalf("capture failed: %+v", result)
			}
			records, err := sessiondocument.BuildRecords("s", result, result.Transport)
			if err != nil || len(records) != 3 || records[2].Type != protocol.EventTypeSessionDocumentCommit {
				t.Fatalf("invalid upload: %v %+v", err, records)
			}
			versions[result.DisplayName] = result.VersionID
		case <-time.After(3 * time.Second):
			t.Fatal("capture timeout")
		}
	}
	sm.captureOpencodeDocuments("s", messages, idle, accepted)
	if attempts != 4 {
		t.Fatal("duplicate snapshot recaptured")
	}
	if err := os.WriteFile(filepath.Join(root, "report.md"), []byte("# Revised report"), 0600); err != nil {
		t.Fatal(err)
	}
	messages[1].Parts[0].ID = "revision"
	sm.captureOpencodeDocuments("s", messages, idle, accepted)
	select {
	case result := <-results:
		if result.DisplayName != "report.md" || string(result.Bytes) != "# Revised report" || result.VersionID == versions["report.md"] {
			t.Fatalf("revision missing: %+v", result)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("revision timeout")
	}
	if attempts != 5 {
		t.Fatal("unchanged HTML recaptured")
	}
}

func TestOpencodeDocumentsResolveAuthorizedWorktreeOnly(t *testing.T) {
	root := t.TempDir()
	worktree := filepath.Join(root, "worktree")
	if err := os.Mkdir(worktree, 0700); err != nil {
		t.Fatal(err)
	}
	policy, err := NewCwdPolicy([]string{root})
	if err != nil {
		t.Fatal(err)
	}
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 1))
	sm.SetCwdPolicy(policy)
	sm.sessions["s"] = &ProcessState{Cwd: root, WorktreePath: worktree}
	source := adapter.OpencodeDocumentCandidate{SessionID: "s", TurnID: "turn", ChangeSetID: "set", SourceEventID: "event"}
	for _, path := range []string{"../outside.md", filepath.Join(root, "outside.md"), "report.txt"} {
		source.FilePath = path
		if _, _, ok := sm.ResolveOpencodeDocumentCandidate(source); ok {
			t.Fatalf("accepted %q", path)
		}
	}
	source.FilePath = filepath.Join(worktree, "report.html")
	resolved, candidate, ok := sm.ResolveOpencodeDocumentCandidate(source)
	canonical, _ := filepath.EvalSymlinks(worktree)
	if !ok || resolved != canonical || candidate.RelativePath != "report.html" {
		t.Fatalf("worktree binding failed: %q %+v %v", resolved, candidate, ok)
	}
	source.SessionID = "missing"
	if _, _, ok := sm.ResolveOpencodeDocumentCandidate(source); ok {
		t.Fatal("accepted unknown session")
	}
}
