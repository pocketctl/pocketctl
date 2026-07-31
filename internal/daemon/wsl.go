package daemon

import (
	"os"
	"runtime"
	"strings"
)

// IsWSL reports whether the current process is running inside Windows
// Subsystem for Linux (WSL1 or WSL2).
//
// Detection strategy (any one match = true):
//  1. WSL_DISTRO_NAME or WSLENV environment variable is set
//  2. /proc/version contains the "microsoft" kernel marker
//
// Only relevant when runtime.GOOS == "linux" — returns false on all other
// platforms without checking files.
func IsWSL() bool {
	if runtime.GOOS != "linux" {
		return false
	}
	if os.Getenv("WSL_DISTRO_NAME") != "" || os.Getenv("WSLENV") != "" {
		return true
	}
	if data, err := os.ReadFile("/proc/version"); err == nil {
		return strings.Contains(string(data), "microsoft")
	}
	return false
}
