//go:build windows

package agentcontrol

import (
	"errors"
	"fmt"
	"os"
	"strings"

	"golang.org/x/sys/windows/registry"
)

const windowsShimMarker = "@rem pocketctl-agent-launcher"

func installPlatformShim(shimPath, pocketctlPath, agent string) error {
	if data, err := os.ReadFile(shimPath); err == nil {
		if strings.Contains(string(data), windowsShimMarker) {
			return nil
		}
		return ErrForeignShim
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	body := fmt.Sprintf("%s\r\n@\"%s\" __agent-launch %s %%*\r\n", windowsShimMarker, pocketctlPath, agent)
	return os.WriteFile(shimPath, []byte(body), 0o600)
}

func removePlatformShim(shimPath, _ string) error {
	data, err := os.ReadFile(shimPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !strings.Contains(string(data), windowsShimMarker) {
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
