import {snapshotLogicalSession,snapshotAliasRow,prepareSnapshotAliasRows} from '../sources/snapshot-alias.js'
import {sourcePoolContext} from '../sources/pool-context.js'
import {canonicalJsonString} from '@pocketctl/session-source'
import type pg from 'pg'
import {lockLegacySourceInput,lockSnapshotSourceInput} from '../sources/input-mode.js'
import { canonicalPayloadHash } from '../inbox/canonical-json.js'
import { classifyArtifact } from '../projection/artifact-classifier.js'
import { withTransaction } from '../db.js'

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

/** Recovery must not clear a privacy fence or a rejected expired replay. */
async function assertSnapshotInstallation(client: pg.PoolClient, installationId: string): Promise<void> {
  const available = await client.query(`SELECT 1 FROM memory_installations WHERE installation_id=$1
    AND relay_status NOT IN ('revoking','revoked') AND local_status NOT IN ('purging','purged','integrity_error')`, [installationId])
  if (!available.rowCount) throw new Error('snapshot_installation_unavailable')
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
      return withTransaction(pool, async client => {
        const modeGeneration=await lockLegacySourceInput(client,installationId)
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('purge:installation:'||$1,0))`, [installationId])
        await assertSnapshotInstallation(client, installationId)
        await client.query(`
          UPDATE memory_snapshot_runs
          SET state = 'failed', error_code = 'stale_running', completed_at = NOW()
          WHERE installation_id = $1 AND state = 'running'
            AND started_at < NOW() - INTERVAL '30 minutes'
        `, [installationId])
        const result = await client.query<{ run_id: string; generation: string }>(`
          WITH next AS (
            SELECT COALESCE(MAX(generation), 0) + 1 AS generation
            FROM memory_snapshot_runs WHERE installation_id = $1
          )
          INSERT INTO memory_snapshot_runs (run_id, installation_id, generation, state, started_at,source_mode_generation)
          SELECT gen_random_uuid(), $1, next.generation, 'running', clock_timestamp(),$2 FROM next
          RETURNING run_id, generation::text
        `, [installationId,modeGeneration])
        return {
          runId: result.rows[0].run_id,
          generation: Number(result.rows[0].generation),
        }
      })
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
      const bindings=events.map(event=>snapshotLogicalSession(event,sessionId))
      const aliasRows=events.flatMap((event,index)=>bindings[index].alias?[snapshotAliasRow(event,bindings[index].sessionId)]:[])
      const aliasAuthority=aliasRows.length?await prepareSnapshotAliasRows(pool,installationId,aliasRows,new Set([sessionId])):undefined
      return withTransaction(pool,async client=>{
      await lockSnapshotSourceInput(client,installationId,generation)
      await client.query("SELECT run_id FROM memory_snapshot_runs WHERE installation_id=$1 AND generation=$2 AND state='running' FOR SHARE",[installationId,generation])
      for(const sid of [...new Set([sessionId,...bindings.map(b=>b.sessionId)])].sort())await client.query("SELECT pg_advisory_xact_lock(hashtextextended('purge:session:'||$1||':'||$2,0))",[installationId,sid])
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('purge:session:'||$1||':'||$2,0))`,[installationId,sessionId])
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('purge:installation:'||$1,0))`,[installationId])
      await assertSnapshotInstallation(client,installationId)
      // A page can arrive after a privacy purge; the same fence is held by
      // the purge transaction, so even durable landing cannot resurrect it.
      if ((await client.query(`SELECT 1 FROM memory_session_tombstones
        WHERE installation_id=$1 AND session_id=$2`,[installationId,sessionId])).rowCount) return 0
      const incoming = new Map<string, Buffer>(),logicalById=new Map<string,string>()
      for (const [index,event] of events.entries()) {
        const id=decimalEventId(event.event_id),hash=canonicalPayloadHash(bindings[index].envelope),prior=incoming.get(id)
        if(prior&&!prior.equals(hash))throw new Error('snapshot integrity violation on duplicate relay event')
        if(logicalById.has(id)&&logicalById.get(id)!==bindings[index].sessionId)throw Error('snapshot source identity conflict')
        incoming.set(id,hash);logicalById.set(id,bindings[index].sessionId)
      }
      const existing = await client.query<{ relay_event_id: string; session_id:string; payload_hash: Buffer }>(`
        SELECT relay_event_id::text, session_id, payload_hash FROM memory_snapshot_events
        WHERE installation_id = $1 AND relay_event_id = ANY($2::bigint[])
      `, [installationId, [...incoming.keys()]])
      for (const row of existing.rows) {
        const next = incoming.get(row.relay_event_id)
        if (row.session_id!==logicalById.get(row.relay_event_id) || (next && !next.equals(row.payload_hash))) {
          throw new Error(`snapshot integrity violation on relay event ${row.relay_event_id}`)
        }
      }
      for (const event of events) {
        const eventId = decimalEventId(event.event_id)
        // The relay-side timestamp drives ordering and turn timelines on
        // rebuild; landing time alone would reorder same-page events by
        // fetch time instead of occurrence.
        const occurredMs = event.created_at instanceof Date ? event.created_at.getTime() : Date.parse(String(event.created_at ?? ''))
        if (!Number.isFinite(occurredMs)) {
          throw new Error(`malformed snapshot event timestamp on relay event ${event.event_id}`)
        }
        if((await client.query('SELECT 1 FROM memory_session_tombstones WHERE installation_id=$1 AND session_id=$2',[installationId,logicalById.get(eventId)!])).rowCount)continue
        await client.query(`
          INSERT INTO memory_snapshot_events
            (installation_id, session_id, relay_event_id, event_type, payload,
             payload_hash, created_at, occurred_at, generation, content_hash)
          SELECT $1, $2, $3, $4, $5::jsonb, $6, NOW(), $7, $8, $9
          WHERE NOT EXISTS(SELECT 1 FROM memory_source_retention_receipts r
            WHERE r.installation_id=$1 AND r.session_id=$2 AND
              (r.turn_id=COALESCE(NULLIF($5::jsonb->>'turn_id',''),NULLIF($5::jsonb->>'source_turn_id',''))
               OR COALESCE(NULLIF($5::jsonb->>'turn_id',''),NULLIF($5::jsonb->>'source_turn_id','')) IS NULL))
          ON CONFLICT (installation_id, session_id, relay_event_id) DO UPDATE
            SET content_hash=COALESCE(memory_snapshot_events.content_hash,EXCLUDED.content_hash),
                generation=GREATEST(memory_snapshot_events.generation,EXCLUDED.generation)
            WHERE memory_snapshot_events.payload_hash=EXCLUDED.payload_hash
              AND(memory_snapshot_events.content_hash IS NULL OR memory_snapshot_events.content_hash=EXCLUDED.content_hash)
        `, [
          installationId, logicalById.get(eventId)!, eventId,
          typeof event.event_type === 'string' ? event.event_type : 'unknown',
          JSON.stringify(event.payload ?? {}), incoming.get(eventId),
          new Date(occurredMs), generation, canonicalPayloadHash(event.payload ?? {}),
        ])
      }
      await aliasAuthority?.assertCurrent(client,true)
      return events.length
      })
    },

    /**
     * Complete the snapshot and add missing projections in one transaction.
     * Preserve existing source identity and history; inventory absence cannot
     * authorize deletion. The Relay ACK runs only after this commits.
     */
    async finalizeRun(input: {
      installationId: string
      generation: number
      inventorySessionIds: string[]
      sessionsSeen: number
      eventsSeen: number
    }): Promise<void> {
      const rosterSql=`SELECT relay_event_id::text,session_id,event_type,encode(content_hash,'hex') AS content_hash,occurred_at::text,
          to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS legacy_wire_timestamp,
          extract(microseconds FROM occurred_at)::bigint%1000=0 AS legacy_millis
        FROM memory_snapshot_events WHERE installation_id=$1 AND generation=$2 ORDER BY relay_event_id LIMIT 100001`
      const roster=(await pool.query(rosterSql,[input.installationId,input.generation])).rows
      const shared=sourcePoolContext(pool).namespace==='memory'
      const authority=shared&&roster.length?await prepareSnapshotAliasRows(pool,input.installationId,roster,new Set(input.inventorySessionIds)):undefined
      const logicalSessions=[...new Set([...input.inventorySessionIds,...roster.map(r=>r.session_id)])].sort()
      if(logicalSessions.length>4096)throw Error('snapshot_source_roster_limit')
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        try {
          await lockSnapshotSourceInput(client,input.installationId,input.generation)
          await client.query("SELECT run_id FROM memory_snapshot_runs WHERE installation_id=$1 AND generation=$2 AND state='running' FOR UPDATE NOWAIT",[input.installationId,input.generation])
          for(const sid of logicalSessions)await client.query("SELECT pg_advisory_xact_lock(hashtextextended('purge:session:'||$1||':'||$2,0))",[input.installationId,sid])
          if(canonicalJsonString((await client.query(rosterSql,[input.installationId,input.generation])).rows)!==canonicalJsonString(roster))throw Error('snapshot_source_roster_changed')
          await authority?.assertCurrent(client)
          await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('purge:installation:'||$1,0))`, [input.installationId])
          await assertSnapshotInstallation(client, input.installationId)
          // Inventory absence is not deletion authority: keep old UUIDs,
          // typed/cold references, Team projections and unproved history.
          // Explicit tombstones are applied by the privacy purge; their
          // landing bodies are removed here as defence in depth.
          await client.query(`DELETE FROM memory_snapshot_events e
            WHERE installation_id=$1 AND EXISTS(SELECT 1 FROM memory_session_tombstones t
              WHERE t.installation_id=e.installation_id AND t.session_id=e.session_id)`,[input.installationId])
          // The canonical id is the identity proof; body equality alone never
          // joins sources. A reviewed binding must agree on session, type,
          // occurrence and canonical hash before it may suppress a new row.
          const conflicts=await client.query(`SELECT 1 FROM memory_snapshot_events e
            LEFT JOIN jsonb_to_recordset($3::jsonb) native(canonical_key text,occurred_at timestamptz) ON native.canonical_key=e.relay_event_id::text
            JOIN source_events s ON s.installation_id=e.installation_id
              AND s.source_kind='relay_event' AND s.mapping_state='verified'
              AND s.canonical_key=e.relay_event_id::text
            WHERE e.installation_id=$1 AND e.session_id=ANY($2::text[])
              AND (s.canonical_session_key IS DISTINCT FROM e.session_id
                OR s.session_id IS DISTINCT FROM e.session_id OR s.event_type IS DISTINCT FROM e.event_type
                OR s.occurred_at IS DISTINCT FROM CASE WHEN s.origin='canonical' THEN COALESCE(native.occurred_at,e.occurred_at) ELSE e.occurred_at END
                OR e.content_hash IS NULL OR s.content_hash IS DISTINCT FROM e.content_hash)
            LIMIT 1`,[input.installationId,logicalSessions,JSON.stringify(authority?.nativeTimes??[])])
          if(conflicts.rowCount) throw new Error('snapshot canonical source integrity conflict')
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
              AND NOT EXISTS(SELECT 1 FROM source_events s WHERE s.installation_id=e.installation_id
                AND s.source_kind='relay_event' AND s.mapping_state='verified' AND s.canonical_key=e.relay_event_id::text)
              AND NOT EXISTS(SELECT 1 FROM memory_source_retention_receipts r WHERE r.installation_id=e.installation_id
                AND r.session_id=e.session_id AND (r.turn_id=COALESCE(NULLIF(e.payload->>'turn_id',''),NULLIF(e.payload->>'source_turn_id',''))
                  OR COALESCE(NULLIF(e.payload->>'turn_id',''),NULLIF(e.payload->>'source_turn_id','')) IS NULL))
              AND NOT EXISTS (
                SELECT 1 FROM memory_session_tombstones t
                WHERE t.installation_id = e.installation_id AND t.session_id = e.session_id
              )
            ON CONFLICT DO NOTHING
          `, [input.installationId, logicalSessions])
          // Recover projected inbox rows only when neither their original
          // Feed position nor a canonical representative survived. Keeping
          // sources above prevents unnecessary replay and budget churn.
          const revived = await client.query(`
            UPDATE memory_feed_inbox i
            SET projection_state = 'pending', projected_at = NULL
            WHERE i.installation_id = $1
              AND i.projection_state = 'projected'
              AND i.body_reclaimed_at IS NULL
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
                  AND (e.canonical_event_key = ${canonicalEventKeySql('i.data')}
                    OR (e.origin='feed' AND e.origin_position=i.feed_id::text))
              )
          `, [input.installationId, logicalSessions, input.generation])
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
              last_recorded_at = GREATEST(source_sessions.last_recorded_at,EXCLUDED.last_recorded_at),
              snapshot_generation = EXCLUDED.snapshot_generation
          `, [input.installationId, input.generation, logicalSessions])
          // An empty inventory also leaves historical/Team sessions intact.
          await rebuildTurns(client, input.installationId, logicalSessions)
          await rebuildArtifacts(client, input.installationId, logicalSessions)
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
              AND NOT EXISTS(SELECT 1 FROM memory_source_retention_receipts r WHERE r.installation_id=t.installation_id AND r.turn_id=t.turn_id)
            ON CONFLICT (installation_id, job_type, idempotency_key) DO UPDATE SET
              state = 'pending', available_at = NOW(), attempts = 0,
              claimed_by = NULL, claim_expires_at = NULL,
              last_error_code = NULL, completed_at = NULL
          `, [input.installationId, logicalSessions])
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
          await authority?.assertCurrent(client,true)
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
        AND session_id = ANY($2::text[]) AND turn_id IS NOT NULL AND body_reclaimed_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM memory_source_retention_receipts r WHERE r.installation_id=source_events.installation_id AND r.turn_id=source_events.turn_id)
    ) ev
    GROUP BY turn_id
    ON CONFLICT(installation_id,turn_id) DO UPDATE SET
      session_id=EXCLUDED.session_id,state=EXCLUDED.state,reason=EXCLUDED.reason,
      started_at=EXCLUDED.started_at,terminal_at=EXCLUDED.terminal_at,
      first_source_event_id=EXCLUDED.first_source_event_id,last_source_event_id=EXCLUDED.last_source_event_id,
      event_count=EXCLUDED.event_count
    WHERE NOT EXISTS(SELECT 1 FROM source_events protected WHERE protected.installation_id=$1
      AND protected.turn_id=EXCLUDED.turn_id AND (protected.origin<>'snapshot' OR protected.mapping_state<>'unproven'))
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
        AND session_id = ANY($2::text[]) AND source_event_id > $3::uuid AND body_reclaimed_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM memory_source_retention_receipts r WHERE r.installation_id=source_events.installation_id
          AND r.session_id=source_events.session_id AND (r.turn_id=source_events.turn_id OR source_events.turn_id IS NULL))
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
