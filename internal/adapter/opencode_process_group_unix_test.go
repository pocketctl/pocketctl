//go:build !windows

package adapter

import (
	"os"
	"os/exec"
	"strings"
	"testing"
)

func TestOpenCodeServeUsesIndependentProcessGroup(t *testing.T) {
	cmd := exec.Command("true")
	configureOpencodeServeProcess(cmd)
	if cmd.SysProcAttr == nil || !cmd.SysProcAttr.Setpgid {
		t.Fatalf("serve process isolation=%+v", cmd.SysProcAttr)
	}
}

func TestProcessStartCommandForcesEnglishPSLocale(t *testing.T) {
	if err := os.Setenv("LC_ALL", "zh_CN.UTF-8"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Unsetenv("LC_ALL") })

	cmd := newProcessStartCommand(os.Getpid())
	var values []string
	for _, entry := range cmd.Env {
		if strings.HasPrefix(entry, "LC_ALL=") {
			values = append(values, entry)
		}
	}
	if len(values) != 1 || values[0] != "LC_ALL=C" {
		t.Fatalf("ps locale=%v, want exactly [LC_ALL=C]", values)
	}
}
