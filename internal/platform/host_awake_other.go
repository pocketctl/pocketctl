//go:build !darwin

package platform

// Non-macOS platforms retain their transport behavior. Relay heartbeat expiry
// still bounds stale presence when the operating system suspends the process.
func HostAwake() (bool, error) { return true, nil }
