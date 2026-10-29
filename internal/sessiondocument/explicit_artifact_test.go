package sessiondocument

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestReadExplicitArtifactBinaryBoundsAndPaths(t *testing.T) {
	root := t.TempDir()
	content := []byte{0, 255, 2, 3}
	if err := os.WriteFile(filepath.Join(root, "report.pdf"), content, 0600); err != nil {
		t.Fatal(err)
	}
	got, err := ReadExplicitArtifact(root, "report.pdf", 4)
	if err != nil || !bytes.Equal(got, content) {
		t.Fatalf("binary snapshot: %v", err)
	}
	for _, name := range []string{"../report.pdf", "./report.pdf", "/report.pdf", `C:\report.pdf`, "x/../report.pdf", ".", "missing.pdf"} {
		if _, err := ReadExplicitArtifact(root, name, 10); err == nil {
			t.Errorf("accepted path %q", name)
		}
	}
	if _, err := ReadExplicitArtifact(root, "report.pdf", 3); err == nil {
		t.Fatal("oversized file accepted")
	}
	if err := os.WriteFile(filepath.Join(root, "empty.pdf"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadExplicitArtifact(root, "empty.pdf", 3); err == nil {
		t.Fatal("empty file accepted")
	}
}
