package session

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
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

func collaborationHasSelectedMemory(value *protocol.CollaborationContext) bool {
	return value != nil && value.MemoryContext != nil && len(value.MemoryContext.References) > 0
}

// rollbackCollaborationCreate only releases the reservation and native runtime
// owned by this create attempt. A failed native close keeps the binding as a
// quarantine, so retry cannot spawn a second thread beside the unclosed one.
func (sm *SessionManager) rollbackCollaborationCreate(binding collaborationNativeBinding, callID, workspace string, created *ProcessState) error {
	sm.collaborationMu.Lock()
	defer sm.collaborationMu.Unlock()
	if sm.collaborationBindings[binding.BindingID] != binding {
		return nil
	}
	if sm.collaborationCalls[callID] == binding.NativeSessionID {
		delete(sm.collaborationCalls, callID)
	}
	if err := sm.disposeFailedCollaborationSession(binding, workspace, created); err != nil {
		return fmt.Errorf("collaboration_create_cleanup_failed: %w", err)
	}
	delete(sm.collaborationBindings, binding.BindingID)
	return nil
}

func (sm *SessionManager) disposeFailedCollaborationSession(binding collaborationNativeBinding, workspace string, created *ProcessState) error {
	if created == nil {
		return nil
	}
	sm.mu.RLock()
	owned := sm.sessions[binding.NativeSessionID] == created && created.SessionID == binding.NativeSessionID &&
		created.Source == "daemon" && created.Agent == binding.Agent && created.Cwd == workspace
	sm.mu.RUnlock()
	if !owned {
		return nil
	}
	_, release, err := sm.acquireObserverDrive(context.Background(), binding.NativeSessionID)
	if err != nil {
		return err
	}
	defer release()
	sm.mu.RLock()
	if sm.sessions[binding.NativeSessionID] != created || created.Source != "daemon" || created.Agent != binding.Agent || created.Cwd != workspace {
		sm.mu.RUnlock()
		return nil
	}
	backend, cancel, cmd, pty := created.Backend, created.Cancel, created.Cmd, created.PTY
	sm.mu.RUnlock()
	if backend != nil {
		// Codex Close detaches this thread through its native lifecycle; never
		// terminate the shared app-server or another terminal's runtime.
		if err := backend.Close(binding.NativeSessionID); err != nil {
			return err
		}
	} else {
		if cancel != nil {
			cancel()
		}
		if sm.approvals != nil {
			sm.approvals.DrainSession(binding.NativeSessionID)
		}
		if pty != nil {
			if err := pty.Close(); err != nil && !errors.Is(err, os.ErrClosed) {
				return err
			}
		}
		if cmd != nil && cmd.Process != nil {
			// The existing lifecycle goroutine remains the single Wait owner.
			if err := cmd.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
				return err
			}
		}
	}
	sm.mu.Lock()
	if sm.sessions[binding.NativeSessionID] != created {
		sm.mu.Unlock()
		return nil
	}
	retirement, err := persistCollaborationRetirement(binding, workspace)
	if err != nil {
		sm.mu.Unlock()
		return err
	}
	if sm.collaborationRetirements == nil {
		sm.collaborationRetirements = make(map[string]*collaborationRetirement)
	}
	sm.collaborationRetirements[binding.NativeSessionID] = retirement
	delete(sm.sessions, binding.NativeSessionID)
	if cmd != nil && cmd.Process != nil {
		delete(sm.childPids, cmd.Process.Pid)
	}
	sm.mu.Unlock()
	sm.unregisterCwd(binding.NativeSessionID, workspace)
	if sm.fileLocks != nil {
		sm.fileLocks.ReleaseAll(binding.NativeSessionID)
	}
	return nil
}

// CreateCollaborationSession creates a daemon-local session in an isolated,
// operator-authorized directory. No remote cwd or private session ID is accepted.
func (sm *SessionManager) CreateCollaborationSession(ctx context.Context, auth *protocol.CollaborationAuthorization, teamContext *protocol.CollaborationContext, agent, content string) (string, error) {
	return sm.createCollaborationSession(ctx, auth, teamContext, agent, content, nil)
}

// CreateCollaborationSessionRegistered waits for canonical native-session
// registration before sending the first turn or preparing its Memory grant.
func (sm *SessionManager) CreateCollaborationSessionRegistered(ctx context.Context, auth *protocol.CollaborationAuthorization, teamContext *protocol.CollaborationContext, agent, content string, register func(context.Context, string) error) (string, error) {
	return sm.createCollaborationSession(ctx, auth, teamContext, agent, content, register)
}

func (sm *SessionManager) createCollaborationSession(ctx context.Context, auth *protocol.CollaborationAuthorization, teamContext *protocol.CollaborationContext, agent, content string, register func(context.Context, string) error) (_ string, createErr error) {
	if err := ValidateCollaborationAuthorization(auth, "create"); err != nil {
		return "", err
	}
	if agent != adapter.AgentCodex && agent != adapter.AgentClaude && agent != adapter.AgentDSH {
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
	}
	if sm.collaborationCalls == nil {
		sm.collaborationCalls = make(map[string]string)
	}
	if _, exists := sm.collaborationBindings[auth.BindingID]; exists {
		sm.collaborationMu.Unlock()
		return "", ErrCollaborationBinding
	}
	if _, exists := sm.collaborationCalls[auth.CallID]; exists {
		sm.collaborationMu.Unlock()
		return "", ErrCollaborationDuplicateCall
	}
	binding := collaborationNativeBinding{
		NativeSessionID: "creating", TeamSessionID: auth.TeamSessionID, BindingID: auth.BindingID,
		BindingRevision: auth.BindingRevision, OfferID: auth.OfferID, OfferRevision: auth.OfferRevision,
		OwnerUserID: auth.OwnerUserID, DaemonID: auth.DaemonID, Agent: agent,
	}
	sm.collaborationBindings[auth.BindingID] = binding
	sm.collaborationMu.Unlock()
	workspace := collaborationWorkspace(roots[0], auth.BindingID)
	var created *ProcessState
	defer func() {
		if createErr != nil && !errors.Is(createErr, errNativeSessionCreateUncertain) {
			createErr = errors.Join(createErr, sm.rollbackCollaborationCreate(binding, auth.CallID, workspace, created))
		}
	}()

	prompt, err := collaborationInitialPrompt(content, teamContext)
	if err != nil {
		return "", err
	}
	selectedMemory := collaborationHasSelectedMemory(teamContext)
	initialPrompt := prompt
	if selectedMemory || register != nil || agent == adapter.AgentClaude || agent == adapter.AgentDSH {
		initialPrompt = ""
	}
	nativeSessionID, err := sm.CreateSession(ctx, protocol.SessionConfig{
		Agent: agent, Cwd: workspace, Prompt: initialPrompt, AutoCreateDir: true,
		ClaudePrintSession: agent == adapter.AgentClaude,
	})
	if nativeSessionID == "" && err == nil {
		err = ErrCollaborationBinding
	}
	if nativeSessionID != "" {
		sm.mu.RLock()
		created = sm.sessions[nativeSessionID]
		sm.mu.RUnlock()
		sm.collaborationMu.Lock()
		if sm.collaborationBindings[auth.BindingID] != binding {
			sm.collaborationMu.Unlock()
			return "", ErrCollaborationBinding
		}
		binding.NativeSessionID = nativeSessionID
		sm.collaborationBindings[auth.BindingID] = binding
		if err == nil {
			sm.collaborationCalls[auth.CallID] = nativeSessionID
		}
		sm.collaborationMu.Unlock()
	}
	if err != nil {
		return "", err
	}
	if agent == adapter.AgentClaude || agent == adapter.AgentDSH {
		if err := persistCollaborationNative(binding, workspace); err != nil {
			return "", err
		}
	}
	if register != nil && selectedMemory && sm.MemoryContextCapability(ctx, nativeSessionID, agent) != memorycontext.CapabilityNativeHiddenV1 {
		return "", fmt.Errorf("team_memory_context_unsupported_adapter")
	}
	if register != nil {
		if err := register(ctx, nativeSessionID); err != nil {
			return "", err
		}
	}
	if selectedMemory || register != nil || agent == adapter.AgentClaude || agent == adapter.AgentDSH {
		base, baseErr := prepareCollaborationContext(teamContext)
		if baseErr != nil {
			return "", baseErr
		}
		var selected *memorycontext.PreparedContext
		if selectedMemory {
			var outcome memorycontext.Outcome
			selected, outcome = sm.prepareCollaborationMemoryContext(ctx, teamContext, nativeSessionID, agent, content, auth.CallID)
			if selected == nil {
				return "", fmt.Errorf("team_memory_context_%s", outcome.Reason)
			}
		}
		prompt, hidden := collaborationDelivery(agent, content, mergeCollaborationContext(base, selected))
		if err := sm.SendMessageWithInput(ctx, UserMessageInput{
			SessionID: nativeSessionID, Content: prompt, RequestID: auth.CallID, MsgID: auth.CallID,
			InputMode: protocol.InputModeNewTurn, HiddenContext: hidden,
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
	sm.mu.RUnlock()
	if restored := sm.restoreCollaborationClaude(auth, nativeSessionID, process, policy); restored != nil {
		process = restored
	}
	sm.mu.RLock()
	busy := process == nil || process.Status == protocol.StatusRunning || process.Status == protocol.StatusBusy ||
		process.Status == protocol.StatusRetry || process.Status == protocol.StatusWaitingApproval || process.Status == protocol.StatusWaitingQuestion
	sm.mu.RUnlock()
	if process == nil {
		return ErrCollaborationBinding
	}
	if process.Agent == adapter.AgentDSH && !sm.restoreCollaborationDSH(auth, nativeSessionID, process, policy) {
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
			(process.Agent != adapter.AgentCodex && process.Agent != adapter.AgentClaude && process.Agent != adapter.AgentDSH) {
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
	if collaborationHasSelectedMemory(teamContext) && selectedContext == nil {
		sm.collaborationMu.Lock()
		delete(sm.collaborationCalls, auth.CallID)
		sm.collaborationMu.Unlock()
		return fmt.Errorf("team_memory_context_%s", outcome.Reason)
	}
	prompt, hidden := collaborationDelivery(process.Agent, content, mergeCollaborationContext(preparedContext, selectedContext))
	err = sm.SendMessageWithInput(ctx, UserMessageInput{
		SessionID: nativeSessionID, Content: prompt, RequestID: requestID, MsgID: msgID,
		InputMode: protocol.InputModeNewTurn, HiddenContext: hidden,
		SkipMemoryContext: true,
	})
	if err != nil {
		sm.collaborationMu.Lock()
		delete(sm.collaborationCalls, auth.CallID)
		sm.collaborationMu.Unlock()
	}
	return err
}
