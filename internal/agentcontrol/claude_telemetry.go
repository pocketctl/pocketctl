package agentcontrol

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/pocketctl/pocketctl/internal/config"
	"github.com/pocketctl/pocketctl/internal/platform"
)

const claudeTelemetryVersion = 1

var allowedClaudeFinishReasons = map[string]struct{}{
	"approved": {}, "denied": {}, "timed_out": {}, "hook_disconnected": {},
	"session_drained": {}, "server_shutdown": {},
}

var allowedClaudeJSONLWarnings = map[string]struct{}{
	"jsonl_record_too_large": {}, "jsonl_parse_error": {},
}

// ClaudeTelemetry contains only enumerated counters. There is no schema field
// capable of storing a session ID, request ID, path, prompt, tool input, or
// approval answer.
type ClaudeTelemetry struct {
	Version           int               `json:"version"`
	FinishReasons     map[string]uint64 `json:"finish_reasons,omitempty"`
	ResolvedElsewhere uint64            `json:"resolved_elsewhere,omitempty"`
	Replayed          uint64            `json:"replayed,omitempty"`
	OrphanClosed      uint64            `json:"orphan_closed,omitempty"`
	JSONLWarnings     map[string]uint64 `json:"jsonl_warnings,omitempty"`
}

func claudeTelemetryPath() string {
	dir, err := config.ConfigDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "claude-telemetry.json")
}

func RecordClaudeApprovalFinish(reason string) error {
	if _, ok := allowedClaudeFinishReasons[reason]; !ok {
		return fmt.Errorf("unsupported Claude finish telemetry category %q", reason)
	}
	return updateClaudeTelemetry(func(snapshot *ClaudeTelemetry) { snapshot.FinishReasons[reason]++ })
}

func RecordClaudeResolvedElsewhere() error {
	return updateClaudeTelemetry(func(snapshot *ClaudeTelemetry) { snapshot.ResolvedElsewhere++ })
}

func RecordClaudeReplay(count int) error {
	if count < 0 {
		return errors.New("Claude replay count must be non-negative")
	}
	if count == 0 {
		return nil
	}
	return updateClaudeTelemetry(func(snapshot *ClaudeTelemetry) { snapshot.Replayed += uint64(count) })
}

func RecordClaudeOrphanClosure(count int) error {
	if count < 0 {
		return errors.New("Claude orphan closure count must be non-negative")
	}
	if count == 0 {
		return nil
	}
	return updateClaudeTelemetry(func(snapshot *ClaudeTelemetry) { snapshot.OrphanClosed += uint64(count) })
}

func RecordClaudeJSONLWarning(reason string) error {
	if _, ok := allowedClaudeJSONLWarnings[reason]; !ok {
		return fmt.Errorf("unsupported Claude JSONL telemetry category %q", reason)
	}
	return updateClaudeTelemetry(func(snapshot *ClaudeTelemetry) { snapshot.JSONLWarnings[reason]++ })
}

func LoadClaudeTelemetry() (ClaudeTelemetry, error) {
	path := claudeTelemetryPath()
	if path == "" {
		return ClaudeTelemetry{}, errors.New("resolve Claude telemetry path")
	}
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return newClaudeTelemetry(), nil
	}
	if err != nil {
		return ClaudeTelemetry{}, err
	}
	var snapshot ClaudeTelemetry
	if err := json.Unmarshal(raw, &snapshot); err != nil {
		return ClaudeTelemetry{}, fmt.Errorf("parse Claude telemetry: %w", err)
	}
	if snapshot.Version != claudeTelemetryVersion {
		return ClaudeTelemetry{}, fmt.Errorf("unsupported Claude telemetry version %d", snapshot.Version)
	}
	snapshot.FinishReasons = filterClaudeCounters(snapshot.FinishReasons, allowedClaudeFinishReasons)
	snapshot.JSONLWarnings = filterClaudeCounters(snapshot.JSONLWarnings, allowedClaudeJSONLWarnings)
	return snapshot, nil
}

func newClaudeTelemetry() ClaudeTelemetry {
	return ClaudeTelemetry{
		Version:       claudeTelemetryVersion,
		FinishReasons: make(map[string]uint64),
		JSONLWarnings: make(map[string]uint64),
	}
}

func filterClaudeCounters(input map[string]uint64, allowed map[string]struct{}) map[string]uint64 {
	filtered := make(map[string]uint64)
	for key, count := range input {
		if _, ok := allowed[key]; ok && count > 0 {
			filtered[key] = count
		}
	}
	return filtered
}

func updateClaudeTelemetry(update func(*ClaudeTelemetry)) error {
	path := claudeTelemetryPath()
	if path == "" {
		return errors.New("resolve Claude telemetry path")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	locker := platform.NewLogicalLocker("pocketctl-claude-telemetry")
	var lock platform.Lock
	var err error
	for attempt := 0; attempt < 4; attempt++ {
		lock, err = locker.Acquire(path + ".lock")
		if err == nil {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if err != nil {
		return err
	}
	defer lock.Close()
	snapshot, err := LoadClaudeTelemetry()
	if err != nil {
		return err
	}
	update(&snapshot)
	raw, err := json.Marshal(snapshot)
	if err != nil {
		return err
	}
	raw = append(raw, '\n')
	tmp, err := os.CreateTemp(filepath.Dir(path), ".claude-telemetry-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
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
	return os.Rename(tmpPath, path)
}
