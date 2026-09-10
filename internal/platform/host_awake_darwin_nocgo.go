//go:build darwin && !cgo

package platform

import (
	"context"
	"os/exec"
	"time"
)

// Keep the same fail-closed policy in cross-compiled builds without IOKit FFI.
func HostAwake() (bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "/usr/sbin/ioreg", "-r", "-n", "IOPMrootDomain", "-d", "1").Output()
	if err != nil {
		return false, err
	}
	return parseHostCapabilities(string(out))
}
