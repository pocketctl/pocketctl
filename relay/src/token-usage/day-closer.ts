import type pg from 'pg'

export type TokenDayCloseResult =
  | { date: string; status: 'already_sealed' }
  | { date: string; status: 'waiting'; pendingRows: number }
  | { date: string; status: 'failed'; deadLetterRows?: number; reason?: 'reconciliation_mismatch' | 'missing_usage_facts' }
  | { date: string; status: 'sealed'; factCount: number; total: number }

function utcDate(now: Date): string {
  return now.toISOString().slice(0, 10)
}

function closeEligibleBefore(now: Date): string {
  if (now.getUTCHours() !== 0 || now.getUTCMinutes() >= 5) return utcDate(now)
  return new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - 1,
  )).toISOString().slice(0, 10)
}

function requireCompletedUtcDate(date: string, now: Date): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new Error('token day close requires an ISO UTC date')
  }
  if (date >= utcDate(now)) throw new Error('token day close requires a completed UTC date')
}

function bigint(value: unknown): bigint {
  const text = String(value ?? '0')
  if (!/^-?\d+$/.test(text)) throw new Error('token reconciliation returned a non-integer value')
  return BigInt(text)
}

/**
 * Closes one UTC accounting date under a transaction-scoped advisory lock.
 * A date cannot become historical until all inbox rows received before its
 * cutoff are terminal, no dead letters remain, and fact/rollup totals match.
 */
export async function closeTokenUsageDay(
  pool: pg.Pool,
  date: string,
  now: Date = new Date(),
): Promise<TokenDayCloseResult> {
  requireCompletedUtcDate(date, now)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT pg_advisory_xact_lock_shared(hashtext('token-usage-accounting-global'))`)
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('token-day-close:' || $1))`, [date])
    const closure = await client.query(
      `INSERT INTO token_daily_closures (date, status, cutoff_at, updated_at)
       VALUES ($1::date, 'pending', (($1::date + 1)::timestamp AT TIME ZONE 'UTC'), NOW())
       ON CONFLICT (date) DO UPDATE SET updated_at = NOW()
       RETURNING status`,
      [date],
    )
    if (closure.rows[0]?.status === 'sealed') {
      await client.query('COMMIT')
      return { date, status: 'already_sealed' }
    }

    const active = await client.query(
      `SELECT COUNT(*) AS count
       FROM event_inbox
       WHERE received_at >= ($1::date::timestamp AT TIME ZONE 'UTC')
         AND received_at < (($1::date + 1)::timestamp AT TIME ZONE 'UTC')
         AND status IN (0, 1)`,
      [date],
    )
    const pendingRows = Number(active.rows[0]?.count ?? 0)
    if (pendingRows > 0) {
      await client.query(
        `UPDATE token_daily_closures
         SET status = 'pending', last_error = NULL, updated_at = NOW()
         WHERE date = $1::date`,
        [date],
      )
      await client.query('COMMIT')
      return { date, status: 'waiting', pendingRows }
    }

    const dead = await client.query(
      `SELECT COUNT(*) AS count
       FROM event_inbox
       WHERE received_at >= ($1::date::timestamp AT TIME ZONE 'UTC')
         AND received_at < (($1::date + 1)::timestamp AT TIME ZONE 'UTC')
         AND status = 3`,
      [date],
    )
    const deadLetterRows = Number(dead.rows[0]?.count ?? 0)
    if (deadLetterRows > 0) {
      await client.query(
        `UPDATE token_daily_closures
         SET status = 'failed', last_error = 'pre_cutoff_dead_letter', updated_at = NOW()
         WHERE date = $1::date`,
        [date],
      )
      await client.query('COMMIT')
      return { date, status: 'failed', deadLetterRows }
    }

    // A worker/API flag mismatch must fail closed instead of silently sealing
    // a partial day. Pre-baseline rows are exempt because migration may have
    // reconstructed them with event-based compatibility keys.
    const missingFacts = await client.query(
      `SELECT COUNT(*) AS count
       FROM event_inbox inbox
       JOIN token_usage_accounting_state baseline ON baseline.key = 'baseline-v1'
       LEFT JOIN token_usage_facts fact ON fact.fact_key = 'inbox:' || inbox.inbox_id
       LEFT JOIN token_usage_facts event_fact
         ON inbox.materialized_event_id IS NOT NULL
        AND event_fact.source_event_id = inbox.materialized_event_id
       WHERE inbox.received_at >= baseline.completed_at
         AND inbox.received_at >= ($1::date::timestamp AT TIME ZONE 'UTC')
         AND inbox.received_at < (($1::date + 1)::timestamp AT TIME ZONE 'UTC')
         AND inbox.status = 2 AND inbox.event_type = 'agent_text'
         AND inbox.payload ? 'usage'
         AND fact.fact_key IS NULL AND event_fact.fact_key IS NULL`,
      [date],
    )
    if (Number(missingFacts.rows[0]?.count ?? 0) > 0) {
      await client.query(
        `UPDATE token_daily_closures
         SET status = 'failed', last_error = 'missing_usage_facts', updated_at = NOW()
         WHERE date = $1::date`,
        [date],
      )
      await client.query('COMMIT')
      return { date, status: 'failed', reason: 'missing_usage_facts' }
    }

    // Replacement, not additive upsert: this also removes legacy deletion
    // compensation rows before inserting the fact-authoritative rollup.
    await client.query(`DELETE FROM token_daily_stats WHERE date = $1::date`, [date])
    await client.query(
      `INSERT INTO token_daily_stats (
         user_id, daemon_id, date, model, input, output,
         cache_read, cache_create, requests
       )
       SELECT user_id, daemon_id, usage_date, model,
              SUM(input), SUM(output), SUM(cache_read), SUM(cache_create), SUM(requests)
       FROM token_usage_facts
       WHERE usage_date = $1::date
       GROUP BY user_id, daemon_id, usage_date, model`,
      [date],
    )
    await client.query(`DELETE FROM token_session_daily_stats WHERE date = $1::date`, [date])
    await client.query(
      `INSERT INTO token_session_daily_stats (
         user_id, session_id, date, input, output, cache_read, cache_create, requests
       )
       SELECT user_id, session_id, usage_date, SUM(input), SUM(output), SUM(cache_read),
              SUM(cache_create), SUM(requests)
       FROM token_usage_facts
       WHERE usage_date = $1::date AND session_attribution_revoked = false
       GROUP BY user_id, session_id, usage_date`,
      [date],
    )
    const reconciliation = await client.query(
      `SELECT
         (SELECT COUNT(*) FROM token_usage_facts WHERE usage_date = $1::date) AS source_fact_count,
         (SELECT COALESCE(SUM(requests), 0)
          FROM token_usage_facts WHERE usage_date = $1::date) AS source_request_count,
         (SELECT COALESCE(SUM(requests), 0)
          FROM token_daily_stats WHERE date = $1::date) AS rollup_request_count,
         (SELECT COALESCE(SUM(requests), 0)
          FROM token_usage_facts
          WHERE usage_date = $1::date AND session_attribution_revoked = false) AS session_source_request_count,
         (SELECT COALESCE(SUM(requests), 0)
          FROM token_session_daily_stats WHERE date = $1::date) AS session_rollup_request_count,
         (SELECT COALESCE(SUM(input + output + cache_read + cache_create), 0)
          FROM token_usage_facts WHERE usage_date = $1::date) AS source_total,
         (SELECT COALESCE(SUM(input + output + cache_read + cache_create), 0)
          FROM token_daily_stats WHERE date = $1::date) AS rollup_total,
         (SELECT COALESCE(SUM(input + output + cache_read + cache_create), 0)
          FROM token_usage_facts
          WHERE usage_date = $1::date AND session_attribution_revoked = false) AS session_source_total,
         (SELECT COALESCE(SUM(input + output + cache_read + cache_create), 0)
          FROM token_session_daily_stats WHERE date = $1::date) AS session_rollup_total`,
      [date],
    )
    const factCountExact = bigint(reconciliation.rows[0]?.source_fact_count)
    const sourceRequestCount = bigint(reconciliation.rows[0]?.source_request_count)
    const rollupRequestCount = bigint(reconciliation.rows[0]?.rollup_request_count)
    const sessionSourceRequestCount = bigint(reconciliation.rows[0]?.session_source_request_count)
    const sessionRollupRequestCount = bigint(reconciliation.rows[0]?.session_rollup_request_count)
    const sourceTotal = bigint(reconciliation.rows[0]?.source_total)
    const rollupTotal = bigint(reconciliation.rows[0]?.rollup_total)
    const sessionSourceTotal = bigint(reconciliation.rows[0]?.session_source_total)
    const sessionRollupTotal = bigint(reconciliation.rows[0]?.session_rollup_total)
    if (sourceRequestCount !== rollupRequestCount
      || sessionSourceRequestCount !== sessionRollupRequestCount
      || sourceTotal !== rollupTotal
      || sessionSourceTotal !== sessionRollupTotal) {
      await client.query(
        `UPDATE token_daily_closures
         SET status = 'failed', source_fact_count = $2, source_request_count = $3,
             rollup_request_count = $4, session_source_request_count = $5,
             session_rollup_request_count = $6, source_total = $7, rollup_total = $8,
             session_source_total = $9, session_rollup_total = $10,
             last_error = 'reconciliation_mismatch', updated_at = NOW()
         WHERE date = $1::date`,
        [date, factCountExact.toString(), sourceRequestCount.toString(),
         rollupRequestCount.toString(), sessionSourceRequestCount.toString(),
         sessionRollupRequestCount.toString(), sourceTotal.toString(), rollupTotal.toString(),
         sessionSourceTotal.toString(), sessionRollupTotal.toString()],
      )
      await client.query('COMMIT')
      return { date, status: 'failed', reason: 'reconciliation_mismatch' }
    }
    await client.query(
      `UPDATE token_daily_closures
       SET status = 'sealed', source_fact_count = $2, source_request_count = $3,
           rollup_request_count = $3, session_source_request_count = $4,
           session_rollup_request_count = $4, source_total = $5, rollup_total = $5,
           session_source_total = $6, session_rollup_total = $6, sealed_at = NOW(),
           last_error = NULL, updated_at = NOW()
       WHERE date = $1::date`,
      [date, factCountExact.toString(), sourceRequestCount.toString(),
       sessionSourceRequestCount.toString(), sourceTotal.toString(), sessionSourceTotal.toString()],
    )
    await client.query('COMMIT')
    return {
      date,
      status: 'sealed',
      factCount: Number(factCountExact),
      total: Number(sourceTotal),
    }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function closeEligibleTokenUsageDays(
  pool: pg.Pool,
  now: Date = new Date(),
  limit = 31,
): Promise<TokenDayCloseResult[]> {
  // Give the inbox/materializer pipeline five minutes after UTC midnight to
  // drain events received immediately before the date cutoff. Before then,
  // only dates older than yesterday are eligible.
  const eligibleBefore = closeEligibleBefore(now)
  const candidates = await pool.query(
    `WITH candidate_dates AS (
       SELECT usage_date AS date
       FROM token_usage_facts
       WHERE usage_date < $1::date
       UNION
       SELECT (received_at AT TIME ZONE 'UTC')::date AS date
       FROM event_inbox
       WHERE received_at < ($1::date::timestamp AT TIME ZONE 'UTC')
       UNION
       SELECT date FROM token_daily_closures WHERE date < $1::date
     )
     SELECT candidates.date::text AS date
     FROM candidate_dates candidates
     LEFT JOIN token_daily_closures closure ON closure.date = candidates.date
     WHERE closure.status IS DISTINCT FROM 'sealed'
     ORDER BY candidates.date
     LIMIT $2`,
    [eligibleBefore, Math.max(1, Math.min(366, Math.trunc(limit)))],
  )
  const results: TokenDayCloseResult[] = []
  for (const row of candidates.rows) {
    results.push(await closeTokenUsageDay(pool, String(row.date), now))
  }
  return results
}
