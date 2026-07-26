package daemon

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/pocketctl/pocketctl/internal/config"
)

const claudeApprovalStateVersion = 1

type ClaudeApprovalState struct {
	Version  int                       `json:"version"`
	DaemonID string                    `json:"daemon_id"`
	Requests []ClaudeApprovalStateItem `json:"requests"`
}

type ClaudeApprovalStateItem struct {
	SessionID string    `json:"session_id"`
	RequestID string    `json:"request_id"`
	CreatedAt time.Time `json:"created_at"`
}

func ClaudeApprovalStatePath() string {
	home, _ := config.HomeDir()
	return filepath.Join(home, ".pocketctl", "claude-approvals.state")
}

func WriteClaudeApprovalState(state ClaudeApprovalState) error {
	path := ClaudeApprovalStatePath()
	if len(state.Requests) == 0 {
		return ClearClaudeApprovalState()
	}
	state.Version = claudeApprovalStateVersion
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return err
	}
	data, err := json.Marshal(state)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".claude-approvals.state-*")
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

func ReadClaudeApprovalState() (*ClaudeApprovalState, error) {
	path := ClaudeApprovalStatePath()
	lstat, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !lstat.Mode().IsRegular() || lstat.Mode().Perm() != 0o600 || !stateFileOwnedByCurrentUser(lstat) {
		return nil, fmt.Errorf("claude approval state must be a private regular file (0600)")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	fstat, err := file.Stat()
	if err != nil || !os.SameFile(lstat, fstat) || !fstat.Mode().IsRegular() || fstat.Mode().Perm() != 0o600 || !stateFileOwnedByCurrentUser(fstat) {
		return nil, fmt.Errorf("claude approval state changed while opening")
	}
	data, err := io.ReadAll(io.LimitReader(file, 1<<20))
	if err != nil {
		return nil, err
	}
	var state ClaudeApprovalState
	if err := json.Unmarshal(data, &state); err != nil {
		return nil, err
	}
	if state.Version != claudeApprovalStateVersion {
		return nil, fmt.Errorf("unsupported claude approval state version %d", state.Version)
	}
	for _, request := range state.Requests {
		if request.SessionID == "" || request.RequestID == "" || request.CreatedAt.IsZero() {
			return nil, fmt.Errorf("invalid claude approval state item")
		}
	}
	return &state, nil
}

func ClearClaudeApprovalState() error {
	path := ClaudeApprovalStatePath()
	err := os.Remove(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if err == nil {
		return syncStateDirectory(filepath.Dir(path))
	}
	return nil
}
