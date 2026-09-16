package session

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/agentcontrol"
	"github.com/pocketctl/pocketctl/internal/daemon"
)

type CodexRuntimeProvider struct {
	projectsMu         sync.Mutex
	projects           map[string]*codexCoordinator
	homesMu            sync.Mutex
	homeCoordinators   map[string]*codexCoordinator
	sm                 *SessionManager
	coordinator        *codexCoordinator
	coordinatorFactory func(adapter.CodexHomeProfile) *codexCoordinator
	resolve            func() (string, string, error)
	probe              func(context.Context, string, string) (agentcontrol.CodexCapabilities, error)
}

func codexHomeRuntimeStateDir() string {
	return filepath.Join(filepath.Dir(daemon.CodexAppServerStatePath()), "codex-home-runtimes")
}

// Recover adopts a persisted live app-server generation after daemon restart.
// It is deliberately lazy when no handoff file exists, so normal daemon start
// does not spawn Codex until a terminal or managed Web session needs it.
func (p *CodexRuntimeProvider) Recover(ctx context.Context) error {
	projectErr := p.recoverProjects(ctx)
	homeErr := p.recoverHomes(ctx)
	return errors.Join(projectErr, homeErr, p.recoverLegacy(ctx))
}

func (p *CodexRuntimeProvider) recoverHomes(ctx context.Context) error {
	files, err := filepath.Glob(filepath.Join(codexHomeRuntimeStateDir(), "*.state"))
	if err != nil || len(files) == 0 {
		return err
	}
	cfg, err := agentcontrol.LoadConfig()
	if err != nil || cfg.Codex.State != agentcontrol.StateEnabled {
		return err
	}
	binary, version, err := p.resolve()
	if err != nil {
		return err
	}
	capabilities, err := p.probe(ctx, binary, version)
	if err != nil {
		return err
	}
	if !capabilities.Managed() {
		return errors.New("Codex managed capabilities are incomplete")
	}
	var recoveryErrors []error
	for _, file := range files {
		state, readErr := daemon.ReadCodexAppServerStateAt(file)
		if readErr != nil || state.CodexHomeID == "" || filepath.Base(file) != state.CodexHomeID+".state" {
			recoveryErrors = append(recoveryErrors, fmt.Errorf("%s: invalid Codex home runtime identity", filepath.Base(file)))
			continue
		}
		coord, _, coordErr := p.coordinatorForHomeID(state.CodexHomeID)
		if coordErr == nil {
			_, coordErr = coord.ensureStarted(ctx, binary, version, capabilities)
		}
		if coordErr != nil && !errors.Is(coordErr, errCodexRuntimeUpgradeDeferred) {
			recoveryErrors = append(recoveryErrors, fmt.Errorf("%s: %w", filepath.Base(file), coordErr))
		}
	}
	return errors.Join(recoveryErrors...)
}
func (p *CodexRuntimeProvider) recoverLegacy(ctx context.Context) error {
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
	if errors.Is(err, errCodexRuntimeUpgradeDeferred) {
		return nil
	}
	if err != nil {
		_ = agentcontrol.RecordCodexFallback(agentcontrol.CodexFallbackRuntime)
	}
	return err
}

func newCodexRuntimeProvider(sm *SessionManager) *CodexRuntimeProvider {
	p := &CodexRuntimeProvider{
		sm:      sm,
		resolve: agentcontrol.ResolveConfiguredCodex,
		probe: func(ctx context.Context, binary, version string) (agentcontrol.CodexCapabilities, error) {
			return (agentcontrol.CodexProbe{}).Probe(ctx, binary, version)
		},
	}
	p.coordinatorFactory = func(profile adapter.CodexHomeProfile) *codexCoordinator {
		coord := newCodexCoordinator(sm)
		coord.start = func(ctx context.Context, binary, version string, generation uint64) (*codexAppServerRuntime, error) {
			return startCodexAppServerForHome(ctx, binary, version, generation, profile.ID, profile.Home)
		}
		return coord
	}
	profiles := adapter.CodexHomeProfiles()
	primary := adapter.CodexHomeProfile{Primary: true}
	if len(profiles) > 0 {
		primary = profiles[0]
	}
	p.coordinator = p.coordinatorFactory(primary)
	p.coordinator.configureCodexHome(primary)
	return p
}

func (p *CodexRuntimeProvider) coordinatorForHomeID(homeID string) (*codexCoordinator, adapter.CodexHomeProfile, error) {
	selected, err := p.profileForHomeID(homeID)
	if err != nil {
		return nil, adapter.CodexHomeProfile{}, err
	}
	if selected.Primary {
		return p.coordinator, selected, nil
	}
	p.homesMu.Lock()
	defer p.homesMu.Unlock()
	if coord := p.homeCoordinators[selected.ID]; coord != nil {
		return coord, selected, nil
	}
	if p.homeCoordinators == nil {
		p.homeCoordinators = make(map[string]*codexCoordinator)
	}
	coord := p.coordinatorFactory(selected)
	coord.configureCodexHome(selected)
	coord.statePath = filepath.Join(codexHomeRuntimeStateDir(), selected.ID+".state")
	// Generations are global lease identities. A per-home coordinator starting
	// again at 1 would let one account consume another account's lease state.
	coord.generation = uint64(time.Now().UnixMilli())*1000 + projectGeneration.Add(1)%1000
	p.homeCoordinators[selected.ID] = coord
	return coord, selected, nil
}

func (p *CodexRuntimeProvider) profileForHomeID(homeID string) (adapter.CodexHomeProfile, error) {
	profiles := adapter.CodexHomeProfiles()
	if len(profiles) == 0 {
		return adapter.CodexHomeProfile{}, fmt.Errorf("Codex home is not configured")
	}
	if homeID == "" {
		homeID = profiles[0].ID
	}
	var selected adapter.CodexHomeProfile
	found := false
	for _, profile := range profiles {
		if profile.ID == homeID {
			selected, found = profile, true
			break
		}
	}
	if !found {
		return adapter.CodexHomeProfile{}, fmt.Errorf("Codex home %q is not configured in the daemon", homeID)
	}
	return selected, nil
}

func (p *CodexRuntimeProvider) coordinatorForGeneration(generation uint64) *codexCoordinator {
	p.coordinator.mu.Lock()
	primaryGeneration := p.coordinator.generation
	p.coordinator.mu.Unlock()
	if primaryGeneration == generation {
		return p.coordinator
	}
	p.homesMu.Lock()
	defer p.homesMu.Unlock()
	for _, coord := range p.homeCoordinators {
		coord.mu.Lock()
		matches := coord.generation == generation
		coord.mu.Unlock()
		if matches {
			return coord
		}
	}
	return nil
}

func (p *CodexRuntimeProvider) coordinatorForLease(leaseID string) *codexCoordinator {
	lease, ok := p.sm.leases.Snapshot()[leaseID]
	if !ok {
		return nil
	}
	return p.coordinatorForGeneration(lease.Generation)
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
	coord, _, err := p.coordinatorForHomeID(req.Payload.CodexHomeID)
	if err != nil {
		return agentcontrol.AcquireResult{Mode: string(agentcontrol.LaunchNative), RealBinary: binary, Reason: err.Error()}, nil
	}
	snapshot, err := coord.ensureStarted(ctx, binary, version, capabilities)
	if errors.Is(err, errCodexRuntimeUpgradeDeferred) {
		_ = agentcontrol.RecordCodexFallback(agentcontrol.CodexFallbackRuntime)
		return agentcontrol.AcquireResult{
			Mode: string(agentcontrol.LaunchNative), RealBinary: binary, Reason: err.Error(),
		}, nil
	}
	if err != nil {
		_ = agentcontrol.RecordCodexFallback(agentcontrol.CodexFallbackRuntime)
		return agentcontrol.AcquireResult{}, runtimeProtocolError(err)
	}
	leaseID := fmt.Sprintf("codex-%d-%s", req.ClientPID, req.Payload.OperationID)
	if err := p.sm.leases.Register(agentcontrol.Lease{ID: leaseID, Agent: agentcontrol.AgentCodex, SessionID: req.Payload.SessionID, PID: req.ClientPID, Generation: snapshot.Generation}); err != nil {
		return agentcontrol.AcquireResult{}, runtimeProtocolError(err)
	}
	if err := coord.persist(); err != nil {
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
	if coord := p.coordinatorForLease(req.Payload.LeaseID); coord != nil {
		return coord.persist()
	}
	return fmt.Errorf("Codex runtime lease coordinator not found")
}

func (p *CodexRuntimeProvider) Release(_ context.Context, req agentcontrol.ReleaseRequest) error {
	coord := p.coordinatorForLease(req.Payload.LeaseID)
	p.sm.leases.Release(req.Payload.LeaseID)
	if coord != nil {
		return coord.persist()
	}
	return nil
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
	return provider.shutdownAll()
}
