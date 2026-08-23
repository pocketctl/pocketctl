package agentcontrol

import (
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
)

// Internal launcher environment keys. The v3 wrapper sets them for exactly
// one PocketCtl hop; they must never reach a real agent process.
const (
	launcherEnvDepth      = "POCKETCTL_AGENT_LAUNCH_DEPTH"
	launcherEnvRealBinary = "POCKETCTL_AGENT_REAL_BINARY"
)

// PocketCtl launcher wrapper markers. A marker counts only as a complete
// trimmed line inside the bounded inspection prefix, so ownership detection
// never depends on the current HOME and never executes the candidate.
const (
	launcherMarkerV2Unix    = "# pocketctl-agent-launcher-v2"
	launcherMarkerV3Unix    = "# pocketctl-agent-launcher-v3"
	launcherMarkerWindows   = "@rem pocketctl-agent-launcher"
	launcherMarkerWindowsV3 = "@rem pocketctl-agent-launcher-v3"
	launcherInspectLimit    = 4096
)

// ShimIdentity classifies a candidate executable path for launcher safety.
type ShimIdentity int

const (
	ShimForeign ShimIdentity = iota
	ShimPocketctlMarker
	ShimPocketctlExecutable
)

var launcherMarkerLines = map[string]struct{}{
	launcherMarkerV2Unix:    {},
	launcherMarkerV3Unix:    {},
	launcherMarkerWindows:   {},
	launcherMarkerWindowsV3: {},
}

// inspectPocketctlShim reports whether path is a PocketCtl-owned launcher
// shim. Ownership is HOME-independent: the path may resolve to the supplied
// PocketCtl executable (symlink/hardlink), or be a regular file whose bounded
// prefix contains an exact supported marker line. Unreadable, non-regular,
// oversized-without-marker, or marker-like foreign content is not owned.
func inspectPocketctlShim(path string, pocketctlPath string) ShimIdentity {
	if path != "" && pocketctlPath != "" {
		pathInfo, pathErr := os.Stat(path)
		pocketctlInfo, pocketctlErr := os.Stat(pocketctlPath)
		if pathErr == nil && pocketctlErr == nil && os.SameFile(pathInfo, pocketctlInfo) {
			return ShimPocketctlExecutable
		}
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() {
		return ShimForeign
	}
	f, err := os.Open(path)
	if err != nil {
		return ShimForeign
	}
	defer f.Close()
	prefix := make([]byte, launcherInspectLimit+1)
	n, err := io.ReadFull(f, prefix)
	if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
		return ShimForeign
	}
	if n > launcherInspectLimit {
		n = launcherInspectLimit
	}
	for _, line := range strings.Split(string(prefix[:n]), "\n") {
		if _, ok := launcherMarkerLines[strings.TrimSpace(line)]; ok {
			return ShimPocketctlMarker
		}
	}
	return ShimForeign
}

// isPocketctlOwnedShim reports whether path must never be treated as a real
// agent binary.
func isPocketctlOwnedShim(path string, pocketctlPath string) bool {
	return inspectPocketctlShim(path, pocketctlPath) != ShimForeign
}

var launcherPocketctlOnce struct {
	once sync.Once
	path string
}

// launcherPocketctlPath returns the running PocketCtl executable, resolved,
// for same-file shim detection. Empty when unavailable.
func launcherPocketctlPath() string {
	launcherPocketctlOnce.once.Do(func() {
		exe, err := os.Executable()
		if err != nil {
			return
		}
		if resolved, err := filepath.EvalSymlinks(exe); err == nil {
			exe = resolved
		}
		launcherPocketctlOnce.path = exe
	})
	return launcherPocketctlOnce.path
}

// validatedRealAgentPath validates a candidate real agent binary without
// executing it: absolute, regular executable file, not a PocketCtl-owned
// shim, and not the PocketCtl executable itself. Returns the resolved path.
func validatedRealAgentPath(path string) (string, bool) {
	if path == "" || !filepath.IsAbs(path) {
		return "", false
	}
	resolved, info, err := inspectPath(path)
	if err != nil || !info.Mode().IsRegular() {
		return "", false
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o111 == 0 {
		return "", false
	}
	pocketctl := launcherPocketctlPath()
	if isPocketctlOwnedShim(path, pocketctl) || isPocketctlOwnedShim(resolved, pocketctl) {
		return "", false
	}
	return resolved, true
}

// validatedLauncherRealBinaryHint validates the POCKETCTL_AGENT_REAL_BINARY
// hint a generated v3 wrapper recorded for this hop. The hint is convenience,
// never authority: it is checked exactly like a configured real binary.
func validatedLauncherRealBinaryHint() (string, bool) {
	return validatedRealAgentPath(os.Getenv(launcherEnvRealBinary))
}

// acceptRealAgentCandidate is the discovery filter that rejects every
// PocketCtl-owned shim regardless of the current HOME.
func acceptRealAgentCandidate(candidate, resolved string) bool {
	pocketctl := launcherPocketctlPath()
	if isPocketctlOwnedShim(candidate, pocketctl) {
		return false
	}
	if resolved != "" && isPocketctlOwnedShim(resolved, pocketctl) {
		return false
	}
	return true
}

// stripLauncherInternalEnv removes the internal launcher hint/fuse variables
// so they cannot leak into a real agent process.
func stripLauncherInternalEnv(env []string) []string {
	out := make([]string, 0, len(env))
	for _, item := range env {
		if strings.HasPrefix(item, launcherEnvDepth+"=") || strings.HasPrefix(item, launcherEnvRealBinary+"=") {
			continue
		}
		out = append(out, item)
	}
	return out
}
