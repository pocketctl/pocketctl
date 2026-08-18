//go:build !windows
// +build !windows

package agentcontrol

func testShimMarker() string {
	return launcherMarkerV3Unix
}

func testShellQuote(value string) string {
	return shellQuote(value)
}
