//go:build linux

package service

import (
	"strings"
	"testing"
)

func TestRenderUnit(t *testing.T) {
	cfg := Config{
		ExePath: "/usr/local/bin/pocketctl",
		Args:    []string{"daemon", "start", "--foreground"},
		LogPath: "/tmp/pocketctl/daemon.log",
	}
	out := renderUnit(cfg)

	wantSubstrings := []string{
		"ExecStart=/usr/local/bin/pocketctl daemon start --foreground",
		"Restart=always",
		"OOMScoreAdjust=-500",
		"WantedBy=default.target",
	}
	for _, w := range wantSubstrings {
		if !strings.Contains(out, w) {
			t.Errorf("unit missing %q:\n%s", w, out)
		}
	}
}

func TestRenderUnitQuotesSpaces(t *testing.T) {
	cfg := Config{
		ExePath: "/opt/my apps/pocketctl",
		Args:    []string{"daemon", "start", "--foreground"},
	}
	out := renderUnit(cfg)
	if !strings.Contains(out, `ExecStart="/opt/my apps/pocketctl" daemon start --foreground`) {
		t.Errorf("path with spaces not quoted:\n%s", out)
	}
}
