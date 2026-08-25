import { describe, expect, test, vi } from 'vitest'
import { ExtensionJournalOwnerMissingError } from '../extensions/journal.js'
import { ClientEventOwnershipError } from '../db.js'
import { createInboxWorker, safeMaterializationError } from '../inbox-worker.js'
import { LostClaimError, type InboxRow } from '../ingress/inbox-repository.js'
import { EventMaterializer } from '../materialization/event-materializer.js'

function row(overrides: Partial<InboxRow> = {}): InboxRow {
  return {
    inboxId: 1, userId: 1, daemonId: 'd1', daemonGeneration: 1, seq: 1,
    dedupKey: 'event-1', sessionId: 'session-1', eventType: 'agent_text', priorityClass: 1,
    schemaVersion: 1, occurredAt: null, receivedAt: new Date(0), payload: { type: 'agent_text' },
    materializationContext: {},
    status: 1, attempts: 1, availableAt: new Date(0), claimedAt: new Date(0), claimedBy: 'worker',
    completedAt: null, materializedEventId: null, lastError: null,
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

describe('inbox worker', () => {
  test('catches up a controlled ten-minute accepted backlog through outbox without duplicate materialization', async () => {
    let now = new Date('2026-07-29T00:00:00.000Z')
    const backlog = [row({ receivedAt: now })]
    const repository = {
      resetStaleClaims: vi.fn().mockResolvedValue(0),
      claimBatch: vi.fn(async () => backlog.splice(0)),
      renewClaims: vi.fn(),
      complete: vi.fn(),
      reschedule: vi.fn(),
      deadLetter: vi.fn(),
    }
    const delivery = {
      inboxId: 1,
      daemonId: 'd1',
      eventId: 91,
      userId: 1,
      audience: 'session' as const,
      sessionId: 'session-1',
      requestId: null,
      ordinal: 0,
      deliveryKey: 'event:91:session:-:0',
      type: 'agent_text',
      payload: { type: 'agent_text', session_id: 'session-1', usage: { input_tokens: 3 } },
    }
    const materializer = {
      materialize: vi.fn().mockResolvedValue({ eventId: 91, deliveries: [delivery] }),
    }
    const outboxWriter = { complete: vi.fn().mockResolvedValue(undefined) }
    const worker = createInboxWorker({
      repository,
      materializer: materializer as never,
      outboxWriter: outboxWriter as never,
      workerId: 'worker',
      shardCount: 1,
      shardIndex: 0,
      now: () => now,
    })

    // Admission already ACKed the durable Inbox row; the worker is absent for
    // ten controlled minutes, so no wall-clock sleep is involved.
    now = new Date(now.getTime() + 600_000)
    expect(materializer.materialize).not.toHaveBeenCalled()
    expect(backlog).toHaveLength(1)

    await worker.runOnce()
    await worker.runOnce()

    expect(materializer.materialize).toHaveBeenCalledOnce()
    expect(outboxWriter.complete).toHaveBeenCalledOnce()
    expect(outboxWriter.complete).toHaveBeenCalledWith(1, 91, [delivery], 'worker', 1)
    expect(repository.complete).not.toHaveBeenCalled()
    expect(backlog).toHaveLength(0)
  })

  test('passes persisted materialization context to a fresh worker materializer', async () => {
    const materializationContext = {
      agentType: 'codex', cwd: '/repo', requestId: 'req-1',
      reservationId: 'reservation-1', hostname: 'host-1',
    }
    const repository = {
      resetStaleClaims: vi.fn().mockResolvedValue(0),
      claimBatch: vi.fn()
        .mockResolvedValueOnce([row({ materializationContext })])
        .mockResolvedValue([]),
      renewClaims: vi.fn(),
      complete: vi.fn(),
      reschedule: vi.fn(),
      deadLetter: vi.fn(),
    }
    const materializer = {
      materialize: vi.fn().mockResolvedValue({ eventId: 91, deliveries: [] }),
    }
    const worker = createInboxWorker({
      repository, materializer: materializer as never,
      workerId: 'worker', shardCount: 1, shardIndex: 0,
    })

    await worker.runOnce()

    expect(materializer.materialize).toHaveBeenCalledWith(
      expect.objectContaining({ context: materializationContext }),
      undefined,
      expect.objectContaining({ assertClaim: expect.any(Function) }),
    )
  })

  test('does not materialize seq 2 before seq 1 from the same daemon', async () => {
    const first = deferred<void>()
    const seen: number[] = []
    const repository = { resetStaleClaims: vi.fn().mockResolvedValue(0), claimBatch: vi.fn().mockResolvedValueOnce([row({ seq: 1 }), row({ inboxId: 2, seq: 2 })]).mockResolvedValue([]), renewClaims: vi.fn(), complete: vi.fn(), reschedule: vi.fn(), deadLetter: vi.fn() }
    const materializer = { materialize: vi.fn(async (input: { inboxId: number }) => {
      const seq = input.inboxId
      seen.push(seq)
      if (seq === 1) await first.promise
      return { eventId: seq, deliveries: [] }
    }) }
    const worker = createInboxWorker({ repository, materializer: materializer as never, workerId: 'worker', shardCount: 1, shardIndex: 0 })

    const running = worker.runOnce()
    await vi.waitFor(() => expect(seen).toEqual([1]))
    expect(seen).toEqual([1])
    first.resolve()
    await running
    expect(seen).toEqual([1, 2])
  })

  test('reschedules a failed row with exponential delay and a controlled error code', async () => {
    const repository = { resetStaleClaims: vi.fn().mockResolvedValue(0), claimBatch: vi.fn().mockResolvedValueOnce([row({ attempts: 2 })]).mockResolvedValue([]), renewClaims: vi.fn(), complete: vi.fn(), reschedule: vi.fn(), deadLetter: vi.fn() }
    const materializer = { materialize: vi.fn().mockRejectedValue(new Error('token=secret user text must not persist')) }
    const now = new Date('2026-07-28T00:00:00.000Z')
    const worker = createInboxWorker({ repository, materializer: materializer as never, workerId: 'worker', shardCount: 1, shardIndex: 0, now: () => now, random: () => 0 })

    await worker.runOnce()

    expect(repository.reschedule).toHaveBeenCalledWith(1, 2, new Date(now.getTime() + 1_000), 'materialization_failed', 'worker')
    expect(repository.reschedule.mock.calls[0][3]).not.toContain('secret')
  })

  test('dead-letters the twelfth failure and marks control events as a release blocker', async () => {
    const onDeadLetter = vi.fn()
    const repository = { resetStaleClaims: vi.fn().mockResolvedValue(0), claimBatch: vi.fn().mockResolvedValueOnce([row({ attempts: 12, priorityClass: 0 })]).mockResolvedValue([]), renewClaims: vi.fn(), complete: vi.fn(), reschedule: vi.fn(), deadLetter: vi.fn() }
    const materializer = { materialize: vi.fn().mockRejectedValue(Object.assign(new Error('bad request'), { name: 'SchemaValidationError' })) }
    const worker = createInboxWorker({ repository, materializer: materializer as never, workerId: 'worker', shardCount: 1, shardIndex: 0, onDeadLetter })

    await worker.runOnce()

    expect(repository.deadLetter).toHaveBeenCalledWith(1, 12, 'schema_validation', 'worker')
    expect(onDeadLetter).toHaveBeenCalledWith(expect.objectContaining({ inboxId: 1 }), 'schema_validation', true)
  })

  test('does not let concurrent runOnce calls claim or materialize the same inbox twice', async () => {
    const gate = deferred<void>()
    const repository = { resetStaleClaims: vi.fn().mockResolvedValue(0), claimBatch: vi.fn().mockResolvedValueOnce([row()]).mockResolvedValue([]), renewClaims: vi.fn(), complete: vi.fn(), reschedule: vi.fn(), deadLetter: vi.fn() }
    const materializer = { materialize: vi.fn(async () => { await gate.promise; return { eventId: 1, deliveries: [] } }) }
    const worker = createInboxWorker({ repository, materializer: materializer as never, workerId: 'worker', shardCount: 1, shardIndex: 0 })

    const first = worker.runOnce()
    const second = worker.runOnce()
    await vi.waitFor(() => expect(repository.claimBatch).toHaveBeenCalledOnce())
    expect(repository.claimBatch).toHaveBeenCalledOnce()
    gate.resolve()
    await Promise.all([first, second])
    expect(materializer.materialize).toHaveBeenCalledOnce()
  })

  test('classifies unsafe errors without retaining user data', () => {
    expect(safeMaterializationError(new Error('Bearer token and command text'))).toBe('materialization_failed')
    expect(safeMaterializationError(Object.assign(new Error('x'), { name: 'OwnershipError' }))).toBe('ownership_mismatch')
  })

  test('passes claimed_by and attempts as the completion fence', async () => {
    const repository = { resetStaleClaims: vi.fn().mockResolvedValue(0), claimBatch: vi.fn().mockResolvedValueOnce([row({ claimedBy: 'worker-a', attempts: 4 })]).mockResolvedValue([]), renewClaims: vi.fn(), complete: vi.fn(), reschedule: vi.fn(), deadLetter: vi.fn() }
    const materializer = { materialize: vi.fn().mockResolvedValue({ eventId: 81, deliveries: [] }) }
    const worker = createInboxWorker({ repository, materializer: materializer as never, workerId: 'worker-a', shardCount: 1, shardIndex: 0 })

    await worker.runOnce()

    expect(repository.complete).toHaveBeenCalledWith(1, 81, 'worker-a', 4)
  })

  test('does not let a stale owner reschedule after losing its claim', async () => {
    const repository = {
      resetStaleClaims: vi.fn().mockResolvedValue(0),
      claimBatch: vi.fn().mockResolvedValueOnce([row({ claimedBy: 'old-worker', attempts: 3 })]).mockResolvedValue([]),
      renewClaims: vi.fn(),
      complete: vi.fn().mockRejectedValue(new LostClaimError(1)),
      reschedule: vi.fn(),
      deadLetter: vi.fn(),
    }
    const materializer = { materialize: vi.fn().mockResolvedValue({ eventId: 81, deliveries: [] }) }
    const worker = createInboxWorker({ repository, materializer: materializer as never, workerId: 'old-worker', shardCount: 1, shardIndex: 0 })

    await worker.runOnce()

    expect(repository.reschedule).not.toHaveBeenCalled()
    expect(repository.deadLetter).not.toHaveBeenCalled()
  })

  test('sweeps stale claims at startup and at most once per sixty seconds', async () => {
    let nowMs = 1_000_000
    const repository = {
      resetStaleClaims: vi.fn().mockResolvedValue(0),
      claimBatch: vi.fn().mockResolvedValue([]),
      renewClaims: vi.fn(),
      complete: vi.fn(), reschedule: vi.fn(), deadLetter: vi.fn(),
    }
    const worker = createInboxWorker({
      repository, materializer: { materialize: vi.fn() } as never,
      workerId: 'worker', shardCount: 1, shardIndex: 0, now: () => new Date(nowMs),
    })

    await worker.runOnce()
    nowMs += 59_999
    await worker.runOnce()
    nowMs += 1
    await worker.runOnce()

    expect(repository.resetStaleClaims).toHaveBeenCalledTimes(2)
    expect(repository.resetStaleClaims).toHaveBeenNthCalledWith(1, 300_000, 1_000)
    expect(repository.resetStaleClaims).toHaveBeenNthCalledWith(2, 300_000, 1_000)
  })

  test('does not retry a failed recovery query on every fifty-millisecond poll', async () => {
    let nowMs = 1_000_000
    const repository = {
      resetStaleClaims: vi.fn()
        .mockRejectedValueOnce(new Error('recovery unavailable'))
        .mockResolvedValueOnce(0),
      claimBatch: vi.fn().mockResolvedValue([]),
      renewClaims: vi.fn(),
      complete: vi.fn(), reschedule: vi.fn(), deadLetter: vi.fn(),
    }
    const worker = createInboxWorker({
      repository,
      materializer: { materialize: vi.fn() } as never,
      workerId: 'worker',
      shardCount: 1,
      shardIndex: 0,
      now: () => new Date(nowMs),
    })

    await expect(worker.runOnce()).rejects.toThrow('recovery unavailable')
    nowMs += 50
    await expect(worker.runOnce()).resolves.toBeUndefined()
    expect(repository.resetStaleClaims).toHaveBeenCalledOnce()
    nowMs += 59_950
    await expect(worker.runOnce()).resolves.toBeUndefined()
    expect(repository.resetStaleClaims).toHaveBeenCalledTimes(2)
  })

  test('reuses the original non-zero event id when inbox completion fails and the row is retried', async () => {
    let completed = false
    const ledgerPool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('INSERT INTO events')) {
          return {
            rows: [{ id: 73, inserted: !completed, effect_status: completed ? 'completed' : 'pending', effect_step: 0 }],
            rowCount: 1,
          }
        }
        if (sql.includes('SELECT effect_status')) {
          return { rows: [{ effect_status: completed ? 'completed' : 'pending', effect_step: 0 }], rowCount: 1 }
        }
        if (sql.includes("effect_status = 'completed'")) completed = true
        return { rows: [], rowCount: 1 }
      }),
    }
    const repository = {
      resetStaleClaims: vi.fn().mockResolvedValue(0),
      claimBatch: vi.fn()
        .mockResolvedValueOnce([row({ attempts: 1 })])
        .mockResolvedValueOnce([row({ attempts: 2 })])
        .mockResolvedValue([]),
      renewClaims: vi.fn(),
      complete: vi.fn()
        .mockRejectedValueOnce(new Error('completion write failed'))
        .mockResolvedValueOnce(undefined),
      reschedule: vi.fn().mockResolvedValue(undefined),
      deadLetter: vi.fn(),
    }
    const worker = createInboxWorker({
      repository,
      materializer: new EventMaterializer({ pool: ledgerPool as never }),
      workerId: 'worker',
      shardCount: 1,
      shardIndex: 0,
      random: () => 0,
    })

    await worker.runOnce()
    await worker.runOnce()

    expect(repository.complete.mock.calls.map(call => call[1])).toEqual([73, 73])
    expect(repository.reschedule).toHaveBeenCalledOnce()
  })

  test('leaves a failed completion write recoverable when its reschedule write also fails', async () => {
    let nowMs = 1_000_000
    const repository = {
      resetStaleClaims: vi.fn().mockResolvedValue(1),
      claimBatch: vi.fn()
        .mockResolvedValueOnce([row({ attempts: 1, claimedBy: 'worker' })])
        .mockResolvedValueOnce([row({ attempts: 2, claimedBy: 'worker' })])
        .mockResolvedValue([]),
      renewClaims: vi.fn(),
      complete: vi.fn()
        .mockRejectedValueOnce(new Error('completion write failed'))
        .mockResolvedValueOnce(undefined),
      reschedule: vi.fn().mockRejectedValueOnce(new Error('reschedule write failed')),
      deadLetter: vi.fn(),
    }
    const materializer = { materialize: vi.fn().mockResolvedValue({ eventId: 73, deliveries: [] }) }
    const worker = createInboxWorker({
      repository,
      materializer: materializer as never,
      workerId: 'worker',
      shardCount: 1,
      shardIndex: 0,
      now: () => new Date(nowMs),
      random: () => 0,
    })

    await expect(worker.runOnce()).rejects.toThrow('reschedule write failed')
    nowMs += 300_001
    await expect(worker.runOnce()).resolves.toBeUndefined()

    expect(repository.resetStaleClaims).toHaveBeenCalledTimes(2)
    expect(materializer.materialize).toHaveBeenCalledTimes(2)
    expect(repository.complete.mock.calls.map(call => call[3])).toEqual([1, 2])
  })

  test('heartbeats the entire claimed batch while a slow first row runs beyond the stale lease', async () => {
    const slow = deferred<void>()
    let heartbeat: (() => void) | undefined
    let nowMs = 1_000_000
    const repository = {
      resetStaleClaims: vi.fn().mockResolvedValue(0),
      claimBatch: vi.fn().mockResolvedValueOnce([
        row({ inboxId: 1, daemonId: 'd1', attempts: 1 }),
        row({ inboxId: 2, daemonId: 'd2', attempts: 1 }),
      ]).mockResolvedValue([]),
      renewClaims: vi.fn().mockResolvedValue(new Set([1, 2])),
      complete: vi.fn(), reschedule: vi.fn(), deadLetter: vi.fn(),
    }
    const materializer = {
      materialize: vi.fn(async (input: { inboxId: number }) => {
        if (input.inboxId === 1) await slow.promise
        return { eventId: input.inboxId, deliveries: [] }
      }),
    }
    const worker = createInboxWorker({
      repository,
      materializer: materializer as never,
      workerId: 'worker',
      shardCount: 1,
      shardIndex: 0,
      now: () => new Date(nowMs),
      setTimer: (callback) => {
        heartbeat = callback
        return 1 as never
      },
      clearTimer: vi.fn(),
    })

    const running = worker.runOnce()
    await vi.waitFor(() => expect(heartbeat).toBeTypeOf('function'))
    for (let elapsed = 100_000; elapsed <= 400_000; elapsed += 100_000) {
      nowMs += 100_000
      heartbeat!()
      await vi.waitFor(() => expect(repository.renewClaims).toHaveBeenCalledTimes(elapsed / 100_000))
    }
    expect(repository.renewClaims).toHaveBeenLastCalledWith([
      { inboxId: 1, attempts: 1 },
      { inboxId: 2, attempts: 1 },
    ], 'worker')
    expect(materializer.materialize).toHaveBeenCalledTimes(1)

    slow.resolve()
    await running
    expect(repository.complete).toHaveBeenCalledTimes(2)
  })

  test('stops late effects when a heartbeat reports that the worker lost its claim', async () => {
    const effectGate = deferred<void>()
    let heartbeat: (() => void) | undefined
    const mutation = vi.fn()
    const repository = {
      resetStaleClaims: vi.fn().mockResolvedValue(0),
      claimBatch: vi.fn().mockResolvedValueOnce([row({ inboxId: 1, attempts: 3 })]).mockResolvedValue([]),
      renewClaims: vi.fn().mockResolvedValue(new Set<number>()),
      complete: vi.fn(), reschedule: vi.fn(), deadLetter: vi.fn(),
    }
    const materializer = {
      materialize: vi.fn(async (
        _input: unknown,
        _effect: unknown,
        options: { assertClaim: () => Promise<void> },
      ) => {
        await effectGate.promise
        await options.assertClaim()
        mutation()
        return { eventId: 81, deliveries: [] }
      }),
    }
    const worker = createInboxWorker({
      repository,
      materializer: materializer as never,
      workerId: 'worker',
      shardCount: 1,
      shardIndex: 0,
      setTimer: (callback) => {
        heartbeat = callback
        return 1 as never
      },
      clearTimer: vi.fn(),
    })

    const running = worker.runOnce()
    await vi.waitFor(() => expect(heartbeat).toBeTypeOf('function'))
    heartbeat!()
    await vi.waitFor(() => expect(repository.renewClaims).toHaveBeenCalledOnce())
    effectGate.resolve()
    await running

    expect(mutation).not.toHaveBeenCalled()
    expect(repository.complete).not.toHaveBeenCalled()
    expect(repository.reschedule).not.toHaveBeenCalled()
    expect(repository.deadLetter).not.toHaveBeenCalled()
  })

  test('keeps its service polling timer referenced after start', async () => {
    const serviceTimer = { unref: vi.fn() }
    const repository = {
      resetStaleClaims: vi.fn().mockResolvedValue(0),
      claimBatch: vi.fn().mockResolvedValue([]),
      renewClaims: vi.fn(), complete: vi.fn(), reschedule: vi.fn(), deadLetter: vi.fn(),
    }
    const worker = createInboxWorker({
      repository,
      materializer: { materialize: vi.fn() } as never,
      workerId: 'worker',
      shardCount: 1,
      shardIndex: 0,
      setTimer: vi.fn(() => serviceTimer as never),
      clearTimer: vi.fn(),
    })

    worker.start()

    expect(serviceTimer.unref).not.toHaveBeenCalled()
    await worker.stop()
  })
})

describe('inbox worker bounded drain', () => {
  function orderedRowsRepository(total: number, overrides: Partial<InboxRow> = {}) {
    const rows: InboxRow[] = Array.from({ length: total }, (_, index) => row({
      inboxId: index + 1,
      seq: index + 1,
      dedupKey: `event-${index + 1}`,
      ...overrides,
    }))
    let next = 0
    const repository = {
      resetStaleClaims: vi.fn().mockResolvedValue(0),
      // The real claim SQL admits only the minimum pending seq per daemon
      // generation, so a same-daemon backlog surfaces exactly one ordered row
      // per claim until it is empty.
      claimBatch: vi.fn(async () => {
        if (next >= rows.length) return []
        const claimed = [rows[next]]
        next += 1
        return claimed
      }),
      renewClaims: vi.fn().mockResolvedValue(new Set<number>()),
      complete: vi.fn().mockResolvedValue(undefined),
      reschedule: vi.fn().mockResolvedValue(undefined),
      deadLetter: vi.fn().mockResolvedValue(undefined),
    }
    return { repository }
  }

  test('drains a same-daemon backlog through bounded passes in one run', async () => {
    const { repository } = orderedRowsRepository(200)
    const materializer = { materialize: vi.fn().mockResolvedValue({ eventId: 1, deliveries: [] }) }
    const worker = createInboxWorker({
      repository,
      materializer: materializer as never,
      workerId: 'worker',
      shardCount: 1,
      shardIndex: 0,
      maxDrainPasses: 32,
      pollIntervalMs: 50,
    })

    await worker.runOnce()

    expect(repository.claimBatch).toHaveBeenCalledTimes(32)
    expect(materializer.materialize.mock.calls.map(call => call[0].inboxId))
      .toEqual(Array.from({ length: 32 }, (_, index) => index + 1))
    expect(repository.complete).toHaveBeenCalledTimes(32)
    expect(repository.resetStaleClaims).toHaveBeenCalledOnce()
  })

  test('schedules an immediate continuation after the drain budget is exhausted', async () => {
    let claims = 0
    const repository = {
      resetStaleClaims: vi.fn().mockResolvedValue(0),
      claimBatch: vi.fn(async () => {
        claims += 1
        return [row({ inboxId: claims, seq: claims, dedupKey: `event-${claims}` })]
      }),
      renewClaims: vi.fn().mockResolvedValue(new Set<number>()),
      complete: vi.fn().mockResolvedValue(undefined),
      reschedule: vi.fn().mockResolvedValue(undefined),
      deadLetter: vi.fn().mockResolvedValue(undefined),
    }
    const materializer = { materialize: vi.fn().mockResolvedValue({ eventId: 1, deliveries: [] }) }
    const timers = new Map<number, { callback: () => void; delayMs: number }>()
    let nextTimerId = 1
    const setTimer = (callback: () => void, delayMs: number) => {
      const id = nextTimerId
      nextTimerId += 1
      timers.set(id, { callback, delayMs })
      return id as never
    }
    const clearTimer = (id: ReturnType<typeof setTimeout>) => { timers.delete(id as never) }
    const HEARTBEAT_INTERVAL_MS = 999_999
    const pendingServiceTimer = () => {
      for (const timer of timers.values()) {
        if (timer.delayMs !== HEARTBEAT_INTERVAL_MS) return timer
      }
      return undefined
    }
    const fireFirstServiceTimer = () => {
      for (const [id, entry] of timers) {
        if (entry.delayMs !== HEARTBEAT_INTERVAL_MS) {
          timers.delete(id)
          entry.callback()
          return
        }
      }
      throw new Error('no service timer pending')
    }
    const worker = createInboxWorker({
      repository,
      materializer: materializer as never,
      workerId: 'worker',
      shardCount: 1,
      shardIndex: 0,
      maxDrainPasses: 2,
      pollIntervalMs: 50,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      setTimer,
      clearTimer,
    })

    worker.start()
    const initial = pendingServiceTimer()
    expect(initial?.delayMs).toBe(0)
    fireFirstServiceTimer()
    await vi.waitFor(() => expect(pendingServiceTimer()?.delayMs).toBe(0))
    expect(repository.claimBatch).toHaveBeenCalledTimes(2)

    fireFirstServiceTimer()
    await vi.waitFor(() => expect(pendingServiceTimer()?.delayMs).toBe(0))
    expect(repository.claimBatch).toHaveBeenCalledTimes(4)

    await worker.stop()
    expect(pendingServiceTimer()).toBeUndefined()
  })

  test('returns to the normal poll interval once a pass comes back empty', async () => {
    const repository = {
      resetStaleClaims: vi.fn().mockResolvedValue(0),
      claimBatch: vi.fn().mockResolvedValueOnce([row()]).mockResolvedValue([]),
      renewClaims: vi.fn().mockResolvedValue(new Set<number>()),
      complete: vi.fn().mockResolvedValue(undefined),
      reschedule: vi.fn().mockResolvedValue(undefined),
      deadLetter: vi.fn().mockResolvedValue(undefined),
    }
    const materializer = { materialize: vi.fn().mockResolvedValue({ eventId: 1, deliveries: [] }) }
    const timers = new Map<number, { callback: () => void; delayMs: number }>()
    let nextTimerId = 1
    const worker = createInboxWorker({
      repository,
      materializer: materializer as never,
      workerId: 'worker',
      shardCount: 1,
      shardIndex: 0,
      maxDrainPasses: 4,
      pollIntervalMs: 50,
      heartbeatIntervalMs: 999_999,
      setTimer: (callback, delayMs) => {
        const id = nextTimerId
        nextTimerId += 1
        timers.set(id, { callback, delayMs })
        return id as never
      },
      clearTimer: (id: ReturnType<typeof setTimeout>) => { timers.delete(id as never) },
    })
    const fireFirstServiceTimer = () => {
      for (const [id, entry] of timers) {
        if (entry.delayMs !== 999_999) {
          timers.delete(id)
          entry.callback()
          return
        }
      }
      throw new Error('no service timer pending')
    }

    worker.start()
    fireFirstServiceTimer()
    await vi.waitFor(() => {
      const timer = [...timers.values()].find(entry => entry.delayMs !== 999_999)
      expect(timer?.delayMs).toBe(50)
    })
    // The empty probe stops the drain instead of burning the whole budget.
    expect(repository.claimBatch).toHaveBeenCalledTimes(2)
    await worker.stop()
  })

  test('keeps the bounded jitter retry when a drain pass fails', async () => {
    const repository = {
      resetStaleClaims: vi.fn().mockResolvedValue(0),
      claimBatch: vi.fn().mockRejectedValueOnce(new Error('database unavailable')).mockResolvedValue([]),
      renewClaims: vi.fn().mockResolvedValue(new Set<number>()),
      complete: vi.fn().mockResolvedValue(undefined),
      reschedule: vi.fn().mockResolvedValue(undefined),
      deadLetter: vi.fn().mockResolvedValue(undefined),
    }
    const timers = new Map<number, { callback: () => void; delayMs: number }>()
    let nextTimerId = 1
    const worker = createInboxWorker({
      repository,
      materializer: { materialize: vi.fn() } as never,
      workerId: 'worker',
      shardCount: 1,
      shardIndex: 0,
      maxDrainPasses: 4,
      pollIntervalMs: 50,
      random: () => 0.5,
      setTimer: (callback, delayMs) => {
        const id = nextTimerId
        nextTimerId += 1
        timers.set(id, { callback, delayMs })
        return id as never
      },
      clearTimer: (id: ReturnType<typeof setTimeout>) => { timers.delete(id as never) },
    })
    const fireFirstServiceTimer = () => {
      for (const [id, entry] of timers) {
        if (entry.delayMs !== 999_999) {
          timers.delete(id)
          entry.callback()
          return
        }
      }
      throw new Error('no service timer pending')
    }

    worker.start()
    fireFirstServiceTimer()
    await vi.waitFor(() => {
      const timer = [...timers.values()].find(entry => entry.delayMs !== 999_999)
      expect(timer?.delayMs).toBe(25)
    })
    await worker.stop()
  })

  test('stop cancels a scheduled continuation timer and waits for the active run', async () => {
    const gate = deferred<void>()
    let claims = 0
    const repository = {
      resetStaleClaims: vi.fn().mockResolvedValue(0),
      claimBatch: vi.fn(async () => {
        claims += 1
        return [row({ inboxId: claims, seq: claims, dedupKey: `event-${claims}` })]
      }),
      renewClaims: vi.fn().mockResolvedValue(new Set<number>()),
      complete: vi.fn().mockResolvedValue(undefined),
      reschedule: vi.fn().mockResolvedValue(undefined),
      deadLetter: vi.fn().mockResolvedValue(undefined),
    }
    const materializer = { materialize: vi.fn(async (input: { inboxId: number }) => {
      if (input.inboxId === 1) await gate.promise
      return { eventId: input.inboxId, deliveries: [] }
    }) }
    const timers = new Map<number, { callback: () => void; delayMs: number }>()
    let nextTimerId = 1
    const worker = createInboxWorker({
      repository,
      materializer: materializer as never,
      workerId: 'worker',
      shardCount: 1,
      shardIndex: 0,
      maxDrainPasses: 1,
      pollIntervalMs: 50,
      heartbeatIntervalMs: 999_999,
      setTimer: (callback, delayMs) => {
        const id = nextTimerId
        nextTimerId += 1
        timers.set(id, { callback, delayMs })
        return id as never
      },
      clearTimer: (id: ReturnType<typeof setTimeout>) => { timers.delete(id as never) },
    })
    const fireFirstServiceTimer = () => {
      for (const [id, entry] of timers) {
        if (entry.delayMs !== 999_999) {
          timers.delete(id)
          entry.callback()
          return
        }
      }
      throw new Error('no service timer pending')
    }

    worker.start()
    fireFirstServiceTimer()
    await vi.waitFor(() => expect(materializer.materialize).toHaveBeenCalledOnce())

    const stopping = worker.stop()
    gate.resolve()
    await stopping

    const pending = [...timers.values()].filter(entry => entry.delayMs !== 999_999)
    expect(pending).toEqual([])
    expect(repository.claimBatch).toHaveBeenCalledOnce()
  })
})

describe('inbox worker permanent security rejections', () => {
  function ownershipError(code: string) {
    return Object.assign(new Error('daemon session authorization failed'), {
      code, permanent: true,
    })
  }

  test('classifies ownership violations as permanent non-retrying error codes', () => {
    expect(safeMaterializationError(ownershipError('session_ownership_violation')))
      .toBe('session_ownership_violation')
    expect(safeMaterializationError(ownershipError('unknown_daemon_session')))
      .toBe('unknown_daemon_session')
  })

  test.each([
    ['session_ownership_violation'],
    ['unknown_daemon_session'],
  ])('%s dead-letters immediately without outbox or retry', async (code) => {
    const claimed = row({ attempts: 1 })
    const repository = {
      resetStaleClaims: vi.fn().mockResolvedValue(0),
      claimBatch: vi.fn()
        .mockResolvedValueOnce([claimed])
        .mockResolvedValue([]),
      renewClaims: vi.fn(),
      complete: vi.fn(),
      reschedule: vi.fn(),
      deadLetter: vi.fn(),
    }
    const materializer = {
      materialize: vi.fn().mockRejectedValue(ownershipError(code)),
    }
    const outboxWriter = { complete: vi.fn().mockResolvedValue(undefined) }
    const onDeadLetter = vi.fn()
    const worker = createInboxWorker({
      repository,
      materializer: materializer as never,
      outboxWriter: outboxWriter as never,
      workerId: 'worker',
      shardCount: 1,
      shardIndex: 0,
      onDeadLetter,
    })

    await worker.runOnce()

    expect(repository.deadLetter).toHaveBeenCalledWith(1, 1, code, 'worker')
    expect(repository.reschedule).not.toHaveBeenCalled()
    expect(outboxWriter.complete).not.toHaveBeenCalled()
    expect(onDeadLetter).toHaveBeenCalledOnce()
  })

  test('transient materialization failures keep the retry path', async () => {
    const repository = {
      resetStaleClaims: vi.fn().mockResolvedValue(0),
      claimBatch: vi.fn()
        .mockResolvedValueOnce([row({ attempts: 1 })])
        .mockResolvedValue([]),
      renewClaims: vi.fn(),
      complete: vi.fn(),
      reschedule: vi.fn(),
      deadLetter: vi.fn(),
    }
    const materializer = {
      materialize: vi.fn().mockRejectedValue(new Error('connection reset')),
    }
    const worker = createInboxWorker({
      repository,
      materializer: materializer as never,
      workerId: 'worker',
      shardCount: 1,
      shardIndex: 0,
    })

    await worker.runOnce()

    expect(repository.reschedule).toHaveBeenCalledOnce()
    expect(repository.deadLetter).not.toHaveBeenCalled()
  })
})


describe('extension authorization defects dead-letter immediately', () => {
  test('journal owner missing and client ownership errors are permanent', async () => {
    const { isPermanentMaterializationError, safeMaterializationError } = await import('../inbox-worker.js')
    expect(isPermanentMaterializationError(new ExtensionJournalOwnerMissingError())).toBe(true)
    expect(isPermanentMaterializationError(new ClientEventOwnershipError())).toBe(true)
    expect(safeMaterializationError(new ExtensionJournalOwnerMissingError())).toBe('extension_journal_owner_missing')
    expect(safeMaterializationError(new ClientEventOwnershipError())).toBe('client_event_ownership_mismatch')
  })
})
