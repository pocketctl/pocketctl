//go:build !windows

package session

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestExecResumeProcessKillTerminatesDescendants(t *testing.T) {
	dir := t.TempDir()
	script := filepath.Join(dir, "resume-parent")
	childPIDFile := filepath.Join(dir, "child.pid")
	heartbeatFile := filepath.Join(dir, "heartbeat")
	body := "#!/bin/sh\n" +
		"(while :; do printf x >> " + shellQuotePath(heartbeatFile) + "; sleep 0.05; done) &\n" +
		"child=$!\n" +
		"printf '%s\\n' \"$child\" > " + shellQuotePath(childPIDFile) + "\n" +
		"wait \"$child\"\n"
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}

	proc, err := startExecResumeProcess(context.Background(), resumeLaunchSpec{Path: script, Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	var childPID int
	t.Cleanup(func() {
		_ = proc.Kill()
		if childPID > 0 {
			_ = syscall.Kill(childPID, syscall.SIGKILL)
		}
	})

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		raw, readErr := os.ReadFile(childPIDFile)
		if readErr == nil {
			childPID, err = strconv.Atoi(strings.TrimSpace(string(raw)))
			if err == nil && childPID > 0 {
				break
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	if childPID <= 0 {
		t.Fatal("resume child did not publish its PID")
	}

	if err := proc.Kill(); err != nil {
		t.Fatalf("Kill error=%v", err)
	}
	_ = proc.Wait()

	before, err := os.Stat(heartbeatFile)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(250 * time.Millisecond)
	after, err := os.Stat(heartbeatFile)
	if err != nil {
		t.Fatal(err)
	}
	if after.Size() != before.Size() {
		t.Fatalf("descendant kept running after Kill: heartbeat grew from %d to %d bytes", before.Size(), after.Size())
	}
}
