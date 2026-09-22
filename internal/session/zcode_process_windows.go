//go:build windows

package session

import "os/exec"

func configureZcodeProcess(*exec.Cmd) {}

func killZcodeProcess(cmd *exec.Cmd) error {
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	return cmd.Process.Kill()
}
