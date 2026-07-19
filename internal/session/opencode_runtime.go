package session

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/agentcontrol"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

// Acquire implements agentcontrol.RuntimeProvider for OpenCode. Session
// preparation resolves interactive intents to a session owned by the shared
// authenticated runtime authority.
func (sm *SessionManager) Acquire(ctx context.Context, req agentcontrol.AcquireRequest) (agentcontrol.AcquireResult, error) {
	cfg, err := agentcontrol.LoadConfig()
	if err != nil {
		return agentcontrol.AcquireResult{}, err
	}
	if cfg.OpenCode.State != agentcontrol.StateEnabled {
		return agentcontrol.AcquireResult{
			Mode:       string(agentcontrol.LaunchNative),
			RealBinary: cfg.OpenCode.RealBinary,
			Reason:     "OpenCode agent integration is not enabled",
		}, nil
	}

	coord := sm.ensureOpencode()
	if err := coord.ensureStarted(); err != nil {
		return agentcontrol.AcquireResult{}, &agentcontrol.ProtocolError{Code: agentcontrol.ErrRuntimeUnavailable, Message: err.Error()}
	}
	coord.mu.Lock()
	server, generation, binary, binaryVersion := coord.server, coord.generation, coord.realBinary, coord.realVersion
	coord.mu.Unlock()
	if server == nil || server.BaseURL() == "" {
		return agentcontrol.AcquireResult{}, &agentcontrol.ProtocolError{Code: agentcontrol.ErrRuntimeUnavailable, Message: "OpenCode serve is not ready"}
	}
	if binary == "" {
		return agentcontrol.AcquireResult{}, &agentcontrol.ProtocolError{Code: agentcontrol.ErrRuntimeUnavailable, Message: "OpenCode runtime binary is unavailable"}
	} else if _, err := os.Stat(binary); err != nil {
		return agentcontrol.AcquireResult{}, &agentcontrol.ProtocolError{Code: agentcontrol.ErrRuntimeUnavailable, Message: fmt.Sprintf("configured OpenCode binary is unavailable: %v", err)}
	}
	if binaryVersion != "" && !agentcontrol.SupportsManagedOpenCodeVersion(binaryVersion) {
		return agentcontrol.AcquireResult{
			Mode: string(agentcontrol.LaunchNative), RealBinary: binary,
			Reason: fmt.Sprintf("OpenCode %s is older than the managed runtime minimum %s", binaryVersion, "1.17.11"),
		}, nil
	}
	prepareCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	healthy := server.Healthy(prepareCtx)
	sm.observeOpenCodeRuntimeHealth(healthy)
	if !healthy {
		return agentcontrol.AcquireResult{}, &agentcontrol.ProtocolError{Code: agentcontrol.ErrRuntimeUnavailable, Message: "OpenCode serve health check failed"}
	}
	resolvedSessionID, err := sm.prepareOpenCodeRuntimeSession(prepareCtx, coord, req.ClientPID, req.Payload)
	if err != nil {
		return agentcontrol.AcquireResult{}, err
	}
	leaseID := fmt.Sprintf("opencode-%d-%s", req.ClientPID, req.Payload.OperationID)
	if err := sm.leases.Register(agentcontrol.Lease{
		ID: leaseID, Agent: agentcontrol.AgentOpenCode, SessionID: resolvedSessionID,
		PID: req.ClientPID, Generation: generation,
	}); err != nil {
		return agentcontrol.AcquireResult{}, &agentcontrol.ProtocolError{Code: agentcontrol.ErrRuntimeUnavailable, Message: err.Error()}
	}
	if err := coord.persistLeaseHandoff(); err != nil {
		sm.leases.Release(leaseID)
		return agentcontrol.AcquireResult{}, &agentcontrol.ProtocolError{Code: agentcontrol.ErrRuntimeUnavailable, Message: err.Error()}
	}
	return agentcontrol.AcquireResult{
		Mode:              string(agentcontrol.LaunchManaged),
		BaseURL:           server.BaseURL(),
		Password:          server.Password(),
		RealBinary:        binary,
		LeaseID:           leaseID,
		Generation:        generation,
		ResolvedSessionID: resolvedSessionID,
	}, nil
}

func (sm *SessionManager) prepareOpenCodeRuntimeSession(ctx context.Context, coord *opencodeCoordinator, clientPID int, payload agentcontrol.AcquirePayload) (string, error) {
	cwd := normalizeCwd(payload.CWD)
	if err := validateCwd(cwd); err != nil {
		return "", &agentcontrol.ProtocolError{Code: agentcontrol.ErrInvalidRequest, Message: err.Error()}
	}
	server := coord.srv()
	if server == nil {
		return "", &agentcontrol.ProtocolError{Code: agentcontrol.ErrRuntimeUnavailable, Message: "OpenCode serve is not ready"}
	}

	var sessionID string
	switch payload.Intent {
	case agentcontrol.IntentRun:
		var err error
		sessionID, err = server.CreateSession(ctx, nil, cwd)
		if err != nil {
			return "", runtimeUnavailable(err)
		}
	case agentcontrol.IntentNew:
		var err error
		sessionID, err = server.CreateSession(ctx, nil, cwd)
		if err != nil {
			return "", runtimeUnavailable(err)
		}
	case agentcontrol.IntentContinue:
		sessions, err := server.ListSessions(ctx)
		if err != nil {
			return "", runtimeUnavailable(err)
		}
		var newest int64
		for _, candidate := range sessions {
			if normalizeCwd(candidate.Directory()) != cwd || candidate.ID == "" {
				continue
			}
			if sessionID == "" || candidate.Time.Updated > newest {
				sessionID, newest = candidate.ID, candidate.Time.Updated
			}
		}
		if sessionID == "" {
			return "", &agentcontrol.ProtocolError{Code: agentcontrol.ErrInvalidRequest, Message: "no OpenCode session exists in this directory"}
		}
	case agentcontrol.IntentResume:
		info, err := server.GetSession(ctx, payload.SessionID)
		if err != nil {
			return "", runtimeUnavailable(err)
		}
		if info.ID != payload.SessionID || normalizeCwd(info.Directory) != cwd {
			return "", &agentcontrol.ProtocolError{Code: agentcontrol.ErrInvalidRequest, Message: "OpenCode session does not belong to the requested directory"}
		}
		sessionID = info.ID
	default:
		return "", &agentcontrol.ProtocolError{Code: agentcontrol.ErrInvalidRequest, Message: "unsupported OpenCode runtime intent"}
	}
	if payload.Intent == agentcontrol.IntentContinue || payload.Intent == agentcontrol.IntentResume {
		if sm.openCodeAdoptionBusy(coord, sessionID, cwd, server.BaseURL(), clientPID) {
			sm.mu.Lock()
			if state := sm.sessions[sessionID]; state != nil {
				state.ControlMode = protocol.ControlUnmanagedActive
			}
			sm.mu.Unlock()
			return "", &agentcontrol.ProtocolError{Code: agentcontrol.ErrSessionBusy, Message: "an unmanaged OpenCode process is still active in this directory"}
		}
	}

	if payload.Fork {
		coord.deferManagedFork(sessionID, cwd)
		return sessionID, nil
	}
	sm.registerManagedOpenCodeSession(coord, sessionID, cwd)
	return sessionID, nil
}

func (sm *SessionManager) openCodeAdoptionBusy(coord *opencodeCoordinator, sessionID, cwd, sharedBaseURL string, clientPID int) bool {
	sm.mu.RLock()
	state := sm.sessions[sessionID]
	pid := 0
	if state != nil {
		pid = state.Pid
	}
	sm.mu.RUnlock()
	if pid > 0 && (sm.proc == nil || sm.proc.IsAlive(pid)) {
		return true
	}
	serverPID := 0
	if server := coord.srv(); server != nil {
		serverPID = server.PID()
	}
	return hasUnmanagedOpenCodeProcess(coord.processInspector, cwd, sharedBaseURL, serverPID, clientPID)
}

func (sm *SessionManager) registerManagedOpenCodeSession(coord *opencodeCoordinator, sessionID, cwd string) {
	now := time.Now()
	created := false
	sm.mu.Lock()
	state := sm.sessions[sessionID]
	if state == nil {
		created = true
		state = &ProcessState{
			SessionID: sessionID, Status: protocol.StatusIdle, StartedAt: now, LastActivityAt: now,
			Cwd: cwd, Agent: adapter.AgentOpencode, Source: "terminal", Backend: &serverBackend{coord: coord},
			PendingPermissions: make(map[string]PendingOpenCodePermission), PendingQuestions: make(map[string]PendingOpenCodeQuestion),
			ControlMode: protocol.ControlManaged,
		}
		sm.sessions[sessionID] = state
	} else if state.Agent == adapter.AgentOpencode {
		state.Cwd, state.Backend = cwd, &serverBackend{coord: coord}
	}
	registerCwdKeyLocked(sm, sessionID, normalizeCwd(cwd))
	sm.mu.Unlock()
	coord.markManagedSession(sessionID, cwd)
	coord.startSync(sessionID, true)
	if created {
		event := protocol.DaemonEvent{
			Type: "session_discovered", SessionID: sessionID, Cwd: cwd, Status: protocol.StatusIdle,
			Source: "terminal", Agent: adapter.AgentOpencode, ControlMode: protocol.ControlManaged,
			Capabilities: sm.OpenCodeInteractionCapabilities(sessionID),
		}
		sm.enqueueOpenCodeLifecycleEvent(coord, event)
	}
}

// enqueueOpenCodeLifecycleEvent keeps launcher acquisition independent from
// relay backpressure without dropping the lifecycle event. The fast path is
// allocation-free; when the daemon outbox is full, a background waiter hands
// the event to the existing durable websocket spool as soon as capacity
// returns. A daemon restart remains recoverable through the persisted managed
// registry and normal OpenCode discovery.
func (sm *SessionManager) enqueueOpenCodeLifecycleEvent(coord *opencodeCoordinator, event protocol.DaemonEvent) {
	select {
	case sm.outputCh <- event:
		return
	default:
	}
	ctx := coord.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	go func() {
		select {
		case sm.outputCh <- event:
		case <-ctx.Done():
		}
	}()
}

func runtimeUnavailable(err error) error {
	return &agentcontrol.ProtocolError{Code: agentcontrol.ErrRuntimeUnavailable, Message: err.Error()}
}

func (sm *SessionManager) BindLease(_ context.Context, req agentcontrol.LeaseBindRequest) error {
	if err := sm.leases.Bind(req.Payload.LeaseID, req.Payload.PID); err != nil {
		return err
	}
	sm.mu.Lock()
	coord := sm.opencode
	sm.mu.Unlock()
	if coord != nil {
		return coord.persistLeaseHandoff()
	}
	return nil
}

func (sm *SessionManager) Release(_ context.Context, req agentcontrol.ReleaseRequest) error {
	sm.leases.Release(req.Payload.LeaseID)
	sm.mu.Lock()
	coord := sm.opencode
	sm.mu.Unlock()
	if coord != nil {
		return coord.persistLeaseHandoff()
	}
	return nil
}

func (sm *SessionManager) hasActiveOpenCodeLeases(generation uint64) bool {
	return len(sm.leases.Active(generation)) > 0
}

func (sm *SessionManager) Status(_ context.Context, _ agentcontrol.RuntimeStatusRequest) (agentcontrol.RuntimeStatusResult, error) {
	cfg, err := agentcontrol.LoadConfig()
	if err != nil {
		return agentcontrol.RuntimeStatusResult{}, err
	}
	if cfg.OpenCode.State != agentcontrol.StateEnabled {
		return agentcontrol.RuntimeStatusResult{Mode: string(agentcontrol.LaunchNative), Reason: "OpenCode agent integration is not enabled"}, nil
	}
	sm.mu.Lock()
	coord := sm.opencode
	sm.mu.Unlock()
	if coord == nil {
		return agentcontrol.RuntimeStatusResult{Mode: string(agentcontrol.LaunchManaged), Reason: "runtime has not started"}, nil
	}
	coord.mu.Lock()
	server, generation := coord.server, coord.generation
	coord.mu.Unlock()
	result := agentcontrol.RuntimeStatusResult{Mode: string(agentcontrol.LaunchManaged), Generation: generation}
	if server != nil {
		result.BaseURL = server.BaseURL()
	}
	return result, nil
}
