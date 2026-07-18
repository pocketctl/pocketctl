package session

import (
	"context"
	"fmt"
	"os"

	"github.com/pocketctl/pocketctl/internal/agentcontrol"
	"github.com/pocketctl/pocketctl/internal/daemon"
)

type CodexRuntimeProvider struct {
	sm          *SessionManager
	coordinator *codexCoordinator
	resolve     func() (string, string, error)
	probe       func(context.Context, string, string) (agentcontrol.CodexCapabilities, error)
}

// Recover adopts a persisted live app-server generation after daemon restart.
// It is deliberately lazy when no handoff file exists, so normal daemon start
// does not spawn Codex until a terminal or managed Web session needs it.
func (p *CodexRuntimeProvider) Recover(ctx context.Context) error {
	cfg, err := agentcontrol.LoadConfig()
	if err != nil {
		return err
	}
	if cfg.Codex.State != agentcontrol.StateEnabled {
		return nil
	}
	if _, err := daemon.ReadCodexAppServerState(); os.IsNotExist(err) {
		return nil
	} else if err != nil {
		return err
	}
	binary, version, err := p.resolve()
	if err != nil {
		_ = agentcontrol.RecordCodexFallback(agentcontrol.CodexFallbackMissing)
		return err
	}
	if !agentcontrol.SupportsManagedCodexVersion(version) {
		_ = agentcontrol.RecordCodexFallback(agentcontrol.CodexFallbackOldVersion)
		return fmt.Errorf("Codex %s is older than 0.144.1", version)
	}
	capabilities, err := p.probe(ctx, binary, version)
	if err != nil {
		_ = agentcontrol.RecordCodexFallback(agentcontrol.CodexFallbackCapabilities)
		return err
	}
	if !capabilities.Managed() {
		_ = agentcontrol.RecordCodexFallback(agentcontrol.CodexFallbackCapabilities)
		return fmt.Errorf("Codex managed capabilities are incomplete")
	}
	_, err = p.coordinator.ensureStarted(ctx, binary, version, capabilities)
	if err != nil {
		_ = agentcontrol.RecordCodexFallback(agentcontrol.CodexFallbackRuntime)
	}
	return err
}

func newCodexRuntimeProvider(sm *SessionManager) *CodexRuntimeProvider {
	return &CodexRuntimeProvider{
		sm: sm, coordinator: newCodexCoordinator(sm),
		resolve: agentcontrol.ResolveConfiguredCodex,
		probe: func(ctx context.Context, binary, version string) (agentcontrol.CodexCapabilities, error) {
			return (agentcontrol.CodexProbe{}).Probe(ctx, binary, version)
		},
	}
}

func (sm *SessionManager) CodexRuntimeProvider() *CodexRuntimeProvider {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	if sm.codexProvider == nil {
		sm.codexProvider = newCodexRuntimeProvider(sm)
	}
	return sm.codexProvider
}

func (p *CodexRuntimeProvider) Acquire(ctx context.Context, req agentcontrol.AcquireRequest) (agentcontrol.AcquireResult, error) {
	cfg, err := agentcontrol.LoadConfig()
	if err != nil {
		return agentcontrol.AcquireResult{}, err
	}
	if cfg.Codex.State != agentcontrol.StateEnabled {
		_ = agentcontrol.RecordCodexFallback(agentcontrol.CodexFallbackDisabled)
		return agentcontrol.AcquireResult{Mode: string(agentcontrol.LaunchNative), RealBinary: cfg.Codex.RealBinary, Reason: "Codex agent integration is not enabled"}, nil
	}
	binary, version, err := p.resolve()
	if err != nil {
		_ = agentcontrol.RecordCodexFallback(agentcontrol.CodexFallbackMissing)
		return agentcontrol.AcquireResult{Mode: string(agentcontrol.LaunchNative), RealBinary: cfg.Codex.RealBinary, Reason: err.Error()}, nil
	}
	if !agentcontrol.SupportsManagedCodexVersion(version) {
		_ = agentcontrol.RecordCodexFallback(agentcontrol.CodexFallbackOldVersion)
		return agentcontrol.AcquireResult{Mode: string(agentcontrol.LaunchNative), RealBinary: binary, Reason: fmt.Sprintf("Codex %s is older than 0.144.1", version)}, nil
	}
	capabilities, err := p.probe(ctx, binary, version)
	if err != nil || !capabilities.Managed() {
		_ = agentcontrol.RecordCodexFallback(agentcontrol.CodexFallbackCapabilities)
		if err == nil {
			err = fmt.Errorf("Codex managed capabilities are incomplete")
		}
		return agentcontrol.AcquireResult{Mode: string(agentcontrol.LaunchNative), RealBinary: binary, Reason: err.Error()}, nil
	}
	snapshot, err := p.coordinator.ensureStarted(ctx, binary, version, capabilities)
	if err != nil {
		_ = agentcontrol.RecordCodexFallback(agentcontrol.CodexFallbackRuntime)
		return agentcontrol.AcquireResult{}, runtimeProtocolError(err)
	}
	leaseID := fmt.Sprintf("codex-%d-%s", req.ClientPID, req.Payload.OperationID)
	if err := p.sm.leases.Register(agentcontrol.Lease{ID: leaseID, Agent: agentcontrol.AgentCodex, SessionID: req.Payload.SessionID, PID: req.ClientPID, Generation: snapshot.Generation}); err != nil {
		return agentcontrol.AcquireResult{}, runtimeProtocolError(err)
	}
	if err := p.coordinator.persist(); err != nil {
		p.sm.leases.Release(leaseID)
		return agentcontrol.AcquireResult{}, runtimeProtocolError(err)
	}
	return agentcontrol.AcquireResult{
		Mode: string(agentcontrol.LaunchManaged), RemoteURI: snapshot.RemoteURI,
		RealBinary: snapshot.Binary, LeaseID: leaseID, Generation: snapshot.Generation,
		ResolvedSessionID: req.Payload.SessionID,
	}, nil
}

func (p *CodexRuntimeProvider) BindLease(_ context.Context, req agentcontrol.LeaseBindRequest) error {
	if err := p.sm.leases.Bind(req.Payload.LeaseID, req.Payload.PID); err != nil {
		return err
	}
	return p.coordinator.persist()
}

func (p *CodexRuntimeProvider) Release(_ context.Context, req agentcontrol.ReleaseRequest) error {
	p.sm.leases.Release(req.Payload.LeaseID)
	return p.coordinator.persist()
}

func (p *CodexRuntimeProvider) Status(_ context.Context, _ agentcontrol.RuntimeStatusRequest) (agentcontrol.RuntimeStatusResult, error) {
	cfg, err := agentcontrol.LoadConfig()
	if err != nil {
		return agentcontrol.RuntimeStatusResult{}, err
	}
	if cfg.Codex.State != agentcontrol.StateEnabled {
		return agentcontrol.RuntimeStatusResult{Mode: string(agentcontrol.LaunchNative), Reason: "Codex agent integration is not enabled"}, nil
	}
	snapshot, running := p.coordinator.status()
	if !running {
		return agentcontrol.RuntimeStatusResult{Mode: string(agentcontrol.LaunchManaged), Reason: "runtime has not started"}, nil
	}
	return agentcontrol.RuntimeStatusResult{Mode: string(agentcontrol.LaunchManaged), BaseURL: snapshot.RemoteURI, Generation: snapshot.Generation}, nil
}

func (sm *SessionManager) ShutdownCodex() error {
	sm.mu.Lock()
	provider := sm.codexProvider
	sm.mu.Unlock()
	if provider == nil {
		return nil
	}
	return provider.coordinator.shutdown()
}
