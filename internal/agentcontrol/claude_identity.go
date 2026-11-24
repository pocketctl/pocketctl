package agentcontrol

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/pocketctl/pocketctl/internal/config"
)

// RefreshClaudeIdentity runs during daemon inventory refresh, outside terminal
// launch. The launcher keeps its no-subprocess identity-bound version gate.
func RefreshClaudeIdentity() error {
	cfg, err := LoadConfig()
	if err != nil || cfg.Claude.State != StateEnabled {
		return err
	}
	old := cfg.Claude
	path := old.RealBinary
	home, err := config.HomeDir()
	if err != nil {
		return err
	}
	alias := filepath.Join(home, ".local", "bin", "claude")
	// Migrate versioned native installations to the stable entry even when
	// Claude's updater keeps its previous version installed.
	if filepath.Dir(path) == filepath.Join(home, ".local", "share", "claude", "versions") {
		if _, ok := validatedRealAgentPath(alias); ok {
			path = alias
		}
	}
	resolved, ok := validatedRealAgentPath(path)
	if !ok {
		resolved, err = ResolveClaudeExecutableFast()
		if err != nil {
			return err
		}
		path = resolved
	}
	before, err := os.Stat(resolved)
	if err != nil {
		return err
	}
	if resolved == old.RealBinary && old.DetectedVersion != "" && before.Size() == old.BinarySize && before.ModTime().UnixNano() == old.BinaryMTimeNS && uint32(before.Mode()) == old.BinaryMode {
		return nil
	}
	r := NewBinaryResolver()
	actual, version, err := r.validate(resolved, []string{old.ShimPath, defaultClaudeShimPath()}, ErrClaudeNotFound, ErrClaudeVersion, ErrClaudeVersionTimeout)
	if err != nil {
		return err
	}
	lock, err := lockLauncherConfig()
	if err != nil {
		return err
	}
	defer lock.Close()
	fresh, err := LoadConfig()
	if err != nil || fresh.Claude != old {
		return err
	}
	after, err := os.Stat(path)
	if err != nil || !sameResolvedPath(actual, path) || !os.SameFile(before, after) || before.Size() != after.Size() || before.ModTime() != after.ModTime() || before.Mode() != after.Mode() {
		return fmt.Errorf("Claude binary changed during version probe")
	}
	fresh.Claude.RealBinary = resolved
	fresh.Claude.DetectedVersion = version
	fresh.Claude.BinarySize = after.Size()
	fresh.Claude.BinaryMTimeNS = after.ModTime().UnixNano()
	fresh.Claude.BinaryMode = uint32(after.Mode())
	return saveConfigLocked(fresh)
}
