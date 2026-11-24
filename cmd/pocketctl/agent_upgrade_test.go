//go:build !windows

package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestCodexUpgradeCoalescesDuplicateRequests(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	prefix := filepath.Join(home, ".local")
	t.Setenv("PREFIX_FIXTURE", prefix)
	bin := filepath.Join(prefix, "bin")
	t.Setenv("PATH", bin)
	pkg := filepath.Join(prefix, "lib", "node_modules", "@openai", "codex")
	for _, dir := range []string{bin, filepath.Join(pkg, "bin")} {
		if err := os.MkdirAll(dir, 0755); err != nil {
			t.Fatal(err)
		}
	}
	write := func(file, data string) {
		t.Helper()
		if err := os.WriteFile(file, []byte(data), 0755); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(pkg, "bin", "codex.js"), "#!/bin/sh\necho 'codex-cli 0.172.0'\n")
	write(filepath.Join(pkg, "package.json"), `{"name":"@openai/codex","version":"0.172.0"}`)
	if err := os.Symlink(filepath.Join(pkg, "bin", "codex.js"), filepath.Join(bin, "codex")); err != nil {
		t.Fatal(err)
	}
	write(filepath.Join(bin, "npm"), `#!/bin/sh
case "$1" in
  prefix|config) echo "$PREFIX_FIXTURE" ;;
  install)
    echo install >> "$PREFIX_FIXTURE/calls"
    while [ ! -f "$PREFIX_FIXTURE/release" ]; do /bin/sleep 0.02; done ;;
  view) echo 0.172.0 ;;
esac
`)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	sender := &recordingDaemonMessageSender{}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	done := make(chan struct{})
	go func() { defer close(done); handleUpgradeAgent(ctx, sender, logger, "codex", nil) }()
	for {
		if _, err := os.Stat(filepath.Join(prefix, "calls")); err == nil {
			break
		}
		select {
		case <-done:
			t.Fatalf("unexpected early completion: %+v", sender.messages)
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(10 * time.Millisecond):
		}
	}
	other := &recordingDaemonMessageSender{}
	handleUpgradeAgent(ctx, other, logger, "codex", nil)
	write(filepath.Join(prefix, "release"), "")
	<-done
	if len(other.messages) != 0 || len(sender.messages) != 1 {
		t.Fatalf("duplicate results: %+v %+v", other.messages, sender.messages)
	}
	event := sender.messages[0].(protocol.DaemonEvent)
	if event.Status != "success" || event.Message != "0.172.0" {
		t.Fatalf("%+v", event)
	}
	calls, err := os.ReadFile(filepath.Join(prefix, "calls"))
	if err != nil || string(calls) != "install\n" {
		t.Fatalf("installs=%q err=%v", calls, err)
	}
}

func TestAgentUpgradeReturnsDeadline(t *testing.T) {
	script := filepath.Join(t.TempDir(), "agent")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nexec /bin/sleep 30\n"), 0755); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, err := runAgentUpgrade(ctx, script, "agent update", "", ""); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected deadline: %v", err)
	}
}
