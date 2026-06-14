package notify

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
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

// SendDesktopNotification sends a macOS Notification Center alert via osascript.
func SendDesktopNotification(title, body string) error {
	script := fmt.Sprintf(`display notification %q with title %q sound name "default"`, body, title)
	return exec.Command("osascript", "-e", script).Run()
}

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
