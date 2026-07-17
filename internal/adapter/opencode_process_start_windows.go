//go:build windows

package adapter

import (
	"fmt"
	"os/exec"
	"time"

	"golang.org/x/sys/windows"
)

func configureOpencodeServeProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &windows.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP}
}

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
