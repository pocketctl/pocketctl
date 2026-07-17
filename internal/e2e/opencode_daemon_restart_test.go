package e2e

import (
	"os/exec"
	"testing"

	"github.com/pocketctl/pocketctl/internal/agentcontrol"
	"github.com/pocketctl/pocketctl/internal/daemon"
)

func TestOpenCodeDaemonRestartRestoresOnlyLiveTerminalLeases(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	terminal := exec.Command("sleep", "30")
	if err := terminal.Start(); err != nil {
		t.Fatal(err)
	}
	defer terminal.Process.Kill()

	beforeRestart := agentcontrol.NewLeaseRegistry()
	if err := beforeRestart.Register(agentcontrol.Lease{
		ID: "lease-terminal", Agent: agentcontrol.AgentOpenCode, SessionID: "ses_1",
		PID: terminal.Process.Pid, Generation: 9,
	}); err != nil {
		t.Fatal(err)
	}
	if err := daemon.WriteOpenCodeServeState(&daemon.OpenCodeServeState{
		PID: 777, BaseURL: "http://127.0.0.1:4096", Password: "private", Version: "1.17.11",
		OwnerPID: 0, Generation: 9, Leases: beforeRestart.Snapshot(),
	}); err != nil {
		t.Fatal(err)
	}

	handoff, err := daemon.ReadOpenCodeServeState()
	if err != nil {
		t.Fatal(err)
	}
	afterRestart := agentcontrol.NewLeaseRegistry()
	afterRestart.Restore(handoff.Leases)
	if got := afterRestart.Active(handoff.Generation); len(got) != 1 || got[0].SessionID != "ses_1" {
		t.Fatalf("replacement daemon leases=%+v", got)
	}

	if err := terminal.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = terminal.Wait()
	if got := afterRestart.Active(handoff.Generation); len(got) != 0 {
		t.Fatalf("dead terminal lease survived restart reconciliation: %+v", got)
	}
}
