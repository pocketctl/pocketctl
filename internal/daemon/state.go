package daemon

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"
)

// DaemonState is written to a file by the running daemon
// and read by CLI commands (status) to show daemon info.
type DaemonState struct {
	DaemonID  string        `json:"daemon_id"`
	RelayURL  string        `json:"relay_url"`
	Connected bool          `json:"connected"`
	StartedAt time.Time     `json:"started_at"`
	PID       int           `json:"pid"`
	Sessions  []SessionState `json:"sessions"`
}

// SessionState is a snapshot of a single session's status.
type SessionState struct {
	SessionID string    `json:"session_id"`
	Agent     string    `json:"agent"`
	Cwd       string    `json:"cwd"`
	Status    string    `json:"status"`
	StartedAt time.Time `json:"started_at"`
}

// WriteState persists the daemon state to the state file.
func WriteState(s *DaemonState) error {
	statePath := StatePath()
	if err := os.MkdirAll(filepath.Dir(statePath), 0755); err != nil {
		return err
	}
	data, err := json.Marshal(s)
	if err != nil {
		return err
	}
	return os.WriteFile(statePath, data, 0644)
}

// ReadState reads the daemon state from the state file.
func ReadState() (*DaemonState, error) {
	data, err := os.ReadFile(StatePath())
	if err != nil {
		return nil, err
	}
	var s DaemonState
	if err := json.Unmarshal(data, &s); err != nil {
		return nil, err
	}
	return &s, nil
}
