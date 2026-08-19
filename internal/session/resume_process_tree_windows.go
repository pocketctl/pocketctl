//go:build windows

package session

import (
	"errors"
	"os"
	"os/exec"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

type windowsResumeProcessTree struct {
	mu     sync.Mutex
	job    windows.Handle
	closed bool
}

func newResumeProcessTree() (resumeProcessTree, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, err
	}
	tree := &windowsResumeProcessTree{job: job}
	var info windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	_, err = windows.SetInformationJobObject(
		job,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)),
		uint32(unsafe.Sizeof(info)),
	)
	if err != nil {
		_ = windows.CloseHandle(job)
		return nil, err
	}
	return tree, nil
}

func (*windowsResumeProcessTree) Configure(*exec.Cmd) error { return nil }

func (t *windowsResumeProcessTree) Attach(cmd *exec.Cmd) error {
	if cmd.Process == nil || cmd.Process.Pid <= 0 {
		return os.ErrProcessDone
	}
	process, err := windows.OpenProcess(
		windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE,
		false,
		uint32(cmd.Process.Pid),
	)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(process)

	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return os.ErrClosed
	}
	return windows.AssignProcessToJobObject(t.job, process)
}

func (t *windowsResumeProcessTree) Kill(cmd *exec.Cmd) error {
	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		if cmd.Process == nil {
			return nil
		}
		err := cmd.Process.Kill()
		if errors.Is(err, os.ErrProcessDone) {
			return nil
		}
		return err
	}
	err := windows.TerminateJobObject(t.job, 1)
	t.mu.Unlock()
	if err == nil || errors.Is(err, os.ErrProcessDone) {
		return nil
	}
	if cmd.Process == nil {
		return err
	}
	directErr := cmd.Process.Kill()
	if directErr == nil || errors.Is(directErr, os.ErrProcessDone) {
		return err
	}
	return errors.Join(err, directErr)
}

func (t *windowsResumeProcessTree) Close() error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return nil
	}
	t.closed = true
	return windows.CloseHandle(t.job)
}
