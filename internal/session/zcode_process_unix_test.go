//go:build !windows

package session

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestConfigureZcodeProcessCreatesDedicatedProcessGroup(t *testing.T) {
	cmd := exec.Command("true")
	configureZcodeProcess(cmd)
	if cmd.SysProcAttr == nil || !cmd.SysProcAttr.Setpgid {
		t.Fatal("managed ZCode app-server must own a process group")
	}
}

func TestStartZcodeAppServerUsesProtocolArgumentsAndGracefulEOF(t *testing.T) {
	dir := t.TempDir()
	argsPath := filepath.Join(dir, "args")
	eofPath := filepath.Join(dir, "eof")
	script := filepath.Join(dir, "zcode")
	body := "#!/bin/sh\n" +
		"printf '%s\\n' \"$*\" > '" + argsPath + "'\n" +
		"IFS= read -r line\n" +
		"printf '%s\\n' '{\"id\":1,\"result\":{}}'\n" +
		"while IFS= read -r line; do :; done\n" +
		"printf done > '" + eofPath + "'\n"
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}

	client, err := startZcodeAppServer(context.Background(), script)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	var capabilities map[string]any
	if err := client.Call(ctx, "runtime/capabilities", map[string]any{}, &capabilities); err != nil {
		t.Fatal(err)
	}
	if err := client.Close(); err != nil {
		t.Fatal(err)
	}
	args, err := os.ReadFile(argsPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(args)) != "app-server --stdio" {
		t.Fatalf("arguments = %q", strings.TrimSpace(string(args)))
	}
	if _, err := os.Stat(eofPath); err != nil {
		t.Fatalf("app server did not observe graceful stdin EOF: %v", err)
	}
}

func TestZcodeStderrTailIsBoundedAndKeepsNewestBytes(t *testing.T) {
	tail := &zcodeStderrTail{limit: 5}
	_, _ = tail.Write([]byte("1234"))
	_, _ = tail.Write([]byte("5678"))
	if got := tail.String(); got != "45678" {
		t.Fatalf("tail = %q, want newest bytes", got)
	}
}
