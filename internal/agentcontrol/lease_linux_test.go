//go:build linux

package agentcontrol

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestLeaseRegistryIgnoresLinuxUptimeDrift(t *testing.T) {
	// gopsutil estimates boot time from wall time minus uptime. Keep the
	// process stat unchanged while moving that estimate across a second.
	root := t.TempDir()
	pid := os.Getpid()
	processDir := filepath.Join(root, fmt.Sprint(pid))
	if err := os.Mkdir(processDir, 0700); err != nil {
		t.Fatal(err)
	}
	stat, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		t.Fatal(err)
	}
	for name, data := range map[string][]byte{
		filepath.Join(processDir, "stat"): stat,
		filepath.Join(root, "stat"):       []byte("btime 1000000000\n"),
		filepath.Join(root, "uptime"):     []byte("1000.00 1000.00\n"),
	} {
		if err := os.WriteFile(name, data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("HOST_PROC", root)
	registry := NewLeaseRegistry()
	if err := registry.Register(Lease{ID: "live", Agent: AgentCodex, PID: pid, Generation: 1}); err != nil {
		t.Fatal(err)
	}
	snapshot := registry.Snapshot()
	if len(snapshot) != 1 {
		t.Fatal("lease missing before uptime drift")
	}
	if err := os.WriteFile(filepath.Join(root, "uptime"), []byte("1002.00 1002.00\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if got := registry.Active(1); len(got) != 1 {
		t.Fatal("live process pruned after uptime drift")
	}
	encoded, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]Lease
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	restored := NewLeaseRegistry()
	restored.Restore(decoded)
	if got := restored.Active(1); len(got) != 1 {
		t.Fatal("live process lost on handoff after uptime drift")
	}
}
