import type pg from 'pg'
import { canonicalPayloadHash } from '../inbox/canonical-json.js'
import { classifyArtifact } from '../projection/artifact-classifier.js'

/**
 * SQL rendering of the frozen canonical-event-key priority chain, identical
 * to extractCanonicalEventKey in projection/event-identity.ts (event_id →
 * message/part/revision → call/event_type). One template shared by every
 * query that needs the key, so the expression can never drift between
 * callers; an integration test pins it against the TypeScript extractor.
 * jsonb_typeof guards keep non-string field values out (TS requires
 * typeof string); the one residual divergence is exponent-range numeric
 * revisions (jsonb prints them plain, JS as 1e+21), documented here and
 * deliberately not covered by the parity corpus.
 */
function canonicalEventKeySql(jsonb: string): string {
  return `(CASE
    WHEN jsonb_typeof(${jsonb}->'event_id') = 'string' AND ${jsonb}->>'event_id' <> ''
      THEN 'event_id:' || (${jsonb}->>'event_id')
    WHEN jsonb_typeof(${jsonb}->'message_id') = 'string' AND ${jsonb}->>'message_id' <> ''
      AND jsonb_typeof(${jsonb}->'part_id') = 'string' AND ${jsonb}->>'part_id' <> ''
      AND (jsonb_typeof(${jsonb}->'revision') = 'number'
        OR (jsonb_typeof(${jsonb}->'revision') = 'string' AND ${jsonb}->>'revision' <> ''))
      THEN 'message:' || (${jsonb}->>'message_id') || ':' || (${jsonb}->>'part_id') || ':' || (${jsonb}->>'revision')
    WHEN jsonb_typeof(${jsonb}->'call_id') = 'string' AND ${jsonb}->>'call_id' <> ''
      AND jsonb_typeof(${jsonb}->'event_type') = 'string' AND ${jsonb}->>'event_type' <> ''
      THEN 'call:' || (${jsonb}->>'call_id') || ':' || (${jsonb}->>'event_type')
    ELSE NULL
  END)`
}

/**
 * Snapshot run state: one authoritative generation at a time per
 * installation. Rows land durably in memory_snapshot_events before any
 * projection happens; a failed generation never deletes prior projections.
 */
export function createSnapshotRepository(pool: pg.Pool) {
  return {
    async pendingAcknowledgement(installationId: string): Promise<{
      generation: number
      sessionsSeen: number
      eventsSeen: number
    } | null> {
      const result = await pool.query<{
        generation: string
        sessions_seen: string
        events_seen: string
      }>(`
        SELECT generation::text, sessions_seen::text, events_seen::text
        FROM memory_snapshot_runs
        WHERE installation_id = $1 AND state = 'completed' AND relay_acked_at IS NULL
        ORDER BY generation DESC
        LIMIT 1
      `, [installationId])
      const row = result.rows[0]
      return row ? {
        generation: Number(row.generation),
        sessionsSeen: Number(row.sessions_seen),
        eventsSeen: Number(row.events_seen),
      } : null
    },

    async markAcknowledged(installationId: string, generation: number): Promise<void> {
      await pool.query(`
        UPDATE memory_snapshot_runs SET relay_acked_at = NOW()
        WHERE installation_id = $1 AND generation = $2 AND state = 'completed'
      `, [installationId, generation])
    },

    /**
     * Start (or observe) the next generation. Only one running generation
     * per installation is allowed — enforced by the v5 partial unique index,
     * so a concurrent reconcile fails here and retries via the job ladder.
     * A run whose worker died mid-reconcile (no failRun ever committed) is
     * expired first: the 30-minute threshold sits below the retry ladder's
     * ~36-minute dead-letter point (attempts 11-12 fire at ~31-36 min), so a
     * hard kill of a run started in the ladder's first ~6 minutes unwedges
     * on a later attempt instead of dead-lettering with the never-freed
     * snapshot idempotency key — a run started later than that whose worker
     * dies still wedges until the dead-letter row is cleared, because no
     * remaining attempt sees 30 minutes of row age. A live reconcile is
     * protected by its lease renewal (the job never resets to pending while
     * its worker keeps renewing). Residual theoretical gap: pool starvation
     * could delay the renewal query past several lease windows while the
     * handler still progresses, stealing the run row of a >30-minute live
     * reconcile; both generations then rebuild with last-finalize-wins and
     * bounded, self-healing damage.
     */
    async startRun(installationId: string): Promise<{ runId: string; generation: number }> {
      await pool.query(`
        UPDATE memory_snapshot_runs
        SET state = 'failed', error_code = 'stale_running', completed_at = NOW()
        WHERE installation_id = $1 AND state = 'running'
          AND started_at < NOW() - INTERVAL '30 minutes'
      `, [installationId])
      const result = await pool.query<{ run_id: string; generation: string }>(`
        WITH next AS (
          SELECT COALESCE(MAX(generation), 0) + 1 AS generation
          FROM memory_snapshot_runs WHERE installation_id = $1
        )
        INSERT INTO memory_snapshot_runs (run_id, installation_id, generation, state)
        SELECT gen_random_uuid(), $1, next.generation, 'running' FROM next
        RETURNING run_id, generation::text
      `, [installationId])
      return {
        runId: result.rows[0].run_id,
        generation: Number(result.rows[0].generation),
      }
    },

    async failRun(installationId: string, generation: number, errorCode: string): Promise<void> {
      await pool.query(`
        UPDATE memory_snapshot_runs
        SET state = 'failed', error_code = $3, completed_at = NOW()
        WHERE installation_id = $1 AND generation = $2
      `, [installationId, generation, errorCode])
    },

    /** Durable event landing with an integrity fence on the relay event id. */
    async persistSessionEvents(
      installationId: string,
      generation: number,
      sessionId: string,
      events: Array<Record<string, unknown>>,
    ): Promise<number> {
      if (events.length === 0) return 0
      const incoming = new Map<string, Buffer>()
      for (const event of events) {
        incoming.set(decimalEventId(event.event_id), canonicalPayloadHash(event))
      }
      const existing = await pool.query<{ relay_event_id: string; payload_hash: Buffer }>(`
        SELECT relay_event_id::text, payload_hash FROM memory_snapshot_events
        WHERE installation_id = $1 AND session_id = $2 AND relay_event_id = ANY($3::bigint[])
      `, [installationId, sessionId, [...incoming.keys()]])
      for (const row of existing.rows) {
        const next = incoming.get(row.relay_event_id)
        if (next && !next.equals(row.payload_hash)) {
          throw new Error(`snapshot integrity violation on relay event ${row.relay_event_id}`)
        }
      }
      for (const event of events) {
        const eventId = decimalEventId(event.event_id)
        // The relay-side timestamp drives ordering and turn timelines on
        // rebuild; landing time alone would reorder same-page events by
        // fetch time instead of occurrence.
        const occurredMs = Date.parse(String(event.created_at ?? ''))
        if (!Number.isFinite(occurredMs)) {
          throw new Error(`malformed snapshot event timestamp on relay event ${event.event_id}`)
        }
        await pool.query(`
          INSERT INTO memory_snapshot_events
            (installation_id, session_id, relay_event_id, event_type, payload,
             payload_hash, created_at, occurred_at, generation)
          VALUES ($1, $2, $3, $4, $5::jsonb, $6, NOW(), $7, $8)
          ON CONFLICT (installation_id, session_id, relay_event_id) DO NOTHING
        `, [
          installationId, sessionId, eventId,
          typeof event.event_type === 'string' ? event.event_type : 'unknown',
          JSON.stringify(event.payload ?? {}), incoming.get(eventId),
          new Date(occurredMs), generation,
        ])
      }
      return events.length
    },

    /**
     * Authoritative finalize in ONE transaction: complete the run, clear the
     * sessions the inventory no longer lists (except tombstoned ones), and
     * rebuild the FULL source projection from snapshot rows — events (with
     * turn ids recovered from the payload), sessions, turns, artifacts —
     * then drop orphaned episodes and reschedule compilation for terminal
     * turns. The Relay ACK runs only after this commits.
     */
    async finalizeRun(input: {
      installationId: string
      generation: number
      inventorySessionIds: string[]
      sessionsSeen: number
      eventsSeen: number
    }): Promise<void> {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        try {
          // Turns reference source events (first/last ids); clear derived rows
          // before rebuilding the events underneath them. Deletion is scoped
          // to the whole installation — the drained inventory is the complete
          // authority, so events of sessions that left it must not linger
          // (tombstoned sessions own no rows here: purge already cleared them).
          // Note the empty-inventory edge: `<> ALL($2)` on an empty array
          // legitimately wipes the whole installation. That leans entirely on
          // relay inventory correctness and only self-heals on the next
          // reconcile.
          await client.query(`
            DELETE FROM source_turns WHERE installation_id = $1
          `, [input.installationId])
          await client.query(`
            DELETE FROM source_events WHERE installation_id = $1
          `, [input.installationId])
          // Same authority rule for the durable snapshot landing itself:
          // rows for departed sessions — and for tombstoned sessions Relay
          // (mistakenly) still lists — would otherwise accumulate forever,
          // because the drain itself carries no tombstone fence.
          // This is a deliberate fence tradeoff — a session that leaves the
          // inventory and later returns re-lands its history with no prior
          // payload hashes to compare against, so relay-side tampering in
          // that window goes undetected. The alternative (keeping departed
          // rows) is the unbounded growth this delete exists to prevent.
          await client.query(`
            DELETE FROM memory_snapshot_events
            WHERE installation_id = $1
              AND (session_id <> ALL($2::text[])
                   OR EXISTS (
                     SELECT 1 FROM memory_session_tombstones t
                     WHERE t.installation_id = memory_snapshot_events.installation_id
                       AND t.session_id = memory_snapshot_events.session_id
                   ))
          `, [input.installationId, input.inventorySessionIds])
          // Turn identity lives inside the payload itself — the Relay feed
          // envelope extracts the same fields (payload.turn_id, falling back
          // to payload.source_turn_id), so the snapshot rebuild must too or
          // turns could never be reconstructed after a hard-retention
          // reconcile. Tombstoned sessions are fenced out here and below:
          // even if Relay (mistakenly) still lists a purged session, the
          // rebuild must not resurrect its content.
          await client.query(`
            INSERT INTO source_events
              (source_event_id, installation_id, origin, origin_position, canonical_event_key,
               session_id, turn_id, event_type, occurred_at, payload, payload_hash)
            SELECT gen_random_uuid(), $1, 'snapshot', e.relay_event_id::text,
                   ${canonicalEventKeySql('e.payload')},
                   e.session_id,
                   COALESCE(NULLIF(e.payload->>'turn_id', ''), NULLIF(e.payload->>'source_turn_id', '')),
                   e.event_type, COALESCE(e.occurred_at, e.created_at), e.payload, e.payload_hash
            FROM memory_snapshot_events e
            WHERE e.installation_id = $1 AND e.session_id = ANY($2::text[])
              AND NOT EXISTS (
                SELECT 1 FROM memory_session_tombstones t
                WHERE t.installation_id = e.installation_id AND t.session_id = e.session_id
              )
            ON CONFLICT DO NOTHING
          `, [input.installationId, input.inventorySessionIds])
          // A feed event pulled and projected while this reconcile was
          // draining has no snapshot row yet; its source_events row was just
          // deleted above and the relay checkpoint moved past it, so nothing
          // would ever re-deliver it. Revive exactly the inbox rows whose
          // logical identity (canonical key) has no surviving representative
          // in the rebuilt events AND that were projected during this run —
          // the race window is by definition inside the drain, and the time
          // guard stops rows whose event simply fell out of the relay
          // snapshot from churning on every reconcile. Rows already rebuilt
          // from the snapshot keep their projected state; rows without a
          // stable identity (NULL key) stay projected and self-heal on the
          // next reconcile only if Relay still lists the event — if hard
          // retention pruned it first, the gap is permanent (bounded by the
          // race window; the alternative is reviving everything). Departed
          // sessions are excluded because for them deletion is the point.
          const revived = await client.query(`
            UPDATE memory_feed_inbox i
            SET projection_state = 'pending', projected_at = NULL
            WHERE i.installation_id = $1
              AND i.projection_state = 'projected'
              AND i.session_id IS NOT NULL AND i.session_id = ANY($2::text[])
              AND ${canonicalEventKeySql('i.data')} IS NOT NULL
              AND i.projected_at >= (
                SELECT r.started_at FROM memory_snapshot_runs r
                WHERE r.installation_id = $1 AND r.generation = $3
              )
              AND NOT EXISTS (
                SELECT 1 FROM source_events e
                WHERE e.installation_id = i.installation_id
                  AND e.session_id = i.session_id
                  AND e.canonical_event_key = ${canonicalEventKeySql('i.data')}
              )
          `, [input.installationId, input.inventorySessionIds, input.generation])
          if ((revived.rowCount ?? 0) > 0) {
            await client.query(`
              INSERT INTO memory_jobs
                (job_id, installation_id, job_type, idempotency_key, priority, payload)
              VALUES (gen_random_uuid(), $1, 'project_feed', $2, 50, '{}'::jsonb)
              ON CONFLICT DO NOTHING
            `, [input.installationId, `project:${input.installationId}:revive:${Date.now()}`])
          }
          await client.query(`
            INSERT INTO source_sessions
              (installation_id, session_id, first_recorded_at, last_recorded_at, snapshot_generation)
            SELECT $1, s.session_id, MIN(COALESCE(e.occurred_at, e.created_at)),
                   MAX(COALESCE(e.occurred_at, e.created_at)), $2
            FROM memory_snapshot_events e
            JOIN (SELECT unnest($3::text[]) AS session_id) s ON TRUE
            WHERE e.installation_id = $1 AND e.session_id = s.session_id
              AND NOT EXISTS (
                SELECT 1 FROM memory_session_tombstones t
                WHERE t.installation_id = e.installation_id AND t.session_id = e.session_id
              )
            GROUP BY s.session_id
            ON CONFLICT (installation_id, session_id) DO UPDATE SET
              last_recorded_at = EXCLUDED.last_recorded_at,
              snapshot_generation = EXCLUDED.snapshot_generation
          `, [input.installationId, input.generation, input.inventorySessionIds])
          // Sessions absent from the inventory disappear — unless a later
          // feed tombstone already handles them.
          await client.query(`
            DELETE FROM source_sessions s
            WHERE s.installation_id = $1
              AND s.session_id <> ALL($2::text[])
              AND NOT EXISTS (
                SELECT 1 FROM memory_session_tombstones t
                WHERE t.installation_id = s.installation_id AND t.session_id = s.session_id
              )
          `, [input.installationId, input.inventorySessionIds])
          await rebuildTurns(client, input.installationId, input.inventorySessionIds)
          await rebuildArtifacts(client, input.installationId, input.inventorySessionIds)
          // Episodes reference turns by id only (no FK): drop the ones whose
          // turn no longer exists instead of leaving stale orphans behind.
          await client.query(`
            DELETE FROM work_episodes w
            WHERE w.installation_id = $1
              AND NOT EXISTS (
                SELECT 1 FROM source_turns t
                WHERE t.installation_id = w.installation_id AND t.turn_id = w.turn_id
              )
          `, [input.installationId])
          // Terminal turns get a fresh compile so episodes reflect the
          // rebuilt events; compileTurn is idempotent, so re-running a
          // completed compile is safe.
          await client.query(`
            INSERT INTO memory_jobs
              (job_id, installation_id, job_type, idempotency_key, priority, payload)
            SELECT gen_random_uuid(), $1, 'compile_episode', 'compile_episode:' || t.turn_id,
                   70, '{}'::jsonb
            FROM source_turns t
            WHERE t.installation_id = $1 AND t.session_id = ANY($2::text[])
              AND t.terminal_at IS NOT NULL
            ON CONFLICT (installation_id, job_type, idempotency_key) DO UPDATE SET
              state = 'pending', available_at = NOW(), attempts = 0,
              claimed_by = NULL, claim_expires_at = NULL,
              last_error_code = NULL, completed_at = NULL
          `, [input.installationId, input.inventorySessionIds])
          await client.query(`
            UPDATE memory_snapshot_runs
            SET state = 'completed', sessions_seen = $3, events_seen = $4, completed_at = NOW()
            WHERE installation_id = $1 AND generation = $2
          `, [input.installationId, input.generation, input.sessionsSeen, input.eventsSeen])
          await client.query(`
            UPDATE memory_installations
            SET snapshot_required = FALSE, local_status = 'ready', last_error_code = NULL,
                updated_at = NOW()
            WHERE installation_id = $1
          `, [input.installationId])
          await client.query('COMMIT')
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        }
      } finally {
        client.release()
      }
    },
  }
}

/**
 * Rebuild turns from the freshly inserted snapshot events with the same
 * semantics the feed projector applies incrementally: the first terminal
 * state wins and never regresses, otherwise the last known state applies,
 * and the earliest event opens the turn. turn ids are only unique per
 * installation — a turn id reused across two sessions attributes to the
 * session of its earliest event, exactly like the feed's first insert wins.
 * Ties on occurred_at break by the relay event id (journal arrival order),
 * which is stable across rebuilds — a regenerated uuid would let repeated
 * reconciles flip the outcome.
 */
async function rebuildTurns(
  client: Pick<pg.PoolClient, 'query'>,
  installationId: string,
  inventorySessionIds: string[],
): Promise<void> {
  await client.query(`
    INSERT INTO source_turns
      (installation_id, turn_id, session_id, state, reason, started_at, terminal_at,
       first_source_event_id, last_source_event_id, event_count)
    SELECT
      $1,
      turn_id,
      (array_agg(session_id ORDER BY occurred_at, relay_pos))[1],
      COALESCE(
        (array_agg(state_status ORDER BY occurred_at, relay_pos)
          FILTER (WHERE state_status IN ('completed','interrupted','failed','abandoned')))[1],
        (array_agg(state_status ORDER BY occurred_at DESC, relay_pos DESC)
          FILTER (WHERE state_status IS NOT NULL))[1],
        'running'
      ),
      (array_agg(reason ORDER BY occurred_at DESC, relay_pos DESC)
        FILTER (WHERE reason IS NOT NULL))[1],
      MIN(occurred_at),
      (array_agg(occurred_at ORDER BY occurred_at, relay_pos)
        FILTER (WHERE state_status IN ('completed','interrupted','failed','abandoned')))[1],
      (array_agg(source_event_id ORDER BY occurred_at, relay_pos))[1],
      (array_agg(source_event_id ORDER BY occurred_at DESC, relay_pos DESC))[1],
      COUNT(*)
    FROM (
      SELECT source_event_id, turn_id, session_id, occurred_at,
             origin_position::bigint AS relay_pos,
             CASE WHEN payload->>'status' IN
               ('running','interrupt_requested','completed','interrupted','failed','abandoned')
             THEN payload->>'status' END AS state_status,
             NULLIF(payload->>'reason', '') AS reason
      FROM source_events
      WHERE installation_id = $1 AND origin = 'snapshot'
        AND session_id = ANY($2::text[]) AND turn_id IS NOT NULL
    ) ev
    GROUP BY turn_id
  `, [installationId, inventorySessionIds])
}

/**
 * Rebuild artifacts by re-running the deterministic feed classifier over the
 * rebuilt snapshot events — the payload shape is identical to the feed
 * envelope's data, so the same classifier must produce the same artifacts.
 * Keyset-paginated to keep the transaction's memory bounded.
 */
async function rebuildArtifacts(
  client: Pick<pg.PoolClient, 'query'>,
  installationId: string,
  inventorySessionIds: string[],
): Promise<void> {
  const pageSize = 500
  let afterEventId = '00000000-0000-0000-0000-000000000000'
  for (;;) {
    const page = await client.query<{
      source_event_id: string
      session_id: string
      turn_id: string | null
      event_type: string
      payload: Record<string, unknown>
      occurred_at: Date
    }>(`
      SELECT source_event_id::text, session_id, turn_id, event_type, payload, occurred_at
      FROM source_events
      WHERE installation_id = $1 AND origin = 'snapshot'
        AND session_id = ANY($2::text[]) AND source_event_id > $3::uuid
      ORDER BY source_event_id
      LIMIT $4
    `, [installationId, inventorySessionIds, afterEventId, pageSize])
    if (page.rows.length === 0) break
    for (const row of page.rows) {
      const artifact = classifyArtifact(row.event_type, row.payload ?? {})
      if (!artifact) continue
      await client.query(`
        INSERT INTO source_artifacts
          (artifact_id, installation_id, session_id, turn_id, source_event_id,
           artifact_type, identity_key, path, call_id, status, details, occurred_at)
        VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
        ON CONFLICT DO NOTHING
      `, [
        installationId, row.session_id, row.turn_id, row.source_event_id,
        artifact.artifact_type, artifact.identity_key, artifact.path,
        artifact.call_id, artifact.status, JSON.stringify(artifact.details),
        row.occurred_at,
      ])
    }
    afterEventId = page.rows[page.rows.length - 1].source_event_id
  }
}

export type SnapshotRepository = ReturnType<typeof createSnapshotRepository>

function decimalEventId(value: unknown): string {
  if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) return value
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value)
  throw new Error('malformed snapshot relay event id')
}
