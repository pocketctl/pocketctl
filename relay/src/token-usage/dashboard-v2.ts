import type pg from 'pg'

export interface TokenDashboardV2 {
  summary: { total: number; today: number; thisWeek: number; thisMonth: number }
  dailySeries: Array<{ date: string; input: number; output: number; cache_read: number; requests: number }>
  byModel: Array<{ model: string; input: number; output: number; cache_read: number; requests: number; total: number; pct: number }>
  byDaemon: Array<{ daemon_id: string; hostname: string; alias: string; input: number; output: number; cache_read: number; requests: number; total: number }>
}

function amount(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function dateString(value: unknown): string {
  if (value instanceof Date) {
    const year = value.getFullYear()
    const month = String(value.getMonth() + 1).padStart(2, '0')
    const day = String(value.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }
  return String(value ?? '').slice(0, 10)
}

/**
 * One-query Dashboard read path. Past dates are admitted only through sealed
 * rollups; the current UTC date comes only from immutable facts.
 */
export async function getTokenDashboardV2(
  pool: pg.Pool,
  userId: number,
  daemonId: string | null = null,
  days = 30,
): Promise<TokenDashboardV2> {
  const daemon = daemonId && daemonId !== 'all' ? daemonId : null
  const boundedDays = Math.max(1, Math.min(365, Math.trunc(days)))
  const result = await pool.query(
    `WITH utc AS (
       SELECT (NOW() AT TIME ZONE 'UTC')::date AS today
     ), historical AS (
       SELECT s.user_id, s.daemon_id, s.date, s.model,
              s.input, s.output, s.cache_read, s.cache_create, s.requests
       FROM token_daily_stats s
       JOIN token_daily_closures c ON c.date = s.date AND c.status = 'sealed'
       CROSS JOIN utc
       WHERE s.user_id = $1 AND s.date < utc.today
     ), live AS (
       SELECT f.user_id, f.daemon_id, f.usage_date AS date, f.model,
              SUM(f.input) AS input, SUM(f.output) AS output,
              SUM(f.cache_read) AS cache_read, SUM(f.cache_create) AS cache_create,
              SUM(f.requests) AS requests
       FROM token_usage_facts f CROSS JOIN utc
       WHERE f.user_id = $1 AND f.usage_date = utc.today
       GROUP BY f.user_id, f.daemon_id, f.usage_date, f.model
     ), all_buckets AS (
       SELECT * FROM historical
       UNION ALL
       SELECT * FROM live
     ), scoped AS (
       SELECT * FROM all_buckets WHERE ($2::text IS NULL OR daemon_id = $2)
     ), daily AS (
       SELECT date, SUM(input) AS input, SUM(output) AS output,
              SUM(cache_read) AS cache_read, SUM(requests) AS requests
       FROM scoped CROSS JOIN utc
       WHERE date >= utc.today - ($3::int - 1)
       GROUP BY date
     ), models AS (
       SELECT model, SUM(input) AS input, SUM(output) AS output,
              SUM(cache_read) AS cache_read, SUM(requests) AS requests
       FROM scoped GROUP BY model
     ), daemon_totals AS (
       SELECT b.daemon_id, SUM(b.input) AS input, SUM(b.output) AS output,
              SUM(b.cache_read) AS cache_read, SUM(b.requests) AS requests
       FROM all_buckets b GROUP BY b.daemon_id
     )
     SELECT
       jsonb_build_object(
         'total', COALESCE((SELECT SUM(input + output + cache_read + cache_create) FROM scoped), 0),
         'today', COALESCE((SELECT SUM(input + output + cache_read + cache_create) FROM scoped CROSS JOIN utc WHERE date = utc.today), 0),
         'this_week', COALESCE((SELECT SUM(input + output + cache_read + cache_create) FROM scoped CROSS JOIN utc WHERE date >= date_trunc('week', utc.today)::date), 0),
         'this_month', COALESCE((SELECT SUM(input + output + cache_read + cache_create) FROM scoped CROSS JOIN utc WHERE date >= date_trunc('month', utc.today)::date), 0)
       ) AS summary,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
           'date', date, 'input', input, 'output', output,
           'cache_read', cache_read, 'requests', requests
         ) ORDER BY date) FROM daily
       ), '[]'::jsonb) AS daily_series,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
           'model', model, 'input', input, 'output', output,
           'cache_read', cache_read, 'requests', requests
         ) ORDER BY input DESC, model) FROM models
       ), '[]'::jsonb) AS by_model,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
           'daemon_id', totals.daemon_id,
           'hostname', COALESCE(d.hostname, ''), 'alias', COALESCE(d.alias, ''),
           'input', totals.input, 'output', totals.output,
           'cache_read', totals.cache_read, 'requests', totals.requests
         ) ORDER BY totals.input DESC, totals.daemon_id)
         FROM daemon_totals totals
         LEFT JOIN daemons d ON d.daemon_id = totals.daemon_id
       ), '[]'::jsonb) AS by_daemon`,
    [userId, daemon, boundedDays],
  )
  const row = result.rows[0] ?? {}
  const summary = row.summary ?? {}
  const dailySeries: TokenDashboardV2['dailySeries'] = (Array.isArray(row.daily_series) ? row.daily_series : []).map((item: any) => ({
    date: dateString(item.date),
    input: amount(item.input),
    output: amount(item.output),
    cache_read: amount(item.cache_read),
    requests: amount(item.requests),
  }))
  const byModel: TokenDashboardV2['byModel'] = (Array.isArray(row.by_model) ? row.by_model : []).map((item: any) => ({
    model: String(item.model ?? 'unknown'),
    input: amount(item.input),
    output: amount(item.output),
    cache_read: amount(item.cache_read),
    requests: amount(item.requests),
    total: amount(item.input) + amount(item.output),
    pct: 0,
  }))
  const modelTotal = byModel.reduce((sum, item) => sum + item.total, 0)
  for (const item of byModel) {
    item.pct = modelTotal > 0 ? Number((item.total / modelTotal * 100).toFixed(1)) : 0
  }
  const byDaemon: TokenDashboardV2['byDaemon'] = (Array.isArray(row.by_daemon) ? row.by_daemon : []).map((item: any) => ({
    daemon_id: String(item.daemon_id ?? ''),
    hostname: String(item.hostname ?? ''),
    alias: String(item.alias ?? ''),
    input: amount(item.input),
    output: amount(item.output),
    cache_read: amount(item.cache_read),
    requests: amount(item.requests),
    total: amount(item.input) + amount(item.output),
  }))
  return {
    summary: {
      total: amount(summary.total),
      today: amount(summary.today),
      thisWeek: amount(summary.this_week),
      thisMonth: amount(summary.this_month),
    },
    dailySeries,
    byModel,
    byDaemon,
  }
}

/** Per-session trend backed by immutable facts instead of retained events. */
export async function getSessionTokenTrendV2(
  pool: pg.Pool,
  userId: number,
  sessionId: string,
  days = 30,
): Promise<Array<{ date: string; input: number; output: number; cache_read: number; requests: number }>> {
  const boundedDays = Math.max(1, Math.min(365, Math.trunc(days)))
  const result = await pool.query(
    `WITH utc AS (SELECT (NOW() AT TIME ZONE 'UTC')::date AS today),
     historical AS (
       SELECT s.date, s.input, s.output, s.cache_read, s.requests
       FROM token_session_daily_stats s
       JOIN token_daily_closures c ON c.date = s.date AND c.status = 'sealed'
       CROSS JOIN utc
       WHERE s.user_id = $1 AND s.session_id = $2 AND s.date < utc.today
     ), live AS (
       SELECT f.usage_date AS date, SUM(f.input) AS input, SUM(f.output) AS output,
              SUM(f.cache_read) AS cache_read, SUM(f.requests) AS requests
       FROM token_usage_facts f CROSS JOIN utc
       WHERE f.user_id = $1 AND f.session_id = $2
         AND f.session_attribution_revoked = false AND f.usage_date = utc.today
       GROUP BY f.usage_date
     )
     SELECT date, SUM(input) AS input, SUM(output) AS output,
            SUM(cache_read) AS cache_read, SUM(requests) AS requests
     FROM (SELECT * FROM historical UNION ALL SELECT * FROM live) buckets
     CROSS JOIN utc
     WHERE date >= utc.today - ($3::int - 1)
     GROUP BY date ORDER BY date`,
    [userId, sessionId, boundedDays],
  )
  return result.rows.map((row: any) => ({
    date: dateString(row.date),
    input: amount(row.input),
    output: amount(row.output),
    cache_read: amount(row.cache_read),
    requests: amount(row.requests),
  }))
}

/** Current UTC day agent split for the daemon detail view. */
export async function getTodayTokenUsageByAgentV2(
  pool: pg.Pool,
  userId: number,
  daemonId: string,
): Promise<Array<{ agent_type: string; today: number }>> {
  const result = await pool.query(
    `SELECT agent_type,
            SUM(input + output + cache_read + cache_create) AS today
     FROM token_usage_facts
     WHERE user_id = $1 AND daemon_id = $2
       AND usage_date = (NOW() AT TIME ZONE 'UTC')::date
     GROUP BY agent_type`,
    [userId, daemonId],
  )
  return result.rows.map((row: any) => ({
    agent_type: String(row.agent_type ?? 'unknown'),
    today: amount(row.today),
  }))
}

function reportTotals(row: any): { total: number; requests: number } | null {
  const total = amount(row?.total)
  const requests = amount(row?.requests)
  return total === 0 && requests === 0 ? null : { total, requests }
}

export async function getUserDailyTokensV2(
  pool: pg.Pool,
  userId: number,
  date: string,
): Promise<{ total: number; requests: number } | null> {
  const result = await pool.query(
    `SELECT COALESCE(SUM(s.input + s.output + s.cache_read + s.cache_create), 0) AS total,
            COALESCE(SUM(s.requests), 0) AS requests
     FROM token_daily_stats s
     JOIN token_daily_closures c ON c.date = s.date AND c.status = 'sealed'
     WHERE s.user_id = $1 AND s.date = $2::date`,
    [userId, date],
  )
  return reportTotals(result.rows[0])
}

export async function getUserWeeklyTokensV2(
  pool: pg.Pool,
  userId: number,
  weekEndDate: string,
): Promise<{ total: number; requests: number } | null> {
  const result = await pool.query(
    `WITH unresolved_fact_date AS (
       SELECT 1
       FROM token_usage_facts f
       LEFT JOIN token_daily_closures c ON c.date = f.usage_date
       WHERE f.user_id = $1
         AND f.usage_date > ($2::date - 7) AND f.usage_date <= $2::date
         AND c.status IS DISTINCT FROM 'sealed'
       LIMIT 1
     )
     SELECT COALESCE(SUM(s.input + s.output + s.cache_read + s.cache_create), 0) AS total,
            COALESCE(SUM(s.requests), 0) AS requests
     FROM token_daily_stats s
     JOIN token_daily_closures c ON c.date = s.date AND c.status = 'sealed'
     WHERE s.user_id = $1
       AND s.date > ($2::date - 7) AND s.date <= $2::date
       AND NOT EXISTS (SELECT 1 FROM unresolved_fact_date)`,
    [userId, weekEndDate],
  )
  return reportTotals(result.rows[0])
}
