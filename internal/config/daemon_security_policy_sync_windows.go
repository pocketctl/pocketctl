//go:build windows

package config

// Windows does not support flushing a directory handle opened through
// os.Open; os.Rename is the available atomic replacement primitive here.
func syncDaemonSecurityPolicyDirectory(string) error { return nil }
