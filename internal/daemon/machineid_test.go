package daemon

import (
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

func TestMachineIDCreatesAndReusesRandomPersistentIdentity(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	first := MachineID()
	if !regexp.MustCompile(`^machine-[a-f0-9]{32}$`).MatchString(first) {
		t.Fatalf("MachineID() = %q, want machine-<32 lowercase hex>", first)
	}
	if second := MachineID(); second != first {
		t.Fatalf("MachineID() changed from %q to %q", first, second)
	}
	info, err := os.Stat(machineIDCachePath())
	if err != nil {
		t.Fatalf("stat machine id cache: %v", err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("machine id cache permissions = %o, want 0600", info.Mode().Perm())
	}
}

func TestMachineIDRetainsLegacyCachedIdentity(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if err := os.MkdirAll(filepath.Dir(machineIDCachePath()), 0700); err != nil {
		t.Fatalf("create pocketctl directory: %v", err)
	}
	if err := os.WriteFile(machineIDCachePath(), []byte("daemon-1234abcd\n"), 0600); err != nil {
		t.Fatalf("write legacy machine id: %v", err)
	}
	if got := MachineID(); got != "daemon-1234abcd" {
		t.Fatalf("MachineID() = %q, want legacy cached ID", got)
	}
}
