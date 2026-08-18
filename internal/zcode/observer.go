package zcode

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

// observer.go runs the isolated ZCode read-only sync loop. It owns its own
// store and CursorStore — it does NOT hold a SessionManager reference, never
// enters ActiveRootSessionIDs, and never drives a session (design §7 /
// ADR-001). Page orchestration lives in observer_scan.go.
//
// Backpressure: the observer never blocks the shared outputCh. main injects a
// tryEmit closure (the low-priority gate); the observer only sends when the
// gate accepts. On rejection it keeps its durable pending state, stops the
// page, and yields. ZCode congestion therefore never starves
// Claude/Codex/OpenCode producers.
//
// ACK: the observer advances its acknowledged cursor only via
// AcknowledgeEventIDs (called from main's combined OnEventsAcknowledged).
// outputCh enqueue is NOT a durable boundary.
//
// Resync: on relay reconnect, main calls QueueResync. The observer re-emits
// resync metadata (session_discovered with Resync=true) for its sessions
// through the same low-priority gate, ordered before any new content — it does
// NOT burst-send all history on OnReconnected.

// EmitFunc attempts to deliver an event to the shared outputCh via the
// low-priority gate. Returns false when the channel is at/above the low
// watermark or a non-blocking send would block; the observer then keeps its
// pending state and retries the same stable event later.
type EmitFunc func(protocol.DaemonEvent) bool

// ObserverConfig parameterizes an Observer (mainly so tests can inject a
// synthetic store, cursor store and fast poll intervals).
type ObserverConfig struct {
	SourceID     string
	StorageDir   string
	History      string
	LookbackDays int
	OpenStore    func() (*Store, error) // injected for tests; nil → Open(StorageDir)
	CursorStore  *CursorStore           // injected for tests; nil → NewCursorStore()
	// PreparedEventJournal holds exact event payloads before pending
	// recording; nil → NewPreparedEventJournal() at Start.
	PreparedEventJournal *PreparedEventJournal
	ActivePoll           time.Duration // default 1s
	IdlePoll             time.Duration // default 5s
	DisablePoll          time.Duration // default 5s (config-disable check interval)
	Emit                 EmitFunc      // low-priority gate (content events)
	EmitDirect           EmitFunc      // bypass-gate for critical metadata (session_status)
	Logger               *slog.Logger
}

// Observer runs the ZCode sync loop independently of the SessionManager.
type Observer struct {
	cfg     ObserverConfig
	store   *Store
	cursor  *CursorStore
	journal *PreparedEventJournal
	mu      sync.Mutex
	enabled bool
	stop    chan struct{}
	done    chan struct{}
	resync  chan struct{}
	log     *slog.Logger
	// testHookPagePrep fires before each page preparation attempt; tests use
	// it to race ACKs and conflicting cursor writes into the page pipeline.
	testHookPagePrep func(kind PositionKind)
	// timerFn builds the resettable poll timer; tests inject a fake so
	// scheduler assertions never sleep for real interval durations.
	timerFn func(d time.Duration) pollTimer

	// Recovery-blocked sessions: a session whose durable pending lost its
	// prepared payload (or whose legacy pending cannot be reconstructed) is
	// skipped at idle cadence with a rate-limited warning until manual
	// recovery; it is never silently resolved by clearing pending.
	recoveryMu      sync.Mutex
	recoveryBlocked map[string]time.Time // wireID → last warn
}

// pollTimer is the resettable timer boundary used by the observer loop.
type pollTimer interface {
	C() <-chan time.Time
	Reset(d time.Duration)
	Stop()
}

// realTimer adapts time.Timer to pollTimer.
type realTimer struct{ t *time.Timer }

func (r *realTimer) C() <-chan time.Time   { return r.t.C }
func (r *realTimer) Reset(d time.Duration) { r.t.Reset(d) }
func (r *realTimer) Stop()                 { r.t.Stop() }

// NewObserver builds (but does not start) an Observer.
func NewObserver(cfg ObserverConfig) *Observer {
	if cfg.ActivePoll == 0 {
		cfg.ActivePoll = time.Second
	}
	if cfg.IdlePoll == 0 {
		cfg.IdlePoll = 5 * time.Second
	}
	if cfg.DisablePoll == 0 {
		cfg.DisablePoll = 5 * time.Second
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	o := &Observer{
		cfg:     cfg,
		stop:    make(chan struct{}),
		done:    make(chan struct{}),
		resync:  make(chan struct{}, 1),
		log:     cfg.Logger,
		timerFn: func(d time.Duration) pollTimer { return &realTimer{t: time.NewTimer(d)} },
	}
	// Bind an injected cursor store up front so AcknowledgeEventIDs works even
	// before Start (tests, or ACKs arriving before the first poll). Start()
	// fills in a default cursor store when none is injected.
	if cfg.CursorStore != nil {
		o.cursor = cfg.CursorStore
	}
	o.journal = cfg.PreparedEventJournal
	o.recoveryBlocked = map[string]time.Time{}
	return o
}

// Start opens the store and begins the poll loop. It returns an error if the
// store cannot be opened (fail-closed: the observer simply does not run; the
// daemon's other agents continue).
func (o *Observer) Start(ctx context.Context) error {
	open := o.cfg.OpenStore
	if open == nil {
		open = func() (*Store, error) { return Open(o.cfg.StorageDir) }
	}
	store, err := open()
	if err != nil {
		return err
	}
	if err := store.Probe(ctx); err != nil {
		store.Close()
		return err
	}
	o.store = store
	if o.cfg.CursorStore == nil {
		cs, err := NewCursorStore()
		if err != nil {
			store.Close()
			return err
		}
		o.cursor = cs
	} else {
		o.cursor = o.cfg.CursorStore
	}
	if _, err := o.bindCursorIdentity(); err != nil {
		store.Close()
		return fmt.Errorf("zcode cursor identity: %w", err)
	}
	if o.journal == nil {
		j, err := NewPreparedEventJournal()
		if err != nil {
			store.Close()
			return err
		}
		o.journal = j
	}
	if err := o.journal.Open(); err != nil {
		store.Close()
		return fmt.Errorf("zcode prepared journal: %w", err)
	}
	o.reconcileRecovery()
	o.enabled = true
	go o.loop(ctx)
	return nil
}

func (o *Observer) bindCursorIdentity() (bool, error) {
	snap, err := o.cursor.Snapshot()
	if err != nil {
		return false, err
	}
	ident := CursorIdentity{
		StoragePathHash:   StoragePathHash(o.cfg.StorageDir),
		SourceID:          o.cfg.SourceID,
		SchemaFingerprint: o.store.Fingerprint(),
	}
	if snap.File.StoragePathHash == ident.StoragePathHash &&
		snap.File.SourceID == ident.SourceID &&
		snap.File.SchemaFingerprint == ident.SchemaFingerprint {
		return false, nil
	}
	if err := o.cursor.UpdateIdentity(ident); err != nil {
		return false, err
	}
	o.recoveryMu.Lock()
	o.recoveryBlocked = map[string]time.Time{}
	o.recoveryMu.Unlock()
	return true, nil
}

// reconcileRecovery validates at startup that every unacknowledged
// PayloadDurable pending EventID still has a live prepared payload. Missing
// payloads mark their sessions recovery-blocked (idle cadence, rate-limited
// warning) instead of spinning or silently dropping pending state.
func (o *Observer) reconcileRecovery() {
	if o.journal == nil || o.cursor == nil {
		return
	}
	snap, err := o.cursor.Snapshot()
	if err != nil {
		o.log.Warn("zcode recovery: cursor snapshot", "error", err)
		return
	}
	referenced := map[string]struct{}{}
	perSession := map[string]map[string]struct{}{}
	for wireID, sess := range snap.File.Sessions {
		for _, pp := range sess.Pending {
			if !pp.PayloadDurable {
				continue
			}
			for _, eid := range pp.ExpectedEventIDs {
				if containsStr(pp.AckedEventIDs, eid) {
					continue // already acknowledged: its payload is spent
				}
				referenced[eid] = struct{}{}
				if perSession[wireID] == nil {
					perSession[wireID] = map[string]struct{}{}
				}
				perSession[wireID][eid] = struct{}{}
			}
		}
	}
	if err := o.journal.Reconcile(referenced); err != nil {
		o.log.Warn("zcode recovery: prepared journal reconcile", "error", err)
		for wireID, ids := range perSession {
			for eid := range ids {
				if _, ok, _ := o.journal.Load(eid); !ok {
					o.markRecoveryBlocked(wireID, fmt.Errorf("%w: %s", ErrPreparedPayloadMissing, eid))
					break
				}
			}
		}
	}
}

// QueueResync asks the observer to re-emit resync metadata for its sessions on
// the next loop tick. Called by main on relay reconnect.
func (o *Observer) QueueResync() {
	select {
	case o.resync <- struct{}{}:
	default:
	}
}

// AcknowledgeEventIDs forwards a relay ACK to the cursor store and then, only
// after the cursor transaction succeeded, tombstones the prepared payloads.
// A journal failure leaves a safe orphan for reconcile/compaction.
func (o *Observer) AcknowledgeEventIDs(eventIDs []string) {
	if o.cursor == nil {
		return
	}
	if _, err := o.cursor.AcknowledgeEventIDs(eventIDs); err != nil {
		o.log.Warn("zcode ack: advance cursor failed", "error", err)
		return
	}
	if o.journal != nil && len(eventIDs) > 0 {
		if err := o.journal.Acknowledge(eventIDs); err != nil {
			o.log.Warn("zcode ack: prepared journal cleanup failed (orphan retained)", "error", err)
		}
	}
}

// isRecoveryBlocked reports whether a session is skipped pending manual
// recovery.
func (o *Observer) isRecoveryBlocked(wireID string) bool {
	o.recoveryMu.Lock()
	defer o.recoveryMu.Unlock()
	_, blocked := o.recoveryBlocked[wireID]
	return blocked
}

// markRecoveryBlocked blocks a session and emits a rate-limited warning (at
// most once per minute per session). Log lines carry wire identifiers only.
func (o *Observer) markRecoveryBlocked(wireID string, reason error) {
	o.recoveryMu.Lock()
	last, blocked := o.recoveryBlocked[wireID]
	now := time.Now()
	o.recoveryBlocked[wireID] = now
	o.recoveryMu.Unlock()
	if !blocked || now.Sub(last) >= time.Minute {
		o.log.Warn("zcode recovery: session blocked pending manual recovery",
			"session", wireID, "error", reason)
	}
}

// Disable stops new queries and emission (the running observer notices within
// DisablePoll). Disable does NOT delete Relay content.
func (o *Observer) Disable() {
	o.mu.Lock()
	o.enabled = false
	o.mu.Unlock()
}

// Stop closes the store and stops the loop. Safe to call once.
func (o *Observer) Stop() {
	select {
	case <-o.stop:
		return
	default:
		close(o.stop)
	}
	<-o.done
	if o.store != nil {
		_ = o.store.Close()
	}
	if o.journal != nil {
		_ = o.journal.Close()
	}
}

func (o *Observer) loop(ctx context.Context) {
	defer close(o.done)
	timer := o.timerFn(o.cfg.ActivePoll)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-o.stop:
			return
		case <-o.resync:
			// Resync wakes an idle observer immediately: re-emit the resync
			// metadata, poll at once, and return to the active interval.
			o.handleResync()
			o.pollAndReschedule(ctx, timer)
		case <-timer.C():
			o.mu.Lock()
			enabled := o.enabled
			o.mu.Unlock()
			if !enabled {
				// Disabled: keep the loop alive (so Disable is noticed) but do
				// no DB work. Stop() is the durable shutdown.
				timer.Reset(o.cfg.DisablePoll)
				continue
			}
			o.pollAndReschedule(ctx, timer)
		}
	}
}

// pollAndReschedule runs one poll and selects the next interval from the
// poll's OUTCOMES: active work (new pending, emissions, or deferred retry)
// keeps the one-second active interval; only-unchanged overlap scans fall
// back to the idle interval. Scanned rows alone never count as active work.
func (o *Observer) pollAndReschedule(ctx context.Context, timer pollTimer) {
	res := o.pollOnce(ctx)
	if res.HasActiveWork() {
		timer.Reset(o.cfg.ActivePoll)
		return
	}
	timer.Reset(o.cfg.IdlePoll)
}

// handleResync re-emits a session_discovered (Resync=true) for each known
// session through the low-priority gate. It does NOT burst-send content.
func (o *Observer) handleResync() {
	if o.cfg.Emit == nil || o.cursor == nil {
		return
	}
	snap, err := o.cursor.Snapshot()
	if err != nil {
		return
	}
	mp := NewMapper(o.cfg.SourceID)
	for wireID := range snap.File.Sessions {
		ev := mp.SessionDiscovered(wireID, "", "", "", "completed")
		ev.Resync = true
		// Low-priority gate: if rejected, keep trying on subsequent ticks.
		o.cfg.Emit(ev)
	}
}

// emitEvent delivers one event. session_status is a tiny metadata event that
// directly affects the user-visible session state: try the low-priority gate
// first, then fall back to a direct non-blocking send that bypasses the
// watermark.
func (o *Observer) emitEvent(ev protocol.DaemonEvent) bool {
	if ev.Type == "session_status" && o.cfg.EmitDirect != nil {
		if o.tryEmit(ev) {
			return true
		}
		return o.emitDirect(ev)
	}
	return o.tryEmit(ev)
}

// tryEmit emits via the injected gate; if rejected, the pending position stays
// (already durable) and the observer re-emits the same stable event later.
func (o *Observer) tryEmit(ev protocol.DaemonEvent) bool {
	if o.cfg.Emit == nil {
		return false
	}
	return o.cfg.Emit(ev)
}

// emitDirect sends a critical metadata event (session_status) bypassing the
// low-watermark gate. main provides this closure alongside Emit; it does a
// non-blocking send directly into outputCh. If the channel is genuinely full
// the send is dropped (best-effort — status is re-derived next poll).
func (o *Observer) emitDirect(ev protocol.DaemonEvent) bool {
	if o.cfg.EmitDirect != nil {
		return o.cfg.EmitDirect(ev)
	}
	if o.cfg.Emit != nil {
		return o.cfg.Emit(ev)
	}
	return false
}

// deriveSessionStatus conservatively derives running/completed from the latest
// DB content signals. It never produces waiting_approval/waiting_question
// (design §6.5 — ZCode DB has no authoritative signal for those).
//
//   - last tool running/pending            → running (tool in flight)
//   - last assistant finish empty + no terminal tool → running (still generating)
//   - last assistant finish stop/completed + tool terminal → completed
//   - default                              → completed (safe)
func deriveSessionStatus(lastAssistantFinish, lastToolStatus string, sessionUpdatedMs int64) string {
	if lastToolStatus == "running" || lastToolStatus == "pending" {
		return protocol.StatusRunning
	}
	if lastAssistantFinish == "" && lastToolStatus != "completed" && lastToolStatus != "error" {
		// No finish signal and tool not terminal → likely still generating.
		// Guard: only treat as running if the session was updated very recently
		// (within 2 minutes), so a stale unfinished message doesn't look live.
		if sessionUpdatedMs > 0 && time.Now().UnixMilli()-sessionUpdatedMs < 2*60*1000 {
			return protocol.StatusRunning
		}
	}
	return protocol.StatusCompleted
}

// WireMessageID returns a stable, native-id-free wire id for a message.
func WireMessageID(sourceID, nativeMessageID string) string {
	return "zcodem-" + hashWithSource(sourceID, nativeMessageID)
}
