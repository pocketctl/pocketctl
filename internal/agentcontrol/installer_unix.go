//go:build !windows

package agentcontrol

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const unixShimMarker = launcherMarkerV2Unix

func installPlatformShim(shimPath, pocketctlPath, agent string, realBinaries ...string) error {
	realBinary := ""
	if len(realBinaries) > 0 {
		realBinary = realBinaries[0]
	}
	if _, err := os.Lstat(shimPath); err == nil {
		if !isPocketctlOwnedShim(shimPath, pocketctlPath) {
			return ErrForeignShim
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if realBinary == "" {
		if err := replaceSymlink(shimPath, pocketctlPath); err != nil {
			return fmt.Errorf("install agent launcher: %w", err)
		}
		return nil
	}
	// v3 wrapper: the depth fuse makes a second PocketCtl hop exec the
	// recorded real binary directly, so re-entry cannot loop forever.
	body := "#!/bin/sh\n" + launcherMarkerV3Unix + "\n" +
		"if [ -n \"${POCKETCTL_AGENT_LAUNCH_DEPTH:-}\" ]; then\n" +
		"  unset POCKETCTL_AGENT_LAUNCH_DEPTH POCKETCTL_AGENT_REAL_BINARY\n" +
		"  exec " + shellQuote(realBinary) + " \"$@\"\n" +
		"fi\n" +
		"if [ -x " + shellQuote(pocketctlPath) + " ]; then\n" +
		"  POCKETCTL_AGENT_LAUNCH_DEPTH=1 \\\n" +
		"  POCKETCTL_AGENT_REAL_BINARY=" + shellQuote(realBinary) + " \\\n" +
		"  exec " + shellQuote(pocketctlPath) + " __agent-launch " + shellQuote(agent) + " \"$@\"\n" +
		"fi\n" +
		"exec " + shellQuote(realBinary) + " \"$@\"\n"
	if err := writeAtomicFile(shimPath, []byte(body), 0o755); err != nil {
		return fmt.Errorf("install agent launcher: %w", err)
	}
	return nil
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

func replaceSymlink(path, target string) error {
	_ = os.Remove(path)
	return os.Symlink(target, path)
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}

func writeAtomicFile(path string, data []byte, mode os.FileMode) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".pocketctl-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpPath, path)
}

func ensureLauncherPath(home, binDir, shell string) error {
	if !supportedLauncherShell(shell) {
		return ErrUnsupportedShell
	}
	type profileUpdate struct {
		path string
		data []byte
		mode os.FileMode
	}
	updates := make([]profileUpdate, 0, 3)
	block := launcherBlockStart + "\n" + `[ -f "$HOME/.pocketctl/shell/path.sh" ] && . "$HOME/.pocketctl/shell/path.sh"` + "\n" + launcherBlockEnd + "\n"
	for _, profile := range launcherProfiles(home) {
		data, readErr := os.ReadFile(profile)
		if readErr != nil && !errors.Is(readErr, os.ErrNotExist) {
			return readErr
		}
		clean, err := removeManagedBlock(string(data))
		if err != nil {
			return err
		}
		if clean != "" && !strings.HasSuffix(clean, "\n") {
			clean += "\n"
		}
		mode := os.FileMode(0o600)
		if info, statErr := os.Stat(profile); statErr == nil {
			mode = info.Mode().Perm()
		}
		updates = append(updates, profileUpdate{path: profile, data: []byte(clean + block), mode: mode})
	}
	pathDir := filepath.Join(home, ".pocketctl", "shell")
	if err := os.MkdirAll(pathDir, 0o700); err != nil {
		return err
	}
	pathBody := "case \"$PATH\" in\n" +
		`  "$HOME/.pocketctl/bin"|"$HOME/.pocketctl/bin":*) ;;` + "\n" +
		`  *) export PATH="$HOME/.pocketctl/bin:$PATH" ;;` + "\n" +
		"esac\n"
	if err := writeAtomicFile(filepath.Join(pathDir, "path.sh"), []byte(pathBody), 0o600); err != nil {
		return err
	}
	for _, update := range updates {
		if err := writeAtomicFile(update.path, update.data, update.mode); err != nil {
			return fmt.Errorf("update shell profile: %w", err)
		}
	}
	_ = binDir
	return nil
}

func removeLauncherPath(home, _ string, shell string) error {
	if !supportedLauncherShell(shell) {
		return nil
	}
	for _, profile := range launcherProfiles(home) {
		data, err := os.ReadFile(profile)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		clean, err := removeManagedBlock(string(data))
		if err != nil {
			return err
		}
		mode := os.FileMode(0o600)
		if info, statErr := os.Stat(profile); statErr == nil {
			mode = info.Mode().Perm()
		}
		if err := writeAtomicFile(profile, []byte(clean), mode); err != nil {
			return err
		}
	}
	pathFile := filepath.Join(home, ".pocketctl", "shell", "path.sh")
	if err := os.Remove(pathFile); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func supportedLauncherShell(shell string) bool {
	base := filepath.Base(shell)
	return base == "zsh" || base == "bash"
}

func launcherProfiles(home string) []string {
	return []string{
		filepath.Join(home, ".zshrc"),
		filepath.Join(home, ".bash_profile"),
		filepath.Join(home, ".bashrc"),
	}
}

func shellProfile(home, shell string) (string, error) {
	switch filepath.Base(shell) {
	case "zsh":
		return filepath.Join(home, ".zshrc"), nil
	case "bash":
		return filepath.Join(home, ".bashrc"), nil
	default:
		return "", ErrUnsupportedShell
	}
}

func removeManagedBlock(content string) (string, error) {
	for {
		start := strings.Index(content, launcherBlockStart)
		if start < 0 {
			return content, nil
		}
		endRel := strings.Index(content[start:], launcherBlockEnd)
		if endRel < 0 {
			return content, ErrMalformedProfileBlock
		}
		end := start + endRel + len(launcherBlockEnd)
		if end < len(content) && content[end] == '\n' {
			end++
		}
		content = content[:start] + content[end:]
	}
}
