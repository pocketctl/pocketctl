//go:build darwin

package service

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
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
