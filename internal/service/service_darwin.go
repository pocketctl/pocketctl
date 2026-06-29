//go:build darwin

package service

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// plistPath returns ~/Library/LaunchAgents/<Label>.plist.
func plistPath() (string, error) {
	home, err := os.UserHomeDir()
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

// Status reports whether the plist exists and whether launchd currently lists
// the job (a numeric PID in `launchctl list` output means it's running).
func Status() (Info, error) {
	path, err := plistPath()
	if err != nil {
		return Info{}, err
	}
	info := Info{UnitPath: path}
	if _, statErr := os.Stat(path); statErr == nil {
		info.Installed = true
	}

	out, _ := exec.Command("launchctl", "list").CombinedOutput()
	for _, line := range strings.Split(string(out), "\n") {
		if !strings.Contains(line, Label) {
			continue
		}
		// Columns: PID  Status  Label. A numeric (non "-") PID means running.
		fields := strings.Fields(line)
		if len(fields) >= 1 && fields[0] != "-" {
			info.Running = true
		}
		info.Detail = strings.TrimSpace(line)
		break
	}
	return info, nil
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
