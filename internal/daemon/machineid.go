package daemon

import (
	"crypto/rand"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"

	"github.com/pocketctl/pocketctl/internal/config"
)

// MachineID returns the durable identity of this Pocketctl installation.
//
// New installations receive a random 128-bit identifier. It deliberately does
// not use hostname, MAC address, or OS identifiers: all of those may change
// when a machine is renamed, restored, virtualized, or moved between networks.
// The value is written once to ~/.pocketctl/machine.id and remains stable until
// an operator intentionally removes that file.
//
// Existing daemon-xxxxxxxx cache values remain valid so an upgrade never turns
// one existing machine into a new host in Relay.
func MachineID() string {
	if cached := readMachineIDCache(); cached != "" {
		return cached
	}

	var entropy [16]byte
	if _, err := rand.Read(entropy[:]); err != nil {
		// Never manufacture a deterministic fallback from mutable machine
		// properties. "unknown" is intentionally not eligible for Relay host
		// consolidation, which is safer than merging unrelated devices.
		return "machine-unknown"
	}
	id := "machine-" + hex.EncodeToString(entropy[:])
	writeMachineIDCache(id)
	return id
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

// readMachineIDCache returns "" if the persisted value is absent or malformed.
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
	if !validMachineID(id) {
		return ""
	}
	return id
}

func validMachineID(id string) bool {
	if strings.HasPrefix(id, "machine-") {
		return len(id) == len("machine-")+32 && isLowerHex(id[len("machine-"):])
	}
	// Compatibility with the former cached machine identity format.
	if strings.HasPrefix(id, "daemon-") {
		return len(id) == len("daemon-")+8 && isLowerHex(id[len("daemon-"):])
	}
	return false
}

func isLowerHex(value string) bool {
	for _, c := range value {
		if !(c >= '0' && c <= '9') && !(c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

// writeMachineIDCache atomically persists the generated identity. Failures are
// non-fatal: the current daemon can still connect, but a later start will get a
// fresh identity rather than risking an unsafe deterministic collision.
func writeMachineIDCache(id string) {
	path := machineIDCachePath()
	if path == "" || !validMachineID(id) {
		return
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return
	}
	tmp, err := os.CreateTemp(dir, ".machine.id-*")
	if err != nil {
		return
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := tmp.Chmod(0600); err != nil {
		_ = tmp.Close()
		return
	}
	if _, err := tmp.WriteString(id + "\n"); err != nil {
		_ = tmp.Close()
		return
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return
	}
	if err := tmp.Close(); err != nil {
		return
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return
	}
	_ = syncStateDirectory(dir)
}
