//go:build linux

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

const unitName = "pocketctl.service"

var systemctlShowCommand = func(ctx context.Context) ([]byte, error) {
	return exec.CommandContext(
		ctx,
		"systemctl", "--user", "show", unitName, "--no-pager",
		"--property=LoadState", "--property=ActiveState", "--property=MainPID", "--property=ExecMainStatus",
	).CombinedOutput()
}

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

// Status reports the on-disk unit separately from systemd's live unit state.
func Status() (Info, error) {
	path, err := unitPath()
	if err != nil {
		return Info{}, err
	}
	info := Info{UnitPath: path}
	if _, statErr := os.Stat(path); statErr == nil {
		info.Installed = true
	} else if !os.IsNotExist(statErr) {
		return Info{}, fmt.Errorf("stat systemd user unit: %w", statErr)
	}

	ctx, cancel := context.WithTimeout(context.Background(), statusQueryTimeout)
	defer cancel()
	out, commandErr := systemctlShowCommand(ctx)
	live := parseSystemctlShow(string(out))
	if commandErr != nil {
		if ctx.Err() != nil {
			commandErr = ctx.Err()
		}
		if errors.Is(commandErr, context.DeadlineExceeded) ||
			errors.Is(commandErr, context.Canceled) ||
			!systemctlUnitNotFound(string(out)) {
			return Info{}, fmt.Errorf("systemctl --user show %s: %w (%s)", unitName, commandErr, strings.TrimSpace(string(out)))
		}
	}
	live.Installed = info.Installed
	live.UnitPath = path
	return live, nil
}

func parseSystemctlShow(out string) Info {
	values := make(map[string]string)
	for _, line := range strings.Split(out, "\n") {
		key, value, ok := strings.Cut(strings.TrimSpace(line), "=")
		if ok {
			values[key] = value
		}
	}
	info := Info{
		Loaded: values["LoadState"] == "loaded",
		Detail: values["ActiveState"],
	}
	if pid, err := strconv.Atoi(values["MainPID"]); err == nil {
		info.PID = pid
	}
	if code, err := strconv.Atoi(values["ExecMainStatus"]); err == nil {
		info.LastExitCode = &code
	}
	info.Running = values["ActiveState"] == "active" && info.PID > 0
	return info
}

func systemctlUnitNotFound(out string) bool {
	for _, line := range strings.Split(out, "\n") {
		if strings.TrimSpace(line) == "LoadState=not-found" {
			return true
		}
	}
	return false
}

func renderUnit(cfg Config) string {
	parts := append([]string{cfg.ExePath}, cfg.Args...)
	for i, p := range parts {
		parts[i] = quoteSystemdExecArg(p)
	}
	execStart := strings.Join(parts, " ")
	pathEnvironment := ""
	if cfg.PathEnv != "" {
		pathEnvironment = "Environment=" + quoteSystemdEnvironment("PATH="+cfg.PathEnv) + "\n"
	}

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
%s

[Install]
WantedBy=default.target
`, execStart, pathEnvironment)
}

// quoteSystemdExecArg mirrors systemd's own ExecStart serialization rules:
// quote every argv element, escape syntax characters, suppress specifier and
// environment expansion, and keep control bytes on the directive's one line.
func quoteSystemdExecArg(value string) string {
	var escaped strings.Builder
	escaped.Grow(len(value) + 2)
	escaped.WriteByte('"')
	for i := 0; i < len(value); i++ {
		switch c := value[i]; c {
		case '\\':
			escaped.WriteString(`\\`)
		case '"':
			escaped.WriteString(`\"`)
		case '$':
			escaped.WriteString(`$$`)
		case '%':
			escaped.WriteString(`%%`)
		case '\n':
			escaped.WriteString(`\n`)
		case '\r':
			escaped.WriteString(`\r`)
		case '\t':
			escaped.WriteString(`\t`)
		default:
			if c < 0x20 || c == 0x7f {
				fmt.Fprintf(&escaped, `\x%02x`, c)
			} else {
				escaped.WriteByte(c)
			}
		}
	}
	escaped.WriteByte('"')
	return escaped.String()
}

func quoteSystemdEnvironment(value string) string {
	escaped := strings.NewReplacer(
		`\`, `\\`,
		`"`, `\"`,
		`%`, `%%`,
		"\n", `\n`,
		"\r", `\r`,
		"\t", `\t`,
	).Replace(value)
	return `"` + escaped + `"`
}
