//go:build !windows

package adapter

import (
	"fmt"
	"os/exec"
	"strings"
	"time"
)

func validateProcessStartedBefore(pid int, notAfter time.Time) error {
	if notAfter.IsZero() {
		return fmt.Errorf("missing process identity timestamp")
	}
	out, err := exec.Command("ps", "-p", fmt.Sprintf("%d", pid), "-o", "lstart=").Output()
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
