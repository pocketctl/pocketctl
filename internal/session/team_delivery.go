package session

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"sync"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/sessiondocument"
)

// Serialize the final admission with interruption. Downloads use the cancellable
// preparation context; a successfully launched native turn keeps its parent
// context and is interrupted by the normal session lifecycle mechanism.
type teamStepPreparation struct {
	mu     sync.Mutex
	cancel context.CancelFunc
}

type teamCommandControlKey struct{}
type teamCommandControlSnapshot struct {
	manager  *SessionManager
	sequence uint64
}

// CaptureTeamCommandContext defines cancellation ordering when the command is
// received, before a background goroutine is scheduled.
func (sm *SessionManager) CaptureTeamCommandContext(ctx context.Context) context.Context {
	return context.WithValue(ctx, teamCommandControlKey{}, teamCommandControlSnapshot{sm, sm.teamStepControlSnapshot()})
}

func (sm *SessionManager) teamCommandControlSequence(ctx context.Context) uint64 {
	if snapshot, ok := ctx.Value(teamCommandControlKey{}).(teamCommandControlSnapshot); ok && snapshot.manager == sm {
		return snapshot.sequence
	}
	return sm.teamStepControlSnapshot()
}

func (sm *SessionManager) teamStepControlSnapshot() uint64 {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	return sm.teamStepControlSequence
}

func (sm *SessionManager) startTeamStepPreparation(ctx context.Context, auth *protocol.CollaborationAuthorization, nativeID string, controlSnapshot uint64) (context.Context, *teamStepPreparation, func()) {
	if auth == nil || auth.Delivery == nil || auth.Delivery.AttemptID == "" {
		return ctx, nil, func() {}
	}
	prepared, cancel := context.WithCancel(ctx)
	p := &teamStepPreparation{cancel: cancel}
	sm.mu.Lock()
	if sm.teamStepPreparations == nil {
		sm.teamStepPreparations = make(map[string]*teamStepPreparation)
	}
	sm.teamStepPreparations[nativeID] = p
	// A control may have arrived while this operation restored/created the
	// native session, before its preparation handle could be registered.
	if sm.teamStepLastControl[nativeID] > controlSnapshot {
		cancel()
	}
	sm.mu.Unlock()
	return prepared, p, func() {
		sm.mu.Lock()
		if sm.teamStepPreparations[nativeID] == p {
			delete(sm.teamStepPreparations, nativeID)
		}
		sm.mu.Unlock()
		cancel()
	}
}

func (sm *SessionManager) cancelTeamStepPreparation(nativeID string) {
	sm.mu.Lock()
	sm.teamStepControlSequence++
	if sm.teamStepLastControl == nil {
		sm.teamStepLastControl = make(map[string]uint64)
	}
	sm.teamStepLastControl[nativeID] = sm.teamStepControlSequence
	p := sm.teamStepPreparations[nativeID]
	sm.mu.Unlock()
	if p != nil {
		p.mu.Lock()
		p.cancel()
		p.mu.Unlock()
	}
}

func (sm *SessionManager) admitTeamStep(ctx, prepareCtx context.Context, p *teamStepPreparation, input UserMessageInput) error {
	if p == nil {
		return sm.SendMessageWithInput(ctx, input)
	}
	// Controls use observer drive -> preparation lock too. Pass the lease to
	// SendMessage so a pending observer classifier cannot make it reacquire.
	return sm.WithObserverDrive(ctx, input.SessionID, func(driveCtx context.Context) error {
		return p.admit(prepareCtx, func() error { return sm.SendMessageWithInput(driveCtx, input) })
	})
}

func (p *teamStepPreparation) admit(ctx context.Context, send func() error) error {
	if p != nil {
		p.mu.Lock()
		defer p.mu.Unlock()
		if err := ctx.Err(); err != nil {
			return err
		}
	}
	return send()
}

func (sm *SessionManager) SetTeamStepInputPreparer(prepare func(context.Context, *protocol.CollaborationAuthorization, string, string) error) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	sm.teamStepInputPreparer = prepare
}

func (sm *SessionManager) TeamStepInputsReady() bool {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	return sm.teamStepInputPreparer != nil && sm.turnEnabled()
}

func teamStepInputBinding(auth *protocol.CollaborationAuthorization, value *protocol.CollaborationContext) (string, error) {
	step := auth != nil && auth.Delivery != nil && auth.Delivery.AttemptID != ""
	hash := ""
	if value != nil {
		hash = value.StepInputHash
	}
	if !step && hash == "" {
		return "", nil
	}
	decoded, err := hex.DecodeString(hash)
	if !step || !protocol.ValidTeamDeliveryAttemptID(auth.Delivery.AttemptID) || err != nil || len(decoded) != 32 || strings.ToLower(hash) != hash {
		return "", ErrCollaborationAuthorization
	}
	if _, err = prepareCollaborationContext(value); err != nil {
		return "", err
	}
	return hash, nil
}

func (sm *SessionManager) prepareTeamStepInputs(ctx context.Context, auth *protocol.CollaborationAuthorization, value *protocol.CollaborationContext, workspace string) error {
	hash, err := teamStepInputBinding(auth, value)
	if err != nil {
		return err
	}
	if hash == "" {
		return nil
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	sm.mu.RLock()
	prepare := sm.teamStepInputPreparer
	sm.mu.RUnlock()
	if prepare == nil {
		return fmt.Errorf("team_step_inputs_unsupported")
	}
	if err := prepare(ctx, auth, hash, workspace); err != nil {
		return err
	}
	return ctx.Err()
}

// TeamDeliveryWorkspace authorizes a Relay job against private daemon ownership
// records. Agent-authored output and natural-language Context cannot grant
// access to a workspace or turn an unrelated native session into a source.
func (sm *SessionManager) TeamDeliveryWorkspace(job protocol.TeamDeliveryJob) (string, error) {
	sm.mu.RLock()
	policy := sm.cwdPolicy
	sm.mu.RUnlock()
	if job.Provider != adapter.AgentCodex && job.Provider != adapter.AgentClaude && job.Provider != adapter.AgentDSH && job.Provider != "agentteams" {
		return "", ErrCollaborationBinding
	}
	p, err := collaborationRecordPath(job.Provider, job.NativeSessionID)
	if err != nil {
		return "", err
	}
	data, err := sessiondocument.ReadExplicitArtifact(filepath.Dir(p), filepath.Base(p), 16384)
	if err != nil {
		return "", ErrCollaborationBinding
	}
	cwd, err := deliveryWorkspaceFromRecord(data, job, policy)
	if err != nil {
		return "", err
	}
	if sm.isRetiredCollaborationSession(job.NativeSessionID, job.Provider, cwd) {
		return "", ErrCollaborationBinding
	}
	return cwd, nil
}

func deliveryWorkspaceFromRecord(data []byte, job protocol.TeamDeliveryJob, policy *CwdPolicy) (string, error) {
	auth := &job.Authorization
	if (auth.Operation != "create" && auth.Operation != "message") || ValidateCollaborationAuthorization(auth, auth.Operation) != nil ||
		job.CallID == "" || job.CallID != auth.CallID || job.NativeSessionID == "" ||
		auth.Delivery == nil || job.TaskID == "" || auth.Delivery.TaskID != job.TaskID ||
		!protocol.ValidTeamDeliveryAttemptID(job.AttemptID) || auth.Delivery.AttemptID != job.AttemptID ||
		job.SpecRevision < 1 || auth.Delivery.SpecRevision != job.SpecRevision || policy == nil || len(policy.Roots()) == 0 {
		return "", ErrCollaborationAuthorization
	}
	var record collaborationNativeRecord
	if json.Unmarshal(data, &record) != nil || record.Version != 1 {
		return "", ErrCollaborationBinding
	}
	b := record.Binding
	if b.NativeSessionID != job.NativeSessionID || b.Agent != job.Provider || b.TeamSessionID != auth.TeamSessionID ||
		b.BindingID != auth.BindingID || b.BindingRevision != auth.BindingRevision || b.OfferID != auth.OfferID ||
		b.OfferRevision != auth.OfferRevision || b.OwnerUserID != auth.OwnerUserID || b.DaemonID != auth.DaemonID {
		return "", ErrCollaborationBinding
	}
	expected := collaborationWorkspace(policy.Roots()[0], auth.BindingID)
	canonical, err := filepath.EvalSymlinks(record.Cwd)
	if err != nil || record.Cwd != expected || canonical != expected || policy.Allows(canonical) != nil {
		return "", ErrCollaborationBinding
	}
	return canonical, nil
}
