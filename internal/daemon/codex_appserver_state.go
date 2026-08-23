package daemon

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/pocketctl/pocketctl/internal/config"

	"github.com/pocketctl/pocketctl/internal/agentcontrol"
)

type CodexAppServerState struct {
	PID        int                           `json:"pid"`
	OwnerPID   int                           `json:"owner_pid"`
	Endpoint   string                        `json:"endpoint"`
	RemoteURI  string                        `json:"remote_uri"`
	Binary     string                        `json:"binary"`
	Version    string                        `json:"version"`
	SchemaHash string                        `json:"schema_hash,omitempty"`
	Generation uint64                        `json:"generation"`
	Leases     map[string]agentcontrol.Lease `json:"leases,omitempty"`
	Threads    []string                      `json:"threads,omitempty"`
	UpdatedAt  time.Time                     `json:"updated_at"`
}

func CodexAppServerStatePath() string {
	home, _ := config.HomeDir()
	return filepath.Join(home, ".pocketctl", "codex-app-server.state")
}

func WriteCodexAppServerState(state *CodexAppServerState) error {
	if state == nil {
		return fmt.Errorf("codex app-server state is nil")
	}
	path := CodexAppServerStatePath()
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return err
	}
	raw, err := json.Marshal(state)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".codex-app-server.state-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(raw); err != nil {
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

func ReadCodexAppServerState() (*CodexAppServerState, error) {
	path := CodexAppServerStatePath()
	lstat, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !lstat.Mode().IsRegular() || !stateFileHasPrivatePermissions(lstat) || !stateFileOwnedByCurrentUser(lstat) {
		return nil, fmt.Errorf("codex app-server state must be a private regular file (0600)")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	fstat, err := file.Stat()
	if err != nil || !os.SameFile(lstat, fstat) || !fstat.Mode().IsRegular() || !stateFileHasPrivatePermissions(fstat) || !stateFileOwnedByCurrentUser(fstat) {
		return nil, fmt.Errorf("codex app-server state changed while opening")
	}
	raw, err := io.ReadAll(io.LimitReader(file, 128<<10))
	if err != nil {
		return nil, err
	}
	after, err := os.Lstat(path)
	if err != nil || !os.SameFile(fstat, after) {
		return nil, fmt.Errorf("codex app-server state changed while reading")
	}
	var state CodexAppServerState
	if err := json.Unmarshal(raw, &state); err != nil {
		return nil, err
	}
	return &state, nil
}

func RemoveCodexAppServerState() error {
	err := os.Remove(CodexAppServerStatePath())
	if os.IsNotExist(err) {
		return nil
	}
	return err
}
