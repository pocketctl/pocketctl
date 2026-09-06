package session

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/agentcontrol"
	"github.com/pocketctl/pocketctl/internal/codexapp"
	"github.com/pocketctl/pocketctl/internal/daemon"
	"github.com/pocketctl/pocketctl/internal/platform"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/turn"
)

type codexAppServerRuntime struct {
	PID       int
	Endpoint  string
	RemoteURI string
	Client    codexRuntimeClient
	Stop      func() error
}

type codexRuntimeClient interface {
	Call(context.Context, string, any, any) error
	Respond(codexapp.RequestID, any, *codexapp.RPCError) error
	Events() <-chan codexapp.Inbound
	Close() error
}

type codexRuntimeSnapshot struct {
	PID        int
	Endpoint   string
	RemoteURI  string
	Binary     string
	Version    string
	SchemaHash string
	Generation uint64
}

type codexRuntimeStarter func(context.Context, string, string, uint64) (*codexAppServerRuntime, error)
type codexRuntimeProbe func(context.Context, *codexAppServerRuntime) error

type codexCoordinator struct {
	titleMu    sync.Mutex
	titleTurns map[string]codexTitleTurn
	sm         *SessionManager

	mu              sync.Mutex
	runtime         *codexAppServerRuntime
	binary          string
	version         string
	schemaHash      string
	generation      uint64
	start           codexRuntimeStarter
	adopt           func(context.Context, *daemon.CodexAppServerState) (*codexAppServerRuntime, error)
	probe           codexRuntimeProbe
	pumpCancel      context.CancelFunc
	projectionMu    sync.Mutex
	turnMu          sync.RWMutex
	activeTurn      map[string]string
	turnRevision    map[string]uint64
	subscribeMu     sync.Mutex
	subscribed      map[string]struct{}
	subscribing     map[string]struct{}
	managedThreads  map[string]struct{}
	interactions    *codexInteractions
	reconnecting    bool
	reconnectCancel context.CancelFunc
	reconnectDone   chan struct{}
	shuttingDown    bool
	pumpWG          sync.WaitGroup
	subscriptionWG  sync.WaitGroup
}

var errCodexRuntimeUpgradeDeferred = errors.New("Codex managed runtime upgrade is deferred while an active terminal lease uses the current generation")

type codexTitleTurn struct {
	user      string
	assistant string
}

func newCodexCoordinator(sm *SessionManager) *codexCoordinator {
	return &codexCoordinator{
		sm: sm, start: startCodexAppServer, adopt: adoptCodexAppServer, probe: probeCodexAppServer,
		activeTurn: make(map[string]string), turnRevision: make(map[string]uint64), subscribed: make(map[string]struct{}), subscribing: make(map[string]struct{}), managedThreads: make(map[string]struct{}),
	}
}

func (c *codexCoordinator) ensureStarted(ctx context.Context, binary, version string, capabilities agentcontrol.CodexCapabilities) (codexRuntimeSnapshot, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.shuttingDown {
		return codexRuntimeSnapshot{}, errors.New("Codex coordinator is shutting down")
	}
	var restoredThreads []string
	if c.runtime != nil {
		probeErr := c.probe(ctx, c.runtime)
		activeLease := c.sm != nil && hasActiveCodexLease(c.sm.leases.Snapshot(), c.generation)
		compatible := codexRuntimeCompatible(c.binary, c.version, c.schemaHash, binary, version, capabilities.SchemaHash)
		if probeErr == nil && compatible {
			return c.snapshotLocked(), nil
		}
		if probeErr == nil && activeLease {
			return c.snapshotLocked(), errCodexRuntimeUpgradeDeferred
		}
		if probeErr != nil && activeLease {
			return codexRuntimeSnapshot{}, fmt.Errorf("Codex app-server endpoint is unavailable while a managed terminal is active: %w", probeErr)
		}
		restoredThreads = c.managedThreadSnapshot()
		c.stopEventPumpLocked()
		if c.runtime.Stop != nil {
			if stopErr := c.runtime.Stop(); stopErr != nil {
				return codexRuntimeSnapshot{}, fmt.Errorf("stop unavailable Codex app-server: %w", stopErr)
			}
		}
		c.runtime = nil
		if removeErr := daemon.RemoveCodexAppServerState(); removeErr != nil && !os.IsNotExist(removeErr) {
			return codexRuntimeSnapshot{}, removeErr
		}
	}
	state, stateErr := daemon.ReadCodexAppServerState()
	if stateErr == nil {
		c.generation = state.Generation
		restoredThreads = append(restoredThreads, state.Threads...)
		alive := platform.NewProcessController().IsAlive(state.PID)
		ownerAvailable := state.OwnerPID <= 0 || state.OwnerPID == os.Getpid() || !platform.NewProcessController().IsAlive(state.OwnerPID)
		compatible := codexRuntimeCompatible(state.Binary, state.Version, state.SchemaHash, binary, version, capabilities.SchemaHash)
		if alive {
			if !ownerAvailable {
				return codexRuntimeSnapshot{}, fmt.Errorf("Codex app-server handoff is still owned by live daemon pid %d", state.OwnerPID)
			}
			activeLease := hasActiveCodexLease(state.Leases, state.Generation)
			if !compatible && !activeLease {
				if err := stopPersistedCodexAppServer(state); err != nil {
					return codexRuntimeSnapshot{}, fmt.Errorf("stop incompatible Codex app-server handoff: %w", err)
				}
				if err := daemon.RemoveCodexAppServerState(); err != nil {
					return codexRuntimeSnapshot{}, err
				}
			} else {
				runtime, err := c.adopt(ctx, state)
				if err != nil {
					if activeLease {
						return codexRuntimeSnapshot{}, fmt.Errorf("Codex app-server endpoint is unavailable while a managed terminal is active: %w", err)
					}
					if stopErr := stopPersistedCodexAppServer(state); stopErr != nil {
						return codexRuntimeSnapshot{}, fmt.Errorf("stop unavailable persisted Codex app-server: %w", stopErr)
					}
					if removeErr := daemon.RemoveCodexAppServerState(); removeErr != nil {
						return codexRuntimeSnapshot{}, removeErr
					}
				} else {
					c.runtime, c.binary, c.version, c.schemaHash = runtime, state.Binary, state.Version, state.SchemaHash
					c.restoreManagedThreads(state.Threads)
					c.startEventPumpLocked()
					if c.sm != nil {
						c.sm.leases.Restore(state.Leases)
						if err := c.persistLocked(); err != nil {
							return codexRuntimeSnapshot{}, err
						}
					}
					snapshot := c.snapshotLocked()
					if !compatible {
						return snapshot, errCodexRuntimeUpgradeDeferred
					}
					return snapshot, nil
				}
			}
		} else if err := daemon.RemoveCodexAppServerState(); err != nil {
			return codexRuntimeSnapshot{}, err
		}
	} else if !os.IsNotExist(stateErr) {
		return codexRuntimeSnapshot{}, fmt.Errorf("read Codex app-server handoff: %w", stateErr)
	}
	generation := c.generation + 1
	runtime, err := c.start(ctx, binary, version, generation)
	if err != nil {
		return codexRuntimeSnapshot{}, err
	}
	if runtime == nil || runtime.PID <= 0 || runtime.Endpoint == "" || runtime.RemoteURI == "" {
		return codexRuntimeSnapshot{}, errors.New("Codex app-server starter returned incomplete runtime")
	}
	c.runtime = runtime
	c.binary = binary
	c.version = version
	c.schemaHash = capabilities.SchemaHash
	c.generation = generation
	c.restoreManagedThreads(restoredThreads)
	c.startEventPumpLocked()
	if c.sm != nil {
		if err := c.persistLocked(); err != nil {
			c.stopEventPumpLocked()
			if runtime.Stop != nil {
				_ = runtime.Stop()
			}
			c.runtime = nil
			return codexRuntimeSnapshot{}, err
		}
	}
	return c.snapshotLocked(), nil
}

func probeCodexAppServer(ctx context.Context, runtime *codexAppServerRuntime) error {
	if runtime == nil || runtime.Endpoint == "" {
		return errors.New("Codex app-server endpoint is empty")
	}
	info, err := os.Stat(runtime.Endpoint)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSocket == 0 || info.Mode().Perm() != 0o600 {
		return errors.New("Codex app-server socket must be private (0600)")
	}
	client, err := codexapp.DialUnix(ctx, runtime.Endpoint)
	if err != nil {
		return err
	}
	defer client.Close()
	var initialized map[string]any
	return client.Initialize(ctx, codexInitializeParams(), &initialized)
}

func hasActiveCodexLease(snapshot map[string]agentcontrol.Lease, generation uint64) bool {
	registry := agentcontrol.NewLeaseRegistry()
	registry.Restore(snapshot)
	for _, lease := range registry.Active(generation) {
		if lease.Agent == agentcontrol.AgentCodex {
			return true
		}
	}
	return false
}

func codexRuntimeCompatible(binary, version, schemaHash, wantBinary, wantVersion, wantSchemaHash string) bool {
	return binary == wantBinary && version == wantVersion && schemaHash == wantSchemaHash
}

func (c *codexCoordinator) snapshotLocked() codexRuntimeSnapshot {
	return codexRuntimeSnapshot{
		PID: c.runtime.PID, Endpoint: c.runtime.Endpoint, RemoteURI: c.runtime.RemoteURI,
		Binary: c.binary, Version: c.version, SchemaHash: c.schemaHash, Generation: c.generation,
	}
}

func (c *codexCoordinator) persist() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.persistLocked()
}

func (c *codexCoordinator) persistLocked() error {
	return c.persistOwnerLocked(os.Getpid())
}

func (c *codexCoordinator) persistOwnerLocked(ownerPID int) error {
	if c.runtime == nil || c.sm == nil {
		return nil
	}
	leases := c.sm.leases.Snapshot()
	for id, lease := range leases {
		if lease.Agent != agentcontrol.AgentCodex {
			delete(leases, id)
		}
	}
	return daemon.WriteCodexAppServerState(&daemon.CodexAppServerState{
		PID: c.runtime.PID, OwnerPID: ownerPID, Endpoint: c.runtime.Endpoint,
		RemoteURI: c.runtime.RemoteURI, Binary: c.binary, Version: c.version,
		SchemaHash: c.schemaHash, Generation: c.generation, Leases: leases,
		Threads:   c.managedThreadSnapshot(),
		UpdatedAt: time.Now().UTC(),
	})
}

func (c *codexCoordinator) status() (codexRuntimeSnapshot, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.runtime == nil {
		return codexRuntimeSnapshot{}, false
	}
	return c.snapshotLocked(), true
}

func (c *codexCoordinator) backendClient() (codexRuntimeClient, uint64, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.runtime == nil || c.runtime.Client == nil {
		return nil, 0, false
	}
	return c.runtime.Client, c.generation, true
}

func (c *codexCoordinator) shutdown() error {
	c.mu.Lock()
	c.shuttingDown = true
	c.stopEventPumpLocked()
	if c.reconnectCancel != nil {
		c.reconnectCancel()
	}
	reconnectDone := c.reconnectDone
	if c.runtime == nil {
		c.mu.Unlock()
		c.waitForBackgroundWork(reconnectDone)
		return nil
	}
	if c.sm != nil {
		for _, lease := range c.sm.leases.Active(c.generation) {
			if lease.Agent == agentcontrol.AgentCodex {
				err := c.persistOwnerLocked(0)
				c.runtime = nil
				c.mu.Unlock()
				c.waitForBackgroundWork(reconnectDone)
				return err
			}
		}
	}
	var err error
	if c.runtime.Stop != nil {
		err = c.runtime.Stop()
	}
	c.runtime = nil
	if removeErr := daemon.RemoveCodexAppServerState(); err == nil {
		err = removeErr
	}
	c.mu.Unlock()
	c.waitForBackgroundWork(reconnectDone)
	return err
}

func (c *codexCoordinator) waitForBackgroundWork(done <-chan struct{}) {
	if done != nil {
		<-done
	}
	c.pumpWG.Wait()
	c.subscriptionWG.Wait()
}

func (c *codexCoordinator) startEventPumpLocked() {
	c.stopEventPumpLocked()
	if c.runtime == nil || c.runtime.Client == nil || c.sm == nil {
		return
	}
	// Subscription state belongs to an app-server connection. A replacement
	// daemon client must resume every managed thread so the server can replay
	// pending server requests and rebuild the projection on that connection.
	c.resetSubscriptionsForNewClient()
	ctx, cancel := context.WithCancel(context.Background())
	c.pumpCancel = cancel
	projector := newCodexProjection(c.generation)
	c.replaceInteractionsLocked(newCodexInteractions(c.sm, c.generation, c.runtime.Client))
	interactions := c.interactions
	client, generation := c.runtime.Client, c.generation
	c.pumpWG.Add(1)
	go func() {
		defer c.pumpWG.Done()
		c.consumeEventsWithInteractions(ctx, client.Events(), projector, interactions)
	}()
	for _, threadID := range c.managedThreadSnapshot() {
		if c.beginSubscription(threadID) {
			c.startTerminalThreadSubscription(ctx, client, generation, threadID, projector)
		}
	}
}

func (c *codexCoordinator) startTerminalThreadSubscription(parent context.Context, client codexRuntimeClient, generation uint64, threadID string, projector *codexProjection) {
	c.subscriptionWG.Add(1)
	go func() {
		defer c.subscriptionWG.Done()
		c.subscribeTerminalThread(parent, client, generation, threadID, projector)
	}()
}

func (c *codexCoordinator) resetSubscriptionsForNewClient() {
	c.subscribeMu.Lock()
	c.subscribed = make(map[string]struct{})
	c.subscribing = make(map[string]struct{})
	c.subscribeMu.Unlock()
}

func (c *codexCoordinator) stopEventPumpLocked() {
	if c.pumpCancel != nil {
		c.pumpCancel()
		c.pumpCancel = nil
	}
	c.replaceInteractionsLocked(nil)
}

func (c *codexCoordinator) replaceInteractionsLocked(next *codexInteractions) {
	if c.interactions != nil {
		c.interactions.Close()
	}
	c.interactions = next
}

func (c *codexCoordinator) consumeEvents(ctx context.Context, inbound <-chan codexapp.Inbound, projector *codexProjection) {
	c.consumeEventsWithInteractions(ctx, inbound, projector, nil)
}

func (c *codexCoordinator) consumeEventsWithInteractions(ctx context.Context, inbound <-chan codexapp.Inbound, projector *codexProjection, interactions *codexInteractions) {
	for {
		select {
		case <-ctx.Done():
			return
		case message, ok := <-inbound:
			if !ok {
				if ctx.Err() == nil {
					go c.reconnectClient(projector.generation)
				}
				return
			}
			if interactions != nil {
				interactions.Handle(message)
			}
			c.maybeSubscribeTerminalThread(ctx, message, projector)
			c.projectLive(projector, message)
		}
	}
}

func (c *codexCoordinator) reconnectClient(generation uint64) {
	c.mu.Lock()
	if c.runtime == nil || c.generation != generation || c.reconnecting || c.shuttingDown {
		c.mu.Unlock()
		return
	}
	reconnectCtx, cancelReconnect := context.WithCancel(context.Background())
	done := make(chan struct{})
	c.reconnecting = true
	c.reconnectCancel = cancelReconnect
	c.reconnectDone = done
	c.mu.Unlock()
	defer func() {
		cancelReconnect()
		c.mu.Lock()
		c.reconnecting = false
		c.reconnectCancel = nil
		c.reconnectDone = nil
		c.mu.Unlock()
		close(done)
	}()

	delay := 100 * time.Millisecond
	for attempt := 1; attempt <= 5; attempt++ {
		ctx, cancel := context.WithTimeout(reconnectCtx, 5*time.Second)
		state, stateErr := daemon.ReadCodexAppServerState()
		var runtime *codexAppServerRuntime
		var err error
		if stateErr != nil {
			err = stateErr
		} else if state.Generation != generation {
			err = fmt.Errorf("Codex app-server generation changed from %d to %d", generation, state.Generation)
		} else {
			runtime, err = c.adopt(ctx, state)
		}
		cancel()
		if reconnectCtx.Err() != nil {
			if runtime != nil && runtime.Client != nil {
				_ = runtime.Client.Close()
			}
			return
		}
		if err == nil && runtime != nil && runtime.Client != nil {
			c.mu.Lock()
			if c.runtime == nil || c.generation != generation || c.shuttingDown {
				c.mu.Unlock()
				_ = runtime.Client.Close()
				return
			}
			c.runtime = runtime
			c.startEventPumpLocked()
			persistErr := c.persistLocked()
			c.mu.Unlock()
			if persistErr != nil {
				slog.Default().Warn("persist reconnected Codex app-server", "generation", generation, "error", persistErr)
			}
			slog.Default().Info("Codex app-server client reconnected", "generation", generation, "attempt", attempt)
			_ = agentcontrol.RecordCodexReconnect(generation)
			return
		}
		slog.Default().Warn("Codex app-server client reconnect failed", "generation", generation, "attempt", attempt, "error", err)
		timer := time.NewTimer(delay)
		select {
		case <-timer.C:
		case <-reconnectCtx.Done():
			timer.Stop()
			return
		}
		if delay < 2*time.Second {
			delay *= 2
		}
	}
	c.mu.Lock()
	if c.runtime != nil && c.generation == generation {
		c.runtime.Client = nil
		c.replaceInteractionsLocked(nil)
	}
	c.mu.Unlock()
}

func (c *codexCoordinator) interactionBroker() *codexInteractions {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.interactions
}

func (c *codexCoordinator) publishProjected(events []protocol.DaemonEvent) {
	for _, event := range events {
		// Codex app-server lifecycle notifications have no timestamp field. Stamp
		// the daemon's receipt time before fan-out so clients can present the
		// actual response end time instead of their local WebSocket arrival time.
		if event.Type == "session_status" && event.LastActivityAt == "" && !event.Resync && event.Status != protocol.StatusDisconnected {
			event.LastActivityAt = time.Now().UTC().Format(time.RFC3339Nano)
		}
		if event.Type == protocol.EventTypeTurnStatus {
			// Registry sync happens here; emission dedup and forwarding are
			// owned by the daemon's outgoing chokepoint (ObserveTurnStatusEvent).
			c.syncProjectedTurnStatus(event)
		}
		c.decorateTurnLifecycle(&event)
		if event.Type == "session_status" && event.Status != protocol.StatusWaitingApproval && event.Status != protocol.StatusWaitingQuestion {
			if broker := c.interactionBroker(); broker != nil {
				broker.PublishProjectedStatus(event, func() []protocol.DaemonEvent {
					published := make([]protocol.DaemonEvent, 0, 2)
					if discovered, ok := c.applyProjectedEvent(event); ok {
						published = append(published, discovered)
					}
					c.observeTitleEvent(event)
					return append(published, event)
				})
				continue
			}
		}
		if discovered, ok := c.applyProjectedEvent(event); ok {
			c.sm.outputCh <- discovered
		}
		c.sm.outputCh <- event
		c.observeTitleEvent(event)
	}
}

// syncProjectedTurnStatus mirrors a projected turn_status event into the
// registry. It never drops or rewrites the event — forwarding decisions
// belong to the outgoing chokepoint. A completed turn flushes the pending
// codex title pair (review P1-5).
func (c *codexCoordinator) syncProjectedTurnStatus(event protocol.DaemonEvent) {
	if c.sm == nil || !c.sm.turnEnabled() || event.TurnID == "" {
		return
	}
	key := turn.ActorKey{SessionID: event.SessionID}
	if turn.IsActive(event.TurnStatus) {
		if active, ok := c.sm.turns.Active(key); ok && active.TurnID != event.TurnID {
			return // a different turn owns this actor — stale fact
		}
		if _, ok := c.sm.turns.Active(key); !ok {
			c.sm.turns.Reconcile(turn.TurnRecord{
				Actor:        key,
				Agent:        adapter.AgentCodex,
				TurnID:       event.TurnID,
				SourceTurnID: event.SourceTurnID,
				State:        event.TurnStatus,
				Origin:       event.TurnOrigin,
				Confidence:   event.TurnConfidence,
				StartedAt:    time.Now(),
			})
		}
	} else if active, ok := c.sm.turns.Active(key); ok && active.TurnID == event.TurnID {
		if _, err := c.sm.turns.Terminalize(key, event.TurnID, event.TurnStatus, event.TurnReason, event.TurnConfidence); err == nil {
			if event.TurnStatus == protocol.TurnStateCompleted {
				c.flushTitleOnTurnEnd(event.SessionID)
			} else {
				// A dead turn's pending title pair never leaks into a later
				// completed turn.
				c.titleMu.Lock()
				delete(c.titleTurns, event.SessionID)
				c.titleMu.Unlock()
			}
		}
	}
}

func (c *codexCoordinator) decorateTurnLifecycle(event *protocol.DaemonEvent) {
	if c.sm == nil || event.Type != "session_status" || event.SessionID == "" {
		return
	}
	active := event.Status == protocol.StatusRunning || event.Status == protocol.StatusBusy || event.Status == protocol.StatusRetry ||
		event.Status == protocol.StatusWaitingApproval || event.Status == protocol.StatusWaitingQuestion
	c.sm.mu.Lock()
	defer c.sm.mu.Unlock()
	ps := c.sm.sessions[event.SessionID]
	if ps == nil {
		return
	}
	if active {
		if ps.TurnStartedAt.IsZero() {
			ps.TurnStartedAt = time.Now()
		}
		event.TurnStartedAt = ps.TurnStartedAt.UTC().Format(time.RFC3339Nano)
	} else {
		ps.TurnStartedAt = time.Time{}
	}
}

func (c *codexCoordinator) observeTitleEvent(event protocol.DaemonEvent) {
	if c.sm == nil || event.SessionID == "" || (event.Type != "user_text" && event.Type != "agent_text") {
		return
	}
	c.titleMu.Lock()
	if c.titleTurns == nil {
		c.titleTurns = make(map[string]codexTitleTurn)
	}
	titleTurn := c.titleTurns[event.SessionID]
	if event.Type == "user_text" {
		titleTurn = codexTitleTurn{user: strings.TrimSpace(event.Snapshot)}
		if titleTurn.user == "" {
			titleTurn.user = strings.TrimSpace(event.Text)
		}
		c.titleTurns[event.SessionID] = titleTurn
		c.titleMu.Unlock()
		return
	}
	titleTurn.assistant = strings.TrimSpace(event.Snapshot)
	if titleTurn.assistant == "" {
		titleTurn.assistant = strings.TrimSpace(event.Text)
	}
	// The pair is kept pending until the turn completes (flushTitleOnTurnEnd,
	// review P1-5): firing at the final agent_text raced the turn terminal —
	// the completion guard dropped the first turn's title and never retried,
	// while later turns leaked the previous completed turn's approval.
	c.titleTurns[event.SessionID] = titleTurn
	c.titleMu.Unlock()
}

// flushTitleOnTurnEnd generates the pending title after a turn reached a
// terminal state. Only completed turns flush — interrupted/failed/abandoned
// turns never count as success (plan stage 2).
func (c *codexCoordinator) flushTitleOnTurnEnd(sessionID string) {
	if c.sm == nil {
		return
	}
	c.titleMu.Lock()
	titleTurn, ok := c.titleTurns[sessionID]
	if !ok || titleTurn.user == "" || titleTurn.assistant == "" {
		c.titleMu.Unlock()
		return
	}
	delete(c.titleTurns, sessionID)
	c.titleMu.Unlock()
	c.sm.GenerateTitle(sessionID, titleTurn.user, titleTurn.assistant)
}

func (c *codexCoordinator) projectLive(projector *codexProjection, message codexapp.Inbound) {
	c.projectionMu.Lock()
	defer c.projectionMu.Unlock()
	c.observeTurnNotification(message)
	if threadID, status, ok := codexThreadStatusNotification(message); ok {
		c.reconcileActiveTurnStatus(threadID, status)
	}
	c.publishProjected(projector.Project(message))
	if threadID := codexTurnStartedThreadID(message); threadID != "" {
		c.refreshManagedThreadModelAsync(threadID)
	}
}

// codexTurnStartedThreadID identifies the lifecycle point at which the Codex
// app-server has committed the GUI's currently selected model to a new turn.
func codexTurnStartedThreadID(message codexapp.Inbound) string {
	if message.Method != "turn/started" {
		return ""
	}
	var params struct {
		ThreadID string `json:"threadId"`
	}
	if json.Unmarshal(message.Params, &params) != nil {
		return ""
	}
	return strings.TrimSpace(params.ThreadID)
}

// refreshManagedThreadModelAsync reads the current model from the same
// thread/resume result already used for managed-session hydration. App-server
// notifications do not expose a separate model-change frame, so turn start is
// the first authoritative point after a GUI selection takes effect.
func (c *codexCoordinator) refreshManagedThreadModelAsync(threadID string) {
	client, generation, ok := c.backendClient()
	if !ok || threadID == "" {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		var resumed struct {
			Model string `json:"model"`
		}
		if err := client.Call(ctx, "thread/resume", map[string]any{"threadId": threadID, "excludeTurns": true}, &resumed); err != nil {
			slog.Default().Debug("Codex model refresh failed", "thread", threadID, "generation", generation, "error", err)
			return
		}
		model := strings.TrimSpace(resumed.Model)
		current, exists := c.sm.GetSessionModel(threadID)
		if !exists || model == "" || model == current {
			return
		}
		if current == "" {
			// Initial discovery is metadata, not a user-visible model switch.
			c.sm.SetSessionModel(threadID, model)
			c.sm.outputCh <- protocol.DaemonEvent{Type: "session_meta", SessionID: threadID, Model: model}
			return
		}
		// The daemon's central outgoing classifier commits this new model and
		// keeps it durable before Relay fans it out to Web/iOS.
		c.sm.outputCh <- protocol.DaemonEvent{Type: "session_model_changed", SessionID: threadID, Model: model}
	}()
}

func (c *codexCoordinator) projectHistorical(projector *codexProjection, message codexapp.Inbound) {
	c.projectionMu.Lock()
	c.publishProjected(projector.ProjectHistorical(message))
	c.projectionMu.Unlock()
}

func (c *codexCoordinator) maybeSubscribeTerminalThread(parent context.Context, message codexapp.Inbound, projector *codexProjection) {
	if message.Method != "thread/status/changed" {
		return
	}
	client, generation, ok := c.backendClient()
	if !ok {
		return
	}
	var params struct {
		ThreadID string `json:"threadId"`
	}
	if json.Unmarshal(message.Params, &params) != nil || params.ThreadID == "" {
		return
	}
	if c.rejectCodexDesktopManagedThread(params.ThreadID) {
		return
	}
	c.sm.mu.RLock()
	ps := c.sm.sessions[params.ThreadID]
	alreadyOwned := ps != nil && ps.Source == "daemon" && ps.Backend != nil
	c.sm.mu.RUnlock()
	if alreadyOwned || !c.beginSubscription(params.ThreadID) {
		return
	}
	c.startTerminalThreadSubscription(parent, client, generation, params.ThreadID, projector)
}

func (c *codexCoordinator) beginSubscription(threadID string) bool {
	c.subscribeMu.Lock()
	defer c.subscribeMu.Unlock()
	if _, ok := c.subscribed[threadID]; ok {
		return false
	}
	if _, ok := c.subscribing[threadID]; ok {
		return false
	}
	c.subscribing[threadID] = struct{}{}
	return true
}

func (c *codexCoordinator) finishSubscription(threadID string, success bool) {
	c.subscribeMu.Lock()
	delete(c.subscribing, threadID)
	if success {
		c.subscribed[threadID] = struct{}{}
		c.managedThreads[threadID] = struct{}{}
	}
	c.subscribeMu.Unlock()
	if success && c.sm != nil {
		if err := c.persist(); err != nil {
			slog.Default().Warn("persist Codex managed thread registry", "thread", threadID, "error", err)
		}
	}
}

func (c *codexCoordinator) markSubscribed(threadID string) {
	if threadID == "" {
		return
	}
	c.subscribeMu.Lock()
	delete(c.subscribing, threadID)
	c.subscribed[threadID] = struct{}{}
	c.managedThreads[threadID] = struct{}{}
	c.subscribeMu.Unlock()
	if c.sm != nil {
		if err := c.persist(); err != nil {
			slog.Default().Warn("persist Codex managed thread registry", "thread", threadID, "error", err)
		}
	}
}

func (c *codexCoordinator) restoreManagedThreads(threadIDs []string) {
	c.subscribeMu.Lock()
	defer c.subscribeMu.Unlock()
	c.subscribed = make(map[string]struct{})
	c.subscribing = make(map[string]struct{})
	c.managedThreads = make(map[string]struct{}, len(threadIDs))
	for _, threadID := range threadIDs {
		if threadID != "" && !c.isCodexDesktopOrigin(threadID) {
			c.managedThreads[threadID] = struct{}{}
		}
	}
}

// isCodexDesktopOrigin treats the rollout's immutable creation metadata as
// authoritative. App-server visibility or a successful thread/resume does not
// transfer ownership of a thread created by Codex Desktop to PocketCtl.
func (c *codexCoordinator) isCodexDesktopOrigin(threadID string) bool {
	if threadID == "" {
		return false
	}
	if c.sm != nil {
		c.sm.mu.RLock()
		state := c.sm.sessions[threadID]
		observer := state != nil && state.Agent == adapter.AgentCodexDesktop && state.Source == "observer"
		c.sm.mu.RUnlock()
		if observer {
			return true
		}
	}
	path, err := adapter.ResolveJSONLPathFor(adapter.AgentCodex, threadID, "")
	if err != nil {
		return false
	}
	meta, ok := adapter.ReadCodexRolloutMetadata(path)
	if !ok || meta.ID != threadID || meta.IsSubagent {
		return false
	}
	classification := adapter.ClassifyCodexOrigin(meta)
	return classification.Classified && classification.AgentType == adapter.AgentCodexDesktop
}

func (c *codexCoordinator) rejectCodexDesktopManagedThread(threadID string) bool {
	if !c.isCodexDesktopOrigin(threadID) {
		return false
	}
	c.subscribeMu.Lock()
	_, persisted := c.managedThreads[threadID]
	delete(c.managedThreads, threadID)
	delete(c.subscribed, threadID)
	delete(c.subscribing, threadID)
	c.subscribeMu.Unlock()
	if persisted && c.sm != nil {
		if err := c.persist(); err != nil {
			slog.Default().Warn("remove Codex Desktop observer from managed registry", "thread", threadID, "error", err)
		}
	}
	return true
}

func (c *codexCoordinator) managedThreadSnapshot() []string {
	c.subscribeMu.Lock()
	defer c.subscribeMu.Unlock()
	threadIDs := make([]string, 0, len(c.managedThreads))
	for threadID := range c.managedThreads {
		threadIDs = append(threadIDs, threadID)
	}
	sort.Strings(threadIDs)
	return threadIDs
}

func (c *codexCoordinator) subscribeTerminalThread(parent context.Context, client codexRuntimeClient, generation uint64, threadID string, projector *codexProjection) {
	if c.rejectCodexDesktopManagedThread(threadID) {
		return
	}
	c.sm.EnsureSessionLoaded(threadID)
	restoredActivityAt, hasRestoredActivity := c.sm.SessionActivityAt(threadID)
	ctx, cancel := context.WithTimeout(parent, 15*time.Second)
	defer cancel()
	var resumed struct {
		Thread json.RawMessage `json:"thread"`
		Model  string          `json:"model"`
		Cwd    string          `json:"cwd"`
	}
	statusRevision := projector.ThreadStatusRevision(threadID)
	_, turnRevision := c.turnSnapshot(threadID)
	err := client.Call(ctx, "thread/resume", map[string]any{"threadId": threadID, "excludeTurns": true}, &resumed)
	if c.rejectCodexDesktopManagedThread(threadID) {
		return
	}
	c.projectionMu.Lock()
	if err == nil && len(resumed.Thread) > 0 {
		overrideStatus := ""
		liveTurn, currentTurnRevision := c.turnSnapshot(threadID)
		if currentTurnRevision != turnRevision {
			overrideStatus = "idle"
			if liveTurn != "" {
				overrideStatus = "active"
			}
		}
		events, _ := projector.ProjectResumedThread(resumed.Thread, threadID, statusRevision, overrideStatus)
		if hasRestoredActivity && !restoredActivityAt.IsZero() {
			for i := range events {
				if events[i].Type == "session_discovered" && events[i].LastActivityAt == "" {
					events[i].LastActivityAt = restoredActivityAt.UTC().Format(time.RFC3339Nano)
				}
			}
		}
		c.publishProjected(events)
	}
	c.projectionMu.Unlock()
	if err != nil {
		c.finishSubscription(threadID, false)
		slog.Default().Warn("Codex terminal thread subscription failed", "thread", threadID, "generation", generation, "error", err)
		return
	}
	historicalActiveTurn := ""
	cursor := ""
	visitedCursors := map[string]struct{}{"": {}}
	hydrationComplete := false
	for {
		if c.rejectCodexDesktopManagedThread(threadID) {
			return
		}
		var page struct {
			Data       []json.RawMessage `json:"data"`
			NextCursor string            `json:"nextCursor"`
		}
		params := map[string]any{
			"threadId": threadID, "itemsView": "full", "sortDirection": "asc", "limit": 100,
		}
		if cursor != "" {
			params["cursor"] = cursor
		}
		if err := client.Call(ctx, "thread/turns/list", params, &page); err != nil {
			slog.Default().Warn("Codex terminal thread hydration failed", "thread", threadID, "generation", generation, "error", err)
			break
		}
		historicalActiveTurn = c.hydrateTurns(threadID, page.Data, historicalActiveTurn, projector)
		if page.NextCursor == "" {
			hydrationComplete = true
			break
		}
		if _, visited := visitedCursors[page.NextCursor]; visited {
			slog.Default().Warn("Codex terminal thread hydration returned cursor cycle", "thread", threadID, "generation", generation)
			break
		}
		visitedCursors[page.NextCursor] = struct{}{}
		cursor = page.NextCursor
	}
	c.projectionMu.Lock()
	c.reconcileHydratedActiveTurn(threadID, projector.CurrentThreadStatus(threadID), historicalActiveTurn, turnRevision, hydrationComplete)
	c.projectionMu.Unlock()
	// A reconnect can replace the daemon client while an old resume/hydration
	// call is still completing. Never attach a backend that writes through the
	// stale connection or mutate the new connection's subscription bookkeeping.
	currentClient, currentGeneration, current := c.backendClient()
	if !current || currentGeneration != generation || currentClient != client {
		return
	}
	if c.rejectCodexDesktopManagedThread(threadID) {
		return
	}
	backend := newCodexAppServerBackend(c.sm, c, client, generation)
	c.sm.mu.Lock()
	if ps := c.sm.sessions[threadID]; ps != nil {
		ps.Backend = backend
		ps.Agent = adapter.AgentCodex
		ps.Source = "terminal"
		ps.ControlMode = protocol.ControlManaged
		if resumed.Model != "" {
			ps.Model = resumed.Model
		}
		if ps.Cwd == "" && resumed.Cwd != "" {
			ps.Cwd = resumed.Cwd
			c.registerProjectedCwdLocked(threadID, "", resumed.Cwd)
		}
	}
	c.sm.mu.Unlock()
	if resumed.Model != "" {
		c.sm.outputCh <- protocol.DaemonEvent{Type: "session_meta", SessionID: threadID, Model: resumed.Model, Resync: true}
	}
	c.finishSubscription(threadID, true)
}

func (c *codexCoordinator) hydrateTurns(threadID string, turns []json.RawMessage, activeTurn string, projector *codexProjection) string {
	for _, rawTurn := range turns {
		var turn struct {
			ID     string            `json:"id"`
			Status string            `json:"status"`
			Items  []json.RawMessage `json:"items"`
		}
		if json.Unmarshal(rawTurn, &turn) != nil || turn.ID == "" {
			continue
		}
		if turn.Status == "inProgress" {
			activeTurn = turn.ID
			params, _ := json.Marshal(map[string]any{"threadId": threadID, "turn": json.RawMessage(rawTurn)})
			n := codexapp.Inbound{Method: "turn/started", Params: params}
			c.projectHistorical(projector, n)
		}
		for _, item := range turn.Items {
			params, _ := json.Marshal(map[string]any{"threadId": threadID, "turnId": turn.ID, "completedAtMs": 0, "item": json.RawMessage(item)})
			c.projectHistorical(projector, codexapp.Inbound{Method: "item/completed", Params: params})
		}
		if turn.Status != "inProgress" {
			activeTurn = ""
			params, _ := json.Marshal(map[string]any{"threadId": threadID, "turn": json.RawMessage(rawTurn)})
			n := codexapp.Inbound{Method: "turn/completed", Params: params}
			c.projectHistorical(projector, n)
		}
	}
	return activeTurn
}

func (c *codexCoordinator) observeTurnNotification(message codexapp.Inbound) {
	if message.Method != "turn/started" && message.Method != "turn/completed" {
		return
	}
	var params struct {
		ThreadID string `json:"threadId"`
		Turn     struct {
			ID string `json:"id"`
		} `json:"turn"`
	}
	if json.Unmarshal(message.Params, &params) != nil || params.ThreadID == "" || params.Turn.ID == "" {
		return
	}
	if message.Method == "turn/started" {
		c.turnMu.Lock()
		c.activeTurn[params.ThreadID] = params.Turn.ID
		c.turnRevision[params.ThreadID]++
		c.turnMu.Unlock()
		return
	}
	c.turnMu.Lock()
	if c.activeTurn[params.ThreadID] == params.Turn.ID {
		delete(c.activeTurn, params.ThreadID)
	}
	c.turnRevision[params.ThreadID]++
	c.turnMu.Unlock()
}

func codexThreadStatusNotification(message codexapp.Inbound) (string, string, bool) {
	if message.Method != "thread/status/changed" {
		return "", "", false
	}
	var params struct {
		ThreadID string            `json:"threadId"`
		Status   codexThreadStatus `json:"status"`
	}
	if json.Unmarshal(message.Params, &params) != nil || params.ThreadID == "" || params.Status.Type == "" {
		return "", "", false
	}
	return params.ThreadID, params.Status.Type, true
}

func (c *codexCoordinator) reconcileActiveTurnStatus(threadID, status string) {
	if status != "active" {
		c.setActiveTurn(threadID, "")
	}
}

func (c *codexCoordinator) reconcileHydratedActiveTurn(threadID, status, historicalTurn string, baseline uint64, hydrationComplete bool) {
	_, revision := c.turnSnapshot(threadID)
	if revision != baseline {
		return
	}
	if status != "active" {
		c.setActiveTurn(threadID, "")
		return
	}
	if hydrationComplete {
		c.setActiveTurn(threadID, historicalTurn)
	}
}

func (c *codexCoordinator) turnSnapshot(threadID string) (string, uint64) {
	c.turnMu.RLock()
	defer c.turnMu.RUnlock()
	return c.activeTurn[threadID], c.turnRevision[threadID]
}

func (c *codexCoordinator) setActiveTurn(threadID, turnID string) {
	c.turnMu.Lock()
	if turnID == "" {
		delete(c.activeTurn, threadID)
	} else {
		c.activeTurn[threadID] = turnID
	}
	c.turnMu.Unlock()
}

func (c *codexCoordinator) currentTurn(threadID string) string {
	c.turnMu.RLock()
	defer c.turnMu.RUnlock()
	return c.activeTurn[threadID]
}

// applyProjectedEvent mirrors native Codex state into the SessionManager. It
// returns a synthetic discovery when a late item/status notification arrives
// before thread/started, which is normal when a daemon joins an active TUI.
func (c *codexCoordinator) applyProjectedEvent(event protocol.DaemonEvent) (protocol.DaemonEvent, bool) {
	if c.sm == nil || event.SessionID == "" {
		return protocol.DaemonEvent{}, false
	}
	now := time.Now()
	activityAt := now
	if event.LastActivityAt != "" {
		if parsed, err := time.Parse(time.RFC3339Nano, event.LastActivityAt); err == nil {
			activityAt = parsed
		}
	} else if event.Resync || event.Status == protocol.StatusDisconnected {
		activityAt = time.Time{}
	}
	c.sm.mu.Lock()
	defer c.sm.mu.Unlock()
	ps, exists := c.sm.sessions[event.SessionID]
	if event.Type == "session_discovered" {
		if !exists {
			ps = &ProcessState{
				SessionID: event.SessionID, Status: event.Status, StartedAt: now, LastActivityAt: activityAt,
				Cwd: event.Cwd, Agent: adapter.AgentCodex, Source: event.Source,
				ControlMode: protocol.ControlManaged,
			}
			c.sm.sessions[event.SessionID] = ps
			c.registerProjectedCwdLocked(event.SessionID, "", event.Cwd)
		} else {
			if event.Cwd != "" {
				oldCwd := ps.Cwd
				ps.Cwd = event.Cwd
				c.registerProjectedCwdLocked(event.SessionID, oldCwd, event.Cwd)
			}
			if event.Status != "" {
				ps.Status = event.Status
			}
			if !activityAt.IsZero() && activityAt.After(ps.LastActivityAt) {
				ps.LastActivityAt = activityAt
			}
		}
		return protocol.DaemonEvent{}, false
	}
	if !exists {
		ps = &ProcessState{
			SessionID: event.SessionID, Status: protocol.StatusIdle, StartedAt: now, LastActivityAt: activityAt,
			Agent: adapter.AgentCodex, Source: "terminal", ControlMode: protocol.ControlManaged,
		}
		c.sm.sessions[event.SessionID] = ps
		discovered := protocol.DaemonEvent{
			Type: "session_discovered", SessionID: event.SessionID, Status: ps.Status,
			Agent: adapter.AgentCodex, Source: ps.Source, ControlMode: ps.ControlMode,
		}
		if event.Type == "session_status" && event.Status != "" {
			ps.Status = event.Status
		}
		return discovered, true
	}
	if event.Type == "session_status" && event.Status != "" {
		ps.Status = event.Status
	}
	if !activityAt.IsZero() && activityAt.After(ps.LastActivityAt) {
		ps.LastActivityAt = activityAt
	}
	return protocol.DaemonEvent{}, false
}

func (c *codexCoordinator) registerProjectedCwdLocked(sessionID, oldCwd, newCwd string) {
	if oldCwd != "" && normalizeCwd(oldCwd) != normalizeCwd(newCwd) {
		oldKey := normalizeCwd(oldCwd)
		if set := c.sm.cwdSessions[oldKey]; set != nil {
			delete(set, sessionID)
			if len(set) == 0 {
				delete(c.sm.cwdSessions, oldKey)
			}
		}
	}
	if newCwd == "" {
		return
	}
	key := normalizeCwd(newCwd)
	set := c.sm.cwdSessions[key]
	if set == nil {
		set = make(map[string]struct{})
		c.sm.cwdSessions[key] = set
	}
	set[sessionID] = struct{}{}
}

func runtimeProtocolError(err error) error {
	return &agentcontrol.ProtocolError{Code: agentcontrol.ErrRuntimeUnavailable, Message: fmt.Sprintf("%v", err)}
}
