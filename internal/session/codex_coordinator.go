package session

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"sort"
	"sync"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/agentcontrol"
	"github.com/pocketctl/pocketctl/internal/codexapp"
	"github.com/pocketctl/pocketctl/internal/daemon"
	"github.com/pocketctl/pocketctl/internal/platform"
	"github.com/pocketctl/pocketctl/internal/protocol"
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

type codexCoordinator struct {
	sm *SessionManager

	mu             sync.Mutex
	runtime        *codexAppServerRuntime
	binary         string
	version        string
	schemaHash     string
	generation     uint64
	start          codexRuntimeStarter
	adopt          func(context.Context, *daemon.CodexAppServerState) (*codexAppServerRuntime, error)
	pumpCancel     context.CancelFunc
	turnMu         sync.RWMutex
	activeTurn     map[string]string
	subscribeMu    sync.Mutex
	subscribed     map[string]struct{}
	subscribing    map[string]struct{}
	managedThreads map[string]struct{}
	interactions   *codexInteractions
	reconnecting   bool
}

func newCodexCoordinator(sm *SessionManager) *codexCoordinator {
	return &codexCoordinator{
		sm: sm, start: startCodexAppServer, adopt: adoptCodexAppServer,
		activeTurn: make(map[string]string), subscribed: make(map[string]struct{}), subscribing: make(map[string]struct{}), managedThreads: make(map[string]struct{}),
	}
}

func (c *codexCoordinator) ensureStarted(ctx context.Context, binary, version string, capabilities agentcontrol.CodexCapabilities) (codexRuntimeSnapshot, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.runtime != nil {
		return c.snapshotLocked(), nil
	}
	state, stateErr := daemon.ReadCodexAppServerState()
	if stateErr == nil {
		c.generation = state.Generation
		alive := platform.NewProcessController().IsAlive(state.PID)
		ownerAvailable := state.OwnerPID <= 0 || state.OwnerPID == os.Getpid() || !platform.NewProcessController().IsAlive(state.OwnerPID)
		compatible := state.Binary == binary && state.Version == version && state.SchemaHash == capabilities.SchemaHash
		if alive {
			if !ownerAvailable {
				return codexRuntimeSnapshot{}, fmt.Errorf("Codex app-server handoff is still owned by live daemon pid %d", state.OwnerPID)
			}
			if !compatible {
				return codexRuntimeSnapshot{}, errors.New("live Codex app-server handoff is incompatible; refusing competing runtime")
			}
			runtime, err := c.adopt(ctx, state)
			if err != nil {
				return codexRuntimeSnapshot{}, fmt.Errorf("adopt Codex app-server: %w", err)
			}
			c.runtime, c.binary, c.version, c.schemaHash = runtime, binary, version, capabilities.SchemaHash
			c.restoreManagedThreads(state.Threads)
			c.startEventPumpLocked()
			if c.sm != nil {
				c.sm.leases.Restore(state.Leases)
				if err := c.persistLocked(); err != nil {
					return codexRuntimeSnapshot{}, err
				}
			}
			return c.snapshotLocked(), nil
		}
		if err := daemon.RemoveCodexAppServerState(); err != nil {
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
	c.restoreManagedThreads(nil)
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
	return daemon.WriteCodexAppServerState(&daemon.CodexAppServerState{
		PID: c.runtime.PID, OwnerPID: ownerPID, Endpoint: c.runtime.Endpoint,
		RemoteURI: c.runtime.RemoteURI, Binary: c.binary, Version: c.version,
		SchemaHash: c.schemaHash, Generation: c.generation, Leases: c.sm.leases.Snapshot(),
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
	defer c.mu.Unlock()
	if c.runtime == nil {
		return nil
	}
	c.stopEventPumpLocked()
	if c.sm != nil && len(c.sm.leases.Active(c.generation)) > 0 {
		return c.persistOwnerLocked(0)
	}
	var err error
	if c.runtime.Stop != nil {
		err = c.runtime.Stop()
	}
	c.runtime = nil
	if removeErr := daemon.RemoveCodexAppServerState(); err == nil {
		err = removeErr
	}
	return err
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
	c.interactions = newCodexInteractions(c.sm, c.generation, c.runtime.Client)
	go c.consumeEventsWithInteractions(ctx, c.runtime.Client.Events(), projector, c.interactions)
	client, generation := c.runtime.Client, c.generation
	for _, threadID := range c.managedThreadSnapshot() {
		if c.beginSubscription(threadID) {
			go c.subscribeTerminalThread(context.Background(), client, generation, threadID, projector)
		}
	}
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
	c.interactions = nil
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
			c.observeTurnNotification(message)
			c.maybeSubscribeTerminalThread(ctx, message, projector)
			c.publishProjected(projector.Project(message))
		}
	}
}

func (c *codexCoordinator) reconnectClient(generation uint64) {
	c.mu.Lock()
	if c.runtime == nil || c.generation != generation || c.reconnecting {
		c.mu.Unlock()
		return
	}
	c.reconnecting = true
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		c.reconnecting = false
		c.mu.Unlock()
	}()

	delay := 100 * time.Millisecond
	for attempt := 1; attempt <= 5; attempt++ {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
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
		if err == nil && runtime != nil && runtime.Client != nil {
			c.mu.Lock()
			if c.runtime == nil || c.generation != generation {
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
		<-timer.C
		if delay < 2*time.Second {
			delay *= 2
		}
	}
	c.mu.Lock()
	if c.runtime != nil && c.generation == generation {
		c.runtime.Client = nil
		c.interactions = nil
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
		if event.Type == "session_status" && event.Status != protocol.StatusWaitingApproval && event.Status != protocol.StatusWaitingQuestion {
			if broker := c.interactionBroker(); broker != nil && broker.HasPending(event.SessionID) {
				continue
			}
		}
		if discovered, ok := c.applyProjectedEvent(event); ok {
			c.sm.outputCh <- discovered
		}
		c.sm.outputCh <- event
	}
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
	c.sm.mu.RLock()
	ps := c.sm.sessions[params.ThreadID]
	alreadyOwned := ps != nil && ps.Source == "daemon" && ps.Backend != nil
	c.sm.mu.RUnlock()
	if alreadyOwned || !c.beginSubscription(params.ThreadID) {
		return
	}
	go c.subscribeTerminalThread(parent, client, generation, params.ThreadID, projector)
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
		if threadID != "" {
			c.managedThreads[threadID] = struct{}{}
		}
	}
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
	ctx, cancel := context.WithTimeout(parent, 15*time.Second)
	defer cancel()
	var resumed struct {
		Thread json.RawMessage `json:"thread"`
		Model  string          `json:"model"`
		Cwd    string          `json:"cwd"`
	}
	if err := client.Call(ctx, "thread/resume", map[string]any{"threadId": threadID, "excludeTurns": true}, &resumed); err != nil {
		c.finishSubscription(threadID, false)
		slog.Default().Warn("Codex terminal thread subscription failed", "thread", threadID, "generation", generation, "error", err)
		return
	}
	if len(resumed.Thread) > 0 {
		params, _ := json.Marshal(map[string]any{"thread": json.RawMessage(resumed.Thread)})
		c.publishProjected(projector.Project(codexapp.Inbound{Method: "thread/started", Params: params}))
	}
	var page struct {
		Data []json.RawMessage `json:"data"`
	}
	if err := client.Call(ctx, "thread/turns/list", map[string]any{
		"threadId": threadID, "itemsView": "full", "sortDirection": "ascending", "limit": 100,
	}, &page); err != nil {
		slog.Default().Warn("Codex terminal thread hydration failed", "thread", threadID, "generation", generation, "error", err)
	} else {
		c.hydrateTurns(threadID, page.Data, projector)
	}
	// A reconnect can replace the daemon client while an old resume/hydration
	// call is still completing. Never attach a backend that writes through the
	// stale connection or mutate the new connection's subscription bookkeeping.
	currentClient, currentGeneration, current := c.backendClient()
	if !current || currentGeneration != generation || currentClient != client {
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
		c.sm.outputCh <- protocol.DaemonEvent{Type: "session_meta", SessionID: threadID, Model: resumed.Model}
	}
	c.finishSubscription(threadID, true)
}

func (c *codexCoordinator) hydrateTurns(threadID string, turns []json.RawMessage, projector *codexProjection) {
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
			params, _ := json.Marshal(map[string]any{"threadId": threadID, "turn": json.RawMessage(rawTurn)})
			n := codexapp.Inbound{Method: "turn/started", Params: params}
			c.observeTurnNotification(n)
			c.publishProjected(projector.Project(n))
		}
		for _, item := range turn.Items {
			params, _ := json.Marshal(map[string]any{"threadId": threadID, "turnId": turn.ID, "completedAtMs": 0, "item": json.RawMessage(item)})
			c.publishProjected(projector.Project(codexapp.Inbound{Method: "item/completed", Params: params}))
		}
		if turn.Status != "inProgress" {
			params, _ := json.Marshal(map[string]any{"threadId": threadID, "turn": json.RawMessage(rawTurn)})
			n := codexapp.Inbound{Method: "turn/completed", Params: params}
			c.observeTurnNotification(n)
			c.publishProjected(projector.Project(n))
		}
	}
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
		c.setActiveTurn(params.ThreadID, params.Turn.ID)
		return
	}
	c.turnMu.Lock()
	if c.activeTurn[params.ThreadID] == params.Turn.ID {
		delete(c.activeTurn, params.ThreadID)
	}
	c.turnMu.Unlock()
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
	c.sm.mu.Lock()
	defer c.sm.mu.Unlock()
	ps, exists := c.sm.sessions[event.SessionID]
	if event.Type == "session_discovered" {
		if !exists {
			ps = &ProcessState{
				SessionID: event.SessionID, Status: event.Status, StartedAt: now, LastActivityAt: now,
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
			ps.LastActivityAt = now
		}
		return protocol.DaemonEvent{}, false
	}
	if !exists {
		ps = &ProcessState{
			SessionID: event.SessionID, Status: protocol.StatusIdle, StartedAt: now, LastActivityAt: now,
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
	ps.LastActivityAt = now
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
