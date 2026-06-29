package update

import (
	"log/slog"
	"os/exec"
	"runtime"
)

// resignDarwin re-applies an ad-hoc code signature to the binary at path on
// macOS. This is required after the binary is replaced during self-update:
// macOS (Sequoia and later) SIGKILLs a process whose on-disk image changed and
// no longer matches its code signature when it re-execs itself — which the
// daemon does on every `daemon start` (re-exec into the daemonized child) and
// `daemon_restart`. Without re-signing, the post-update daemon would be killed
// with "Killed: 9".
//
// Best-effort and a no-op off macOS: any failure (codesign missing, signing
// error) is logged at warn but does not fail the update — the binary is still
// updated; the user can re-sign manually with `codesign --force --sign - <bin>`
// if the automatic pass didn't take.
func resignDarwin(path string) {
	if runtime.GOOS != "darwin" {
		return
	}
	// --force replaces any existing (now-invalid) signature; `--sign -` is the
	// ad-hoc identity (no certificate required).
	out, err := exec.Command("codesign", "--force", "--sign", "-", path).CombinedOutput()
	if err != nil {
		slog.Default().Warn("ad-hoc codesign after update failed; re-sign manually if the daemon is killed on restart",
			"path", path, "error", err, "output", string(out),
			"hint", "codesign --force --sign - "+path)
		return
	}
	slog.Default().Info("re-signed updated binary (ad-hoc)", "path", path)
}
