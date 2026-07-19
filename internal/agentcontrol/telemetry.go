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

const (
	openCodeTelemetryVersion = 1
	codexTelemetryVersion    = 1

	FallbackUnsupportedArguments = "unsupported_arguments"
	FallbackDaemonUnavailable    = "daemon_unavailable"
	FallbackRuntimeUnavailable   = "runtime_unavailable"
	FallbackSessionBusy          = "session_busy"
	FallbackInvalidRequest       = "invalid_request"
	FallbackNativeResponse       = "native_response"
)

const (
	CodexFallbackDisabled     = "disabled"
	CodexFallbackMissing      = "missing"
	CodexFallbackOldVersion   = "old_version"
	CodexFallbackCapabilities = "capabilities"
	CodexFallbackRuntime      = "runtime_unavailable"
)

var allowedCodexFallbacks = map[string]struct{}{
	CodexFallbackDisabled: {}, CodexFallbackMissing: {}, CodexFallbackOldVersion: {},
	CodexFallbackCapabilities: {}, CodexFallbackRuntime: {},
}

var allowedOpenCodeFallbacks = map[string]struct{}{
	FallbackUnsupportedArguments: {},
	FallbackDaemonUnavailable:    {},
	FallbackRuntimeUnavailable:   {},
	FallbackSessionBusy:          {},
	FallbackInvalidRequest:       {},
	FallbackNativeResponse:       {},
}

// OpenCodeTelemetry contains cumulative, content-free rollout counters. The
// fixed fallback keys prevent arbitrary errors, prompts, paths, or answers from
// entering telemetry.
type OpenCodeTelemetry struct {
	Version         int               `json:"version"`
	FallbackReasons map[string]uint64 `json:"fallback_reasons,omitempty"`
	HealthOK        uint64            `json:"health_ok,omitempty"`
	HealthFailed    uint64            `json:"health_failed,omitempty"`
}

// CodexTelemetry intentionally contains counters and generation identity only.
// No error text, endpoint, path, prompt, form value, approval payload, or auth
// material is accepted by this API or represented in its on-disk schema.
type CodexTelemetry struct {
	Version         int               `json:"version"`
	FallbackReasons map[string]uint64 `json:"fallback_reasons,omitempty"`
	Reconnects      uint64            `json:"reconnects,omitempty"`
	LastGeneration  uint64            `json:"last_generation,omitempty"`
}

func openCodeTelemetryPath() string {
	dir, err := config.ConfigDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "opencode-telemetry.json")
}

func codexTelemetryPath() string {
	dir, err := config.ConfigDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "codex-telemetry.json")
}

func RecordCodexFallback(reason string) error {
	if _, ok := allowedCodexFallbacks[reason]; !ok {
		return fmt.Errorf("unsupported codex fallback telemetry category %q", reason)
	}
	return updateCodexTelemetry(func(snapshot *CodexTelemetry) { snapshot.FallbackReasons[reason]++ })
}

func RecordCodexReconnect(generation uint64) error {
	if generation == 0 {
		return fmt.Errorf("Codex reconnect generation is required")
	}
	return updateCodexTelemetry(func(snapshot *CodexTelemetry) {
		snapshot.Reconnects++
		snapshot.LastGeneration = generation
	})
}

func LoadCodexTelemetry() (CodexTelemetry, error) {
	path := codexTelemetryPath()
	if path == "" {
		return CodexTelemetry{}, errors.New("resolve codex telemetry path")
	}
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return newCodexTelemetry(), nil
	}
	if err != nil {
		return CodexTelemetry{}, err
	}
	var snapshot CodexTelemetry
	if err := json.Unmarshal(raw, &snapshot); err != nil {
		return CodexTelemetry{}, fmt.Errorf("parse codex telemetry: %w", err)
	}
	if snapshot.Version != codexTelemetryVersion {
		return CodexTelemetry{}, fmt.Errorf("unsupported codex telemetry version %d", snapshot.Version)
	}
	filtered := make(map[string]uint64, len(snapshot.FallbackReasons))
	for reason, count := range snapshot.FallbackReasons {
		if _, ok := allowedCodexFallbacks[reason]; ok && count > 0 {
			filtered[reason] = count
		}
	}
	snapshot.FallbackReasons = filtered
	return snapshot, nil
}

func newCodexTelemetry() CodexTelemetry {
	return CodexTelemetry{Version: codexTelemetryVersion, FallbackReasons: make(map[string]uint64)}
}

func updateCodexTelemetry(update func(*CodexTelemetry)) error {
	path := codexTelemetryPath()
	if path == "" {
		return errors.New("resolve codex telemetry path")
	}
	locker := platform.NewLogicalLocker("pocketctl-codex-telemetry")
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
	snapshot, err := LoadCodexTelemetry()
	if err != nil {
		return err
	}
	update(&snapshot)
	raw, err := json.Marshal(snapshot)
	if err != nil {
		return err
	}
	raw = append(raw, '\n')
	tmp, err := os.CreateTemp(filepath.Dir(path), ".codex-telemetry-*")
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

func RecordOpenCodeFallback(reason string) error {
	if _, ok := allowedOpenCodeFallbacks[reason]; !ok {
		return fmt.Errorf("unsupported opencode fallback telemetry category %q", reason)
	}
	return updateOpenCodeTelemetry(func(snapshot *OpenCodeTelemetry) {
		snapshot.FallbackReasons[reason]++
	})
}

func RecordOpenCodeRuntimeHealth(healthy bool) error {
	return updateOpenCodeTelemetry(func(snapshot *OpenCodeTelemetry) {
		if healthy {
			snapshot.HealthOK++
		} else {
			snapshot.HealthFailed++
		}
	})
}

func LoadOpenCodeTelemetry() (OpenCodeTelemetry, error) {
	path := openCodeTelemetryPath()
	if path == "" {
		return OpenCodeTelemetry{}, errors.New("resolve opencode telemetry path")
	}
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return newOpenCodeTelemetry(), nil
	}
	if err != nil {
		return OpenCodeTelemetry{}, err
	}
	var snapshot OpenCodeTelemetry
	if err := json.Unmarshal(raw, &snapshot); err != nil {
		return OpenCodeTelemetry{}, fmt.Errorf("parse opencode telemetry: %w", err)
	}
	if snapshot.Version != openCodeTelemetryVersion {
		return OpenCodeTelemetry{}, fmt.Errorf("unsupported opencode telemetry version %d", snapshot.Version)
	}
	filtered := make(map[string]uint64, len(snapshot.FallbackReasons))
	for reason, count := range snapshot.FallbackReasons {
		if _, ok := allowedOpenCodeFallbacks[reason]; ok && count > 0 {
			filtered[reason] = count
		}
	}
	snapshot.FallbackReasons = filtered
	return snapshot, nil
}

func newOpenCodeTelemetry() OpenCodeTelemetry {
	return OpenCodeTelemetry{Version: openCodeTelemetryVersion, FallbackReasons: make(map[string]uint64)}
}

func updateOpenCodeTelemetry(update func(*OpenCodeTelemetry)) error {
	path := openCodeTelemetryPath()
	if path == "" {
		return errors.New("resolve opencode telemetry path")
	}
	locker := platform.NewLogicalLocker("pocketctl-opencode-telemetry")
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

	snapshot, err := LoadOpenCodeTelemetry()
	if err != nil {
		return err
	}
	update(&snapshot)
	raw, err := json.Marshal(snapshot)
	if err != nil {
		return err
	}
	raw = append(raw, '\n')
	tmp, err := os.CreateTemp(filepath.Dir(path), ".opencode-telemetry-*")
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

func classifyOpenCodeFallback(err error, result AcquireResult) string {
	if err == nil {
		return FallbackNativeResponse
	}
	var protocolErr *ProtocolError
	if errors.As(err, &protocolErr) {
		switch protocolErr.Code {
		case ErrRuntimeUnavailable:
			return FallbackRuntimeUnavailable
		case ErrSessionBusy:
			return FallbackSessionBusy
		case ErrInvalidRequest, ErrUnsupportedVersion:
			return FallbackInvalidRequest
		}
	}
	return FallbackDaemonUnavailable
}
