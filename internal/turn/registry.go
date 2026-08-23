package turn

import (
	"sync"
	"time"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

// Metrics observes registry outcomes for daemon-side counters. A nil-able
// no-op default keeps the core dependency-free. Implementations must never
// include content or sensitive fields.
type Metrics interface {
	InvalidTransition(turnID, from, to string)
	InferredTerminal(turnID, state, reason string)
	UnknownClassification(eventType string)
	JournalCorruption(path string, err error)
}

// MetricsFuncs adapts plain functions to Metrics.
type MetricsFuncs struct {
	OnInvalidTransition     func(turnID, from, to string)
	OnInferredTerminal      func(turnID, state, reason string)
	OnUnknownClassification func(eventType string)
	OnJournalCorruption     func(path string, err error)
}

func (m MetricsFuncs) InvalidTransition(turnID, from, to string) {
	if m.OnInvalidTransition != nil {
		m.OnInvalidTransition(turnID, from, to)
	}
}
func (m MetricsFuncs) InferredTerminal(turnID, state, reason string) {
	if m.OnInferredTerminal != nil {
		m.OnInferredTerminal(turnID, state, reason)
	}
}
func (m MetricsFuncs) UnknownClassification(eventType string) {
	if m.OnUnknownClassification != nil {
		m.OnUnknownClassification(eventType)
	}
}
func (m MetricsFuncs) JournalCorruption(path string, err error) {
	if m.OnJournalCorruption != nil {
		m.OnJournalCorruption(path, err)
	}
}

// ErrNoActiveTurn, ErrStaleTurn and ErrNoIdentityAnchor are typed registry
// outcomes callers branch on; they are not bugs.
var (
	ErrNoActiveTurn      = errString("no active turn for actor")
	ErrStaleTurn         = errString("turn reference does not match the active turn")
	ErrNoIdentityAnchor  = errString("no stable identity anchor for turn start")
	ErrTurnAlreadyActive = errString("turn id already has an active record")
)

type errString string

func (e errString) Error() string { return string(e) }

// recentTurns bounds per-actor history so long-running daemons do not grow
// memory without limit. Terminal turns older than this are forgotten; relay
// event_id dedup remains the last line of defense.
const recentTurns = 64

// TurnRecord is the registry's view of one turn.
type TurnRecord struct {
	Actor        ActorKey
	Agent        string
	TurnID       string
	SourceTurnID string
	// ExpectedSourceTurnID is a dispatch reservation, not observed source
	// evidence. It is persisted across daemon restart but never emitted as the
	// canonical SourceTurnID until BindSource confirms the exact native id.
	ExpectedSourceTurnID string
	State                string
	Origin               string
	Confidence           string
	PreviousTurnID       string
	ContinuationReason   string
	// ParentTurnID is an explicit causal relation. AgentID/session proximity is
	// never sufficient to infer that a child belongs to a root turn.
	ParentTurnID  string
	StartedAt     time.Time
	RequestIDHash string
	LastReason    string
	// Restored marks turns reloaded from the journal. Their evidence predates
	// this daemon process, so input dispatch reconciles them against the
	// live session state before treating them as addendum anchors.
	Restored bool
}

type actorState struct {
	active *TurnRecord
	recent []TurnRecord // bounded, newest last
}

// Registry is the concurrency-safe turn state machine keyed by
// (session_id, normalized_agent_id). All mutations go through the explicit
// API; callers can never write state directly.
type Registry struct {
	mu      sync.Mutex
	actors  map[ActorKey]*actorState
	emitted map[string]struct{} // "turnID|state" -> emitted turn_status events
	journal *Journal
	metrics Metrics
	now     func() time.Time
}

// NewRegistry builds a registry. journal and metrics are optional (nil
// disables persistence / metrics).
func NewRegistry(journal *Journal, metrics Metrics) *Registry {
	return &Registry{
		actors:  make(map[ActorKey]*actorState),
		journal: journal,
		metrics: metrics,
		now:     time.Now,
	}
}

// StartInput describes one turn start request.
type StartInput struct {
	Actor              ActorKey
	Agent              string
	Identity           Identity
	PreviousTurnID     string
	ContinuationReason string
	ParentTurnID       string
}

func (in StartInput) normalized() StartInput {
	in.Actor.AgentID = NormalizeAgentID(in.Actor.AgentID)
	return in
}

// Start reserves a new running turn for the actor, deriving the logical id
// from the strongest identity anchor. Re-starting the same derived id while
// it is still running is idempotent (relay request retry); a different active
// turn is rejected; interrupt_requested rejects with InterruptPendingError.
func (r *Registry) Start(in StartInput) (TurnRecord, error) {
	in = in.normalized()
	kind, _ := in.Identity.SourceKind()
	if kind == "" {
		return TurnRecord{}, ErrNoIdentityAnchor
	}
	turnID, origin := in.Identity.Resolve(in.Actor.SessionID, in.Actor.AgentID)

	r.mu.Lock()
	defer r.mu.Unlock()
	st := r.stateFor(in.Actor)
	if st.active != nil {
		if st.active.TurnID == turnID && st.active.State == protocol.TurnStateRunning {
			return *st.active, nil // idempotent reserve of the same request
		}
		if st.active.State == protocol.TurnStateInterruptRequested {
			return *st.active, &InterruptPendingError{TurnID: st.active.TurnID}
		}
		return *st.active, &ActiveTurnError{TurnID: st.active.TurnID, State: st.active.State}
	}
	for i := range st.recent {
		if st.recent[i].TurnID == turnID {
			return TurnRecord{}, &TransitionError{TurnID: turnID, From: st.recent[i].State, To: protocol.TurnStateRunning}
		}
	}
	rec := &TurnRecord{
		Actor:              in.Actor,
		Agent:              in.Identity.Agent,
		TurnID:             turnID,
		SourceTurnID:       in.Identity.SourceTurnID,
		State:              protocol.TurnStateRunning,
		Origin:             origin,
		Confidence:         confidenceForOrigin(origin),
		PreviousTurnID:     in.PreviousTurnID,
		ContinuationReason: in.ContinuationReason,
		ParentTurnID:       in.ParentTurnID,
		StartedAt:          r.now(),
		RequestIDHash:      HashRequestID(in.Identity.RequestID),
	}
	st.active = rec
	r.persistLocked()
	return *rec, nil
}

// BindSource records the source-native identity observed for a canonical
// active turn. The first non-empty binding wins; later matching evidence is
// idempotent and conflicting/stale evidence cannot rewrite the association.
func (r *Registry) BindSource(key ActorKey, turnID, sourceTurnID string) (TurnRecord, error) {
	key.AgentID = NormalizeAgentID(key.AgentID)
	r.mu.Lock()
	defer r.mu.Unlock()
	rec, ok := r.activeLocked(key)
	if !ok {
		return TurnRecord{}, ErrNoActiveTurn
	}
	if rec.TurnID != turnID {
		return *rec, ErrStaleTurn
	}
	if sourceTurnID == "" || rec.SourceTurnID == sourceTurnID {
		return *rec, nil
	}
	if rec.SourceTurnID != "" {
		return *rec, ErrStaleTurn
	}
	if rec.ExpectedSourceTurnID != "" && rec.ExpectedSourceTurnID != sourceTurnID {
		return *rec, ErrStaleTurn
	}
	rec.SourceTurnID = sourceTurnID
	rec.ExpectedSourceTurnID = ""
	r.persistLocked()
	return *rec, nil
}

// ExpectSource records the native source id allocated for an outbound
// dispatch without treating it as observed evidence. The first expectation
// wins; BindSource later confirms only that exact id. This closes the window
// where an unrelated native source can arrive between request reservation and
// the actual agent dispatch.
func (r *Registry) ExpectSource(key ActorKey, turnID, sourceTurnID string) (TurnRecord, error) {
	key.AgentID = NormalizeAgentID(key.AgentID)
	r.mu.Lock()
	defer r.mu.Unlock()
	rec, ok := r.activeLocked(key)
	if !ok {
		return TurnRecord{}, ErrNoActiveTurn
	}
	if rec.TurnID != turnID {
		return *rec, ErrStaleTurn
	}
	if sourceTurnID == "" || rec.SourceTurnID == sourceTurnID || rec.ExpectedSourceTurnID == sourceTurnID {
		return *rec, nil
	}
	if rec.SourceTurnID != "" || rec.ExpectedSourceTurnID != "" {
		return *rec, ErrStaleTurn
	}
	rec.ExpectedSourceTurnID = sourceTurnID
	r.persistLocked()
	return *rec, nil
}

func confidenceForOrigin(origin string) string {
	if origin == protocol.TurnOriginNative {
		return protocol.TurnConfidenceNative
	}
	return protocol.TurnConfidenceDerived
}

// Addendum binds an input to the actor's running turn without creating a new
// one. The turn state is unchanged, so no turn_status event is emitted.
func (r *Registry) Addendum(key ActorKey, requestID string) (TurnRecord, error) {
	key.AgentID = NormalizeAgentID(key.AgentID)
	r.mu.Lock()
	defer r.mu.Unlock()
	rec, ok := r.activeLocked(key)
	if !ok {
		return TurnRecord{}, ErrNoActiveTurn
	}
	switch rec.State {
	case protocol.TurnStateRunning:
		if h := HashRequestID(requestID); h != "" {
			rec.RequestIDHash = h
		}
		return *rec, nil
	case protocol.TurnStateInterruptRequested:
		return *rec, &InterruptPendingError{TurnID: rec.TurnID}
	default:
		return *rec, &TransitionError{TurnID: rec.TurnID, From: rec.State, To: protocol.TurnStateRunning}
	}
}

// RequestInterrupt moves a running turn to interrupt_requested. Re-requesting
// while already interrupt_requested is idempotent; a missing active turn is a
// typed error (never a guess about "the most recent turn").
func (r *Registry) RequestInterrupt(key ActorKey, reason string) (TurnRecord, error) {
	key.AgentID = NormalizeAgentID(key.AgentID)
	r.mu.Lock()
	defer r.mu.Unlock()
	rec, ok := r.activeLocked(key)
	if !ok {
		return TurnRecord{}, ErrNoActiveTurn
	}
	if rec.State == protocol.TurnStateInterruptRequested {
		return *rec, nil // idempotent
	}
	if err := r.transitionLocked(rec, protocol.TurnStateInterruptRequested, reason, protocol.TurnConfidenceDerived); err != nil {
		return TurnRecord{}, err
	}
	return *rec, nil
}

// Terminalize drives the active turn (identified by turnID) to a terminal
// state. Same-state repeats are idempotent — including repeats that arrive
// after the turn already left the active slot (late duplicate source events);
// mismatched ids are stale facts and must not touch the active turn.
func (r *Registry) Terminalize(key ActorKey, turnID, state, reason, confidence string) (TurnRecord, error) {
	key.AgentID = NormalizeAgentID(key.AgentID)
	r.mu.Lock()
	defer r.mu.Unlock()
	rec, ok := r.activeLocked(key)
	if !ok {
		if earlier, found := r.recentLocked(key, turnID); found {
			if earlier.State == state {
				return earlier, nil // idempotent late duplicate
			}
			return earlier, &TransitionError{TurnID: turnID, From: earlier.State, To: state}
		}
		return TurnRecord{}, ErrNoActiveTurn
	}
	if rec.TurnID != turnID {
		return *rec, ErrStaleTurn
	}
	if rec.State == state {
		return *rec, nil // idempotent terminal
	}
	if err := r.transitionLocked(rec, state, reason, confidence); err != nil {
		return TurnRecord{}, err
	}
	return *rec, nil
}

// recentLocked finds a terminal record by turn id inside the actor's bounded
// history.
func (r *Registry) recentLocked(key ActorKey, turnID string) (TurnRecord, bool) {
	st, ok := r.actors[key]
	if !ok {
		return TurnRecord{}, false
	}
	for i := len(st.recent) - 1; i >= 0; i-- {
		if st.recent[i].TurnID == turnID {
			return st.recent[i], true
		}
	}
	return TurnRecord{}, false
}

// Reconcile applies an externally observed fact about a turn. It covers the
// observer direction (adopt a running turn the registry does not know) and
// the provider direction (same rules as Terminalize). A terminal fact about
// an unknown turn, or a running fact that collides with a different active
// turn, is ignored as stale — never a guess.
func (r *Registry) Reconcile(fact TurnRecord) (TurnRecord, error) {
	fact.Actor.AgentID = NormalizeAgentID(fact.Actor.AgentID)
	r.mu.Lock()
	defer r.mu.Unlock()
	st := r.stateFor(fact.Actor)
	if st.active == nil {
		if !IsActive(fact.State) || !ValidState(fact.State) {
			return TurnRecord{}, ErrStaleTurn
		}
		rec := fact // adopt the observed active turn (e.g. journal-less observers)
		st.active = &rec
		r.persistLocked()
		return rec, nil
	}
	if st.active.TurnID != fact.TurnID {
		return *st.active, ErrStaleTurn
	}
	if st.active.State == fact.State {
		return *st.active, nil
	}
	rec := st.active
	if err := r.transitionLocked(rec, fact.State, fact.LastReason, fact.Confidence); err != nil {
		return TurnRecord{}, err
	}
	return *rec, nil
}

// Active returns the actor's current non-terminal turn.
func (r *Registry) Active(key ActorKey) (TurnRecord, bool) {
	key.AgentID = NormalizeAgentID(key.AgentID)
	r.mu.Lock()
	defer r.mu.Unlock()
	rec, ok := r.activeLocked(key)
	if !ok {
		return TurnRecord{}, false
	}
	return *rec, true
}

// Last returns the actor's most recently terminalized turn (falling back to
// the active one), enabling after-interrupt continuation links and
// completion-side-effect guards without leaking registry internals.
func (r *Registry) Last(key ActorKey) (TurnRecord, bool) {
	key.AgentID = NormalizeAgentID(key.AgentID)
	r.mu.Lock()
	defer r.mu.Unlock()
	st, ok := r.actors[key]
	if !ok {
		return TurnRecord{}, false
	}
	if len(st.recent) > 0 {
		return st.recent[len(st.recent)-1], true
	}
	if st.active != nil {
		return *st.active, true
	}
	return TurnRecord{}, false
}

// ActiveAll snapshots every active turn (journal reconciliation, shutdown).
func (r *Registry) ActiveAll() map[ActorKey]TurnRecord {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make(map[ActorKey]TurnRecord, len(r.actors))
	for key, st := range r.actors {
		if st.active != nil {
			out[key] = *st.active
		}
	}
	return out
}

// ClaimEmission reports whether a turn_status event for (turnID, state) has
// not been emitted yet, marking it emitted atomically. This is the single
// dedup point enforcing "one event per turn_id + state".
func (r *Registry) ClaimEmission(turnID, state string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	key := turnID + "|" + state
	if r.emitted == nil {
		r.emitted = make(map[string]struct{})
	}
	if _, dup := r.emitted[key]; dup {
		return false
	}
	r.emitted[key] = struct{}{}
	return true
}

// Restore injects non-terminal journal entries after a daemon restart. It
// never overwrites an existing active record for the same actor; the caller
// reconciles restored turns against discovered session state afterwards.
func (r *Registry) Restore(entries []JournalEntry) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, e := range entries {
		if !IsActive(e.State) || e.TurnID == "" {
			continue
		}
		key := ActorKey{SessionID: e.SessionID, AgentID: NormalizeAgentID(e.AgentID)}
		st := r.stateFor(key)
		if st.active != nil {
			continue
		}
		st.active = &TurnRecord{
			Actor:                key,
			TurnID:               e.TurnID,
			SourceTurnID:         e.SourceTurnID,
			ExpectedSourceTurnID: e.ExpectedSourceTurnID,
			ParentTurnID:         e.ParentTurnID,
			State:                e.State,
			Origin:               e.Origin,
			Confidence:           e.Confidence,
			StartedAt:            e.StartedAt,
			RequestIDHash:        e.RequestIDHash,
			Restored:             true,
		}
	}
	r.persistLocked()
}

func (r *Registry) activeLocked(key ActorKey) (*TurnRecord, bool) {
	st, ok := r.actors[key]
	if !ok || st.active == nil || !IsActive(st.active.State) {
		return nil, false
	}
	return st.active, true
}

func (r *Registry) stateFor(key ActorKey) *actorState {
	st, ok := r.actors[key]
	if !ok {
		st = &actorState{}
		r.actors[key] = st
	}
	return st
}

func (r *Registry) transitionLocked(rec *TurnRecord, to, reason, confidence string) error {
	if !ValidState(to) || !CanTransition(rec.State, to) {
		if r.metrics != nil {
			r.metrics.InvalidTransition(rec.TurnID, rec.State, to)
		}
		return &TransitionError{TurnID: rec.TurnID, From: rec.State, To: to}
	}
	if IsTerminal(to) && confidence == protocol.TurnConfidenceInferred && r.metrics != nil {
		r.metrics.InferredTerminal(rec.TurnID, to, reason)
	}
	rec.State = to
	rec.LastReason = reason
	if confidence != "" {
		rec.Confidence = confidence
	}
	if IsTerminal(to) {
		rec.ExpectedSourceTurnID = ""
		st := r.stateFor(rec.Actor)
		if st.active == rec {
			st.recent = append(st.recent, *rec)
			if len(st.recent) > recentTurns {
				st.recent = st.recent[len(st.recent)-recentTurns:]
			}
			st.active = nil
		}
	}
	r.persistLocked()
	return nil
}

func (r *Registry) persistLocked() {
	if r.journal == nil {
		return
	}
	entries := make([]JournalEntry, 0, len(r.actors))
	for key, st := range r.actors {
		if st.active == nil {
			continue
		}
		entries = append(entries, JournalEntry{
			SessionID:            key.SessionID,
			AgentID:              key.AgentID,
			TurnID:               st.active.TurnID,
			SourceTurnID:         st.active.SourceTurnID,
			ExpectedSourceTurnID: st.active.ExpectedSourceTurnID,
			ParentTurnID:         st.active.ParentTurnID,
			State:                st.active.State,
			Origin:               st.active.Origin,
			Confidence:           st.active.Confidence,
			StartedAt:            st.active.StartedAt,
			RequestIDHash:        st.active.RequestIDHash,
		})
	}
	if err := r.journal.Save(entries); err != nil && r.metrics != nil {
		r.metrics.JournalCorruption(r.journal.Path(), err)
	}
}
