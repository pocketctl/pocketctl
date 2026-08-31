import type pg from 'pg'

export interface StatusWorkerOptions {
  pool: pg.Pool
  reportStatus(input: Record<string, unknown>): Promise<void>
  intervalMs?: number
  onError?(error: unknown): void
  providerVersion: string
}

const DEFAULT_INTERVAL_MS = 60_000

/**
 * Per-installation status heartbeat (every 60s): provider version, local
 * state, checkpoint position, feed lag and job backlog. Error messages never
 * travel — only bounded codes. Relay failures retry on the next beat and
 * never affect readiness.
 */
export function createStatusWorker(options: StatusWorkerOptions) {
  const intervalMs = Math.max(1_000, options.intervalMs ?? DEFAULT_INTERVAL_MS)
  let timer: ReturnType<typeof setInterval> | undefined
  let current: Promise<unknown> | undefined

  async function runOnce(): Promise<number> {
    if (current) return 0
    const pass = (async () => {
      try {
        const rows = await options.pool.query<{
          installation_id: string
          local_status: string
          last_feed_id: string | null
          last_error_code: string | null
          feed_lag_seconds: number | null
          pending_jobs: string
          failed_jobs_24h: string
        }>(`
          SELECT i.installation_id,
                 i.local_status,
                 i.last_feed_id::text,
                 i.last_error_code,
                 EXTRACT(EPOCH FROM (NOW() - i.last_pull_at))::bigint AS feed_lag_seconds,
                 (SELECT COUNT(*) FROM memory_jobs j
                   WHERE j.installation_id = i.installation_id AND j.state = 'pending')::text AS pending_jobs,
                 (SELECT COUNT(*) FROM memory_jobs j
                   WHERE j.installation_id = i.installation_id AND j.state = 'dead'
                     AND j.created_at > NOW() - INTERVAL '24 hours')::text AS failed_jobs_24h
          FROM memory_installations i
          -- Relay rejects heartbeats after revocation. Reporting only the
          -- statuses it accepts avoids a retrying not_found loop while the
          -- purge worker completes its local cleanup.
          WHERE i.relay_status IN ('pending', 'active', 'paused')
        `)
        for (const row of rows.rows) {
          await options.reportStatus({
            installation_id: row.installation_id,
            provider_version: options.providerVersion,
            state: row.local_status === 'ready' ? 'ready'
              : row.local_status === 'degraded' ? 'degraded'
                : row.local_status === 'integrity_error' ? 'error'
                  : 'syncing',
            last_feed_id: Number(row.last_feed_id ?? 0),
            feed_lag_seconds: Number(row.feed_lag_seconds ?? 0),
            pending_jobs: Number(row.pending_jobs),
            failed_jobs_24h: Number(row.failed_jobs_24h),
            ...(row.last_error_code ? { last_error_code: row.last_error_code } : {}),
          })
        }
        return rows.rows.length
      } finally {
        current = undefined
      }
    })()
    current = pass
    return pass
  }

  return {
    start(): void {
      if (timer) return
      timer = setInterval(() => {
        void runOnce().catch(error => options.onError?.(error))
      }, intervalMs)
      timer.unref?.()
    },
    /** Stop the timer, then wait for an in-flight beat so pool.end() is safe. */
    async stop(): Promise<void> {
      if (timer) clearInterval(timer)
      timer = undefined
      await current?.catch(() => undefined)
      current = undefined
    },
    runOnce,
  }
}

export type StatusWorker = ReturnType<typeof createStatusWorker>
