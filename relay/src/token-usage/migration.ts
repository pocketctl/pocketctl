import type pg from 'pg'

export interface TokenUsageMigrationResult {
  adoptedHistoricalDays: number
  backfilledEventFacts: number
  syntheticCurrentFacts: number
  backfilledSessionRollups: number
}

function utcDate(now: Date): string {
  return now.toISOString().slice(0, 10)
}

/**
 * Establishes the V2 accounting baseline in one transaction:
 *
 * 1. Existing past-day rollups are already historical truth, so adopt them as
 *    sealed without rebuilding them from retention-limited events.
 * 2. Backfill retained events only for dates that are not sealed.
 * 3. Convert current-day legacy deletion compensation rows into synthetic
 *    facts. The length-prefixed key is deterministic and collision-free for
 *    the row's user/daemon/model dimensions.
 */
export async function migrateTokenUsageAccounting(
  pool: pg.Pool,
  now: Date = new Date(),
): Promise<TokenUsageMigrationResult> {
  const today = utcDate(now)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('token-usage-accounting-global'))`)
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('token-usage-baseline-v1'))`)
    const unresolved = await client.query(
      `SELECT COUNT(*) AS count
       FROM event_inbox
       WHERE received_at < ($1::date::timestamp AT TIME ZONE 'UTC')
         AND status IN (0, 1, 3)`,
      [today],
    )
    if (BigInt(String(unresolved.rows[0]?.count ?? 0)) > 0n) {
      throw new Error('token usage baseline blocked by unresolved historical inbox rows')
    }
    const baseline = await client.query(
      `INSERT INTO token_usage_accounting_state (key, completed_at)
       VALUES ('baseline-v1', NOW())
       ON CONFLICT (key) DO NOTHING
       RETURNING key`,
    )
    const firstBaseline = (baseline.rowCount ?? 0) > 0
    const adopted = firstBaseline ? await client.query(
      `INSERT INTO token_daily_closures (
         date, status, cutoff_at, source_fact_count, source_request_count,
         rollup_request_count, source_total, rollup_total, sealed_at, updated_at
       )
       SELECT date, 'sealed', ((date + 1)::timestamp AT TIME ZONE 'UTC'),
              0, SUM(requests), SUM(requests),
              SUM(input + output + cache_read + cache_create),
              SUM(input + output + cache_read + cache_create), NOW(), NOW()
       FROM token_daily_stats
       WHERE date < $1::date
       GROUP BY date
      ON CONFLICT (date) DO NOTHING`,
      [today],
    ) : { rowCount: 0 }
    const events = await client.query(
       `INSERT INTO token_usage_facts (
         fact_key, source_event_id, user_id, daemon_id, session_id,
         agent_type, model, usage_date, recorded_at, input, output,
         cache_read, cache_create, reasoning, reported_total, requests
       )
       SELECT 'event:' || e.id, e.id, s.user_id, s.daemon_id, e.session_id,
              COALESCE(NULLIF(s.agent_type, ''), 'unknown'),
              COALESCE(NULLIF(s.model, ''), 'unknown'),
              (e.created_at AT TIME ZONE 'UTC')::date, e.created_at,
              GREATEST(COALESCE((e.payload->'usage'->>'input_tokens')::bigint, 0), 0),
              GREATEST(COALESCE((e.payload->'usage'->>'output_tokens')::bigint, 0), 0),
              GREATEST(COALESCE((e.payload->'usage'->>'cache_read_tokens')::bigint, 0), 0),
              GREATEST(COALESCE((e.payload->'usage'->>'cache_create_tokens')::bigint, 0), 0),
              GREATEST(COALESCE((e.payload->'usage'->>'reasoning_tokens')::bigint, 0), 0),
              GREATEST(COALESCE((e.payload->'usage'->>'total_tokens')::bigint, 0), 0),
              1
       FROM events e
       JOIN sessions s ON s.session_id = e.session_id
       WHERE e.event_type = 'agent_text' AND e.payload ? 'usage'
         AND s.user_id IS NOT NULL AND s.daemon_id IS NOT NULL
         AND (e.created_at AT TIME ZONE 'UTC')::date <= $1::date
         AND NOT EXISTS (
           SELECT 1 FROM token_daily_closures c
           WHERE c.date = (e.created_at AT TIME ZONE 'UTC')::date
             AND c.status = 'sealed'
         )
       ON CONFLICT DO NOTHING`,
      [today],
    )
    const synthetic = firstBaseline ? await client.query(
      `INSERT INTO token_usage_facts (
         fact_key, source_event_id, user_id, daemon_id, session_id,
         session_attribution_revoked, agent_type, model, usage_date, recorded_at, input, output,
         cache_read, cache_create, reasoning, reported_total, requests
       )
       SELECT 'legacy-daily:' || user_id || ':' || length(daemon_id) || ':' || daemon_id
                || ':' || length(model) || ':' || model || ':' || date,
              NULL, user_id, daemon_id, 'legacy-daily:' || date,
              true, 'unknown', model, date, (date::timestamp AT TIME ZONE 'UTC'),
              input, output, cache_read, cache_create, 0,
              input + output + cache_read + cache_create, requests
       FROM token_daily_stats
       WHERE date = $1::date
       ON CONFLICT DO NOTHING`,
      [today],
    ) : { rowCount: 0 }
    const sessionRollups = await client.query(
      `INSERT INTO token_session_daily_stats (
         user_id, session_id, date, input, output, cache_read, cache_create, requests
       )
       SELECT s.user_id, e.session_id, (e.created_at AT TIME ZONE 'UTC')::date,
              SUM(GREATEST(COALESCE((e.payload->'usage'->>'input_tokens')::bigint, 0), 0)),
              SUM(GREATEST(COALESCE((e.payload->'usage'->>'output_tokens')::bigint, 0), 0)),
              SUM(GREATEST(COALESCE((e.payload->'usage'->>'cache_read_tokens')::bigint, 0), 0)),
              SUM(GREATEST(COALESCE((e.payload->'usage'->>'cache_create_tokens')::bigint, 0), 0)),
              COUNT(*)
       FROM events e
       JOIN sessions s ON s.session_id = e.session_id
       WHERE e.event_type = 'agent_text' AND e.payload ? 'usage'
         AND s.user_id IS NOT NULL
         AND (e.created_at AT TIME ZONE 'UTC')::date < $1::date
       GROUP BY s.user_id, e.session_id, (e.created_at AT TIME ZONE 'UTC')::date
       ON CONFLICT (user_id, session_id, date) DO NOTHING`,
      [today],
    )
    await client.query('COMMIT')
    return {
      adoptedHistoricalDays: adopted.rowCount ?? 0,
      backfilledEventFacts: events.rowCount ?? 0,
      syntheticCurrentFacts: synthetic.rowCount ?? 0,
      backfilledSessionRollups: sessionRollups.rowCount ?? 0,
    }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
