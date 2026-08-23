package discovery

import (
	"context"
	"errors"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/zcode"
)

// discoverStorageAgent surfaces a DiscoveryStorage agent (zcode) in the agent
// list. It returns ok=false (and therefore omits the agent) when:
//   - the sync config is absent or disabled,
//   - the local store is missing/inaccessible/corrupt,
//   - the schema probe fails.
//
// It never performs npm/CLI version queries, never opens the DB for content, and
// never exposes session title/cwd/content. Version is left empty: ZCode's binary
// version is not reliably readable from the store, and we refuse to guess it
// from DB content (design §4.2).
func discoverStorageAgent(a adapter.Provider) (AgentInfo, bool) {
	if a.Discovery != adapter.DiscoveryStorage {
		return AgentInfo{}, false
	}
	if a.Type != adapter.AgentZcode {
		// Future observer agents would need their own probe; only zcode is wired.
		return AgentInfo{}, false
	}
	return DiscoverZcode()
}

// DiscoverZcode probes the local ZCode store and returns an AgentInfo when the
// user has enabled the read-only sync and the store is reachable with a
// compatible schema. It is the single entry point used by DiscoverAgents for
// zcode; tests may call it directly with a config override.
func DiscoverZcode() (AgentInfo, bool) {
	cfg, err := zcode.LoadConfig()
	if err != nil || !cfg.Enabled {
		// Disabled (or corrupt/absent) → never surface zcode, and never open the
		// DB. This is the explicit opt-in gate.
		return AgentInfo{}, false
	}
	storage := zcode.ResolveStorageDir(cfg)
	store, err := zcode.Open(storage)
	if err != nil {
		return AgentInfo{}, false
	}
	defer store.Close()
	if err := store.Probe(context.Background()); err != nil {
		// Schema incompatible (or DB busy/corrupt) → fail closed: do not surface
		// the agent. The daemon's other agents and the Relay loop keep working.
		if errors.Is(err, zcode.ErrSchemaIncompatible) || errors.Is(err, zcode.ErrDatabaseCorrupt) || errors.Is(err, zcode.ErrDatabaseBusy) {
			return AgentInfo{}, false
		}
		return AgentInfo{}, false
	}
	return AgentInfo{
		Type:       adapter.AgentZcode,
		CLIName:    "",
		Manageable: false,
		// Version/Latest intentionally empty: ZCode's version is not reliably
		// derivable from the store; we never guess it from DB content.
	}, true
}
