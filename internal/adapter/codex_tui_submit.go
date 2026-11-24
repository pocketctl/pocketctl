package adapter

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

// CodexTUISubmitID corroborates a live native input against the TUI's own
// submitted-prompt history in the same configured Codex home. History can be
// disabled or truncated; lack of a match must never promote an ordinary echo.
func CodexTUISubmitID(home, session, text string, observed time.Time) string {
	if home == "" || session == "" || text == "" || observed.IsZero() {
		return ""
	}
	path := filepath.Join(home, "history.jsonl")
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() {
		return ""
	}
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	const limit = 64 << 10
	start := max(int64(0), info.Size()-limit)
	data, err := io.ReadAll(io.NewSectionReader(f, start, info.Size()-start))
	if err != nil {
		return ""
	}
	rows := bytes.Split(data, []byte{'\n'})
	// A truncated leading record and an unfinished final record cannot attest a submission.
	if start > 0 {
		rows = rows[1:]
	}
	for i := len(rows) - 2; i >= 0; i-- {
		var entry struct {
			Session string `json:"session_id"`
			Time    int64  `json:"ts"`
			Text    string `json:"text"`
		}
		if json.Unmarshal(rows[i], &entry) != nil || entry.Session != session || entry.Text != text {
			continue
		}
		if delta := observed.Unix() - entry.Time; delta >= -1 && delta <= 5 {
			return fmt.Sprintf("codex-tui:%x", sha256.Sum256(rows[i]))
		}
	}
	return ""
}
