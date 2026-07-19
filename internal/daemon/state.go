package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/agentcontrol"
	"github.com/pocketctl/pocketctl/internal/platform"
)

// DaemonState is written to a file by the running daemon
// and read by CLI commands (status) to show daemon info.
type DaemonState struct {
	DaemonID  string         `json:"daemon_id"`
	Version   string         `json:"version"`
	RelayURL  string         `json:"relay_url"`
	Connected bool           `json:"connected"`
	StartedAt time.Time      `json:"started_at"`
	PID       int            `json:"pid"`
	Sessions  []SessionState `json:"sessions"`
}

// SessionState is a snapshot of a single session's status.
type SessionState struct {
	SessionID      string    `json:"session_id"`
	Agent          string    `json:"agent"`
	Cwd            string    `json:"cwd"`
	Status         string    `json:"status"`
	StartedAt      time.Time `json:"started_at"`
	LastActivityAt time.Time `json:"last_activity_at"`
}

// OpenCodeServeState is the private credential needed by a replacement daemon
// to attach to the existing in-memory OpenCode serve process.
type OpenCodeServeState struct {
	PID             int                                      `json:"pid"`
	BaseURL         string                                   `json:"base_url"`
	Password        string                                   `json:"password"`
	Version         string                                   `json:"version"`
	OwnerPID        int                                      `json:"owner_pid"`
	Generation      uint64                                   `json:"generation,omitempty"`
	ManagedSessions map[string]OpenCodeManagedSessionState   `json:"managed_sessions,omitempty"`
	PendingForks    map[string][]OpenCodeManagedSessionState `json:"pending_forks,omitempty"`
	Leases          map[string]agentcontrol.Lease            `json:"leases,omitempty"`
	UpdatedAt       time.Time                                `json:"updated_at"`
}

type OpenCodeManagedSessionState struct {
	CWD         string `json:"cwd"`
	Generation  uint64 `json:"generation"`
	ControlMode string `json:"control_mode"`
}

func OpenCodeServeStatePath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".pocketctl", "opencode-serve.state")
}

func WriteOpenCodeServeState(s *OpenCodeServeState) error {
	path := OpenCodeServeStatePath()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	if err := os.Chmod(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.Marshal(s)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".opencode-serve.state-*")
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
	return syncStateDirectory(filepath.Dir(path))
}

func ReadOpenCodeServeState() (*OpenCodeServeState, error) {
	path := OpenCodeServeStatePath()
	lstat, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !lstat.Mode().IsRegular() || lstat.Mode().Perm() != 0o600 || !stateFileOwnedByCurrentUser(lstat) {
		return nil, fmt.Errorf("opencode serve state must be a private regular file (0600)")
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	fstat, err := f.Stat()
	if err != nil || !os.SameFile(lstat, fstat) || !fstat.Mode().IsRegular() || fstat.Mode().Perm() != 0o600 || !stateFileOwnedByCurrentUser(fstat) {
		return nil, fmt.Errorf("opencode serve state changed while opening")
	}
	data, err := io.ReadAll(io.LimitReader(f, 64<<10))
	if err != nil {
		return nil, err
	}
	after, err := os.Lstat(path)
	if err != nil || !os.SameFile(fstat, after) {
		return nil, fmt.Errorf("opencode serve state changed while reading")
	}
	var s OpenCodeServeState
	if err := json.Unmarshal(data, &s); err != nil {
		return nil, err
	}
	return &s, nil
}

func RemoveOpenCodeServeState() error {
	err := os.Remove(OpenCodeServeStatePath())
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

// ClaimOpenCodeServeState atomically serializes an owner transition and applies
// it only if the record still names the owner observed by the caller.
func ClaimOpenCodeServeState(expectedOwner int, next *OpenCodeServeState) error {
	lockPath := OpenCodeServeStatePath() + ".claim"
	deadline := time.Now().Add(5 * time.Second)
	for {
		err := os.Mkdir(lockPath, 0o700)
		if err == nil {
			break
		}
		if !os.IsExist(err) {
			return err
		}
		if info, statErr := os.Stat(lockPath); statErr == nil && time.Since(info.ModTime()) > 30*time.Second {
			_ = os.RemoveAll(lockPath)
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("timed out acquiring opencode state claim")
		}
		time.Sleep(20 * time.Millisecond)
	}
	defer os.RemoveAll(lockPath)
	current, err := ReadOpenCodeServeState()
	if err != nil {
		return err
	}
	if current.OwnerPID != expectedOwner {
		return fmt.Errorf("opencode state owner changed from %d to %d", expectedOwner, current.OwnerPID)
	}
	return WriteOpenCodeServeState(next)
}

// CleanupOpenCodeServeAfterForcedStop is the CLI-side fallback for a daemon
// that could not run graceful shutdown. It fails closed on live unverifiable
// state and removes credentials only after safe termination or confirmed death.
func CleanupOpenCodeServeAfterForcedStop() error {
	state, err := ReadOpenCodeServeState()
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return RemoveOpenCodeServeState()
	}
	leases := agentcontrol.NewLeaseRegistry()
	leases.Restore(state.Leases)
	if len(leases.Active(state.Generation)) > 0 {
		return nil
	}
	if !platform.NewProcessController().IsAlive(state.PID) {
		return RemoveOpenCodeServeState()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	server, err := adapter.AttachOpencodeServer(ctx, state.BaseURL, state.Password, state.PID, state.Version, state.UpdatedAt)
	cancel()
	if err != nil {
		return fmt.Errorf("preserved opencode serve identity unverifiable: %w", err)
	}
	if err := server.Stop(); err != nil {
		return err
	}
	return RemoveOpenCodeServeState()
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
