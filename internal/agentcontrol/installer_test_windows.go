//go:build windows
// +build windows

package agentcontrol

func testShimMarker() string {
	return launcherMarkerWindowsV3
}

// testShellQuote is never called on Windows: wrapper tests skip before use.
func testShellQuote(value string) string {
	return "\"" + value + "\""
}
