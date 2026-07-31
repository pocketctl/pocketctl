package daemon

import (
	"crypto/sha256"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"

	"github.com/pocketctl/pocketctl/internal/config"
)

// MachineID returns a deterministic daemon ID. The first time it is called on a
// given host, it derives an ID from stable system identifiers and PERSISTS it to
// ~/.pocketctl/machine.id; every subsequent call reads that cached value back.
//
// Why the cache matters: the underlying sources (/etc/machine-id, hostname, MAC)
// are NOT stable across reboots on virtualized platforms — WSL2 regenerates
// /etc/machine-id and its MAC after `wsl --shutdown`; macOS has no machine-id
// file at all and falls through to hostname/MAC; Docker changes everything per
// container start. If we re-derive on every daemon start, the same physical host
// ends up with two different daemon_ids after a reboot, and the relay shows it
// as two hosts (the old one stuck "offline", a new "online" one).
//
// The file lives alongside daemon.state so it shares the same lifetime; unlike
// daemon.state it is never deleted, so a machine keeps a single ID forever.
//
// Resolution order (first hit wins, used only for the INITIAL value):
//  0. ~/.pocketctl/machine.id (cached — always wins once written)
//  1. /etc/machine-id or /var/lib/dbus/machine-id (systemd — stable across reboots)
//  2. Hostname (stable on physical machines, semi-stable on VMs)
//  3. First non-loopback MAC address (fallback — unstable on WSL2/cloud)
//  4. "daemon-unknown" (last resort)
//
// Format: "daemon-<sha256(id)[:8]>"
func MachineID() string {
	// 0. Cached value wins — never re-derive once an ID is assigned to this host.
	if cached := readMachineIDCache(); cached != "" {
		return cached
	}

	// Miss → derive from system sources and persist so the next start reuses it.
	id := deriveMachineID()
	writeMachineIDCache(id)
	return id
}

// deriveMachineID computes a fresh daemon id from system identifiers, WITHOUT
// consulting the cache. Sources, in order of stability:
//  1. /etc/machine-id or /var/lib/dbus/machine-id (systemd — stable across reboots)
//  2. Hostname (stable on physical machines, semi-stable on VMs)
//  3. First non-loopback MAC address (fallback — unstable on WSL2/cloud)
//  4. "daemon-unknown" (last resort)
func deriveMachineID() string {
	// 1. Try /etc/machine-id (Linux systemd) — most stable on WSL2/cloud
	if id := readMachineIDFile(); id != "" {
		hash := sha256.Sum256([]byte("machineid:" + id))
		return fmt.Sprintf("daemon-%x", hash[:4])
	}

	// 2. Try hostname — stable on physical machines, semi-stable on VMs
	if hostname, err := os.Hostname(); err == nil && hostname != "" {
		// Only use hostname if it's not a generic default
		if !isGenericHostname(hostname) {
			hash := sha256.Sum256([]byte("hostname:" + hostname))
			return fmt.Sprintf("daemon-%x", hash[:4])
		}
	}

	// 3. Fall back to MAC address (original logic)
	mac := firstMAC()
	if mac != "" {
		hash := sha256.Sum256([]byte(mac))
		return fmt.Sprintf("daemon-%x", hash[:4])
	}

	return "daemon-unknown"
}

// machineIDCachePath returns ~/.pocketctl/machine.id — the persisted host
// identifier. Uses the shared Pocketctl home resolver so state remains isolated
// when HOME is overridden by a service, test harness, or operator.
func machineIDCachePath() string {
	home, err := config.HomeDir()
	if err != nil || home == "" {
		return "" // caller falls back to deriving each time
	}
	return filepath.Join(home, ".pocketctl", "machine.id")
}

// readMachineIDCache reads the persisted daemon id. Returns "" if missing,
// unreadable, or malformed (any of which triggers a fresh derivation below).
func readMachineIDCache() string {
	path := machineIDCachePath()
	if path == "" {
		return ""
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	id := strings.TrimSpace(string(data))
	if id == "" || !strings.HasPrefix(id, "daemon-") {
		return ""
	}
	return id
}

// writeMachineIDCache persists the first-derived daemon id so future starts
// reuse it instead of re-deriving from an unstable source. Failures are
// non-fatal — worst case the id is re-derived next start, which is no worse
// than today's behavior.
func writeMachineIDCache(id string) {
	path := machineIDCachePath()
	if path == "" || id == "" {
		return
	}
	_ = os.MkdirAll(filepath.Dir(path), 0700)
	_ = os.WriteFile(path, []byte(id), 0600)
}

// readMachineIDFile reads the machine ID from systemd's /etc/machine-id
// or /var/lib/dbus/machine-id. Returns "" if not found or empty.
func readMachineIDFile() string {
	for _, path := range []string{"/etc/machine-id", "/var/lib/dbus/machine-id"} {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		id := strings.TrimSpace(string(data))
		if id != "" && id != "uninitialized" {
			return id
		}
	}
	return ""
}

// isGenericHostname returns true for default/generic hostnames that
// shouldn't be used as a machine identifier (too common across machines).
func isGenericHostname(hostname string) bool {
	generic := []string{"localhost", "raspberrypi", "ubuntu"}
	lower := strings.ToLower(hostname)
	for _, g := range generic {
		if lower == g {
			return true
		}
	}
	return false
}

// firstMAC returns the hardware MAC address of the first non-loopback
// network interface, or "" if none found.
func firstMAC() string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return ""
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		if len(iface.HardwareAddr) == 0 {
			continue
		}
		return iface.HardwareAddr.String()
	}
	return ""
}
