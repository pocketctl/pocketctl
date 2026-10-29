package agentcontrol

import (
	"fmt"
	"sort"
	"sync"
	"time"

	"github.com/pocketctl/pocketctl/internal/platform"
	gopsprocess "github.com/shirou/gopsutil/v3/process"
)

// Lease identifies one terminal process attached to a managed agent runtime.
// ProcessStart preserves the legacy epoch-millisecond identity for older daemons.
// ProcessStartIdentity is the native birth token used by new daemons: unlike
// gopsutil's Linux epoch estimate it does not drift with wall time or uptime.
type Lease struct {
	ID                   string    `json:"id"`
	Agent                string    `json:"agent"`
	SessionID            string    `json:"session_id,omitempty"`
	PID                  int       `json:"pid"`
	ProcessStart         int64     `json:"process_start"`
	ProcessStartIdentity string    `json:"process_start_identity,omitempty"`
	Generation           uint64    `json:"generation"`
	CreatedAt            time.Time `json:"created_at"`
	LastSeen             time.Time `json:"last_seen"`
}

type processIdentityFunc func(pid int) (int64, error)

// LeaseRegistry is safe for concurrent acquire/bind/release and snapshot use.
// Stale processes are pruned whenever active leases or a snapshot is requested.
type LeaseRegistry struct {
	mu             sync.Mutex
	leases         map[string]Lease
	pruned         []Lease
	identity       processIdentityFunc
	nativeIdentity func(int) (string, error)
	now            func() time.Time
}

func NewLeaseRegistry() *LeaseRegistry {
	r := newLeaseRegistry(processStartIdentity)
	r.nativeIdentity = platform.ProcessStartIdentity
	return r
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

// identify samples the native identity around the legacy query so PID reuse
// cannot associate a legacy timestamp with a different process's birth token.
func (r *LeaseRegistry) identify(pid int) (int64, string, error) {
	var birth string
	if r.nativeIdentity != nil {
		var err error
		birth, err = r.nativeIdentity(pid)
		if err != nil {
			return 0, "", err
		}
		if birth == "" {
			return 0, "", fmt.Errorf("empty process identity for pid %d", pid)
		}
	}
	legacy, err := r.identity(pid)
	if err != nil {
		return 0, "", err
	}
	if r.nativeIdentity != nil {
		after, err := r.nativeIdentity(pid)
		if err != nil {
			return 0, "", err
		}
		if after != birth {
			return 0, "", fmt.Errorf("process %d changed while reading identity", pid)
		}
	}
	return legacy, birth, nil
}

func (r *LeaseRegistry) Register(lease Lease) error {
	if lease.ID == "" || lease.PID <= 0 || lease.Generation == 0 {
		return fmt.Errorf("invalid runtime lease")
	}
	identity, birth, err := r.identify(lease.PID)
	if err != nil {
		return fmt.Errorf("identify lease process %d: %w", lease.PID, err)
	}
	now := r.now().UTC()
	if lease.CreatedAt.IsZero() {
		lease.CreatedAt = now
	}
	lease.ProcessStart = identity
	lease.ProcessStartIdentity = birth
	lease.LastSeen = now
	r.mu.Lock()
	r.leases[lease.ID] = lease
	r.mu.Unlock()
	return nil
}

func (r *LeaseRegistry) Bind(id string, pid int) error {
	identity, birth, err := r.identify(pid)
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
	lease.ProcessStartIdentity = birth
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
		alive := false
		if lease.ProcessStartIdentity != "" {
			if r.nativeIdentity != nil {
				identity, err := r.nativeIdentity(lease.PID)
				alive = err == nil && identity == lease.ProcessStartIdentity
			}
		} else {
			// Old handoffs retain their original exact-match rule. Once verified,
			// upgrade the lease to the stable token for subsequent checks.
			identity, birth, err := r.identify(lease.PID)
			alive = err == nil && identity == lease.ProcessStart
			if alive {
				lease.ProcessStartIdentity = birth
			}
		}
		if !alive {
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
