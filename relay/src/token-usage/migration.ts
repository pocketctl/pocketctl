import type pg from 'pg'

export interface TokenUsageMigrationResult {
  adoptedHistoricalDays: number
  backfilledEventFacts: number
  syntheticCurrentFacts: number
  backfilledSessionRollups: number
}

export interface TokenUsageMigrationOptions {
  eventBatchSize?: number
  statementTimeoutMs?: number
}

const EMPTY_MIGRATION_RESULT: TokenUsageMigrationResult = {
  adoptedHistoricalDays: 0,
  backfilledEventFacts: 0,
  syntheticCurrentFacts: 0,
  backfilledSessionRollups: 0,
}

function utcDate(now: Date): string {
  return now.toISOString().slice(0, 10)
}

function boundedPositive(value: number | undefined, fallback: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value ?? 0) <= 0) return fallback
  return Math.min(maximum, value as number)
}

function bigint(value: unknown, field: string): bigint {
  const text = String(value ?? '0')
  if (!/^\d+$/.test(text)) throw new Error(`token usage migration ${field} is not an unsigned integer`)
  return BigInt(text)
}

async function unresolvedHistoricalInbox(client: pg.PoolClient, today: string): Promise<bigint> {
  const unresolved = await client.query(
    `SELECT COUNT(*) AS count
     FROM event_inbox
     WHERE received_at < ($1::date::timestamp AT TIME ZONE 'UTC')
       AND status IN (0, 1, 3)`,
    [today],
  )
  return bigint(unresolved.rows[0]?.count, 'unresolved inbox count')
}

/**
 * Establish the V2 baseline with short, restart-safe batches.
 *
 * Facts and per-date session rollups are idempotent progress: an interrupted
 * run leaves the baseline absent, and the next run only fills missing facts or
 * rollups. The final transaction briefly fences event/inbox writers, validates
 * complete coverage, adopts legacy daily truth, and publishes baseline-v1.
 */
export async function migrateTokenUsageAccounting(
  pool: pg.Pool,
  now: Date = new Date(),
  options: TokenUsageMigrationOptions = {},
): Promise<TokenUsageMigrationResult> {
  const today = utcDate(now)
  const eventBatchSize = boundedPositive(options.eventBatchSize, 1_000, 10_000)
  const statementTimeoutMs = boundedPositive(options.statementTimeoutMs, 120_000, 900_000)
  const client = await pool.connect()
  let transactionOpen = false
  let migrationLockHeld = false
  let backfilledEventFacts = 0
  let backfilledSessionRollups = 0
  try {
    await client.query(`SELECT pg_advisory_lock(hashtext('token-usage-baseline-v1'))`)
    migrationLockHeld = true
    await client.query(`SELECT set_config('statement_timeout', $1, false)`, [String(statementTimeoutMs)])

    await client.query('BEGIN')
    transactionOpen = true
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('token-usage-accounting-global'))`)
    const completed = await client.query(
      `SELECT key FROM token_usage_accounting_state WHERE key = 'baseline-v1' LIMIT 1`,
    )
    if ((completed.rowCount ?? completed.rows.length) > 0) {
      await client.query('COMMIT')
      transactionOpen = false
      return { ...EMPTY_MIGRATION_RESULT }
    }
    if (await unresolvedHistoricalInbox(client, today) > 0n) {
      throw new Error('token usage baseline blocked by unresolved historical inbox rows')
    }
    const highWaterResult = await client.query(
      `SELECT COALESCE(MAX(id), 0) AS high_water, NOW() AS started_at FROM events`,
    )
    const eventHighWater = bigint(highWaterResult.rows[0]?.high_water, 'event high water')
    const migrationStartedAt = highWaterResult.rows[0]?.started_at instanceof Date
      ? highWaterResult.rows[0].started_at.toISOString()
      : String(highWaterResult.rows[0]?.started_at ?? now.toISOString())
    await client.query('COMMIT')
    transactionOpen = false

    let eventCursor = 0n
    while (eventCursor < eventHighWater) {
      await client.query('BEGIN')
      transactionOpen = true
      const page = await client.query(
        `WITH page AS MATERIALIZED (
           SELECT id
           FROM events
           WHERE id > $1::bigint AND id <= $2::bigint
           ORDER BY id
           LIMIT $3
         ), inserted AS (
           INSERT INTO token_usage_facts (
             fact_key, source_event_id, user_id, daemon_id, session_id,
             agent_type, model, usage_date, recorded_at, input, output,
             cache_read, cache_create, reasoning, reported_total, requests
           )
           SELECT 'event:' || event.id, event.id, session.user_id, session.daemon_id,
                  event.session_id, COALESCE(NULLIF(session.agent_type, ''), 'unknown'),
                  COALESCE(NULLIF(session.model, ''), 'unknown'),
                  (event.created_at AT TIME ZONE 'UTC')::date, event.created_at,
                  GREATEST(COALESCE((event.payload->'usage'->>'input_tokens')::bigint, 0), 0),
                  GREATEST(COALESCE((event.payload->'usage'->>'output_tokens')::bigint, 0), 0),
                  GREATEST(COALESCE((event.payload->'usage'->>'cache_read_tokens')::bigint, 0), 0),
                  GREATEST(COALESCE((event.payload->'usage'->>'cache_create_tokens')::bigint, 0), 0),
                  GREATEST(COALESCE((event.payload->'usage'->>'reasoning_tokens')::bigint, 0), 0),
                  GREATEST(COALESCE((event.payload->'usage'->>'total_tokens')::bigint, 0), 0),
                  1
           FROM page
           JOIN events event USING (id)
           JOIN sessions session ON session.session_id = event.session_id
           WHERE event.event_type = 'agent_text' AND event.payload ? 'usage'
             AND session.user_id IS NOT NULL AND session.daemon_id IS NOT NULL
           ON CONFLICT DO NOTHING
           RETURNING 1
         )
         SELECT COALESCE(MAX(page.id), $1::bigint) AS next_cursor,
                (SELECT COUNT(*) FROM inserted) AS inserted
         FROM page`,
        [eventCursor.toString(), eventHighWater.toString(), eventBatchSize],
      )
      const nextCursor = bigint(page.rows[0]?.next_cursor, 'event cursor')
      const inserted = bigint(page.rows[0]?.inserted, 'inserted fact count')
      if (nextCursor <= eventCursor) {
        throw new Error('token usage migration event cursor did not advance')
      }
      backfilledEventFacts += Number(inserted)
      eventCursor = nextCursor
      await client.query('COMMIT')
      transactionOpen = false
    }

    const sessionDates = await client.query(
      `SELECT DISTINCT usage_date::text AS usage_date
       FROM token_usage_facts
       WHERE usage_date < $1::date AND session_attribution_revoked = false
       ORDER BY usage_date`,
      [today],
    )
    for (const row of sessionDates.rows) {
      await client.query('BEGIN')
      transactionOpen = true
      const rollup = await client.query(
        `INSERT INTO token_session_daily_stats (
           user_id, session_id, date, input, output, cache_read, cache_create, requests
         )
         SELECT user_id, session_id, usage_date,
                SUM(input), SUM(output), SUM(cache_read), SUM(cache_create), SUM(requests)
         FROM token_usage_facts
         WHERE usage_date = $1::date AND session_attribution_revoked = false
         GROUP BY user_id, session_id, usage_date
         ON CONFLICT (user_id, session_id, date) DO NOTHING`,
        [String(row.usage_date)],
      )
      backfilledSessionRollups += rollup.rowCount ?? 0
      await client.query('COMMIT')
      transactionOpen = false
    }

    await client.query('BEGIN')
    transactionOpen = true
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('token-usage-accounting-global'))`)
    // These locks are deliberately short: they only cover final coverage
    // validation plus publication of the baseline marker and adopted closures.
    await client.query(`LOCK TABLE events IN SHARE MODE`)
    await client.query(`LOCK TABLE event_inbox IN SHARE MODE`)
    if (await unresolvedHistoricalInbox(client, today) > 0n) {
      throw new Error('token usage baseline blocked by unresolved historical inbox rows')
    }
    const coverage = await client.query(
      `SELECT
         (SELECT COUNT(*)
          FROM events event
          JOIN sessions session ON session.session_id = event.session_id
          LEFT JOIN token_usage_facts fact ON fact.source_event_id = event.id
          WHERE event.event_type = 'agent_text' AND event.payload ? 'usage'
            AND session.user_id IS NOT NULL AND session.daemon_id IS NOT NULL
            AND fact.source_event_id IS NULL) AS missing_event_facts,
         (SELECT COUNT(*)
          FROM event_inbox inbox
          WHERE inbox.received_at >= $1::timestamptz
            AND inbox.status = 2 AND inbox.event_type = 'agent_text'
            AND inbox.payload ? 'usage'
            AND NOT EXISTS (
              SELECT 1 FROM token_usage_facts fact
              WHERE fact.fact_key = 'inbox:' || inbox.inbox_id
                 OR (inbox.materialized_event_id IS NOT NULL
                     AND fact.source_event_id = inbox.materialized_event_id)
            )) AS missing_inbox_facts`,
      [migrationStartedAt],
    )
    if (bigint(coverage.rows[0]?.missing_event_facts, 'missing event facts') > 0n
      || bigint(coverage.rows[0]?.missing_inbox_facts, 'missing inbox facts') > 0n) {
      throw new Error('token usage baseline blocked by incomplete usage fact coverage')
    }
    const adopted = await client.query(
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
    )
    const synthetic = await client.query(
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
    )
    const baseline = await client.query(
      `INSERT INTO token_usage_accounting_state (key, completed_at)
       VALUES ('baseline-v1', NOW())
       ON CONFLICT (key) DO NOTHING
       RETURNING key`,
    )
    if ((baseline.rowCount ?? baseline.rows.length) !== 1) {
      throw new Error('token usage baseline publication lost its migration lock')
    }
    await client.query('COMMIT')
    transactionOpen = false
    return {
      adoptedHistoricalDays: adopted.rowCount ?? 0,
      backfilledEventFacts,
      syntheticCurrentFacts: synthetic.rowCount ?? 0,
      backfilledSessionRollups,
    }
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // Preserve the migration failure.
      }
    }
    throw error
  } finally {
    if (migrationLockHeld) {
      try {
        await client.query(`SELECT pg_advisory_unlock(hashtext('token-usage-baseline-v1'))`)
      } catch {
        // Releasing the client also releases session-level advisory locks.
      }
    }
    client.release()
  }
}
