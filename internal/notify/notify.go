package notify

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"

	"github.com/pocketctl/pocketctl/internal/daemon"
)

// GetTTYForPID discovers the TTY device path (e.g. /dev/ttys002) for a process.
func GetTTYForPID(pid int) (string, error) {
	out, err := exec.Command("ps", "-o", "tty=", "-p", fmt.Sprintf("%d", pid)).Output()
	if err != nil {
		return "", fmt.Errorf("ps tty lookup: %w", err)
	}
	suffix := strings.TrimSpace(string(out))
	if suffix == "" {
		return "", fmt.Errorf("no tty for pid %d", pid)
	}
	return "/dev/" + suffix, nil
}

// SendDesktopNotification sends a desktop notification using the platform's
// native notification system.
//
//   - macOS: osascript (Notification Center)
//   - Linux native: notify-send (libnotify / GNOME / KDE)
//   - WSL: powershell.exe toast notification (hand off to Windows)
//
// Returns nil if no notification system is available (silent skip).
func SendDesktopNotification(title, body string) error {
	switch runtime.GOOS {
	case "darwin":
		script := fmt.Sprintf(`display notification %q with title %q sound name "default"`, body, title)
		return exec.Command("osascript", "-e", script).Run()

	case "linux":
		// WSL: try powershell.exe toast (hand off to Windows host)
		if isWSL() {
			if p, err := exec.LookPath("powershell.exe"); err == nil {
				psScript := fmt.Sprintf(
					`[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime] > $null; `+
						`$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02); `+
						`$text = $template.GetElementsByTagName("text"); `+
						`$text.Item(0).AppendChild($template.CreateTextNode("%s")) > $null; `+
						`$text.Item(1).AppendChild($template.CreateTextNode("%s")) > $null; `+
						`$toast = [Windows.UI.Notifications.ToastNotification]::new($template); `+
						`[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("pocketctl").Show($toast)`,
					escapeForPowerShell(title), escapeForPowerShell(body),
				)
				// Toast may fail in older Windows; fall through to notify-send.
				if err := exec.Command(p, "-NoProfile", "-Command", psScript).Run(); err == nil {
					return nil
				}
			}
		}

		// Linux/WSL: try notify-send (libnotify)
		if p, err := exec.LookPath("notify-send"); err == nil {
			return exec.Command(p, title, body).Run()
		}

		// No notification system available — silent skip
		return nil

	default:
		return nil
	}
}

// escapeForPowerShell escapes a string for safe embedding in a PowerShell
// double-quoted string context.
func escapeForPowerShell(s string) string {
	s = strings.ReplaceAll(s, `"`, ``+"`"+`"`)
	s = strings.ReplaceAll(s, `$`, ``+"`"+`$`)
	return s
}

// isWSL delegates to daemon.IsWSL (shared implementation).
func isWSL() bool { return daemon.IsWSL() }

// SendTerminalBanner writes an ANSI-colored banner message to a TTY device.
func SendTerminalBanner(ttyPath, message string) error {
	f, err := os.OpenFile(ttyPath, os.O_WRONLY, 0)
	if err != nil {
		return fmt.Errorf("open tty %s: %w", ttyPath, err)
	}
	defer f.Close()
	banner := fmt.Sprintf("\r\n\033[33m[pocketctl] 📱 %s\033[0m\r\n", message)
	_, err = f.WriteString(banner)
	return err
}

// NotifyTerminal sends both a desktop notification and a terminal banner.
func NotifyTerminal(ttyPath, shortMsg, longMsg string) {
	// Desktop notification (may fail silently if not in GUI session)
	_ = SendDesktopNotification("pocketctl 📱", longMsg)
	// Terminal banner
	if ttyPath != "" {
		_ = SendTerminalBanner(ttyPath, shortMsg)
	}
}
