import { describe, expect, test, vi } from 'vitest'
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
      claimBatch: vi.fn().mockResolvedValue([row({ materializationContext })]),
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
    const repository = { resetStaleClaims: vi.fn().mockResolvedValue(0), claimBatch: vi.fn().mockResolvedValue([row({ seq: 1 }), row({ inboxId: 2, seq: 2 })]), renewClaims: vi.fn(), complete: vi.fn(), reschedule: vi.fn(), deadLetter: vi.fn() }
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
    const repository = { resetStaleClaims: vi.fn().mockResolvedValue(0), claimBatch: vi.fn().mockResolvedValue([row({ attempts: 2 })]), renewClaims: vi.fn(), complete: vi.fn(), reschedule: vi.fn(), deadLetter: vi.fn() }
    const materializer = { materialize: vi.fn().mockRejectedValue(new Error('token=secret user text must not persist')) }
    const now = new Date('2026-07-28T00:00:00.000Z')
    const worker = createInboxWorker({ repository, materializer: materializer as never, workerId: 'worker', shardCount: 1, shardIndex: 0, now: () => now, random: () => 0 })

    await worker.runOnce()

    expect(repository.reschedule).toHaveBeenCalledWith(1, 2, new Date(now.getTime() + 1_000), 'materialization_failed', 'worker')
    expect(repository.reschedule.mock.calls[0][3]).not.toContain('secret')
  })

  test('dead-letters the twelfth failure and marks control events as a release blocker', async () => {
    const onDeadLetter = vi.fn()
    const repository = { resetStaleClaims: vi.fn().mockResolvedValue(0), claimBatch: vi.fn().mockResolvedValue([row({ attempts: 12, priorityClass: 0 })]), renewClaims: vi.fn(), complete: vi.fn(), reschedule: vi.fn(), deadLetter: vi.fn() }
    const materializer = { materialize: vi.fn().mockRejectedValue(Object.assign(new Error('bad request'), { name: 'SchemaValidationError' })) }
    const worker = createInboxWorker({ repository, materializer: materializer as never, workerId: 'worker', shardCount: 1, shardIndex: 0, onDeadLetter })

    await worker.runOnce()

    expect(repository.deadLetter).toHaveBeenCalledWith(1, 12, 'schema_validation', 'worker')
    expect(onDeadLetter).toHaveBeenCalledWith(expect.objectContaining({ inboxId: 1 }), 'schema_validation', true)
  })

  test('does not let concurrent runOnce calls claim or materialize the same inbox twice', async () => {
    const gate = deferred<void>()
    const repository = { resetStaleClaims: vi.fn().mockResolvedValue(0), claimBatch: vi.fn().mockResolvedValue([row()]), renewClaims: vi.fn(), complete: vi.fn(), reschedule: vi.fn(), deadLetter: vi.fn() }
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
    const repository = { resetStaleClaims: vi.fn().mockResolvedValue(0), claimBatch: vi.fn().mockResolvedValue([row({ claimedBy: 'worker-a', attempts: 4 })]), renewClaims: vi.fn(), complete: vi.fn(), reschedule: vi.fn(), deadLetter: vi.fn() }
    const materializer = { materialize: vi.fn().mockResolvedValue({ eventId: 81, deliveries: [] }) }
    const worker = createInboxWorker({ repository, materializer: materializer as never, workerId: 'worker-a', shardCount: 1, shardIndex: 0 })

    await worker.runOnce()

    expect(repository.complete).toHaveBeenCalledWith(1, 81, 'worker-a', 4)
  })

  test('does not let a stale owner reschedule after losing its claim', async () => {
    const repository = {
      resetStaleClaims: vi.fn().mockResolvedValue(0),
      claimBatch: vi.fn().mockResolvedValue([row({ claimedBy: 'old-worker', attempts: 3 })]),
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
        .mockResolvedValueOnce([row({ attempts: 2 })]),
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
        .mockResolvedValueOnce([row({ attempts: 2, claimedBy: 'worker' })]),
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
      claimBatch: vi.fn().mockResolvedValue([
        row({ inboxId: 1, daemonId: 'd1', attempts: 1 }),
        row({ inboxId: 2, daemonId: 'd2', attempts: 1 }),
      ]),
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
      claimBatch: vi.fn().mockResolvedValue([row({ inboxId: 1, attempts: 3 })]),
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
