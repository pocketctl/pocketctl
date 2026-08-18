package zcode

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sort"
	"time"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

// observer_scan.go is the bounded page orchestration for the ZCode observer
// (ADR-0002). Every insert page follows prepare → persist → emit:
//
//  1. one deep-copy cursor snapshot provides query boundaries, the sync
//     checkpoint, pending commits, and the session's StateRevision;
//  2. a bounded page is queried from SQLite;
//  3. the page is built on a disposable scratch projection (timeline replay)
//     without touching the CursorStore;
//  4. RecordPendingBatch persists the whole page in one transaction — events
//     for a row exist durably before that row is ever emitted;
//  5. an ErrCursorConflict discards the stale page and rebuilds it from a
//     fresh snapshot (bounded retries);
//  6. canonical commits are applied to the published projection and events
//     are emitted in source order until the sink rejects one.
//
// Retrying a page may rediscover a durable pending record: the row is
// regenerated from the projection state immediately preceding its commit, its
// event ids are validated against the persisted set, and only unacked ids are
// re-emitted.

const (
	sessionPageSize    = 50
	messagePageSize    = 100
	partPageSize       = 500
	maxConflictRetries = 3
	initialStatus      = "completed"
)

// preparedRow is one source row with its regenerated events and pending
// identity. ackedIDs carries the snapshot's acknowledged set for rediscovered
// rows so already-acked events are not re-emitted.
type preparedRow struct {
	Pending PendingRecord
	Events  []protocol.DaemonEvent
	// isNew marks rows whose pending record is submitted this round (their
	// payloads must pass through the prepared journal).
	isNew bool
	// ackedIDs carries the snapshot's acknowledged set for rediscovered rows
	// so already-acked events are not re-emitted.
	ackedIDs []string
}

// pagePlan is one fully-prepared page awaiting durable recording.
type pagePlan struct {
	rows          []preparedRow
	newRecords    []PendingRecord
	scanned       int
	hasMore       bool
	nextMsgAfter  int64          // message-insert continuation (raw, in-memory only)
	nextPartAfter *PartCursor    // part-insert continuation (raw, in-memory only)
	nextMutation  MutationCursor // mutation continuation (transient, never persisted)
}

// pollResult aggregates one poll across sessions. Scanned-but-unchanged rows
// are deliberately absent: they are not outcomes and must not influence
// interval selection.
type pollResult struct {
	NewPending      int
	Emitted         int
	Deferred        bool
	ConflictRetries int
	PersistCalls    int
}

// HasActiveWork reports whether the poll produced outcome-level work: newly
// recorded pending entries, emitted events, or deferred retryable work.
func (r pollResult) HasActiveWork() bool {
	return r.NewPending > 0 || r.Emitted > 0 || r.Deferred
}

// streamStats aggregates one stream (or session) within a poll.
type streamStats struct {
	scanned    int
	newPending int
	emitted    int
	deferred   bool
	conflicts  int
}

// pollOnce runs one bounded scan: discover sessions, and for each run the
// metadata, insert, status and subagent page pipelines.
func (o *Observer) pollOnce(ctx context.Context) pollResult {
	var res pollResult
	if o.store == nil || o.cfg.Emit == nil {
		return res
	}
	reset, err := o.bindCursorIdentity()
	if err != nil {
		o.log.Warn("zcode poll: update cursor identity", "error", err)
		return res
	}
	if reset {
		o.reconcileRecovery()
	}
	scope := HistoryScopeAll
	if o.cfg.History == HistoryRecent {
		scope = HistoryScopeRecent
	}
	page, err := o.store.ListSessions(ctx, scope, o.cfg.LookbackDays, nil, sessionPageSize)
	if err != nil {
		o.log.Warn("zcode poll: list sessions", "error", err)
		return res
	}
	for _, sr := range page.Sessions {
		o.mu.Lock()
		enabled := o.enabled
		o.mu.Unlock()
		if !enabled {
			// Disable() landed mid-poll: stop scanning further sessions. The
			// in-flight session's page may still complete (at-least-once).
			break
		}
		wireID := WireSessionID(o.cfg.SourceID, sr.ID)
		if o.isRecoveryBlocked(wireID) {
			// Recovery-blocked sessions never spin: re-assert the
			// rate-limited warning and contribute no outcomes so the poll
			// falls back to the idle interval.
			o.markRecoveryBlocked(wireID, ErrPreparedPayloadMissing)
			continue
		}
		st := o.scanSession(ctx, wireID, sr)
		res.NewPending += st.newPending
		res.Emitted += st.emitted
		res.ConflictRetries += st.conflicts
		if st.deferred {
			res.Deferred = true
			break
		}
	}
	_ = o.cursor.TouchLastScan(time.Now().UnixMilli())
	return res
}

// scanSession runs the page pipelines for one session: discovered/title/model
// first (Relay must know the session before content), then insert streams,
// then the derived status and subagent metadata — the latter run even when
// content paging deferred, mirroring the legacy scan order.
func (o *Observer) scanSession(ctx context.Context, wireID string, sr SessionRow) streamStats {
	var total streamStats
	plan, st := o.runPage(ctx, wireID, PositionMetadata, func(sess SessionCursor) (pagePlan, error) {
		return o.planMetaPage(wireID, sess, sr)
	})
	total.merge(st, plan.scanned)
	// A recovery-blocked session stops mid-poll: no stream may create new
	// generations behind an unrecoverable gap.
	if !total.deferred && !o.isRecoveryBlocked(wireID) {
		plan, st = o.runMessageStream(ctx, wireID, sr.ID)
		total.merge(st, plan.scanned)
	}
	if !total.deferred && !o.isRecoveryBlocked(wireID) {
		plan, st = o.runPartStream(ctx, wireID, sr.ID)
		total.merge(st, plan.scanned)
	}
	if !total.deferred && !o.isRecoveryBlocked(wireID) {
		plan, st = o.runMessageMutationStream(ctx, wireID, sr.ID)
		total.merge(st, plan.scanned)
	}
	if !total.deferred && !o.isRecoveryBlocked(wireID) {
		plan, st = o.runPartMutationStream(ctx, wireID, sr.ID)
		total.merge(st, plan.scanned)
	}
	if o.isRecoveryBlocked(wireID) {
		return total
	}
	_ = plan
	derived := deriveSessionStatus(
		o.store.QueryLastAssistantFinish(ctx, sr.ID),
		o.store.QueryLastToolStatus(ctx, sr.ID),
		sr.TimeUpdated,
	)
	_, st = o.runPage(ctx, wireID, PositionMetadata, func(sess SessionCursor) (pagePlan, error) {
		return o.planStatusPage(wireID, sess, derived)
	})
	total.merge(st, 0)
	if sr.ParentID != "" {
		_, st = o.runPage(ctx, wireID, PositionMetadata, func(sess SessionCursor) (pagePlan, error) {
			return o.planSubagentPage(ctx, sess, sr)
		})
		total.merge(st, 0)
	}
	return total
}

// runPage runs one prepare→persist→emit cycle with bounded conflict rebuilds.
func (o *Observer) runPage(ctx context.Context, wireID string, kind PositionKind,
	planPage func(sess SessionCursor) (pagePlan, error)) (pagePlan, streamStats) {
	var st streamStats
	var plan pagePlan
	conflicts := 0
	for attempt := 0; ; attempt++ {
		if ctx.Err() != nil {
			st.deferred = true
			return plan, st
		}
		snap, err := o.cursor.Snapshot()
		if err != nil {
			o.log.Warn("zcode poll: cursor snapshot", "error", err)
			st.deferred = true
			return plan, st
		}
		sess := snap.File.Sessions[wireID]
		if o.testHookPagePrep != nil {
			o.testHookPagePrep(kind)
		}
		plan, err = planPage(sess)
		if err != nil {
			if errors.Is(err, ErrPreparedPayloadMissing) || errors.Is(err, ErrLegacyPendingUnrecoverable) {
				// Typed recovery corruption: block the session (idle cadence,
				// rate-limited warning) instead of deferring into an active
				// spin or silently replacing the expected EventID set.
				o.markRecoveryBlocked(wireID, err)
				return plan, st
			}
			o.log.Warn("zcode poll: prepare page", "stream", string(kind), "error", err)
			st.deferred = true
			return plan, st
		}
		if o.journal != nil {
			var newEvents []protocol.DaemonEvent
			for i := range plan.rows {
				if plan.rows[i].isNew && len(plan.rows[i].Events) > 0 {
					newEvents = append(newEvents, plan.rows[i].Events...)
				}
			}
			if len(newEvents) > 0 {
				// The exact payloads must be durable BEFORE the cursor records
				// their pending positions. A failure here records nothing and
				// emits nothing. A conflict against a live entry can only be
				// an orphan from a failed/conflicted earlier attempt (new
				// record ids are never cursor-referenced yet): discard it and
				// retry once; recorded payloads are never replaced.
				journalSessionID := newEvents[0].SessionID
				if err := o.prepareEvents(journalSessionID, newEvents); err != nil {
					o.log.Warn("zcode poll: prepare event journal", "error", err)
					st.deferred = true
					return plan, st
				}
				for i := range plan.newRecords {
					if len(plan.newRecords[i].ExpectedEventIDs) > 0 {
						plan.newRecords[i].PayloadDurable = true
					}
				}
			}
		}
		recorded, err := o.cursor.RecordPendingBatch(PendingBatchRequest{
			WireSessionID:         wireID,
			ExpectedStateRevision: sess.StateRevision,
			Records:               plan.newRecords,
		}, time.Now().UnixMilli())
		if err == nil {
			st = o.emitPage(wireID, plan, recorded)
			st.conflicts = conflicts
			return plan, st
		}
		if errors.Is(err, ErrCursorConflict) {
			// A concurrent ACK or page changed the session: discard the stale
			// page (nothing was emitted) and rebuild from a fresh snapshot.
			conflicts++
			if attempt >= maxConflictRetries {
				st.conflicts = conflicts
				st.deferred = true
				return plan, st
			}
			continue
		}
		o.log.Warn("zcode poll: record page", "stream", string(kind), "error", err)
		st.conflicts = conflicts
		st.deferred = true
		return plan, st
	}
}

// emitPage applies canonical commits to the published projection and emits
// events in source order. Backpressure stops the page: no later event is
// emitted and the durable pending state remains retryable.
func (o *Observer) emitPage(wireID string, plan pagePlan, recorded RecordedBatch) streamStats {
	var st streamStats
	st.scanned = plan.scanned
	st.newPending = len(plan.newRecords)
	// The observer stays snapshot-driven: every planner reconstructs from the
	// durable checkpoint plus pending commits, so emission needs no projection
	// hydration here (the durable validation of these commits happens during
	// ACK advancement inside the cursor store).
	for i := range plan.rows {
		acked := stringSet(plan.rows[i].ackedIDs)
		for _, ev := range plan.rows[i].Events {
			if acked[ev.EventID] {
				continue
			}
			if !o.emitEvent(ev) {
				st.deferred = true
				return st
			}
			st.emitted++
		}
	}
	return st
}

// runMessageStream pages message inserts from the acknowledged sequence.
func (o *Observer) runMessageStream(ctx context.Context, wireID, nativeSessionID string) (pagePlan, streamStats) {
	var total streamStats
	var lastPlan pagePlan
	afterSeq := int64(-1) // -1 = derive from the snapshot's high-water
	for {
		plan, st := o.runPage(ctx, wireID, PositionMessageInsert, func(sess SessionCursor) (pagePlan, error) {
			after := sess.AckMessageSequence
			if afterSeq >= 0 {
				after = afterSeq
			}
			return o.planMessagePage(ctx, wireID, nativeSessionID, sess, after)
		})
		lastPlan = plan
		total.merge(st, plan.scanned)
		if st.deferred || !plan.hasMore {
			return lastPlan, total
		}
		afterSeq = plan.nextMsgAfter
	}
}

// runPartStream pages part inserts from the acknowledged inclusive tuple plus
// hashed native-id anchor.
func (o *Observer) runPartStream(ctx context.Context, wireID, nativeSessionID string) (pagePlan, streamStats) {
	var total streamStats
	var lastPlan pagePlan
	pageStart := (*PartCursor)(nil)
	anchorResolved := false
	for {
		plan, st := o.runPage(ctx, wireID, PositionPartInsert, func(sess SessionCursor) (pagePlan, error) {
			if !anchorResolved {
				pageStart = o.resolvePartAnchor(ctx, nativeSessionID, sess)
				anchorResolved = true
			}
			return o.planPartPage(ctx, wireID, nativeSessionID, sess, pageStart)
		})
		lastPlan = plan
		total.merge(st, plan.scanned)
		if st.deferred || !plan.hasMore {
			return lastPlan, total
		}
		pageStart = plan.nextPartAfter
	}
}

// --- page planners ----------------------------------------------------------

// planMessagePage prepares one bounded page of message inserts.
func (o *Observer) planMessagePage(ctx context.Context, wireID, nativeSessionID string, sess SessionCursor, after int64) (pagePlan, error) {
	var plan pagePlan
	mp, err := o.store.ListMessages(ctx, nativeSessionID, after, messagePageSize)
	if err != nil {
		return plan, err
	}
	plan.scanned = len(mp.Messages)
	plan.hasMore = mp.NextSequence != 0
	walk := newTimelineWalk(o.cfg.SourceID, wireID, sess)
	posIndex := indexPendingByPosition(sess.Pending)
	for _, m := range mp.Messages {
		if ctx.Err() != nil {
			return plan, ctx.Err()
		}
		if len(mp.Messages) > 0 {
			plan.nextMsgAfter = m.Sequence
		}
		pos := SourcePosition{
			Kind:            PositionMessageInsert,
			MessageSequence: m.Sequence,
			NativeIDHash:    hashID(m.ID),
		}
		data, ok := DecodeMessageData(m.DataJSON)
		if !ok {
			plan.addSkipRecord(wireID, sess, pos, "bad_json")
			continue
		}
		if !MessageVisible(data) {
			plan.addSkipRecord(wireID, sess, pos, "filtered_role")
			continue
		}
		if entry, known := posIndex[sigOf(pos)]; known {
			// Rediscovered pending position: replay exactly what was
			// prepared, never a regenerated payload.
			if entry.PayloadDurable {
				if err := o.replayDurableRow(&plan, wireID, entry); err != nil {
					return plan, err
				}
				continue
			}
			if err := walk.applyUpTo(entry.Commit.CommitOrder); err != nil {
				return plan, err
			}
			batch, err := walk.scratch.PreviewMessage(m.ID, WireMessageID(o.cfg.SourceID, m.ID), data)
			if err != nil {
				return plan, err
			}
			if !samePendingEvents(entry, batch) {
				return plan, legacyUnrecoverable(fmt.Sprintf("message at sequence %d", m.Sequence))
			}
			plan.rows = append(plan.rows, preparedRow{Pending: recFromEntry(wireID, entry), Events: batch.Events, ackedIDs: entry.AckedEventIDs})
			continue
		}
		if err := walk.applyUpTo(noOrderLimit); err != nil {
			return plan, err
		}
		batch, err := walk.scratch.PreviewMessage(m.ID, WireMessageID(o.cfg.SourceID, m.ID), data)
		if err != nil {
			return plan, err
		}
		if batch.SkipReason != "" || len(batch.Events) == 0 {
			plan.addSkipRecord(wireID, sess, pos, skipReasonFor(batch))
			continue
		}
		if plan.addPreviewRow(wireID, sess, pos, batch) {
			if err := walk.scratch.applyProvisional(batch.Commit); err != nil {
				return plan, err
			}
		}
	}
	return plan, nil
}

// prepareEvents journals a page's new payloads, replacing same-ID orphans
// left by earlier failed or conflicted preparations (their ids cannot be
// cursor-referenced: the page only submits records absent from pending).
func (o *Observer) prepareEvents(wireID string, events []protocol.DaemonEvent) error {
	err := o.journal.PrepareBatch(wireID, events)
	if err == nil || !errors.Is(err, ErrPreparedEventConflict) {
		return err
	}
	var orphans []string
	for _, ev := range events {
		existing, ok, lerr := o.journal.Load(ev.EventID)
		if lerr != nil {
			return lerr
		}
		if ok && !identicalJournalPayload(existing, ev) {
			orphans = append(orphans, ev.EventID)
		}
	}
	if len(orphans) == 0 {
		return err
	}
	o.journal.DiscardOrphans(orphans)
	return o.journal.PrepareBatch(wireID, events)
}

// loadPreparedEvents loads the exact journal payloads for a rediscovered
// durable pending entry, skipping already-acknowledged events. A referenced
// payload absent from the live journal index is a typed recovery error.
func (o *Observer) loadPreparedEvents(entry PendingPosition) ([]protocol.DaemonEvent, error) {
	acked := stringSet(entry.AckedEventIDs)
	out := make([]protocol.DaemonEvent, 0, len(entry.ExpectedEventIDs))
	for _, eid := range entry.ExpectedEventIDs {
		if acked[eid] {
			continue
		}
		payload, ok, err := o.journal.Load(eid)
		if err != nil {
			return nil, err
		}
		if !ok {
			return nil, fmt.Errorf("%w: %s", ErrPreparedPayloadMissing, eid)
		}
		out = append(out, payload)
	}
	return out, nil
}

// recFromEntry materializes the pending record mirror of a rediscovered
// pending position.
func recFromEntry(wireID string, entry PendingPosition) PendingRecord {
	return PendingRecord{
		WireSessionID:    wireID,
		Position:         entry.Position,
		ExpectedEventIDs: entry.ExpectedEventIDs,
		SkippedReason:    entry.SkippedReason,
		Commit:           entry.Commit,
		PayloadDurable:   entry.PayloadDurable,
	}
}

// replayDurableRow appends the exact journal payload replay of a durable
// pending entry (re-emitting only unacknowledged events).
func (o *Observer) replayDurableRow(plan *pagePlan, wireID string, entry PendingPosition) error {
	payloads, err := o.loadPreparedEvents(entry)
	if err != nil {
		return err
	}
	plan.rows = append(plan.rows, preparedRow{Pending: recFromEntry(wireID, entry), Events: payloads, ackedIDs: entry.AckedEventIDs})
	return nil
}

// legacyUnrecoverable builds the typed error for a journal-less pending entry
// whose regenerated EventID set no longer matches the source.
func legacyUnrecoverable(what string) error {
	return fmt.Errorf("%w: %s", ErrLegacyPendingUnrecoverable, what)
}

// skipReasonFor normalizes a preview that produced no event into a stable
// durable skip reason.
func skipReasonFor(batch DiffBatch) string {
	if batch.SkipReason != "" {
		return batch.SkipReason
	}
	return "no_event"
}

// planPartPage prepares one bounded page of part inserts.
func (o *Observer) planPartPage(ctx context.Context, wireID, nativeSessionID string, sess SessionCursor, after *PartCursor) (pagePlan, error) {
	var plan pagePlan
	pp, err := o.store.ListParts(ctx, nativeSessionID, after, partPageSize)
	if err != nil {
		return plan, err
	}
	plan.scanned = len(pp.Parts)
	plan.hasMore = pp.NextCursor != nil
	walk := newTimelineWalk(o.cfg.SourceID, wireID, sess)
	posIndex := indexPendingByPosition(sess.Pending)
	for _, p := range pp.Parts {
		if ctx.Err() != nil {
			return plan, ctx.Err()
		}
		plan.nextPartAfter = &PartCursor{MessageSequence: p.MessageSequence, PartSequence: p.Sequence, PartID: p.ID}
		pos := SourcePosition{
			Kind:           PositionPartInsert,
			PartMessageSeq: p.MessageSequence,
			PartSequence:   p.Sequence,
			NativeIDHash:   hashID(p.ID),
		}
		part, ok := DecodePartData(p.DataJSON)
		if !ok {
			plan.addSkipRecord(wireID, sess, pos, "bad_json")
			continue
		}
		if entry, known := posIndex[sigOf(pos)]; known {
			// Rediscovered pending position: replay exactly what was prepared.
			if entry.PayloadDurable {
				if err := o.replayDurableRow(&plan, wireID, entry); err != nil {
					return plan, err
				}
				continue
			}
			if err := walk.applyUpTo(entry.Commit.CommitOrder); err != nil {
				return plan, err
			}
			batch, err := walk.scratch.PreviewPart(p.ID, WireMessageID(o.cfg.SourceID, p.MessageID), part, "")
			if err != nil {
				return plan, err
			}
			if !samePendingEvents(entry, batch) {
				return plan, legacyUnrecoverable(fmt.Sprintf("part %s at (%d,%d)", hashID(p.ID), p.MessageSequence, p.Sequence))
			}
			plan.rows = append(plan.rows, preparedRow{Pending: recFromEntry(wireID, entry), Events: batch.Events, ackedIDs: entry.AckedEventIDs})
			continue
		}
		if err := walk.applyUpTo(noOrderLimit); err != nil {
			return plan, err
		}
		batch, err := walk.scratch.PreviewPart(p.ID, WireMessageID(o.cfg.SourceID, p.MessageID), part, "")
		if err != nil {
			return plan, err
		}
		if plan.addPreviewRow(wireID, sess, pos, batch) {
			if err := walk.scratch.applyProvisional(batch.Commit); err != nil {
				return plan, err
			}
		}
	}
	return plan, nil
}

// planMetaPage prepares the session_discovered / title / model page. Pending
// metadata entries are regenerated from the projection state immediately
// preceding their commit so unacked events are re-emitted with stable ids.
func (o *Observer) planMetaPage(wireID string, sess SessionCursor, sr SessionRow) (pagePlan, error) {
	var plan pagePlan
	pos := SourcePosition{Kind: PositionMetadata, NativeIDHash: hashID(wireID)}
	walk := newTimelineWalk(o.cfg.SourceID, wireID, sess)
	for _, entry := range pendingMetadataEntries(sess.Pending, hashID(wireID)) {
		if entry.Commit.Title == nil && entry.Commit.Model == nil {
			continue // status-only entries regenerate via the status page
		}
		if entry.PayloadDurable {
			if err := o.replayDurableRow(&plan, wireID, entry); err != nil {
				return plan, err
			}
			continue
		}
		if err := walk.applyUpTo(entry.Commit.CommitOrder); err != nil {
			return plan, err
		}
		batch, err := walk.scratch.PreviewSessionMeta(sr.Title, "", initialStatus)
		if err != nil {
			return plan, err
		}
		if samePendingEvents(entry, batch) {
			plan.rows = append(plan.rows, preparedRow{
				Pending:  recFromEntry(wireID, entry),
				Events:   batch.Events,
				ackedIDs: entry.AckedEventIDs,
			})
			continue
		}
		return plan, legacyUnrecoverable("session metadata pending entry")
	}
	if err := walk.applyUpTo(noOrderLimit); err != nil {
		return plan, err
	}
	batch, err := walk.scratch.PreviewSessionMeta(sr.Title, "", initialStatus)
	if err != nil {
		return plan, err
	}
	if len(batch.Events) > 0 {
		plan.addPreviewRow(wireID, sess, pos, batch)
	}
	return plan, nil
}

// planStatusPage prepares the derived session_status page.
func (o *Observer) planStatusPage(wireID string, sess SessionCursor, derived string) (pagePlan, error) {
	var plan pagePlan
	pos := SourcePosition{Kind: PositionMetadata, NativeIDHash: hashID(wireID)}
	walk := newTimelineWalk(o.cfg.SourceID, wireID, sess)
	for _, entry := range pendingMetadataEntries(sess.Pending, hashID(wireID)) {
		if entry.Commit.Title != nil || entry.Commit.Model != nil || entry.Commit.SubagentEventID != "" {
			continue // discovered/title/model entries regenerate via the meta page
		}
		if entry.PayloadDurable {
			if err := o.replayDurableRow(&plan, wireID, entry); err != nil {
				return plan, err
			}
			continue
		}
		if err := walk.applyUpTo(entry.Commit.CommitOrder); err != nil {
			return plan, err
		}
		batch, err := walk.scratch.PreviewStatus(derived)
		if err != nil {
			return plan, err
		}
		if !samePendingEvents(entry, batch) {
			return plan, legacyUnrecoverable("session status pending entry")
		}
		plan.rows = append(plan.rows, preparedRow{
			Pending:  recFromEntry(wireID, entry),
			Events:   batch.Events,
			ackedIDs: entry.AckedEventIDs,
		})
	}
	if err := walk.applyUpTo(noOrderLimit); err != nil {
		return plan, err
	}
	batch, err := walk.scratch.PreviewStatus(derived)
	if err != nil {
		return plan, err
	}
	if len(batch.Events) > 0 {
		plan.addPreviewRow(wireID, sess, pos, batch)
	}
	return plan, nil
}

// planSubagentPage prepares a subagent_discovered event linking a child
// session to its parent. Like the legacy emitter it re-emits every poll:
// the event identity is stable and Relay reconciles idempotently.
func (o *Observer) planSubagentPage(ctx context.Context, sess SessionCursor, sr SessionRow) (pagePlan, error) {
	var plan pagePlan
	wireChildID := WireSessionID(o.cfg.SourceID, sr.ID)
	wireParentID := WireSessionID(o.cfg.SourceID, sr.ParentID)
	agentType := ""
	if mp, err := o.store.ListMessages(ctx, sr.ID, 0, 1); err == nil && len(mp.Messages) > 0 {
		if data, ok := DecodeMessageData(mp.Messages[0].DataJSON); ok {
			agentType = data.Agent
		}
	}
	ev := NewMapper(o.cfg.SourceID).SubagentDiscovered(wireParentID, wireChildID, agentType, sr.Title, "")
	if sess.Sync.SubagentEventID == ev.EventID {
		return plan, nil
	}
	pos := SourcePosition{Kind: PositionMetadata, NativeIDHash: hashID(wireChildID)}
	rec := PendingRecord{
		WireSessionID:    wireChildID,
		Position:         pos,
		ExpectedEventIDs: []string{ev.EventID},
		Commit:           SyncCommit{SubagentEventID: ev.EventID},
	}
	if existing, ok := sess.Pending[pendingKey(rec)]; ok {
		if existing.PayloadDurable {
			if err := o.replayDurableRow(&plan, wireChildID, existing); err != nil {
				return plan, err
			}
			return plan, nil
		}
		plan.rows = append(plan.rows, preparedRow{Pending: rec, Events: []protocol.DaemonEvent{ev}, ackedIDs: existing.AckedEventIDs})
		return plan, nil
	}
	plan.rows = append(plan.rows, preparedRow{Pending: rec, Events: []protocol.DaemonEvent{ev}, isNew: true})
	plan.newRecords = append(plan.newRecords, rec)
	return plan, nil
}

// resolvePartAnchor locates the acknowledged part row by numeric tuple and
// hashed id within a bounded equality set and resumes strictly after its raw
// tuple. If the anchor row disappeared, it replays conservatively from the
// numeric tuple boundary: unchanged rows merge without duplicate emission.
// The resolved raw id is never persisted.
func (o *Observer) resolvePartAnchor(ctx context.Context, nativeSessionID string, sess SessionCursor) *PartCursor {
	if sess.AckPartMessageSeq == 0 && sess.AckPartSequence == 0 && sess.AckPartIDHash == "" {
		return nil
	}
	tuple := &PartCursor{MessageSequence: sess.AckPartMessageSeq, PartSequence: sess.AckPartSequence}
	page, err := o.store.ListParts(ctx, nativeSessionID, tuple, partPageSize)
	if err != nil {
		o.log.Warn("zcode poll: resolve part anchor", "error", err)
		return tuple
	}
	for _, p := range page.Parts {
		if p.MessageSequence != sess.AckPartMessageSeq || p.Sequence != sess.AckPartSequence {
			break // ran past the equality set
		}
		if hashID(p.ID) == sess.AckPartIDHash {
			return &PartCursor{MessageSequence: p.MessageSequence, PartSequence: p.Sequence, PartID: p.ID}
		}
	}
	return tuple
}

// --- page plan helpers ------------------------------------------------------

// addPreviewRow records one previewed row. Returns true when the row is new
// (its provisional commit must chain the scratch state).
func (p *pagePlan) addPreviewRow(wireID string, sess SessionCursor, pos SourcePosition, batch DiffBatch) bool {
	rec := PendingRecord{
		WireSessionID:    wireID,
		Position:         pos,
		ExpectedEventIDs: eventIDs(batch.Events),
		SkippedReason:    batch.SkipReason,
		Commit:           batch.Commit,
	}
	if existing, ok := sess.Pending[pendingKey(rec)]; ok {
		// Rediscovered pending position: keep its ACK set, re-emit unacked.
		p.rows = append(p.rows, preparedRow{Pending: rec, Events: batch.Events, ackedIDs: existing.AckedEventIDs})
		return false
	}
	p.rows = append(p.rows, preparedRow{Pending: rec, Events: batch.Events, isNew: true})
	p.newRecords = append(p.newRecords, rec)
	return true
}

// addSkipRecord durably records a positioned row that produced no event so
// the stream high-water can advance past it once its prefix completes.
func (p *pagePlan) addSkipRecord(wireID string, sess SessionCursor, pos SourcePosition, reason string) {
	rec := PendingRecord{WireSessionID: wireID, Position: pos, SkippedReason: reason}
	if _, ok := sess.Pending[pendingKey(rec)]; ok {
		return // skip already durable behind an earlier unacked row
	}
	p.newRecords = append(p.newRecords, rec)
}

func (s *streamStats) merge(st streamStats, scanned int) {
	s.scanned += scanned
	s.newPending += st.newPending
	s.emitted += st.emitted
	s.deferred = s.deferred || st.deferred
	s.conflicts += st.conflicts
}

func eventIDs(events []protocol.DaemonEvent) []string {
	ids := make([]string, 0, len(events))
	for _, ev := range events {
		ids = append(ids, ev.EventID)
	}
	return ids
}

func stringSet(xs []string) map[string]bool {
	set := make(map[string]bool, len(xs))
	for _, x := range xs {
		set[x] = true
	}
	return set
}

func samePendingEvents(entry PendingPosition, batch DiffBatch) bool {
	return entry.SkippedReason == batch.SkipReason &&
		len(entry.ExpectedEventIDs) == len(batch.Events) &&
		sameStringSet(entry.ExpectedEventIDs, eventIDs(batch.Events))
}

// --- timeline walk ----------------------------------------------------------

const noOrderLimit = math.MaxUint64

// timelineWalk replays pending commits onto a scratch projection in commit
// order. A rediscovered row previews against the state immediately preceding
// its own commit; a new row previews against the full speculative state.
type timelineWalk struct {
	scratch  *ZcodeSync
	timeline []PendingPosition
	next     int
}

func newTimelineWalk(sourceID, wireID string, sess SessionCursor) *timelineWalk {
	entries := make([]PendingPosition, 0, len(sess.Pending))
	for _, pp := range sess.Pending {
		if pp.Commit.CommitOrder > 0 {
			entries = append(entries, pp)
		}
	}
	sort.Slice(entries, func(i, j int) bool {
		return entries[i].Commit.CommitOrder < entries[j].Commit.CommitOrder
	})
	// The scratch starts from the DURABLE checkpoint only: pending commits are
	// replayed by applyUpTo so a rediscovered row previews against the state
	// immediately preceding its own commit. (emitPage separately hydrates the
	// full speculative projection for publication.)
	scratch, err := NewZcodeSyncFromCheckpoint(sourceID, wireID, sess.Sync)
	if err != nil {
		scratch = NewZcodeSync(sourceID, wireID)
	}
	return &timelineWalk{scratch: scratch, timeline: entries}
}

// applyUpTo applies pending commits with order < limit to the scratch state.
// A commit-application conflict propagates: the page fails closed instead of
// silently building on a contradictory projection.
func (w *timelineWalk) applyUpTo(limit uint64) error {
	for ; w.next < len(w.timeline); w.next++ {
		commit := w.timeline[w.next].Commit
		if limit != noOrderLimit && commit.CommitOrder >= limit {
			break
		}
		if err := w.scratch.applyCommit(commit); err != nil {
			return err
		}
	}
	return nil
}

// --- pending position lookup ------------------------------------------------

type positionSig struct {
	kind       PositionKind
	msgSeq     int64
	partMsgSeq int64
	partSeq    int64
	mutationMs int64
	idHash     string
}

func sigOf(pos SourcePosition) positionSig {
	return positionSig{
		kind:       pos.Kind,
		msgSeq:     pos.MessageSequence,
		partMsgSeq: pos.PartMessageSeq,
		partSeq:    pos.PartSequence,
		mutationMs: pos.MutationTime,
		idHash:     pos.NativeIDHash,
	}
}

// indexPendingByPosition maps each source position to its earliest pending
// entry (insert positions are unique per row).
func indexPendingByPosition(pending map[string]PendingPosition) map[positionSig]PendingPosition {
	out := make(map[positionSig]PendingPosition, len(pending))
	for _, pp := range pending {
		sig := sigOf(pp.Position)
		if existing, ok := out[sig]; !ok || pp.Position.Order < existing.Position.Order {
			out[sig] = pp
		}
	}
	return out
}

// pendingMetadataEntries returns the pending metadata entries for one
// native-id hash, in stream order.
func pendingMetadataEntries(pending map[string]PendingPosition, idHash string) []PendingPosition {
	var out []PendingPosition
	for _, pp := range pending {
		if pp.Position.Kind == PositionMetadata && pp.Position.NativeIDHash == idHash {
			out = append(out, pp)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].Position.Order < out[j].Position.Order
	})
	return out
}

// --- mutation streams -------------------------------------------------------

// mutationOverlap is the lookback applied to the acknowledged mutation time at
// the start of every stream poll, so rows whose timestamps land slightly before
// an ACK boundary are still observed. The transient raw (time_updated, id)
// cursor pages through the FULL overlap window within one poll and is never
// persisted.
const mutationOverlap = 2 * time.Second

// ErrMutationStall reports a mutation page whose last tuple did not strictly
// advance the transient keyset cursor — paging would loop forever.
var ErrMutationStall = errors.New("zcode mutation page did not advance")

// advanceTransientCursor validates that the next page tuple is strictly greater
// than the previous one and returns it as the new query tuple.
func advanceTransientCursor(prev, next MutationCursor) (MutationCursor, error) {
	if next.TimeUpdated < prev.TimeUpdated ||
		(next.TimeUpdated == prev.TimeUpdated && next.ID <= prev.ID) {
		return prev, fmt.Errorf("%w: (%d,%s) after (%d,%s)",
			ErrMutationStall, next.TimeUpdated, next.ID, prev.TimeUpdated, prev.ID)
	}
	return next, nil
}

// mutationOverlapStart returns the window start for one stream poll.
func mutationOverlapStart(ackMutationTime int64) int64 {
	start := ackMutationTime - mutationOverlap.Milliseconds()
	if start < 0 {
		return 0
	}
	return start
}

// mutationCandidate reports whether a row inside the queried window represents
// work: strictly beyond the acknowledged time, or at the acknowledged time and
// beyond the resolved raw anchor row. Rows at time 0 are pre-baseline (no
// mutation has ever been acknowledged, so the insert streams own them). A
// missing anchor is conservative: every row at the acknowledged time is a
// candidate.
//
// Both mutation streams treat rows timestamped inside the overlap window
// BELOW the acknowledged time as candidates: per-message and per-part
// semantic checkpoints make unchanged rows a pure scan with no pending and
// no emission, so the full two-second overlap is honored without duplicate
// work.
func mutationCandidate(rowTime int64, rowRawID string, ackTime int64, anchorRawID string, includeOverlap bool) bool {
	if rowTime > ackTime {
		return true
	}
	if rowTime < ackTime {
		return includeOverlap
	}
	if ackTime == 0 {
		return false
	}
	return anchorRawID == "" || rowRawID > anchorRawID
}

// runMessageMutationStream exhausts the message mutation overlap window with a
// transient raw (time_updated, id) keyset cursor.
func (o *Observer) runMessageMutationStream(ctx context.Context, wireID, nativeSessionID string) (pagePlan, streamStats) {
	var total streamStats
	var lastPlan pagePlan
	cursor := MutationCursor{} // resolved on the first page from the snapshot
	resolved := false
	for {
		plan, st := o.runPage(ctx, wireID, PositionMessageMutation, func(sess SessionCursor) (pagePlan, error) {
			if !resolved {
				cursor = MutationCursor{TimeUpdated: mutationOverlapStart(sess.AckMessageMutationTime)}
				resolved = true
			}
			return o.planMessageMutationPage(ctx, wireID, nativeSessionID, sess, cursor)
		})
		lastPlan = plan
		total.merge(st, plan.scanned)
		if st.deferred || !plan.hasMore {
			return lastPlan, total
		}
		cursor = plan.nextMutation
	}
}

// runPartMutationStream exhausts the part mutation overlap window the same way.
func (o *Observer) runPartMutationStream(ctx context.Context, wireID, nativeSessionID string) (pagePlan, streamStats) {
	var total streamStats
	var lastPlan pagePlan
	cursor := MutationCursor{}
	resolved := false
	for {
		plan, st := o.runPage(ctx, wireID, PositionPartMutation, func(sess SessionCursor) (pagePlan, error) {
			if !resolved {
				cursor = MutationCursor{TimeUpdated: mutationOverlapStart(sess.AckPartMutationTime)}
				resolved = true
			}
			return o.planPartMutationPage(ctx, wireID, nativeSessionID, sess, cursor)
		})
		lastPlan = plan
		total.merge(st, plan.scanned)
		if st.deferred || !plan.hasMore {
			return lastPlan, total
		}
		cursor = plan.nextMutation
	}
}

// planMessageMutationPage prepares one bounded page of message mutations.
func (o *Observer) planMessageMutationPage(ctx context.Context, wireID, nativeSessionID string, sess SessionCursor, cursor MutationCursor) (pagePlan, error) {
	var plan pagePlan
	anchor := o.resolveMessageMutationAnchor(ctx, nativeSessionID, sess)
	mp, err := o.store.ListChangedMessages(ctx, nativeSessionID, cursor, messagePageSize)
	if err != nil {
		return plan, err
	}
	plan.scanned = len(mp.Messages)
	plan.hasMore = len(mp.Messages) >= messagePageSize
	walk := newTimelineWalk(o.cfg.SourceID, wireID, sess)
	posIndex := indexPendingByPosition(sess.Pending)
	for _, m := range mp.Messages {
		if ctx.Err() != nil {
			return plan, ctx.Err()
		}
		next := MutationCursor{TimeUpdated: m.TimeUpdated, ID: m.ID}
		if _, err := advanceTransientCursor(cursor, next); err != nil {
			return plan, err
		}
		cursor = next
		plan.nextMutation = next
		if !mutationCandidate(m.TimeUpdated, m.ID, sess.AckMessageMutationTime, anchor, true) {
			continue // already represented behind the acknowledged anchor
		}
		pos := SourcePosition{
			Kind:            PositionMessageMutation,
			MessageSequence: m.Sequence,
			MutationTime:    m.TimeUpdated,
			NativeIDHash:    hashID(m.ID),
		}
		data, ok := DecodeMessageData(m.DataJSON)
		if !ok {
			if m.TimeUpdated < sess.AckMessageMutationTime {
				continue
			}
			plan.addSkipRecord(wireID, sess, pos, "bad_json")
			continue
		}
		if !MessageVisible(data) {
			if m.TimeUpdated < sess.AckMessageMutationTime {
				continue
			}
			plan.addSkipRecord(wireID, sess, pos, "filtered_role")
			continue
		}
		if entry, known := posIndex[sigOf(pos)]; known {
			if entry.PayloadDurable {
				// Replay the exact prepared payload; a row whose content
				// advanced since chains a new generation after it.
				if err := o.replayDurableRow(&plan, wireID, entry); err != nil {
					return plan, err
				}
				if err := walk.applyUpTo(noOrderLimit); err != nil {
					return plan, err
				}
				batch, err := walk.scratch.PreviewMessage(m.ID, WireMessageID(o.cfg.SourceID, m.ID), data)
				if err != nil {
					return plan, err
				}
				if len(batch.Events) > 0 {
					if plan.addPreviewRow(wireID, sess, pos, batch) {
						if err := walk.scratch.applyProvisional(batch.Commit); err != nil {
							return plan, err
						}
					}
				}
				continue
			}
			// Legacy journal-less entry: regenerate and require exact
			// EventID agreement; a mismatch blocks the session instead of
			// creating a generation behind the gap.
			if err := walk.applyUpTo(entry.Commit.CommitOrder); err != nil {
				return plan, err
			}
			batch, err := walk.scratch.PreviewMessage(m.ID, WireMessageID(o.cfg.SourceID, m.ID), data)
			if err != nil {
				return plan, err
			}
			if !samePendingEvents(entry, batch) {
				return plan, legacyUnrecoverable(fmt.Sprintf("message mutation at %d", m.TimeUpdated))
			}
			plan.rows = append(plan.rows, preparedRow{Pending: recFromEntry(wireID, entry), Events: batch.Events, ackedIDs: entry.AckedEventIDs})
			continue
		}
		if err := walk.applyUpTo(noOrderLimit); err != nil {
			return plan, err
		}
		batch, err := walk.scratch.PreviewMessage(m.ID, WireMessageID(o.cfg.SourceID, m.ID), data)
		if err != nil {
			return plan, err
		}
		if batch.SkipReason == "skip" {
			// Unchanged content inside the overlap window: scanned only, no
			// pending entry, no high-water change (§2.7).
			continue
		}
		if len(batch.Events) == 0 {
			if m.TimeUpdated < sess.AckMessageMutationTime {
				continue
			}
			// Visible message with no mappable content: a durable skip moves
			// the mutation high-water past the row.
			plan.addSkipRecord(wireID, sess, pos, skipReasonFor(batch))
			continue
		}
		if plan.addPreviewRow(wireID, sess, pos, batch) {
			if err := walk.scratch.applyProvisional(batch.Commit); err != nil {
				return plan, err
			}
		}
	}
	return plan, nil
}

// planPartMutationPage prepares one bounded page of part mutations.
func (o *Observer) planPartMutationPage(ctx context.Context, wireID, nativeSessionID string, sess SessionCursor, cursor MutationCursor) (pagePlan, error) {
	var plan pagePlan
	anchor := o.resolvePartMutationAnchor(ctx, nativeSessionID, sess)
	pp, err := o.store.ListChangedParts(ctx, nativeSessionID, cursor, partPageSize)
	if err != nil {
		return plan, err
	}
	plan.scanned = len(pp.Parts)
	plan.hasMore = len(pp.Parts) >= partPageSize
	walk := newTimelineWalk(o.cfg.SourceID, wireID, sess)
	posIndex := indexPendingByPosition(sess.Pending)
	for _, p := range pp.Parts {
		if ctx.Err() != nil {
			return plan, ctx.Err()
		}
		next := MutationCursor{TimeUpdated: p.TimeUpdated, ID: p.ID}
		if _, err := advanceTransientCursor(cursor, next); err != nil {
			return plan, err
		}
		cursor = next
		plan.nextMutation = next
		if !mutationCandidate(p.TimeUpdated, p.ID, sess.AckPartMutationTime, anchor, true) {
			continue
		}
		pos := SourcePosition{
			Kind:           PositionPartMutation,
			PartMessageSeq: p.MessageSequence,
			PartSequence:   p.Sequence,
			MutationTime:   p.TimeUpdated,
			NativeIDHash:   hashID(p.ID),
		}
		part, ok := DecodePartData(p.DataJSON)
		if !ok {
			if p.TimeUpdated < sess.AckPartMutationTime {
				continue
			}
			plan.addSkipRecord(wireID, sess, pos, "bad_json")
			continue
		}
		if entry, known := posIndex[sigOf(pos)]; known {
			if entry.PayloadDurable {
				// Replay the exact prepared payload; a row whose content
				// advanced since chains a new generation after it.
				if err := o.replayDurableRow(&plan, wireID, entry); err != nil {
					return plan, err
				}
				if err := walk.applyUpTo(noOrderLimit); err != nil {
					return plan, err
				}
				batch, err := walk.scratch.PreviewPart(p.ID, WireMessageID(o.cfg.SourceID, p.MessageID), part, "")
				if err != nil {
					return plan, err
				}
				if len(batch.Events) > 0 && batch.SkipReason == "" {
					if plan.addPreviewRow(wireID, sess, pos, batch) {
						if err := walk.scratch.applyProvisional(batch.Commit); err != nil {
							return plan, err
						}
					}
				}
				continue
			}
			// Legacy journal-less entry: regenerate and require exact
			// EventID agreement.
			if err := walk.applyUpTo(entry.Commit.CommitOrder); err != nil {
				return plan, err
			}
			batch, err := walk.scratch.PreviewPart(p.ID, WireMessageID(o.cfg.SourceID, p.MessageID), part, "")
			if err != nil {
				return plan, err
			}
			if !samePendingEvents(entry, batch) {
				return plan, legacyUnrecoverable(fmt.Sprintf("part mutation at %d", p.TimeUpdated))
			}
			plan.rows = append(plan.rows, preparedRow{Pending: recFromEntry(wireID, entry), Events: batch.Events, ackedIDs: entry.AckedEventIDs})
			continue
		}
		if err := walk.applyUpTo(noOrderLimit); err != nil {
			return plan, err
		}
		batch, err := walk.scratch.PreviewPart(p.ID, WireMessageID(o.cfg.SourceID, p.MessageID), part, "")
		if err != nil {
			return plan, err
		}
		if batch.SkipReason == "skip" {
			// Unchanged content inside the overlap window: scanned only, no
			// pending entry, no high-water change (§2.7).
			continue
		}
		if len(batch.Events) == 0 && p.TimeUpdated < sess.AckPartMutationTime {
			continue
		}
		if plan.addPreviewRow(wireID, sess, pos, batch) {
			if err := walk.scratch.applyProvisional(batch.Commit); err != nil {
				return plan, err
			}
		}
	}
	return plan, nil
}

// resolveMessageMutationAnchor locates the acknowledged message row at the
// acknowledged mutation timestamp by hash within the bounded equality set and
// returns its raw id. The resolved raw id is used only inside this poll.
func (o *Observer) resolveMessageMutationAnchor(ctx context.Context, nativeSessionID string, sess SessionCursor) string {
	if sess.AckMessageMutationTime <= 0 || sess.AckMessageMutationIDHash == "" {
		return ""
	}
	page, err := o.store.ListChangedMessages(ctx, nativeSessionID, MutationCursor{
		TimeUpdated: sess.AckMessageMutationTime,
	}, messagePageSize)
	if err != nil {
		o.log.Warn("zcode poll: resolve message mutation anchor", "error", err)
		return ""
	}
	for _, m := range page.Messages {
		if m.TimeUpdated != sess.AckMessageMutationTime {
			break // ran past the equality set
		}
		if hashID(m.ID) == sess.AckMessageMutationIDHash {
			return m.ID
		}
	}
	return "" // anchor row disappeared: replay conservatively
}

// resolvePartMutationAnchor locates the acknowledged part row the same way.
func (o *Observer) resolvePartMutationAnchor(ctx context.Context, nativeSessionID string, sess SessionCursor) string {
	if sess.AckPartMutationTime <= 0 || sess.AckPartMutationIDHash == "" {
		return ""
	}
	page, err := o.store.ListChangedParts(ctx, nativeSessionID, MutationCursor{
		TimeUpdated: sess.AckPartMutationTime,
	}, partPageSize)
	if err != nil {
		o.log.Warn("zcode poll: resolve part mutation anchor", "error", err)
		return ""
	}
	for _, p := range page.Parts {
		if p.TimeUpdated != sess.AckPartMutationTime {
			break
		}
		if hashID(p.ID) == sess.AckPartMutationIDHash {
			return p.ID
		}
	}
	return ""
}

// pendingKeyForBatch derives the pending key for a previewed record without
// materializing it twice.
func pendingKeyForBatch(wireID string, pos SourcePosition, batch DiffBatch) string {
	return pendingKey(PendingRecord{
		WireSessionID:    wireID,
		Position:         pos,
		ExpectedEventIDs: eventIDs(batch.Events),
		SkippedReason:    batch.SkipReason,
		Commit:           batch.Commit,
	})
}
