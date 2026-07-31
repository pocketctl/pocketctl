//go:build windows

package agentcontrol

import "os"

func isDirectory(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}
