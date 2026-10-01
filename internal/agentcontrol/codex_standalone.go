package agentcontrol

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/pocketctl/pocketctl/internal/config"
)

// normalizeCodexStandaloneBinary maps a versioned Codex standalone release
// path onto the stable `current` alias maintained by Codex's own updater.
// Standalone self-updates repoint .../standalone/current and keep old release
// directories on disk, so a release path captured at enable time keeps passing
// every validity check while running an outdated binary forever. Any other
// layout — npm, Homebrew, arbitrary paths — and any missing or invalid alias
// is returned unchanged.
func normalizeCodexStandaloneBinary(path string) string {
	if path == "" {
		return path
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return path
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return path
	}
	userHome, err := config.HomeDir()
	if err != nil {
		return path
	}
	codexHome, err := ResolveCodexHome(os.Getenv("CODEX_HOME"), userHome)
	if err != nil {
		return path
	}
	releasesRoot := filepath.Join(codexHome, "packages", "standalone", "releases")
	rel, err := filepath.Rel(releasesRoot, resolved)
	if err != nil {
		return path
	}
	parts := strings.Split(rel, string(filepath.Separator))
	if len(parts) != 3 || parts[0] == "" || parts[0] == "." || parts[0] == ".." ||
		parts[1] != "bin" || !isCodexStandaloneBinaryName(parts[2]) {
		return path
	}
	alias := filepath.Join(codexHome, "packages", "standalone", "current", "bin", parts[2])
	if _, ok := validatedRealAgentPath(alias); ok {
		return alias
	}
	return path
}

func isCodexStandaloneBinaryName(name string) bool {
	return name == AgentCodex || (runtime.GOOS == "windows" && name == AgentCodex+".exe")
}
