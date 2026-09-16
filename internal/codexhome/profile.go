package codexhome

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const idPrefix = "codex-home-"

func Resolve(path, userHome string) (string, error) {
	path = strings.TrimSpace(path)
	userHome = strings.TrimSpace(userHome)
	if path == "" {
		if userHome == "" {
			return "", fmt.Errorf("Codex home cannot be resolved without HOME")
		}
		path = filepath.Join(userHome, ".codex")
	} else if path == "~" || strings.HasPrefix(path, "~/") || strings.HasPrefix(path, `~\`) {
		if userHome == "" {
			return "", fmt.Errorf("Codex home %q cannot be expanded without HOME", path)
		}
		if path == "~" {
			path = userHome
		} else {
			path = filepath.Join(userHome, path[2:])
		}
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	abs = filepath.Clean(abs)
	if resolved, err := filepath.EvalSymlinks(abs); err == nil {
		abs = filepath.Clean(resolved)
	}
	return abs, nil
}

func ID(resolvedHome string) string {
	sum := sha256.Sum256([]byte(filepath.Clean(resolvedHome)))
	return idPrefix + hex.EncodeToString(sum[:12])
}

func IDFromEnvironment(env []string) (string, error) {
	values := make(map[string]string, 2)
	for _, item := range env {
		if index := strings.IndexByte(item, '='); index >= 0 {
			key := item[:index]
			if key == "HOME" || key == "CODEX_HOME" {
				values[key] = item[index+1:]
			}
		}
	}
	userHome := values["HOME"]
	if userHome == "" {
		userHome, _ = os.UserHomeDir()
	}
	resolved, err := Resolve(values["CODEX_HOME"], userHome)
	if err != nil {
		return "", err
	}
	return ID(resolved), nil
}
