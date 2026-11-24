package discovery

import (
	"context"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// CodexNPMPrefix queries the npm executable used by the upgrade. Do not use the
// inventory's cached prefix when deciding which directories may be repaired.
func CodexNPMPrefix(parent context.Context) (string, error) {
	ctx, cancel := context.WithTimeout(parent, 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "npm", "prefix", "-g").Output()
	if err != nil {
		return "", fmt.Errorf("resolve npm global prefix: %w", err)
	}
	prefix := strings.TrimSpace(string(out))
	if !filepath.IsAbs(prefix) {
		return "", fmt.Errorf("invalid npm global prefix %q", prefix)
	}
	return filepath.Clean(prefix), nil
}

// npm's Arborist retire-path hashes the absolute package path. A glob would
// also match administrator-retained packages that still serve live processes.
func npmRetiredPackage(dir string) string {
	sum := sha1.Sum([]byte(dir))
	hash := strings.NewReplacer("+", "", "/", "").Replace(base64.RawStdEncoding.EncodeToString(sum[:]))
	return filepath.Join(filepath.Dir(dir), "."+filepath.Base(dir)+"-"+hash[:min(8, len(hash))])
}

// RecoverCodexNPM handles the Unix global npm layout. It only takes over when
// npm left its exact retirement directory and the canonical package is incomplete.
func RecoverCodexNPM(prefix string) (bool, error) {
	dir := filepath.Join(prefix, "lib", "node_modules", "@openai", "codex")
	// Arborist resolves the installation root before hashing (for example
	// /var and /private/var on macOS). The package itself may be missing.
	scope, err := filepath.EvalSymlinks(filepath.Dir(dir))
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	old := npmRetiredPackage(filepath.Join(scope, "codex"))
	stat, err := os.Lstat(old)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !stat.IsDir() || !fileOwnedByCurrentUser(old) || !fileOwnedByCurrentUser(filepath.Dir(dir)) {
		return false, fmt.Errorf("cannot verify ownership of npm retirement directory %s", old)
	}
	currentInfo, err := os.Lstat(dir)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	if currentInfo != nil && (!currentInfo.IsDir() || !fileOwnedByCurrentUser(dir)) {
		return false, fmt.Errorf("unexpected Codex package path %s", dir)
	}
	if data, err := os.ReadFile(filepath.Join(dir, "package.json")); err == nil {
		var current struct{ Name string }
		if json.Unmarshal(data, &current) != nil || current.Name != "@openai/codex" {
			return false, fmt.Errorf("cannot identify incomplete package at %s", dir)
		}
		if _, err := verifiedCodexPackageVersion(dir); err == nil {
			return false, fmt.Errorf("current Codex works but npm retirement directory is occupied; inspect %s before retrying", old)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	if _, err := verifiedCodexPackageVersion(old); err != nil {
		return false, err
	}
	link := filepath.Join(prefix, "bin", "codex")
	target := filepath.Join(dir, "bin", "codex.js")
	dest, err := os.Readlink(link)
	missingLink := errors.Is(err, os.ErrNotExist)
	if !missingLink {
		if err != nil {
			return false, fmt.Errorf("cannot verify npm launcher %s: %w", link, err)
		}
		if !filepath.IsAbs(dest) {
			dest = filepath.Join(filepath.Dir(link), dest)
		}
		if filepath.Clean(dest) != target {
			return false, fmt.Errorf("unexpected npm launcher target %s", dest)
		}
	}
	// Install a missing link before moving the partial package, so a failed
	// link creation leaves both package directories in their original places.
	if missingLink {
		if err := os.Symlink(target, link); err != nil {
			return false, fmt.Errorf("restore Codex launcher: %w", err)
		}
	}
	var partial string
	if currentInfo != nil {
		holder, err := os.MkdirTemp(filepath.Dir(dir), ".pocketctl-codex-partial-")
		if err != nil {
			return false, err
		}
		partial = filepath.Join(holder, "codex")
		if err := os.Rename(dir, partial); err != nil {
			_ = os.Remove(holder)
			return false, err
		}
	}
	if err := os.Rename(old, dir); err != nil {
		if partial != "" {
			if _, statErr := os.Lstat(dir); errors.Is(statErr, os.ErrNotExist) {
				if undoErr := os.Rename(partial, dir); undoErr != nil {
					return false, errors.Join(err, undoErr)
				}
				_ = os.Remove(filepath.Dir(partial))
			}
		}
		return false, fmt.Errorf("restore Codex package from %s: %w", old, err)
	}
	return true, nil
}

// VerifyCodexNPMTarget prevents a global npm install from updating a different
// Codex than the one the daemon actually discovered.
func VerifyCodexNPMTarget(prefix, path string) error {
	bin := filepath.Join(prefix, "lib", "node_modules", "@openai", "codex", "bin", "codex.js")
	active, err := os.Stat(path)
	if err != nil {
		return err
	}
	target, err := os.Stat(bin)
	if err != nil || !os.SameFile(active, target) {
		return fmt.Errorf("active Codex %s does not match npm package %s", path, bin)
	}
	return nil
}

func VerifyCodexNPMVersion(prefix, path string) (string, error) {
	if err := VerifyCodexNPMTarget(prefix, path); err != nil {
		return "", err
	}
	dir := filepath.Join(prefix, "lib", "node_modules", "@openai", "codex")
	return verifiedCodexPackageVersion(dir)
}

func verifiedCodexPackageVersion(dir string) (string, error) {
	var manifest struct{ Name, Version string }
	data, err := os.ReadFile(filepath.Join(dir, "package.json"))
	if err != nil {
		return "", err
	}
	if json.Unmarshal(data, &manifest) != nil || manifest.Name != "@openai/codex" || manifest.Version == "" {
		return "", fmt.Errorf("invalid Codex manifest in %s", dir)
	}
	binary := filepath.Join(dir, "bin", "codex.js")
	real, err := filepath.EvalSymlinks(binary)
	realDir, dirErr := filepath.EvalSymlinks(dir)
	if err != nil || dirErr != nil || real != filepath.Join(realDir, "bin", "codex.js") || !fileOwnedByCurrentUser(binary) || detectVersion(binary) != manifest.Version {
		return "", fmt.Errorf("Codex CLI in %s failed version verification", dir)
	}
	return manifest.Version, nil
}
