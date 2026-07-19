//go:build !windows

package adapter

import (
	"os/exec"
	"testing"
)

func TestOpenCodeServeUsesIndependentProcessGroup(t *testing.T) {
	cmd := exec.Command("true")
	configureOpencodeServeProcess(cmd)
	if cmd.SysProcAttr == nil || !cmd.SysProcAttr.Setpgid {
		t.Fatalf("serve process isolation=%+v", cmd.SysProcAttr)
	}
}
