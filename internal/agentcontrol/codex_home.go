package agentcontrol

import (
	"github.com/pocketctl/pocketctl/internal/codexhome"
)

// ResolveCodexHome normalizes one Codex configuration root for stable runtime
// identity. Existing symlinks are resolved so aliases and daemon configuration
// cannot accidentally create two runtimes for the same directory.
func ResolveCodexHome(path, userHome string) (string, error) {
	return codexhome.Resolve(path, userHome)
}

// CodexHomeID is an opaque, path-derived identifier. The raw home path never
// crosses the local launcher control protocol or the Relay connection.
func CodexHomeID(resolvedHome string) string {
	return codexhome.ID(resolvedHome)
}

// CodexHomeIDFromEnvironment returns the managed-runtime identity selected by
// one Codex invocation's environment.
func CodexHomeIDFromEnvironment(env []string) (string, error) {
	return codexhome.IDFromEnvironment(env)
}
