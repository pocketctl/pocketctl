//go:build !windows

package adapter

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"
)

func configureOpencodeServeProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func validateProcessStartedBefore(pid int, notAfter time.Time) error {
	if notAfter.IsZero() {
		return fmt.Errorf("missing process identity timestamp")
	}
	cmd := newProcessStartCommand(pid)
	out, err := cmd.Output()
	if err != nil {
		return err
	}
	started, err := time.ParseInLocation("Mon Jan 2 15:04:05 2006", strings.TrimSpace(string(out)), time.Local)
	if err != nil {
		return fmt.Errorf("parse process start: %w", err)
	}
	if started.After(notAfter.Add(time.Second)) {
		return fmt.Errorf("pid was created after handoff identity")
	}
	return nil
}

func newProcessStartCommand(pid int) *exec.Cmd {
	// ps localizes lstart according to the inherited locale. Pin it to the C
	// locale because Go's reference layout only parses the stable English form.
	cmd := exec.Command("ps", "-p", fmt.Sprintf("%d", pid), "-o", "lstart=")
	cmd.Env = withCProcessLocale(os.Environ())
	return cmd
}

func withCProcessLocale(env []string) []string {
	filtered := make([]string, 0, len(env)+1)
	for _, entry := range env {
		if !strings.HasPrefix(entry, "LC_ALL=") {
			filtered = append(filtered, entry)
		}
	}
	return append(filtered, "LC_ALL=C")
}
