package watcher

import (
	"path/filepath"
	"testing"
)

func TestCodexReplayCursorPersistsSafeResumeLine(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "codex-replay-cursors.json")
	sourcePath := filepath.Join(t.TempDir(), "rollout-child.jsonl")
	sourceID := CodexReplaySourceID(sourcePath)

	store, err := NewCodexReplayCursorStore(statePath)
	if err != nil {
		t.Fatal(err)
	}
	if got := store.StartLine(sourcePath); got != 0 {
		t.Fatalf("initial start line = %d", got)
	}
	if err := store.AdvanceEventIDs([]string{
		"unrelated",
		"jsonl:" + sourceID + ":3:0",
		"jsonl:" + sourceID + ":4:0:usage",
	}); err != nil {
		t.Fatal(err)
	}

	reloaded, err := NewCodexReplayCursorStore(statePath)
	if err != nil {
		t.Fatal(err)
	}
	// A single source line may emit several sequenced events. Resume from the
	// highest ACKed line (rather than the following line) so a crash after a
	// partial-line ACK can only cause a stable-ID duplicate, never data loss.
	if got := reloaded.StartLine(sourcePath); got != 4 {
		t.Fatalf("reloaded start line = %d, want 4", got)
	}

	if err := reloaded.AdvanceEventIDs([]string{"jsonl:" + sourceID + ":2:0"}); err != nil {
		t.Fatal(err)
	}
	if got := reloaded.StartLine(sourcePath); got != 4 {
		t.Fatalf("cursor moved backwards to %d", got)
	}
}
