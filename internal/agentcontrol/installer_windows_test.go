//go:build windows

package agentcontrol

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestOpenCodeInstallerWindowsWrapperRoundTrip(t *testing.T) {
	dir := t.TempDir()
	shim := filepath.Join(dir, "opencode.cmd")
	pocketctl := filepath.Join(dir, "Pocketctl Program", "pocketctl.exe")

	if err := installPlatformShim(shim, pocketctl); err != nil {
		t.Fatal(err)
	}
	want := windowsShimMarker + "\r\n@\"" + pocketctl + "\" __agent-launch opencode %*\r\n"
	data, err := os.ReadFile(shim)
	if err != nil || string(data) != want {
		t.Fatalf("wrapper=%q err=%v, want %q", data, err, want)
	}
	if err := installPlatformShim(shim, pocketctl); err != nil {
		t.Fatalf("idempotent wrapper install: %v", err)
	}
	if err := removePlatformShim(shim, pocketctl); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(shim); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("wrapper remains after disable: %v", err)
	}
}

func TestOpenCodeInstallerWindowsWrapperRefusesForeignFile(t *testing.T) {
	shim := filepath.Join(t.TempDir(), "opencode.cmd")
	if err := os.WriteFile(shim, []byte("@echo foreign\r\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := installPlatformShim(shim, `C:\Pocketctl\pocketctl.exe`); !errors.Is(err, ErrForeignShim) {
		t.Fatalf("install error=%v, want ErrForeignShim", err)
	}
	if err := removePlatformShim(shim, `C:\Pocketctl\pocketctl.exe`); !errors.Is(err, ErrForeignShim) {
		t.Fatalf("remove error=%v, want ErrForeignShim", err)
	}
	data, err := os.ReadFile(shim)
	if err != nil || string(data) != "@echo foreign\r\n" {
		t.Fatalf("foreign wrapper changed: %q err=%v", data, err)
	}
}

func TestOpenCodeInstallerWindowsPathValueIsIdempotentAndReversible(t *testing.T) {
	original := `C:\Windows;C:\Tools`
	binDir := `C:\Users\Alice\.pocketctl\bin`
	added, changed := addWindowsPathEntry(original, binDir)
	if !changed || added != original+";"+binDir {
		t.Fatalf("added=%q changed=%v", added, changed)
	}
	if repeated, changed := addWindowsPathEntry(added, strings.ToLower(binDir)); changed || repeated != added {
		t.Fatalf("case-insensitive duplicate changed PATH: %q changed=%v", repeated, changed)
	}
	if removed := removeWindowsPathEntry(added, strings.ToUpper(binDir)); removed != original {
		t.Fatalf("removed=%q, want %q", removed, original)
	}
}
