package sysinfo

import (
	"runtime"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/mem"
)

// Metrics holds the latest system resource usage.
type Metrics struct {
	CpuPct float64 // 0-100
	MemPct float64 // 0-100
	DiskPct float64 // 0-100
	CollectedAt time.Time
}

var (
	current  Metrics
	mu       sync.RWMutex
	started  = false
	stopCh   chan struct{}
)

// Start begins a background goroutine that collects system metrics every 10s.
func Start() {
	if started {
		return
	}
	started = true
	stopCh = make(chan struct{})
	go collectLoop()
}

// Stop stops the background collector.
func Stop() {
	if stopCh != nil {
		close(stopCh)
	}
}

// Get returns the latest collected metrics.
func Get() Metrics {
	mu.RLock()
	defer mu.RUnlock()
	return current
}

// collectLoop samples CPU/memory/disk every 10 seconds.
// CPU.Percent blocks for 1 second (sampling window), so it runs in its own goroutine.
func collectLoop() {
	// Initial collection immediately
	collect()

	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			collect()
		case <-stopCh:
			return
		}
	}
}

func collect() {
	// CPU: blocks for 1s to sample
	cpuPct, err := cpu.Percent(time.Second, false)
	cpuVal := 0.0
	if err == nil && len(cpuPct) > 0 {
		cpuVal = cpuPct[0]
	}

	// Memory
	memVal := 0.0
	if m, err := mem.VirtualMemory(); err == nil {
		memVal = m.UsedPercent
	}

	// Disk (root or first mounted partition)
	diskVal := 0.0
	// On macOS use "/", on Linux use "/"
	if d, err := disk.Usage("/"); err == nil {
		diskVal = d.UsedPercent
	}

	mu.Lock()
	current = Metrics{
		CpuPct:   cpuVal,
		MemPct:   memVal,
		DiskPct:  diskVal,
		CollectedAt: time.Now(),
	}
	mu.Unlock()
}

// Arch returns the CPU architecture (e.g. "arm64", "amd64").
func Arch() string {
	return runtime.GOARCH
}
