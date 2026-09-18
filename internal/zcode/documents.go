package zcode

import (
	"encoding/json"
	"path/filepath"
	"strings"

	"github.com/pocketctl/pocketctl/internal/turn"
)

const (
	maxDocumentCandidatesPerSession = 50
	documentToolQueryLimit          = maxDocumentCandidatesPerSession
)

// DocumentCandidate is a local-only, strongly attributed ZCode file write.
// Native paths never leave the daemon; main binds FilePath to SessionDirectory
// before handing a normalized relative path to the document capture package.
type DocumentCandidate struct {
	SessionID        string
	SessionDirectory string
	TurnID           string
	ChangeSetID      string
	SourceEventID    string
	FilePath         string
}

// DocumentCaptureFunc attempts to schedule a document snapshot. False means
// retry later (for example, Relay capability negotiation or local backpressure
// is not ready yet).
type DocumentCaptureFunc func(DocumentCandidate) bool

type documentToolInput struct {
	FilePath string `json:"file_path"`
}

func documentPathFromPart(part ZcodePartData) (string, bool) {
	if part.Type != "tool" || part.State == nil || part.State.Status != "completed" ||
		(part.Tool != "Write" && part.Tool != "Edit") || len(part.State.Input) == 0 {
		return "", false
	}
	var input documentToolInput
	if err := json.Unmarshal(part.State.Input, &input); err != nil {
		return "", false
	}
	input.FilePath = strings.TrimSpace(input.FilePath)
	if input.FilePath == "" || len(input.FilePath) > 4096 || strings.ContainsRune(input.FilePath, '\x00') {
		return "", false
	}
	switch strings.ToLower(filepath.Ext(input.FilePath)) {
	case ".md", ".markdown", ".html", ".htm":
		return input.FilePath, true
	default:
		return "", false
	}
}

func documentCandidateFromRow(sourceID, wireSessionID, sessionDirectory string, row PartRow) (DocumentCandidate, bool) {
	if !row.Msg.Visible() || row.Msg.Role != "assistant" {
		return DocumentCandidate{}, false
	}
	part, ok := DecodePartData(row.DataJSON)
	if !ok {
		return DocumentCandidate{}, false
	}
	filePath, ok := documentPathFromPart(part)
	if !ok {
		return DocumentCandidate{}, false
	}
	event, reason := NewMapper(sourceID).MapPart(
		wireSessionID,
		WireMessageID(sourceID, row.MessageID),
		row.ID,
		part,
		"",
		"",
		1,
	)
	if reason != "" || event.EventID == "" {
		return DocumentCandidate{}, false
	}
	return DocumentCandidate{
		SessionID:        wireSessionID,
		SessionDirectory: sessionDirectory,
		TurnID:           turn.LogicalTurnID("zcode", wireSessionID, "", "source_message", row.MessageID),
		ChangeSetID:      "zcode-docset-" + hashWithSource(sourceID, row.ID),
		SourceEventID:    event.EventID,
		FilePath:         filePath,
	}, true
}
