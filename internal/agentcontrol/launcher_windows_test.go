//go:build windows

package agentcontrol

import (
	"errors"
	"os"
	"os/exec"
	"testing"
)

func TestOpenCodeLauncherWindowsSupervisorPreservesExitCode(t *testing.T) {
	if os.Getenv("POCKETCTL_WINDOWS_EXIT_HELPER") == "1" {
		os.Exit(23)
	}
	startedPID := 0
	err := executeOpenCode(ExecSpec{
		Path: os.Args[0],
		Args: []string{"-test.run=TestOpenCodeLauncherWindowsSupervisorPreservesExitCode"},
		Env:  append(os.Environ(), "POCKETCTL_WINDOWS_EXIT_HELPER=1"),
		OnStart: func(pid int) error {
			startedPID = pid
			return nil
		},
	})
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) || exitErr.ExitCode() != 23 {
		t.Fatalf("supervisor error=%v, want exit code 23", err)
	}
	if startedPID <= 0 {
		t.Fatalf("lease binder received invalid child PID %d", startedPID)
	}
}
