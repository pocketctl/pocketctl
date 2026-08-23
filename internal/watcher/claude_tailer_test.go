package watcher

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func claudeAssistantLine(text string) string {
	return `{"type":"assistant","sessionId":"s1","message":{"role":"assistant","model":"claude-sonnet-4","content":[{"type":"text","text":"` + text + `"}]}}`
}

func TestClaudeTailerStableIDsAcrossRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	line := claudeAssistantLine("hello")
	if err := os.WriteFile(path, []byte(line+"\n"+line+"\n"), 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	first, err := NewClaudeJSONLTailerFromStart(path, "session-1")
	if err != nil {
		t.Fatalf("new first tailer: %v", err)
	}
	firstEvents, _, err := first.TailNewLines()
	first.Close()
	if err != nil || len(firstEvents) != 2 {
		t.Fatalf("first events=%#v err=%v", firstEvents, err)
	}
	if firstEvents[0].EventID == "" || firstEvents[0].EventID == firstEvents[1].EventID {
		t.Fatalf("stable IDs missing/colliding: %#v", firstEvents)
	}

	second, err := NewClaudeJSONLTailerFromStart(path, "session-1")
	if err != nil {
		t.Fatalf("new second tailer: %v", err)
	}
	secondEvents, _, err := second.TailNewLines()
	second.Close()
	if err != nil || len(secondEvents) != 2 {
		t.Fatalf("second events=%#v err=%v", secondEvents, err)
	}
	for i := range firstEvents {
		if firstEvents[i].EventID != secondEvents[i].EventID {
			t.Fatalf("event[%d] ID changed across restart: %q != %q", i, firstEvents[i].EventID, secondEvents[i].EventID)
		}
	}
}

func TestClaudeTailerDoesNotCommitPartialRecord(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	line := claudeAssistantLine("partial")
	split := len(line) / 2
	if err := os.WriteFile(path, []byte(line[:split]), 0o600); err != nil {
		t.Fatalf("write partial: %v", err)
	}
	tailer, err := NewClaudeJSONLTailerFromStart(path, "session-1")
	if err != nil {
		t.Fatalf("new tailer: %v", err)
	}
	defer tailer.Close()
	if events, lines, err := tailer.TailNewLines(); err != nil || len(events) != 0 || len(lines) != 0 {
		t.Fatalf("partial read events=%v lines=%v err=%v", events, lines, err)
	}
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatalf("open append: %v", err)
	}
	if _, err := file.WriteString(line[split:] + "\n"); err != nil {
		file.Close()
		t.Fatalf("append remainder: %v", err)
	}
	file.Close()
	events, _, err := tailer.TailNewLines()
	if err != nil || len(events) != 1 || events[0].Text != "partial" {
		t.Fatalf("completed record events=%#v err=%v", events, err)
	}
}

func TestClaudeTailerHandlesTruncateAndReplace(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	if err := os.WriteFile(path, []byte(claudeAssistantLine("first")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	tailer, err := NewClaudeJSONLTailerFromStart(path, "session-1")
	if err != nil {
		t.Fatal(err)
	}
	defer tailer.Close()
	first, _, _ := tailer.TailNewLines()
	if len(first) != 1 {
		t.Fatalf("first=%#v", first)
	}

	if err := os.WriteFile(path, []byte(claudeAssistantLine("x")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	truncated, _, err := tailer.TailNewLines()
	if err != nil || len(truncated) != 1 || truncated[0].Text != "x" {
		t.Fatalf("truncated=%#v err=%v", truncated, err)
	}

	replacement := path + ".new"
	if err := os.WriteFile(replacement, []byte(claudeAssistantLine("replacement")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(replacement, path); err != nil {
		t.Fatal(err)
	}
	replaced, _, err := tailer.TailNewLines()
	if err != nil || len(replaced) != 1 || replaced[0].Text != "replacement" {
		t.Fatalf("replaced=%#v err=%v", replaced, err)
	}
}

func TestClaudeTailerSkipsOversizedRecordAndContinues(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	oversized := strings.Repeat("x", 512)
	valid := claudeAssistantLine("after")
	if err := os.WriteFile(path, []byte(oversized+"\n"+valid+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	tailer, err := NewClaudeJSONLTailerFromStart(path, "session-1")
	if err != nil {
		t.Fatal(err)
	}
	defer tailer.Close()
	tailer.maxRecordBytes = 256
	events, _, err := tailer.TailNewLines()
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 || events[0].Type != "sync_warning" || events[0].Reason != "jsonl_record_too_large" || events[1].Text != "after" {
		t.Fatalf("events=%#v", events)
	}
}

func TestClaudeJSONLV2FlagDefaultsOff(t *testing.T) {
	t.Setenv("POCKETCTL_CLAUDE_JSONL_V2", "")
	if ClaudeJSONLV2Enabled() {
		t.Fatal("Claude JSONL V2 must remain rollout-gated by default")
	}
	t.Setenv("POCKETCTL_CLAUDE_JSONL_V2", "1")
	if !ClaudeJSONLV2Enabled() {
		t.Fatal("Claude JSONL V2 flag was not enabled")
	}
}
