//go:build windows

package agentcontrol

import (
	"errors"
	"os"
	"strings"

	"golang.org/x/sys/windows/registry"
)

const windowsShimMarker = launcherMarkerWindows

func installPlatformShim(shimPath, pocketctlPath, agent string, realBinaries ...string) error {
	if _, err := os.Lstat(shimPath); err == nil {
		if !isPocketctlOwnedShim(shimPath, pocketctlPath) {
			return ErrForeignShim
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	realBinary := ""
	if len(realBinaries) > 0 {
		realBinary = realBinaries[0]
	}
	// v3 wrapper: the depth fuse makes a second PocketCtl hop fall straight
	// through to the recorded real binary, so re-entry cannot loop forever.
	body := launcherMarkerWindowsV3 + "\r\n" +
		"@setlocal\r\n" +
		"@if not \"%POCKETCTL_AGENT_LAUNCH_DEPTH%\"==\"\" goto fallback\r\n" +
		"@if not exist \"" + pocketctlPath + "\" goto fallback\r\n"
	if realBinary != "" {
		body += "@set \"POCKETCTL_AGENT_REAL_BINARY=" + realBinary + "\"\r\n"
	}
	body += "@set \"POCKETCTL_AGENT_LAUNCH_DEPTH=1\"\r\n" +
		"@\"" + pocketctlPath + "\" __agent-launch " + agent + " %*\r\n" +
		"@endlocal & exit /b %errorlevel%\r\n" +
		":fallback\r\n" +
		"@set \"POCKETCTL_AGENT_LAUNCH_DEPTH=\"\r\n" +
		"@set \"POCKETCTL_AGENT_REAL_BINARY=\"\r\n"
	if realBinary != "" {
		body += "@\"" + realBinary + "\" %*\r\n" +
			"@exit /b %errorlevel%\r\n"
	} else {
		body += "@exit /b 9009\r\n"
	}
	return os.WriteFile(shimPath, []byte(body), 0o600)
}

func removePlatformShim(shimPath, pocketctlPath string) error {
	if _, err := os.Lstat(shimPath); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	if !isPocketctlOwnedShim(shimPath, pocketctlPath) {
		return ErrForeignShim
	}
	return os.Remove(shimPath)
}

func ensureLauncherPath(_, binDir, _ string) error {
	key, err := registry.OpenKey(registry.CURRENT_USER, `Environment`, registry.QUERY_VALUE|registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer key.Close()
	value, _, _ := key.GetStringValue("Path")
	updated, changed := addWindowsPathEntry(value, binDir)
	if !changed {
		return nil
	}
	return key.SetStringValue("Path", updated)
}

func removeLauncherPath(_, binDir, _ string) error {
	key, err := registry.OpenKey(registry.CURRENT_USER, `Environment`, registry.QUERY_VALUE|registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer key.Close()
	value, _, err := key.GetStringValue("Path")
	if err != nil {
		return nil
	}
	return key.SetStringValue("Path", removeWindowsPathEntry(value, binDir))
}

func addWindowsPathEntry(value, binDir string) (string, bool) {
	if pathListContains(value, binDir) {
		return value, false
	}
	if value != "" && !strings.HasSuffix(value, ";") {
		value += ";"
	}
	return value + binDir, true
}

func removeWindowsPathEntry(value, binDir string) string {
	parts := strings.Split(value, ";")
	out := parts[:0]
	for _, part := range parts {
		if cleanComparablePath(part) != cleanComparablePath(binDir) {
			out = append(out, part)
		}
	}
	return strings.Join(out, ";")
}

func pathListContains(value, want string) bool {
	for _, part := range strings.Split(value, ";") {
		if cleanComparablePath(part) == cleanComparablePath(want) {
			return true
		}
	}
	return false
}
