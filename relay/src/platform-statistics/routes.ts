import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Pool } from 'pg'
import { platformStatisticsConfig, PLATFORM_STATISTICS_OWNER_EMAIL } from './config.js'
import { parseStatisticsRange } from './range.js'
import { readPlatformStatistics } from './service.js'
import type { MemoryReader, StatisticsResponse } from './types.js'

interface Dependencies {
  pool: Pool
  verifyAccessToken: (token: string, pool: Pool) => Promise<{ userId: number } | null>
  memoryReader?: MemoryReader
  env?: NodeJS.ProcessEnv
  now?: () => Date
}
function csvCell(value: unknown): string { return `"${String(value ?? '').replaceAll('"', '""')}"` }
export function statisticsCsv(value: StatisticsResponse): string {
  const rows: unknown[][] = [['definitionVersion', value.definitionVersion], ['timezone', value.timezone], ['generatedAt', value.generatedAt], ['dataThrough', value.dataThrough],
    ...Object.entries(value.dataThroughByMetric).map(([key, time]) => ['dataThroughByMetric', key, time]),
    ['range', value.range.from, value.range.to], ['previousRange', value.previousRange.from, value.previousRange.to],
    ['comparisonAvailable', value.comparisonAvailable], ['actualUse', 'unconfirmed'],
    ...value.exclusions.map(rule => ['exclusion', rule]), ...value.warnings.map(warning => ['warning', warning]),
    ['period', 'date', 'metric', 'value', 'status', 'coverageStart', 'reason']]
  for (const [period, metrics] of [['current', value.metrics], ['previous', value.previous]] as const) {
    for (const [key, metric] of Object.entries(metrics)) rows.push([period, '', key, metric.value, metric.status, metric.coverageStart, metric.reason])
  }
  for (const [period, days] of [['current', value.daily], ['previous', value.previousDaily]] as const) {
    for (const { date, ...metrics } of days) for (const [key, metric] of Object.entries(metrics)) rows.push([period, date, key, metric.value, metric.status, metric.coverageStart, metric.reason])
  }
  for (const [key, metric] of Object.entries(value.memorySources)) rows.push(['memorySource','',key,metric.value,metric.status,metric.coverageStart,metric.reason])
  return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n'
}

export function registerPlatformStatisticsRoutes(app: FastifyInstance, dependencies: Dependencies): void {
  async function authorize(request: FastifyRequest, reply: FastifyReply): Promise<boolean | null> {
    reply.header('Cache-Control', 'no-store, private').header('Pragma', 'no-cache')
    const auth = request.headers.authorization
    let identity: { userId: number } | null = null
    try { if (auth?.startsWith('Bearer ')) identity = await dependencies.verifyAccessToken(auth.slice(7), dependencies.pool) } catch { /* fail closed */ }
    if (!identity || !Number.isSafeInteger(identity.userId) || identity.userId <= 0) {
      reply.code(401).send({ error: 'Authentication required', code: 'unauthorized' }); return null
    }
    const config = platformStatisticsConfig(dependencies.env)
    const ownerPin = (dependencies.env ?? process.env).PLATFORM_STATS_OWNER_USER_ID
    if (!config.enabled || !config.valid || (ownerPin && config.ownerUserId === null)
      || (config.ownerUserId !== null && identity.userId !== config.ownerUserId)) return false
    // Token email can become stale after an account email change. Bind the
    // authenticated stable subject to its current server-side account instead.
    try {
      const result = await dependencies.pool.query<{ email: string | null }>('SELECT email FROM users WHERE id=$1', [identity.userId])
      const email = result.rows[0]?.email
      return typeof email === 'string' && email.trim().toLowerCase() === PLATFORM_STATISTICS_OWNER_EMAIL
    } catch { return false }
  }
  app.get('/api/admin/statistics/access', async (request, reply) => {
    const allowed = await authorize(request, reply)
    return allowed === null ? reply : { allowed }
  })
  for (const exportCsv of [false, true]) app.get(exportCsv ? '/api/admin/statistics/export.csv' : '/api/admin/statistics', async (request, reply) => {
    const allowed = await authorize(request, reply)
    if (allowed === null) return reply
    if (!allowed) return reply.code(403).send({ error: 'Statistics owner access required', code: 'forbidden' })
    const now = dependencies.now?.() ?? new Date()
    let range
    try { range = parseStatisticsRange(request.query as Record<string, unknown>, now) }
    catch { return reply.code(400).send({ error: 'Invalid statistics date range', code: 'invalid_range' }) }
    try {
      const response = await readPlatformStatistics(dependencies.pool, platformStatisticsConfig(dependencies.env), range, dependencies.memoryReader, now)
      return exportCsv ? reply.type('text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="platform-statistics.csv"').send(statisticsCsv(response)) : response
    } catch { return reply.code(503).send({ error: 'Statistics source unavailable', code: 'statistics_unavailable' }) }
  })
}
