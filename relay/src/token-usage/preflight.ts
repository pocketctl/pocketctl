import type pg from 'pg'

export interface TokenUsagePreflightOptions {
  now?: Date
  acceptLegacyHistory?: boolean
}

export interface TokenUsageHistoryComparison {
  date: string
  statsRequests: number
  statsTotal: number
  eventRequests: number
  eventTotal: number
}

export interface TokenUsagePreflightReport {
  generatedAt: string
  todayUtc: string
  baseline: { status: 'absent' | 'completed'; completedAt: string | null }
  historicalInbox: { pending: number; claimed: number; deadLetter: number }
  facts: { postBaselineCompletedUsageMissing: number }
  scanEstimate: {
    retainedUsageEvents: number
    retainedUsageDays: number
    legacyDailyRows: number
    legacyDays: number
    eventsBytes: number
    inboxBytes: number
  }
  legacyComparison: {
    comparableDays: number
    mismatchedDays: number
    accepted: boolean
    samples: TokenUsageHistoryComparison[]
  }
  blockers: string[]
  warnings: string[]
  ready: boolean
}

function safeInteger(value: unknown, field: string): number {
  const text = String(value ?? '0')
  if (!/^\d+$/.test(text)) throw new Error(`token usage preflight ${field} is not an unsigned integer`)
  const parsed = Number(text)
  if (!Number.isSafeInteger(parsed)) throw new Error(`token usage preflight ${field} exceeds safe integer range`)
  return parsed
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const date = value instanceof Date ? value : new Date(String(value))
  if (Number.isNaN(date.getTime())) throw new Error('token usage preflight baseline timestamp is invalid')
  return date.toISOString()
}

/** Inspect the accounting cutover from one read-only repeatable snapshot. */
export async function inspectTokenUsageMigration(
  pool: pg.Pool,
  options: TokenUsagePreflightOptions = {},
): Promise<TokenUsagePreflightReport> {
  const now = options.now ?? new Date()
  const today = now.toISOString().slice(0, 10)
  const client = await pool.connect()
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const baselineResult = await client.query(
      `SELECT completed_at
       FROM token_usage_accounting_state
       WHERE key = 'baseline-v1'
       LIMIT 1`,
    )
    const completedAt = iso(baselineResult.rows[0]?.completed_at)
    const baselineCompleted = completedAt !== null

    const inboxResult = await client.query(
      `SELECT
         COUNT(*) FILTER (
           WHERE inbox.received_at < ($1::date::timestamp AT TIME ZONE 'UTC')
             AND inbox.status = 0
             AND ($2::timestamptz IS NULL OR closure.status IS DISTINCT FROM 'sealed')
         ) AS historical_pending,
         COUNT(*) FILTER (
           WHERE inbox.received_at < ($1::date::timestamp AT TIME ZONE 'UTC')
             AND inbox.status = 1
             AND ($2::timestamptz IS NULL OR closure.status IS DISTINCT FROM 'sealed')
         ) AS historical_claimed,
         COUNT(*) FILTER (
           WHERE inbox.received_at < ($1::date::timestamp AT TIME ZONE 'UTC')
             AND inbox.status = 3
             AND ($2::timestamptz IS NULL OR closure.status IS DISTINCT FROM 'sealed')
         ) AS historical_dead_letter,
         COUNT(*) FILTER (
           WHERE $2::timestamptz IS NOT NULL
             AND inbox.received_at >= $2::timestamptz
             AND inbox.status = 2
             AND inbox.event_type = 'agent_text'
             AND inbox.payload ? 'usage'
             AND NOT EXISTS (
               SELECT 1
               FROM token_usage_facts fact
               WHERE fact.fact_key = 'inbox:' || inbox.inbox_id
                  OR (inbox.materialized_event_id IS NOT NULL
                      AND fact.source_event_id = inbox.materialized_event_id)
             )
         ) AS missing_usage_facts
       FROM event_inbox inbox
       LEFT JOIN token_daily_closures closure
         ON closure.date = (inbox.received_at AT TIME ZONE 'UTC')::date`,
      [today, completedAt],
    )
    const inbox = inboxResult.rows[0] ?? {}

    const volumeResult = await client.query(
      `SELECT
         (SELECT COUNT(*) FROM events
          WHERE event_type = 'agent_text' AND payload ? 'usage') AS retained_usage_events,
         (SELECT COUNT(DISTINCT (created_at AT TIME ZONE 'UTC')::date) FROM events
          WHERE event_type = 'agent_text' AND payload ? 'usage') AS retained_usage_days,
         (SELECT COUNT(*) FROM token_daily_stats) AS legacy_daily_rows,
         (SELECT COUNT(DISTINCT date) FROM token_daily_stats) AS legacy_days,
         pg_total_relation_size('events') AS events_bytes,
         pg_total_relation_size('event_inbox') AS inbox_bytes`,
    )
    const volume = volumeResult.rows[0] ?? {}

    const comparisonResult = await client.query(
      `WITH stats AS (
         SELECT date, SUM(requests)::bigint AS stats_requests,
                SUM(input + output + cache_read + cache_create)::bigint AS stats_total
         FROM token_daily_stats
         WHERE date < $1::date
         GROUP BY date
       ), retained_events AS (
         SELECT (created_at AT TIME ZONE 'UTC')::date AS date,
                COUNT(*)::bigint AS event_requests,
                SUM(
                  GREATEST(COALESCE((payload->'usage'->>'input_tokens')::bigint, 0), 0)
                  + GREATEST(COALESCE((payload->'usage'->>'output_tokens')::bigint, 0), 0)
                  + GREATEST(COALESCE((payload->'usage'->>'cache_read_tokens')::bigint, 0), 0)
                  + GREATEST(COALESCE((payload->'usage'->>'cache_create_tokens')::bigint, 0), 0)
                )::bigint AS event_total
         FROM events
         WHERE event_type = 'agent_text' AND payload ? 'usage'
           AND (created_at AT TIME ZONE 'UTC')::date < $1::date
         GROUP BY (created_at AT TIME ZONE 'UTC')::date
       )
       SELECT stats.date::text AS date, stats.stats_requests, stats.stats_total,
              retained_events.event_requests, retained_events.event_total
       FROM stats
       JOIN retained_events USING (date)
       ORDER BY stats.date DESC`,
      [today],
    )
    const comparisons: TokenUsageHistoryComparison[] = comparisonResult.rows.map((row) => ({
      date: String(row.date),
      statsRequests: safeInteger(row.stats_requests, 'stats requests'),
      statsTotal: safeInteger(row.stats_total, 'stats total'),
      eventRequests: safeInteger(row.event_requests, 'event requests'),
      eventTotal: safeInteger(row.event_total, 'event total'),
    }))
    const mismatches = comparisons.filter((row) => row.statsRequests !== row.eventRequests
      || row.statsTotal !== row.eventTotal)
    const accepted = baselineCompleted || mismatches.length === 0 || options.acceptLegacyHistory === true

    const historicalInbox = {
      pending: safeInteger(inbox.historical_pending, 'historical pending'),
      claimed: safeInteger(inbox.historical_claimed, 'historical claimed'),
      deadLetter: safeInteger(inbox.historical_dead_letter, 'historical dead letter'),
    }
    const missingUsageFacts = safeInteger(inbox.missing_usage_facts, 'missing usage facts')
    const scanEstimate = {
      retainedUsageEvents: safeInteger(volume.retained_usage_events, 'retained usage events'),
      retainedUsageDays: safeInteger(volume.retained_usage_days, 'retained usage days'),
      legacyDailyRows: safeInteger(volume.legacy_daily_rows, 'legacy daily rows'),
      legacyDays: safeInteger(volume.legacy_days, 'legacy days'),
      eventsBytes: safeInteger(volume.events_bytes, 'events bytes'),
      inboxBytes: safeInteger(volume.inbox_bytes, 'inbox bytes'),
    }
    const blockers: string[] = []
    if (historicalInbox.pending > 0) blockers.push('historical_pending_inbox')
    if (historicalInbox.claimed > 0) blockers.push('historical_claimed_inbox')
    if (historicalInbox.deadLetter > 0) blockers.push('historical_dead_letter')
    if (missingUsageFacts > 0) blockers.push('post_baseline_missing_usage_facts')
    if (!accepted) blockers.push('legacy_history_review_required')
    const warnings: string[] = []
    if (mismatches.length > 0) warnings.push('legacy_history_differs_from_retained_events')
    if (scanEstimate.retainedUsageEvents >= 100_000) warnings.push('large_retained_event_scan')

    const report: TokenUsagePreflightReport = {
      generatedAt: now.toISOString(),
      todayUtc: today,
      baseline: {
        status: baselineCompleted ? 'completed' : 'absent',
        completedAt,
      },
      historicalInbox,
      facts: { postBaselineCompletedUsageMissing: missingUsageFacts },
      scanEstimate,
      legacyComparison: {
        comparableDays: comparisons.length,
        mismatchedDays: mismatches.length,
        accepted,
        samples: mismatches.slice(0, 31),
      },
      blockers,
      warnings,
      ready: blockers.length === 0,
    }
    await client.query('COMMIT')
    return report
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // Preserve the inspection failure.
    }
    throw error
  } finally {
    client.release()
  }
}
