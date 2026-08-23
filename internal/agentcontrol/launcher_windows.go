//go:build windows

package agentcontrol

import (
	"os"
	"os/exec"
)

func executeOpenCode(spec ExecSpec) error {
	cmd := exec.Command(spec.Path, spec.Args...)
	cmd.Env, cmd.Dir = spec.Env, spec.Dir
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Start(); err != nil {
		return err
	}
	if spec.OnStart != nil {
		if err := spec.OnStart(cmd.Process.Pid); err != nil {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
			return err
		}
	}
	return cmd.Wait()
}
