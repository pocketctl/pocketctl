//go:build !windows

package daemon

import (
	"os"
	"path/filepath"
	"testing"
)

func TestValidateLegacyRuntimeDirAcceptsOwnedNonWritableDirectory(t *testing.T) {
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := validateLegacyRuntimeDir(dir); err != nil {
		t.Fatalf("validateLegacyRuntimeDir rejected a safe legacy dir: %v", err)
	}
}

func TestValidateLegacyRuntimeDirRejectsSymlinkAndWritableDirectory(t *testing.T) {
	t.Run("symlink", func(t *testing.T) {
		base := t.TempDir()
		target := filepath.Join(base, "target")
		if err := os.Mkdir(target, 0o700); err != nil {
			t.Fatal(err)
		}
		link := filepath.Join(base, "legacy")
		if err := os.Symlink(target, link); err != nil {
			t.Fatal(err)
		}
		if err := validateLegacyRuntimeDir(link); err == nil {
			t.Fatal("validateLegacyRuntimeDir accepted a symlink")
		}
	})

	t.Run("group-writable", func(t *testing.T) {
		dir := t.TempDir()
		if err := os.Chmod(dir, 0o770); err != nil {
			t.Fatal(err)
		}
		if err := validateLegacyRuntimeDir(dir); err == nil {
			t.Fatal("validateLegacyRuntimeDir accepted a group-writable directory")
		}
	})
}
