package teamdelivery

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

func fixtureJob() protocol.TeamDeliveryJob {
	return protocol.TeamDeliveryJob{CallID: "call-1", TaskID: "task-1", SpecRevision: 1, Revision: 2,
		Provider: "codex", NativeSessionID: "native-1", DeliveryRole: "primary", Authorization: protocol.CollaborationAuthorization{
			ProtocolVersion: 1, Operation: "message", CallID: "call-1", TeamSessionID: "session-1",
			BindingID: "binding-1", BindingRevision: 1, OfferID: "offer-1", OfferRevision: 1, OwnerUserID: 1, DaemonID: "daemon-1",
			Delivery: &protocol.TeamDeliveryBinding{TaskID: "task-1", SpecRevision: 1},
		}}
}

func fixtureManifest() manifest {
	required := true
	return manifest{SchemaVersion: 1, PublishScope: "team", Summary: "Ready for review",
		Artifacts: []manifestArtifact{{ID: "report", Path: "report.pdf", MIMEType: "application/pdf", Required: &required}},
		Evidence:  []protocol.TeamDeliveryEvidence{{CheckID: "verification", ArtifactID: "report", SourceKind: "agent_claim", Result: "unverified"}}}
}

func writeManifest(t *testing.T, root string, value manifest) {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(root, protocol.TeamDeliveryDirectory("call-1"), "submission.json"), data, 0600); err != nil {
		t.Fatal(err)
	}
}

func fixtureWorkspace(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	dir := filepath.Join(root, protocol.TeamDeliveryDirectory("call-1"))
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "report.pdf"), []byte{'%', 'P', 'D', 'F', '-', 0, 255}, 0600); err != nil {
		t.Fatal(err)
	}
	writeManifest(t, root, fixtureManifest())
	return root
}

func TestCollectCapturesOnlyExplicitBytesAndSource(t *testing.T) {
	root := fixtureWorkspace(t)
	if err := os.WriteFile(filepath.Join(root, "private.txt"), []byte("must stay private"), 0600); err != nil {
		t.Fatal(err)
	}
	snapshot, err := Collect(root, fixtureJob())
	if err != nil {
		t.Fatal(err)
	}
	data := snapshot.Files["report"]
	hash := sha256.Sum256(data)
	if len(snapshot.Files) != 1 || snapshot.Submission.Artifacts[0].SHA256 != hex.EncodeToString(hash[:]) ||
		snapshot.Submission.Artifacts[0].ByteSize != 7 || snapshot.Submission.SourceCallID != "call-1" ||
		snapshot.Submission.ExpectedRevision != 2 || snapshot.Submission.ContributionIDs == nil {
		t.Fatalf("incorrect snapshot: %+v", snapshot.Submission)
	}
	if err := snapshot.validate(); err != nil {
		t.Fatal(err)
	}
	job := fixtureJob()
	job.CallID = "another-call"
	if _, err := Collect(root, job); err == nil {
		t.Fatal("accepted inconsistent authorization")
	}
	job.Authorization.CallID = job.CallID
	if _, err := Collect(root, job); err == nil {
		t.Fatal("read previous call's output")
	}
}

func TestCollectRejectsInvalidManifest(t *testing.T) {
	cases := map[string]func(*manifest){
		"scope":                func(m *manifest) { m.PublishScope = "private" },
		"version":              func(m *manifest) { m.SchemaVersion = 2 },
		"empty summary":        func(m *manifest) { m.Summary = " " },
		"escape":               func(m *manifest) { m.Artifacts[0].Path = "../private.txt" },
		"absolute":             func(m *manifest) { m.Artifacts[0].Path = "/etc/passwd" },
		"windows escape":       func(m *manifest) { m.Artifacts[0].Path = `..\private.txt` },
		"noncanonical":         func(m *manifest) { m.Artifacts[0].Path = "nested/../report.pdf" },
		"metadata":             func(m *manifest) { m.Artifacts[0].Path = "submission.json" },
		"duplicate id":         func(m *manifest) { m.Artifacts = append(m.Artifacts, m.Artifacts[0]) },
		"duplicate path":       func(m *manifest) { a := m.Artifacts[0]; a.ID = "other"; m.Artifacts = append(m.Artifacts, a) },
		"missing required":     func(m *manifest) { m.Artifacts[0].Required = nil },
		"unsupported mime":     func(m *manifest) { m.Artifacts[0].MIMEType = "application/x-executable" },
		"missing file":         func(m *manifest) { m.Artifacts[0].Path = "missing.pdf" },
		"trusted claim":        func(m *manifest) { m.Evidence[0].SourceKind = "trusted_ci" },
		"unknown artifact":     func(m *manifest) { m.Evidence[0].ArtifactID = "other" },
		"duplicate check":      func(m *manifest) { m.Evidence = append(m.Evidence, m.Evidence[0]) },
		"code mismatch":        func(m *manifest) { code := "revision"; m.Evidence[0].CodeRevision = &code },
		"invalid contribution": func(m *manifest) { m.ContributionIDs = []string{"other-task"} },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			root := fixtureWorkspace(t)
			m := fixtureManifest()
			mutate(&m)
			writeManifest(t, root, m)
			if _, err := Collect(root, fixtureJob()); err == nil {
				t.Fatal("invalid manifest accepted")
			}
		})
	}
}

func TestCollectRejectsUnknownFieldsTrailingJSONAndSize(t *testing.T) {
	for _, change := range []string{"unknown", "trailing", "oversize"} {
		t.Run(change, func(t *testing.T) {
			root := fixtureWorkspace(t)
			dir := filepath.Join(root, protocol.TeamDeliveryDirectory("call-1"))
			file := filepath.Join(dir, "submission.json")
			raw, _ := os.ReadFile(file)
			switch change {
			case "unknown":
				raw = bytes.Replace(raw, []byte(`"schema_version":1`), []byte(`"schema_version":1,"task_id":"another"`), 1)
			case "trailing":
				raw = append(raw, []byte(` {}`)...)
			case "oversize":
				if err := os.WriteFile(filepath.Join(dir, "report.pdf"), bytes.Repeat([]byte{1}, MaxArtifactBytes+1), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if err := os.WriteFile(file, raw, 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := Collect(root, fixtureJob()); err == nil {
				t.Fatal("accepted invalid output")
			}
		})
	}
}

func TestJournalRestartKeepsOriginalBytesAndIsolatesScope(t *testing.T) {
	ctx := context.Background()
	root, private := fixtureWorkspace(t), t.TempDir()
	snapshot, err := Collect(root, fixtureJob())
	if err != nil {
		t.Fatal(err)
	}
	journal, err := OpenJournal(private, "relay-A|daemon-1|owner-1")
	if err != nil {
		t.Fatal(err)
	}
	saved, err := journal.Save(ctx, snapshot)
	if err != nil {
		t.Fatal(err)
	}
	snapshot.Files["report"][0] = '!'
	if saved.Files["report"][0] != '%' {
		t.Fatal("Save returned mutable caller bytes")
	}
	if err := journal.Close(); err != nil {
		t.Fatal(err)
	}
	journal, err = OpenJournal(private, "relay-A|daemon-1|owner-1")
	if err != nil {
		t.Fatal(err)
	}
	defer journal.Close()
	if err := os.WriteFile(filepath.Join(root, protocol.TeamDeliveryDirectory("call-1"), "report.pdf"), []byte("changed after outage"), 0600); err != nil {
		t.Fatal(err)
	}
	changed, err := Collect(root, fixtureJob())
	if err != nil {
		t.Fatal(err)
	}
	again, err := journal.Save(ctx, changed)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(again.Files["report"], saved.Files["report"]) || again.Submission.RequestID != saved.Submission.RequestID {
		t.Fatal("retry changed persisted publication")
	}
	loaded, err := journal.Load(ctx, "call-1")
	if err != nil || !bytes.Equal(loaded.Files["report"], saved.Files["report"]) {
		t.Fatalf("restart lost bytes: %v", err)
	}
	other, err := OpenJournal(private, "relay-B|daemon-1|owner-1")
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	if _, err := other.Load(ctx, "call-1"); !errors.Is(err, ErrSnapshotMissing) {
		t.Fatalf("cross-Relay snapshot visible: %v", err)
	}
	changed.Job.NativeSessionID = "native-other"
	if _, err := journal.Save(ctx, changed); err == nil {
		t.Fatal("source identity changed")
	}
}

func TestJournalConcurrentSaveAndCorruption(t *testing.T) {
	ctx := context.Background()
	journal, err := OpenJournal(t.TempDir(), "relay|daemon|owner")
	if err != nil {
		t.Fatal(err)
	}
	defer journal.Close()
	snapshot, err := Collect(fixtureWorkspace(t), fixtureJob())
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := journal.Save(ctx, snapshot); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	var count int
	if err := journal.db.QueryRow(`SELECT COUNT(*) FROM delivery_snapshots`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("snapshot count: %d %v", count, err)
	}
	if _, err := journal.db.Exec(`UPDATE delivery_snapshots SET digest=?`, strings.Repeat("0", 64)); err != nil {
		t.Fatal(err)
	}
	if _, err := journal.Load(ctx, "call-1"); err == nil {
		t.Fatal("corrupt snapshot accepted")
	}
	if _, err := journal.Save(ctx, snapshot); err == nil {
		t.Fatal("corrupt snapshot overwritten")
	}
}
