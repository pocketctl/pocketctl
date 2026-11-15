import type { Pool } from 'pg'
import { platformStatisticsConfig } from './config.js'

export const COLLECTOR_LEASE_MS = 45_000
export const COLLECTOR_METRICS = { relay: ['newUsers','activeUsers','sessions'], materializer: ['activeUsers','sessions'] } as const
export type CollectorChannel = keyof typeof COLLECTOR_METRICS

export async function heartbeatPlatformStatisticsCollector(pool: Pool, channel: CollectorChannel, now = new Date()): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT pg_advisory_xact_lock(hashtext('platform-statistics-collector:' || $1))", [channel])
    const row = (await client.query<{ last_seen: Date }>('SELECT last_seen FROM platform_statistics_collectors WHERE channel=$1 FOR UPDATE', [channel])).rows[0]
    if (!row) {
      // Until every required process has started, no complete zero is claimed.
      await client.query('UPDATE platform_statistics_coverage SET starts_at=GREATEST(starts_at,$1) WHERE metric=ANY($2::text[])', [now, [...COLLECTOR_METRICS[channel]]])
    } else if (now.getTime() - row.last_seen.getTime() > COLLECTOR_LEASE_MS) {
      await client.query(`INSERT INTO platform_statistics_gaps(metric,starts_at,ends_at,reason)
        SELECT unnest($1::text[]),$2,$3,'collector_interrupted'`, [[...COLLECTOR_METRICS[channel]], row.last_seen, now])
    }
    await client.query(`INSERT INTO platform_statistics_collectors(channel,last_seen) VALUES($1,$2)
      ON CONFLICT(channel) DO UPDATE SET last_seen=GREATEST(platform_statistics_collectors.last_seen,EXCLUDED.last_seen)`, [channel, now])
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error }
  finally { client.release() }
}

/** Start once in API Relay and once in each materializer worker process. */
export async function startPlatformStatisticsCollector(pool: Pool, channel: CollectorChannel, env: NodeJS.ProcessEnv = process.env): Promise<() => void> {
  const config = platformStatisticsConfig(env)
  if (!config.enabled) return () => undefined
  if (!config.valid) throw new Error('Invalid platform statistics exclusion configuration')
  await heartbeatPlatformStatisticsCollector(pool, channel)
  let running = false
  const timer = setInterval(() => {
    if (running) return
    running = true
    heartbeatPlatformStatisticsCollector(pool, channel)
      .catch(() => { console.error('[platform-statistics] collector heartbeat failed', { channel }) })
      .finally(() => { running = false })
  }, 15_000)
  timer.unref()
  return () => clearInterval(timer)
}
