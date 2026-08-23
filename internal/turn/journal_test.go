package turn

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

func journalPath(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "turn-state-v1.json")
}

func TestJournalSaveLoadRoundTrip(t *testing.T) {
	path := journalPath(t)
	j, err := OpenJournal(path)
	if err != nil {
		t.Fatal(err)
	}
	entries := []JournalEntry{
		{
			SessionID: "sess-1", TurnID: "turn:v1:codex:t1", State: protocol.TurnStateRunning,
			StartedAt: time.Now().UTC().Truncate(time.Second), RequestIDHash: "abcd1234abcd1234",
			ExpectedSourceTurnID: "native-pending-1",
		},
		{
			SessionID: "sess-2", AgentID: "agent-1", TurnID: "turn:v1:codex:t2",
			State: protocol.TurnStateInterruptRequested, Origin: protocol.TurnOriginRequest,
			ParentTurnID: "turn:v1:codex:root",
		},
	}
	if err := j.Save(entries); err != nil {
		t.Fatal(err)
	}
	loaded, err := j.Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded) != 2 || loaded[0].TurnID != entries[0].TurnID || loaded[0].ExpectedSourceTurnID != "native-pending-1" || loaded[1].AgentID != "agent-1" ||
		loaded[1].ParentTurnID != "turn:v1:codex:root" {
		t.Fatalf("round trip = %+v", loaded)
	}
}

func TestJournalPermissionsAre0600(t *testing.T) {
	path := journalPath(t)
	j, _ := OpenJournal(path)
	if err := j.Save([]JournalEntry{{SessionID: "s", TurnID: "t", State: protocol.TurnStateRunning}}); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("journal mode = %v, want 0600", info.Mode().Perm())
	}
}

func TestJournalNeverContainsContent(t *testing.T) {
	path := journalPath(t)
	j, _ := OpenJournal(path)
	prompt := "TOP-SECRET-FIXTURE-PROMPT"
	toolOutput := "SECRET-TOOL-OUTPUT"
	err := j.Save([]JournalEntry{{
		SessionID: "sess-1",
		TurnID:    LogicalTurnID("codex", "sess-1", "", "request", HashRequestID(prompt)),
		State:     protocol.TurnStateRunning,
	}})
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	if strings.Contains(string(raw), prompt) || strings.Contains(string(raw), toolOutput) {
		t.Fatal("journal serialized prompt or tool content")
	}
	var generic []map[string]interface{}
	if err := json.Unmarshal(raw, &generic); err != nil {
		t.Fatal(err)
	}
	for _, e := range generic {
		for k := range e {
			switch k {
			case "session_id", "agent_id", "turn_id", "source_turn_id", "expected_source_turn_id", "parent_turn_id", "state", "origin", "confidence", "started_at", "request_id_hash":
			default:
				t.Errorf("unexpected journal key %q — content fields are forbidden", k)
			}
		}
	}
}

func TestJournalCorruptFileQuarantinedFailOpen(t *testing.T) {
	path := journalPath(t)
	if err := os.WriteFile(path, []byte("{not-json"), 0o600); err != nil {
		t.Fatal(err)
	}
	j, err := OpenJournal(path)
	if err == nil {
		t.Fatal("corrupt journal must surface an error to the caller for warning")
	}
	if j == nil {
		t.Fatal("but the journal handle must still be usable (fail-open)")
	}
	matches, _ := filepath.Glob(path + ".corrupt-*")
	if len(matches) != 1 {
		t.Fatalf("corrupt file must be quarantined exactly once, got %v", matches)
	}
	// After quarantine the journal is empty and functional.
	entries, err := j.Load()
	if err != nil || len(entries) != 0 {
		t.Fatalf("post-quarantine load = (%v, %+v)", err, entries)
	}
	if err := j.Save([]JournalEntry{{SessionID: "s", TurnID: "t", State: protocol.TurnStateRunning}}); err != nil {
		t.Fatalf("post-quarantine save: %v", err)
	}
}

func TestJournalAtomicReplace(t *testing.T) {
	path := journalPath(t)
	j, _ := OpenJournal(path)
	if err := j.Save([]JournalEntry{{SessionID: "s1", TurnID: "t1", State: protocol.TurnStateRunning}}); err != nil {
		t.Fatal(err)
	}
	if err := j.Save([]JournalEntry{{SessionID: "s2", TurnID: "t2", State: protocol.TurnStateRunning}}); err != nil {
		t.Fatal(err)
	}
	loaded, _ := j.Load()
	if len(loaded) != 1 || loaded[0].SessionID != "s2" {
		t.Fatalf("save must fully replace content, got %+v", loaded)
	}
	leftovers, _ := filepath.Glob(path + ".tmp-*")
	if len(leftovers) != 0 {
		t.Errorf("temp files leaked: %v", leftovers)
	}
}

func TestJournalDropsTerminalEntriesOnLoad(t *testing.T) {
	path := journalPath(t)
	j, _ := OpenJournal(path)
	// Simulate a crash mid-write that left a terminal entry behind.
	raw, _ := json.Marshal([]JournalEntry{
		{SessionID: "s1", TurnID: "t1", State: protocol.TurnStateCompleted},
		{SessionID: "s2", TurnID: "t2", State: protocol.TurnStateRunning},
	})
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	loaded, err := j.Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded) != 1 || loaded[0].TurnID != "t2" {
		t.Fatalf("load = %+v, want only the active entry", loaded)
	}
}

func TestJournalMissingFileIsEmpty(t *testing.T) {
	j, err := OpenJournal(filepath.Join(t.TempDir(), "absent.json"))
	if err != nil {
		t.Fatalf("missing journal is not an error: %v", err)
	}
	entries, err := j.Load()
	if err != nil || entries != nil {
		t.Fatalf("load = (%v, %+v)", err, entries)
	}
}

func TestJournalConcurrentSavesRaceSafe(t *testing.T) {
	path := journalPath(t)
	j, _ := OpenJournal(path)
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_ = j.Save([]JournalEntry{{
				SessionID: "sess", TurnID: "turn:v1:codex:parallel", State: protocol.TurnStateRunning,
			}})
			_, _ = j.Load()
		}(i)
	}
	wg.Wait()
	loaded, err := j.Load()
	if err != nil || len(loaded) != 1 {
		t.Fatalf("final load = (%v, %+v)", err, loaded)
	}
}
