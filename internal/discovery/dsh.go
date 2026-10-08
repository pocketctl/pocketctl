package discovery

import (
	"context"
	"time"

	"github.com/pocketctl/pocketctl/internal/dshapp"
)

// A configured native Host is installation evidence even without a CLI on PATH.
// Callable evidence additionally requires an authenticated native RPC. Never
// include the launch URL or token in the public Agent snapshot.
func discoverDSHHost() (configured, callable bool) {
	cfg, err := dshapp.LoadConfig()
	if err != nil {
		return false, false
	}
	if _, err := dshapp.ValidateURL(cfg.URL); err != nil {
		return false, false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	client, err := dshapp.Connect(ctx, cfg)
	if err != nil {
		return true, false
	}
	defer client.Close()
	var catalog any
	err = client.Call(ctx, "session/modelCatalog", map[string]any{}, &catalog)
	return true, err == nil
}
