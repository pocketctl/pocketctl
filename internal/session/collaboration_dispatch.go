package session

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/memorycontext"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

var (
	ErrCollaborationAuthorization = errors.New("collaboration_authorization_invalid")
	ErrCollaborationBinding       = errors.New("collaboration_binding_mismatch")
	ErrCollaborationDuplicateCall = errors.New("collaboration_call_already_processed")
	ErrCollaborationSessionBusy   = errors.New("collaboration_session_busy")
)

type collaborationNativeBinding struct {
	NativeSessionID string
	TeamSessionID   string
	BindingID       string
	BindingRevision int64
	OfferID         string
	OfferRevision   int64
	OwnerUserID     int
	DaemonID        string
	Agent           string
}

func ValidateCollaborationAuthorization(auth *protocol.CollaborationAuthorization, operation string) error {
	if auth == nil || auth.ProtocolVersion != protocol.TeamCollaborationProtocolV1 || auth.Operation != operation ||
		auth.CallID == "" || auth.TeamSessionID == "" || auth.BindingID == "" || auth.BindingRevision <= 0 ||
		auth.OfferID == "" || auth.OfferRevision <= 0 || auth.OwnerUserID <= 0 || auth.DaemonID == "" {
		return ErrCollaborationAuthorization
	}
	return nil
}

func collaborationWorkspace(root, bindingID string) string {
	digest := sha256.Sum256([]byte(bindingID))
	return filepath.Join(root, ".pocketctl", "team", fmt.Sprintf("%x", digest[:12]))
}

func prepareCollaborationContext(value *protocol.CollaborationContext) (*memorycontext.PreparedContext, error) {
	if value == nil {
		return nil, nil
	}
	payload := value.StableText
	if value.MemoryContext != nil {
		payload += "\n" + collaborationMemorySelectionText(value.MemoryContext)
	}
	digest := sha256.Sum256([]byte(payload))
	if value.SchemaVersion != 1 || value.ContextVersion < 0 || value.HistoryThroughEventSeq < 0 ||
		len(value.ContentHash) != 64 || len(value.PayloadHash) != 64 || hex.EncodeToString(digest[:]) != value.PayloadHash {
		return nil, ErrCollaborationAuthorization
	}
	return &memorycontext.PreparedContext{StableText: value.StableText, StableDigest: value.PayloadHash}, nil
}

func collaborationMemorySelectionText(value *protocol.CollaborationMemoryContext) string {
	lines := []string{fmt.Sprintf("%d|%s|%s", value.SchemaVersion, value.InstallationID, value.OwnerScopeID)}
	for _, reference := range value.References {
		lines = append(lines, fmt.Sprintf("%s|%s|%s|%s|%s",
			reference.SourceKind, reference.SourceID, reference.SourceVersion,
			reference.OwnerScopeID, reference.InstallationID))
	}
	return strings.Join(lines, "\n")
}

func (sm *SessionManager) prepareCollaborationMemoryContext(ctx context.Context, value *protocol.CollaborationContext, nativeSessionID, agent, content, requestID string) (*memorycontext.PreparedContext, memorycontext.Outcome) {
	if value == nil || value.MemoryContext == nil || len(value.MemoryContext.References) == 0 {
		return nil, memorycontext.Outcome{Kind: "skipped", Reason: "not_selected"}
	}
	memorySelection := value.MemoryContext
	if memorySelection.SchemaVersion != 1 || memorySelection.InstallationID == "" || memorySelection.OwnerScopeID == "" {
		return nil, memorycontext.Outcome{Kind: "skipped", Reason: "unreadable"}
	}
	sm.mu.RLock()
	coordinator := sm.memoryContext
	ready := sm.memoryContextReady
	sm.mu.RUnlock()
	if coordinator == nil || ready == nil || !ready() {
		return nil, memorycontext.Outcome{Kind: "skipped", Reason: "memory_unavailable"}
	}
	references := make([]memorycontext.SelectedReference, 0, len(memorySelection.References))
	for _, reference := range memorySelection.References {
		if reference.InstallationID != memorySelection.InstallationID || reference.OwnerScopeID != memorySelection.OwnerScopeID {
			return nil, memorycontext.Outcome{Kind: "skipped", Reason: "unreadable"}
		}
		references = append(references, memorycontext.SelectedReference{
			SourceKind: reference.SourceKind, SourceID: reference.SourceID,
			SourceVersion: reference.SourceVersion, OwnerScopeID: reference.OwnerScopeID,
			InstallationID: reference.InstallationID,
		})
	}
	return coordinator.Prepare(ctx, memorycontext.TurnRequest{
		ClientRequestID: requestID, SessionID: nativeSessionID, Agent: agent,
		Cwd: sm.cwdFor(nativeSessionID), UserContent: content, IsNewTurn: true,
		Mode:                 memorycontext.ModeEnabled,
		Capability:           sm.MemoryContextCapability(ctx, nativeSessionID, agent),
		ScopeInstallationIDs: []string{memorySelection.InstallationID},
		SelectedReferences:   references,
	})
}

func mergeCollaborationContext(base, selected *memorycontext.PreparedContext) *memorycontext.PreparedContext {
	if selected == nil {
		return base
	}
	if base != nil && base.StableText != "" {
		if selected.StableText != "" {
			selected.StableText = base.StableText + "\n\n" + selected.StableText
		} else {
			selected.StableText = base.StableText
		}
	}
	return selected
}

func collaborationInitialPrompt(content string, value *protocol.CollaborationContext) (string, error) {
	prepared, err := prepareCollaborationContext(value)
	if err != nil || prepared == nil {
		return content, err
	}
	return prepared.StableText + "\n\n[Current Team request]\n" + content, nil
}

// CreateCollaborationSession creates a daemon-local session in an isolated,
// operator-authorized directory. No remote cwd or private session ID is accepted.
func (sm *SessionManager) CreateCollaborationSession(ctx context.Context, auth *protocol.CollaborationAuthorization, teamContext *protocol.CollaborationContext, agent, content string) (string, error) {
	if err := ValidateCollaborationAuthorization(auth, "create"); err != nil {
		return "", err
	}
	if agent != adapter.AgentCodex && agent != adapter.AgentClaude {
		return "", fmt.Errorf("%w: unsupported provider", ErrCollaborationAuthorization)
	}
	sm.mu.RLock()
	policy := sm.cwdPolicy
	sm.mu.RUnlock()
	roots := policy.Roots()
	if len(roots) == 0 {
		return "", fmt.Errorf("%w: no daemon-local workspace root", ErrCwdNotAuthorized)
	}

	sm.collaborationMu.Lock()
	if sm.collaborationBindings == nil {
		sm.collaborationBindings = make(map[string]collaborationNativeBinding)
		sm.collaborationCalls = make(map[string]string)
	}
	if _, exists := sm.collaborationBindings[auth.BindingID]; exists {
		sm.collaborationMu.Unlock()
		return "", ErrCollaborationBinding
	}
	sm.collaborationBindings[auth.BindingID] = collaborationNativeBinding{
		NativeSessionID: "creating", TeamSessionID: auth.TeamSessionID, BindingID: auth.BindingID,
		BindingRevision: auth.BindingRevision, OfferID: auth.OfferID, OfferRevision: auth.OfferRevision,
		OwnerUserID: auth.OwnerUserID, DaemonID: auth.DaemonID, Agent: agent,
	}
	sm.collaborationMu.Unlock()

	prompt, err := collaborationInitialPrompt(content, teamContext)
	if err != nil {
		sm.collaborationMu.Lock()
		if sm.collaborationBindings[auth.BindingID].NativeSessionID == "creating" {
			delete(sm.collaborationBindings, auth.BindingID)
		}
		sm.collaborationMu.Unlock()
		return "", err
	}
	selectedMemory := teamContext != nil && teamContext.MemoryContext != nil
	initialPrompt := prompt
	if selectedMemory {
		initialPrompt = ""
	}
	nativeSessionID, err := sm.CreateSession(ctx, protocol.SessionConfig{
		Agent: agent, Cwd: collaborationWorkspace(roots[0], auth.BindingID), Prompt: initialPrompt, AutoCreateDir: true,
	})
	if err != nil {
		return "", err
	}
	sm.collaborationMu.Lock()
	sm.collaborationBindings[auth.BindingID] = collaborationNativeBinding{
		NativeSessionID: nativeSessionID, TeamSessionID: auth.TeamSessionID,
		BindingID: auth.BindingID, BindingRevision: auth.BindingRevision,
		OfferID: auth.OfferID, OfferRevision: auth.OfferRevision,
		OwnerUserID: auth.OwnerUserID, DaemonID: auth.DaemonID, Agent: agent,
	}
	sm.collaborationCalls[auth.CallID] = nativeSessionID
	sm.collaborationMu.Unlock()
	if selectedMemory {
		base, baseErr := prepareCollaborationContext(teamContext)
		if baseErr != nil {
			return "", baseErr
		}
		selected, outcome := sm.prepareCollaborationMemoryContext(ctx, teamContext, nativeSessionID, agent, content, auth.CallID)
		if selected == nil {
			return "", fmt.Errorf("team_memory_context_%s", outcome.Reason)
		}
		if err := sm.SendMessageWithInput(ctx, UserMessageInput{
			SessionID: nativeSessionID, Content: content, RequestID: auth.CallID, MsgID: auth.CallID,
			InputMode: protocol.InputModeNewTurn, HiddenContext: mergeCollaborationContext(base, selected),
			SkipMemoryContext: true,
		}); err != nil {
			sm.recordMemoryContextReceipt(ctx, selected, false, "dispatch_failed")
			return "", err
		}
	}
	return nativeSessionID, nil
}

// DispatchCollaborationMessage drives only the session recorded for the exact
// binding tuple. Duplicate call IDs are never executed again.
func (sm *SessionManager) DispatchCollaborationMessage(ctx context.Context, auth *protocol.CollaborationAuthorization, teamContext *protocol.CollaborationContext, nativeSessionID, content, requestID, msgID string) error {
	if auth == nil || (auth.Operation != "create" && auth.Operation != "message") {
		return ErrCollaborationAuthorization
	}
	if err := ValidateCollaborationAuthorization(auth, auth.Operation); err != nil {
		return err
	}
	sm.mu.RLock()
	process := sm.sessions[nativeSessionID]
	policy := sm.cwdPolicy
	busy := process == nil || process.Status == protocol.StatusRunning || process.Status == protocol.StatusBusy ||
		process.Status == protocol.StatusRetry || process.Status == protocol.StatusWaitingApproval || process.Status == protocol.StatusWaitingQuestion
	sm.mu.RUnlock()
	if process == nil {
		return ErrCollaborationBinding
	}

	sm.collaborationMu.Lock()
	if sm.collaborationBindings == nil {
		sm.collaborationBindings = make(map[string]collaborationNativeBinding)
		sm.collaborationCalls = make(map[string]string)
	}
	binding, exists := sm.collaborationBindings[auth.BindingID]
	if !exists {
		roots := policy.Roots()
		canonicalCwd, cwdErr := policy.AuthorizeProposed(process.Cwd)
		if len(roots) == 0 || cwdErr != nil || process.Source != "daemon" || canonicalCwd != collaborationWorkspace(roots[0], auth.BindingID) ||
			(process.Agent != adapter.AgentCodex && process.Agent != adapter.AgentClaude) {
			sm.collaborationMu.Unlock()
			return ErrCollaborationBinding
		}
		binding = collaborationNativeBinding{
			NativeSessionID: nativeSessionID, TeamSessionID: auth.TeamSessionID,
			BindingID: auth.BindingID, BindingRevision: auth.BindingRevision,
			OfferID: auth.OfferID, OfferRevision: auth.OfferRevision,
			OwnerUserID: auth.OwnerUserID, DaemonID: auth.DaemonID, Agent: process.Agent,
		}
		sm.collaborationBindings[auth.BindingID] = binding
	}
	if binding.NativeSessionID != nativeSessionID || binding.TeamSessionID != auth.TeamSessionID ||
		binding.BindingRevision != auth.BindingRevision || binding.OfferID != auth.OfferID ||
		binding.OfferRevision != auth.OfferRevision || binding.OwnerUserID != auth.OwnerUserID || binding.DaemonID != auth.DaemonID {
		sm.collaborationMu.Unlock()
		return ErrCollaborationBinding
	}
	if _, duplicate := sm.collaborationCalls[auth.CallID]; duplicate {
		sm.collaborationMu.Unlock()
		return ErrCollaborationDuplicateCall
	}
	if busy {
		sm.collaborationMu.Unlock()
		return ErrCollaborationSessionBusy
	}
	sm.collaborationCalls[auth.CallID] = nativeSessionID
	sm.collaborationMu.Unlock()

	preparedContext, err := prepareCollaborationContext(teamContext)
	if err != nil {
		sm.collaborationMu.Lock()
		delete(sm.collaborationCalls, auth.CallID)
		sm.collaborationMu.Unlock()
		return err
	}
	selectedContext, outcome := sm.prepareCollaborationMemoryContext(ctx, teamContext, nativeSessionID, process.Agent, content, requestID)
	if teamContext != nil && teamContext.MemoryContext != nil && selectedContext == nil {
		sm.collaborationMu.Lock()
		delete(sm.collaborationCalls, auth.CallID)
		sm.collaborationMu.Unlock()
		return fmt.Errorf("team_memory_context_%s", outcome.Reason)
	}
	err = sm.SendMessageWithInput(ctx, UserMessageInput{
		SessionID: nativeSessionID, Content: content, RequestID: requestID, MsgID: msgID,
		InputMode: protocol.InputModeNewTurn, HiddenContext: mergeCollaborationContext(preparedContext, selectedContext),
		SkipMemoryContext: true,
	})
	if err != nil {
		sm.collaborationMu.Lock()
		delete(sm.collaborationCalls, auth.CallID)
		sm.collaborationMu.Unlock()
	}
	return err
}
