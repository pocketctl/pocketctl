package session

import (
	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/sessiondocument"
)

// ResolveOpencodeDocumentCandidate preserves the session directory's original
// spelling (e.g. macOS /var vs /private/var) while validating its canonical root.
func (sm *SessionManager) ResolveOpencodeDocumentCandidate(source adapter.OpencodeDocumentCandidate) (string, sessiondocument.Candidate, bool) {
	authorized, ok := sm.GetDocumentCaptureRoot(source.SessionID)
	if !ok {
		return "", sessiondocument.Candidate{}, false
	}
	directory, _ := sm.GetSessionCwd(source.SessionID)
	if worktree, _, ok := sm.GetWorktreeInfo(source.SessionID); ok {
		directory = worktree
	}
	root, relative, ok := sessiondocument.ResolvePathWithinRoot(directory, source.FilePath)
	if !ok || root != authorized {
		return "", sessiondocument.Candidate{}, false
	}
	candidate, ok := sessiondocument.CandidateFromPath(source.SessionID, source.TurnID, source.ChangeSetID, source.SourceEventID, relative)
	return root, candidate, ok
}

// SetOpencodeDocumentCapture installs the optional local snapshot sink. A false
// result requests a retry on the next idle message poll (capability/backpressure).
func (sm *SessionManager) SetOpencodeDocumentCapture(capture func(adapter.OpencodeDocumentCandidate) bool) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	sm.opencodeDocumentCapture = capture
}

func (sm *SessionManager) captureOpencodeDocuments(sessionID string, messages []adapter.OpencodeMessageWithParts, status *adapter.OpencodeSessionStatus, accepted map[string]string) {
	sm.mu.RLock()
	capture := sm.opencodeDocumentCapture
	sm.mu.RUnlock()
	if capture == nil {
		return
	}
	directory, _ := sm.GetSessionCwd(sessionID)
	if worktree, _, ok := sm.GetWorktreeInfo(sessionID); ok {
		directory = worktree
	}
	candidates := adapter.OpencodeDocumentCandidates(sessionID, directory, messages, status)
	if candidates == nil {
		return
	}
	current := make(map[string]bool, len(candidates))
	for _, candidate := range candidates {
		current[candidate.FilePath] = true
		if accepted[candidate.FilePath] == candidate.SourceEventID {
			continue
		}
		if capture(candidate) {
			accepted[candidate.FilePath] = candidate.SourceEventID
		}
	}
	for path := range accepted {
		if !current[path] {
			delete(accepted, path)
		}
	}
}
