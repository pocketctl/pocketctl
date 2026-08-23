//go:build windows

package daemon

// Windows FlushFileBuffers does not support directory handles opened through
// os.Open; atomic rename remains the durable primitive available here.
func syncStateDirectory(path string) error { return nil }
