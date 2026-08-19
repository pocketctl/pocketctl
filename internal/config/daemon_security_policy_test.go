package config

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestDaemonSecurityPolicyRoundTripIsPrivateAndAtomic(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	root := filepath.Join(home, "workspace")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	want := DaemonSecurityPolicy{
		AllowedCwdRoots:                 []string{root},
		AllowDangerousRemotePermissions: true,
		TrustedActionPolicy:             "on",
	}

	if err := SaveDaemonSecurityPolicy(want); err != nil {
		t.Fatalf("SaveDaemonSecurityPolicy: %v", err)
	}
	got, err := LoadDaemonSecurityPolicy()
	if err != nil {
		t.Fatalf("LoadDaemonSecurityPolicy: %v", err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("policy=%+v want %+v", got, want)
	}

	path, err := DaemonSecurityPolicyPath()
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if gotMode := info.Mode().Perm(); gotMode != 0o600 {
		t.Fatalf("policy mode=%#o want 0600", gotMode)
	}
	residue, err := filepath.Glob(filepath.Join(filepath.Dir(path), ".daemon-security-policy-*.tmp"))
	if err != nil {
		t.Fatal(err)
	}
	if len(residue) != 0 {
		t.Fatalf("temporary policy files remain: %v", residue)
	}
}

func TestLoadDaemonSecurityPolicyRejectsUntrustedShape(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	path, err := DaemonSecurityPolicyPath()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"version":1,"allowed_cwd_roots":["relative/path"],"allow_dangerous_remote_permissions":true,"trusted_action_policy":"off"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadDaemonSecurityPolicy(); err == nil {
		t.Fatal("relative cwd root in persisted policy was accepted")
	}

	if err := os.WriteFile(path, []byte(`{"version":1,"allowed_cwd_roots":[],"allow_dangerous_remote_permissions":false,"trusted_action_policy":"off","unexpected":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadDaemonSecurityPolicy(); err == nil {
		t.Fatal("unknown persisted policy field was accepted")
	}

	if err := os.WriteFile(path, []byte(`{"version":1,"allowed_cwd_roots":[],"allow_dangerous_remote_permissions":false,"trusted_action_policy":"sometimes"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadDaemonSecurityPolicy(); err == nil {
		t.Fatal("unknown trusted action policy was accepted")
	}
}
