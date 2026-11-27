import {randomUUID} from 'node:crypto'
import type pg from 'pg'
import {MEMORY_USAGE_OPERATIONS} from './memory-usage-contract.js'
import { createUsageOutbox } from './usage-outbox.js'

export interface UsageWorkerOptions {
  pool: pg.Pool
  reportUsage(installationId: string, facts: Array<Record<string, unknown>>): Promise<number>
  intervalMs?: number
  onError?(error: unknown): void
}

const DEFAULT_INTERVAL_MS = 30_000

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
        const claim = randomUUID()
        const batch = await outbox.nextBatch(claim)
        if (batch.length === 0) return 0
        const byInstallation = new Map<string, typeof batch>()
        for (const fact of batch) {
          const list = byInstallation.get(fact.installationId) ?? []
          list.push(fact)
          byInstallation.set(fact.installationId, list)
        }
        let sent = 0
        async function deliverInstallation(installationId:string,sourceFacts:typeof batch) {
          const wireFacts=[]
          for(const fact of sourceFacts) {
            const counters=[fact.inputTokens,fact.outputTokens,fact.embeddingTokens,fact.cachedTokens,fact.costMicros]
            if(!fact.usageId || fact.usageId.length>128 || (fact.model?.length??0)>128
              || !(MEMORY_USAGE_OPERATIONS as readonly string[]).includes(fact.operation)
              || !(fact.occurredAt instanceof Date) || !Number.isFinite(fact.occurredAt.getTime())
              || counters.some(value=>!Number.isSafeInteger(value)||Number(value)<0)) {
              await outbox.markAttempt(installationId,fact.usageId,claim,'invalid_request',true)
              continue
            }
            const clockLead=fact.occurredAt.getTime()-Date.now()
            if(clockLead>300_000) {
              await outbox.markAttempt(installationId,fact.usageId,claim,'usage_clock_ahead',false,clockLead)
              continue
            }
            wireFacts.push(fact)
          }
          const facts = wireFacts.map(fact => ({
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
          // A deterministic payload rejection must not spend the attempts of
          // valid siblings. Bound extra calls; untouched sub-batches stay pending.
          let callsRemaining = Math.min(15,Math.floor(32/byInstallation.size))
          const deliver = async (batch: typeof facts): Promise<void> => {
            if (callsRemaining <= 0) return
            callsRemaining--
            try {
              await options.reportUsage(installationId, batch)
            } catch (error) {
              const errorCode = boundedErrorCode(error)
              const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined
              const rejected=(errorCode==='invalid_request' && status===400) || (errorCode==='revision_conflict' && status===409)
              if (rejected && batch.length > 1) {
                const middle = Math.ceil(batch.length / 2)
                await deliver(batch.slice(0, middle))
                await deliver(batch.slice(middle))
                return
              }
              for (const fact of batch) {
                const retryAfter=Number((error as {retryAfterMs?:number}|null)?.retryAfterMs??0)
                await outbox.markAttempt(installationId,String(fact.usage_id),claim,errorCode,rejected,retryAfter)
              }
              options.onError?.(error)
              return
            }
            for (const fact of batch) {
              if(await outbox.markReported(installationId,String(fact.usage_id),claim)) sent++
            }
          }
          if(facts.length) await deliver(facts)
        }
        // Bounded tenant concurrency prevents one slow Relay request from
        // holding all other installations' delivery leases.
        const groups=[...byInstallation]
        let failed:PromiseRejectedResult|undefined
        for(let offset=0;offset<groups.length;offset+=4) {
          const results=await Promise.allSettled(groups.slice(offset,offset+4).map(([id,rows])=>deliverInstallation(id,rows)))
          failed??=results.find((r):r is PromiseRejectedResult=>r.status==='rejected')
        }
        if(failed) throw failed.reason
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
