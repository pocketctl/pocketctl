package daemon

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRotatingLogWriterWritesDatedFile(t *testing.T) {
	dir := t.TempDir()
	w, err := NewRotatingLogWriter(dir, "daemon")
	if err != nil {
		t.Fatalf("new writer: %v", err)
	}
	defer w.Close()

	if _, err := w.Write([]byte("hello\n")); err != nil {
		t.Fatalf("write: %v", err)
	}

	want := filepath.Join(dir, "daemon-"+time.Now().Format("2006-01-02")+".log")
	if w.CurrentPath() != want {
		t.Errorf("CurrentPath = %q, want %q", w.CurrentPath(), want)
	}
	data, err := os.ReadFile(want)
	if err != nil {
		t.Fatalf("read dated file: %v", err)
	}
	if !strings.Contains(string(data), "hello") {
		t.Errorf("dated file missing content: %q", data)
	}
}

func TestRotatingLogWriterRotatesOnDateChange(t *testing.T) {
	dir := t.TempDir()
	w := &RotatingLogWriter{dir: dir, prefix: "daemon"}

	// Simulate two consecutive days by driving rotateLocked directly.
	day1 := time.Date(2026, 6, 29, 23, 59, 0, 0, time.UTC)
	day2 := time.Date(2026, 6, 30, 0, 1, 0, 0, time.UTC)

	if err := w.rotateLocked(day1); err != nil {
		t.Fatalf("rotate day1: %v", err)
	}
	w.file.WriteString("day1\n")
	if err := w.rotateLocked(day2); err != nil {
		t.Fatalf("rotate day2: %v", err)
	}
	w.file.WriteString("day2\n")
	w.Close()

	f1 := filepath.Join(dir, "daemon-2026-06-29.log")
	f2 := filepath.Join(dir, "daemon-2026-06-30.log")
	for _, f := range []string{f1, f2} {
		if _, err := os.Stat(f); err != nil {
			t.Errorf("expected dated file %s: %v", f, err)
		}
	}
	// Content must land in the right day's file, not bleed across.
	d1, _ := os.ReadFile(f1)
	d2, _ := os.ReadFile(f2)
	if !strings.Contains(string(d1), "day1") || strings.Contains(string(d1), "day2") {
		t.Errorf("day1 file wrong content: %q", d1)
	}
	if !strings.Contains(string(d2), "day2") || strings.Contains(string(d2), "day1") {
		t.Errorf("day2 file wrong content: %q", d2)
	}
}

func TestLatestLogPath(t *testing.T) {
	dir := t.TempDir()
	// Override LogDir via HOME so LatestLogPath looks in our temp tree.
	t.Setenv("HOME", dir)
	logs := filepath.Join(dir, ".pocketctl", "logs")
	if err := os.MkdirAll(logs, 0755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"daemon-2026-06-01.log", "daemon-2026-06-29.log", "daemon-2026-06-15.log", "ignore.txt"} {
		if err := os.WriteFile(filepath.Join(logs, name), []byte("x"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	got := LatestLogPath()
	want := filepath.Join(logs, "daemon-2026-06-29.log")
	if got != want {
		t.Errorf("LatestLogPath = %q, want %q", got, want)
	}
}
