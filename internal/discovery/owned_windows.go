//go:build windows

package discovery

// fileOwnedByCurrentUser on Windows always returns false: Windows has no uid
// concept, and in-place agent-upgrade manageability is determined elsewhere.
// Native Windows upgrade path lands in a later PR.
func fileOwnedByCurrentUser(path string) bool {
	return false
}

func platformExtensions() []string {
	return []string{"", ".exe", ".cmd", ".bat"}
}
