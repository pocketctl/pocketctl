//go:build !windows

package agentcontrol

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func installPlatformShim(shimPath, pocketctlPath, _ string) error {
	if _, err := os.Lstat(shimPath); err == nil {
		if sameFilePath(shimPath, pocketctlPath) {
			return nil
		}
		return ErrForeignShim
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.Symlink(pocketctlPath, shimPath); err != nil {
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
	if !sameFilePath(shimPath, pocketctlPath) {
		return ErrForeignShim
	}
	return os.Remove(shimPath)
}

func sameFilePath(left, right string) bool {
	leftInfo, leftErr := os.Stat(left)
	rightInfo, rightErr := os.Stat(right)
	return leftErr == nil && rightErr == nil && os.SameFile(leftInfo, rightInfo)
}

func ensureLauncherPath(home, binDir, shell string) error {
	profile, err := shellProfile(home, shell)
	if err != nil {
		return err
	}
	data, readErr := os.ReadFile(profile)
	if readErr != nil && !errors.Is(readErr, os.ErrNotExist) {
		return readErr
	}
	clean, err := removeManagedBlock(string(data))
	if err != nil {
		return err
	}
	block := launcherBlockStart + "\n" + `export PATH="$HOME/.pocketctl/bin:$PATH"` + "\n" + launcherBlockEnd + "\n"
	if clean != "" && !strings.HasSuffix(clean, "\n") {
		clean += "\n"
	}
	if err := os.WriteFile(profile, []byte(clean+block), 0o600); err != nil {
		return fmt.Errorf("update shell profile: %w", err)
	}
	_ = binDir
	return nil
}

func removeLauncherPath(home, _ string, shell string) error {
	profile, err := shellProfile(home, shell)
	if err != nil {
		if errors.Is(err, ErrUnsupportedShell) {
			return nil
		}
		return err
	}
	data, err := os.ReadFile(profile)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	clean, err := removeManagedBlock(string(data))
	if err != nil {
		return err
	}
	return os.WriteFile(profile, []byte(clean), 0o600)
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
