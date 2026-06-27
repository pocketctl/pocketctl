package adapter

import (
	"context"
	"os/exec"
	"testing"
	"time"
)

// TestOpencodeServerSmoke exercises the serve-client lifecycle against a real
// `opencode serve` process: start, create a session, fetch it back, stop. It is
// an integration test — skipped when opencode is not installed — and makes no
// LLM call (session creation is free). Uses temp XDG dirs to avoid touching the
// user's real opencode data.
func TestOpencodeServerSmoke(t *testing.T) {
	cli, err := exec.LookPath("opencode")
	if err != nil {
		t.Skip("opencode not installed; skipping integration smoke test")
	}
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("XDG_STATE_HOME", t.TempDir())

	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()

	srv := NewOpencodeServer(cli)
	if err := srv.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer srv.Stop()

	if srv.BaseURL() == "" {
		t.Fatal("BaseURL empty after Start")
	}
	if !srv.Healthy(ctx) {
		t.Fatal("server not healthy after Start")
	}

	sid, err := srv.CreateSession(ctx, nil, "")
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if sid == "" {
		t.Fatal("CreateSession returned empty id")
	}

	info, err := srv.GetSession(ctx, sid)
	if err != nil {
		t.Fatalf("GetSession: %v", err)
	}
	if info.ID != sid {
		t.Fatalf("GetSession id mismatch: got %q want %q", info.ID, sid)
	}
}
