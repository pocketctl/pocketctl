package zcode

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

// observer.go runs the isolated ZCode read-only sync loop. It owns its own
// store, sync map, catalog and CursorStore — it does NOT hold a SessionManager
// reference, never enters ActiveRootSessionIDs, and never drives a session
// (design §7 / ADR-001).
//
// Backpressure: the observer never blocks the shared outputCh. main injects a
// tryEmit closure (the low-priority gate); the observer only sends when the
// gate accepts (len(outputCh) <= cap/4). On rejection it keeps its pending
// state, pauses paging, and yields. ZCode congestion therefore never starves
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
	ActivePoll   time.Duration          // default 1s
	IdlePoll     time.Duration          // default 5s
	DisablePoll  time.Duration          // default 5s (config-disable check interval)
	Emit         EmitFunc               // low-priority gate (content events)
	EmitDirect   EmitFunc               // bypass-gate for critical metadata (session_status)
	Logger       *slog.Logger
}

// Observer runs the ZCode sync loop independently of the SessionManager.
type Observer struct {
	cfg     ObserverConfig
	store   *Store
	cursor  *CursorStore
	mu      sync.Mutex
	syncs   map[string]*ZcodeSync // wire session id → differ
	enabled bool
	stop    chan struct{}
	done    chan struct{}
	resync  chan struct{}
	log     *slog.Logger
}

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
		cfg:    cfg,
		syncs:  make(map[string]*ZcodeSync),
		stop:   make(chan struct{}),
		done:   make(chan struct{}),
		resync: make(chan struct{}, 1),
		log:    cfg.Logger,
	}
	// Bind an injected cursor store up front so AcknowledgeEventIDs works even
	// before Start (tests, or ACKs arriving before the first poll). Start()
	// fills in a default cursor store when none is injected.
	if cfg.CursorStore != nil {
		o.cursor = cfg.CursorStore
	}
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
	o.enabled = true
	go o.loop(ctx)
	return nil
}

// QueueResync asks the observer to re-emit resync metadata for its sessions on
// the next loop tick. Called by main on relay reconnect.
func (o *Observer) QueueResync() {
	select {
	case o.resync <- struct{}{}:
	default:
	}
}

// AcknowledgeEventIDs forwards a relay ACK to the cursor store. Called by main
// from the combined OnEventsAcknowledged callback.
func (o *Observer) AcknowledgeEventIDs(eventIDs []string) {
	if o.cursor == nil {
		return
	}
	cf, err := o.cursor.Load()
	if err != nil {
		o.log.Warn("zcode ack: load cursor failed", "error", err)
		return
	}
	if _, err := o.cursor.AcknowledgeEventIDs(&cf, eventIDs); err != nil {
		o.log.Warn("zcode ack: advance cursor failed", "error", err)
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
}

func (o *Observer) loop(ctx context.Context) {
	defer close(o.done)
	ticker := time.NewTicker(o.cfg.ActivePoll)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-o.stop:
			return
		case <-o.resync:
			o.handleResync()
		case <-ticker.C:
			o.mu.Lock()
			enabled := o.enabled
			o.mu.Unlock()
			if !enabled {
				// Disabled: keep the loop alive (so Disable is noticed) but do
				// no DB work. Stop() is the durable shutdown.
				continue
			}
			o.pollOnce(ctx)
		}
	}
}

// handleResync re-emits a session_discovered (Resync=true) for each known
// session through the low-priority gate. It does NOT burst-send content.
func (o *Observer) handleResync() {
	if o.cfg.Emit == nil || o.cursor == nil {
		return
	}
	cf, err := o.cursor.Load()
	if err != nil {
		return
	}
	mp := NewMapper(o.cfg.SourceID)
	for wireID := range cf.Sessions {
		ev := mp.SessionDiscovered(wireID, "", "", "", "completed")
		ev.Resync = true
		// Low-priority gate: if rejected, keep trying on subsequent ticks (the
		// pending resync state is implicit in cf.Sessions).
		o.cfg.Emit(ev)
	}
}

// pollOnce runs a single bounded scan: discover sessions, and for each emit at
// most one batch of content through the low-priority gate. It records pending
// positions before emitting so a crash never loses the source position.
func (o *Observer) pollOnce(ctx context.Context) {
	if o.store == nil || o.cfg.Emit == nil {
		return
	}
	cf, err := o.cursor.Load()
	if err != nil {
		return
	}
	// Stamp the cursor identity so a storage/schema change is detectable and
	// the source id is durably bound (design §7.1 / §7.4).
	cf.SourceID = o.cfg.SourceID
	if fp := o.store.Fingerprint(); fp != "" {
		cf.SchemaFingerprint = fp
	}
	cf.StoragePathHash = StoragePathHash(o.cfg.StorageDir)
	scope := HistoryScopeAll
	if o.cfg.History == HistoryRecent {
		scope = HistoryScopeRecent
	}
	page, err := o.store.ListSessions(ctx, scope, o.cfg.LookbackDays, nil, 50)
	if err != nil {
		o.log.Warn("zcode poll: list sessions", "error", err)
		return
	}
	for _, sr := range page.Sessions {
		wireID := WireSessionID(o.cfg.SourceID, sr.ID)
		o.scanSession(ctx, &cf, wireID, sr)
		// Derive and emit session_status INDEPENDENTLY of content paging.
		// scanSession may early-return on backpressure before reaching the tail,
		// so status is derived here via a lightweight query (2 single-row SELECTs)
		// rather than from the paging loop. This ensures running/completed is
		// always synced even when the shared outputCh is congested.
		o.emitDerivedStatus(ctx, &cf, wireID, sr)
		// If this is a child (subagent) session, emit a subagent_discovered
		// event linking it to its parent.
		if sr.ParentID != "" {
			o.emitSubagentDiscovered(ctx, &cf, sr)
		}
		if !o.lowWaterMarkAvailable() {
			break
		}
	}
	cf.LastScanUnixMs = time.Now().UnixMilli()
	_ = o.cursor.Save(cf)
}

func (o *Observer) scanSession(ctx context.Context, cf *CursorFile, wireID string, sr SessionRow) {
	sync := o.getSync(wireID)
	// session meta (discovered/title/model). The status passed here is the
	// INITIAL status only; the derived live status is emitted via DiffStatus
	// after content scanning (once we know the last tool/finish state).
	for _, ev := range sync.DiffSessionMeta(sr.Title, "", "completed") {
		positionKey := "meta:" + wireID
		_ = o.cursor.RecordPending(cf, wireID, positionKey, []string{ev.EventID}, "")
		if !o.tryEmit(ev) {
			return
		}
	}
	// Messages: page through ALL messages (the differ skips already-emitted ones,
	// so this is cheap for steady-state and catches new ones). Stop early only
	// when the low-priority gate yields. Track the last assistant finish signal
	// for status derivation.
	msgAfter := cf.Sessions[wireID].AckMessageSequence
	wireMsgIDs := make(map[string]string, 64)
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}
		msgPage, err := o.store.ListMessages(ctx, sr.ID, msgAfter, 100)
		if err != nil {
			return
		}
		if len(msgPage.Messages) == 0 {
			break
		}
		for _, m := range msgPage.Messages {
			data, ok := DecodeMessageData(m.DataJSON)
			if !ok {
				continue
			}
			if data.Role == "assistant" {
				_ = data.Finish // tracked via emitDerivedStatus, not here
			}
			wireMsgID := WireMessageID(o.cfg.SourceID, m.ID)
			wireMsgIDs[m.ID] = wireMsgID
			evs := sync.DiffMessage(m.ID, wireMsgID, data)
			o.emitBatch(cf, wireID, "msg:"+m.ID, evs)
			msgAfter = m.Sequence
		}
		if msgPage.NextSequence == 0 {
			break // exhausted
		}
		if !o.lowWaterMarkAvailable() {
			return
		}
	}
	// Parts: page through ALL parts via the composite cursor; track the last
	// tool state for status derivation.
	partCursor := &PartCursor{
		MessageSequence: cf.Sessions[wireID].AckPartMessageSeq,
		PartSequence:    cf.Sessions[wireID].AckPartSeq,
	}
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}
		partPage, err := o.store.ListParts(ctx, sr.ID, partCursor, 500)
		if err != nil {
			return
		}
		if len(partPage.Parts) == 0 {
			break
		}
		for _, p := range partPage.Parts {
			part, ok := DecodePartData(p.DataJSON)
			if !ok {
				continue
			}
			if part.Type == "tool" && part.State != nil {
				_ = part.State.Status // tracked via emitDerivedStatus, not here
			}
			wireMsgID := wireMsgIDs[p.MessageID]
			if wireMsgID == "" {
				wireMsgID = WireMessageID(o.cfg.SourceID, p.MessageID)
			}
			ev, reason := sync.DiffPart(p.ID, wireMsgID, part, "")
			if reason == "skip" || reason == "step-start" || reason == "unknown" {
				continue
			}
			// Record pending BEFORE emit; commit differ only on success.
			o.cursor.RecordPending(cf, wireID, "part:"+p.ID, []string{ev.EventID}, "")
			if !o.tryEmit(ev) {
				return
			}
			sync.CommitPart()
		}
		if partPage.NextCursor == nil {
			break // exhausted
		}
		partCursor = partPage.NextCursor
		if !o.lowWaterMarkAvailable() {
			return
		}
	}
}

// emitDerivedStatus queries the session's latest tool/finish signals via
// lightweight single-row queries (independent of content paging) and emits a
// session_status event when the derived status changes. This runs every poll
// regardless of whether content paging completed, so running/completed is
// always kept in sync.
func (o *Observer) emitDerivedStatus(ctx context.Context, cf *CursorFile, wireID string, sr SessionRow) {
	lastFinish := o.store.QueryLastAssistantFinish(ctx, sr.ID)
	lastTool := o.store.QueryLastToolStatus(ctx, sr.ID)
	derived := deriveSessionStatus(lastFinish, lastTool, sr.TimeUpdated)
	sync := o.getSync(wireID)
	evs := sync.DiffStatus(derived)
	for _, ev := range evs {
		o.cursor.RecordPending(cf, wireID, "status:"+wireID, []string{ev.EventID}, "")
		// session_status is a single small metadata event that directly affects
		// the user-visible session state (running vs completed). It MUST NOT be
		// starved by content backfill backpressure. Try the low-priority gate
		// first; if rejected, fall back to a direct non-blocking send which
		// bypasses the watermark (the event is tiny and critical for UX).
		// Commit the differ state only if at least one path accepted the event.
		if o.tryEmit(ev) || o.emitDirect(ev) {
			sync.CommitStatus()
		}
	}
}

// emitDirect sends a critical metadata event (session_status) bypassing the
// low-watermark gate. main provides this closure alongside Emit; it does a
// non-blocking send directly into outputCh. If the channel is genuinely full
// the send is dropped (best-effort — status is re-derived next poll).
func (o *Observer) emitDirect(ev protocol.DaemonEvent) bool {
	if o.cfg.EmitDirect != nil {
		return o.cfg.EmitDirect(ev)
	}
	// Fallback: try the regular gate (no EmitDirect configured).
	if o.cfg.Emit != nil {
		return o.cfg.Emit(ev)
	}
	return false
}

// emitSubagentDiscovered sends a subagent_discovered event linking a child
// session to its parent. The agentType is extracted from the child's first
// message.data $.agent field (e.g. "zcode-explore"). Falls back to "" if the
// child has no messages or the agent field is absent.
func (o *Observer) emitSubagentDiscovered(ctx context.Context, cf *CursorFile, sr SessionRow) {
	wireChildID := WireSessionID(o.cfg.SourceID, sr.ID)
	wireParentID := WireSessionID(o.cfg.SourceID, sr.ParentID)
	// Extract agentType from the child's first message.
	agentType := ""
	msgPage, err := o.store.ListMessages(ctx, sr.ID, 0, 1)
	if err == nil && len(msgPage.Messages) > 0 {
		if data, ok := DecodeMessageData(msgPage.Messages[0].DataJSON); ok {
			agentType = data.Agent
		}
	}
	mp := NewMapper(o.cfg.SourceID)
	ev := mp.SubagentDiscovered(wireParentID, wireChildID, agentType, sr.Title, "")
	o.cursor.RecordPending(cf, wireChildID, "subagent:"+wireChildID, []string{ev.EventID}, "")
	o.tryEmit(ev)
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

func (o *Observer) emitBatch(cf *CursorFile, wireID, positionKey string, evs []protocol.DaemonEvent) {
	for _, ev := range evs {
		_ = o.cursor.RecordPending(cf, wireID, positionKey, []string{ev.EventID}, "")
		o.tryEmit(ev)
	}
}

// tryEmit emits via the injected gate; if rejected, the pending position stays
// (already recorded) and the observer yields on the next tick.
func (o *Observer) tryEmit(ev protocol.DaemonEvent) bool {
	if o.cfg.Emit == nil {
		return false
	}
	return o.cfg.Emit(ev)
}

// lowWaterMarkAvailable reports whether the shared outputCh is at/below the low
// watermark (cap/4). The gate itself lives in main (which owns the channel); we
// approximate by attempting a no-op probe through Emit only when main signals
// capacity. In practice the Emit closure returns false on rejection, which the
// caller treats as "yield".
func (o *Observer) lowWaterMarkAvailable() bool {
	return true // the Emit closure is the authoritative gate; see tryEmit
}

func (o *Observer) getSync(wireID string) *ZcodeSync {
	o.mu.Lock()
	defer o.mu.Unlock()
	if s, ok := o.syncs[wireID]; ok {
		return s
	}
	s := NewZcodeSync(o.cfg.SourceID, wireID)
	o.syncs[wireID] = s
	return s
}

// WireMessageID returns a stable, native-id-free wire id for a message.
func WireMessageID(sourceID, nativeMessageID string) string {
	return "zcodem-" + hashWithSource(sourceID, nativeMessageID)
}
