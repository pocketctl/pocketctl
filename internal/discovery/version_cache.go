package discovery

import (
	"os"
	"sync"
	"time"
)

// Installation polling should not repeatedly launch unchanged CLIs. Probe again
// after a file change, an explicit upgrade scan, or a bounded cache lifetime.
var localVersions = struct {
	sync.Mutex
	entries map[string]localVersion
}{entries: make(map[string]localVersion)}

type localVersion struct {
	modified time.Time
	size     int64
	checked  time.Time
	version  string
}

func cachedVersion(path string, force bool) string {
	info, err := os.Stat(path)
	if err != nil {
		return ""
	}
	localVersions.Lock()
	previous, ok := localVersions.entries[path]
	localVersions.Unlock()
	if !force && ok && previous.modified.Equal(info.ModTime()) && previous.size == info.Size() && time.Since(previous.checked) < 5*time.Minute {
		return previous.version
	}
	version := detectVersion(path)
	localVersions.Lock()
	localVersions.entries[path] = localVersion{info.ModTime(), info.Size(), time.Now(), version}
	localVersions.Unlock()
	return version
}
