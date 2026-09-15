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

func TestCodexTitleIndexLooksUpAcrossAdditionalHomes(t *testing.T) {
	primaryHome := t.TempDir()
	extraHome := t.TempDir()
	primaryCodex := filepath.Join(primaryHome, "codex")
	t.Setenv("HOME", primaryHome)
	t.Setenv("CODEX_HOME", primaryCodex)
	t.Setenv("POCKETCTL_CODEX_HOMES", extraHome)

	if err := os.MkdirAll(primaryCodex, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(primaryCodex, "session_index.jsonl"),
		[]byte(`{"id":"sess-primary","thread_name":"primary title","updated_at":"2026-09-14T09:00:00Z"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(extraHome, "session_index.jsonl"),
		[]byte(`{"id":"sess-extra","thread_name":"extra title","updated_at":"2026-09-14T09:05:00Z"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	index := NewCodexTitleIndex()
	if title, ok := index.Lookup("sess-primary"); !ok || title.Name != "primary title" {
		t.Fatalf("primary home lookup: title=%+v ok=%v", title, ok)
	}
	if title, ok := index.Lookup("sess-extra"); !ok || title.Name != "extra title" {
		t.Fatalf("additional home lookup: title=%+v ok=%v", title, ok)
	}
}

func TestCodexTitleIndexReplacesStaleEntries(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("CODEX_HOME", dir)
	index := NewCodexTitleIndex()
	path := filepath.Join(dir, "session_index.jsonl")
	if err := os.WriteFile(path, []byte(
		`{"id":"sess-x","thread_name":"old","updated_at":"2026-09-14T09:00:00Z"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, ok := index.Lookup("sess-x"); !ok {
		t.Fatal("initial record missing")
	}

	// The index is rewritten without sess-x; the stale title must disappear.
	if err := os.WriteFile(path, []byte(
		`{"id":"sess-y","thread_name":"kept","updated_at":"2026-09-14T09:10:00Z"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, ok := index.Lookup("sess-x"); ok {
		t.Fatal("stale title survived a rewrite that dropped its record")
	}
	if _, ok := index.Lookup("sess-y"); !ok {
		t.Fatal("rewritten record missing")
	}
}

func TestCodexTitleIndexEqualTimestampPrefersPrimaryHome(t *testing.T) {
	primaryHome := t.TempDir()
	extraHome := t.TempDir()
	primaryCodex := filepath.Join(primaryHome, "codex")
	t.Setenv("HOME", primaryHome)
	t.Setenv("CODEX_HOME", primaryCodex)
	t.Setenv("POCKETCTL_CODEX_HOMES", extraHome)
	if err := os.MkdirAll(primaryCodex, 0o755); err != nil {
		t.Fatal(err)
	}

	const ts = `"updated_at":"2026-09-14T09:00:00Z"`
	if err := os.WriteFile(filepath.Join(primaryCodex, "session_index.jsonl"),
		[]byte(`{"id":"sess-s","thread_name":"primary name",`+ts+"}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(extraHome, "session_index.jsonl"),
		[]byte(`{"id":"sess-s","thread_name":"mirror name",`+ts+"}\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	if title, _ := NewCodexTitleIndex().Lookup("sess-s"); title.Name != "primary name" {
		t.Fatalf("equal updated_at must keep the primary-home title, got %q", title.Name)
	}
}

func TestCodexTitleIndexFallsBackToAdditionalHomeAfterPrimaryDrops(t *testing.T) {
	primaryHome := t.TempDir()
	extraHome := t.TempDir()
	primaryCodex := filepath.Join(primaryHome, "codex")
	t.Setenv("HOME", primaryHome)
	t.Setenv("CODEX_HOME", primaryCodex)
	t.Setenv("POCKETCTL_CODEX_HOMES", extraHome)
	if err := os.MkdirAll(primaryCodex, 0o755); err != nil {
		t.Fatal(err)
	}

	primaryIndex := filepath.Join(primaryCodex, "session_index.jsonl")
	if err := os.WriteFile(primaryIndex, []byte(
		`{"id":"sess-f","thread_name":"primary title","updated_at":"2026-09-14T09:00:00Z"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(extraHome, "session_index.jsonl"), []byte(
		`{"id":"sess-f","thread_name":"extra title","updated_at":"2026-09-14T08:00:00Z"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	index := NewCodexTitleIndex()
	if title, _ := index.Lookup("sess-f"); title.Name != "primary title" {
		t.Fatalf("primary should win while present, got %q", title.Name)
	}

	// Primary drops the record; the older additional-home record must surface.
	if err := os.WriteFile(primaryIndex, []byte(
		`{"id":"sess-other","thread_name":"other","updated_at":"2026-09-14T09:05:00Z"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if title, ok := index.Lookup("sess-f"); !ok || title.Name != "extra title" {
		t.Fatalf("after primary dropped the record, want extra-home fallback, got ok=%v title=%+v", ok, title)
	}
}
