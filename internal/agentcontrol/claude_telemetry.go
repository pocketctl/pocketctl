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

// allowedClaudeChannel* enums are the ONLY dimensions telemetry may record
// for the Claude Channel permission relay. Design §Task 11: "禁止维度:
// session ID、request ID、cwd、tool、description、preview、answer、token、PID".
var allowedClaudeChannelFallbackReasons = map[string]struct{}{
	"rollout_disabled": {}, "unsupported_version": {}, "organization_disabled": {},
	"bootstrap_unavailable": {}, "bootstrap_timeout": {}, "user_mcp_config_present": {},
	"unsupported_arguments": {}, "probe_failed": {},
}

var allowedClaudeChannelDisconnectReasons = map[string]struct{}{
	"channel_exit": {}, "daemon_shutdown": {}, "instance_unknown": {},
	"token_mismatch": {}, "instance_expired": {}, "duplicate_register": {},
	"server_error": {}, "ipc_error": {},
}

var allowedClaudeChannelVerdictBehaviors = map[string]struct{}{
	"allow": {}, "deny": {},
}

var allowedClaudeChannelResultUnknownReasons = map[string]struct{}{
	"channel_write_failed": {}, "channel_disconnected": {}, "daemon_restarted": {},
	"session_ended": {}, "timed_out": {}, "ipc_error": {},
}

// allowedLauncherSafetyReasons and allowedResumeCleanupReasons enumerate the
// launcher lifecycle safety counters. Only these content-free labels are
// ever stored.
var allowedLauncherSafetyReasons = map[string]struct{}{
	"owned_shim_rejected": {}, "bootstrap_timeout": {},
}

var allowedResumeCleanupReasons = map[string]struct{}{
	"resume_cancelled": {}, "resume_force_killed": {},
}

// ClaudeTelemetry contains only enumerated counters. There is no schema field
// capable of storing a session ID, request ID, path, prompt, tool input, or
// approval answer. The Channel* fields below were added in Task 11 for the
// Claude Code Channel permission relay; they follow the same counter-only
// discipline.
type ClaudeTelemetry struct {
	Version           int               `json:"version"`
	FinishReasons     map[string]uint64 `json:"finish_reasons,omitempty"`
	ResolvedElsewhere uint64            `json:"resolved_elsewhere,omitempty"`
	Replayed          uint64            `json:"replayed,omitempty"`
	OrphanClosed      uint64            `json:"orphan_closed,omitempty"`
	JSONLWarnings     map[string]uint64 `json:"jsonl_warnings,omitempty"`

	// Claude Channel permission-relay counters (Task 11). Every dimension is
	// an enumerated reason/behavior; no PII or content is ever recorded.
	ChannelBootstrapFallback map[string]uint64 `json:"channel_bootstrap_fallback,omitempty"`
	ChannelRegistered        uint64            `json:"channel_registered,omitempty"`
	ChannelDisconnected      map[string]uint64 `json:"channel_disconnected,omitempty"`
	ChannelApprovalObserved  uint64            `json:"channel_approval_observed,omitempty"`
	ChannelVerdictReserved   map[string]uint64 `json:"channel_verdict_reserved,omitempty"`
	ChannelVerdictSubmitted  map[string]uint64 `json:"channel_verdict_submitted,omitempty"`
	ChannelResultUnknown     map[string]uint64 `json:"channel_result_unknown,omitempty"`
	ChannelTerminalProgress  uint64            `json:"channel_terminal_progress,omitempty"`

	// Launcher lifecycle safety counters. Additive, version stays 1: older
	// files simply initialize empty maps. Every dimension is an enumerated
	// content-free reason.
	LauncherSafety map[string]uint64 `json:"launcher_safety,omitempty"`
	ResumeCleanup  map[string]uint64 `json:"resume_cleanup,omitempty"`
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

// --- Claude Channel permission-relay counters (Task 11) -------------------

// RecordClaudeChannelBootstrapFallback increments the bootstrap fallback
// counter for the given reason. reason MUST be one of the enumerated
// allowedClaudeChannelFallbackReasons values.
func RecordClaudeChannelBootstrapFallback(reason string) error {
	if _, ok := allowedClaudeChannelFallbackReasons[reason]; !ok {
		return fmt.Errorf("unsupported Claude Channel fallback reason %q", reason)
	}
	return updateClaudeTelemetry(func(snapshot *ClaudeTelemetry) {
		snapshot.ChannelBootstrapFallback[reason]++
	})
}

// RecordClaudeChannelRegistered increments the channel_registered counter.
func RecordClaudeChannelRegistered() error {
	return updateClaudeTelemetry(func(snapshot *ClaudeTelemetry) { snapshot.ChannelRegistered++ })
}

// RecordClaudeChannelDisconnected increments the channel_disconnected counter
// for the given reason.
func RecordClaudeChannelDisconnected(reason string) error {
	if _, ok := allowedClaudeChannelDisconnectReasons[reason]; !ok {
		return fmt.Errorf("unsupported Claude Channel disconnect reason %q", reason)
	}
	return updateClaudeTelemetry(func(snapshot *ClaudeTelemetry) {
		snapshot.ChannelDisconnected[reason]++
	})
}

// RecordClaudeChannelApprovalObserved increments the approval_observed counter.
func RecordClaudeChannelApprovalObserved() error {
	return updateClaudeTelemetry(func(snapshot *ClaudeTelemetry) { snapshot.ChannelApprovalObserved++ })
}

// RecordClaudeChannelVerdictReserved increments verdict_reserved{behavior}.
// behavior must be allow or deny.
func RecordClaudeChannelVerdictReserved(behavior string) error {
	if _, ok := allowedClaudeChannelVerdictBehaviors[behavior]; !ok {
		return fmt.Errorf("unsupported Claude Channel verdict behavior %q", behavior)
	}
	return updateClaudeTelemetry(func(snapshot *ClaudeTelemetry) {
		snapshot.ChannelVerdictReserved[behavior]++
	})
}

// RecordClaudeChannelVerdictSubmitted increments verdict_submitted{behavior}.
func RecordClaudeChannelVerdictSubmitted(behavior string) error {
	if _, ok := allowedClaudeChannelVerdictBehaviors[behavior]; !ok {
		return fmt.Errorf("unsupported Claude Channel verdict behavior %q", behavior)
	}
	return updateClaudeTelemetry(func(snapshot *ClaudeTelemetry) {
		snapshot.ChannelVerdictSubmitted[behavior]++
	})
}

// RecordClaudeChannelResultUnknown increments verdict_result_unknown{reason}.
func RecordClaudeChannelResultUnknown(reason string) error {
	if _, ok := allowedClaudeChannelResultUnknownReasons[reason]; !ok {
		return fmt.Errorf("unsupported Claude Channel result_unknown reason %q", reason)
	}
	return updateClaudeTelemetry(func(snapshot *ClaudeTelemetry) {
		snapshot.ChannelResultUnknown[reason]++
	})
}

// RecordClaudeChannelTerminalProgress increments the terminal_progress_inferred
// counter (the daemon observed JSONL progress and neutrally closed a card).
func RecordClaudeChannelTerminalProgress() error {
	return updateClaudeTelemetry(func(snapshot *ClaudeTelemetry) { snapshot.ChannelTerminalProgress++ })
}

// --- Launcher lifecycle safety counters ------------------------------------

// RecordLauncherSafety increments a launcher safety counter (e.g. a resolver
// refused a PocketCtl-owned shim, or a Channel bootstrap exceeded its total
// handshake budget). Reasons are enumerated and content-free.
func RecordLauncherSafety(reason string) error {
	if _, ok := allowedLauncherSafetyReasons[reason]; !ok {
		return fmt.Errorf("unsupported launcher safety reason %q", reason)
	}
	return updateClaudeTelemetry(func(snapshot *ClaudeTelemetry) {
		snapshot.LauncherSafety[reason]++
	})
}

// RecordResumeCleanup increments a daemon-owned resume cleanup counter
// (canceled during shutdown, or force killed after the grace period).
func RecordResumeCleanup(reason string) error {
	if _, ok := allowedResumeCleanupReasons[reason]; !ok {
		return fmt.Errorf("unsupported resume cleanup reason %q", reason)
	}
	return updateClaudeTelemetry(func(snapshot *ClaudeTelemetry) {
		snapshot.ResumeCleanup[reason]++
	})
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
	snapshot.ChannelBootstrapFallback = filterClaudeCounters(snapshot.ChannelBootstrapFallback, allowedClaudeChannelFallbackReasons)
	snapshot.ChannelDisconnected = filterClaudeCounters(snapshot.ChannelDisconnected, allowedClaudeChannelDisconnectReasons)
	snapshot.ChannelVerdictReserved = filterClaudeCounters(snapshot.ChannelVerdictReserved, allowedClaudeChannelVerdictBehaviors)
	snapshot.ChannelVerdictSubmitted = filterClaudeCounters(snapshot.ChannelVerdictSubmitted, allowedClaudeChannelVerdictBehaviors)
	snapshot.ChannelResultUnknown = filterClaudeCounters(snapshot.ChannelResultUnknown, allowedClaudeChannelResultUnknownReasons)
	snapshot.LauncherSafety = filterClaudeCounters(snapshot.LauncherSafety, allowedLauncherSafetyReasons)
	snapshot.ResumeCleanup = filterClaudeCounters(snapshot.ResumeCleanup, allowedResumeCleanupReasons)
	return snapshot, nil
}

func newClaudeTelemetry() ClaudeTelemetry {
	return ClaudeTelemetry{
		Version:                  claudeTelemetryVersion,
		FinishReasons:            make(map[string]uint64),
		JSONLWarnings:            make(map[string]uint64),
		ChannelBootstrapFallback: make(map[string]uint64),
		ChannelDisconnected:      make(map[string]uint64),
		ChannelVerdictReserved:   make(map[string]uint64),
		ChannelVerdictSubmitted:  make(map[string]uint64),
		ChannelResultUnknown:     make(map[string]uint64),
		LauncherSafety:           make(map[string]uint64),
		ResumeCleanup:            make(map[string]uint64),
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
