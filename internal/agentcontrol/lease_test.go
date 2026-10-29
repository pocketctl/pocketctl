package agentcontrol

import (
	"errors"
	"fmt"
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

func TestLeaseRegistryNativeIdentitySurvivesClockDriftButRejectsPIDReuse(t *testing.T) {
	processes := &fakeProcessIdentities{values: map[int]int64{11: 1100, 22: 2200}}
	births := map[int]string{11: "linux:111", 22: "linux:222"}
	registry := newLeaseRegistry(processes.identity)
	registry.nativeIdentity = func(pid int) (string, error) { return births[pid], nil }
	if err := registry.Register(Lease{ID: "terminal", PID: 11, Generation: 4}); err != nil {
		t.Fatal(err)
	}
	processes.values[11] = 2100
	if got := registry.Active(4); len(got) != 1 {
		t.Fatal("clock drift pruned a live lease")
	}
	if err := registry.Bind("terminal", 22); err != nil {
		t.Fatal(err)
	}
	snapshot := registry.Snapshot()
	if got := snapshot["terminal"]; got.PID != 22 || got.ProcessStartIdentity != "linux:222" {
		t.Fatalf("bound lease=%+v", got)
	}
	// A new process can share the same coarse legacy timestamp but never the
	// native birth token; it must not inherit the terminal lease.
	births[22] = "linux:223"
	if got := registry.Active(4); len(got) != 0 {
		t.Fatalf("reused PID kept lease=%+v", got)
	}
	restored := newLeaseRegistry(processes.identity)
	restored.nativeIdentity = registry.nativeIdentity
	restored.Restore(snapshot)
	if got := restored.Active(4); len(got) != 0 {
		t.Fatalf("reused PID restored lease=%+v", got)
	}
}

func TestLeaseRegistryUpgradesOnlyVerifiedLegacyHandoffs(t *testing.T) {
	processes := &fakeProcessIdentities{values: map[int]int64{11: 1100, 22: 2200}}
	registry := newLeaseRegistry(processes.identity)
	registry.nativeIdentity = func(pid int) (string, error) { return fmt.Sprintf("linux:%d", pid), nil }
	registry.Restore(map[string]Lease{
		"live":  {ID: "live", PID: 11, ProcessStart: 1100, Generation: 4},
		"stale": {ID: "stale", PID: 22, ProcessStart: 2199, Generation: 4},
	})
	snapshot := registry.Snapshot()
	if len(snapshot) != 1 || snapshot["live"].ProcessStartIdentity != "linux:11" {
		t.Fatalf("upgraded leases=%+v", snapshot)
	}
	processes.values[11] = 2100
	if got := registry.Active(4); len(got) != 1 {
		t.Fatal("verified legacy lease was not upgraded")
	}
}

func TestLeaseRegistryRejectsIdentityChangeDuringRegistration(t *testing.T) {
	for _, operation := range []string{"register", "bind"} {
		t.Run(operation, func(t *testing.T) {
			processes := &fakeProcessIdentities{values: map[int]int64{11: 1100, 22: 2200}}
			registry := newLeaseRegistry(processes.identity)
			if err := registry.Register(Lease{ID: "terminal", PID: 11, Generation: 4}); err != nil {
				t.Fatal(err)
			}
			calls := 0
			registry.nativeIdentity = func(int) (string, error) { calls++; return fmt.Sprint(calls), nil }
			var err error
			if operation == "register" {
				err = registry.Register(Lease{ID: "new", PID: 22, Generation: 4})
			} else {
				err = registry.Bind("terminal", 22)
			}
			if err == nil {
				t.Fatal("accepted PID reuse during identity query")
			}
			// Inspect the stored lease without triggering another identity query.
			if len(registry.leases) != 1 || registry.leases["terminal"].PID != 11 {
				t.Fatalf("failed operation changed leases=%+v", registry.leases)
			}
		})
	}
}
