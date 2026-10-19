import {loadBusinessHealth, evaluateBusinessHealth} from './business-health.js'
import type pg from 'pg'

export interface StatusWorkerOptions {
  pool: pg.Pool
  reportStatus(input: Record<string, unknown>): Promise<void>
  intervalMs?: number
  onError?(error: unknown): void
  providerVersion: string
}

const DEFAULT_INTERVAL_MS = 60_000

/** Relay accepts only nonnegative safe integer counters, unlike SQL EXTRACT. */
function relayCount(value: unknown): number {
  const count = Number(value ?? 0)
  return Number.isFinite(count) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(count))) : 0
}

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
        const rows = await loadBusinessHealth(options.pool)
        for (const row of rows) {
          const health = evaluateBusinessHealth(row)
          await options.reportStatus({
            installation_id: row.installation_id,
            provider_version: options.providerVersion,
            state: health.state,
            last_feed_id: relayCount(row.last_feed_id),
            feed_lag_seconds: relayCount(row.feed_lag_seconds),
            pending_jobs: relayCount(row.pending_jobs),
            failed_jobs_24h: relayCount(row.failed_jobs_24h),
            ...(health.primaryError ? { last_error_code: health.primaryError } : {}),
            ...(row.last_extract_at ? {last_extract_at: new Date(row.last_extract_at).toISOString()} : {}),
          })
        }
        return rows.length
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
