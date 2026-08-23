//go:build linux

package platform

import (
	"fmt"
	"os"
)

func ProcessStartIdentity(pid int) (string, error) {
	return processStartIdentityLinux(pid, os.ReadFile)
}

func processStartIdentityLinux(
	pid int,
	readFile func(string) ([]byte, error),
) (string, error) {
	if err := validateProcessStartIdentityPID(pid); err != nil {
		return "", err
	}
	path := fmt.Sprintf("/proc/%d/stat", pid)
	data, err := readFile(path)
	if err != nil {
		return "", fmt.Errorf("read process start identity for pid %d: %w", pid, err)
	}
	startTime, err := parseLinuxProcStatStartTime(data)
	if err != nil {
		return "", fmt.Errorf("read process start identity for pid %d: %w", pid, err)
	}
	return "linux:" + startTime, nil
}
