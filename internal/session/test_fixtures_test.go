package session

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"testing"
)

func writeFakeCommandFixture(t *testing.T, basePath, unixScript, windowsScript string) string {
	t.Helper()
	path := basePath
	if runtime.GOOS == "windows" {
		if filepath.Ext(path) == "" {
			path += ".cmd"
		}
		if err := os.WriteFile(path, []byte(windowsScript), 0o700); err != nil {
			t.Fatal(err)
		}
		return path
	}
	if err := os.WriteFile(path, []byte(unixScript), 0o700); err != nil {
		t.Fatal(err)
	}
	return path
}

func sleepCommand(t *testing.T, seconds int) *exec.Cmd {
	t.Helper()
	if runtime.GOOS == "windows" {
		return exec.Command("cmd", "/C", "timeout", "/T", strconv.Itoa(seconds), "/NOBREAK")
	}
	return exec.Command("sleep", strconv.Itoa(seconds))
}
