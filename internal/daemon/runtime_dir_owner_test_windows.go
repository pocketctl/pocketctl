//go:build windows

package daemon

import (
	"os"
	"testing"
)

func assertRuntimeDirOwner(t *testing.T, _ os.FileInfo) {
	t.Helper()
}
