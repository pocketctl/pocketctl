package daemon

import (
	"os"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/agentcontrol"
)

func TestCodexAppServerStateRoundTripIsPrivate(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	want := &CodexAppServerState{
		PID: os.Getpid(), OwnerPID: 42, Endpoint: "/private/tmp/pocketctl/codex.sock",
		RemoteURI: "unix:///private/tmp/pocketctl/codex.sock", Binary: "/opt/codex",
		Version: "0.144.1", SchemaHash: "abc", Generation: 7,
		Threads:   []string{"thr_1", "thr_2"},
		Leases:    map[string]agentcontrol.Lease{"lease-1": {ID: "lease-1", PID: os.Getpid(), Generation: 7}},
		UpdatedAt: time.Now().UTC().Truncate(time.Second),
	}
	if err := WriteCodexAppServerState(want); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(CodexAppServerStatePath())
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode=%o want 600", info.Mode().Perm())
	}
	got, err := ReadCodexAppServerState()
	if err != nil {
		t.Fatal(err)
	}
	if got.PID != want.PID || got.Endpoint != want.Endpoint || got.RemoteURI != want.RemoteURI || got.Generation != 7 || got.Version != "0.144.1" || got.Leases["lease-1"].ID != "lease-1" || len(got.Threads) != 2 || got.Threads[0] != "thr_1" {
		t.Fatalf("state=%+v want=%+v", got, want)
	}
	if err := RemoveCodexAppServerState(); err != nil {
		t.Fatal(err)
	}
}

func TestCodexAppServerStateRejectsCorruptOrPublicFile(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	path := CodexAppServerStatePath()
	if err := os.MkdirAll(filepathDir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadCodexAppServerState(); err == nil {
		t.Fatal("corrupt state was accepted")
	}
	if err := os.WriteFile(path, []byte(`{"pid":1}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadCodexAppServerState(); err == nil {
		t.Fatal("public state was accepted")
	}
}

func filepathDir(path string) string {
	for index := len(path) - 1; index >= 0; index-- {
		if path[index] == os.PathSeparator {
			return path[:index]
		}
	}
	return "."
}
