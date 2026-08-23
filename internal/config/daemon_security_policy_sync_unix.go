//go:build !windows

package config

import "os"

func syncDaemonSecurityPolicyDirectory(path string) error {
	dir, err := os.Open(path)
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}
