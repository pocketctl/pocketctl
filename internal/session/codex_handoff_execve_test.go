//go:build !windows

package session

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/pocketctl/pocketctl/internal/daemon"
	"github.com/pocketctl/pocketctl/internal/platform"
)

func npmExecveFixture(t *testing.T) (*daemon.CodexAppServerState, platform.ProcessSnapshot) {
	t.Helper()
	root := filepath.Join(t.TempDir(), "node_modules", "@openai", "codex")
	script := filepath.Join(root, "bin", "codex.js")
	platformPackage, triple := codexNpmPlatform(runtime.GOOS, runtime.GOARCH)
	if platformPackage == "" {
		t.Skip("unsupported npm platform")
	}
	pkg := filepath.Join(root, "node_modules", "@openai", platformPackage)
	native := filepath.Join(pkg, "vendor", triple, "bin", "codex")
	for _, p := range []string{script, native} {
		if err := os.MkdirAll(filepath.Dir(p), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("#!/usr/bin/env node\n"), 0700); err != nil {
			t.Fatal(err)
		}
	}
	for path, name := range map[string]string{filepath.Join(root, "package.json"): "@openai/codex", filepath.Join(pkg, "package.json"): "@openai/" + platformPackage} {
		data, _ := json.Marshal(map[string]any{"name": name, "version": "0.167.1", "optionalDependencies": map[string]string{"@openai/" + platformPackage: "0.167.1"}})
		if err := os.WriteFile(path, data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	state := &daemon.CodexAppServerState{PID: 42, Binary: script, Version: "0.167.1", Endpoint: "/tmp/npm.sock", RemoteURI: "unix:///tmp/npm.sock"}
	process := platform.ProcessSnapshot{PID: 42, Executable: native, Args: []string{native, "app-server", "--listen", state.RemoteURI}}
	return state, process
}

func TestCodexHandoffAcceptsPinnedNpmAliasVersion(t *testing.T) {
	state, process := npmExecveFixture(t)
	root := filepath.Dir(filepath.Dir(state.Binary))
	pkg, _ := codexNpmPlatform(runtime.GOOS, runtime.GOARCH)
	version := "0.167.1-" + pkg[len("codex-"):]
	data, _ := json.Marshal(map[string]any{"name": "@openai/codex", "version": "0.167.0", "optionalDependencies": map[string]string{"@openai/" + pkg: "npm:@openai/codex@" + version}})
	if err := os.WriteFile(filepath.Join(root, "package.json"), data, 0600); err != nil {
		t.Fatal(err)
	}
	data, _ = json.Marshal(map[string]string{"name": "@openai/codex", "version": version})
	path := filepath.Join(root, "node_modules", "@openai", pkg, "package.json")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	if !codexHandoffArgsMatch(state, process) {
		t.Fatal("official npm alias rejected when launcher and native versions differ")
	}
	if err := os.WriteFile(path, []byte(`{"name":"@openai/codex","version":"0.166.0-darwin-arm64"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if codexHandoffArgsMatch(state, process) {
		t.Fatal("accepted wrong native alias version")
	}
}

func TestCodexHandoffAcceptsExactNpmExecveBinary(t *testing.T) {
	state, process := npmExecveFixture(t)
	if !codexHandoffArgsMatch(state, process) {
		t.Fatal("exact npm bundled executable rejected after execve")
	}
	for _, mutation := range []func(*daemon.CodexAppServerState, *platform.ProcessSnapshot){
		func(s *daemon.CodexAppServerState, p *platform.ProcessSnapshot) {
			p.Executable = filepath.Join(t.TempDir(), "codex")
		},
		func(s *daemon.CodexAppServerState, p *platform.ProcessSnapshot) {
			p.Args[3] = "unix:///tmp/foreign.sock"
		},
		func(s *daemon.CodexAppServerState, p *platform.ProcessSnapshot) { s.Version = "0.166.0" },
		func(s *daemon.CodexAppServerState, p *platform.ProcessSnapshot) {
			p.Args = []string{p.Executable, "exec", "app-server", "--listen", s.RemoteURI}
		},
	} {
		s, p := *state, process
		p.Args = append([]string(nil), process.Args...)
		mutation(&s, &p)
		if codexHandoffArgsMatch(&s, p) {
			t.Fatalf("accepted foreign npm process: %+v %+v", s, p)
		}
	}
}

func TestCodexHandoffRejectsUnrelatedPackageNamedCodex(t *testing.T) {
	state, process := npmExecveFixture(t)
	packageJSON := filepath.Join(filepath.Dir(filepath.Dir(state.Binary)), "package.json")
	if err := os.WriteFile(packageJSON, []byte(`{"name":"unrelated","version":"0.167.1"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if codexHandoffArgsMatch(state, process) {
		t.Fatal("accepted executable based only on codex basename")
	}
}

func TestCodexHandoffPinsReadyExecutable(t *testing.T) {
	state, process := npmExecveFixture(t)
	state.ProcessExecutable = process.Executable
	if !codexHandoffArgsMatch(state, process) {
		t.Fatal("ready native executable rejected")
	}
	state.ProcessExecutable = filepath.Join(t.TempDir(), "foreign-codex")
	if codexHandoffArgsMatch(state, process) {
		t.Fatal("ignored pinned executable identity")
	}
}
