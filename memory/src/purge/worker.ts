import type pg from 'pg'
import type { PurgeRepository } from './repository.js'

export interface PurgeWorkerOptions {
  pool: pg.Pool
  purge: PurgeRepository
  relay: {
    listPurges(): Promise<Array<Record<string, unknown>>>
    acknowledgePurge(requestId: string, receipt: string): Promise<void>
  }
  signal?: AbortSignal
  intervalMs?: number
  onError?(error: unknown): void
  onPurgeResult?(result: 'success' | 'failure'): void
}

const DEFAULT_INTERVAL_MS = 5_000

/**
 * Purge queue loop — the highest-priority background work. Each pass lists
 * Relay's pending purge requests and reconciles them: a request without a
 * local receipt purges first (one local transaction), then acks with the
 * receipt; a request whose receipt already exists only re-acks. Errors are
 * bounded codes and leave the installation degraded for the next pass.
 */
export function createPurgeWorker(options: PurgeWorkerOptions) {
  const intervalMs = Math.max(1_000, options.intervalMs ?? DEFAULT_INTERVAL_MS)
  let timer: ReturnType<typeof setInterval> | undefined
  let current: Promise<unknown> | undefined

  async function runOnce(): Promise<number> {
    if (current) return 0
    const pass = (async () => {
      try {
        const requests = await options.relay.listPurges()
        let handled = 0
        for (const request of requests) {
          const requestId = String(request.request_id ?? '')
          const installationId = String(request.installation_id ?? '')
          const reason = String(request.reason ?? 'uninstall')
          if (!requestId || !installationId) continue
          try {
            const receipt = await options.purge.purgeInstallation({
              installationId, requestId, reason,
            })
            // Local commit is durable; the ack may retry on later passes.
            await options.relay.acknowledgePurge(requestId, receipt)
            await options.purge.markPurgeAcked(requestId)
            options.onPurgeResult?.('success')
            handled++
          } catch (error) {
            options.onError?.(error)
            options.onPurgeResult?.('failure')
            await options.pool.query(`
              UPDATE memory_installations
              SET local_status = CASE WHEN local_status = 'purged' THEN 'purged' ELSE 'degraded' END,
                  last_error_code = 'purge_failed', updated_at = NOW()
              WHERE installation_id = $1
            `, [installationId]).catch(() => undefined)
          }
        }
        // Retention cleanup is local and bounded; failures are observable but
        // never change a successfully committed/ACKed purge result.
        await options.purge.cleanupSupersededSnapshots({ limit: 100 })
          .catch(error => options.onError?.(error))
        return handled
      } finally {
        current = undefined
      }
    })()
    current = pass
    return pass
  }

  function launch(): void {
    const run = runOnce().catch(error => options.onError?.(error))
    current = current ?? run
  }

  return {
    start(): void {
      if (timer) return
      launch()
      timer = setInterval(launch, intervalMs)
      timer.unref?.()
    },
    /** Stop the timer, then wait for an in-flight pass so pool.end() is safe. */
    async stop(): Promise<void> {
      if (timer) clearInterval(timer)
      timer = undefined
      await current?.catch(() => undefined)
      current = undefined
    },
    runOnce,
  }
}

export type PurgeWorker = ReturnType<typeof createPurgeWorker>
