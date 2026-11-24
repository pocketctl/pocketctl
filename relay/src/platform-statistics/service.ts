import type { Pool, PoolClient } from 'pg'
import { COLLECTOR_LEASE_MS, COLLECTOR_METRICS, type CollectorChannel } from './collector.js'
import type { StatisticsConfig } from './config.js'
import { addDays, dateStart, type StatisticsRange } from './range.js'
import type { DailyMetrics, MemoryActor, MemoryPeriod, MemoryReader, MemorySnapshot, Metric, MetricKey, Metrics, StatisticsResponse } from './types.js'

const KEYS: MetricKey[] = ['newUsers', 'activeUsers', 'sessions', 'memory', 'memoryUsers', 'readRequests']
const unavailable = (reason: string): Metric => ({ value: null, status: 'unavailable', coverageStart: null, reason })
interface Gap { metric: string; starts_at: Date | string; ends_at: Date | string }
interface Counts { newUsers: number; activeUsers: number; sessions: number }
interface Coverage { metric: string; starts_at: Date | string }
function metric(value: number, coverageStart: string | null, start: string, end: string, gaps: Gap[], key: MetricKey, dataThrough: string, extraReason?: string): Metric {
  if (!coverageStart) return unavailable('source_coverage_unknown')
  const from = Date.parse(start), to = Date.parse(end), first = Date.parse(coverageStart)
  if (first >= to) return { value: null, status: 'unavailable', coverageStart, reason: 'before_forward_coverage' }
  // Missing attribution or a failed source makes the computed population unreliable.
  if (extraReason) return { value: null, status: 'partial', coverageStart, reason: extraReason }

  const through = Date.parse(dataThrough)
  const coveredEnd = Math.min(to, through)
  let cursor = Math.max(from, first)
  let hasGap = false
  // Gaps arrive sorted by start. Advance across overlapping outages until the
  // first observed instant, so a wholly unobserved window never reports zero.
  for (const gap of gaps) {
    if (gap.metric !== key) continue
    const gapStart = new Date(gap.starts_at).getTime(), gapEnd = new Date(gap.ends_at).getTime()
    if (gapStart >= to) break
    if (gapEnd <= from) continue
    hasGap = true
    if (gapStart > cursor) break
    cursor = Math.max(cursor, gapEnd)
  }
  const reason = first > from ? 'before_forward_coverage' : hasGap ? 'coverage_gap'
    : through < to ? 'source_cutoff_incomplete' : undefined
  if (!reason) return { value, status: 'complete', coverageStart }
  return { value: value > 0 || cursor < coveredEnd ? value : null, status: 'partial', coverageStart, reason }
}
function latest(...values: Array<string | null>): string | null {
  return values.some(value => !value) ? null : new Date(Math.max(...values.map(value => Date.parse(value!)))).toISOString()
}
function validSnapshot(snapshot: MemorySnapshot): boolean {
  const number = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0
  const uuid = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  const actor = (value: MemoryActor) => uuid(value.installationId) && (value.membershipId === undefined || uuid(value.membershipId)) && number(value.readRequests) && number(value.writeRequests) && (value.humanActivity === undefined || typeof value.humanActivity === 'boolean')
  return !!snapshot && Number.isFinite(Date.parse(snapshot.dataThrough)) && (snapshot.coverageStart === null || Number.isFinite(Date.parse(snapshot.coverageStart)))
    && typeof snapshot.actorLimitExceeded === 'boolean'
    && Array.isArray(snapshot.gaps) && snapshot.gaps.length <= 20000 && snapshot.gaps.every(gap => ['memory', 'usage'].includes(gap.metric) && Number.isFinite(Date.parse(gap.from)) && Number.isFinite(Date.parse(gap.to)) && Date.parse(gap.from) < Date.parse(gap.to))
    && [snapshot.periods?.current, snapshot.periods?.previous].every(period => period && ['memory','automatic','manual','unclassified'].every(key => number(period[key as keyof MemoryPeriod]))
      && Array.isArray(period.daily) && period.daily.length <= 90 && period.daily.every(day => /^\d{4}-\d{2}-\d{2}$/.test(day.date) && ['memory','automatic','manual','unclassified'].every(key => number(day[key as keyof typeof day])))
      && Array.isArray(period.actors) && period.actors.length <= 20000 && period.actors.every(actor)
      && Array.isArray(period.dailyActors) && period.dailyActors.length <= 20000 && period.dailyActors.every(value => actor(value) && /^\d{4}-\d{2}-\d{2}$/.test(value.date)))
}

async function relayCounts(client: PoolClient, bins: Array<{ start: string; end: string; humanIds: number[] }>, excludedIds: number[]): Promise<Map<string, Counts>> {
  // The period distinct is computed from the complete bounded interval, never
  // by summing daily distinct counts. Memory human IDs join the same union.
  const result = await client.query<{ bucket: string; new_users: string; active_users: string; sessions: string }>(`
    WITH bins AS (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS bins(bucket text,start_at timestamptz,end_at timestamptz,human_ids jsonb)
    ), scoped AS (
      SELECT bins.bucket,f.kind,f.user_id,f.session_id FROM bins JOIN platform_statistics_facts f
        ON f.occurred_at >= bins.start_at AND f.occurred_at < bins.end_at
      WHERE NOT f.user_id=ANY($2::int[])
    ), humans AS (
      SELECT bucket,user_id FROM scoped WHERE kind='human'
      UNION SELECT bucket,actor.value::int FROM bins CROSS JOIN LATERAL jsonb_array_elements_text(human_ids) actor(value)
    ), fact_counts AS (
      SELECT bucket,count(DISTINCT user_id) FILTER(WHERE kind='registration') AS new_users,
        count(DISTINCT session_id) FILTER(WHERE kind='session') AS sessions FROM scoped GROUP BY bucket
    ), human_counts AS (
      SELECT bucket,count(DISTINCT user_id) AS active_users FROM humans GROUP BY bucket
    ) SELECT bins.bucket,COALESCE(fact_counts.new_users,0) AS new_users,
      COALESCE(human_counts.active_users,0) AS active_users,COALESCE(fact_counts.sessions,0) AS sessions
      FROM bins LEFT JOIN fact_counts USING(bucket) LEFT JOIN human_counts USING(bucket)`,
  [JSON.stringify(bins.map(bin => ({ bucket: `${bin.start}/${bin.end}`,start_at: bin.start,end_at: bin.end,human_ids: bin.humanIds }))), excludedIds])
  return new Map(result.rows.map(row => [row.bucket, { newUsers: Number(row.new_users), activeUsers: Number(row.active_users), sessions: Number(row.sessions) }]))
}

export async function readPlatformStatistics(pool: Pool, config: StatisticsConfig, range: StatisticsRange, memoryReader?: MemoryReader, now = new Date()): Promise<StatisticsResponse> {
  const warnings: string[] = []
  let memory: MemorySnapshot | null = null
  let excludedInstallations = config.excludedInstallationIds
  // Fetch exclusions before invoking upstream; never silently truncate scope.
  try {
    const excluded = await pool.query<{ installation_id: string }>('SELECT installation_id FROM extension_installations WHERE owner_user_id=ANY($1::int[]) LIMIT 1001', [config.excludedUserIds])
    excludedInstallations = [...new Set([...excludedInstallations, ...excluded.rows.map(row => row.installation_id)])]
    if (excludedInstallations.length > 1000) throw new Error('exclusion_limit')
    if (memoryReader) {
      const snapshot = await memoryReader({ from: range.start, to: range.end, previousFrom: range.previousStart, previousTo: range.previousEnd, excludeInstallationIds: excludedInstallations })
      if (!validSnapshot(snapshot)) throw new Error('invalid_memory_snapshot')
      memory = snapshot
    }
  } catch { warnings.push('memory_source_unavailable') }
  if (!memory && !warnings.length) warnings.push('memory_source_unavailable')

  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout='5000ms'")
    const coverageRows = (await client.query<Coverage>('SELECT metric,starts_at FROM platform_statistics_coverage')).rows
    const coverage = new Map(coverageRows.map(row => [row.metric, new Date(row.starts_at).toISOString()]))
    // Each affected day keeps its own watermark. A failed output cannot
    // invalidate human activity or a later fully processed calendar day.
    const pending = (await client.query<{ session_cutoff: Date; human_cutoff: Date | null }>(`
      SELECT min(received_at) AS session_cutoff,
        min(received_at) FILTER (WHERE event_type IN ('session_created','session_status')
          AND (NULLIF(payload->>'request_id','') IS NOT NULL OR NULLIF(materialization_context->>'requestId','') IS NOT NULL)
          OR event_type='user_message_receipt' AND payload->>'status'='accepted'
          OR event_type='user_text' AND payload->>'actor_scope'='root' AND payload->>'flow_scope'='main'
            AND payload->>'content_class'='dialogue') AS human_cutoff
      FROM event_inbox WHERE status IN (0,1,3) AND (
        event_type IN ('session_created','session_status','user_message_receipt','agent_text')
        OR (event_type='user_text' AND (payload ? 'local_submit_id' OR payload->>'event_id' LIKE 'native-input:%')))
        AND received_at >= $1 AND received_at < $2 AND user_id IS NOT NULL AND NOT user_id=ANY($3::int[])
        AND COALESCE(payload->>'resync','false')<>'true'
      GROUP BY (received_at AT TIME ZONE 'Asia/Shanghai')::date`,
    [new Date(Math.max(Date.parse(range.previousStart),Date.parse(coverage.get('sessions') ?? range.previousStart))).toISOString(),range.end,config.excludedUserIds])).rows
    function through(start: string, end: string, key: 'session_cutoff' | 'human_cutoff', limit: number): string {
      const from = Date.parse(start), to = Date.parse(end)
      for (const row of pending) {
        const time = row[key]?.getTime()
        if (time !== undefined && time >= from && time < to) limit = Math.min(limit, time)
      }
      return new Date(limit).toISOString()
    }
    if (pending.length) warnings.push('materialization_pending')
    const gaps = (await client.query<Gap>('SELECT metric,starts_at,ends_at FROM platform_statistics_gaps WHERE starts_at<$2 AND ends_at>$1', [range.previousStart, range.end])).rows
    for (const key of ['activeUsers','sessions']) {
      const first = coverage.get(key), localStart = coverage.get('localInputV2') ?? now.toISOString()
      if (first && first < localStart) gaps.push({ metric: key, starts_at: first, ends_at: localStart })
    }
    const collectors = (await client.query<{ channel: CollectorChannel; last_seen: Date }>('SELECT channel,last_seen FROM platform_statistics_collectors')).rows
    for (const channel of ['relay','materializer'] as const) {
      const lastSeen = collectors.find(row => row.channel === channel)?.last_seen
      if (!lastSeen || now.getTime() - lastSeen.getTime() > COLLECTOR_LEASE_MS) {
        for (const key of COLLECTOR_METRICS[channel]) gaps.push({ metric: key, starts_at: lastSeen ?? coverage.get(key) ?? range.previousStart, ends_at: now })
        warnings.push('collector_interrupted')
      }
    }
    const installationIds = memory ? [...new Set([...memory.periods.current.actors, ...memory.periods.previous.actors,
      ...memory.periods.current.dailyActors, ...memory.periods.previous.dailyActors].map(actor => actor.installationId))] : []
    const mappingLimitExceeded = installationIds.length > 20000
    if (mappingLimitExceeded || memory?.actorLimitExceeded) warnings.push('memory_actor_limit_exceeded')
    const owners = new Map<string, number>()
    const actorKey = (actor: MemoryActor) => `${actor.installationId}:${actor.membershipId ?? ''}`
    if (memory && installationIds.length && !mappingLimitExceeded) {
      const requestedMemberships = [...new Map([...memory.periods.current.actors,...memory.periods.previous.actors,
        ...memory.periods.current.dailyActors,...memory.periods.previous.dailyActors].filter(actor => actor.membershipId)
        .map(actor => [actorKey(actor), { installation_id: actor.installationId,membership_id: actor.membershipId }])).values()]
      const rows = (await client.query<{ installation_id: string; owner_user_id: number; membership_id: string | null }>(`
        SELECT i.installation_id,i.owner_user_id,NULL::uuid AS membership_id FROM extension_installations i
        WHERE i.installation_id::text=ANY($1::text[]) AND i.owner_scope_kind='personal' AND i.owner_user_id IS NOT NULL
        UNION ALL
        SELECT i.installation_id,m.user_id AS owner_user_id,m.membership_id FROM extension_installations i
        JOIN extension_scope_memberships m ON m.scope_kind=i.owner_scope_kind AND m.scope_id=i.owner_scope_id
        JOIN jsonb_to_recordset($2::jsonb) AS requested(installation_id uuid,membership_id uuid)
          ON requested.installation_id=i.installation_id AND requested.membership_id=m.membership_id
        WHERE i.installation_id::text=ANY($1::text[]) AND i.owner_scope_kind IN ('team','organization') AND m.user_id IS NOT NULL`, [installationIds,JSON.stringify(requestedMemberships)])).rows
      for (const row of rows) owners.set(`${row.installation_id}:${row.membership_id ?? ''}`, row.owner_user_id)
    }
    const allowed = (actor: MemoryActor) => !excludedInstallations.includes(actor.installationId) && !config.excludedUserIds.includes(owners.get(actorKey(actor)) ?? -1)
    const humanIds = (actors: MemoryActor[]) => [...new Set(actors.filter(actor => actor.humanActivity && allowed(actor)).flatMap(actor => owners.has(actorKey(actor)) ? [owners.get(actorKey(actor))!] : []))]
    const usageReason = (actors: MemoryActor[]) => mappingLimitExceeded || memory?.actorLimitExceeded ? 'memory_actor_limit_exceeded'
      : actors.some(actor => allowed(actor) && !owners.has(actorKey(actor))) ? 'memory_actor_owner_unknown' : undefined
    const memoryGaps: Gap[] = memory?.gaps.flatMap(gap => (gap.metric === 'memory' ? ['memory'] : ['memoryUsers','readRequests','activeUsers']).map(key => ({ metric: key, starts_at: gap.from, ends_at: gap.to }))) ?? []
    const byStart = (a: Gap, b: Gap) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime()
    gaps.sort(byStart)
    const allGaps = [...gaps, ...memoryGaps].sort(byStart)
    const observedAt = now.getTime()
    const memoryAt = memory ? Math.min(observedAt, Date.parse(memory.dataThrough)) : observedAt
    const dataThrough = through(range.start, range.end, 'session_cutoff', memoryAt)
    const memoryThrough = memory ? new Date(memoryAt).toISOString() : null
    const dataThroughByMetric = {
      newUsers: now.toISOString(), sessions: through(range.start, range.end, 'session_cutoff', observedAt),
      activeUsers: memory ? through(range.start, range.end, 'human_cutoff', memoryAt) : null,
      memory: memoryThrough, memoryUsers: memoryThrough, readRequests: memoryThrough,
    }
    const bins = [{ start: range.start,end: range.end,humanIds: memory ? humanIds(memory.periods.current.actors) : [] },
      { start: range.previousStart,end: range.previousEnd,humanIds: memory ? humanIds(memory.periods.previous.actors) : [] }]
    for (const [from, end, source] of [[range.from,range.end,memory?.periods.current],[range.previousFrom,range.previousEnd,memory?.periods.previous]] as const) {
      for (let index = 0; index < range.days; index++) {
        const date = addDays(from, index)
        bins.push({ start: new Date(dateStart(date)).toISOString(),end: new Date(Math.min(dateStart(addDays(date, 1)),Date.parse(end))).toISOString(),
          humanIds: source ? humanIds(source.dailyActors.filter(actor => actor.date === date)) : [] })
      }
    }
    const countsByRange = await relayCounts(client, [...new Map([...bins].reverse().map(bin => [`${bin.start}/${bin.end}`,bin])).values()], config.excludedUserIds)
    async function period(start: string, end: string, source: MemoryPeriod | undefined): Promise<Metrics> {
      const counts = countsByRange.get(`${start}/${end}`)!
      const result = Object.fromEntries(KEYS.map(key => [key, unavailable('memory_source_unavailable')])) as Metrics
      for (const key of ['newUsers', 'sessions'] as const) result[key] = metric(counts[key], coverage.get(key) ?? null, start, end, gaps, key, key === 'sessions' ? through(start, end, 'session_cutoff', observedAt) : now.toISOString())
      result.activeUsers = metric(counts.activeUsers, memory ? latest(coverage.get('activeUsers') ?? null, memory.coverageStart) : coverage.get('activeUsers') ?? null,
        start, end, allGaps, 'activeUsers', through(start, end, 'human_cutoff', memoryAt), source ? usageReason(source.actors.filter(actor => actor.humanActivity)) : 'memory_human_source_unavailable')
      if (memory && source) {
        result.memory = metric(source.memory, memory.coverageStart, start, end, allGaps, 'memory', memory.dataThrough)
        const actors = source.actors.filter(allowed)
        const users = new Set(actors.filter(actor => actor.readRequests + actor.writeRequests > 0).flatMap(actor => owners.has(actorKey(actor)) ? [owners.get(actorKey(actor))!] : []))
        result.memoryUsers = metric(users.size, memory.coverageStart, start, end, allGaps, 'memoryUsers', memory.dataThrough, usageReason(actors))
        result.readRequests = metric(actors.reduce((sum, actor) => sum + actor.readRequests, 0), memory.coverageStart, start, end, allGaps, 'readRequests', memory.dataThrough, usageReason(actors))
      }
      return result
    }
    const metrics = await period(range.start, range.end, memory?.periods.current)
    const previous = await period(range.previousStart, range.previousEnd, memory?.periods.previous)
    async function daily(from: string, end: string, source: MemoryPeriod | undefined): Promise<DailyMetrics[]> {
      const rows: DailyMetrics[] = []
      for (let i = 0; i < range.days; i++) {
        const date = addDays(from, i), start = new Date(dateStart(date)).toISOString()
        const dayEnd = new Date(Math.min(dateStart(addDays(date, 1)), Date.parse(end))).toISOString()
        const day = source?.daily.find(row => row.date === date)
        const actors = source?.dailyActors.filter(row => row.date === date) ?? []
        const value = await period(start, dayEnd, source ? { ...source, memory: day?.memory ?? 0, actors } : undefined)
        rows.push({ date, newUsers: value.newUsers, activeUsers: value.activeUsers, sessions: value.sessions, memory: value.memory })
      }
      return rows
    }
    const dailyRows = await daily(range.from, range.end, memory?.periods.current)
    const previousDaily = await daily(range.previousFrom, range.previousEnd, memory?.periods.previous)
    const memorySources = Object.fromEntries(['automatic','manual','unclassified'].map(key => [key,
      memory ? metric(memory.periods.current[key as 'automatic'], memory.coverageStart, range.start, range.end, allGaps, 'memory', memory.dataThrough) : unavailable('memory_source_unavailable')])) as StatisticsResponse['memorySources']
    await client.query('COMMIT')
    return {
      definitionVersion: 'platform-statistics-v2', generatedAt: now.toISOString(), dataThroughByMetric, timezone: 'Asia/Shanghai', dataThrough,
      range: { from: range.from, to: range.to }, previousRange: { from: range.previousFrom, to: range.previousTo },
      comparisonAvailable: KEYS.some(key => metrics[key].status === 'complete' && previous[key].status === 'complete'),
      metrics, previous, daily: dailyRows, previousDaily, memorySources,
      actualUse: { value: null, status: 'unconfirmed' },
      exclusions: ['configured_test_service_users', 'configured_memory_installation_scopes', 'shared_creation_owner_not_inferred', 'active_users_v2_explicit_business_whitelist', 'exclude_login_page_open_heartbeat_sync_replay', 'exclude_candidate_shadow_projection_migration'], warnings: [...new Set(warnings)],
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { client.release() }
}
