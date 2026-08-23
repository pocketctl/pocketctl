//go:build darwin

package service

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRenderPlistValid(t *testing.T) {
	cfg := Config{
		ExePath: "/usr/local/bin/pocketctl",
		Args:    []string{"daemon", "start", "--foreground", "--relay", "wss://r&d.example.com/ws"},
		LogPath: "/tmp/pocketctl/daemon.log",
	}
	out := renderPlist(cfg)

	// The Label and every arg must appear; the ampersand must be XML-escaped.
	if !strings.Contains(out, Label) {
		t.Errorf("plist missing Label %q", Label)
	}
	if !strings.Contains(out, "&amp;") || strings.Contains(out, "r&d") {
		t.Errorf("ampersand not XML-escaped in plist:\n%s", out)
	}
	for _, a := range cfg.Args {
		esc := xmlEscape(a)
		if !strings.Contains(out, esc) {
			t.Errorf("plist missing arg %q (escaped %q)", a, esc)
		}
	}

	// If plutil is available (it is on macOS), the plist must lint clean.
	if _, err := exec.LookPath("plutil"); err == nil {
		f := filepath.Join(t.TempDir(), "test.plist")
		if err := os.WriteFile(f, []byte(out), 0644); err != nil {
			t.Fatalf("write temp plist: %v", err)
		}
		if b, err := exec.Command("plutil", "-lint", f).CombinedOutput(); err != nil {
			t.Errorf("plutil -lint rejected generated plist: %v\n%s\n--- plist ---\n%s", err, b, out)
		}
	}
}

func TestRenderPlistIncludesOnlyEscapedPathEnvironment(t *testing.T) {
	cfg := Config{
		ExePath: "/usr/local/bin/pocketctl",
		Args:    []string{"daemon", "start", "--foreground"},
		PathEnv: "/opt/homebrew/bin:/path with space:&<quoted>",
	}
	out := renderPlist(cfg)

	want := "  <key>EnvironmentVariables</key>\n  <dict>\n    <key>PATH</key>\n    <string>/opt/homebrew/bin:/path with space:&amp;&lt;quoted&gt;</string>\n  </dict>\n"
	if !strings.Contains(out, want) {
		t.Fatalf("plist missing PATH environment:\n%s", out)
	}
	if strings.Count(out, "<key>EnvironmentVariables</key>") != 1 || strings.Count(out, "<key>PATH</key>") != 1 {
		t.Fatalf("plist must persist only one PATH environment entry:\n%s", out)
	}
}

func TestParseLaunchctlStatusDistinguishesInstalledLoadedAndRunning(t *testing.T) {
	got := parseLaunchctlPrint("state = exited\nlast exit code = 0\n")
	if !got.Loaded || got.Running || got.LastExitCode == nil || *got.LastExitCode != 0 {
		t.Fatalf("got %#v", got)
	}
}

func TestParseLaunchctlStatusRequiresRunningStateAndPID(t *testing.T) {
	tests := []struct {
		name    string
		output  string
		running bool
		pid     int
	}{
		{"running", "state = running\npid = 321\nlast exit code = 7\n", true, 321},
		{"running without pid", "state = running\n", false, 0},
		{"exited with stale pid", "state = exited\npid = 321\n", false, 321},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseLaunchctlPrint(tt.output)
			if !got.Loaded || got.Running != tt.running || got.PID != tt.pid {
				t.Fatalf("got %#v", got)
			}
		})
	}
}

func TestParseLaunchctlStatusIgnoresNestedCoalitionState(t *testing.T) {
	got := parseLaunchctlPrint(`gui/501/me.pocketctl.daemon = {
	state = running
	pid = 80365
	resource coalition = {
		state = active
	}
}`)
	if !got.Loaded || !got.Running || got.PID != 80365 || got.Detail != "running" {
		t.Fatalf("nested coalition state overrode service state: %#v", got)
	}
}

func TestLaunchctlPrintNotLoadedIsNotExecutionFailure(t *testing.T) {
	if !launchctlServiceNotLoaded("Could not find service \"me.pocketctl.daemon\" in domain for user gui: 501") {
		t.Fatal("not-loaded launchctl output was treated as an execution failure")
	}
	if launchctlServiceNotLoaded("launchctl: internal I/O error") {
		t.Fatal("real launchctl error was treated as not loaded")
	}
}

func TestStatusSeparatesLaunchAgentFileFromLiveLoadState(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	path, err := plistPath()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("<plist/>"), 0o644); err != nil {
		t.Fatal(err)
	}
	old := launchctlPrintCommand
	launchctlPrintCommand = func(context.Context, string) ([]byte, error) {
		return []byte("Could not find service \"me.pocketctl.daemon\" in domain for user gui: 501"), errors.New("exit status 113")
	}
	t.Cleanup(func() { launchctlPrintCommand = old })

	got, err := Status()
	if err != nil {
		t.Fatal(err)
	}
	if !got.Installed || got.Loaded || got.Running || got.Detail != "" {
		t.Fatalf("got %#v", got)
	}
}

func TestStatusReturnsLaunchctlExecutionFailures(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	old := launchctlPrintCommand
	launchctlPrintCommand = func(context.Context, string) ([]byte, error) {
		return nil, exec.ErrNotFound
	}
	t.Cleanup(func() { launchctlPrintCommand = old })

	if _, err := Status(); err == nil {
		t.Fatal("missing launchctl command was treated as an unloaded service")
	}
}

func TestStatusLaunchctlTimeoutHasDeadlineAndIsNotUnloaded(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	old := launchctlPrintCommand
	launchctlPrintCommand = func(ctx context.Context, _ string) ([]byte, error) {
		deadline, ok := ctx.Deadline()
		if !ok {
			t.Fatal("launchctl context has no deadline")
		}
		remaining := time.Until(deadline)
		if remaining <= 0 || remaining > 6*time.Second {
			t.Fatalf("launchctl deadline remaining=%s", remaining)
		}
		return []byte("Could not find service \"me.pocketctl.daemon\""), context.DeadlineExceeded
	}
	t.Cleanup(func() { launchctlPrintCommand = old })

	if _, err := Status(); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Status error=%v, want deadline exceeded", err)
	}
}
