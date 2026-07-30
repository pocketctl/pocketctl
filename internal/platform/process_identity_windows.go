//go:build windows

package platform

import (
	"fmt"

	"golang.org/x/sys/windows"
)

func ProcessStartIdentity(pid int) (string, error) {
	return processStartIdentityWindows(pid, queryWindowsProcessStartInfo)
}

func queryWindowsProcessStartInfo(pid int) (windowsProcessStartInfo, error) {
	handle, err := windows.OpenProcess(
		windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE,
		false,
		uint32(pid),
	)
	if err != nil {
		// In particular, access denied remains an error. It must never be
		// collapsed into "process absent" by callers authorizing a signal.
		return windowsProcessStartInfo{}, fmt.Errorf(
			"open process %d for start identity: %w",
			pid,
			err,
		)
	}
	defer windows.CloseHandle(handle)

	runningBefore, err := windowsProcessHandleIsRunning(handle)
	if err != nil {
		return windowsProcessStartInfo{}, fmt.Errorf(
			"check process %d before start identity query: %w",
			pid,
			err,
		)
	}
	if !runningBefore {
		return windowsProcessStartInfo{Running: false}, nil
	}

	var creationTime windows.Filetime
	var exitTime windows.Filetime
	var kernelTime windows.Filetime
	var userTime windows.Filetime
	if err := windows.GetProcessTimes(
		handle,
		&creationTime,
		&exitTime,
		&kernelTime,
		&userTime,
	); err != nil {
		return windowsProcessStartInfo{}, fmt.Errorf(
			"get process %d creation time: %w",
			pid,
			err,
		)
	}

	runningAfter, err := windowsProcessHandleIsRunning(handle)
	if err != nil {
		return windowsProcessStartInfo{}, fmt.Errorf(
			"check process %d after start identity query: %w",
			pid,
			err,
		)
	}
	return windowsProcessStartInfo{
		CreationTimeHigh: creationTime.HighDateTime,
		CreationTimeLow:  creationTime.LowDateTime,
		Running:          runningAfter,
	}, nil
}

func windowsProcessHandleIsRunning(handle windows.Handle) (bool, error) {
	event, err := windows.WaitForSingleObject(handle, 0)
	if err != nil {
		return false, err
	}
	switch event {
	case windows.WAIT_OBJECT_0:
		return false, nil
	case uint32(windows.WAIT_TIMEOUT):
		return true, nil
	default:
		return false, fmt.Errorf("unexpected wait result %#x", event)
	}
}
