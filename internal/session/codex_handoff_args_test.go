//go:build !windows

package session

import (
	"github.com/pocketctl/pocketctl/internal/daemon"
	"github.com/pocketctl/pocketctl/internal/platform"
	"os"
	"path/filepath"
	"testing"
)

func TestCodexHandoffRejectsAmbiguousNodeArguments(t *testing.T) {
	script := filepath.Join(t.TempDir(), "codex.js")
	if err := os.WriteFile(script, []byte("#!/usr/bin/env node\n"), 0700); err != nil {
		t.Fatal(err)
	}
	state := &daemon.CodexAppServerState{PID: 42, Binary: script, Endpoint: "/tmp/app.sock", RemoteURI: "unix:///tmp/app.sock"}
	for _, tt := range []struct {
		name, exe string
		args      []string
		want      bool
	}{
		{"exact", "/opt/node", []string{"node", script, "app-server", "--listen", state.RemoteURI}, true},
		{"equals listener", "/opt/node", []string{"node", script, "app-server", "--listen=" + state.RemoteURI}, true},
		{"wrong interpreter", "/opt/python", []string{"node", script, "app-server", "--listen", state.RemoteURI}, false},
		{"wrong script", "/opt/node", []string{"node", "/tmp/other.js", "app-server", "--listen", state.RemoteURI}, false},
		{"node eval", "/opt/node", []string{"node", "-e", script, "app-server", "--listen", state.RemoteURI}, false},
		{"missing listener value", "/opt/node", []string{"node", script, "app-server", "--listen"}, false},
		{"duplicate listener", "/opt/node", []string{"node", script, "app-server", "--listen", state.RemoteURI, "--listen=" + state.RemoteURI}, false},
		{"trailing listener", "/opt/node", []string{"node", script, "app-server", "--listen", state.RemoteURI, "--listen"}, false},
		{"positional listener", "/opt/node", []string{"node", script, "app-server", "--", "--listen", state.RemoteURI}, false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if got := codexHandoffArgsMatch(state, platform.ProcessSnapshot{PID: 42, Executable: tt.exe, Args: tt.args}); got != tt.want {
				t.Fatalf("matched=%v", got)
			}
		})
	}
	if err := os.WriteFile(script, []byte("#!/bin/sh\n"), 0700); err != nil {
		t.Fatal(err)
	}
	if codexHandoffArgsMatch(state, platform.ProcessSnapshot{PID: 42, Executable: "/opt/node", Args: []string{"node", script, "app-server", "--listen", state.RemoteURI}}) {
		t.Fatal("accepted non-Node script")
	}
}
