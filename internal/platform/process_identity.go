package platform

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

func validateProcessStartIdentityPID(pid int) error {
	if pid <= 0 || uint64(pid) > math.MaxUint32 {
		return fmt.Errorf("invalid process pid %d", pid)
	}
	return nil
}

func parseLinuxProcStatStartTime(data []byte) (string, error) {
	stat := strings.TrimSpace(string(data))
	commEnd := strings.LastIndexByte(stat, ')')
	commStart := strings.IndexByte(stat, '(')
	if commStart < 0 || commEnd <= commStart {
		return "", fmt.Errorf("malformed /proc stat process name")
	}
	// Fields after comm begin with field 3 (state). Linux starttime is field
	// 22, therefore index 19 in this suffix. Splitting only after the final ')'
	// keeps spaces and parentheses inside comm from shifting the field index.
	fields := strings.Fields(stat[commEnd+1:])
	if len(fields) <= 19 {
		return "", fmt.Errorf("malformed /proc stat: have %d fields after comm", len(fields))
	}
	startTime, err := strconv.ParseUint(fields[19], 10, 64)
	if err != nil {
		return "", fmt.Errorf("parse /proc stat starttime: %w", err)
	}
	return strconv.FormatUint(startTime, 10), nil
}

type windowsProcessStartInfo struct {
	CreationTimeHigh uint32
	CreationTimeLow  uint32
	Running          bool
}

func processStartIdentityWindows(
	pid int,
	query func(int) (windowsProcessStartInfo, error),
) (string, error) {
	if err := validateProcessStartIdentityPID(pid); err != nil {
		return "", err
	}
	info, err := query(pid)
	if err != nil {
		return "", err
	}
	if !info.Running {
		return "", fmt.Errorf("process %d exited during start identity query", pid)
	}
	if info.CreationTimeHigh == 0 && info.CreationTimeLow == 0 {
		return "", fmt.Errorf("process start identity for pid %d is empty", pid)
	}
	return formatWindowsProcessCreationTime(
		info.CreationTimeHigh,
		info.CreationTimeLow,
	), nil
}

func formatWindowsProcessCreationTime(high, low uint32) string {
	creationTime := uint64(high)<<32 | uint64(low)
	return fmt.Sprintf("windows:%d", creationTime)
}
