//go:build !windows

package agentcontrol

import (
	"context"
	"os"
	"testing"
)

// This fixture writes a POSIX shell probe and therefore belongs in the Unix
// test set. Keeping it out of the Windows compile contract also ensures it
// cannot depend on Unix-only helpers such as shellQuote.
func TestResolveLauncherCodexTempHomeRejectsRealHomeShim(t *testing.T) {
	f := newLauncherResolutionFixture(t, AgentCodex, "codex-cli 0.300.0")
	f.isolate(t, f.shimDir, f.realDir)
	realExecMarker := f.real + ".executed"
	realBody := "#!/bin/sh\ntouch " + shellQuote(realExecMarker) + "\nexit 99\n"
	if err := os.WriteFile(f.real, []byte(realBody), 0o755); err != nil {
		t.Fatal(err)
	}
	resolver := NewBinaryResolver()
	resolver.RunVersion = func(_ context.Context, path string) (string, error) {
		if !sameFile(path, f.real) {
			t.Fatalf("version probe path=%q, want real candidate %q", path, f.real)
		}
		return "codex-cli 0.300.0", nil
	}

	got, err := resolveLauncherCodexWithResolver(resolver)
	if err != nil {
		t.Fatal(err)
	}
	if sameFile(got, f.shim) {
		t.Fatalf("resolver returned the PocketCtl-owned shim from the real HOME: %q", got)
	}
	if !sameFile(got, f.real) {
		t.Fatalf("resolver path=%q, want real candidate %q", got, f.real)
	}
	f.assertShimNeverExecuted(t)
	if _, err := os.Lstat(realExecMarker); !os.IsNotExist(err) {
		t.Fatalf("resolver executed the real candidate instead of the injected version probe: %v", err)
	}
}
