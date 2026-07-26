package agentcontrol

import (
	"bytes"
	"os"
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
