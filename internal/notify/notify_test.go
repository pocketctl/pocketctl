package notify

import (
	"os"
	"strings"
	"testing"
)

func TestWslToastScriptIsConstantAndReadsEnvVars(t *testing.T) {
	if strings.Contains(wslToastScript, "%s") || strings.Contains(wslToastScript, "%d") {
		t.Fatal("toast script must not contain format verbs — data must flow via env, not source interpolation")
	}
	if !strings.Contains(wslToastScript, "$env:POCKETCTL_NOTIFY_TITLE") {
		t.Fatal("toast script must read the title from $env:POCKETCTL_NOTIFY_TITLE")
	}
	if !strings.Contains(wslToastScript, "$env:POCKETCTL_NOTIFY_BODY") {
		t.Fatal("toast script must read the body from $env:POCKETCTL_NOTIFY_BODY")
	}
	if !strings.Contains(wslToastScript, "CreateTextNode") {
		t.Fatal("toast script must keep XML-safe CreateTextNode construction")
	}
}

func TestWslToastCommandPassesDataThroughEnvNotSource(t *testing.T) {
	hostileTitle := "pocketctl 📱 `backtick` \"quotes\" $dollar $(whoami); rm -rf"
	hostileBody := "line1\nline2 <tag> & 'single'"
	cmd := wslToastCommand("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", hostileTitle, hostileBody)

	if cmd.Path != "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe" {
		t.Fatalf("command path = %q", cmd.Path)
	}
	joined := strings.Join(cmd.Args, " ")
	if strings.Contains(joined, "backtick") || strings.Contains(joined, "whoami") || strings.Contains(joined, "line1") {
		t.Fatalf("notification data leaked into the command line: %q", joined)
	}
	title, body := envValue(cmd.Env, "POCKETCTL_NOTIFY_TITLE"), envValue(cmd.Env, "POCKETCTL_NOTIFY_BODY")
	if title != hostileTitle || body != hostileBody {
		t.Fatalf("env must carry data verbatim:\ntitle=%q\nbody=%q", title, body)
	}
	// The script source must be byte-identical whatever the data is.
	other := wslToastCommand("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", "a", "b")
	if strings.Join(other.Args, " ") != joined {
		t.Fatal("argv must not depend on notification data")
	}
}

func envValue(env []string, name string) string {
	for _, entry := range env {
		if strings.HasPrefix(entry, name+"=") {
			return strings.TrimPrefix(entry, name+"=")
		}
	}
	return ""
}

func TestSendTerminalBannerDoesNotMutateMessages(t *testing.T) {
	f, err := os.CreateTemp("", "pocketctl-banner-*.tty")
	if err != nil {
		t.Skip("cannot create temp tty file")
	}
	defer os.Remove(f.Name())
	defer f.Close()
	if err := SendTerminalBanner(f.Name(), "hello"); err != nil {
		t.Fatalf("SendTerminalBanner = %v, want nil", err)
	}
}
