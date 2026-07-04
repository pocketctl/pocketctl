package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// SaveAuth must be robust enough that a refresh-rotation never silently fails
// to persist the new refresh token. The m3-pro incident was caused by SaveAuth
// failing (or not executing) after a successful refresh: the relay had already
// rotated the old refresh token, but the daemon kept using it → reuse → breach
// → the host permanently parked. These tests pin the durability contract.

func TestSaveAuthCreatesConfigDirIfMissing(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	// ~/.pocketctl does NOT exist yet — SaveAuth must create it, not fail.
	if err := SaveAuth("wss://relay/ws", "acc-1", "ref-1"); err != nil {
		t.Fatalf("SaveAuth failed when config dir missing: %v", err)
	}
	if _, err := os.Stat(filepath.Join(tmp, ".pocketctl", "auth.json")); err != nil {
		t.Errorf("auth.json not written: %v", err)
	}
}

func TestSaveAuthPersistsTokensAndPreservesProdRelayURL(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	os.MkdirAll(filepath.Join(tmp, ".pocketctl"), 0o700)
	os.WriteFile(filepath.Join(tmp, ".pocketctl", "auth.json"),
		[]byte(`{"prod_relay_url":"wss://prod.example/ws"}`), 0o600)

	if err := SaveAuth("wss://relay/ws", "acc-1", "ref-1"); err != nil {
		t.Fatalf("SaveAuth: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(tmp, ".pocketctl", "auth.json"))
	if err != nil {
		t.Fatal(err)
	}
	var d authFile
	if err := json.Unmarshal(raw, &d); err != nil {
		t.Fatal(err)
	}
	if d.AccessToken != "acc-1" || d.RefreshToken != "ref-1" {
		t.Errorf("tokens = {access:%q refresh:%q}, want acc-1/ref-1", d.AccessToken, d.RefreshToken)
	}
	if d.ProdRelayURL != "wss://prod.example/ws" {
		t.Errorf("prod_relay_url not preserved = %q", d.ProdRelayURL)
	}
}

func TestSaveAuthLeavesNoTempResidue(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	if err := SaveAuth("wss://r", "a", "r"); err != nil {
		t.Fatalf("SaveAuth: %v", err)
	}
	// Atomic write = write to temp + rename; the temp file must not survive.
	if _, err := os.Stat(filepath.Join(tmp, ".pocketctl", "auth.json.tmp")); err == nil {
		t.Error("auth.json.tmp left behind — SaveAuth must rename atomically")
	}
}
