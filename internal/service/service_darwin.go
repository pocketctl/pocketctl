//go:build darwin

package service

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/pocketctl/pocketctl/internal/config"
)

var launchctlPrintCommand = func(ctx context.Context, target string) ([]byte, error) {
	return exec.CommandContext(ctx, "launchctl", "print", target).CombinedOutput()
}

// plistPath returns ~/Library/LaunchAgents/<Label>.plist.
func plistPath() (string, error) {
	home, err := config.HomeDir()
	if err != nil {
		return "", fmt.Errorf("get home dir: %w", err)
	}
	return filepath.Join(home, "Library", "LaunchAgents", Label+".plist"), nil
}

// Install writes the LaunchAgent plist and (re)loads it. RunAtLoad starts it
// immediately and at every login; KeepAlive restarts it if it ever exits.
func Install(cfg Config) error {
	path, err := plistPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return fmt.Errorf("create LaunchAgents dir: %w", err)
	}

	// If a previous job is loaded, unload it first so load -w picks up changes.
	_ = exec.Command("launchctl", "unload", path).Run()

	if err := os.WriteFile(path, []byte(renderPlist(cfg)), 0644); err != nil {
		return fmt.Errorf("write plist: %w", err)
	}

	out, err := exec.Command("launchctl", "load", "-w", path).CombinedOutput()
	if err != nil {
		return fmt.Errorf("launchctl load: %w (%s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// Uninstall unloads the job and removes the plist.
func Uninstall() error {
	path, err := plistPath()
	if err != nil {
		return err
	}
	if _, statErr := os.Stat(path); statErr == nil {
		_ = exec.Command("launchctl", "unload", "-w", path).Run()
		if err := os.Remove(path); err != nil {
			return fmt.Errorf("remove plist: %w", err)
		}
	}
	return nil
}

// Status reports the on-disk plist separately from launchd's live job state.
func Status() (Info, error) {
	path, err := plistPath()
	if err != nil {
		return Info{}, err
	}
	info := Info{UnitPath: path}
	if _, statErr := os.Stat(path); statErr == nil {
		info.Installed = true
	} else if !os.IsNotExist(statErr) {
		return Info{}, fmt.Errorf("stat launch agent: %w", statErr)
	}

	target := fmt.Sprintf("gui/%d/%s", os.Getuid(), Label)
	ctx, cancel := context.WithTimeout(context.Background(), statusQueryTimeout)
	defer cancel()
	out, commandErr := launchctlPrintCommand(ctx, target)
	if commandErr != nil {
		if ctx.Err() != nil {
			commandErr = ctx.Err()
		}
		if !errors.Is(commandErr, context.DeadlineExceeded) &&
			!errors.Is(commandErr, context.Canceled) &&
			launchctlServiceNotLoaded(string(out)) {
			return info, nil
		}
		return Info{}, fmt.Errorf("launchctl print %s: %w (%s)", target, commandErr, strings.TrimSpace(string(out)))
	}
	live := parseLaunchctlPrint(string(out))
	live.Installed = info.Installed
	live.UnitPath = path
	return live, nil
}

func parseLaunchctlPrint(out string) Info {
	info := Info{Loaded: true}
	state := ""
	for _, line := range strings.Split(out, "\n") {
		key, value, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		switch key {
		case "state":
			state = value
		case "pid":
			if pid, err := strconv.Atoi(value); err == nil {
				info.PID = pid
			}
		case "last exit code":
			if code, err := strconv.Atoi(value); err == nil {
				info.LastExitCode = &code
			}
		}
	}
	info.Running = state == "running" && info.PID > 0
	info.Detail = state
	return info
}

func launchctlServiceNotLoaded(out string) bool {
	lower := strings.ToLower(out)
	return strings.Contains(lower, "could not find service") ||
		strings.Contains(lower, "service not found")
}

func renderPlist(cfg Config) string {
	var args strings.Builder
	args.WriteString(fmt.Sprintf("    <string>%s</string>\n", xmlEscape(cfg.ExePath)))
	for _, a := range cfg.Args {
		args.WriteString(fmt.Sprintf("    <string>%s</string>\n", xmlEscape(a)))
	}
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>%s</string>
  <key>ProgramArguments</key>
  <array>
%s  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>%s</string>
  <key>StandardErrorPath</key>
  <string>%s</string>
</dict>
</plist>
`, Label, args.String(), xmlEscape(cfg.LogPath), xmlEscape(cfg.LogPath))
}

func xmlEscape(s string) string {
	s = strings.ReplaceAll(s, "&", "&amp;")
	s = strings.ReplaceAll(s, "<", "&lt;")
	s = strings.ReplaceAll(s, ">", "&gt;")
	return s
}
