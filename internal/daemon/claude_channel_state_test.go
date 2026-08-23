package daemon

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestClaudeChannelJournalRoundTrip verifies the journal persists and
// reloads items with the expected irreversible hashes, state enum, and time.
func TestClaudeChannelJournalRoundTrip(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	now := time.Now().UTC().Truncate(time.Second)
	journal := ClaudeChannelJournal{
		Items: []ClaudeChannelJournalItem{
			{
				PublicRequestHash: HashClaudeChannelID("d9428888-122b-11e1-b85c-61cd3cbb3210"),
				SessionHash:       HashClaudeChannelID("session-A"),
				InstanceHash:      HashClaudeChannelID("instance-A"),
				State:             "pending_remote",
				CreatedAt:         now,
			},
		},
	}
	if err := WriteClaudeChannelJournal(journal); err != nil {
		t.Fatal(err)
	}
	path := ClaudeChannelStatePath()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("journal perm=%o want 600", info.Mode().Perm())
	}
	dir, _ := os.Stat(filepath.Dir(path))
	if dir.Mode().Perm() != 0o700 {
		t.Fatalf("journal dir perm=%o want 700", dir.Mode().Perm())
	}
	loaded, err := ReadClaudeChannelJournal()
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded.Items) != 1 {
		t.Fatalf("items=%d", len(loaded.Items))
	}
	got := loaded.Items[0]
	if got.PublicRequestHash != journal.Items[0].PublicRequestHash ||
		got.SessionHash != journal.Items[0].SessionHash ||
		got.InstanceHash != journal.Items[0].InstanceHash ||
		got.State != "pending_remote" ||
		!got.CreatedAt.Equal(now) {
		t.Fatalf("round trip mismatch: got=%+v want=%+v", got, journal.Items[0])
	}
}

// TestClaudeChannelJournalHashIsIrreversible verifies the hash is a 16-hex-
// char SHA-256 prefix and the raw identifier cannot be recovered from the
// file. Design §Task 11: "不可逆哈希".
func TestClaudeChannelJournalHashIsIrreversible(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	raw := "d9428888-122b-11e1-b85c-61cd3cbb3210"
	h := HashClaudeChannelID(raw)
	if len(h) != 16 {
		t.Fatalf("hash len=%d want 16", len(h))
	}
	if err := WriteClaudeChannelJournal(ClaudeChannelJournal{
		Items: []ClaudeChannelJournalItem{
			{PublicRequestHash: h, SessionHash: HashClaudeChannelID("s"),
				InstanceHash: HashClaudeChannelID("i"), State: "pending_remote",
				CreatedAt: time.Now()},
		},
	}); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(ClaudeChannelStatePath())
	if err != nil {
		t.Fatal(err)
	}
	// The raw UUID must NOT appear in the file. Only the short hash may.
	if bytes.Contains(body, []byte(raw)) {
		t.Fatalf("journal leaked the raw identifier: %s", body)
	}
	// No content-bearing fields either.
	for _, forbidden := range [][]byte{[]byte("tool_name"), []byte("description"), []byte("input_preview"), []byte("behavior"), []byte("token")} {
		if bytes.Contains(body, forbidden) {
			t.Fatalf("journal leaked forbidden field %q: %s", forbidden, body)
		}
	}
}

// TestClaudeChannelJournalClearRemovesFile verifies Clear removes the file.
func TestClaudeChannelJournalClearRemovesFile(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if err := WriteClaudeChannelJournal(ClaudeChannelJournal{
		Items: []ClaudeChannelJournalItem{
			{PublicRequestHash: "h", SessionHash: "h", InstanceHash: "h",
				State: "pending_remote", CreatedAt: time.Now()},
		},
	}); err != nil {
		t.Fatal(err)
	}
	if err := ClearClaudeChannelJournal(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(ClaudeChannelStatePath()); !os.IsNotExist(err) {
		t.Fatalf("journal not removed: %v", err)
	}
}

// TestClaudeChannelJournalReadMissingReturnsNil verifies a missing journal
// returns (nil, nil) so the daemon restart path can no-op cleanly.
func TestClaudeChannelJournalReadMissingReturnsNil(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	got, err := ReadClaudeChannelJournal()
	if err != nil {
		t.Fatal(err)
	}
	if got != nil {
		t.Fatalf("missing journal must return nil, got %+v", got)
	}
}

// TestClaudeChannelJournalRejectsTamperedPermissions verifies a journal file
// with the wrong permissions is refused (defense against tampering).
func TestClaudeChannelJournalRejectsTamperedPermissions(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if err := WriteClaudeChannelJournal(ClaudeChannelJournal{
		Items: []ClaudeChannelJournalItem{
			{PublicRequestHash: "h", SessionHash: "h", InstanceHash: "h",
				State: "pending_remote", CreatedAt: time.Now()},
		},
	}); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(ClaudeChannelStatePath(), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadClaudeChannelJournal(); err == nil {
		t.Fatal("journal with wrong perms must be rejected")
	}
}
