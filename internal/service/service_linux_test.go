//go:build linux

package service

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
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

func TestRenderUnitEscapesPathEnvironment(t *testing.T) {
	tests := []struct {
		name    string
		pathEnv string
		want    string
	}{
		{"spaces", "/home/alice/my tools/bin:/usr/bin", `Environment="PATH=/home/alice/my tools/bin:/usr/bin"`},
		{"backslashes", `C:\\Program Files\\node`, `Environment="PATH=C:\\\\Program Files\\\\node"`},
		{"quotes", `/opt/"node"/bin`, `Environment="PATH=/opt/\"node\"/bin"`},
		{"systemd specifiers", `/opt/%h/%u/literal%/bin`, `Environment="PATH=/opt/%%h/%%u/literal%%/bin"`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			out := renderUnit(Config{ExePath: "/usr/local/bin/pocketctl", PathEnv: tt.pathEnv})
			if !strings.Contains(out, tt.want) {
				t.Fatalf("unit missing %q:\n%s", tt.want, out)
			}
		})
	}
}

func TestRenderUnitOmitsEmptyPathEnvironment(t *testing.T) {
	out := renderUnit(Config{ExePath: "/usr/local/bin/pocketctl"})
	if strings.Contains(out, "Environment=") {
		t.Fatalf("unit must omit an empty PATH environment:\n%s", out)
	}
}

func TestParseSystemctlShowDistinguishesLoadedRunningAndExitStatus(t *testing.T) {
	tests := []struct {
		name    string
		output  string
		loaded  bool
		running bool
		pid     int
		exit    int
	}{
		{
			name:    "active with pid",
			output:  "LoadState=loaded\nActiveState=active\nMainPID=321\nExecMainStatus=0\n",
			loaded:  true,
			running: true,
			pid:     321,
			exit:    0,
		},
		{
			name:    "inactive",
			output:  "LoadState=loaded\nActiveState=inactive\nMainPID=0\nExecMainStatus=7\n",
			loaded:  true,
			running: false,
			exit:    7,
		},
		{
			name:    "unit missing",
			output:  "LoadState=not-found\nActiveState=inactive\nMainPID=0\nExecMainStatus=0\n",
			loaded:  false,
			running: false,
			exit:    0,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseSystemctlShow(tt.output)
			if got.Loaded != tt.loaded || got.Running != tt.running || got.PID != tt.pid ||
				got.LastExitCode == nil || *got.LastExitCode != tt.exit {
				t.Fatalf("got %#v", got)
			}
		})
	}
}

func TestStatusTreatsOnlyNotFoundUnitAsUnloaded(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	old := systemctlShowCommand
	t.Cleanup(func() { systemctlShowCommand = old })

	systemctlShowCommand = func(context.Context) ([]byte, error) {
		return []byte("LoadState=not-found\nActiveState=inactive\nMainPID=0\nExecMainStatus=0\n"), errors.New("exit status 4")
	}
	got, err := Status()
	if err != nil {
		t.Fatal(err)
	}
	if got.Loaded || got.Running {
		t.Fatalf("got %#v", got)
	}

	systemctlShowCommand = func(context.Context) ([]byte, error) {
		return nil, errors.New("systemctl unavailable")
	}
	if _, err := Status(); err == nil {
		t.Fatal("systemctl execution failure was treated as an unloaded unit")
	}
}

func TestStatusSystemctlTimeoutHasDeadlineAndIsNotNotFound(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	old := systemctlShowCommand
	systemctlShowCommand = func(ctx context.Context) ([]byte, error) {
		deadline, ok := ctx.Deadline()
		if !ok {
			t.Fatal("systemctl context has no deadline")
		}
		remaining := time.Until(deadline)
		if remaining <= 0 || remaining > 6*time.Second {
			t.Fatalf("systemctl deadline remaining=%s", remaining)
		}
		return []byte("LoadState=not-found\nActiveState=inactive\n"), context.DeadlineExceeded
	}
	t.Cleanup(func() { systemctlShowCommand = old })

	if _, err := Status(); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Status error=%v, want deadline exceeded", err)
	}
}
