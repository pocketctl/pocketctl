package protocol

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
)

func TestSessionDocumentBeginRoundTripAndValidation(t *testing.T) {
	emptyDigest := sha256.Sum256(nil)
	event := DaemonEvent{
		Type: EventTypeSessionDocumentBegin, SessionID: "session-1",
		EventID: "document:begin:1", DocumentID: "doc_0123456789abcdef",
		VersionID: "ver_0123456789abcdef", DisplayName: "report.md",
		DocumentFormat: SessionDocumentFormatMarkdown,
		SourceEventID:  "codex:file-change:abc", TurnID: "turn-1",
		TotalBytes: 0, ContentHash: hex.EncodeToString(emptyDigest[:]),
		CapturedAt: "2026-09-11T12:30:00Z", ChunkCount: 0,
	}
	if err := ValidateSessionDocumentEvent(event, SessionDocumentProtocolLimits{
		MaxDocumentBytes: 2 << 20, MaxChunkBytes: 48 << 10,
	}); err != nil {
		t.Fatalf("valid empty begin rejected: %v", err)
	}
	raw, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	var decoded DaemonEvent
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.DocumentID != event.DocumentID || decoded.VersionID != event.VersionID ||
		decoded.DisplayName != event.DisplayName || decoded.DocumentFormat != event.DocumentFormat ||
		decoded.SourceEventID != event.SourceEventID || decoded.CapturedAt != event.CapturedAt ||
		decoded.ChunkCount != 0 {
		t.Fatalf("document begin did not round-trip: %+v", decoded)
	}
}

func TestSessionDocumentBeginRejectsMalformedMetadata(t *testing.T) {
	valid := validDocumentBeginEvent()
	tests := []struct {
		name string
		edit func(*DaemonEvent)
		want string
	}{
		{name: "missing session", edit: func(e *DaemonEvent) { e.SessionID = "" }, want: "session_id"},
		{name: "bad document id", edit: func(e *DaemonEvent) { e.DocumentID = "../report" }, want: "document_id"},
		{name: "bad version id", edit: func(e *DaemonEvent) { e.VersionID = strings.Repeat("v", 130) }, want: "version_id"},
		{name: "path in display name", edit: func(e *DaemonEvent) { e.DisplayName = "docs/report.md" }, want: "display_name"},
		{name: "unsupported format", edit: func(e *DaemonEvent) { e.DocumentFormat = "svg" }, want: "document_format"},
		{name: "missing source event", edit: func(e *DaemonEvent) { e.SourceEventID = "" }, want: "source_event_id"},
		{name: "missing turn", edit: func(e *DaemonEvent) { e.TurnID = "" }, want: "turn_id"},
		{name: "invalid time", edit: func(e *DaemonEvent) { e.CapturedAt = "yesterday" }, want: "captured_at"},
		{name: "invalid digest", edit: func(e *DaemonEvent) { e.ContentHash = "abc" }, want: "content_hash"},
		{name: "negative size", edit: func(e *DaemonEvent) { e.TotalBytes = -1 }, want: "total_bytes"},
		{name: "over size", edit: func(e *DaemonEvent) { e.TotalBytes = (2 << 20) + 1 }, want: "total_bytes"},
		{name: "zero chunks for content", edit: func(e *DaemonEvent) { e.ChunkCount = 0 }, want: "chunk_count"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			event := valid
			tt.edit(&event)
			err := ValidateSessionDocumentEvent(event, SessionDocumentProtocolLimits{
				MaxDocumentBytes: 2 << 20, MaxChunkBytes: 48 << 10,
			})
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("error=%v, want field %q", err, tt.want)
			}
		})
	}
}

func TestSessionDocumentUnavailableBeginCarriesNoVersionOrBody(t *testing.T) {
	event := validDocumentBeginEvent()
	event.DocumentState = SessionDocumentStateUnavailable
	event.DocumentReason = SessionDocumentReasonTooLarge
	event.VersionID = ""
	event.TotalBytes = 0
	event.ContentHash = ""
	event.ChunkCount = 0
	if err := ValidateSessionDocumentEvent(event, SessionDocumentProtocolLimits{
		MaxDocumentBytes: 2 << 20, MaxChunkBytes: 48 << 10,
	}); err != nil {
		t.Fatalf("metadata-only unavailable begin rejected: %v", err)
	}
	event.ChunkData = base64.StdEncoding.EncodeToString([]byte("must not leak"))
	if err := ValidateSessionDocumentEvent(event, SessionDocumentProtocolLimits{
		MaxDocumentBytes: 2 << 20, MaxChunkBytes: 48 << 10,
	}); err == nil || !strings.Contains(err.Error(), "chunk_data") {
		t.Fatalf("unavailable begin body error=%v", err)
	}
}

func TestSessionDocumentChunkValidatesEncodedBytesAndDigest(t *testing.T) {
	content := []byte("hello document")
	digest := sha256.Sum256(content)
	chunkIndex, byteOffset := 0, 0
	event := DaemonEvent{
		Type: EventTypeSessionDocumentChunk, SessionID: "session-1",
		EventID: "document:chunk:1:0", DocumentID: "doc_0123456789abcdef",
		VersionID: "ver_0123456789abcdef", ChunkIndex: &chunkIndex,
		ByteOffset: &byteOffset, ChunkData: base64.StdEncoding.EncodeToString(content),
		ChunkHash: hex.EncodeToString(digest[:]),
	}
	limits := SessionDocumentProtocolLimits{MaxDocumentBytes: 2 << 20, MaxChunkBytes: len(content)}
	if err := ValidateSessionDocumentEvent(event, limits); err != nil {
		t.Fatalf("valid chunk rejected: %v", err)
	}

	tests := []struct {
		name string
		edit func(*DaemonEvent)
		want string
	}{
		{name: "missing index", edit: func(e *DaemonEvent) { e.ChunkIndex = nil }, want: "chunk_index"},
		{name: "negative index", edit: func(e *DaemonEvent) { n := -1; e.ChunkIndex = &n }, want: "chunk_index"},
		{name: "missing offset", edit: func(e *DaemonEvent) { e.ByteOffset = nil }, want: "byte_offset"},
		{name: "negative offset", edit: func(e *DaemonEvent) { n := -1; e.ByteOffset = &n }, want: "byte_offset"},
		{name: "invalid base64", edit: func(e *DaemonEvent) { e.ChunkData = "%%%" }, want: "chunk_data"},
		{name: "oversized decoded bytes", edit: func(e *DaemonEvent) { e.ChunkData = base64.StdEncoding.EncodeToString(append(content, '!')) }, want: "chunk_data"},
		{name: "digest mismatch", edit: func(e *DaemonEvent) { e.ChunkHash = strings.Repeat("0", 64) }, want: "chunk_hash"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			candidate := event
			tt.edit(&candidate)
			err := ValidateSessionDocumentEvent(candidate, limits)
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("error=%v, want field %q", err, tt.want)
			}
		})
	}
}

func TestSessionDocumentCommitAndChangedValidation(t *testing.T) {
	begin := validDocumentBeginEvent()
	commit := DaemonEvent{
		Type: EventTypeSessionDocumentCommit, SessionID: begin.SessionID,
		EventID: "document:commit:1", DocumentID: begin.DocumentID,
		VersionID: begin.VersionID, TotalBytes: begin.TotalBytes,
		ContentHash: begin.ContentHash,
	}
	limits := SessionDocumentProtocolLimits{MaxDocumentBytes: 2 << 20, MaxChunkBytes: 48 << 10}
	if err := ValidateSessionDocumentEvent(commit, limits); err != nil {
		t.Fatalf("valid commit rejected: %v", err)
	}
	changed := DaemonEvent{
		Type: EventTypeSessionDocumentsChanged, SessionID: begin.SessionID,
		DocumentID: begin.DocumentID, VersionID: begin.VersionID,
	}
	if err := ValidateSessionDocumentEvent(changed, limits); err != nil {
		t.Fatalf("valid changed notification rejected: %v", err)
	}
	changed.ChunkData = base64.StdEncoding.EncodeToString([]byte("body"))
	if err := ValidateSessionDocumentEvent(changed, limits); err == nil || !strings.Contains(err.Error(), "chunk_data") {
		t.Fatalf("body-bearing changed notification error=%v", err)
	}
}

func validDocumentBeginEvent() DaemonEvent {
	content := []byte("hello document")
	digest := sha256.Sum256(content)
	return DaemonEvent{
		Type: EventTypeSessionDocumentBegin, SessionID: "session-1",
		EventID: "document:begin:1", DocumentID: "doc_0123456789abcdef",
		VersionID: "ver_0123456789abcdef", DisplayName: "report.html",
		DocumentFormat: SessionDocumentFormatHTML,
		DocumentState:  SessionDocumentStatePending,
		SourceEventID:  "codex:file-change:abc", TurnID: "turn-1",
		TotalBytes: len(content), ContentHash: hex.EncodeToString(digest[:]),
		CapturedAt: "2026-09-11T12:30:00Z", ChunkCount: 1,
	}
}
