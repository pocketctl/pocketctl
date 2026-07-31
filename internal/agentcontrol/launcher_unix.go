//go:build !windows

package agentcontrol

import (
	"os"
	"syscall"
)

func executeOpenCode(spec ExecSpec) error {
	if spec.Dir != "" {
		if err := os.Chdir(spec.Dir); err != nil {
			return err
		}
	}
	argv := append([]string{spec.Path}, spec.Args...)
	return syscall.Exec(spec.Path, argv, spec.Env)
}
