import { hostname } from 'node:os'
import { pathToFileURL } from 'node:url'
import type pg from 'pg'
import { createPool, parseDBUrl } from './db.js'
import { InboxRepository } from './ingress/inbox-repository.js'
import { createInboxWorker } from './inbox-worker.js'
import { InboxRetention } from './inbox-retention.js'
import { EventMaterializer } from './materialization/event-materializer.js'
import { RealtimeOutboxWriter } from './materialization/realtime-outbox.js'
import type { RuntimeMaterializationHooks } from './materialization/types.js'
import {
  assertTokenUsageFeatureDependencies,
  tokenUsageFeatures,
} from './config/token-usage.js'
import { assertTokenUsageWriteContinuity } from './token-usage/lifecycle.js'

const RETENTION_INTERVAL_MS = 60_000
// Connection checkout remains 1s; a claimed durable batch needs enough time
// to complete its transactional materialization without a false timeout.
export const EVENT_WORKER_STATEMENT_TIMEOUT_MS = 30_000

export function createStandaloneMaterializationHooks(): RuntimeMaterializationHooks {
  // Request-ID dedup is authoritative in events(session_id,event_hash) plus
  // effect_status/effect_step. Process-local state would reset with the Worker.
  return {}
}

interface RetentionLoopOptions {
  retention: { runOnce(): Promise<unknown> };
  intervalMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export function createRetentionLoop(options: RetentionLoopOptions) {
  const intervalMs = Math.max(1, Math.trunc(options.intervalMs ?? RETENTION_INTERVAL_MS))
  const setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer))
  let timer: ReturnType<typeof setTimeout> | undefined
  let activeRun: Promise<void> | undefined
  let stopped = true

  const schedule = (delayMs: number): void => {
    if (stopped || timer) return
    timer = setTimer(() => {
      timer = undefined
      void runOnce()
        .catch((error) => console.error('[inbox-retention] cleanup failed', {
          errorName: error instanceof Error ? error.name : typeof error,
        }))
        .finally(() => schedule(intervalMs))
    }, delayMs)
    timer.unref?.()
  }

  const runOnce = async (): Promise<void> => {
    if (activeRun) return activeRun
    const run = options.retention.runOnce().then(() => undefined)
    activeRun = run
    try {
      await run
    } finally {
      if (activeRun === run) activeRun = undefined
    }
  }

  return {
    start(): void {
      if (!stopped) return
      stopped = false
      schedule(0)
    },
    async stop(): Promise<void> {
      stopped = true
      if (timer) {
        clearTimer(timer)
        timer = undefined
      }
      await activeRun
    },
  }
}

interface WorkerRuntimeDeps {
  assertSchemaReady(): Promise<void>;
  worker: { start(): void; stop(): Promise<void> };
  retention: { start(): void; stop(): Promise<void> };
  pool: { end(): Promise<void> };
}

export function createWorkerRuntime(deps: WorkerRuntimeDeps) {
  let started = false
  let workerStarted = false
  let retentionStarted = false
  let closed = false
  let stopRun: Promise<void> | undefined

  const closePool = async (): Promise<void> => {
    if (closed) return
    closed = true
    await deps.pool.end()
  }

  return {
    async start(): Promise<void> {
      if (started) return
      try {
        await deps.assertSchemaReady()
        deps.worker.start()
        workerStarted = true
        deps.retention.start()
        retentionStarted = true
        started = true
      } catch (error) {
        await Promise.allSettled([
          ...(workerStarted ? [deps.worker.stop()] : []),
          ...(retentionStarted ? [deps.retention.stop()] : []),
        ])
        workerStarted = false
        retentionStarted = false
        await closePool()
        throw error
      }
    },
    async stop(_signal = 'shutdown'): Promise<void> {
      if (stopRun) return stopRun
      stopRun = (async () => {
        let drainFailure: unknown
        if (started) {
          const drained = await Promise.allSettled([
            deps.worker.stop(),
            deps.retention.stop(),
          ])
          drainFailure = drained.find((result) => result.status === 'rejected')?.reason
          started = false
          workerStarted = false
          retentionStarted = false
        }
        await closePool()
        if (drainFailure !== undefined) throw drainFailure
      })()
      return stopRun
    },
  }
}

export async function assertDurableIngressSchema(pool: Pick<pg.Pool, 'query'>): Promise<void> {
  const result = await pool.query<{ ready: boolean }>(`
    SELECT
      to_regclass('event_inbox') IS NOT NULL
      AND to_regclass('event_inbox_receipt') IS NOT NULL
      AND to_regclass('daemon_ack_checkpoint') IS NOT NULL
      AND to_regclass('realtime_outbox') IS NOT NULL
      AND to_regclass('request_push_effect') IS NOT NULL
      AND to_regclass('idx_event_inbox_stream_unresolved') IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'event_inbox'
          AND column_name = 'materialization_context'
      )
      AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'realtime_outbox'
          AND column_name = 'event_id'
          AND is_nullable = 'YES'
      )
      AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'realtime_outbox'
          AND column_name = 'audience'
          AND character_maximum_length >= 18
      ) AS ready
  `)
  if (result.rows[0]?.ready !== true) throw new Error('durable ingress schema not ready')
}

function strictPositiveEnvInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  if (!/^[1-9]\d*$/.test(raw)) throw new Error(`${name} must be a positive decimal integer`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a positive decimal integer`)
  return value
}

function nonNegativeEnvInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  if (!/^(0|[1-9]\d*)$/.test(raw)) throw new Error(`${name} must be a non-negative decimal integer`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a non-negative decimal integer`)
  return value
}

export async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required')
  const shardCount = strictPositiveEnvInt('RELAY_WORKER_SHARD_COUNT', 1)
  const shardIndex = nonNegativeEnvInt('RELAY_WORKER_SHARD_INDEX', 0)
  if (shardIndex >= shardCount) throw new Error('RELAY_WORKER_SHARD_INDEX must be less than RELAY_WORKER_SHARD_COUNT')
  const tokenFeatures = tokenUsageFeatures(process.env)
  assertTokenUsageFeatureDependencies(tokenFeatures, process.env.RELAY_DURABLE_INGRESS ?? 'off')
  const pool = createPool(parseDBUrl(databaseUrl), {
    name: 'event-worker',
    max: strictPositiveEnvInt('DB_WORKER_POOL_MAX', 8),
    connectionTimeoutMillis: 1_000,
    statementTimeoutMillis: EVENT_WORKER_STATEMENT_TIMEOUT_MS,
  })
  const repository = new InboxRepository(pool)
  const worker = createInboxWorker({
    repository,
    materializer: new EventMaterializer({
      pool,
      hooks: createStandaloneMaterializationHooks(),
      writeTokenUsageFacts: tokenFeatures.writeFacts,
    }),
    outboxWriter: new RealtimeOutboxWriter(pool),
    workerId: process.env.RELAY_WORKER_ID || `${hostname()}:${process.pid}`,
    shardCount,
    shardIndex,
  })
  const retention = createRetentionLoop({
    retention: new InboxRetention(pool),
    intervalMs: RETENTION_INTERVAL_MS,
  })
  const runtime = createWorkerRuntime({
    assertSchemaReady: async () => {
      await assertDurableIngressSchema(pool)
      await assertTokenUsageWriteContinuity(pool, tokenFeatures)
    },
    worker,
    retention,
    pool,
  })
  await runtime.start()

  let stopping = false
  const shutdown = (signal: string): void => {
    if (stopping) return
    stopping = true
    void runtime.stop(signal).then(
      () => { process.exitCode = 0 },
      (error) => {
        console.error('[event-worker] shutdown failed', {
          errorName: error instanceof Error ? error.name : typeof error,
        })
        process.exitCode = 1
      },
    )
  }
  process.once('SIGTERM', () => shutdown('SIGTERM'))
  process.once('SIGINT', () => shutdown('SIGINT'))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    console.error('[event-worker] startup failed', {
      errorName: error instanceof Error ? error.name : typeof error,
    })
    process.exitCode = 1
  })
}
