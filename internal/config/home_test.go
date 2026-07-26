package config

import (
	"path/filepath"
	"testing"
)

func TestHomeDirPrefersHOME(t *testing.T) {
	homeA := filepath.Join(t.TempDir(), "home-a")
	homeB := filepath.Join(t.TempDir(), "home-b")

	t.Setenv("HOME", homeA)
	t.Setenv("USERPROFILE", homeB)

	got, err := HomeDir()
	if err != nil {
		t.Fatalf("HomeDir() error: %v", err)
	}
	if got != homeA {
		t.Fatalf("HomeDir() = %q, want %q", got, homeA)
	}
}
