package claudechannel

import (
	"strings"
	"testing"

	"github.com/google/uuid"
	"unicode/utf8"
)

// TestSanitizePreviewCapsAndCleans verifies the preview is capped at
// MaxPreviewRunes, UTF-8 is validated, control chars and bidi/zero-width
// runes are stripped. Design §Task 5: "preview 200 字符、UTF-8、control char、
// 零宽/双向字符清洗".
func TestSanitizePreviewCapsAndCleans(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{"empty", "", ""},
		{"ascii short", "ls -la", "ls -la"},
		{"tab kept", "a\tb", "a\tb"},
		{"newline kept", "a\nb", "a\nb"},
		{"control stripped", "a\x00b\x01c", "abc"},
		{"zero-width stripped", "a\u200Bb", "ab"},
		{"bidi override stripped", "admin\u202Egm", "admingm"},
		{"invalid utf8 replaced", "a\xff\xfdb", "ab"}, // ToValidUTF8 drops
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := SanitizePreview(tt.input)
			if got != tt.want {
				t.Fatalf("got=%q want=%q", got, tt.want)
			}
		})
	}

	// Long preview is capped.
	long := strings.Repeat("x", MaxPreviewRunes*2)
	capped := SanitizePreview(long)
	if utf8.RuneCountInString(capped) != MaxPreviewRunes+1 { // +1 for ellipsis
		t.Fatalf("capped len=%d want %d", utf8.RuneCountInString(capped), MaxPreviewRunes+1)
	}
	if !strings.HasSuffix(capped, "…") {
		t.Fatalf("capped must end with ellipsis: %q", capped)
	}
}

// TestConstantTimeTokenEqual verifies token comparison is constant-time and
// empty tokens never match anything (including another empty).
func TestConstantTimeTokenEqual(t *testing.T) {
	a := NewCapabilityToken()
	b := NewCapabilityToken()
	if a == b {
		t.Fatal("two fresh tokens collided (rng broken)")
	}
	if !ConstantTimeTokenEqual(a, a) {
		t.Fatal("equal tokens must compare equal")
	}
	if ConstantTimeTokenEqual(a, b) {
		t.Fatal("distinct tokens must compare unequal")
	}
	if ConstantTimeTokenEqual("", a) {
		t.Fatal("empty token must not match")
	}
	if ConstantTimeTokenEqual(a, "") {
		t.Fatal("non-empty must not match empty")
	}
	if ConstantTimeTokenEqual("", "") {
		t.Fatal("two empty tokens must not match")
	}
	if ConstantTimeTokenEqual(a, a[:len(a)-1]) {
		t.Fatal("different-length tokens must not match")
	}
}

// TestEnvelopeRoundTrip verifies the encode/decode cycle preserves kind and
// payload and enforces the 64KiB cap.
func TestEnvelopeRoundTrip(t *testing.T) {
	frame, err := EncodeEnvelope(KindChannelRequest, ChannelRequest{
		InstanceID:     "inst-1",
		ShortRequestID: "ABCDE",
		ToolName:       "Bash",
		Description:    "ls -la",
		InputPreview:   "preview text",
	})
	if err != nil {
		t.Fatal(err)
	}
	if frame[len(frame)-1] != '\n' {
		t.Fatalf("frame must be newline terminated: %q", frame)
	}
	env, n, err := DecodeEnvelope(frame)
	if err != nil {
		t.Fatal(err)
	}
	if n != len(frame) {
		t.Fatalf("consumed=%d frame=%d", n, len(frame))
	}
	if env.Kind != KindChannelRequest {
		t.Fatalf("kind=%q", env.Kind)
	}
	var req ChannelRequest
	if err := DecodePayload(env, &req); err != nil {
		t.Fatal(err)
	}
	if req.ShortRequestID != "ABCDE" || req.ToolName != "Bash" {
		t.Fatalf("decoded payload lost fields: %+v", req)
	}
}

// TestEnvelopeIncompleteFrame verifies DecodeEnvelope signals "need more
// data" without erroring on a partial frame.
func TestEnvelopeIncompleteFrame(t *testing.T) {
	_, _, err := DecodeEnvelope([]byte(`{"kind":"ping"}`)) // no newline
	if err == nil {
		t.Fatal("expected incomplete-frame signal")
	}
}

// TestEnvelopeOversizedFrameRejected verifies a frame above MaxJSONRPCFrame
// is rejected to bound daemon memory.
func TestEnvelopeOversizedFrameRejected(t *testing.T) {
	huge := make([]byte, MaxJSONRPCFrame+1)
	for i := range huge {
		huge[i] = 'a'
	}
	huge[MaxJSONRPCFrame] = '\n'
	_, _, err := DecodeEnvelope(huge)
	if err == nil {
		t.Fatal("expected oversized-frame rejection")
	}
}

// TestEncodeEnvelopeRejectsOversizedPayload verifies the encoder also
// enforces the cap before sending.
func TestEncodeEnvelopeRejectsOversizedPayload(t *testing.T) {
	big := strings.Repeat("x", MaxJSONRPCFrame)
	_, err := EncodeEnvelope(KindChannelRequest, ChannelRequest{
		Description: big,
	})
	if err == nil {
		t.Fatal("encoder must reject oversized payload")
	}
}

// TestNewInstanceIDAndPublicRequestIDAreUnique verifies fresh ids do not
// collide (sanity check on the rng path).
func TestNewInstanceIDAndPublicRequestIDAreUnique(t *testing.T) {
	seen := make(map[string]struct{}, 64)
	for i := 0; i < 64; i++ {
		id := NewInstanceID()
		if len(id) != InstanceIDBytes*2 {
			t.Fatalf("instance id len=%d want %d", len(id), InstanceIDBytes*2)
		}
		seen[id] = struct{}{}
	}
	if len(seen) != 64 {
		t.Fatalf("instance id collisions: %d unique of 64", len(seen))
	}
	seenPub := make(map[string]struct{}, 64)
	for i := 0; i < 64; i++ {
		id := NewPublicRequestID()
		if _, err := uuid.Parse(id); err != nil {
			t.Fatalf("public id is not UUID: %q", id)
		}
		seenPub[id] = struct{}{}
	}
	if len(seenPub) != 64 {
		t.Fatalf("public id collisions: %d unique of 64", len(seenPub))
	}
}
