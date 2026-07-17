package session

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/agentcontrol"
	"github.com/pocketctl/pocketctl/internal/daemon"
	"github.com/pocketctl/pocketctl/internal/platform"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/watcher"
)

// opencode_backend.go wires opencode (a server-kind agent) into the manager.
//
// Architecture (see design.md — revised 2026-06-27 after finding current
// opencode persists sessions in SQLite, not the storage/ JSON tree, and its SSE
// bus is in-process):
//
//   - One shared `opencode serve` process, started eagerly, drives all opencode
//     sessions over HTTP against the shared DB.
//   - Discovery: poll GET /api/session to find terminal-started sessions (the DB
//     is shared, so the daemon's serve sees them).
//   - Sync: per tracked session, poll GET /session/{id}/message at 1s (same
//     cadence as the claude/codex JSONL tailer) and forward incremental events
//     via adapter.OpencodeSync.
//   - This unified polling replaces both the SSE demux (owned) and the file-based
//     DirWatch (terminal) — one mechanism, equivalent to claude/codex.

const (
	opencodeDiscoverInterval  = 2 * time.Second
	opencodeSyncInterval      = 1 * time.Second
	opencodeLeaseReapInterval = 2 * time.Second
	opencodeFreshWindow       = 10 * time.Minute
	opencodeReconcileWindow   = 2 * time.Hour // reconcile stuck "running" status for sessions active within this window
	opencodeSeenEventLimit    = 4096
)

type opencodeCoordinator struct {
	sm *SessionManager

	mu               sync.Mutex
	server           *adapter.OpencodeServer
	ctx              context.Context    // daemon lifetime (loops + supervisor)
	cancel           context.CancelFunc // cancels daemon lifetime
	serverCancel     context.CancelFunc // cancels the current serve process (restart)
	started          bool
	preserveServe    bool // set only while handing ownership to an in-place restart
	generation       uint64
	realBinary       string
	realVersion      string
	handoffPersisted bool

	trackMu               sync.Mutex
	tracked               map[string]context.CancelFunc // sessionID → its sync loop's cancel
	loadMu                sync.Mutex
	loads                 map[string]*opencodeLoadCall
	interactionMu         sync.Mutex
	eventMu               sync.Mutex
	seenInteractionEvents map[string]struct{}
	seenInteractionOrder  []string
	resolvedInteractions  map[string]struct{}
	resolvedOrder         []string
	interactionGeneration map[interactionGenerationScope]uint64
	managedMu             sync.RWMutex
	managedSessions       map[string]managedOpenCodeSession
	pendingForks          map[string][]managedOpenCodeSession
	baselineMu            sync.RWMutex
	baselineModes         map[string]string
	processInspector      platform.ProcessInspector

	reconciled     map[string]bool // sessionIDs whose stale "running" status was reconciled to idle
	summaryOnce    sync.Once
	recoverSession func(context.Context, string)
}

type opencodeLoadCall struct {
	done     chan struct{}
	loaded   bool
	notFound bool
}

type managedOpenCodeSession struct {
	CWD        string
	Generation uint64
}

func newOpencodeCoordinator(sm *SessionManager) *opencodeCoordinator {
	c := &opencodeCoordinator{
		sm:                    sm,
		tracked:               make(map[string]context.CancelFunc),
		loads:                 make(map[string]*opencodeLoadCall),
		reconciled:            make(map[string]bool),
		seenInteractionEvents: make(map[string]struct{}),
		resolvedInteractions:  make(map[string]struct{}),
		interactionGeneration: make(map[interactionGenerationScope]uint64),
		managedSessions:       make(map[string]managedOpenCodeSession),
		pendingForks:          make(map[string][]managedOpenCodeSession),
		baselineModes:         make(map[string]string),
		processInspector:      platform.NewProcessInspector(),
	}
	c.recoverSession = c.reconcileSessionInteractions
	return c
}

// ensureStarted lazily launches the shared opencode serve process. Safe to call
// repeatedly. c.ctx is the daemon-lifetime context (loops + supervisor); the
// serve process runs under a child context (serverCancel) so it can be restarted
// independently without killing the loops.
func (c *opencodeCoordinator) ensureStarted() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.started {
		return nil
	}
	if c.ctx == nil {
		c.ctx, c.cancel = context.WithCancel(context.Background())
	}
	state, stateErr := daemon.ReadOpenCodeServeState()
	if stateErr != nil && !os.IsNotExist(stateErr) {
		if err := daemon.RemoveOpenCodeServeState(); err != nil {
			return fmt.Errorf("remove invalid opencode handoff: %w", err)
		}
	}
	if stateErr == nil {
		c.generation = normalizedOpenCodeGeneration(state.Generation)
		c.sm.leases.Restore(state.Leases)
		c.restoreControlRegistry(state)
		if !handoffOwnerAvailable(state) {
			return fmt.Errorf("opencode handoff still owned by live daemon pid %d", state.OwnerPID)
		}
		if cliPath, installedVersion, resolveErr := resolveOpenCodeCLI(); resolveErr == nil {
			attached, err := c.tryAttachHandoffLocked(state, installedVersion)
			if err != nil {
				return err
			}
			if attached {
				c.realBinary, c.realVersion = cliPath, installedVersion
				return nil
			}
		} else {
			return fmt.Errorf("resolve opencode CLI while serve handoff exists: %w", resolveErr)
		}
	}
	server, scancel, err := c.launchServerLocked()
	if err != nil {
		return err
	}
	c.server = server
	c.serverCancel = scancel
	c.started = true
	return nil
}

func handoffOwnerAvailable(state *daemon.OpenCodeServeState) bool {
	return state.OwnerPID <= 0 || state.OwnerPID == os.Getpid() || !platform.NewProcessController().IsAlive(state.OwnerPID)
}

func (c *opencodeCoordinator) tryAttachHandoffLocked(state *daemon.OpenCodeServeState, installedVersion string) (bool, error) {
	ctx, cancel := context.WithTimeout(c.ctx, 5*time.Second)
	defer cancel()
	server, err := adapter.AttachOpencodeServer(ctx, state.BaseURL, state.Password, state.PID, state.Version, state.UpdatedAt)
	if err != nil {
		if platform.NewProcessController().IsAlive(state.PID) {
			return false, fmt.Errorf("live opencode serve identity unverifiable; refusing competing serve: %w", err)
		}
		if removeErr := daemon.RemoveOpenCodeServeState(); removeErr != nil {
			return false, removeErr
		}
		return false, nil
	}
	if server.Version() != installedVersion {
		if err := server.Stop(); err != nil {
			return false, fmt.Errorf("stop incompatible opencode serve: %w", err)
		}
		if err := daemon.RemoveOpenCodeServeState(); err != nil {
			return false, err
		}
		return false, nil
	}
	generation := normalizedOpenCodeGeneration(state.Generation)
	if err := daemon.ClaimOpenCodeServeState(state.OwnerPID, c.openCodeHandoffState(server, generation)); err != nil {
		return false, err
	}
	_, scancel := context.WithCancel(c.ctx)
	c.server, c.serverCancel, c.started = server, scancel, true
	c.generation = generation
	c.handoffPersisted = true
	return true, nil
}

// launchServerLocked starts a new serve process under a child of c.ctx. Caller
// holds c.mu and has ensured c.ctx is set.
func (c *opencodeCoordinator) launchServerLocked() (*adapter.OpencodeServer, context.CancelFunc, error) {
	cliPath, cliVersion, err := resolveOpenCodeCLI()
	if err != nil {
		return nil, nil, err
	}
	server := adapter.NewOpencodeServer(cliPath)
	sctx, scancel := context.WithCancel(c.ctx)
	if err := server.Start(sctx); err != nil {
		scancel()
		return nil, nil, fmt.Errorf("start opencode serve: %w", err)
	}
	generation := nextOpenCodeGeneration(c.generation)
	c.setManagedGeneration(generation)
	if err := daemon.WriteOpenCodeServeState(c.openCodeHandoffState(server, generation)); err != nil {
		server.Stop()
		scancel()
		return nil, nil, fmt.Errorf("persist opencode serve handoff: %w", err)
	}
	c.generation = generation
	c.realBinary = cliPath
	c.realVersion = cliVersion
	c.handoffPersisted = true
	return server, scancel, nil
}

func resolveOpenCodeCLI() (string, string, error) {
	return agentcontrol.ResolveConfiguredOpenCode()
}

func (c *opencodeCoordinator) attachHandoffLocked(state *daemon.OpenCodeServeState) error {
	cliPath, cliVersion, err := resolveOpenCodeCLI()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(c.ctx, 5*time.Second)
	defer cancel()
	server, err := adapter.AttachOpencodeServer(ctx, state.BaseURL, state.Password, state.PID, state.Version, state.UpdatedAt)
	if err != nil {
		return err
	}
	generation := normalizedOpenCodeGeneration(state.Generation)
	c.restoreControlRegistry(state)
	if err := daemon.ClaimOpenCodeServeState(state.OwnerPID, c.openCodeHandoffState(server, generation)); err != nil {
		server.Stop()
		return err
	}
	_, scancel := context.WithCancel(c.ctx)
	c.server, c.serverCancel, c.started = server, scancel, true
	c.generation = generation
	c.realBinary = cliPath
	c.realVersion = cliVersion
	c.handoffPersisted = true
	return nil
}

func (c *opencodeCoordinator) openCodeHandoffState(server *adapter.OpencodeServer, generation uint64) *daemon.OpenCodeServeState {
	managed, pending := c.controlRegistrySnapshot()
	return &daemon.OpenCodeServeState{
		PID: server.PID(), BaseURL: server.BaseURL(), Password: server.Password(),
		Version: server.Version(), OwnerPID: os.Getpid(), Generation: generation,
		ManagedSessions: managed, PendingForks: pending, Leases: c.sm.leases.Snapshot(), UpdatedAt: time.Now().UTC(),
	}
}

func (c *opencodeCoordinator) persistLeaseHandoff() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.server == nil {
		return nil
	}
	next := c.openCodeHandoffState(c.server, c.generation)
	current, err := daemon.ReadOpenCodeServeState()
	if os.IsNotExist(err) {
		return daemon.WriteOpenCodeServeState(next)
	}
	if err != nil {
		return err
	}
	if current.OwnerPID != os.Getpid() {
		return fmt.Errorf("cannot persist opencode leases owned by daemon pid %d", current.OwnerPID)
	}
	return daemon.ClaimOpenCodeServeState(current.OwnerPID, next)
}

func normalizedOpenCodeGeneration(generation uint64) uint64 {
	if generation == 0 {
		return 1
	}
	return generation
}

func nextOpenCodeGeneration(previous uint64) uint64 {
	if previous == ^uint64(0) {
		return 1
	}
	return previous + 1
}

// PrepareDaemonRestart transfers serve ownership to the handoff record. It is
// only called by the Web-triggered in-place restart path.
func (c *opencodeCoordinator) PrepareDaemonRestart() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.server == nil {
		return nil
	}
	if err := daemon.ClaimOpenCodeServeState(os.Getpid(), c.openCodeHandoffState(c.server, c.generation)); err != nil {
		return err
	}
	c.server.Detach()
	c.preserveServe = true
	return nil
}

func (c *opencodeCoordinator) cancelDaemonRestart() {
	c.mu.Lock()
	c.preserveServe = false
	c.mu.Unlock()
}

// srv returns the current serve client under lock (it may be swapped by a restart).
func (c *opencodeCoordinator) srv() *adapter.OpencodeServer {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.server
}

// restartServer tears down the current serve process and launches a fresh one
// (4.4: auto-recovery from a serve crash). The daemon-lifetime ctx and the
// discovery/sync/supervisor loops are unaffected.
func (c *opencodeCoordinator) restartServer() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.serverCancel != nil {
		c.serverCancel()
	}
	if c.server != nil {
		if err := c.server.Stop(); err != nil {
			slog.Default().Error("refusing opencode serve restart without verified cleanup", "error", err)
			return
		}
	}
	c.server, c.serverCancel = nil, nil
	c.started = false
	server, scancel, err := c.launchServerLocked()
	if err != nil {
		slog.Default().Error("opencode serve restart failed", "error", err)
		return
	}
	c.server = server
	c.serverCancel = scancel
	c.started = true
	slog.Default().Info("opencode serve restarted", "serve", server.BaseURL())
}

// supervise periodically health-checks the serve process and restarts it if it
// has died (4.4). Runs under the daemon-lifetime ctx.
func (c *opencodeCoordinator) supervise(ctx context.Context) {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s := c.srv()
			if s == nil {
				continue
			}
			hctx, cancel := context.WithTimeout(ctx, 5*time.Second)
			ok := s.Healthy(hctx)
			cancel()
			c.sm.observeOpenCodeRuntimeHealth(ok)
			if !ok {
				slog.Default().Warn("opencode serve unhealthy — restarting")
				c.restartServer()
			}
		}
	}
}

func (c *opencodeCoordinator) reapTerminalLeases() error {
	if !c.sm.leases.Prune() {
		return nil
	}
	return c.persistLeaseHandoff()
}

func (c *opencodeCoordinator) leaseReaper(ctx context.Context) {
	ticker := time.NewTicker(opencodeLeaseReapInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := c.reapTerminalLeases(); err != nil {
				slog.Default().Warn("persist reaped opencode terminal lease failed", "error", err)
			}
		}
	}
}

// Shutdown stops the serve process and all sync loops.
func (c *opencodeCoordinator) Shutdown() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.preserveServe && c.server != nil && len(c.sm.leases.Active(c.generation)) > 0 {
		next := c.openCodeHandoffState(c.server, c.generation)
		next.OwnerPID = 0
		if current, err := daemon.ReadOpenCodeServeState(); err == nil && current.OwnerPID == os.Getpid() {
			if err := daemon.ClaimOpenCodeServeState(current.OwnerPID, next); err != nil {
				slog.Default().Error("persist opencode active lease handoff", "error", err)
			}
		} else if os.IsNotExist(err) {
			if err := daemon.WriteOpenCodeServeState(next); err != nil {
				slog.Default().Error("write opencode active lease handoff", "error", err)
			}
		} else if err != nil {
			slog.Default().Error("read opencode active lease handoff", "error", err)
		} else {
			slog.Default().Error("opencode active lease handoff owner changed", "owner_pid", current.OwnerPID)
		}
		// An active terminal is the stronger safety invariant. Even if the
		// metadata update failed, relinquish process ownership rather than
		// interrupting the user's TUI. A later daemon start can diagnose or
		// clean the stale handoff record without killing this attach mid-turn.
		c.server.Detach()
		c.preserveServe = true
	}
	if c.cancel != nil {
		c.cancel()
	}
	if !c.preserveServe {
		stopped := true
		if c.server != nil {
			if err := c.server.Stop(); err != nil {
				stopped = false
				slog.Default().Error("opencode serve shutdown requires CLI cleanup", "error", err)
			}
		}
		if stopped {
			_ = daemon.RemoveOpenCodeServeState()
		}
	}
	c.started = false
}

// startDiscovery starts the serve process (if needed), the discovery loop that
// finds terminal-started sessions, and the serve health supervisor. Idempotent
// per coordinator.
func (c *opencodeCoordinator) startDiscovery() error {
	if err := c.ensureStarted(); err != nil {
		return err
	}
	if err := c.initializeControlBaseline(c.ctx); err != nil {
		return fmt.Errorf("initialize opencode control baseline: %w", err)
	}
	slog.Default().Info("opencode discovery started", "serve", c.srv().BaseURL())
	go c.discoveryLoop(c.ctx)
	go c.supervise(c.ctx)
	go c.leaseReaper(c.ctx)
	go c.interactionLoop(c.ctx)
	return nil
}

// Tool approval: opencode 1.17.x emits permission.asked / permission.replied SSE
// events for sessions THIS serve drives. The daemon's serve forces edit/bash to
// "ask" (OPENCODE_CONFIG_CONTENT in OpencodeServer.Start), so daemon-driven
// sessions raise permission.asked, which permissionLoop surfaces as an
// approval_request card (reply routed via ResolveApprovalAction → the matching
// legacy/v2 OpenCode reply endpoint). Requests remain pending until an explicit
// response or authoritative reconciliation. Terminal `opencode`
// sessions are driven by the user's own server, whose permission events this serve
// never sees — those keep prompting in the user's terminal.

// interactionLoop subscribes to OpenCode's SSE stream, surfaces permission and
// question cards, and reconciles pending state whenever the stream reconnects.
func (c *opencodeCoordinator) interactionLoop(ctx context.Context) {
	for {
		if ctx.Err() != nil {
			return
		}
		srv := c.srv()
		if srv == nil || srv.BaseURL() == "" {
			time.Sleep(time.Second)
			continue
		}
		evCh, err := srv.GlobalEvents(ctx)
		if err != nil {
			time.Sleep(2 * time.Second)
			continue
		}
		c.reconcileInteractions(ctx)
		for ev := range evCh {
			c.handleInteractionEvent(ev)
		}
		// Stream closed (serve restart / disconnect) — reconnect after a beat.
		if ctx.Err() != nil {
			return
		}
		time.Sleep(time.Second)
	}
}

func (c *opencodeCoordinator) handleInteractionEvent(ev adapter.SSEEvent) {
	c.interactionMu.Lock()
	statusSessionID := ""
	switch ev.Type {
	case "permission.asked":
		if permission, ok := adapter.ParsePermissionAsked(ev.Properties); ok {
			if c.interactionDirectoryMatches(permission.SessionID, ev.Directory) && !c.interactionResolved("permission", permission.SessionID, permission.ID) && c.claimInteractionEvent(ev.ID) {
				if c.sm.handleOpencodePermission(permission) {
					c.bumpInteractionGeneration(permission.SessionID, "permission", permission.Version)
				}
			}
		}
	case "permission.v2.asked":
		if permission, ok := adapter.ParsePermissionV2Asked(ev.Properties); ok {
			if c.interactionDirectoryMatches(permission.SessionID, ev.Directory) && !c.interactionResolved("permission", permission.SessionID, permission.ID) && c.claimInteractionEvent(ev.ID) {
				if c.sm.handleOpencodePermission(permission) {
					c.bumpInteractionGeneration(permission.SessionID, "permission", permission.Version)
				}
			}
		}
	case "permission.replied", "permission.v2.replied":
		if requestID, sessionID, action, ok := adapter.ParsePermissionResolution(ev.Properties); ok && c.interactionDirectoryMatches(sessionID, ev.Directory) {
			cleared := c.sm.clearOpencodePermission(sessionID, requestID)
			c.markInteractionResolved("permission", sessionID, requestID)
			c.bumpInteractionGeneration(sessionID, "permission", interactionVersionForEvent(ev.Type))
			if cleared {
				c.sm.outputCh <- protocol.DaemonEvent{Type: "approval_resolved", SessionID: sessionID, RequestID: requestID, Action: action, Approved: action != "reject", Reason: "resolved_elsewhere"}
				statusSessionID = sessionID
			}
		}
	case "question.asked", "question.v2.asked":
		if question, ok := adapter.ParseQuestionAsked(ev.Properties); ok {
			if ev.Type == "question.v2.asked" {
				question.Version = adapter.PermissionVersionV2
			}
			if c.interactionDirectoryMatches(question.SessionID, ev.Directory) && !c.interactionResolved("question", question.SessionID, question.ID) && c.claimInteractionEvent(ev.ID) {
				if c.sm.handleOpencodeQuestion(question) {
					c.bumpInteractionGeneration(question.SessionID, "question", question.Version)
				}
			}
		}
	case "question.replied", "question.rejected", "question.v2.replied", "question.v2.rejected":
		if requestID, sessionID, answers, ok := adapter.ParseQuestionResolution(ev.Properties); ok && c.interactionDirectoryMatches(sessionID, ev.Directory) {
			cleared := c.sm.clearOpencodeQuestion(sessionID, requestID)
			c.markInteractionResolved("question", sessionID, requestID)
			c.bumpInteractionGeneration(sessionID, "question", interactionVersionForEvent(ev.Type))
			if cleared {
				c.sm.outputCh <- protocol.DaemonEvent{Type: "question_resolved", SessionID: sessionID, RequestID: requestID, Answers: answers, Rejected: strings.Contains(ev.Type, "rejected"), Reason: "resolved_elsewhere"}
				statusSessionID = sessionID
			}
		}
	}
	c.interactionMu.Unlock()
	if statusSessionID != "" {
		c.sm.emitCurrentInteractionStatus(statusSessionID)
	}
}

type interactionGenerationScope struct {
	sessionID string
	kind      string
	version   string
}

func normalizeInteractionVersion(version string) string {
	if version == adapter.PermissionVersionV2 {
		return adapter.PermissionVersionV2
	}
	return adapter.PermissionVersionLegacy
}

func interactionVersionForEvent(eventType string) string {
	if strings.Contains(eventType, ".v2.") {
		return adapter.PermissionVersionV2
	}
	return adapter.PermissionVersionLegacy
}

func interactionScope(sessionID, kind, version string) interactionGenerationScope {
	return interactionGenerationScope{sessionID: sessionID, kind: kind, version: normalizeInteractionVersion(version)}
}

func (c *opencodeCoordinator) bumpInteractionGeneration(sessionID, kind, version string) {
	if c.interactionGeneration == nil {
		c.interactionGeneration = make(map[interactionGenerationScope]uint64)
	}
	c.interactionGeneration[interactionScope(sessionID, kind, version)]++
}

func (c *opencodeCoordinator) captureInteractionGenerations(sessionIDs []string, kind, version string) map[string]uint64 {
	c.interactionMu.Lock()
	defer c.interactionMu.Unlock()
	generations := make(map[string]uint64, len(sessionIDs))
	for _, sessionID := range sessionIDs {
		generations[sessionID] = c.interactionGeneration[interactionScope(sessionID, kind, version)]
	}
	return generations
}

func interactionRequestKey(kind, sessionID, requestID string) string {
	return kind + "\x00" + sessionID + "\x00" + requestID
}

func (c *opencodeCoordinator) interactionResolved(kind, sessionID, requestID string) bool {
	_, ok := c.resolvedInteractions[interactionRequestKey(kind, sessionID, requestID)]
	return ok
}

func (c *opencodeCoordinator) markInteractionResolved(kind, sessionID, requestID string) {
	if sessionID == "" || requestID == "" {
		return
	}
	if c.resolvedInteractions == nil {
		c.resolvedInteractions = make(map[string]struct{})
	}
	key := interactionRequestKey(kind, sessionID, requestID)
	if _, exists := c.resolvedInteractions[key]; exists {
		return
	}
	if len(c.resolvedOrder) == opencodeSeenEventLimit {
		delete(c.resolvedInteractions, c.resolvedOrder[0])
		copy(c.resolvedOrder, c.resolvedOrder[1:])
		c.resolvedOrder = c.resolvedOrder[:len(c.resolvedOrder)-1]
	}
	c.resolvedInteractions[key] = struct{}{}
	c.resolvedOrder = append(c.resolvedOrder, key)
}

func (c *opencodeCoordinator) claimInteractionEvent(eventID string) bool {
	if eventID == "" {
		return true
	}
	c.eventMu.Lock()
	defer c.eventMu.Unlock()
	if c.seenInteractionEvents == nil {
		c.seenInteractionEvents = make(map[string]struct{})
	}
	if _, duplicate := c.seenInteractionEvents[eventID]; duplicate {
		return false
	}
	if len(c.seenInteractionOrder) == opencodeSeenEventLimit {
		delete(c.seenInteractionEvents, c.seenInteractionOrder[0])
		copy(c.seenInteractionOrder, c.seenInteractionOrder[1:])
		c.seenInteractionOrder = c.seenInteractionOrder[:len(c.seenInteractionOrder)-1]
	}
	c.seenInteractionEvents[eventID] = struct{}{}
	c.seenInteractionOrder = append(c.seenInteractionOrder, eventID)
	return true
}

func (c *opencodeCoordinator) interactionDirectoryMatches(sessionID, directory string) bool {
	canonicalDirectory, valid := canonicalInteractionDirectory(directory)
	if !valid {
		return false
	}
	c.sm.mu.RLock()
	state, ok := c.sm.sessions[sessionID]
	var cwd string
	if ok {
		cwd = state.Cwd
	}
	c.sm.mu.RUnlock()
	canonicalCwd, valid := canonicalInteractionDirectory(cwd)
	return ok && valid && canonicalCwd == canonicalDirectory
}

func (sm *SessionManager) emitCurrentInteractionStatus(sessionID string) {
	sm.mu.RLock()
	ps, ok := sm.sessions[sessionID]
	status := protocol.StatusIdle
	if ok {
		status = pendingInteractionStatus(ps)
	}
	sm.mu.RUnlock()
	if ok {
		// Once the last interaction is cleared, ask OpenCode for the real
		// runtime state instead of briefly reporting a locally inferred idle.
		// OpenCode may already have resumed work or entered retry at this point.
		if status == protocol.StatusIdle {
			if backend := sm.opencodeBackendFor(sessionID); backend != nil && backend.coord != nil && backend.coord.srv() != nil {
				sm.reconcileOpencodeInteractionStatus(sessionID, backend)
				return
			}
		}
		sm.emitInteractionStatus(sessionID, status)
	}
}

// reconcileInteractions recovers asked events missed while SSE was disconnected.
// It intentionally treats list failures as non-authoritative and never clears
// local state merely because one endpoint was unavailable.
func (c *opencodeCoordinator) reconcileInteractions(ctx context.Context) {
	if srv := c.srv(); srv != nil {
		c.trackMu.Lock()
		sessionIDs := make([]string, 0, len(c.tracked))
		for sessionID := range c.tracked {
			sessionIDs = append(sessionIDs, sessionID)
		}
		c.trackMu.Unlock()
		sessionsByDirectory := make(map[string][]string)
		c.sm.mu.RLock()
		for _, sessionID := range sessionIDs {
			if state, ok := c.sm.sessions[sessionID]; ok {
				if directory, valid := canonicalInteractionDirectory(state.Cwd); valid {
					sessionsByDirectory[directory] = append(sessionsByDirectory[directory], sessionID)
				}
			}
		}
		c.sm.mu.RUnlock()
		for directory, cwdSessionIDs := range sessionsByDirectory {
			permissionGenerations := c.captureInteractionGenerations(cwdSessionIDs, "permission", adapter.PermissionVersionLegacy)
			if permissions, err := srv.ListPermissions(ctx, directory); err == nil {
				for _, sessionID := range cwdSessionIDs {
					c.applyPermissionSnapshot(sessionID, adapter.PermissionVersionLegacy, permissionGenerations[sessionID], permissions)
				}
			}
			questionGenerations := c.captureInteractionGenerations(cwdSessionIDs, "question", adapter.PermissionVersionLegacy)
			if questions, err := srv.ListQuestions(ctx, directory); err == nil {
				for _, sessionID := range cwdSessionIDs {
					c.applyQuestionSnapshot(sessionID, adapter.PermissionVersionLegacy, questionGenerations[sessionID], questions)
				}
			}
		}
		for _, sessionID := range sessionIDs {
			permissionGeneration := c.captureInteractionGenerations([]string{sessionID}, "permission", adapter.PermissionVersionV2)[sessionID]
			if permissions, err := srv.ListPermissionsV2(ctx, sessionID); err == nil {
				c.applyPermissionSnapshot(sessionID, adapter.PermissionVersionV2, permissionGeneration, permissions)
			}
			questionGeneration := c.captureInteractionGenerations([]string{sessionID}, "question", adapter.PermissionVersionV2)[sessionID]
			if questions, err := srv.ListQuestionsV2(ctx, sessionID); err == nil {
				c.applyQuestionSnapshot(sessionID, adapter.PermissionVersionV2, questionGeneration, questions)
			}
		}
	}
}

// reconcileSessionInteractions closes the daemon-restart race where the first
// global SSE reconciliation runs before discovery has populated c.tracked.
// Each newly tracked session gets authoritative legacy and v2 snapshots,
// filtered to that session after querying the global legacy routes.
func (c *opencodeCoordinator) reconcileSessionInteractions(ctx context.Context, sessionID string) {
	srv := c.srv()
	if srv == nil {
		return
	}
	requestCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	directory, _ := c.sm.GetSessionCwd(sessionID)
	directory, valid := canonicalInteractionDirectory(directory)
	if valid {
		permissionGeneration := c.captureInteractionGenerations([]string{sessionID}, "permission", adapter.PermissionVersionLegacy)[sessionID]
		if permissions, err := srv.ListPermissions(requestCtx, directory); err == nil {
			c.applyPermissionSnapshot(sessionID, adapter.PermissionVersionLegacy, permissionGeneration, permissions)
		}
		questionGeneration := c.captureInteractionGenerations([]string{sessionID}, "question", adapter.PermissionVersionLegacy)[sessionID]
		if questions, err := srv.ListQuestions(requestCtx, directory); err == nil {
			c.applyQuestionSnapshot(sessionID, adapter.PermissionVersionLegacy, questionGeneration, questions)
		}
	}
	permissionGeneration := c.captureInteractionGenerations([]string{sessionID}, "permission", adapter.PermissionVersionV2)[sessionID]
	if permissions, err := srv.ListPermissionsV2(requestCtx, sessionID); err == nil {
		c.applyPermissionSnapshot(sessionID, adapter.PermissionVersionV2, permissionGeneration, permissions)
	}
	questionGeneration := c.captureInteractionGenerations([]string{sessionID}, "question", adapter.PermissionVersionV2)[sessionID]
	if questions, err := srv.ListQuestionsV2(requestCtx, sessionID); err == nil {
		c.applyQuestionSnapshot(sessionID, adapter.PermissionVersionV2, questionGeneration, questions)
	}
}

func (c *opencodeCoordinator) applyPermissionSnapshot(sessionID, version string, generation uint64, observed []adapter.PermissionAsked) bool {
	c.interactionMu.Lock()
	if c.interactionGeneration[interactionScope(sessionID, "permission", version)] != generation {
		c.interactionMu.Unlock()
		return false
	}
	statusSessions := c.reconcilePermissionSnapshot(sessionID, version, c.permissionsForSession(observed, sessionID))
	c.bumpInteractionGeneration(sessionID, "permission", version)
	c.interactionMu.Unlock()
	for _, statusSessionID := range statusSessions {
		c.sm.emitCurrentInteractionStatus(statusSessionID)
	}
	return true
}

func (c *opencodeCoordinator) applyQuestionSnapshot(sessionID, version string, generation uint64, observed []adapter.QuestionAsked) bool {
	c.interactionMu.Lock()
	if c.interactionGeneration[interactionScope(sessionID, "question", version)] != generation {
		c.interactionMu.Unlock()
		return false
	}
	statusSessions := c.reconcileQuestionSnapshot(sessionID, version, c.questionsForSession(observed, sessionID))
	c.bumpInteractionGeneration(sessionID, "question", version)
	c.interactionMu.Unlock()
	for _, statusSessionID := range statusSessions {
		c.sm.emitCurrentInteractionStatus(statusSessionID)
	}
	return true
}

func (c *opencodeCoordinator) reconcilePermissionSnapshot(sessionID, version string, observed []adapter.PermissionAsked) []string {
	before := make([]string, 0)
	c.sm.mu.RLock()
	if state, ok := c.sm.sessions[sessionID]; ok {
		for requestID, pending := range state.PendingPermissions {
			if pending.ProtocolVersion == version {
				before = append(before, requestID)
			}
		}
	}
	c.sm.mu.RUnlock()
	statusSessions := c.sm.reconcileOpencodePermissionSnapshot(sessionID, version, observed)
	c.sm.mu.RLock()
	state := c.sm.sessions[sessionID]
	for _, requestID := range before {
		if state == nil {
			c.markInteractionResolved("permission", sessionID, requestID)
			continue
		}
		if _, pending := state.PendingPermissions[requestID]; !pending {
			c.markInteractionResolved("permission", sessionID, requestID)
		}
	}
	c.sm.mu.RUnlock()
	return statusSessions
}

func (c *opencodeCoordinator) reconcileQuestionSnapshot(sessionID, version string, observed []adapter.QuestionAsked) []string {
	before := make([]string, 0)
	c.sm.mu.RLock()
	if state, ok := c.sm.sessions[sessionID]; ok {
		for requestID, pending := range state.PendingQuestions {
			if pending.ProtocolVersion == version {
				before = append(before, requestID)
			}
		}
	}
	c.sm.mu.RUnlock()
	statusSessions := c.sm.reconcileOpencodeQuestionSnapshot(sessionID, version, observed)
	c.sm.mu.RLock()
	state := c.sm.sessions[sessionID]
	for _, requestID := range before {
		if state == nil {
			c.markInteractionResolved("question", sessionID, requestID)
			continue
		}
		if _, pending := state.PendingQuestions[requestID]; !pending {
			c.markInteractionResolved("question", sessionID, requestID)
		}
	}
	c.sm.mu.RUnlock()
	return statusSessions
}

func (c *opencodeCoordinator) permissionsForSession(permissions []adapter.PermissionAsked, sessionID string) []adapter.PermissionAsked {
	filtered := make([]adapter.PermissionAsked, 0, len(permissions))
	for _, permission := range permissions {
		if permission.SessionID == sessionID && !c.interactionResolved("permission", sessionID, permission.ID) {
			filtered = append(filtered, permission)
		}
	}
	return filtered
}

func (c *opencodeCoordinator) questionsForSession(questions []adapter.QuestionAsked, sessionID string) []adapter.QuestionAsked {
	filtered := make([]adapter.QuestionAsked, 0, len(questions))
	for _, question := range questions {
		if question.SessionID == sessionID && !c.interactionResolved("question", sessionID, question.ID) {
			filtered = append(filtered, question)
		}
	}
	return filtered
}

func canonicalInteractionDirectory(directory string) (string, bool) {
	if strings.TrimSpace(directory) == "" || strings.ContainsRune(directory, '\x00') {
		return "", false
	}
	return normalizeCwd(directory), true
}

// discoveryLoop polls the shared serve for sessions and registers any
// terminal-started ones that are fresh (recently active) and not already
// tracked (owned sessions are tracked at create time).
func (c *opencodeCoordinator) discoveryLoop(ctx context.Context) {
	ticker := time.NewTicker(opencodeDiscoverInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			c.discoverOnce(ctx)
		}
	}
}

func (c *opencodeCoordinator) discoverOnce(ctx context.Context) {
	s := c.srv()
	if s == nil {
		return // serve down (e.g. mid-restart); next tick retries
	}
	sessions, err := s.ListSessions(ctx)
	if err != nil {
		slog.Default().Warn("opencode ListSessions failed", "error", err)
		return
	}
	nowMs := time.Now().UnixMilli()
	freshMs := opencodeFreshWindow.Milliseconds()
	c.summaryOnce.Do(func() {
		slog.Default().Info("opencode discovery first poll", "total_sessions", len(sessions))
	})
	reconcileMs := opencodeReconcileWindow.Milliseconds()
	fresh := 0
	for _, s := range sessions {
		age := nowMs - s.Time.Updated
		if age > freshMs {
			// Not actively syncing. A session that fell out of the live window
			// while marked "running" (e.g. an abandoned turn) would stay stuck at
			// "running" in the relay DB forever, making the web show a turn timer.
			// Reconcile it once: stale ⇒ not actively running ⇒ idle. Bounded to a
			// recent window so we don't spam status for ancient history.
			if age <= reconcileMs && !c.reconciled[s.ID] && !c.isTracked(s.ID) {
				c.reconciled[s.ID] = true
				c.sm.outputCh <- protocol.DaemonEvent{
					Type:      "session_status",
					SessionID: s.ID,
					Status:    protocol.StatusIdle,
				}
			}
			continue
		}
		fresh++
		if s.ParentID != "" {
			c.promoteDiscoveredFork(s.ID, s.ParentID, s.Directory())
		}
		if c.isTracked(s.ID) {
			continue // owned, or already-discovered terminal session
		}
		// New, fresh, untracked → a terminal-started session.
		if !c.sm.RegisterOpencodeTerminalSession(s.ID, s.Directory()) {
			continue
		}
		slog.Default().Info("opencode terminal session discovered", "session", s.ID, "cwd", s.Directory())
		title := s.Title
		if title == "" || strings.HasPrefix(title, "New session") {
			// opencode hasn't generated a real title yet — use a placeholder;
			// the sync loop pushes the real title once opencode creates it.
			short := s.ID
			if len(short) > 8 {
				short = short[len(short)-8:]
			}
			title = "opencode Session-" + short
		}
		c.sm.UpdateSessionTitle(s.ID, title)
		model := ""
		if info, err := c.srv().GetSession(ctx, s.ID); err == nil && info.Model.ProviderID != "" && info.Model.ID != "" {
			model = info.Model.ProviderID + "/" + info.Model.ID
			c.sm.SetSessionModel(s.ID, model)
		}
		c.sm.outputCh <- protocol.DaemonEvent{
			Type:         "session_discovered",
			SessionID:    s.ID,
			Cwd:          s.Directory(),
			Status:       protocol.StatusIdle,
			Source:       "terminal",
			Agent:        adapter.AgentOpencode,
			Model:        model,
			ControlMode:  c.sm.SessionControlMode(s.ID),
			Capabilities: c.sm.OpenCodeInteractionCapabilities(s.ID),
		}
		// emitUser=true: terminal sessions have no other source of user_text.
		c.startSync(s.ID, true)
	}
}

func (c *opencodeCoordinator) markManagedSession(sessionID, cwd string) {
	generation := c.currentGeneration()
	c.managedMu.Lock()
	c.managedSessions[sessionID] = managedOpenCodeSession{CWD: normalizeCwd(cwd), Generation: generation}
	c.managedMu.Unlock()
	c.sm.mu.Lock()
	if state := c.sm.sessions[sessionID]; state != nil && state.Agent == adapter.AgentOpencode {
		state.ControlMode = protocol.ControlManaged
	}
	c.sm.mu.Unlock()
	c.persistControlRegistry()
}

func (c *opencodeCoordinator) deferManagedFork(parentID, cwd string) {
	generation := c.currentGeneration()
	c.managedMu.Lock()
	c.pendingForks[parentID] = append(c.pendingForks[parentID], managedOpenCodeSession{CWD: normalizeCwd(cwd), Generation: generation})
	c.managedMu.Unlock()
	c.persistControlRegistry()
}

func (c *opencodeCoordinator) promoteDiscoveredFork(childID, parentID, cwd string) {
	c.managedMu.Lock()
	pending := c.pendingForks[parentID]
	for i, candidate := range pending {
		if normalizeCwd(cwd) != candidate.CWD {
			continue
		}
		pending = append(pending[:i], pending[i+1:]...)
		if len(pending) == 0 {
			delete(c.pendingForks, parentID)
		} else {
			c.pendingForks[parentID] = pending
		}
		c.managedSessions[childID] = candidate
		break
	}
	c.managedMu.Unlock()
	c.persistControlRegistry()
}

func (c *opencodeCoordinator) isManagedSession(sessionID string) bool {
	c.managedMu.RLock()
	_, ok := c.managedSessions[sessionID]
	c.managedMu.RUnlock()
	return ok
}

func (c *opencodeCoordinator) currentGeneration() uint64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.generation
}

func (c *opencodeCoordinator) setManagedGeneration(generation uint64) {
	c.managedMu.Lock()
	for sessionID, session := range c.managedSessions {
		session.Generation = generation
		c.managedSessions[sessionID] = session
	}
	for parentID, pending := range c.pendingForks {
		for i := range pending {
			pending[i].Generation = generation
		}
		c.pendingForks[parentID] = pending
	}
	c.managedMu.Unlock()
}

func (c *opencodeCoordinator) controlRegistrySnapshot() (map[string]daemon.OpenCodeManagedSessionState, map[string][]daemon.OpenCodeManagedSessionState) {
	c.managedMu.RLock()
	defer c.managedMu.RUnlock()
	managed := make(map[string]daemon.OpenCodeManagedSessionState, len(c.managedSessions))
	for sessionID, session := range c.managedSessions {
		managed[sessionID] = daemon.OpenCodeManagedSessionState{CWD: session.CWD, Generation: session.Generation, ControlMode: protocol.ControlManaged}
	}
	pending := make(map[string][]daemon.OpenCodeManagedSessionState, len(c.pendingForks))
	for parentID, sessions := range c.pendingForks {
		items := make([]daemon.OpenCodeManagedSessionState, 0, len(sessions))
		for _, session := range sessions {
			items = append(items, daemon.OpenCodeManagedSessionState{CWD: session.CWD, Generation: session.Generation, ControlMode: protocol.ControlManaged})
		}
		pending[parentID] = items
	}
	return managed, pending
}

func (c *opencodeCoordinator) restoreControlRegistry(state *daemon.OpenCodeServeState) {
	if state == nil {
		return
	}
	c.managedMu.Lock()
	for sessionID, session := range state.ManagedSessions {
		if session.ControlMode == protocol.ControlManaged && strings.TrimSpace(session.CWD) != "" {
			c.managedSessions[sessionID] = managedOpenCodeSession{CWD: normalizeCwd(session.CWD), Generation: session.Generation}
		}
	}
	for parentID, sessions := range state.PendingForks {
		for _, session := range sessions {
			if session.ControlMode == protocol.ControlManaged && strings.TrimSpace(session.CWD) != "" {
				c.pendingForks[parentID] = append(c.pendingForks[parentID], managedOpenCodeSession{CWD: normalizeCwd(session.CWD), Generation: session.Generation})
			}
		}
	}
	c.managedMu.Unlock()
}

func (c *opencodeCoordinator) persistControlRegistry() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.handoffPersisted || c.server == nil {
		return
	}
	if err := daemon.ClaimOpenCodeServeState(os.Getpid(), c.openCodeHandoffState(c.server, c.generation)); err != nil {
		slog.Default().Warn("persist opencode control registry failed", "error", err)
	}
}

func (c *opencodeCoordinator) initializeControlBaseline(ctx context.Context) error {
	server := c.srv()
	if server == nil {
		return fmt.Errorf("opencode serve is not ready")
	}
	sessions, err := server.ListSessions(ctx)
	if err != nil {
		return err
	}
	processes, err := c.processInspector.List()
	if err != nil {
		return err
	}
	processes = excludeProcessPIDs(processes, server.PID())
	c.baselineMu.Lock()
	for _, session := range sessions {
		mode := protocol.ControlLegacyReadOnly
		if watcher.HasUnmanagedOpenCodeProcessInCWD(processes, session.Directory(), server.BaseURL()) {
			mode = protocol.ControlUnmanagedActive
		}
		if c.isManagedSession(session.ID) {
			mode = protocol.ControlManaged
		}
		c.baselineModes[session.ID] = mode
	}
	c.baselineMu.Unlock()
	return nil
}

func (c *opencodeCoordinator) controlModeForSession(sessionID, cwd string) string {
	if c.isManagedSession(sessionID) {
		return protocol.ControlManaged
	}
	c.baselineMu.RLock()
	mode := c.baselineModes[sessionID]
	c.baselineMu.RUnlock()
	if mode != "" {
		return mode
	}
	server := c.srv()
	baseURL := ""
	if server != nil {
		baseURL = server.BaseURL()
	}
	serverPID := 0
	if server != nil {
		serverPID = server.PID()
	}
	if hasUnmanagedOpenCodeProcess(c.processInspector, cwd, baseURL, serverPID) {
		return protocol.ControlUnmanagedActive
	}
	return protocol.ControlLegacyReadOnly
}

func hasUnmanagedOpenCodeProcess(inspector platform.ProcessInspector, cwd, sharedBaseURL string, excludedPIDs ...int) bool {
	if inspector == nil {
		return true
	}
	processes, err := inspector.List()
	if err != nil {
		return true
	}
	return watcher.HasUnmanagedOpenCodeProcessInCWD(excludeProcessPIDs(processes, excludedPIDs...), cwd, sharedBaseURL)
}

func excludeProcessPIDs(processes []platform.ProcessSnapshot, excludedPIDs ...int) []platform.ProcessSnapshot {
	excluded := make(map[int]struct{}, len(excludedPIDs))
	for _, pid := range excludedPIDs {
		if pid > 0 {
			excluded[pid] = struct{}{}
		}
	}
	out := make([]platform.ProcessSnapshot, 0, len(processes))
	for _, process := range processes {
		if _, skip := excluded[process.PID]; !skip {
			out = append(out, process)
		}
	}
	return out
}

// startSync launches a per-session message poll loop (once). emitUser controls
// whether user_text parts are forwarded (terminal: yes; owned: no, the user
// message is echoed on Send).
func (c *opencodeCoordinator) startSync(sessionID string, emitUser bool) {
	c.trackMu.Lock()
	if _, ok := c.tracked[sessionID]; ok {
		c.trackMu.Unlock()
		return
	}
	base := c.ctx
	if base == nil {
		base = context.Background()
	}
	sctx, scancel := context.WithCancel(base)
	c.tracked[sessionID] = scancel
	c.trackMu.Unlock()
	if c.recoverSession != nil {
		go c.recoverSession(sctx, sessionID)
	}
	go c.syncLoop(sctx, sessionID, emitUser)
}

func (c *opencodeCoordinator) syncLoop(ctx context.Context, sessionID string, emitUser bool) {
	sync := adapter.NewOpencodeSync(sessionID, emitUser)
	ticker := time.NewTicker(opencodeSyncInterval)
	defer ticker.Stop()
	lastTitle := ""
	lastTodos := ""
	lastTodoEventID := ""
	tick := 0
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			tick++
			s := c.srv()
			if s == nil {
				continue // serve down (e.g. mid-restart); next tick retries
			}
			cwd, _ := c.sm.GetSessionCwd(sessionID)
			var nativeStatus *adapter.OpencodeSessionStatus
			if statuses, err := s.ListSessionStatuses(ctx, cwd); err == nil {
				if status, ok := statuses[sessionID]; ok {
					nativeStatus = &status
				}
			}
			msgs, err := s.GetMessages(ctx, sessionID)
			if err == nil {
				if evs := sync.DiffWithNativeStatus(msgs, nativeStatus); len(evs) > 0 {
					for _, ev := range evs {
						if ev.Type == "session_status" {
							ev.Status = c.sm.applyOpencodeRuntimeStatus(sessionID, ev.Status)
						}
						c.sm.outputCh <- ev
					}
					c.sm.UpdateLastActivity(sessionID)
				}
			}
			if todos, err := s.ListTodos(ctx, sessionID, cwd); err == nil {
				encoded, _ := json.Marshal(todos)
				key := string(encoded)
				if key != lastTodos {
					eventID := adapter.OpencodeTodoEventID(sessionID, todos)
					c.sm.outputCh <- protocol.DaemonEvent{
						Type: "agent_todo", SessionID: sessionID, PartID: "todo:" + sessionID,
						EventID: eventID, PreviousEventID: lastTodoEventID,
						Todos: append([]protocol.TodoItem(nil), todos...),
					}
					lastTodoEventID = eventID
					c.sm.UpdateLastActivity(sessionID)
				}
				lastTodos = key
			}
			// Refresh the title periodically: opencode auto-generates a real title
			// after the first exchange (replacing "New session - <ts>"). Pick it up
			// and push a session_title_update.
			if tick%3 == 0 {
				if info, err := s.GetSession(ctx, sessionID); err == nil {
					t := strings.TrimSpace(info.Title)
					if t != "" && !strings.HasPrefix(t, "New session") && t != lastTitle {
						lastTitle = t
						c.sm.UpdateSessionTitle(sessionID, t)
					}
				}
			}
		}
	}
}

func (c *opencodeCoordinator) isTracked(sessionID string) bool {
	c.trackMu.Lock()
	defer c.trackMu.Unlock()
	_, ok := c.tracked[sessionID]
	return ok
}

func (c *opencodeCoordinator) untrack(sessionID string) {
	c.trackMu.Lock()
	if cancel, ok := c.tracked[sessionID]; ok {
		cancel()
		delete(c.tracked, sessionID)
	}
	c.trackMu.Unlock()
}

// ---- serverBackend: SessionBackend implementation for opencode ----

type serverBackend struct {
	coord *opencodeCoordinator
}

func parseOpenCodeSlashCommand(content string) (name, arguments string, ok bool) {
	trimmed := strings.TrimSpace(content)
	if len(trimmed) < 2 || trimmed[0] != '/' || trimmed[1] == '/' || trimmed[1] == ' ' || trimmed[1] == '\t' || trimmed[1] == '\n' {
		return "", "", false
	}
	rest := trimmed[1:]
	if split := strings.IndexAny(rest, " \t\r\n"); split >= 0 {
		name = rest[:split]
		arguments = strings.TrimSpace(rest[split:])
	} else {
		name = rest
	}
	return name, arguments, name != ""
}

func mapOpenCodeCommands(commands []adapter.OpencodeCommand) []protocol.CommandItem {
	out := make([]protocol.CommandItem, 0, len(commands))
	for _, command := range commands {
		if strings.TrimSpace(command.Name) == "" {
			continue
		}
		kind := "command"
		if command.Source == "skill" {
			kind = "skill"
		}
		out = append(out, protocol.CommandItem{
			Name: command.Name, Source: command.Source, Kind: kind, Description: command.Description,
			ArgHint: strings.Join(command.Hints, " "), Template: command.Template, Hints: command.Hints,
			Subtask: command.Subtask, Agent: command.Agent, Model: command.Model,
		})
	}
	return out
}

func filterOpenCodeAgents(agents []adapter.OpencodeAgent) []protocol.SessionAgentOption {
	out := make([]protocol.SessionAgentOption, 0, len(agents))
	for _, agent := range agents {
		if agent.Hidden || (agent.Mode != "primary" && agent.Mode != "all") || strings.TrimSpace(agent.Name) == "" {
			continue
		}
		out = append(out, protocol.SessionAgentOption{
			Name: agent.Name, Description: agent.Description, Mode: agent.Mode,
			Color: agent.Color, Model: agent.Model, Variant: agent.Variant,
		})
	}
	return out
}

func validateOpenCodeAgentSwitchState(ps *ProcessState) error {
	if ps == nil {
		return fmt.Errorf("session not found")
	}
	if len(ps.PendingPermissions) > 0 || len(ps.PendingQuestions) > 0 {
		return fmt.Errorf("cannot switch agent while an interaction is pending")
	}
	switch ps.Status {
	case protocol.StatusRunning, protocol.StatusBusy, protocol.StatusRetry, protocol.StatusWaitingApproval, protocol.StatusWaitingQuestion:
		return fmt.Errorf("cannot switch agent while session is %s", ps.Status)
	default:
		return nil
	}
}

func (b *serverBackend) Start(ctx context.Context, config protocol.SessionConfig) (string, error) {
	if err := b.coord.ensureStarted(); err != nil {
		return "", err
	}
	sid, err := b.coord.srv().CreateSession(ctx, parseOpencodeModel(config.Model), config.Cwd)
	if err != nil {
		return "", err
	}
	return sid, nil
}

func (b *serverBackend) Send(ctx context.Context, sessionID, content string) error {
	if err := b.coord.ensureStarted(); err != nil {
		return err
	}
	// 6.4 busy-collision: refuse to start a new turn while one is still generating
	// (mirrors claude's "session busy" guard). Checked against the session's live
	// message state via the serve.
	if s := b.coord.srv(); s != nil {
		bctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		msgs, err := s.GetMessages(bctx, sessionID)
		cancel()
		if err == nil && adapter.OpencodeMessagesRunning(msgs) {
			return fmt.Errorf("会话正在生成回复，请等当前回合结束后再发送")
		}
	}
	if name, arguments, isSlash := parseOpenCodeSlashCommand(content); isSlash {
		cwd, _ := b.coord.sm.GetSessionCwd(sessionID)
		commands, err := b.coord.srv().ListCommands(ctx, cwd)
		if err != nil {
			b.coord.sm.outputCh <- protocol.DaemonEvent{
				Type: "command_receipt", SessionID: sessionID, Command: "/" + name,
				ReceiptStatus: "failed", Message: "无法加载 OpenCode 命令列表: " + err.Error(),
			}
			return nil
		}
		known := false
		for _, command := range commands {
			if command.Name == name {
				known = true
				break
			}
		}
		if known {
			go func() {
				status, message := "success", ""
				if err := b.coord.srv().ExecuteCommand(context.Background(), sessionID, cwd, name, arguments); err != nil {
					status, message = "failed", err.Error()
				}
				b.coord.sm.outputCh <- protocol.DaemonEvent{
					Type: "command_receipt", SessionID: sessionID, Command: "/" + name,
					ReceiptStatus: status, Message: message,
				}
			}()
			return nil
		}
	}
	// opencode POST /prompt blocks until the turn completes; run it in the
	// background so Send returns promptly (mirrors claude/codex). The message
	// poller surfaces the streaming response; errors are forwarded to the client.
	model, _ := b.coord.sm.GetSessionModel(sessionID) // "providerID/modelID"; Prompt falls back to the session's own model when empty
	go func() {
		slog.Default().Info("opencode prompt POST", "session", sessionID, "model", model, "len", len(content))
		if err := b.coord.srv().Prompt(context.Background(), sessionID, model, content); err != nil {
			slog.Default().Error("opencode prompt POST failed", "session", sessionID, "error", err)
			b.coord.sm.outputCh <- protocol.DaemonEvent{
				Type:      "error",
				SessionID: sessionID,
				Error:     "opencode prompt 失败: " + err.Error(),
			}
		} else {
			slog.Default().Info("opencode prompt POST ok", "session", sessionID)
		}
	}()
	return nil
}

func (b *serverBackend) Interrupt(sessionID string) error {
	if err := b.coord.ensureStarted(); err != nil {
		return err
	}
	return b.coord.srv().Abort(context.Background(), sessionID)
}

func (b *serverBackend) Close(sessionID string) error {
	b.coord.untrack(sessionID)
	return nil
}

// parseOpencodeModel parses a "providerID/modelID" string into an
// OpencodeModelRef. Returns nil when empty or malformed (opencode picks its
// default).
func parseOpencodeModel(model string) *adapter.OpencodeModelRef {
	model = strings.TrimSpace(model)
	if model == "" {
		return nil
	}
	parts := strings.SplitN(model, "/", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return nil
	}
	return &adapter.OpencodeModelRef{ProviderID: parts[0], ID: parts[1]}
}

// ---- manager integration ----

// opencodeBackendFor returns the serverBackend for a session, or nil if the
// session isn't an opencode (server-kind) session. Used to route approval /
// question replies to the serve API instead of the claude hook/PTY paths.
func (sm *SessionManager) opencodeBackendFor(sessionID string) *serverBackend {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	if ps, ok := sm.sessions[sessionID]; ok {
		if b, ok := ps.Backend.(*serverBackend); ok {
			return b
		}
	}
	return nil
}

// ensureOpencode returns the lazily-created opencode coordinator.
func (sm *SessionManager) ensureOpencode() *opencodeCoordinator {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	if sm.opencode == nil {
		sm.opencode = newOpencodeCoordinator(sm)
	}
	return sm.opencode
}

// StartOpencodeDiscovery boots the shared opencode serve and begins discovering
// terminal-started sessions. Called once during daemon startup (after the relay
// connection is established). No-op error if opencode isn't installed.
func (sm *SessionManager) StartOpencodeDiscovery() error {
	if _, ok := adapter.Get(adapter.AgentOpencode); !ok {
		return nil
	}
	if _, _, err := resolveOpenCodeCLI(); err != nil {
		return nil // opencode not installed — nothing to discover
	}
	return sm.ensureOpencode().startDiscovery()
}

// OpencodeSessionModelFromServe fetches a session's current model from the serve
// ("providerID/modelID") and caches it on the ProcessState. Used to resolve the
// model for terminal opencode sessions (which carry no model at discovery and
// have no claude-style JSONL to extract it from). Returns "" if unavailable.
func (sm *SessionManager) OpencodeSessionModelFromServe(sessionID string) string {
	c := sm.ensureOpencode()
	if err := c.ensureStarted(); err != nil {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	info, err := c.srv().GetSession(ctx, sessionID)
	if err != nil || info.Model.ProviderID == "" || info.Model.ID == "" {
		return ""
	}
	model := info.Model.ProviderID + "/" + info.Model.ID
	sm.SetSessionModel(sessionID, model)
	return model
}

// loadOpencodeSessionFromServe fetches and registers one session that discovery
// has not observed yet. The second result is true only for an authoritative 404.
func (sm *SessionManager) loadOpencodeSessionFromServe(sessionID string) (loaded, notFound bool) {
	coord := sm.ensureOpencode()
	coord.loadMu.Lock()
	if call := coord.loads[sessionID]; call != nil {
		coord.loadMu.Unlock()
		<-call.done
		return call.loaded, call.notFound
	}
	call := &opencodeLoadCall{done: make(chan struct{})}
	coord.loads[sessionID] = call
	coord.loadMu.Unlock()
	defer func() {
		coord.loadMu.Lock()
		call.loaded, call.notFound = loaded, notFound
		delete(coord.loads, sessionID)
		close(call.done)
		coord.loadMu.Unlock()
	}()

	sm.mu.RLock()
	_, exists := sm.sessions[sessionID]
	sm.mu.RUnlock()
	if exists {
		return true, false
	}
	if err := coord.ensureStarted(); err != nil {
		return false, false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	info, err := coord.srv().GetSession(ctx, sessionID)
	if err != nil {
		var statusErr *adapter.OpencodeHTTPStatusError
		return false, errors.As(err, &statusErr) && statusErr.StatusCode == 404
	}
	if info.ID != sessionID || strings.TrimSpace(info.Directory) == "" || !filepath.IsAbs(info.Directory) ||
		strings.TrimSpace(info.Agent) == "" || strings.TrimSpace(info.Model.ProviderID) == "" || strings.TrimSpace(info.Model.ID) == "" {
		return false, false
	}

	model := info.Model.ProviderID + "/" + info.Model.ID
	cwdKey := normalizeCwd(info.Directory)
	controlMode := coord.controlModeForSession(sessionID, info.Directory)
	now := time.Now()
	sm.mu.Lock()
	if state := sm.sessions[sessionID]; state != nil {
		startSync := false
		if state.Agent == adapter.AgentOpencode {
			state.Cwd, state.Model, state.CurrentAgent = info.Directory, model, info.Agent
			if _, ok := state.Backend.(*serverBackend); !ok {
				state.Backend = &serverBackend{coord: coord}
			}
			registerCwdKeyLocked(sm, sessionID, cwdKey)
			startSync = true
		}
		sm.mu.Unlock()
		if startSync {
			coord.startSync(sessionID, true)
		}
		return true, false
	}
	sm.sessions[sessionID] = &ProcessState{
		SessionID:      sessionID,
		Status:         protocol.StatusIdle,
		StartedAt:      now,
		LastActivityAt: now,
		Cwd:            info.Directory,
		Agent:          adapter.AgentOpencode,
		Source:         "terminal",
		Model:          model,
		CurrentAgent:   info.Agent,
		Backend:        &serverBackend{coord: coord},
		ControlMode:    controlMode,
	}
	registerCwdKeyLocked(sm, sessionID, cwdKey)
	sm.mu.Unlock()
	coord.startSync(sessionID, true)
	return true, false
}

// registerCwdKeyLocked records an already-normalized cwd while the caller holds sm.mu.
func registerCwdKeyLocked(sm *SessionManager, sessionID, cwdKey string) {
	set := sm.cwdSessions[cwdKey]
	if set == nil {
		set = make(map[string]struct{})
		sm.cwdSessions[cwdKey] = set
	}
	set[sessionID] = struct{}{}
}

var opencodeInteractionCapabilities = []string{
	"dynamic_commands", "agent_switch", "permission_actions", "questions", "shared_runtime", "terminal_coapproval",
}

func (sm *SessionManager) OpenCodeInteractionCapabilities(sessionID string) []string {
	sm.mu.RLock()
	state := sm.sessions[sessionID]
	capabilities := sm.openCodeCapabilitiesLocked(state)
	sm.mu.RUnlock()
	return capabilities
}

func (sm *SessionManager) openCodeCapabilitiesLocked(state *ProcessState) []string {
	if state == nil || state.Agent != adapter.AgentOpencode || state.ControlMode != protocol.ControlManaged {
		return nil
	}
	return append([]string(nil), opencodeInteractionCapabilities...)
}

func (sm *SessionManager) CommandsForSession(ctx context.Context, sessionID string) ([]protocol.CommandItem, error) {
	b := sm.opencodeBackendFor(sessionID)
	if b == nil || b.coord == nil {
		return nil, fmt.Errorf("not an opencode session")
	}
	if err := b.coord.ensureStarted(); err != nil {
		return nil, err
	}
	cwd, ok := sm.GetSessionCwd(sessionID)
	if !ok {
		return nil, fmt.Errorf("session not found")
	}
	commands, err := b.coord.srv().ListCommands(ctx, cwd)
	if err != nil {
		return nil, err
	}
	return mapOpenCodeCommands(commands), nil
}

func (sm *SessionManager) ListSessionAgents(ctx context.Context, sessionID string) ([]protocol.SessionAgentOption, error) {
	b := sm.opencodeBackendFor(sessionID)
	if b == nil || b.coord == nil {
		return nil, fmt.Errorf("not an opencode session")
	}
	if err := b.coord.ensureStarted(); err != nil {
		return nil, err
	}
	cwd, ok := sm.GetSessionCwd(sessionID)
	if !ok {
		return nil, fmt.Errorf("session not found")
	}
	agents, err := b.coord.srv().ListAgents(ctx, cwd)
	if err != nil {
		return nil, err
	}
	return filterOpenCodeAgents(agents), nil
}

func (sm *SessionManager) CurrentSessionAgent(ctx context.Context, sessionID string) string {
	sm.mu.RLock()
	ps, ok := sm.sessions[sessionID]
	if ok && ps.CurrentAgent != "" {
		current := ps.CurrentAgent
		sm.mu.RUnlock()
		return current
	}
	sm.mu.RUnlock()
	b := sm.opencodeBackendFor(sessionID)
	if !ok || b == nil || b.coord == nil || b.coord.srv() == nil {
		return ""
	}
	info, err := b.coord.srv().GetSession(ctx, sessionID)
	if err != nil || info.Agent == "" {
		return ""
	}
	sm.mu.Lock()
	if state := sm.sessions[sessionID]; state != nil {
		state.CurrentAgent = info.Agent
	}
	sm.mu.Unlock()
	return info.Agent
}

func (sm *SessionManager) SetSessionAgent(ctx context.Context, sessionID, agentName string) error {
	b := sm.opencodeBackendFor(sessionID)
	if b == nil || b.coord == nil {
		return fmt.Errorf("not an opencode session")
	}
	sm.mu.RLock()
	ps := sm.sessions[sessionID]
	if err := validateOpenCodeAgentSwitchState(ps); err != nil {
		sm.mu.RUnlock()
		return err
	}
	sm.mu.RUnlock()
	agents, err := sm.ListSessionAgents(ctx, sessionID)
	if err != nil {
		return err
	}
	found := false
	for _, agent := range agents {
		if agent.Name == agentName {
			found = true
			break
		}
	}
	if !found {
		return fmt.Errorf("unknown or non-interactive opencode agent %q", agentName)
	}
	if err := b.coord.srv().SwitchAgent(ctx, sessionID, agentName); err != nil {
		return err
	}
	sm.mu.Lock()
	if state := sm.sessions[sessionID]; state != nil {
		state.CurrentAgent = agentName
	}
	sm.mu.Unlock()
	sm.outputCh <- protocol.DaemonEvent{Type: "session_agent_changed", SessionID: sessionID, CurrentAgent: agentName}
	return nil
}

// ModelsForAgent returns the model picker options for an agent. opencode models
// come from its serve API (requires the shared serve running); other agents use
// the stateless ListModelsForAgent.
func (sm *SessionManager) ModelsForAgent(agentType string) []protocol.ModelOption {
	if agentType != adapter.AgentOpencode {
		return ListModelsForAgent(agentType)
	}
	if _, _, err := resolveOpenCodeCLI(); err != nil {
		return nil
	}
	coord := sm.ensureOpencode()
	if err := coord.ensureStarted(); err != nil {
		slog.Default().Warn("opencode ModelsForAgent: serve not started", "error", err)
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	models, err := coord.srv().ListModels(ctx)
	if err != nil {
		slog.Default().Warn("opencode ListModels failed", "error", err)
		return nil
	}
	return models
}

// ShutdownOpencode stops coordinator loops. The serve is stopped when no live
// terminal lease remains; otherwise ownership is handed off so the TUI keeps
// running across an explicit daemon stop.
func (sm *SessionManager) ShutdownOpencode() {
	sm.mu.Lock()
	c := sm.opencode
	sm.mu.Unlock()
	if c != nil {
		c.Shutdown()
	}
}

// PrepareDaemonRestart preserves only the OpenCode serve across a Web-requested
// daemon replacement. Explicit daemon stop continues to call ShutdownOpencode.
func (sm *SessionManager) PrepareDaemonRestart() error {
	sm.mu.Lock()
	c := sm.opencode
	sm.mu.Unlock()
	if c == nil {
		return nil
	}
	return c.PrepareDaemonRestart()
}

// CancelDaemonRestart restores normal destructive shutdown semantics if the
// replacement process could not be spawned after preparing the handoff.
func (sm *SessionManager) CancelDaemonRestart() {
	sm.mu.Lock()
	c := sm.opencode
	sm.mu.Unlock()
	if c != nil {
		c.cancelDaemonRestart()
	}
}

// RegisterOpencodeTerminalSession registers a terminal-discovered opencode
// session so clients can view it (events fed by the message poller) and continue
// it (via the shared serve POST /prompt — the session loads from the shared DB).
// Returns true if newly registered.
func (sm *SessionManager) RegisterOpencodeTerminalSession(sessionID, cwd string) bool {
	coord := sm.ensureOpencode()
	controlMode := coord.controlModeForSession(sessionID, cwd)
	sm.mu.Lock()
	defer sm.mu.Unlock()
	if _, exists := sm.sessions[sessionID]; exists {
		return false
	}
	now := time.Now()
	sm.sessions[sessionID] = &ProcessState{
		SessionID:      sessionID,
		Status:         protocol.StatusIdle,
		StartedAt:      now,
		LastActivityAt: now,
		Cwd:            cwd,
		Agent:          adapter.AgentOpencode,
		Source:         "terminal",
		Backend:        &serverBackend{coord: coord},
		ControlMode:    controlMode,
	}
	return true
}

// createOpencodeSession is the server-kind counterpart to CreateSession's PTY
// flow: resolve + validate cwd, create the session via the shared serve process,
// register a backend-driven ProcessState, start its message poller, and submit
// the initial prompt.
func (sm *SessionManager) createOpencodeSession(ctx context.Context, config protocol.SessionConfig) (string, error) {
	resolvedCwd := resolveCwd(config.Cwd)
	if config.AutoCreateDir {
		_ = os.MkdirAll(resolvedCwd, 0o755)
	}
	if err := validateCwd(resolvedCwd); err != nil {
		return "", err
	}
	if !config.Force {
		if n := sm.CwdSessionCount(resolvedCwd); n > 0 {
			return "", fmt.Errorf("目录已被占用: %s (当前已有 %d 个活跃会话；如需继续请在客户端勾选\"强制创建\"后重试)", resolvedCwd, n)
		}
	}

	coord := sm.ensureOpencode()
	if err := coord.ensureStarted(); err != nil {
		return "", fmt.Errorf("start opencode serve: %w", err)
	}
	backend := &serverBackend{coord: coord}

	cfg := config
	cfg.Cwd = resolvedCwd
	// opencode requires a *valid* model on the session — it does NOT auto-apply
	// the config default to API-created sessions, and a model-less (or stale-model)
	// session silently fails the turn (ProviderModelNotFoundError) with no message
	// and no response. When the client didn't pick one, use ListModels()[0]: it
	// returns the config default first IFF it's still a valid model, otherwise the
	// first available model — so we never set a stale/renamed model id.
	if strings.TrimSpace(cfg.Model) == "" {
		var resolveErr error
		cfg.Model, resolveErr = coord.srv().ResolveDefaultModel(ctx)
		if resolveErr != nil {
			return "", fmt.Errorf("select runnable opencode model: %w", resolveErr)
		}
	}
	sid, err := backend.Start(ctx, cfg)
	if err != nil {
		return "", fmt.Errorf("create opencode session: %w", err)
	}

	now := time.Now()
	ps := &ProcessState{
		SessionID:      sid,
		Status:         protocol.StatusIdle,
		StartedAt:      now,
		LastActivityAt: now,
		Cwd:            resolvedCwd,
		Agent:          config.Agent,
		Source:         "daemon",
		Model:          cfg.Model,
		Backend:        backend,
		ControlMode:    protocol.ControlManaged,
	}
	sm.mu.Lock()
	sm.sessions[sid] = ps
	sm.mu.Unlock()
	coord.markManagedSession(sid, resolvedCwd)
	sm.registerCwd(sid, resolvedCwd)

	// Start the message poller (emitUser=false: we echo the user message below).
	coord.startSync(sid, false)

	slog.Default().Info("opencode owned session ready", "session", sid, "model", cfg.Model, "has_initial_prompt", config.Prompt != "")
	if config.Prompt != "" {
		sm.outputCh <- protocol.DaemonEvent{Type: "user_text", SessionID: sid, Text: config.Prompt}
		if err := backend.Send(ctx, sid, config.Prompt); err != nil {
			sm.outputCh <- protocol.DaemonEvent{Type: "error", SessionID: sid, Error: "opencode 发送初始消息失败: " + err.Error()}
		}
	}
	return sid, nil
}
