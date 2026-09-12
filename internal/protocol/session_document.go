package protocol

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	SessionDocumentSnapshotCapability = "session_document_snapshot_v1"

	EventTypeSessionDocumentBegin    = "session_document_begin"
	EventTypeSessionDocumentChunk    = "session_document_chunk"
	EventTypeSessionDocumentCommit   = "session_document_commit"
	EventTypeSessionDocumentsChanged = "session_documents_changed"

	SessionDocumentFormatMarkdown = "markdown"
	SessionDocumentFormatHTML     = "html"

	SessionDocumentStatePending     = "pending"
	SessionDocumentStateUnavailable = "unavailable"

	SessionDocumentReasonTooLarge        = "too_large"
	SessionDocumentReasonInvalidEncoding = "invalid_encoding"
	SessionDocumentReasonPathOutsideRoot = "path_outside_root"
	SessionDocumentReasonUnsupported     = "unsupported"
	SessionDocumentReasonReadFailed      = "read_failed"
)

// IsSessionDocumentUploadEvent reports whether an outbound daemon event carries
// document snapshot protocol state. These records must never be sent until the
// current Relay connection explicitly advertises the snapshot capability.
func IsSessionDocumentUploadEvent(eventType string) bool {
	switch eventType {
	case EventTypeSessionDocumentBegin, EventTypeSessionDocumentChunk, EventTypeSessionDocumentCommit:
		return true
	default:
		return false
	}
}

// SessionDocumentProtocolLimits are negotiated transport bounds. Product
// configuration may choose lower values but must never validate unbounded
// document records.
type SessionDocumentProtocolLimits struct {
	MaxDocumentBytes int
	MaxChunkBytes    int
}

// ValidateSessionDocumentEvent validates the self-contained wire invariants
// for one document record. Cross-record range and begin/commit consistency is
// enforced by Relay's artifact assembler.
func ValidateSessionDocumentEvent(event DaemonEvent, limits SessionDocumentProtocolLimits) error {
	if limits.MaxDocumentBytes <= 0 || limits.MaxChunkBytes <= 0 {
		return fmt.Errorf("session document limits must be positive")
	}
	if err := validateDocumentOpaqueID("session_id", event.SessionID, 128); err != nil {
		return err
	}
	if err := validateDocumentOpaqueID("document_id", event.DocumentID, 128); err != nil {
		return err
	}

	switch event.Type {
	case EventTypeSessionDocumentBegin:
		return validateSessionDocumentBegin(event, limits)
	case EventTypeSessionDocumentChunk:
		return validateSessionDocumentChunk(event, limits)
	case EventTypeSessionDocumentCommit:
		return validateSessionDocumentCommit(event, limits)
	case EventTypeSessionDocumentsChanged:
		return validateSessionDocumentsChanged(event)
	default:
		return fmt.Errorf("type: unsupported session document event %q", event.Type)
	}
}

func validateSessionDocumentBegin(event DaemonEvent, limits SessionDocumentProtocolLimits) error {
	if err := validateDocumentOpaqueID("event_id", event.EventID, 256); err != nil {
		return err
	}
	if !validDocumentDisplayName(event.DisplayName) {
		return fmt.Errorf("display_name: must be a bounded basename")
	}
	if event.DocumentFormat != SessionDocumentFormatMarkdown && event.DocumentFormat != SessionDocumentFormatHTML {
		return fmt.Errorf("document_format: unsupported value %q", event.DocumentFormat)
	}
	if err := validateDocumentOpaqueID("source_event_id", event.SourceEventID, 256); err != nil {
		return err
	}
	if err := validateDocumentOpaqueID("turn_id", event.TurnID, 128); err != nil {
		return err
	}
	if _, err := time.Parse(time.RFC3339Nano, event.CapturedAt); err != nil {
		return fmt.Errorf("captured_at: invalid RFC3339 timestamp")
	}
	if event.ChunkData != "" || event.ChunkHash != "" || event.ChunkIndex != nil || event.ByteOffset != nil {
		return fmt.Errorf("chunk_data: begin must not carry chunk content")
	}

	state := event.DocumentState
	if state == "" {
		state = SessionDocumentStatePending
	}
	if state == SessionDocumentStateUnavailable {
		if !validDocumentUnavailableReason(event.DocumentReason) {
			return fmt.Errorf("document_reason: unsupported unavailable reason %q", event.DocumentReason)
		}
		if event.VersionID != "" || event.TotalBytes != 0 || event.ContentHash != "" || event.ChunkCount != 0 {
			return fmt.Errorf("version_id: unavailable begin must not carry version content metadata")
		}
		return nil
	}
	if state != SessionDocumentStatePending {
		return fmt.Errorf("document_state: unsupported value %q", event.DocumentState)
	}
	if event.DocumentReason != "" {
		return fmt.Errorf("document_reason: pending begin must not carry a failure reason")
	}
	if err := validateDocumentOpaqueID("version_id", event.VersionID, 128); err != nil {
		return err
	}
	if event.TotalBytes < 0 || event.TotalBytes > limits.MaxDocumentBytes {
		return fmt.Errorf("total_bytes: outside negotiated document limit")
	}
	if !validSHA256(event.ContentHash) {
		return fmt.Errorf("content_hash: must be a lowercase SHA-256 digest")
	}
	if event.TotalBytes == 0 && event.ChunkCount != 0 {
		return fmt.Errorf("chunk_count: empty document must have zero chunks")
	}
	if event.TotalBytes > 0 && event.ChunkCount <= 0 {
		return fmt.Errorf("chunk_count: non-empty document must declare chunks")
	}
	return nil
}

func validateSessionDocumentChunk(event DaemonEvent, limits SessionDocumentProtocolLimits) error {
	if err := validateDocumentOpaqueID("event_id", event.EventID, 256); err != nil {
		return err
	}
	if err := validateDocumentOpaqueID("version_id", event.VersionID, 128); err != nil {
		return err
	}
	if event.ChunkIndex == nil || *event.ChunkIndex < 0 {
		return fmt.Errorf("chunk_index: missing or negative")
	}
	if event.ByteOffset == nil || *event.ByteOffset < 0 {
		return fmt.Errorf("byte_offset: missing or negative")
	}
	decoded, err := base64.StdEncoding.Strict().DecodeString(event.ChunkData)
	if err != nil || len(decoded) == 0 || len(decoded) > limits.MaxChunkBytes {
		return fmt.Errorf("chunk_data: invalid base64 or decoded size")
	}
	if !validSHA256(event.ChunkHash) {
		return fmt.Errorf("chunk_hash: must be a lowercase SHA-256 digest")
	}
	digest := sha256.Sum256(decoded)
	if event.ChunkHash != hex.EncodeToString(digest[:]) {
		return fmt.Errorf("chunk_hash: digest does not match decoded bytes")
	}
	return nil
}

func validateSessionDocumentCommit(event DaemonEvent, limits SessionDocumentProtocolLimits) error {
	if err := validateDocumentOpaqueID("event_id", event.EventID, 256); err != nil {
		return err
	}
	if err := validateDocumentOpaqueID("version_id", event.VersionID, 128); err != nil {
		return err
	}
	if event.TotalBytes < 0 || event.TotalBytes > limits.MaxDocumentBytes {
		return fmt.Errorf("total_bytes: outside negotiated document limit")
	}
	if !validSHA256(event.ContentHash) {
		return fmt.Errorf("content_hash: must be a lowercase SHA-256 digest")
	}
	if event.ChunkData != "" {
		return fmt.Errorf("chunk_data: commit must not carry document content")
	}
	return nil
}

func validateSessionDocumentsChanged(event DaemonEvent) error {
	if err := validateDocumentOpaqueID("version_id", event.VersionID, 128); err != nil {
		return err
	}
	if event.ChunkData != "" || event.ChunkHash != "" {
		return fmt.Errorf("chunk_data: change notification must not carry document content")
	}
	return nil
}

func validateDocumentOpaqueID(field, value string, maxBytes int) error {
	if value == "" || len(value) > maxBytes || !utf8.ValidString(value) {
		return fmt.Errorf("%s: missing or too long", field)
	}
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') ||
			(r >= '0' && r <= '9') || strings.ContainsRune("._:-", r) {
			continue
		}
		return fmt.Errorf("%s: contains an invalid character", field)
	}
	return nil
}

func validDocumentDisplayName(value string) bool {
	if value == "" || len(value) > 255 || !utf8.ValidString(value) ||
		value == "." || value == ".." || filepath.Base(value) != value ||
		strings.ContainsAny(value, "/\\") {
		return false
	}
	for _, r := range value {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

func validSHA256(value string) bool {
	if len(value) != sha256.Size*2 || strings.ToLower(value) != value {
		return false
	}
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == sha256.Size
}

func validDocumentUnavailableReason(value string) bool {
	switch value {
	case SessionDocumentReasonTooLarge,
		SessionDocumentReasonInvalidEncoding,
		SessionDocumentReasonPathOutsideRoot,
		SessionDocumentReasonUnsupported,
		SessionDocumentReasonReadFailed:
		return true
	default:
		return false
	}
}
