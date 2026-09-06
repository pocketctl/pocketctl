package agentcontrol

import (
	"errors"
	"testing"
	"time"
)

type fakeProcessIdentities struct {
	values map[int]int64
}

func (f *fakeProcessIdentities) identity(pid int) (int64, error) {
	value, ok := f.values[pid]
	if !ok {
		return 0, errors.New("process not found")
	}
	return value, nil
}

func TestLeaseRegistryTracksBindReleaseAndPIDReuse(t *testing.T) {
	processes := &fakeProcessIdentities{values: map[int]int64{101: 1001, 202: 2002}}
	registry := newLeaseRegistry(processes.identity)
	created := time.Now().UTC().Truncate(time.Millisecond)
	if err := registry.Register(Lease{ID: "lease-1", Agent: AgentOpenCode, SessionID: "ses_1", PID: 101, Generation: 7, CreatedAt: created}); err != nil {
		t.Fatal(err)
	}
	if got := registry.Active(7); len(got) != 1 || got[0].ProcessStart != 1001 || got[0].SessionID != "ses_1" {
		t.Fatalf("active after register=%+v", got)
	}
	if err := registry.Bind("lease-1", 202); err != nil {
		t.Fatal(err)
	}
	if got := registry.Active(7); len(got) != 1 || got[0].PID != 202 || got[0].ProcessStart != 2002 {
		t.Fatalf("active after bind=%+v", got)
	}

	// The PID still exists but now belongs to another process. It must not keep
	// the runtime alive after a PID reuse.
	processes.values[202] = 2999
	if got := registry.Active(7); len(got) != 0 {
		t.Fatalf("reused PID kept lease active: %+v", got)
	}
	if got := registry.Snapshot(); len(got) != 0 {
		t.Fatalf("stale lease survived pruning: %+v", got)
	}

	processes.values[303] = 3003
	if err := registry.Register(Lease{ID: "lease-2", Agent: AgentOpenCode, PID: 303, Generation: 8}); err != nil {
		t.Fatal(err)
	}
	registry.Release("lease-2")
	if got := registry.Active(8); len(got) != 0 {
		t.Fatalf("released lease active: %+v", got)
	}
}

func TestLeaseRegistryRestoreRejectsDeadOrReusedProcesses(t *testing.T) {
	processes := &fakeProcessIdentities{values: map[int]int64{11: 111, 22: 999}}
	registry := newLeaseRegistry(processes.identity)
	registry.Restore(map[string]Lease{
		"live":   {ID: "live", PID: 11, ProcessStart: 111, Generation: 4},
		"dead":   {ID: "dead", PID: 33, ProcessStart: 333, Generation: 4},
		"reused": {ID: "reused", PID: 22, ProcessStart: 222, Generation: 4},
	})
	got := registry.Active(4)
	if len(got) != 1 || got[0].ID != "live" {
		t.Fatalf("restored active leases=%+v", got)
	}
}

func TestLeaseRegistryPruneReportsOnlyActualRemovals(t *testing.T) {
	processes := &fakeProcessIdentities{values: map[int]int64{41: 4100}}
	registry := newLeaseRegistry(processes.identity)
	if err := registry.Register(Lease{ID: "lease-live", Agent: AgentOpenCode, PID: 41, Generation: 3}); err != nil {
		t.Fatal(err)
	}
	if registry.Prune() {
		t.Fatal("live lease reported a removal")
	}
	delete(processes.values, 41)
	if !registry.Prune() {
		t.Fatal("dead lease removal was not reported")
	}
	removed := registry.DrainPruned()
	if len(removed) != 1 || removed[0].ID != "lease-live" {
		t.Fatalf("removed leases=%+v, want lease-live", removed)
	}
	if again := registry.DrainPruned(); len(again) != 0 {
		t.Fatalf("pruned leases were reported twice: %+v", again)
	}
	if registry.Prune() {
		t.Fatal("empty registry repeatedly reported a removal")
	}
}
