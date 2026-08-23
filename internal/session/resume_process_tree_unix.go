//go:build !windows

package session

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
)

type unixResumeProcessTree struct{}

func newResumeProcessTree() (resumeProcessTree, error) {
	return unixResumeProcessTree{}, nil
}

func (unixResumeProcessTree) Configure(cmd *exec.Cmd) error {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	return nil
}

func (unixResumeProcessTree) Attach(*exec.Cmd) error { return nil }

func (unixResumeProcessTree) Kill(cmd *exec.Cmd) error {
	if cmd.Process == nil || cmd.Process.Pid <= 0 {
		return nil
	}
	err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	if err == nil || errors.Is(err, syscall.ESRCH) || errors.Is(err, os.ErrProcessDone) {
		return nil
	}
	directErr := cmd.Process.Kill()
	if directErr == nil || errors.Is(directErr, os.ErrProcessDone) {
		return err
	}
	return errors.Join(err, directErr)
}

func (unixResumeProcessTree) Close() error { return nil }
