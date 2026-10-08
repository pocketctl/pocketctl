package session

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/config"
)

// A retirement excludes one failed daemon-owned create from automatic runtime
// discovery. Native history remains intact and can still be read explicitly.
type collaborationRetirement struct {
	SchemaVersion   int    `json:"schema_version"`
	NativeSessionID string `json:"native_session_id"`
	Agent           string `json:"agent"`
	BindingID       string `json:"binding_id"`
	WorkspaceRoot   string `json:"workspace_root"`
	Cwd             string `json:"cwd"`
}

func collaborationRetirementPath(id string) (string, error) {
	home, err := config.HomeDir()
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256([]byte(id))
	return filepath.Join(home, ".pocketctl", "collaboration-retired", fmt.Sprintf("%x.json", digest)), nil
}

func readCollaborationRetirement(path, id string) (*collaborationRetirement, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > 16*1024 {
		return nil, fmt.Errorf("invalid collaboration retirement file")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var record collaborationRetirement
	if err := json.Unmarshal(data, &record); err != nil {
		return nil, err
	}
	if record.SchemaVersion != 1 || record.NativeSessionID != id || record.BindingID == "" ||
		(record.Agent != adapter.AgentCodex && record.Agent != adapter.AgentClaude && record.Agent != adapter.AgentDSH) ||
		!filepath.IsAbs(record.WorkspaceRoot) || record.Cwd != collaborationWorkspace(record.WorkspaceRoot, record.BindingID) {
		return nil, fmt.Errorf("invalid collaboration retirement identity")
	}
	return &record, nil
}

func persistCollaborationRetirement(binding collaborationNativeBinding, workspace string) (*collaborationRetirement, error) {
	record := &collaborationRetirement{
		SchemaVersion: 1, NativeSessionID: binding.NativeSessionID, Agent: binding.Agent,
		BindingID: binding.BindingID, WorkspaceRoot: filepath.Dir(filepath.Dir(filepath.Dir(workspace))), Cwd: workspace,
	}
	path, err := collaborationRetirementPath(record.NativeSessionID)
	if err != nil {
		return nil, err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("invalid collaboration retirement directory")
	}
	if existing, err := readCollaborationRetirement(path, record.NativeSessionID); err == nil {
		if *existing != *record {
			return nil, fmt.Errorf("collaboration retirement belongs to another binding")
		}
		return existing, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	data, err := json.Marshal(record)
	if err != nil {
		return nil, err
	}
	temp, err := os.CreateTemp(dir, ".retirement-*")
	if err != nil {
		return nil, err
	}
	defer os.Remove(temp.Name())
	defer temp.Close()
	if _, err := temp.Write(data); err != nil {
		return nil, err
	}
	if err := temp.Sync(); err != nil {
		return nil, err
	}
	if err := temp.Close(); err != nil {
		return nil, err
	}
	// Link installs a complete immutable record atomically and never replaces
	// an existing foreign record, including a concurrent writer's record.
	if err := os.Link(temp.Name(), path); err != nil {
		if existing, readErr := readCollaborationRetirement(path, record.NativeSessionID); readErr == nil && *existing == *record {
			return existing, nil
		}
		return nil, err
	}
	if runtime.GOOS != "windows" {
		directory, err := os.Open(dir)
		if err != nil {
			return nil, err
		}
		defer directory.Close()
		if err := directory.Sync(); err != nil {
			return nil, err
		}
	}
	return record, nil
}

func (sm *SessionManager) isRetiredCollaborationSession(id, agent, cwd string) bool {
	if id == "" {
		return false
	}
	sm.mu.RLock()
	record, checked := sm.collaborationRetirements[id]
	sm.mu.RUnlock()
	if !checked {
		path, pathErr := collaborationRetirementPath(id)
		var err error
		if pathErr == nil {
			record, err = readCollaborationRetirement(path, id)
		}
		if pathErr != nil || (err != nil && !errors.Is(err, os.ErrNotExist)) {
			slog.Warn("read collaboration retirement", "session", id, "error", errors.Join(pathErr, err))
		}
		sm.mu.Lock()
		if current, exists := sm.collaborationRetirements[id]; exists {
			record = current
		} else {
			if sm.collaborationRetirements == nil {
				sm.collaborationRetirements = make(map[string]*collaborationRetirement)
			}
			sm.collaborationRetirements[id] = record
		}
		sm.mu.Unlock()
	}
	return matchesCollaborationRetirement(record, agent, cwd)
}

func matchesCollaborationRetirement(record *collaborationRetirement, agent, cwd string) bool {
	return record != nil && record.Agent == agent && (cwd == "" || normalizeCwd(cwd) == record.Cwd)
}

// Caller holds sm.mu. The discovery preflight loads persisted records; this
// final check also fences a retirement committed while discovery waited.
func (sm *SessionManager) retiredCollaborationSessionLocked(id, agent, cwd string) bool {
	return matchesCollaborationRetirement(sm.collaborationRetirements[id], agent, cwd)
}
