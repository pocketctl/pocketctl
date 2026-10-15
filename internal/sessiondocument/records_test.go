package sessiondocument

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestBuildRecordsBoundsLongNativeSourceWithoutTruncationCollisions(t *testing.T) {
	for _, unavailable := range []bool{false, true} {
		result := CaptureResult{
			DocumentID: "doc-long", VersionID: "ver-long", DisplayName: "report.md",
			Format: protocol.SessionDocumentFormatMarkdown, SourceTurnID: "turn-1",
			SourceEventID: strings.Repeat("x", 256) + "a", CapturedAt: time.Now().UTC(),
			ByteSize: 5, Bytes: []byte("hello"), SHA256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
		}
		if unavailable {
			result.Reason = protocol.SessionDocumentReasonReadFailed
		}
		limits := TransportLimits{MaxEventBytes: 4096, MaxChunkBytes: 64}
		first, err := BuildRecords("s", result, limits)
		if err != nil {
			t.Fatal(err)
		}
		if err := protocol.ValidateSessionDocumentEvent(first[0], protocol.SessionDocumentProtocolLimits{MaxDocumentBytes: 100, MaxChunkBytes: 64}); err != nil {
			t.Fatalf("long native source produced invalid begin (unavailable=%v): %v", unavailable, err)
		}
		repeated, err := BuildRecords("s", result, limits)
		if err != nil || repeated[0].EventID != first[0].EventID || repeated[0].SourceEventID != first[0].SourceEventID {
			t.Fatal("source mapping is unstable")
		}
		if result.SourceEventID != strings.Repeat("x", 256)+"a" {
			t.Fatal("input source was mutated")
		}
		result.SourceEventID = strings.Repeat("x", 256) + "b"
		other, err := BuildRecords("s", result, limits)
		if err != nil || other[0].SourceEventID == first[0].SourceEventID || other[0].EventID == first[0].EventID {
			t.Fatal("long source identities collided")
		}
		result.SourceEventID = strings.Repeat("x", 256)
		boundary, err := BuildRecords("s", result, limits)
		if err != nil || boundary[0].SourceEventID != result.SourceEventID {
			t.Fatal("valid source identity changed")
		}
	}
}

func TestBuildRecordsEncodesBeginBoundedChunksAndCommitWithStableIdentities(t *testing.T) {
	result := CaptureResult{
		DocumentID: "doc-1", VersionID: "ver-1", DisplayName: "report.md",
		Format: protocol.SessionDocumentFormatMarkdown, SourceTurnID: "turn-1",
		SourceEventID: "source-1", CapturedAt: time.Date(2026, 9, 11, 1, 2, 3, 4, time.UTC),
		ByteSize: 10, SHA256: "84d89877f0d4041efb6bf91a16f0248f2fd573e6af05c19f96bedb9f882f7882",
		Bytes: []byte("0123456789"),
	}
	first, err := BuildRecords("session-1", result, TransportLimits{MaxEventBytes: 1024, MaxChunkBytes: 4})
	if err != nil {
		t.Fatal(err)
	}
	second, err := BuildRecords("session-1", result, TransportLimits{MaxEventBytes: 1024, MaxChunkBytes: 4})
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 5 || len(second) != len(first) {
		t.Fatalf("records = %d, want begin + 3 chunks + commit", len(first))
	}
	if first[0].Type != protocol.EventTypeSessionDocumentBegin || first[0].ChunkCount != 3 ||
		first[len(first)-1].Type != protocol.EventTypeSessionDocumentCommit {
		t.Fatalf("unexpected boundary records: first=%+v last=%+v", first[0], first[len(first)-1])
	}
	for index := range first {
		if first[index].EventID == "" || first[index].EventID != second[index].EventID {
			t.Fatalf("unstable event id at %d", index)
		}
		if err := protocol.ValidateSessionDocumentEvent(first[index], protocol.SessionDocumentProtocolLimits{
			MaxDocumentBytes: 100, MaxChunkBytes: 4,
		}); err != nil {
			t.Fatalf("invalid record %d: %v", index, err)
		}
		raw, _ := json.Marshal(first[index])
		if len(raw) > 1024 {
			t.Fatalf("record %d exceeds event limit: %d", index, len(raw))
		}
	}
}

func TestBuildRecordsEmitsMetadataOnlyUnavailableAndNeverAnOversizedPrefix(t *testing.T) {
	unavailable := CaptureResult{
		DocumentID: "doc-1", DisplayName: "report.html", Format: protocol.SessionDocumentFormatHTML,
		SourceTurnID: "turn-1", SourceEventID: "source-1", CapturedAt: time.Now().UTC(),
		Reason: protocol.SessionDocumentReasonTooLarge,
	}
	records, err := BuildRecords("session-1", unavailable, TransportLimits{MaxEventBytes: 1024, MaxChunkBytes: 64})
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 1 || records[0].DocumentState != protocol.SessionDocumentStateUnavailable ||
		records[0].DocumentReason != protocol.SessionDocumentReasonTooLarge || records[0].ChunkData != "" {
		t.Fatalf("unexpected unavailable record: %+v", records)
	}

	tooSmall := unavailable
	tooSmall.Reason = ""
	tooSmall.VersionID = "ver-1"
	tooSmall.ByteSize = 5
	tooSmall.Bytes = []byte("hello")
	tooSmall.SHA256 = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
	if built, err := BuildRecords("session-1", tooSmall, TransportLimits{MaxEventBytes: 32, MaxChunkBytes: 4}); err == nil || len(built) != 0 {
		t.Fatalf("oversized transport admitted a prefix: records=%d err=%v", len(built), err)
	}
}
