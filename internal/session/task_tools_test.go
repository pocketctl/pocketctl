//go:build !windows

package session

import (
	"testing"

	"github.com/pocketctl/pocketctl/internal/config"
	"github.com/pocketctl/pocketctl/internal/daemon"
	"github.com/pocketctl/pocketctl/internal/platform"
)

func TestTaskToolsOverridePreservesCodexHandoffIdentity(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	enabled := true
	if err := config.SaveTaskTools("codex", &enabled); err != nil {
		t.Fatal(err)
	}
	state := &daemon.CodexAppServerState{PID: 42, Binary: "/opt/codex", Endpoint: "/tmp/test.sock", RemoteURI: "unix:///tmp/test.sock"}
	args, _, err := applyManagedTaskToolsCommand("codex", []string{state.Binary, "app-server", "-c", "thread_unload_delay_secs=0", "--listen", state.RemoteURI}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !codexHandoffArgsMatch(state, platform.ProcessSnapshot{PID: state.PID, Executable: state.Binary, Args: args}) {
		t.Fatalf("task-tools override prevents safe runtime adoption: %v", args)
	}
	other := *state
	other.RemoteURI = "unix:///tmp/other.sock"
	if codexHandoffArgsMatch(&other, platform.ProcessSnapshot{PID: state.PID, Executable: state.Binary, Args: args}) {
		t.Fatal("task-tools override weakened endpoint identity validation")
	}
}
