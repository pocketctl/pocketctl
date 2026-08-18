//go:build !windows

package agentcontrol

import (
	"os"
	"path/filepath"
	"testing"
)

func TestInspectPocketctlShimUnreadableIsForeign(t *testing.T) {
	dir := t.TempDir()
	pocketctl := filepath.Join(dir, "pocketctl")
	writeShimFixture(t, pocketctl, "macho\n")

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
