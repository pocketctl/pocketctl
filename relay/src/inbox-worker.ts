import {
  InboxRepository,
  LostClaimError,
  type ClaimFence,
  type InboxRow,
} from './ingress/inbox-repository.js'
import type { EventMaterializer } from './materialization/event-materializer.js'
import type { RealtimeOutboxWriter } from './materialization/realtime-outbox.js'
import { observeInboxOldest, workerBacklog, workerBatchSize, workerClaimedRows, workerDrainPasses, workerRetries } from './metrics.js'

const MAX_ATTEMPTS = 12
const STALE_CLAIM_LEASE_MS = 300_000
const STALE_CLAIM_SWEEP_LIMIT = 1_000
const STALE_CLAIM_SWEEP_INTERVAL_MS = 60_000
const CLAIM_HEARTBEAT_INTERVAL_MS = 100_000
const DEFAULT_DRAIN_PASSES = 32

export interface InboxWorkerDeps {
  repository: Pick<InboxRepository, 'claimBatch' | 'complete' | 'reschedule' | 'deadLetter' | 'resetStaleClaims' | 'renewClaims'>
  materializer: Pick<EventMaterializer, 'materialize'>
  outboxWriter?: Pick<RealtimeOutboxWriter, 'complete'>
  workerId: string
  shardCount: number
  shardIndex: number
  batchSize?: number
  pollIntervalMs?: number
  maxDrainPasses?: number
  now?: () => Date
  random?: () => number
  heartbeatIntervalMs?: number
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
  onDeadLetter?: (row: InboxRow, errorCode: string, releaseBlocker: boolean) => void
}

function errorName(error: unknown): string {
  return error && typeof error === 'object' && 'name' in error ? String(error.name) : ''
}

/** Errors written to the inbox must be category-only: never diagnostics. */
export function safeMaterializationError(error: unknown): string {
  const name = errorName(error)
  if (name === 'SchemaValidationError') return 'schema_validation'
  if (name === 'OwnershipError') return 'ownership_mismatch'
  if (name === 'MaterializationContextError') return 'materialization_context_missing'
  if (name === 'EphemeralMaterializationError') return 'ephemeral_event_rejected'
  // ADR-0003: journaling an unownable canonical event is an authorization
  // defect, not a transient failure.
  if (name === 'ExtensionJournalOwnerMissingError') return 'extension_journal_owner_missing'
  if (name === 'ClientEventOwnershipError') return 'client_event_ownership_mismatch'
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  if (code === 'session_ownership_violation' || code === 'unknown_daemon_session'
    || code === 'quota_reservation_binding_mismatch') return code
  if (code.startsWith('08') || code.startsWith('53') || code === '57P01' || code === '57P03') return 'database_unavailable'
  return 'materialization_failed'
}

/**
 * Security rejections are permanent: retrying an ownership violation can
 * never succeed, so the row dead-letters immediately without outbox delivery.
 */
export function isPermanentMaterializationError(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  if (code === 'session_ownership_violation' || code === 'unknown_daemon_session'
    || code === 'quota_reservation_binding_mismatch') return true
  const name = errorName(error)
  // Authorization defects identified by class: an unownable event can never
  // succeed on retry, so it dead-letters immediately. ClientEventOwnership
  // currently rejects synchronously on the WebSocket path; the entry stays
  // so future inbox ingestion of client events keeps the same semantics.
  return name === 'ExtensionJournalOwnerMissingError' || name === 'ClientEventOwnershipError'
}

export function retryDelayMs(attempts: number, random: () => number): number {
  const base = Math.min(60_000, 250 * 2 ** Math.min(Math.max(0, attempts), 8))
  return base + Math.floor(Math.max(0, Math.min(0.999999, random())) * 250)
}

export function createInboxWorker(deps: InboxWorkerDeps) {
  const batchSize = Math.max(1, Math.trunc(deps.batchSize ?? 32))
  const pollIntervalMs = Math.max(1, Math.trunc(deps.pollIntervalMs ?? 50))
  const maxDrainPasses = Math.max(1, Math.trunc(deps.maxDrainPasses ?? DEFAULT_DRAIN_PASSES))
  const now = deps.now ?? (() => new Date())
  const random = deps.random ?? Math.random
  const heartbeatIntervalMs = Math.min(
    CLAIM_HEARTBEAT_INTERVAL_MS,
    Math.max(1, Math.trunc(deps.heartbeatIntervalMs ?? CLAIM_HEARTBEAT_INTERVAL_MS)),
  )
  const setTimer = deps.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  const clearTimer = deps.clearTimer ?? ((activeTimer) => clearTimeout(activeTimer))
  let activeRun: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = true
  let lastRecoveryAt = Number.NEGATIVE_INFINITY
  let shouldContinueImmediately = false

  async function processRow(row: InboxRow, assertClaim: () => Promise<void>): Promise<void> {
    try {
      await assertClaim()
      const result = await deps.materializer.materialize({
        inboxId: row.inboxId,
        userId: row.userId,
        daemonId: row.daemonId,
        sessionId: row.sessionId,
        eventType: row.eventType,
        payload: row.payload,
        receivedAt: row.receivedAt,
        context: row.materializationContext,
      }, undefined, { assertClaim })
      if (deps.outboxWriter) {
        await deps.outboxWriter.complete(
          row.inboxId,
          result.eventId,
          result.deliveries,
          deps.workerId,
          row.attempts,
        )
      } else {
        await deps.repository.complete(row.inboxId, result.eventId, deps.workerId, row.attempts)
      }
    } catch (error) {
      if (error instanceof LostClaimError) return
      const errorCode = safeMaterializationError(error)
      if (isPermanentMaterializationError(error) || row.attempts >= MAX_ATTEMPTS) {
        try {
          await deps.repository.deadLetter(row.inboxId, row.attempts, errorCode, deps.workerId)
        } catch (writeError) {
          if (writeError instanceof LostClaimError) return
          throw writeError
        }
        deps.onDeadLetter?.(row, errorCode, row.priorityClass === 0)
        workerRetries.inc({ outcome: 'dead_letter' })
        return
      }
      const availableAt = new Date(now().getTime() + retryDelayMs(row.attempts, random))
      try {
        await deps.repository.reschedule(row.inboxId, row.attempts, availableAt, errorCode, deps.workerId)
        workerRetries.inc({ outcome: 'rescheduled' })
      } catch (writeError) {
        if (writeError instanceof LostClaimError) return
        throw writeError
      }
    }
  }

  async function processClaimedBatch(): Promise<number> {
    const rows = await deps.repository.claimBatch({
      workerId: deps.workerId,
      limit: batchSize,
      shardCount: deps.shardCount,
      shardIndex: deps.shardIndex,
    })
    workerBacklog.set(rows.length)
    workerBatchSize.observe(rows.length)
    workerClaimedRows.inc(rows.length)
    observeInboxOldest(rows, now())
    const activeClaims = new Map<number, { fence: ClaimFence; owned: boolean }>(
      rows.map((row) => [row.inboxId, {
        fence: { inboxId: row.inboxId, attempts: row.attempts },
        owned: true,
      }]),
    )
    let leaseClosed = false
    let heartbeatTimer: ReturnType<typeof setTimeout> | undefined
    let heartbeatRun: Promise<void> | undefined

    const scheduleHeartbeat = (): void => {
      if (leaseClosed || heartbeatTimer || activeClaims.size === 0) return
      heartbeatTimer = setTimer(() => {
        heartbeatTimer = undefined
        if (leaseClosed) return
        const fences = [...activeClaims.values()]
          .filter((claim) => claim.owned)
          .map((claim) => claim.fence)
        if (fences.length === 0) return
        const run = deps.repository.renewClaims(fences, deps.workerId)
          .then((renewed) => {
            for (const claim of activeClaims.values()) {
              if (claim.owned && !renewed.has(claim.fence.inboxId)) claim.owned = false
            }
          })
          .catch(() => {
            for (const claim of activeClaims.values()) claim.owned = false
          })
          .finally(() => {
            if (heartbeatRun === run) heartbeatRun = undefined
            scheduleHeartbeat()
          })
        heartbeatRun = run
      }, heartbeatIntervalMs)
      heartbeatTimer.unref?.()
    }

    scheduleHeartbeat()
    // Repository claim guarantees one minimum pending seq per daemon generation.
    // Keep this loop serial as an additional in-process ordering fence for fakes
    // and future query changes that return more than one row for a daemon.
    try {
      for (const row of rows) {
        const assertClaim = async (): Promise<void> => {
          if (!activeClaims.get(row.inboxId)?.owned) throw new LostClaimError(row.inboxId)
        }
        await processRow(row, assertClaim)
        activeClaims.delete(row.inboxId)
      }
    } finally {
      leaseClosed = true
      if (heartbeatTimer) clearTimer(heartbeatTimer)
      await heartbeatRun
    }
    return rows.length
  }

  // Keep claiming while the queue has backlog so a same-daemon stream does not
  // wait a full poll interval between single-row claims. The budget bounds the
  // run so stop() and stale-claim maintenance stay responsive; an exhausted
  // budget with remaining backlog reschedules with a zero delay instead.
  async function drainClaimedBatches(): Promise<boolean> {
    let productivePasses = 0
    for (let pass = 0; pass < maxDrainPasses; pass += 1) {
      const claimed = await processClaimedBatch()
      if (claimed === 0) break
      productivePasses += 1
    }
    workerDrainPasses.observe(productivePasses)
    return productivePasses === maxDrainPasses
  }

  async function maybeResetStaleClaims(): Promise<void> {
    const currentTime = now().getTime()
    if (currentTime - lastRecoveryAt < STALE_CLAIM_SWEEP_INTERVAL_MS) return
    lastRecoveryAt = currentTime
    await deps.repository.resetStaleClaims(STALE_CLAIM_LEASE_MS, STALE_CLAIM_SWEEP_LIMIT)
  }

  function schedule(delay: number): void {
    if (stopped) return
    timer = setTimer(() => {
      timer = undefined
      void runOnce().then(
        () => schedule(shouldContinueImmediately ? 0 : pollIntervalMs),
        () => schedule(Math.floor(random() * pollIntervalMs)),
      )
    }, delay)
  }

  async function runOnce(): Promise<void> {
    if (activeRun) return activeRun
    const run = (async () => {
      shouldContinueImmediately = false
      await maybeResetStaleClaims()
      shouldContinueImmediately = await drainClaimedBatches()
    })()
    activeRun = run
    try {
      await run
    } finally {
      if (activeRun === run) activeRun = undefined
    }
  }

  return {
    runOnce,
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
