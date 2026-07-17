package agentcontrol

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"time"

	appconfig "github.com/pocketctl/pocketctl/internal/config"
)

const ConfigVersion = 1

const (
	StateUndecided = "undecided"
	StateEnabled   = "enabled"
	StateDisabled  = "disabled"

	SourceDaemonPrompt = "daemon_prompt"
	SourceCommand      = "command"
)

var ErrConfigVersion = errors.New("unsupported agent launcher config version")

type Config struct {
	Version  int         `json:"version"`
	OpenCode AgentConfig `json:"opencode"`
}

type AgentConfig struct {
	State          string    `json:"state"`
	DecisionSource string    `json:"decision_source,omitempty"`
	RealBinary     string    `json:"real_binary,omitempty"`
	ShimPath       string    `json:"shim_path,omitempty"`
	DecidedAt      time.Time `json:"decided_at,omitempty"`
	InstalledAt    time.Time `json:"installed_at,omitempty"`
}

func DefaultConfig() Config {
	return Config{Version: ConfigVersion, OpenCode: AgentConfig{State: StateUndecided}}
}

func ConfigPath() (string, error) {
	dir, err := appconfig.ConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "agent-launchers.json"), nil
}

func LoadConfig() (Config, error) {
	fallback := DefaultConfig()
	path, err := ConfigPath()
	if err != nil {
		return fallback, err
	}
	info, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return fallback, nil
	}
	if err != nil {
		return fallback, fmt.Errorf("stat launcher config: %w", err)
	}
	if !info.Mode().IsRegular() || (runtime.GOOS != "windows" && info.Mode().Perm() != 0o600) {
		return fallback, fmt.Errorf("launcher config must be a private regular file (0600)")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return fallback, fmt.Errorf("read launcher config: %w", err)
	}
	if len(raw) > MaxFrameSize {
		return fallback, fmt.Errorf("launcher config exceeds %d bytes", MaxFrameSize)
	}
	var cfg Config
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return fallback, fmt.Errorf("parse launcher config: %w", err)
	}
	if cfg.Version != ConfigVersion {
		return fallback, fmt.Errorf("%w: %d", ErrConfigVersion, cfg.Version)
	}
	if !validState(cfg.OpenCode.State) {
		return fallback, fmt.Errorf("invalid opencode launcher state %q", cfg.OpenCode.State)
	}
	return cfg, nil
}

func SaveConfig(cfg Config) error {
	if cfg.Version != ConfigVersion {
		return fmt.Errorf("%w: %d", ErrConfigVersion, cfg.Version)
	}
	if !validState(cfg.OpenCode.State) {
		return fmt.Errorf("invalid opencode launcher state %q", cfg.OpenCode.State)
	}
	path, err := ConfigPath()
	if err != nil {
		return err
	}
	if raw, readErr := os.ReadFile(path); readErr == nil {
		var header struct {
			Version int `json:"version"`
		}
		if json.Unmarshal(raw, &header) == nil && header.Version > ConfigVersion {
			return fmt.Errorf("%w: %d", ErrConfigVersion, header.Version)
		}
	}
	raw, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal launcher config: %w", err)
	}
	raw = append(raw, '\n')
	tmp, err := os.CreateTemp(filepath.Dir(path), ".agent-launchers-*")
	if err != nil {
		return fmt.Errorf("create launcher config temp: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(raw); err != nil {
		tmp.Close()
		return fmt.Errorf("write launcher config: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return fmt.Errorf("sync launcher config: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close launcher config: %w", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("replace launcher config: %w", err)
	}
	return nil
}

func validState(state string) bool {
	return state == StateUndecided || state == StateEnabled || state == StateDisabled
}
