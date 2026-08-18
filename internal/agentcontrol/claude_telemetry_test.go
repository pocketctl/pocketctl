package agentcontrol

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestClaudeTelemetryStoresOnlyEnumeratedCounters(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if err := RecordClaudeApprovalFinish("timed_out"); err != nil {
		t.Fatal(err)
	}
	if err := RecordClaudeResolvedElsewhere(); err != nil {
		t.Fatal(err)
	}
	if err := RecordClaudeReplay(2); err != nil {
		t.Fatal(err)
	}
	if err := RecordClaudeOrphanClosure(1); err != nil {
		t.Fatal(err)
	}
	if err := RecordClaudeJSONLWarning("jsonl_parse_error"); err != nil {
		t.Fatal(err)
	}
	if err := RecordClaudeApprovalFinish("prompt=secret token=auth cwd=/private"); err == nil {
		t.Fatal("arbitrary Claude finish reason was accepted")
	}
	if err := RecordClaudeJSONLWarning("raw-json-content"); err == nil {
		t.Fatal("arbitrary Claude JSONL reason was accepted")
	}
	snapshot, err := LoadClaudeTelemetry()
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.FinishReasons["timed_out"] != 1 || snapshot.ResolvedElsewhere != 1 ||
		snapshot.Replayed != 2 || snapshot.OrphanClosed != 1 ||
		snapshot.JSONLWarnings["jsonl_parse_error"] != 1 {
		t.Fatalf("snapshot=%+v", snapshot)
	}
	raw, err := os.ReadFile(claudeTelemetryPath())
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range [][]byte{[]byte("prompt"), []byte("secret"), []byte("token"), []byte("auth"), []byte("/private"), []byte("raw-json-content")} {
		if bytes.Contains(raw, forbidden) {
			t.Fatalf("telemetry leaked %q: %s", forbidden, raw)
		}
	}
}

// TestClaudeChannelTelemetryStoresOnlyEnumeratedCounters verifies the Task 11
// Claude Channel counters accept only enumerated reasons/behaviors and never
// leak content/session/request identifiers. Design §Task 11: "Telemetry only
// contains counters" + "禁止维度: session ID、request ID、cwd、tool、
// description、preview、answer、token、PID".
func TestClaudeChannelTelemetryStoresOnlyEnumeratedCounters(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	// Each valid counter increments.
	if err := RecordClaudeChannelBootstrapFallback("rollout_disabled"); err != nil {
		t.Fatal(err)
	}
	if err := RecordClaudeChannelBootstrapFallback("bootstrap_timeout"); err != nil {
		t.Fatal(err)
	}
	if err := RecordClaudeChannelRegistered(); err != nil {
		t.Fatal(err)
	}
	if err := RecordClaudeChannelRegistered(); err != nil {
		t.Fatal(err)
	}
	if err := RecordClaudeChannelDisconnected("channel_exit"); err != nil {
		t.Fatal(err)
	}
	if err := RecordClaudeChannelApprovalObserved(); err != nil {
		t.Fatal(err)
	}
	if err := RecordClaudeChannelVerdictReserved("allow"); err != nil {
		t.Fatal(err)
	}
	if err := RecordClaudeChannelVerdictReserved("deny"); err != nil {
		t.Fatal(err)
	}
	if err := RecordClaudeChannelVerdictSubmitted("allow"); err != nil {
		t.Fatal(err)
	}
	if err := RecordClaudeChannelResultUnknown("channel_write_failed"); err != nil {
		t.Fatal(err)
	}
	if err := RecordClaudeChannelTerminalProgress(); err != nil {
		t.Fatal(err)
	}

	// Invalid dimensions are rejected — they would let an attacker inject
	// arbitrary content into the telemetry file.
	for _, invalid := range []struct {
		fn   func() error
		note string
	}{
		{func() error { return RecordClaudeChannelBootstrapFallback("session=claude-uuid") }, "fallback reason"},
		{func() error { return RecordClaudeChannelDisconnected("reason=/cwd=/private") }, "disconnect reason"},
		{func() error { return RecordClaudeChannelVerdictReserved("always") }, "verdict behavior"},
		{func() error { return RecordClaudeChannelVerdictSubmitted("cancel") }, "submitted behavior"},
		{func() error { return RecordClaudeChannelResultUnknown("token=abc123") }, "result_unknown reason"},
	} {
		if err := invalid.fn(); err == nil {
			t.Fatalf("%s must be rejected", invalid.note)
		}
	}

	snapshot, err := LoadClaudeTelemetry()
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.ChannelBootstrapFallback["rollout_disabled"] != 1 ||
		snapshot.ChannelBootstrapFallback["bootstrap_timeout"] != 1 ||
		snapshot.ChannelRegistered != 2 ||
		snapshot.ChannelDisconnected["channel_exit"] != 1 ||
		snapshot.ChannelApprovalObserved != 1 ||
		snapshot.ChannelVerdictReserved["allow"] != 1 ||
		snapshot.ChannelVerdictReserved["deny"] != 1 ||
		snapshot.ChannelVerdictSubmitted["allow"] != 1 ||
		snapshot.ChannelResultUnknown["channel_write_failed"] != 1 ||
		snapshot.ChannelTerminalProgress != 1 {
		t.Fatalf("snapshot mismatch: %+v", snapshot)
	}

	// No content/session/request leak.
	raw, err := os.ReadFile(claudeTelemetryPath())
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range [][]byte{[]byte("session="), []byte("/cwd="), []byte("token="), []byte("always"), []byte("cancel")} {
		if bytes.Contains(raw, forbidden) {
			t.Fatalf("channel telemetry leaked %q: %s", forbidden, raw)
		}
	}
}

func TestClaudeTelemetryLauncherSafetyCounters(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if err := RecordLauncherSafety("owned_shim_rejected"); err != nil {
		t.Fatal(err)
	}
	if err := RecordLauncherSafety("bootstrap_timeout"); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{
		"/Users/x/.pocketctl/bin/claude",
		"session-abc-123",
		"prompt=delete everything",
		"pid=999",
		"token=secret-value",
	} {
		if err := RecordLauncherSafety(bad); err == nil {
			t.Fatalf("LauncherSafety accepted forbidden reason %q", bad)
		}
	}
	snapshot, err := LoadClaudeTelemetry()
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.LauncherSafety["owned_shim_rejected"] != 1 || snapshot.LauncherSafety["bootstrap_timeout"] != 1 {
		t.Fatalf("launcher safety snapshot=%+v", snapshot.LauncherSafety)
	}
}

func TestClaudeTelemetryResumeCleanupCounters(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if err := RecordResumeCleanup("resume_cancelled"); err != nil {
		t.Fatal(err)
	}
	if err := RecordResumeCleanup("resume_force_killed"); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{
		"/var/folders/session.jsonl",
		"session=exited-sid",
		"claude --resume secret",
		"pid=4242",
		"token=abc",
	} {
		if err := RecordResumeCleanup(bad); err == nil {
			t.Fatalf("ResumeCleanup accepted forbidden reason %q", bad)
		}
	}
	snapshot, err := LoadClaudeTelemetry()
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.ResumeCleanup["resume_cancelled"] != 1 || snapshot.ResumeCleanup["resume_force_killed"] != 1 {
		t.Fatalf("resume cleanup snapshot=%+v", snapshot.ResumeCleanup)
	}
}

func TestClaudeTelemetryOlderFileWithoutSafetyMapsInitializesEmpty(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	path := claudeTelemetryPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	legacy := []byte(`{"version":1,"finish_reasons":{"timed_out":2}}` + "\n")
	if err := os.WriteFile(path, legacy, 0o600); err != nil {
		t.Fatal(err)
	}
	snapshot, err := LoadClaudeTelemetry()
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.FinishReasons["timed_out"] != 2 {
		t.Fatalf("legacy counters lost: %+v", snapshot.FinishReasons)
	}
	if snapshot.LauncherSafety == nil || len(snapshot.LauncherSafety) != 0 {
		t.Fatalf("LauncherSafety map not initialized: %+v", snapshot.LauncherSafety)
	}
	if snapshot.ResumeCleanup == nil || len(snapshot.ResumeCleanup) != 0 {
		t.Fatalf("ResumeCleanup map not initialized: %+v", snapshot.ResumeCleanup)
	}
}

func TestClaudeTelemetrySafetySerializationContainsOnlyCounters(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := RecordLauncherSafety("owned_shim_rejected"); err != nil {
		t.Fatal(err)
	}
	if err := RecordResumeCleanup("resume_force_killed"); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(claudeTelemetryPath())
	if err != nil {
		t.Fatal(err)
	}
	var generic map[string]any
	if err := json.Unmarshal(raw, &generic); err != nil {
		t.Fatal(err)
	}
	launcher, _ := generic["launcher_safety"].(map[string]any)
	if launcher["owned_shim_rejected"] != float64(1) || len(launcher) != 1 {
		t.Fatalf("launcher_safety serialization=%+v", launcher)
	}
	cleanup, _ := generic["resume_cleanup"].(map[string]any)
	if cleanup["resume_force_killed"] != float64(1) || len(cleanup) != 1 {
		t.Fatalf("resume_cleanup serialization=%+v", cleanup)
	}
	text := string(raw)
	for _, forbidden := range []string{home, "session", "pid=", "token", "prompt"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("telemetry serialized forbidden content %q: %s", forbidden, text)
		}
	}
}
