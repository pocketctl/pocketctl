package teamdelivery

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestExternalDeliveryImportFreezesOriginalBytesAndRejectsTraversal(t *testing.T) {
	ctx := context.Background()
	workspace := t.TempDir()
	required := true
	value := manifest{SchemaVersion: 1, PublishScope: "team", Summary: "External bounded result", Artifacts: []manifestArtifact{{ID: "proof", Path: "evidence/proof.md", MIMEType: "text/markdown", Required: &required}}}
	metadata, _ := json.Marshal(value)
	files := map[string][]byte{"submission.json": metadata, "evidence/proof.md": []byte("original\n")}
	read := func(_ context.Context, name string, limit int64) ([]byte, error) { return files[name], nil }
	summary, err := ImportExternalDelivery(ctx, workspace, "call", read)
	if err != nil || summary != value.Summary {
		t.Fatalf("import: %s %v", summary, err)
	}
	if _, err = ImportExternalDelivery(ctx, workspace, "call", read); err != nil {
		t.Fatal(err)
	}
	files["evidence/proof.md"] = []byte("changed\n")
	if _, err = ImportExternalDelivery(ctx, workspace, "call", read); err == nil {
		t.Fatal("replaced immutable export")
	}
	content, err := os.ReadFile(filepath.Join(workspace, protocol.TeamDeliveryDirectory("call"), "evidence/proof.md"))
	if err != nil || string(content) != "original\n" {
		t.Fatal("original bytes lost")
	}
	value.Artifacts[0].Path = "../../escaped"
	files["submission.json"], _ = json.Marshal(value)
	if _, err = ImportExternalDelivery(ctx, workspace, "other", read); err == nil {
		t.Fatal("traversal accepted")
	}
}

func TestExternalDeliveryImportRejectsRevocationAndSymlinkBeforeInstall(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	workspace := t.TempDir()
	target := t.TempDir()
	if err := os.Symlink(target, filepath.Join(workspace, ".pocketctl-deliveries")); err != nil {
		t.Fatal(err)
	}
	called := false
	read := func(context.Context, string, int64) ([]byte, error) { called = true; return nil, nil }
	if _, err := ImportExternalDelivery(ctx, workspace, "call", read); err == nil || called {
		t.Fatal("followed source directory symlink")
	}
	cancel()
	if _, err := ImportExternalDelivery(ctx, t.TempDir(), "call", read); err == nil {
		t.Fatal("cancelled import installed")
	}
}

func TestExternalDeliveryImportFeedsExistingCollector(t *testing.T) {
	workspace := t.TempDir()
	job := fixtureJob()
	job.Provider = "agentteams"
	value := fixtureManifest()
	metadata, _ := json.Marshal(value)
	summary, err := ImportExternalDelivery(context.Background(), workspace, job.CallID, func(_ context.Context, name string, _ int64) ([]byte, error) {
		if name == "submission.json" {
			return metadata, nil
		}
		return []byte("actual artifact"), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := Collect(workspace, job)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Submission.Summary != summary || snapshot.Submission.SourceCallID != job.CallID || string(snapshot.Files["report"]) != "actual artifact" {
		t.Fatal("publication snapshot lost original source")
	}
}
