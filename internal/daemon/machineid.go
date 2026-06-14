package daemon

import (
	"crypto/sha256"
	"fmt"
	"net"
)

// MachineID returns a deterministic daemon ID based on the machine's
// first non-loopback MAC address. The ID is stable across daemon
// restarts, stop/start cycles, and state file deletions.
//
// Format: "daemon-<sha256(mac)[:8]>"
// Falls back to "daemon-unknown" if no MAC address is found.
func MachineID() string {
	mac := firstMAC()
	if mac == "" {
		return "daemon-unknown"
	}
	hash := sha256.Sum256([]byte(mac))
	return fmt.Sprintf("daemon-%x", hash[:4])
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
