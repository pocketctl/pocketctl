import type pg from 'pg'

/** Caller already owns the candidate row lock. This is also the lazy expiry
 * path, so an old browser cannot accept a candidate between sweeps. */
export async function expireCandidateIfDue(client: pg.PoolClient, installationId: string, candidateId: string): Promise<boolean> {
  const result = await client.query(`UPDATE memory_candidates SET status='expired',revision=revision+1,
      validation=validation||'{"expiry_reason":"review_ttl_elapsed"}'::jsonb
    WHERE installation_id=$1 AND candidate_id=$2 AND status IN ('validated','conflict')
      AND review_expires_at<=clock_timestamp() RETURNING candidate_id`, [installationId, candidateId])
  return (result.rowCount ?? 0) > 0
}

/** Preserve the candidate and evidence for audit; expiration is not deletion. */
export async function expirePendingCandidates(pool: pg.Pool, batchSize = 500): Promise<number> {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5000) throw new Error('invalid_candidate_expiry_batch')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SET LOCAL statement_timeout='5s'")
    await client.query("SET LOCAL lock_timeout='1s'")
    const result = await client.query(`WITH due AS MATERIALIZED (
      SELECT candidate_id FROM memory_candidates WHERE status IN ('validated','conflict')
        AND review_expires_at<=statement_timestamp()
      ORDER BY review_expires_at,candidate_id LIMIT $1 FOR UPDATE SKIP LOCKED
    ) UPDATE memory_candidates c SET status='expired',revision=revision+1,
        validation=c.validation||'{"expiry_reason":"review_ttl_elapsed"}'::jsonb
      FROM due WHERE c.candidate_id=due.candidate_id`, [batchSize])
    await client.query('COMMIT')
    return result.rowCount ?? 0
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { client.release() }
}

/** Non-overlapping, bounded passes; drain before closing the database pool. */
export function createCandidateExpiryWorker(options: {
  pool: pg.Pool; signal: AbortSignal
  onExpired?(count: number): void; onError?(error: unknown): void
}) {
  let timer: ReturnType<typeof setInterval> | undefined
  let inFlight: Promise<void> | undefined
  let stopped = false
  function runOnce(): Promise<void> {
    if (inFlight) return inFlight
    if (stopped || options.signal.aborted) return Promise.resolve()
    inFlight = expirePendingCandidates(options.pool).then(count => {
      if (count) options.onExpired?.(count)
    }).finally(() => { inFlight = undefined })
    return inFlight
  }
  function tick() { void runOnce().catch(error => options.onError?.(error)) }
  return {
    runOnce,
    start() {
      if (timer || stopped || options.signal.aborted) return
      timer = setInterval(tick, 60_000)
      timer.unref?.()
      tick()
    },
    async stop() { stopped = true; if (timer) clearInterval(timer); await inFlight },
  }
}
