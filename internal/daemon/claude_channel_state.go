package daemon

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/pocketctl/pocketctl/internal/config"
)

const claudeChannelStateVersion = 1

// ClaudeChannelJournalItem captures the minimal, content-free record the
// daemon needs to neutrally close a Claude Channel approval after a crash.
// Only the state enumeration and IRREVERSIBLE hashes of the identifiers are
// persisted — never the short Claude request id, the tool name, the
// description, the input preview, the verdict, or the capability token.
//
// Design §Task 11 "Crash journal":
// "只持久化 public request UUID、session ID、instance ID 的不可逆哈希、
// 状态枚举和时间;不持久化 short Claude ID、token、tool、description、
// preview 或 verdict".
type ClaudeChannelJournalItem struct {
	// PublicRequestHash is the SHA-256 short hash of the public request UUID.
	// It lets the daemon deduplicate journal entries without storing the UUID
	// itself in plaintext on disk.
	PublicRequestHash string `json:"public_request_hash"`
	// SessionHash is the SHA-256 short hash of the session id.
	SessionHash string `json:"session_hash"`
	// InstanceHash is the SHA-256 short hash of the channel instance id.
	InstanceHash string `json:"instance_hash"`
	// State is the state enumeration at the time of the journal write. The
	// daemon restart path only closes non-terminal states neutrally.
	State string `json:"state"`
	// CreatedAt is the wall-clock creation time. Used only for ordering.
	CreatedAt time.Time `json:"created_at"`
}

// ClaudeChannelJournal is the on-disk crash journal. Items are appended
// atomically before broadcasting an actionable approval_request; on daemon
// restart, every non-terminal item is closed with reason=daemon_restarted
// and the journal is cleared. Design §Task 11.
type ClaudeChannelJournal struct {
	Version int                      `json:"version"`
	Items   []ClaudeChannelJournalItem `json:"items"`
}

// ClaudeChannelStatePath returns the journal file path.
func ClaudeChannelStatePath() string {
	home, _ := config.HomeDir()
	return filepath.Join(home, ".pocketctl", "claude-channel.journal")
}

// HashClaudeChannelID returns the irreversible short hash of an identifier
// (session id, instance id, or public request UUID). The hash is the first
// 16 hex chars (64 bits) of SHA-256 — enough for dedup, irreversible.
func HashClaudeChannelID(id string) string {
	sum := sha256.Sum256([]byte(id))
	return hex.EncodeToString(sum[:8])
}

// WriteClaudeChannelJournal atomically persists the journal. An empty Items
// slice clears the file. The parent dir is 0700; the file is 0600.
func WriteClaudeChannelJournal(journal ClaudeChannelJournal) error {
	path := ClaudeChannelStatePath()
	if len(journal.Items) == 0 {
		return ClearClaudeChannelJournal()
	}
	journal.Version = claudeChannelStateVersion
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return err
	}
	data, err := json.Marshal(journal)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".claude-channel.journal-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		return err
	}
	return syncStateDirectory(dir)
}

// ReadClaudeChannelJournal reads and validates the journal. Returns (nil,
// nil) when the file does not exist.
func ReadClaudeChannelJournal() (*ClaudeChannelJournal, error) {
	path := ClaudeChannelStatePath()
	lstat, err := os.Lstat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	if !lstat.Mode().IsRegular() || lstat.Mode().Perm() != 0o600 || !stateFileOwnedByCurrentUser(lstat) {
		return nil, fmt.Errorf("claude channel journal must be a private regular file (0600)")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	fstat, err := file.Stat()
	if err != nil || !os.SameFile(lstat, fstat) || !fstat.Mode().IsRegular() || fstat.Mode().Perm() != 0o600 || !stateFileOwnedByCurrentUser(fstat) {
		return nil, fmt.Errorf("claude channel journal changed while opening")
	}
	data, err := io.ReadAll(io.LimitReader(file, 1<<20))
	if err != nil {
		return nil, err
	}
	var journal ClaudeChannelJournal
	if err := json.Unmarshal(data, &journal); err != nil {
		return nil, err
	}
	if journal.Version != claudeChannelStateVersion {
		return nil, fmt.Errorf("unsupported claude channel journal version %d", journal.Version)
	}
	for _, item := range journal.Items {
		if item.PublicRequestHash == "" || item.SessionHash == "" ||
			item.InstanceHash == "" || item.State == "" || item.CreatedAt.IsZero() {
			return nil, fmt.Errorf("invalid claude channel journal item")
		}
	}
	return &journal, nil
}

// ClearClaudeChannelJournal removes the journal file.
func ClearClaudeChannelJournal() error {
	path := ClaudeChannelStatePath()
	err := os.Remove(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if err == nil {
		return syncStateDirectory(filepath.Dir(path))
	}
	return nil
}
