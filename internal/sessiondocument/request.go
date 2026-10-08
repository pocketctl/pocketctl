package sessiondocument

import (
	"strings"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

// CaptureRequestedDocument is an explicit user read, not inferred agent output.
// The caller supplies a session-owned, locally authorized root; all filesystem
// reads still go through Capture's no-symlink, size, encoding and race checks.
func CaptureRequestedDocument(root, sessionID, requestID, nativePath string, maxBytes int) CaptureResult {
	denied := CaptureResult{Reason: protocol.SessionDocumentReasonPathOutsideRoot}
	if sessionID == "" || requestID == "" || len(requestID) > 128 || strings.Contains(nativePath, "://") {
		return denied
	}
	canonical, relative, ok := ResolvePathWithinRoot(root, nativePath)
	if !ok {
		return denied
	}
	source := "document-request:" + requestID
	candidate, ok := CandidateFromPath(sessionID, source, source, source, relative)
	if !ok {
		return denied
	}
	return Capture(canonical, candidate, maxBytes)
}
