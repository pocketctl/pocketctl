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
		// WSL: hand a toast to the Windows host via a FIXED PowerShell script
		// (M-6). The title and body travel as environment variables for that
		// subprocess only — they are never spliced into the script source, so
		// backticks, quotes, dollars and newlines cannot alter the script.
		if isWSL() {
			if p, err := exec.LookPath("powershell.exe"); err == nil {
				if err := wslToastCommand(p, title, body).Run(); err == nil {
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

// wslToastScript is a constant: it reads the notification text from
// $env:POCKETCTL_NOTIFY_TITLE / $env:POCKETCTL_NOTIFY_BODY and uses
// CreateTextNode so the XML payload is never string-built.
const wslToastScript = `[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime] > $null; ` +
	`$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02); ` +
	`$text = $template.GetElementsByTagName("text"); ` +
	`$text.Item(0).AppendChild($template.CreateTextNode($env:POCKETCTL_NOTIFY_TITLE)) > $null; ` +
	`$text.Item(1).AppendChild($template.CreateTextNode($env:POCKETCTL_NOTIFY_BODY)) > $null; ` +
	`$toast = [Windows.UI.Notifications.ToastNotification]::new($template); ` +
	`[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("pocketctl").Show($toast)`

// wslToastCommand builds the toast invocation. Data flows exclusively through
// the child process environment; the argv (and therefore the script source)
// is identical for every title/body.
func wslToastCommand(powershellPath, title, body string) *exec.Cmd {
	cmd := exec.Command(powershellPath, "-NoProfile", "-Command", wslToastScript)
	cmd.Env = append(os.Environ(),
		"POCKETCTL_NOTIFY_TITLE="+title,
		"POCKETCTL_NOTIFY_BODY="+body,
	)
	return cmd
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
