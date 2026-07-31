//go:build darwin

package platform

import (
	"fmt"

	"golang.org/x/sys/unix"
)

type darwinProcessStartInfo struct {
	PID  int
	Sec  int64
	Usec int64
}

func ProcessStartIdentity(pid int) (string, error) {
	return processStartIdentityDarwin(pid, queryDarwinProcessStartInfo)
}

func queryDarwinProcessStartInfo(pid int) (darwinProcessStartInfo, error) {
	info, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil {
		return darwinProcessStartInfo{}, fmt.Errorf(
			"query process start identity for pid %d: %w",
			pid,
			err,
		)
	}
	return darwinProcessStartInfo{
		PID:  int(info.Proc.P_pid),
		Sec:  info.Proc.P_starttime.Sec,
		Usec: int64(info.Proc.P_starttime.Usec),
	}, nil
}

func processStartIdentityDarwin(
	pid int,
	query func(int) (darwinProcessStartInfo, error),
) (string, error) {
	if err := validateProcessStartIdentityPID(pid); err != nil {
		return "", err
	}
	info, err := query(pid)
	if err != nil {
		return "", err
	}
	if info.PID != pid {
		return "", fmt.Errorf(
			"process start identity pid mismatch: queried %d, got %d",
			pid,
			info.PID,
		)
	}
	if info.Sec == 0 && info.Usec == 0 {
		return "", fmt.Errorf("process start identity for pid %d is empty", pid)
	}
	return fmt.Sprintf("darwin:%d:%d", info.Sec, info.Usec), nil
}
