package sessiondocument

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strconv"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

const preferredChunkBytes = 48 << 10

type TransportLimits struct {
	MaxEventBytes int
	MaxChunkBytes int
}

func documentRecordID(result CaptureResult, stage string, index int) string {
	identity := result.SourceEventID + "\x00" + result.DocumentID + "\x00" + result.VersionID +
		"\x00" + stage + "\x00" + strconv.Itoa(index)
	return stableID("doc-event-", identity)
}

func unavailableRecord(sessionID string, result CaptureResult) protocol.DaemonEvent {
	return protocol.DaemonEvent{
		Type: protocol.EventTypeSessionDocumentBegin, EventID: documentRecordID(result, "unavailable", 0),
		SessionID: sessionID, TurnID: result.SourceTurnID, DocumentID: result.DocumentID,
		DisplayName: result.DisplayName, DocumentFormat: result.Format,
		DocumentState: protocol.SessionDocumentStateUnavailable, DocumentReason: result.Reason,
		SourceEventID: result.SourceEventID, CapturedAt: result.CapturedAt.Format(timeRFC3339Nano),
	}
}

const timeRFC3339Nano = "2006-01-02T15:04:05.999999999Z07:00"

func recordsForChunkSize(sessionID string, result CaptureResult, chunkBytes int) []protocol.DaemonEvent {
	chunkCount := 0
	if len(result.Bytes) > 0 {
		chunkCount = (len(result.Bytes) + chunkBytes - 1) / chunkBytes
	}
	records := make([]protocol.DaemonEvent, 0, chunkCount+2)
	records = append(records, protocol.DaemonEvent{
		Type: protocol.EventTypeSessionDocumentBegin, EventID: documentRecordID(result, "begin", 0),
		SessionID: sessionID, TurnID: result.SourceTurnID, DocumentID: result.DocumentID,
		VersionID: result.VersionID, DisplayName: result.DisplayName, DocumentFormat: result.Format,
		DocumentState: protocol.SessionDocumentStatePending, SourceEventID: result.SourceEventID,
		CapturedAt: result.CapturedAt.Format(timeRFC3339Nano), TotalBytes: result.ByteSize,
		ContentHash: result.SHA256, ChunkCount: chunkCount,
	})
	for index, offset := 0, 0; offset < len(result.Bytes); index, offset = index+1, offset+chunkBytes {
		end := offset + chunkBytes
		if end > len(result.Bytes) {
			end = len(result.Bytes)
		}
		chunk := result.Bytes[offset:end]
		digest := sha256.Sum256(chunk)
		chunkIndex := index
		byteOffset := offset
		records = append(records, protocol.DaemonEvent{
			Type: protocol.EventTypeSessionDocumentChunk, EventID: documentRecordID(result, "chunk", index),
			SessionID: sessionID, DocumentID: result.DocumentID, VersionID: result.VersionID,
			ChunkIndex: &chunkIndex, ByteOffset: &byteOffset,
			ChunkData: base64.StdEncoding.EncodeToString(chunk), ChunkHash: hex.EncodeToString(digest[:]),
		})
	}
	records = append(records, protocol.DaemonEvent{
		Type: protocol.EventTypeSessionDocumentCommit, EventID: documentRecordID(result, "commit", 0),
		SessionID: sessionID, DocumentID: result.DocumentID, VersionID: result.VersionID,
		TotalBytes: result.ByteSize, ContentHash: result.SHA256,
	})
	return records
}

func recordsFit(records []protocol.DaemonEvent, maxEventBytes int) bool {
	for _, record := range records {
		raw, err := json.Marshal(record)
		if err != nil || len(raw) > maxEventBytes {
			return false
		}
	}
	return true
}

// BuildRecords prepares the complete record set before returning any item, so
// an impossible transport budget cannot enqueue a partial document prefix.
func BuildRecords(sessionID string, result CaptureResult, limits TransportLimits) ([]protocol.DaemonEvent, error) {
	if sessionID == "" || limits.MaxEventBytes <= 0 || limits.MaxChunkBytes <= 0 {
		return nil, errors.New("invalid document transport limits")
	}
	if result.Reason != "" {
		records := []protocol.DaemonEvent{unavailableRecord(sessionID, result)}
		if !recordsFit(records, limits.MaxEventBytes) {
			return nil, errors.New("unavailable document record exceeds transport limit")
		}
		return records, nil
	}
	if result.ByteSize != len(result.Bytes) || result.VersionID == "" || result.SHA256 == "" {
		return nil, errors.New("incomplete document capture result")
	}
	digest := sha256.Sum256(result.Bytes)
	if hex.EncodeToString(digest[:]) != result.SHA256 {
		return nil, errors.New("document capture digest mismatch")
	}
	chunkBytes := limits.MaxChunkBytes
	if chunkBytes > preferredChunkBytes {
		chunkBytes = preferredChunkBytes
	}
	for chunkBytes > 0 {
		records := recordsForChunkSize(sessionID, result, chunkBytes)
		if recordsFit(records, limits.MaxEventBytes) {
			return records, nil
		}
		chunkBytes /= 2
	}
	return nil, errors.New("document records exceed transport limit")
}
