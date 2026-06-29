package adapter

import (
	"context"
	"encoding/json"
	"os/exec"
	"testing"
	"time"
)

func TestParsePermissionAsked(t *testing.T) {
	cases := []struct {
		name             string
		props            string
		wantOK           bool
		wantID, wantSess string
		wantTool         string
	}{
		{
			name:     "flat shape",
			props:    `{"id":"per_123","sessionID":"ses_abc","type":"bash","metadata":{"command":"ls"}}`,
			wantOK:   true,
			wantID:   "per_123",
			wantSess: "ses_abc",
			wantTool: "bash",
		},
		{
			name:     "nested under permission",
			props:    `{"permission":{"id":"per_9","sessionID":"ses_z","toolName":"edit","title":"Edit foo.go"}}`,
			wantOK:   true,
			wantID:   "per_9",
			wantSess: "ses_z",
			wantTool: "edit",
		},
		{
			name:     "requestID alias",
			props:    `{"requestID":"req_7","sessionID":"ses_q","type":"bash"}`,
			wantOK:   true,
			wantID:   "req_7",
			wantSess: "ses_q",
			wantTool: "bash",
		},
		{name: "missing id", props: `{"sessionID":"ses_x","type":"bash"}`, wantOK: false},
		{name: "missing session", props: `{"id":"per_1","type":"bash"}`, wantOK: false},
		{name: "garbage", props: `not json`, wantOK: false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			pa, ok := ParsePermissionAsked(json.RawMessage(c.props))
			if ok != c.wantOK {
				t.Fatalf("ok=%v want %v (pa=%+v)", ok, c.wantOK, pa)
			}
			if !c.wantOK {
				return
			}
			if pa.ID != c.wantID || pa.SessionID != c.wantSess || pa.Tool != c.wantTool {
				t.Fatalf("got %+v, want id=%s sess=%s tool=%s", pa, c.wantID, c.wantSess, c.wantTool)
			}
		})
	}
}

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
