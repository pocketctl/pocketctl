package watcher

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
)

func TestCodexTUIActivityRequiresMatchingLiveSubmission(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CODEX_HOME", home)
	dir := filepath.Join(home, "sessions")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "rollout.jsonl")
	const header = "{\"type\":\"session_meta\",\"payload\":{\"id\":\"s\"}}\n"
	const native = "{\"type\":\"event_msg\",\"timestamp\":\"2026-11-23T00:00:00Z\",\"payload\":{\"type\":\"user_message\",\"message\":\"hello\"}}\n"
	if err := os.WriteFile(path, []byte(header+native), 0600); err != nil {
		t.Fatal(err)
	}
	ts := time.Date(2026, 11, 23, 0, 0, 0, 0, time.UTC)
	history := filepath.Join(home, "history.jsonl")
	row := fmt.Sprintf("{\"session_id\":\"s\",\"ts\":%d,\"text\":\"hello\"}\n", ts.Unix())
	if err := os.WriteFile(history, []byte(row), 0600); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		session, text string
		at            time.Time
	}{{"other", "hello", ts}, {"s", "different", ts}, {"s", "hello", ts.Add(time.Minute)}} {
		if adapter.CodexTUISubmitID(home, tc.session, tc.text, tc.at) != "" {
			t.Fatal("unrelated history matched")
		}
	}
	tailer, err := NewCodexObserverJSONLTailerFromStart(path)
	if err != nil {
		t.Fatal(err)
	}
	defer tailer.Close()
	events, _, err := tailer.TailNewLines()
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range events {
		if e.LocalSubmitID != "" {
			t.Fatal("startup replay marked as fresh")
		}
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.WriteString(native); err != nil {
		t.Fatal(err)
	}
	f.Close()
	events, _, err = tailer.TailNewLines()
	if err != nil || len(events) != 1 || !strings.HasPrefix(events[0].LocalSubmitID, "codex-tui:") {
		t.Fatalf("live proof missing: %+v, %v", events, err)
	}
}
