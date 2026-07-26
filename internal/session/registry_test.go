package session

import "testing"

func TestShouldPreserveRootedProtocolPathOnWindows(t *testing.T) {
	tests := []struct {
		name      string
		goos      string
		path      string
		separator uint8
		want      bool
	}{
		{name: "windows forward slash", goos: "windows", path: "/repo", separator: '\\', want: true},
		{name: "windows native separator", goos: "windows", path: `\repo`, separator: '\\', want: true},
		{name: "windows relative", goos: "windows", path: "repo", separator: '\\', want: false},
		{name: "unix forward slash", goos: "darwin", path: "/repo", separator: '/', want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := shouldPreserveRootedProtocolPath(tt.goos, tt.path, tt.separator); got != tt.want {
				t.Fatalf("shouldPreserveRootedProtocolPath(%q, %q) = %v, want %v", tt.goos, tt.path, got, tt.want)
			}
		})
	}
}
