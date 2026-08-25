import type pg from 'pg'
import { createUsageOutbox } from './usage-outbox.js'

export interface UsageWorkerOptions {
  pool: pg.Pool
  reportUsage(installationId: string, facts: Array<Record<string, unknown>>): Promise<number>
  intervalMs?: number
  onError?(error: unknown): void
}

const DEFAULT_INTERVAL_MS = 30_000
const MAX_ATTEMPTS = 10

/**
 * Drains the usage outbox to Relay. Only real, durable records are sent —
 * the worker never fabricates zero-token facts to look busy.
 */
export function createUsageWorker(options: UsageWorkerOptions) {
  const outbox = createUsageOutbox(options.pool)
  const intervalMs = Math.max(1_000, options.intervalMs ?? DEFAULT_INTERVAL_MS)
  let timer: ReturnType<typeof setInterval> | undefined
  let current: Promise<unknown> | undefined

  async function runOnce(): Promise<number> {
    if (current) return 0
    const pass = (async () => {
      try {
        const batch = await outbox.nextBatch()
        if (batch.length === 0) return 0
        const byInstallation = new Map<string, typeof batch>()
        for (const fact of batch) {
          const list = byInstallation.get(fact.installationId) ?? []
          list.push(fact)
          byInstallation.set(fact.installationId, list)
        }
        let sent = 0
        for (const [installationId, sourceFacts] of byInstallation) {
          const facts = sourceFacts.map(fact => ({
            usage_id: fact.usageId,
            operation: fact.operation,
            ...(fact.model ? { model: fact.model } : {}),
            input_tokens: fact.inputTokens ?? 0,
            output_tokens: fact.outputTokens ?? 0,
            embedding_tokens: fact.embeddingTokens ?? 0,
            cached_tokens: fact.cachedTokens ?? 0,
            cost_micros: fact.costMicros ?? 0,
            occurred_at: fact.occurredAt.toISOString(),
          }))
          try {
            await options.reportUsage(installationId, facts)
          } catch (error) {
            const errorCode = boundedErrorCode(error)
            for (const fact of sourceFacts) {
              const attempts = await outbox.markAttempt(installationId, fact.usageId, errorCode)
              if (attempts >= MAX_ATTEMPTS) await outbox.markDeadLetter(installationId, fact.usageId)
            }
            options.onError?.(error)
            continue
          }
          for (const fact of facts) {
            await outbox.markReported(installationId, String(fact.usage_id))
            sent++
          }
        }
        return sent
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
    /** Stop the timer, then wait for an in-flight drain so pool.end() is safe. */
    async stop(): Promise<void> {
      if (timer) clearInterval(timer)
      timer = undefined
      await current?.catch(() => undefined)
      current = undefined
    },
    runOnce,
  }
}

export type UsageWorker = ReturnType<typeof createUsageWorker>

function boundedErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error
    && typeof (error as { code?: unknown }).code === 'string') {
    return (error as { code: string }).code.slice(0, 128) || 'usage_delivery_failed'
  }
  return 'usage_delivery_failed'
}
