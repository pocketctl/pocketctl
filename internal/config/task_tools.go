package config

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// TaskToolsAgent limits this policy to runtimes whose native switches were
// verified. Native/observer processes are never modified by this package.
func TaskToolsAgent(agent string) (string, error) {
	switch agent {
	case "codex":
		return agent, nil
	case "claude", "claude-code":
		return "claude-code", nil
	default:
		return "", fmt.Errorf("task-tools: unsupported agent %q (use codex or claude-code)", agent)
	}
}

func TaskToolsPath(agent string) (string, error) {
	agent, err := TaskToolsAgent(agent)
	if err != nil {
		return "", err
	}
	dir, err := ConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "task-tools", agent+".json"), nil
}

type taskToolsFile struct {
	Version int   `json:"version"`
	Enabled *bool `json:"enabled"`
}

// LoadTaskTools returns nil for inherit. Invalid configuration is an error,
// never an implicit enable/disable. Read on every new process launch.
func LoadTaskTools(agent string) (*bool, error) {
	path, err := TaskToolsPath(agent)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, 4097))
	if err != nil {
		return nil, err
	}
	if len(data) > 4096 {
		return nil, fmt.Errorf("task-tools: config too large: %s", path)
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	var value taskToolsFile
	if err := d.Decode(&value); err != nil {
		return nil, fmt.Errorf("task-tools: invalid config %s: %w", path, err)
	}
	if d.Decode(new(any)) != io.EOF || value.Version != 1 || value.Enabled == nil {
		return nil, fmt.Errorf("task-tools: invalid version or enabled value: %s", path)
	}
	return value.Enabled, nil
}

// SaveTaskTools atomically updates one agent without racing updates to another.
// nil removes only PocketCtl's override and restores native defaults/settings.
func SaveTaskTools(agent string, enabled *bool) error {
	path, err := TaskToolsPath(agent)
	if err != nil {
		return err
	}
	if enabled == nil {
		err := os.Remove(path)
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(taskToolsFile{Version: 1, Enabled: enabled}, "", "  ")
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".task-tools-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	defer f.Close()
	if _, err = f.Write(append(data, '\n')); err != nil {
		return err
	}
	if err = f.Sync(); err != nil {
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}

// ApplyTaskTools is only for daemon-owned native process launches. It leaves
// inherited behavior untouched when no override is configured. Claude gets
// both the startup environment and the highest-precedence per-process settings
// layer so a user's settings.env cannot silently undo the explicit choice.
func ApplyTaskTools(agent string, args, env []string) ([]string, []string, error) {
	if agent != "codex" && agent != "claude-code" {
		return args, env, nil
	}
	enabled, err := LoadTaskTools(agent)
	if err != nil || enabled == nil {
		return args, env, err
	}
	if agent == "codex" {
		override := []string{"-c", "tools.update_plan.enabled=" + strconv.FormatBool(*enabled)}
		// Preserve the app-server command position used by safe process adoption.
		if len(args) > 0 && (args[0] == "app-server" || args[0] == "exec") {
			return append(append([]string{args[0]}, override...), args[1:]...), env, nil
		}
		return append(override, args...), env, nil
	}
	for _, arg := range args {
		if arg == "--settings" || strings.HasPrefix(arg, "--settings=") {
			return nil, nil, fmt.Errorf("task-tools: cannot merge an existing Claude --settings argument")
		}
	}
	value := "0"
	if *enabled {
		value = "1"
	}
	const key = "CLAUDE_CODE_ENABLE_TODO_TOOLS"
	settings, _ := json.Marshal(map[string]any{"env": map[string]string{key: value}})
	args = append([]string{"--settings", string(settings)}, args...)
	if env == nil {
		env = os.Environ()
	}
	out := make([]string, 0, len(env)+1)
	for _, item := range env {
		if !strings.HasPrefix(item, key+"=") {
			out = append(out, item)
		}
	}
	return args, append(out, key+"="+value), nil
}
