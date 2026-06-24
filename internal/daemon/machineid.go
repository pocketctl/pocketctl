package daemon

import (
	"crypto/sha256"
	"fmt"
	"net"
	"os"
	"strings"
)

// MachineID returns a deterministic daemon ID. It prefers stable system
// identifiers (/etc/machine-id, hostname) over MAC addresses, because MAC
// addresses can be unstable on virtualized platforms (WSL2, cloud VMs).
//
// Resolution order:
//  1. /etc/machine-id or /var/lib/dbus/machine-id (systemd — stable across reboots)
//  2. Hostname (stable on physical machines, semi-stable on VMs)
//  3. First non-loopback MAC address (fallback — unstable on WSL2/cloud)
//  4. "daemon-unknown" (last resort)
//
// Format: "daemon-<sha256(id)[:8]>"
func MachineID() string {
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
