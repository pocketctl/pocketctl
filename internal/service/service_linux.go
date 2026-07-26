//go:build linux

package service

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/pocketctl/pocketctl/internal/config"
)

const unitName = "pocketctl.service"

// unitPath returns ~/.config/systemd/user/pocketctl.service.
func unitPath() (string, error) {
	home, err := config.HomeDir()
	if err != nil {
		return "", fmt.Errorf("get home dir: %w", err)
	}
	return filepath.Join(home, ".config", "systemd", "user", unitName), nil
}

// Install writes a systemd user unit, reloads the user manager, enables it at
// login and starts it now. It also attempts `loginctl enable-linger` so the
// daemon keeps running after the user logs out (the unit otherwise dies with
// the session). enable-linger is best-effort: it may require polkit auth.
func Install(cfg Config) error {
	path, err := unitPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return fmt.Errorf("create systemd user dir: %w", err)
	}
	if err := os.WriteFile(path, []byte(renderUnit(cfg)), 0644); err != nil {
		return fmt.Errorf("write unit: %w", err)
	}

	if out, err := exec.Command("systemctl", "--user", "daemon-reload").CombinedOutput(); err != nil {
		return fmt.Errorf("systemctl daemon-reload: %w (%s)", err, strings.TrimSpace(string(out)))
	}
	if out, err := exec.Command("systemctl", "--user", "enable", "--now", unitName).CombinedOutput(); err != nil {
		return fmt.Errorf("systemctl enable --now: %w (%s)", err, strings.TrimSpace(string(out)))
	}

	// Best-effort linger so the service survives logout. Don't fail install if
	// it's denied — the unit is still installed and runs while logged in.
	if u := os.Getenv("USER"); u != "" {
		_ = exec.Command("loginctl", "enable-linger", u).Run()
	}
	return nil
}

// Uninstall stops, disables and removes the unit, then reloads the manager.
func Uninstall() error {
	path, err := unitPath()
	if err != nil {
		return err
	}
	_ = exec.Command("systemctl", "--user", "disable", "--now", unitName).Run()
	if _, statErr := os.Stat(path); statErr == nil {
		if err := os.Remove(path); err != nil {
			return fmt.Errorf("remove unit: %w", err)
		}
	}
	_ = exec.Command("systemctl", "--user", "daemon-reload").Run()
	return nil
}

// Status reports whether the unit file exists and whether systemd reports it
// active.
func Status() (Info, error) {
	path, err := unitPath()
	if err != nil {
		return Info{}, err
	}
	info := Info{UnitPath: path}
	if _, statErr := os.Stat(path); statErr == nil {
		info.Installed = true
	}
	// `is-active` exits non-zero when inactive; we read the word it prints.
	out, _ := exec.Command("systemctl", "--user", "is-active", unitName).CombinedOutput()
	state := strings.TrimSpace(string(out))
	info.Detail = state
	if state == "active" {
		info.Running = true
	}
	return info, nil
}

func renderUnit(cfg Config) string {
	// Quote each arg defensively; paths with spaces are rare but cheap to guard.
	parts := append([]string{cfg.ExePath}, cfg.Args...)
	for i, p := range parts {
		if strings.ContainsAny(p, " \t") {
			parts[i] = "\"" + p + "\""
		}
	}
	execStart := strings.Join(parts, " ")

	return fmt.Sprintf(`[Unit]
Description=pocketctl daemon (remote AI coding agent control)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=%s
Restart=always
RestartSec=5
# Disfavor the daemon for the kernel OOM killer (children are sacrificed first).
OOMScoreAdjust=-500

[Install]
WantedBy=default.target
`, execStart)
}
