//go:build windows

package adapter

import (
	"fmt"
	"time"

	"golang.org/x/sys/windows"
)

func validateProcessStartedBefore(pid int, notAfter time.Time) error {
	if notAfter.IsZero() {
		return fmt.Errorf("missing process identity timestamp")
	}
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return err
	}
	defer windows.CloseHandle(h)
	var creation, exit, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(h, &creation, &exit, &kernel, &user); err != nil {
		return err
	}
	started := time.Unix(0, creation.Nanoseconds())
	if started.After(notAfter.Add(time.Second)) {
		return fmt.Errorf("pid was created after handoff identity")
	}
	return nil
}
