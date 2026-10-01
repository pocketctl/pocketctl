package agentcontrol

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// writeStandaloneRelease creates <codexHome>/packages/standalone/releases/<version>/bin/codex
// as an executable and returns the binary path.
func writeStandaloneRelease(t *testing.T, codexHome, version string) string {
	t.Helper()
	binDir := filepath.Join(codexHome, "packages", "standalone", "releases", version, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(binDir, "codex")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return bin
}

// pointStandaloneCurrent symlinks <codexHome>/packages/standalone/current at
// releases/<version> and returns the alias binary path.
func pointStandaloneCurrent(t *testing.T, codexHome, version string) string {
	t.Helper()
	standalone := filepath.Join(codexHome, "packages", "standalone")
	current := filepath.Join(standalone, "current")
	if err := os.Symlink(filepath.Join(standalone, "releases", version), current); err != nil {
		t.Fatal(err)
	}
	return filepath.Join(current, "bin", "codex")
}

func TestNormalizeCodexStandaloneBinaryMapsReleaseToCurrent(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix symlink layout")
	}
	home := t.TempDir()
	// macOS exposes the temp root through /var -> /private/var; resolve it so
	// expectations match the canonical paths ResolveCodexHome returns.
	if resolved, err := filepath.EvalSymlinks(home); err == nil {
		home = resolved
	}
	t.Setenv("HOME", home)
	t.Setenv("CODEX_HOME", "")
	codexHome := filepath.Join(home, ".codex")

	release := writeStandaloneRelease(t, codexHome, "0.155.1-aarch64-apple-darwin")
	writeStandaloneRelease(t, codexHome, "0.159.2-aarch64-apple-darwin")
	alias := pointStandaloneCurrent(t, codexHome, "0.159.2-aarch64-apple-darwin")

	if got := normalizeCodexStandaloneBinary(release); got != alias {
		t.Fatalf("got %q, want alias %q", got, alias)
	}
}

func TestNormalizeCodexStandaloneBinaryNoopWithoutCurrent(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix symlink layout")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CODEX_HOME", "")
	codexHome := filepath.Join(home, ".codex")

	release := writeStandaloneRelease(t, codexHome, "0.155.1-aarch64-apple-darwin")
	if got := normalizeCodexStandaloneBinary(release); got != release {
		t.Fatalf("got %q, want unchanged %q", got, release)
	}
}

func TestNormalizeCodexStandaloneBinaryNoopWhenCurrentInvalid(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix symlink layout")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CODEX_HOME", "")
	codexHome := filepath.Join(home, ".codex")

	release := writeStandaloneRelease(t, codexHome, "0.155.1-aarch64-apple-darwin")
	// current/bin/codex exists but is not executable — alias must be rejected.
	binDir := filepath.Join(codexHome, "packages", "standalone", "current", "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(binDir, "codex"), []byte("data"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := normalizeCodexStandaloneBinary(release); got != release {
		t.Fatalf("got %q, want unchanged %q", got, release)
	}
}

func TestNormalizeCodexStandaloneBinaryNoopForForeignLayouts(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CODEX_HOME", "")
	codexHome := filepath.Join(home, ".codex")

	writeStandaloneRelease(t, codexHome, "0.155.1-aarch64-apple-darwin")
	writeStandaloneRelease(t, codexHome, "0.159.2-aarch64-apple-darwin")
	pointStandaloneCurrent(t, codexHome, "0.159.2-aarch64-apple-darwin")

	cases := []string{
		"", // empty stays empty
		filepath.Join(home, ".local", "bin", "codex"),
		filepath.Join("/opt", "homebrew", "bin", "codex"),
		// A helper binary inside the release must not be remapped.
		filepath.Join(codexHome, "packages", "standalone", "releases", "0.155.1-aarch64-apple-darwin", "bin", "codex-helper"),
		// The release bin directory itself is not a binary.
		filepath.Join(codexHome, "packages", "standalone", "releases", "0.155.1-aarch64-apple-darwin", "bin"),
	}
	for _, in := range cases {
		if got := normalizeCodexStandaloneBinary(in); got != in {
			t.Fatalf("input %q remapped to %q, want unchanged", in, got)
		}
	}
}

func TestNormalizeCodexStandaloneBinaryHonorsCodexHome(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix symlink layout")
	}
	home := t.TempDir()
	// macOS exposes the temp root through /var -> /private/var; resolve it so
	// expectations match the canonical paths ResolveCodexHome returns.
	if resolved, err := filepath.EvalSymlinks(home); err == nil {
		home = resolved
	}
	t.Setenv("HOME", home)
	custom := filepath.Join(home, "codex-root")
	t.Setenv("CODEX_HOME", custom)

	release := writeStandaloneRelease(t, custom, "0.155.1-aarch64-apple-darwin")
	alias := pointStandaloneCurrent(t, custom, "0.155.1-aarch64-apple-darwin")

	if got := normalizeCodexStandaloneBinary(release); got != alias {
		t.Fatalf("got %q, want alias %q", got, alias)
	}
}
