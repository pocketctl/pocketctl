import type pg from 'pg'

export interface InboxRetentionSettings {
  mode: 'off' | 'enabled'
  bodyDays: number
  metadataDays: number
  batchSize: number
  intervalMs: number
}

export interface InboxRetentionResult {
  reclaimed: number
  deleted: number
  metadataBlocked: boolean
  skipped: 'busy' | 'snapshot' | 'inactive' | 'unacknowledged' | null
}

/** All lifecycle actors use this installation fence. No Session locks may
 * be acquired after it: purge/extraction acquire Session before Installation. */
export async function retainInboxInstallation(
  pool: pg.Pool,
  installationId: string,
  settings: InboxRetentionSettings,
): Promise<InboxRetentionResult> {
  const result: InboxRetentionResult = { reclaimed: 0, deleted: 0, metadataBlocked: false, skipped: null }
  if (settings.mode === 'off') return result
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`SET LOCAL lock_timeout='1s'`)
    await client.query(`SET LOCAL statement_timeout='5s'`)
    const locked = (await client.query<{locked: boolean}>(`
      SELECT pg_try_advisory_xact_lock(hashtextextended('purge:installation:'||$1,0)) AS locked
    `, [installationId])).rows[0].locked
    if (!locked) result.skipped = 'busy'
    else {
      const state = (await client.query<{
        local_status: string; relay_status: string; snapshot_required: boolean
        last_ack_feed_id: string; gc_feed_id: string; snapshot_busy: boolean
      }>(`SELECT i.local_status,i.relay_status,i.snapshot_required,
          COALESCE(c.last_ack_feed_id,0)::text last_ack_feed_id,COALESCE(c.gc_feed_id,0)::text gc_feed_id,
          EXISTS(SELECT 1 FROM memory_snapshot_runs r WHERE r.installation_id=i.installation_id
            AND (r.state='running' OR (r.state='completed' AND r.relay_acked_at IS NULL))) AS snapshot_busy
        FROM memory_installations i LEFT JOIN memory_inbox_checkpoints c USING(installation_id)
        WHERE i.installation_id=$1`, [installationId])).rows[0]
      if (!state || !['ready', 'degraded'].includes(state.local_status)
        || !['active', 'paused'].includes(state.relay_status)) result.skipped = 'inactive'
      else if (state.snapshot_required || state.snapshot_busy) result.skipped = 'snapshot'
      else if (state.last_ack_feed_id === '0') result.skipped = 'unacknowledged'
      else {
        // The hash is the original envelope hash; clearing JSON never changes it.
        const bodies = await client.query(`
          WITH expired AS MATERIALIZED (
            SELECT feed_id FROM memory_feed_inbox WHERE installation_id=$1
              AND projection_state='projected' AND body_reclaimed_at IS NULL
              AND projected_at < NOW()-($2::integer*INTERVAL '1 day') AND feed_id<=$3::bigint
            ORDER BY projected_at,feed_id LIMIT $4 FOR UPDATE SKIP LOCKED
          )
          UPDATE memory_feed_inbox i SET data='{}'::jsonb,classification='{}'::jsonb,body_reclaimed_at=NOW()
          FROM expired e WHERE i.installation_id=$1 AND i.feed_id=e.feed_id`,
        [installationId, settings.bodyDays, state.last_ack_feed_id, settings.batchSize])
        result.reclaimed = bodies.rowCount ?? 0

        // A single watermark may only describe a fully handled prefix. Never
        // skip an old pending/quarantined/unacknowledged/young receipt, even if
        // later IDs could otherwise expire. SKIP LOCKED is unsafe for a prefix.
        const receipts = await client.query<{feed_id: string; eligible: boolean}>(`
          SELECT feed_id::text, (projection_state='projected' AND body_reclaimed_at IS NOT NULL
            AND projected_at < NOW()-($2::integer*INTERVAL '1 day')
            AND feed_id<=$3::bigint) IS TRUE AS eligible
          FROM memory_feed_inbox WHERE installation_id=$1 AND feed_id>$4::bigint
          ORDER BY feed_id LIMIT $5`,
        [installationId, settings.metadataDays, state.last_ack_feed_id, state.gc_feed_id, settings.batchSize])
        let through: string | undefined
        for (const row of receipts.rows) {
          if (!row.eligible) { result.metadataBlocked = true; break }
          through = row.feed_id
        }
        if (through) {
          const deleted = await client.query(`DELETE FROM memory_feed_inbox
            WHERE installation_id=$1 AND feed_id>$2::bigint AND feed_id<=$3::bigint`,
          [installationId, state.gc_feed_id, through])
          await client.query(`UPDATE memory_inbox_checkpoints
            SET gc_feed_id=GREATEST(gc_feed_id,$2::bigint),updated_at=NOW() WHERE installation_id=$1`,
          [installationId, through])
          result.deleted = deleted.rowCount ?? 0
        }
      }
    }
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { client.release() }
}

/** One bounded, non-overlapping pass at a time, drained before pool shutdown. */
export function createInboxRetentionWorker(options: {
  pool: pg.Pool
  settings: InboxRetentionSettings
  signal: AbortSignal
  onResult?(result: InboxRetentionResult): void
  onError?(error: unknown): void
}) {
  let timer: ReturnType<typeof setInterval> | undefined
  let inFlight: Promise<void> | undefined
  let stopped = false
  let after: string | null = null
  function runOnce(): Promise<void> {
    if (inFlight) return inFlight
    if (stopped || options.signal.aborted || options.settings.mode === 'off') return Promise.resolve()
    inFlight = (async () => {
      // Fair across installations even when more than one pass is needed.
      const installations = await options.pool.query<{installation_id: string}>(`
        SELECT c.installation_id FROM memory_inbox_checkpoints c JOIN memory_installations i USING(installation_id)
        WHERE c.last_ack_feed_id>0 AND i.local_status IN('ready','degraded')
          AND i.relay_status IN('active','paused') AND ($1::uuid IS NULL OR c.installation_id>$1::uuid)
        ORDER BY c.installation_id LIMIT 20`, [after])
      for (const row of installations.rows) {
        if (stopped || options.signal.aborted) break
        try { options.onResult?.(await retainInboxInstallation(options.pool, row.installation_id, options.settings)) }
        catch (error) { options.onError?.(error) }
      }
      after = installations.rows.length < 20 ? null : installations.rows.at(-1)!.installation_id
    })().finally(() => { inFlight = undefined })
    return inFlight
  }
  return {
    runOnce,
    start() {
      if (timer || stopped || options.signal.aborted || options.settings.mode === 'off') return
      timer = setInterval(() => { void runOnce().catch(error => options.onError?.(error)) }, options.settings.intervalMs)
      timer.unref?.()
      void runOnce().catch(error => options.onError?.(error))
    },
    async stop() {
      stopped = true
      if (timer) clearInterval(timer)
      await inFlight
    },
  }
}
