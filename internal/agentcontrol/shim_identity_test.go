package agentcontrol

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeShimFixture(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
}

func TestInspectPocketctlShimRecognizesMarkerOutsideCurrentHome(t *testing.T) {
	dir := t.TempDir()
	shim := filepath.Join(dir, "claude")
	writeShimFixture(t, shim, "#!/bin/sh\n# pocketctl-agent-launcher-v2\nexit 0\n")
	if got := inspectPocketctlShim(shim, ""); got != ShimPocketctlMarker {
		t.Fatalf("identity=%v want marker", got)
	}
}

func TestInspectPocketctlShimMarkers(t *testing.T) {
	cases := []struct {
		name string
		body string
	}{
		{"legacy unix v2", "#!/bin/sh\n# pocketctl-agent-launcher-v2\nexit 0\n"},
		{"new unix v3", "#!/bin/sh\n# pocketctl-agent-launcher-v3\nexit 0\n"},
		{"legacy windows", "@rem pocketctl-agent-launcher\r\n@exit /b 0\r\n"},
		{"new windows v3", "@rem pocketctl-agent-launcher-v3\r\n@exit /b 0\r\n"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			shim := filepath.Join(t.TempDir(), "claude")
			writeShimFixture(t, shim, c.body)
			if got := inspectPocketctlShim(shim, ""); got != ShimPocketctlMarker {
				t.Fatalf("identity=%v want marker", got)
			}
		})
	}
}

func TestInspectPocketctlShimMarkerWithinBoundedPrefix(t *testing.T) {
	shim := filepath.Join(t.TempDir(), "claude")
	padding := strings.Repeat("#\n", 1999) // 3998 bytes before the marker line
	if len(padding) >= launcherInspectLimit {
		t.Fatalf("test fixture padding exceeds limit: %d", len(padding))
	}
	writeShimFixture(t, shim, padding+"# pocketctl-agent-launcher-v3\n"+strings.Repeat("#\n", 100))
	if got := inspectPocketctlShim(shim, ""); got != ShimPocketctlMarker {
		t.Fatalf("identity=%v want marker inside inspection prefix", got)
	}
}

func TestInspectPocketctlShimMarkerAfterLimitIsIgnored(t *testing.T) {
	shim := filepath.Join(t.TempDir(), "claude")
	padding := strings.Repeat("#\n", 2100) // 6300 bytes: marker sits past the 4 KiB prefix
	if len(padding) <= launcherInspectLimit {
		t.Fatalf("test fixture padding must exceed limit: %d", len(padding))
	}
	writeShimFixture(t, shim, padding+"# pocketctl-agent-launcher-v3\n")
	if got := inspectPocketctlShim(shim, ""); got != ShimForeign {
		t.Fatalf("identity=%v want foreign for marker past inspection limit", got)
	}
}

func TestInspectPocketctlShimMarkerTextInsideUnrelatedLine(t *testing.T) {
	shim := filepath.Join(t.TempDir(), "claude")
	writeShimFixture(t, shim, "#!/bin/sh\n# see pocketctl-agent-launcher-v3 docs\nexit 0\n")
	if got := inspectPocketctlShim(shim, ""); got != ShimForeign {
		t.Fatalf("identity=%v want foreign for marker text inside unrelated line", got)
	}
}

func TestInspectPocketctlShimSameFileAsPocketctlExecutable(t *testing.T) {
	dir := t.TempDir()
	pocketctl := filepath.Join(dir, "pocketctl")
	writeShimFixture(t, pocketctl, "macho\n")

	symlink := filepath.Join(dir, "claude-symlink")
	if err := os.Symlink(pocketctl, symlink); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	if got := inspectPocketctlShim(symlink, pocketctl); got != ShimPocketctlExecutable {
		t.Fatalf("symlink identity=%v want executable", got)
	}

	if hardlink := filepath.Join(dir, "claude-hardlink"); os.Link(pocketctl, hardlink) == nil {
		if got := inspectPocketctlShim(hardlink, pocketctl); got != ShimPocketctlExecutable {
			t.Fatalf("hardlink identity=%v want executable", got)
		}
	}
}

func TestInspectPocketctlShimForeignExecutable(t *testing.T) {
	dir := t.TempDir()
	shim := filepath.Join(dir, "claude")
	writeShimFixture(t, shim, "#!/bin/sh\nexec /usr/local/bin/node cli.js \"$@\"\n")
	if got := inspectPocketctlShim(shim, filepath.Join(dir, "pocketctl")); got != ShimForeign {
		t.Fatalf("identity=%v want foreign", got)
	}
}

func TestInspectPocketctlShimNonRegularMissingAndUnreadable(t *testing.T) {
	dir := t.TempDir()
	pocketctl := filepath.Join(dir, "pocketctl")
	writeShimFixture(t, pocketctl, "macho\n")

	if got := inspectPocketctlShim(dir, pocketctl); got != ShimForeign {
		t.Fatalf("directory identity=%v want foreign", got)
	}
	broken := filepath.Join(dir, "broken")
	if err := os.Symlink(filepath.Join(dir, "missing-target"), broken); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	if got := inspectPocketctlShim(broken, pocketctl); got != ShimForeign {
		t.Fatalf("broken symlink identity=%v want foreign", got)
	}
	if got := inspectPocketctlShim(filepath.Join(dir, "does-not-exist"), pocketctl); got != ShimForeign {
		t.Fatalf("missing path identity=%v want foreign", got)
	}

	unreadable := filepath.Join(dir, "unreadable")
	writeShimFixture(t, unreadable, "# pocketctl-agent-launcher-v2\n")
	if os.Geteuid() == 0 {
		t.Skip("running as root cannot produce an unreadable file")
	}
	if err := os.Chmod(unreadable, 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(unreadable, 0o644) })
	if got := inspectPocketctlShim(unreadable, pocketctl); got != ShimForeign {
		t.Fatalf("unreadable identity=%v want foreign", got)
	}
}

func TestIsPocketctlOwnedShim(t *testing.T) {
	dir := t.TempDir()
	pocketctl := filepath.Join(dir, "pocketctl")
	writeShimFixture(t, pocketctl, "macho\n")

	marker := filepath.Join(dir, "claude")
	writeShimFixture(t, marker, "#!/bin/sh\n# pocketctl-agent-launcher-v2\nexit 0\n")
	if !isPocketctlOwnedShim(marker, pocketctl) {
		t.Fatal("marker shim should be owned")
	}

	foreign := filepath.Join(dir, "foreign")
	writeShimFixture(t, foreign, "#!/bin/sh\nexit 0\n")
	if isPocketctlOwnedShim(foreign, pocketctl) {
		t.Fatal("foreign shim should not be owned")
	}

	if !isPocketctlOwnedShim(pocketctl, pocketctl) {
		t.Fatal("pocketctl executable itself should be owned")
	}
}
