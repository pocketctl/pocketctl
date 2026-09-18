package zcode

import (
	"context"
	"database/sql"
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

func completedDocumentPart(tool, callID, filePath string) string {
	encoded, _ := json.Marshal(map[string]any{
		"type": "tool", "tool": tool, "callID": callID,
		"state": map[string]any{
			"status": "completed", "input": map[string]any{"file_path": filePath}, "output": "ok",
		},
	})
	return string(encoded)
}

func TestDocumentCandidateFromRowAcceptsOnlyCompletedVisibleWriteEditDocuments(t *testing.T) {
	row := PartRow{
		ID: "native-part-secret", MessageID: "native-message-secret", SessionID: "native-session-secret",
		DataJSON: completedDocumentPart("Write", "call-1", "/workspace/report.MD"),
		Msg:      MessageScope{Role: "assistant"},
	}
	candidate, ok := documentCandidateFromRow(testSourceID, "zcode-wire", "/workspace", row)
	if !ok {
		t.Fatal("completed Write document rejected")
	}
	if candidate.SessionID != "zcode-wire" || candidate.SessionDirectory != "/workspace" ||
		candidate.FilePath != "/workspace/report.MD" || candidate.TurnID == "" ||
		candidate.ChangeSetID == "" || candidate.SourceEventID == "" {
		t.Fatalf("unexpected candidate: %+v", candidate)
	}
	for _, secret := range []string{row.ID, row.MessageID, row.SessionID} {
		if candidate.SourceEventID == secret || candidate.ChangeSetID == secret || candidate.TurnID == secret {
			t.Fatalf("native identity leaked into candidate fields: %+v", candidate)
		}
	}

	cases := []PartRow{
		{ID: "bash", MessageID: "m", DataJSON: completedDocumentPart("Bash", "c", "report.md"), Msg: MessageScope{Role: "assistant"}},
		{ID: "text", MessageID: "m", DataJSON: completedDocumentPart("Write", "c", "report.txt"), Msg: MessageScope{Role: "assistant"}},
		{ID: "user", MessageID: "m", DataJSON: completedDocumentPart("Write", "c", "report.md"), Msg: MessageScope{Role: "user"}},
		{ID: "hidden", MessageID: "m", DataJSON: completedDocumentPart("Edit", "c", "page.html"), Msg: MessageScope{Role: "assistant", Hidden: true}},
		{ID: "pending", MessageID: "m", DataJSON: `{"type":"tool","tool":"Write","callID":"c","state":{"status":"running","input":{"file_path":"report.md"}}}`, Msg: MessageScope{Role: "assistant"}},
		{ID: "bad", MessageID: "m", DataJSON: `{`, Msg: MessageScope{Role: "assistant"}},
	}
	for _, testCase := range cases {
		if got, accepted := documentCandidateFromRow(testSourceID, "zcode-wire", "/workspace", testCase); accepted {
			t.Fatalf("invalid row accepted: id=%s candidate=%+v", testCase.ID, got)
		}
	}
}

func TestStoreListsNewestCompletedDocumentToolParts(t *testing.T) {
	ctx := context.Background()
	storage := testdb(t, withSeed(func(ctx context.Context, db *sql.DB) {
		now := nowMillis()
		insertSession(ctx, db, "ses1", "title", "/workspace", now, now, 0)
		insertMessage(ctx, db, "m1", "ses1", 1, now, now, `{"role":"assistant"}`)
		insertPart(ctx, db, "p1", "m1", "ses1", 1, now, now, completedDocumentPart("Write", "c1", "report.md"))
		insertPart(ctx, db, "p2", "m1", "ses1", 2, now, now+1, completedDocumentPart("Write", "c2", "report.md"))
		insertPart(ctx, db, "p3", "m1", "ses1", 3, now, now+2, completedDocumentPart("Edit", "c3", "page.HTML"))
		insertPart(ctx, db, "p4", "m1", "ses1", 4, now, now+3, completedDocumentPart("Bash", "c4", "ignored.md"))
		insertPart(ctx, db, "p5", "m1", "ses1", 5, now, now+4, completedDocumentPart("Write", "c5", "ignored.txt"))
		insertPart(ctx, db, "p6", "m1", "ses1", 6, now, now+5, `{"type":"tool","tool":"Write","callID":"c6","state":{"status":"running","input":{"file_path":"pending.md"}}}`)
		insertPart(ctx, db, "p7", "m1", "ses1", 7, now, now+6, `{`)
	}))
	store, err := Open(storage)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	rows, err := store.ListDocumentToolParts(ctx, "ses1", 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 || rows[0].ID != "p3" || rows[1].ID != "p2" {
		t.Fatalf("unexpected document rows: %+v", rows)
	}
}

func TestObserverCapturesOnlyLatestCandidatePerDocumentPathAndRetriesBackpressure(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	storage := testdb(t, withSeed(func(ctx context.Context, db *sql.DB) {
		now := nowMillis()
		insertSession(ctx, db, "ses1", "title", root, now, now, 0)
		insertMessage(ctx, db, "m1", "ses1", 1, now, now, `{"role":"assistant"}`)
		insertPart(ctx, db, "p-old", "m1", "ses1", 1, now, now, completedDocumentPart("Write", "c1", filepath.Join(root, "report.md")))
		insertPart(ctx, db, "p-new", "m1", "ses1", 2, now, now+1, completedDocumentPart("Edit", "c2", filepath.Join(root, "report.md")))
		insertPart(ctx, db, "p-html", "m1", "ses1", 3, now, now+2, completedDocumentPart("Write", "c3", "page.html"))
		insertPart(ctx, db, "p-bash", "m1", "ses1", 4, now, now+3, completedDocumentPart("Bash", "c4", "ignored.md"))
	}))
	store, err := Open(storage)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	o := NewObserver(ObserverConfig{SourceID: testSourceID, Emit: func(protocol.DaemonEvent) bool { return true }})
	o.store = store
	var captured []DocumentCandidate
	accept := false
	o.cfg.CaptureDocument = func(candidate DocumentCandidate) bool {
		if !accept {
			return false
		}
		captured = append(captured, candidate)
		return true
	}
	session := SessionRow{ID: "ses1", Directory: root}
	if count, deferred := o.captureSessionDocuments(ctx, WireSessionID(testSourceID, "ses1"), session); count != 0 || !deferred {
		t.Fatalf("backpressured scan = %d, %v", count, deferred)
	}
	accept = true
	if count, deferred := o.captureSessionDocuments(ctx, WireSessionID(testSourceID, "ses1"), session); count != 2 || deferred {
		t.Fatalf("accepted scan = %d, %v", count, deferred)
	}
	if len(captured) != 2 || captured[0].FilePath != "page.html" || captured[1].FilePath != filepath.Join(root, "report.md") {
		t.Fatalf("unexpected candidates: %+v", captured)
	}
	if count, deferred := o.captureSessionDocuments(ctx, WireSessionID(testSourceID, "ses1"), session); count != 0 || deferred {
		t.Fatalf("deduped scan = %d, %v", count, deferred)
	}
}

func TestObserverDocumentCapabilityNotReadyDoesNotBlockSessionSync(t *testing.T) {
	storage := testdb(t, withSeed(func(ctx context.Context, db *sql.DB) {
		now := nowMillis()
		insertSession(ctx, db, "ses1", "title", "/workspace", now, now, 0)
		insertMessage(ctx, db, "m1", "ses1", 1, now, now, `{"role":"assistant"}`)
		insertPart(ctx, db, "p1", "m1", "ses1", 1, now, now, completedDocumentPart("Write", "c1", "report.md"))
	}))
	cursor := NewCursorStoreAt(filepath.Join(t.TempDir(), "cursor.json"))
	recorder := newEmitRecorder()
	observer := testObserver(t, storage, cursor, recorder.fn())
	observer.cfg.DocumentCaptureReady = func() bool { return false }
	observer.cfg.CaptureDocument = func(DocumentCandidate) bool {
		t.Fatal("capture callback called before capability readiness")
		return false
	}
	result := observer.pollOnce(context.Background())
	if result.Deferred || result.DocumentCaptures != 0 || result.Emitted == 0 {
		t.Fatalf("unexpected poll result while capability is unavailable: %+v", result)
	}
}
