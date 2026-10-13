//go:build darwin

package platform

import (
	"context"
	"golang.org/x/sys/unix"
)

// InspectProcess reads only the requested PID, without ps/lsof subprocesses.
// KERN_PROCARGS2 is available in both CGO and pure Go daemon builds.
func InspectProcess(ctx context.Context, pid int) (ProcessSnapshot, error) {
	if err := ctx.Err(); err != nil {
		return ProcessSnapshot{}, err
	}
	if err := validateProcessStartIdentityPID(pid); err != nil {
		return ProcessSnapshot{}, err
	}
	raw, err := unix.SysctlRaw("kern.procargs2", pid)
	if err != nil {
		return ProcessSnapshot{}, err
	}
	if err := ctx.Err(); err != nil {
		return ProcessSnapshot{}, err
	}
	return parseDarwinProcessArgs(pid, raw)
}
