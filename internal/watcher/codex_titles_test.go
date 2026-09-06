package watcher

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCodexTitleIndexTracksNamesAndAtomicReplacement(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	index := NewCodexTitleIndex()
	if _, ok := index.Lookup("session"); ok {
		t.Fatal("missing index has a title")
	}
	path := filepath.Join(dir, "session_index.jsonl")
	data := `{"id":"session","thread_name":"新标题","updated_at":"2026-09-06T09:40:00Z"}
{"id":"session","thread_name":"旧标题","updated_at":"2026-09-06T09:30:00Z"}
{"id":"invalid","thread_name":"bad","updated_at":"invalid"}
{"id":"partial"`
	if err := os.WriteFile(path, []byte(data), 0600); err != nil {
		t.Fatal(err)
	}
	if title, ok := index.Lookup("session"); !ok || title.Name != "新标题" {
		t.Fatalf("title=%+v ok=%v", title, ok)
	}
	if _, ok := index.Lookup("invalid"); ok {
		t.Fatal("invalid timestamp accepted")
	}
	replacement := path + ".tmp"
	if err := os.WriteFile(replacement, []byte(`{"id":"session","thread_name":"重命名","updated_at":"2026-09-06T09:50:00Z"}`+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(replacement, path); err != nil {
		t.Fatal(err)
	}
	if title, _ := index.Lookup("session"); title.Name != "重命名" {
		t.Fatalf("replacement not read: %+v", title)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if title, _ := index.Lookup("session"); title.Name != "重命名" {
		t.Fatal("transient missing file lost cached title")
	}
}
