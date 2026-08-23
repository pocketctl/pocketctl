package turn

import (
	"strings"
	"testing"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestSourceKindPriority(t *testing.T) {
	id := Identity{Agent: "codex"}
	if kind, _ := id.SourceKind(); kind != "" {
		t.Error("empty identity must have no source kind")
	}
	if id.Origin() != protocol.TurnOriginLegacyUnassigned {
		t.Error("empty identity must be legacy_unassigned")
	}

	id = Identity{Agent: "codex", SourceMessageID: "msg-1"}
	if kind, src := id.SourceKind(); kind != "source_message" || src != "msg-1" {
		t.Errorf("source_message expected, got %s/%s", kind, src)
	}

	id = Identity{Agent: "codex", SourceMessageID: "msg-1", RequestID: "req-1"}
	if kind, src := id.SourceKind(); kind != "request" || src != "req-1" {
		t.Errorf("request must outrank source_message, got %s/%s", kind, src)
	}

	id = Identity{Agent: "codex", SourceMessageID: "msg-1", RequestID: "req-1", SourceTurnID: "turn-native-1"}
	if kind, src := id.SourceKind(); kind != "native" || src != "turn-native-1" {
		t.Errorf("native must outrank everything, got %s/%s", kind, src)
	}
	if id.Origin() != protocol.TurnOriginNative {
		t.Error("origin must be native")
	}
}

func TestLogicalTurnIDDeterministicAndIsolated(t *testing.T) {
	a := LogicalTurnID("codex", "sess-1", "", "request", "req-1")
	b := LogicalTurnID("codex", "sess-1", "", "request", "req-1")
	if a == "" || a != b {
		t.Fatalf("same inputs must derive the same id: %q vs %q", a, b)
	}
	if !strings.HasPrefix(a, "turn:v1:codex:") {
		t.Errorf("id must be namespaced: %q", a)
	}

	// Different sessions / actors / kinds / sources never collide.
	variants := []struct{ sess, actor, kind, src string }{
		{"sess-2", "", "request", "req-1"},
		{"sess-1", "agent-1", "request", "req-1"},
		{"sess-1", "", "native", "req-1"},
		{"sess-1", "", "request", "req-2"},
	}
	for _, v := range variants {
		if other := LogicalTurnID("codex", v.sess, v.actor, v.kind, v.src); other == a {
			t.Errorf("collision: (%s,%s,%s,%s) derived the same id", v.sess, v.actor, v.kind, v.src)
		}
	}

	if LogicalTurnID("codex", "sess", "", "", "") != "" {
		t.Error("no anchor must yield an empty id")
	}
	if LogicalTurnID("codex", "sess", "", "request", "") != "" {
		t.Error("empty source id must yield an empty id")
	}
}

func TestLogicalTurnIDContainsNoContent(t *testing.T) {
	secret := "super-secret-prompt-text"
	id := LogicalTurnID("codex", "sess-1", "", "request", "req-1")
	if strings.Contains(id, secret) {
		t.Error("id derivation never sees content")
	}
	// Even a malicious source id must only appear hashed, never verbatim for
	// a different session.
	if got := LogicalTurnID("codex", "sess-1", "", "request", secret); strings.Contains(got, secret) {
		t.Errorf("source id must not appear verbatim in the logical id: %q", got)
	}
}

func TestResolveMatchesDirectDerivation(t *testing.T) {
	id := Identity{Agent: "opencode", RequestID: "req-9"}
	logical, origin := id.Resolve("sess-9", "")
	if logical != LogicalTurnID("opencode", "sess-9", "", "request", "req-9") {
		t.Error("Resolve must match LogicalTurnID")
	}
	if origin != protocol.TurnOriginRequest {
		t.Errorf("origin = %q, want request", origin)
	}
}

func TestHashRequestIDShortAndStable(t *testing.T) {
	if HashRequestID("") != "" {
		t.Error("empty request id hashes to nothing")
	}
	if HashRequestID("req-1") != HashRequestID("req-1") {
		t.Error("hash must be stable")
	}
	if HashRequestID("req-1") == HashRequestID("req-2") {
		t.Error("hash must discriminate")
	}
	if len(HashRequestID("req-1")) != 16 {
		t.Errorf("hash length = %d, want 16 hex chars", len(HashRequestID("req-1")))
	}
}
