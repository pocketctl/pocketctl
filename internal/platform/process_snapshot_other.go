//go:build !darwin

package platform

import (
	"context"
	gopsprocess "github.com/shirou/gopsutil/v3/process"
)

// InspectProcess reads executable and exact argv for one PID. It deliberately
// avoids listing every process or querying unrelated metadata such as cwd.
func InspectProcess(ctx context.Context, pid int) (ProcessSnapshot, error) {
	if err := ctx.Err(); err != nil {
		return ProcessSnapshot{}, err
	}
	if err := validateProcessStartIdentityPID(pid); err != nil {
		return ProcessSnapshot{}, err
	}
	process, err := gopsprocess.NewProcessWithContext(ctx, int32(pid))
	if err != nil {
		return ProcessSnapshot{}, err
	}
	executable, err := process.ExeWithContext(ctx)
	if err != nil {
		return ProcessSnapshot{}, err
	}
	args, err := process.CmdlineSliceWithContext(ctx)
	if err != nil {
		return ProcessSnapshot{}, err
	}
	return ProcessSnapshot{PID: pid, Executable: executable, Args: args}, nil
}
