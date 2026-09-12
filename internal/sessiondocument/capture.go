package sessiondocument

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"path"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

var (
	errUnsafePath = errors.New("unsafe document path")
	errNonRegular = errors.New("document is not a regular file")
)

type Candidate struct {
	SessionID     string
	TurnID        string
	ChangeSetID   string
	SourceEventID string
	RelativePath  string
	DisplayName   string
	Format        string
}

type CaptureResult struct {
	SessionID     string
	DocumentID    string
	VersionID     string
	DisplayName   string
	Format        string
	SourceTurnID  string
	SourceEventID string
	CapturedAt    time.Time
	ByteSize      int
	SHA256        string
	Bytes         []byte
	Reason        string
	Transport     TransportLimits
}

func CandidateFromEvent(event protocol.DaemonEvent) (Candidate, bool) {
	if event.Type != "agent_file_change" || event.Status != "completed" ||
		event.SessionID == "" || event.TurnID == "" || event.ChangeSetID == "" || event.EventID == "" ||
		event.Source == "observer" || event.Agent == "zcode" {
		return Candidate{}, false
	}
	if event.ChangeKind != protocol.FileChangeCreate && event.ChangeKind != protocol.FileChangeUpdate &&
		event.ChangeKind != protocol.FileChangeMove {
		return Candidate{}, false
	}
	candidatePath := event.Path
	if event.ChangeKind == protocol.FileChangeMove {
		candidatePath = event.MovePath
	}
	normalized, ok := normalizeRelativePath(candidatePath)
	if !ok {
		return Candidate{}, false
	}
	format, ok := documentFormat(normalized)
	if !ok {
		return Candidate{}, false
	}
	displayName := path.Base(normalized)
	if !utf8.ValidString(displayName) || len(displayName) == 0 || len(displayName) > 255 {
		return Candidate{}, false
	}
	return Candidate{
		SessionID: event.SessionID, TurnID: event.TurnID, ChangeSetID: event.ChangeSetID,
		SourceEventID: event.EventID, RelativePath: normalized, DisplayName: displayName, Format: format,
	}, true
}

func normalizeRelativePath(value string) (string, bool) {
	if value == "" || len(value) > 4096 || strings.ContainsRune(value, '\x00') {
		return "", false
	}
	value = strings.ReplaceAll(value, `\`, "/")
	if strings.HasPrefix(value, "/") || strings.HasPrefix(value, "//") ||
		(len(value) >= 2 && value[1] == ':' && ((value[0] >= 'A' && value[0] <= 'Z') || (value[0] >= 'a' && value[0] <= 'z'))) {
		return "", false
	}
	normalized := path.Clean(value)
	if normalized == "." || normalized == ".." || strings.HasPrefix(normalized, "../") {
		return "", false
	}
	return normalized, true
}

func documentFormat(relativePath string) (string, bool) {
	switch strings.ToLower(path.Ext(relativePath)) {
	case ".md", ".markdown":
		return protocol.SessionDocumentFormatMarkdown, true
	case ".html", ".htm":
		return protocol.SessionDocumentFormatHTML, true
	default:
		return "", false
	}
}

func stableID(prefix, value string) string {
	digest := sha256.Sum256([]byte(value))
	return prefix + hex.EncodeToString(digest[:16])
}

func unavailableResult(candidate Candidate, reason string) CaptureResult {
	return CaptureResult{
		SessionID:   candidate.SessionID,
		DocumentID:  stableID("doc-", candidate.SessionID+"\x00"+candidate.RelativePath),
		DisplayName: candidate.DisplayName, Format: candidate.Format,
		SourceTurnID: candidate.TurnID, SourceEventID: candidate.SourceEventID,
		CapturedAt: time.Now().UTC(), Reason: reason,
	}
}

func Capture(root string, candidate Candidate, maxDocumentBytes int) CaptureResult {
	result := unavailableResult(candidate, "")
	normalized, ok := normalizeRelativePath(candidate.RelativePath)
	if !ok || normalized != candidate.RelativePath || maxDocumentBytes <= 0 {
		result.Reason = protocol.SessionDocumentReasonPathOutsideRoot
		return result
	}
	file, err := secureOpenRegular(root, filepath.FromSlash(normalized))
	if err != nil {
		if errors.Is(err, errUnsafePath) {
			result.Reason = protocol.SessionDocumentReasonPathOutsideRoot
		} else if errors.Is(err, errNonRegular) {
			result.Reason = protocol.SessionDocumentReasonUnsupported
		} else {
			result.Reason = protocol.SessionDocumentReasonReadFailed
		}
		return result
	}
	defer file.Close()
	before, err := file.Stat()
	if err != nil || !before.Mode().IsRegular() {
		result.Reason = protocol.SessionDocumentReasonUnsupported
		return result
	}
	bytes, err := io.ReadAll(io.LimitReader(file, int64(maxDocumentBytes)+1))
	if err != nil {
		result.Reason = protocol.SessionDocumentReasonReadFailed
		return result
	}
	if len(bytes) > maxDocumentBytes {
		result.Reason = protocol.SessionDocumentReasonTooLarge
		return result
	}
	after, err := file.Stat()
	if err != nil || before.Size() != int64(len(bytes)) || after.Size() != before.Size() ||
		!after.ModTime().Equal(before.ModTime()) {
		result.Reason = protocol.SessionDocumentReasonReadFailed
		return result
	}
	if !utf8.Valid(bytes) {
		result.Reason = protocol.SessionDocumentReasonInvalidEncoding
		return result
	}
	digest := sha256.Sum256(bytes)
	result.SHA256 = hex.EncodeToString(digest[:])
	result.VersionID = stableID("ver-", result.DocumentID+"\x00"+result.SHA256)
	result.ByteSize = len(bytes)
	result.Bytes = bytes
	return result
}
