package agentcontrol

import (
	"fmt"
	"sort"
	"sync"
	"time"

	gopsprocess "github.com/shirou/gopsutil/v3/process"
)

// Lease identifies one terminal process attached to a managed agent runtime.
// ProcessStart is the OS-reported creation time in milliseconds since epoch;
// pairing it with PID prevents a recycled PID from keeping a runtime alive.
type Lease struct {
	ID           string    `json:"id"`
	Agent        string    `json:"agent"`
	SessionID    string    `json:"session_id,omitempty"`
	PID          int       `json:"pid"`
	ProcessStart int64     `json:"process_start"`
	Generation   uint64    `json:"generation"`
	CreatedAt    time.Time `json:"created_at"`
	LastSeen     time.Time `json:"last_seen"`
}

type processIdentityFunc func(pid int) (int64, error)

// LeaseRegistry is safe for concurrent acquire/bind/release and snapshot use.
// Stale processes are pruned whenever active leases or a snapshot is requested.
type LeaseRegistry struct {
	mu       sync.Mutex
	leases   map[string]Lease
	pruned   []Lease
	identity processIdentityFunc
	now      func() time.Time
}

func NewLeaseRegistry() *LeaseRegistry {
	return newLeaseRegistry(processStartIdentity)
}

func newLeaseRegistry(identity processIdentityFunc) *LeaseRegistry {
	return &LeaseRegistry{leases: make(map[string]Lease), identity: identity, now: time.Now}
}

func processStartIdentity(pid int) (int64, error) {
	if pid <= 0 {
		return 0, fmt.Errorf("invalid process pid %d", pid)
	}
	process, err := gopsprocess.NewProcess(int32(pid))
	if err != nil {
		return 0, err
	}
	return process.CreateTime()
}

func (r *LeaseRegistry) Register(lease Lease) error {
	if lease.ID == "" || lease.PID <= 0 || lease.Generation == 0 {
		return fmt.Errorf("invalid runtime lease")
	}
	identity, err := r.identity(lease.PID)
	if err != nil {
		return fmt.Errorf("identify lease process %d: %w", lease.PID, err)
	}
	now := r.now().UTC()
	if lease.CreatedAt.IsZero() {
		lease.CreatedAt = now
	}
	lease.ProcessStart = identity
	lease.LastSeen = now
	r.mu.Lock()
	r.leases[lease.ID] = lease
	r.mu.Unlock()
	return nil
}

func (r *LeaseRegistry) Bind(id string, pid int) error {
	identity, err := r.identity(pid)
	if err != nil {
		return fmt.Errorf("identify bound lease process %d: %w", pid, err)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	lease, ok := r.leases[id]
	if !ok {
		return fmt.Errorf("runtime lease %q not found", id)
	}
	lease.PID = pid
	lease.ProcessStart = identity
	lease.LastSeen = r.now().UTC()
	r.leases[id] = lease
	return nil
}

func (r *LeaseRegistry) Release(id string) {
	r.mu.Lock()
	delete(r.leases, id)
	r.mu.Unlock()
}

// DrainPruned returns leases removed by liveness checks since the previous
// drain. Snapshot and Active also prune, so retaining these records lets the
// runtime owner publish terminal exits even when another reader pruned first.
func (r *LeaseRegistry) DrainPruned() []Lease {
	r.mu.Lock()
	defer r.mu.Unlock()
	removed := append([]Lease(nil), r.pruned...)
	r.pruned = nil
	return removed
}

// Prune removes leases whose process exited or whose PID was reused. It reports
// whether the registry changed so callers can avoid unnecessary persistence.
func (r *LeaseRegistry) Prune() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.pruneLocked()
}

func (r *LeaseRegistry) Active(generation uint64) []Lease {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.pruneLocked()
	active := make([]Lease, 0, len(r.leases))
	for _, lease := range r.leases {
		if generation == 0 || lease.Generation == generation {
			active = append(active, lease)
		}
	}
	sort.Slice(active, func(i, j int) bool { return active[i].ID < active[j].ID })
	return active
}

func (r *LeaseRegistry) Snapshot() map[string]Lease {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.pruneLocked()
	out := make(map[string]Lease, len(r.leases))
	for id, lease := range r.leases {
		out[id] = lease
	}
	return out
}

func (r *LeaseRegistry) Restore(snapshot map[string]Lease) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for id, lease := range snapshot {
		if lease.ID == "" {
			lease.ID = id
		}
		if lease.ID == id && lease.PID > 0 && lease.Generation > 0 {
			r.leases[id] = lease
		}
	}
	r.pruneLocked()
}

func (r *LeaseRegistry) pruneLocked() bool {
	now := r.now().UTC()
	changed := false
	for id, lease := range r.leases {
		identity, err := r.identity(lease.PID)
		if err != nil || identity != lease.ProcessStart {
			delete(r.leases, id)
			r.pruned = append(r.pruned, lease)
			changed = true
			continue
		}
		lease.LastSeen = now
		r.leases[id] = lease
	}
	return changed
}
