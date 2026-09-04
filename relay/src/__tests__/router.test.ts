import { describe, test, expect, vi, beforeEach } from 'vitest'
// Short the offline grace window so debounce tests run fast. Read by the Router
// constructor, so this must be set before any `new Router(...)`.
process.env.DAEMON_OFFLINE_GRACE_MS = '20'
process.env.DAEMON_OFFLINE_WRITE_TIMEOUT_MS = '20'
process.env.DAEMON_REVOCATION_CHECK_TIMEOUT_MS = '20'
process.env.DAEMON_REVOCATION_GATE_MAX_MESSAGES = '4'
process.env.DAEMON_REVOCATION_GATE_MAX_BYTES = '1024'
import { Router } from '../router.js'
import * as db from '../db.js'
import { checkpointKey } from '../ingress/controller.js'

function createNamedMockPools() {
  const make = () => createMockPool()
  return { control: make(), ingest: make(), query: make(), worker: make() }
}

// Mock pg.Pool
function createMockPool(eventInsertIDs?: number[]) {
  const queries: { sql: string; params: any[] }[] = []
  let lastEventID = 1
  const mockPool = {
    query: vi.fn((sql: string, params?: any[]) => {
      queries.push({ sql, params: params || [] })
      let result: any = { rows: [], rowCount: 0 }
      if (sql.includes('SELECT column_name')) {
        result = { rows: [{ column_name: 'last_activity_at' }, { column_name: 'exit_reason' }] }
      } else if (sql.includes('session_allowed')) {
        // Daemon-session ownership probe. The generic mock treats every
        // session as owned by the requesting daemon; auth-specific behaviour
        // is exercised by the ownership pool override in the security tests.
        result = { rows: [{ session_exists: true, session_allowed: true }], rowCount: 1 }
      } else if (sql.includes('ORDER BY session_id FOR UPDATE')) {
        // renameOwnedDaemonSession lock: every id resolves to a legacy
        // null-owner row bound to the generic daemon-1.
        const locked = (params || []).map((id) => ({ session_id: id, user_id: null, daemon_id: 'daemon-1' }))
        result = { rows: locked, rowCount: locked.length }
      } else if (sql.includes('INSERT INTO sessions') && sql.includes('RETURNING session_id')) {
        // Guarded session upserts report a successful owner-checked write.
        result = { rows: [{ session_id: params?.[0] }], rowCount: 1 }
      } else if (sql.includes('SELECT 1 FROM sessions')) {
        // isSessionOwnedByUser: ownership gate. The mock treats every session as
        // owned by the requesting user (auth-specific behaviour is exercised by
        // a dedicated pool override in the authorization tests below).
        result = { rows: [{ '?column?': 1 }], rowCount: 1 }
      } else if (sql.includes('ALTER TABLE')) {
        result = { rows: [] }
      } else if (sql.includes('FROM sessions') && sql.includes('SELECT')) {
        result = {
          rows: [{
            session_id: 'test-sid',
            user_id: 1,
            daemon_id: 'daemon-1',
            agent_type: 'claude-code',
            cwd: '/tmp',
            title: 'Test',
            source: 'terminal',
            status: 'running',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_activity_at: new Date().toISOString(),
            exit_reason: null,
            daemon_status: 'online',
          }]
        }
      } else if (sql.includes('FROM daemons')) {
        result = { rows: [{ daemon_id: 'daemon-1', status: 'online' }] }
      } else if (sql.includes('INSERT INTO events') && sql.includes('RETURNING id')) {
    const id = eventInsertIDs?.shift()
    if (id === 0) {
      result = { rows: [{ id: lastEventID, inserted: false, effect_status: 'completed', effect_step: 0 }] }
    } else {
      lastEventID = id ?? lastEventID
      result = { rows: [{ id: lastEventID, inserted: true, effect_status: 'pending', effect_step: 0 }] }
    }
      } else if (sql.includes('RETURNING id')) {
    result = { rows: [{ id: 1 }] }
      } else if (sql.includes('RETURNING daemon_id')) {
        result = { rows: [{ daemon_id: params?.[0] }], rowCount: 1 }
      } else if (sql.includes('session_target AS')) {
        result = { rows: [{ session_exists: true, claimed: true, applied: true }], rowCount: 1 }
      } else if (sql.includes("UPDATE daemons SET status = 'offline'")) {
        result = { rows: [], rowCount: 1 }
      } else if (sql.includes('UPDATE sessions')) {
        // Existing-row update path: report one affected row so update-only
        // helpers (updateSessionStatus) treat the session as real.
        result = { rows: [], rowCount: 1 }
      }
      return Promise.resolve(result)
    }),
    _queries: queries,
    connect: vi.fn(async () => ({
      query: (sql: string, params?: any[]) => mockPool.query(sql, params),
      release: vi.fn(),
    })),
    end: vi.fn(),
  }
  return mockPool as any
}

// Flush pending microtasks/timers so async persists (and the markPersisted that
// follows them) settle before assertions on the ack water-mark.
const tick = () => new Promise((r) => setTimeout(r, 20))

function forceAuthLeaseRefresh(router: any, daemonId = 'daemon-1'): void {
  const daemon = router.daemons.get(daemonId)
  router.authLeases.confirm(daemon.registrationId, Date.now() - 12_000)
}

function expireAuthLease(router: any, daemonId = 'daemon-1'): void {
  const daemon = router.daemons.get(daemonId)
  router.authLeases.confirm(daemon.registrationId, Date.now() - 31_000)
}

// Mock WebSocket
function createMockWs(): any {
  const sent: any[] = []
  return {
    readyState: 1, // OPEN
    send: vi.fn((data: string) => { sent.push(JSON.parse(data)) }),
    close: vi.fn(),
    terminate: vi.fn(),
    _sent: sent,
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

test('durable ingress flag off preserves the legacy persist-and-ack path', async () => {
  const pool = createMockPool()
  const repository = { persistBatch: vi.fn(), seedCheckpoint: vi.fn() }
  const router = new Router(pool, { durableIngress: { mode: 'off', repository } })
  const ws = createMockWs()
  await router.registerDaemon(ws, { type: 'register', daemon_id: 'legacy-d1', hostname: 'h', agents: [], started_at: 17 }, 1)
  router.handleDaemonMessage('legacy-d1', { type: 'agent_text', session_id: 's1', text: 'hello', seq: 1 })
  await tick()
  expect(repository.seedCheckpoint).not.toHaveBeenCalled()
  expect(repository.persistBatch).not.toHaveBeenCalled()
  expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO events'), expect.anything())
})

test('legacy inline materialization preserves the Relay receipt timestamp', async () => {
  const router = new Router(createMockPool(), { durableIngress: { mode: 'off' } })
  const ws = createMockWs()
  await router.registerDaemon(ws, {
    type: 'register', daemon_id: 'legacy-receipt', hostname: 'h', agents: [], started_at: 17,
  }, 1)
  const materialize = vi.fn(async (_input: any) => ({
    eventId: 1, inserted: true, completed: true, deliveries: [],
  }))
  ;(router as any).materializer = { materialize }
  const receivedAt = new Date('2026-08-09T23:59:59.900Z')

  router.handleDaemonMessage(
    'legacy-receipt',
    { type: 'agent_text', session_id: 's1', usage: { input_tokens: 1 }, seq: 1 },
    undefined,
    undefined,
    false,
    receivedAt,
  )
  await tick()

  expect(materialize.mock.calls[0]?.[0]).toMatchObject({ receivedAt })
})

test('rejects usage without a positive sequence when immutable accounting is enabled', async () => {
  const pool = createMockPool()
  const repository = {
    seedCheckpoint: vi.fn(async () => ({ daemonId: 'usage-no-seq', daemonGeneration: 17, ackSeq: 0 })),
    persistBatch: vi.fn(),
  }
  const router = new Router(pool, {
    durableIngress: { mode: 'on', repository },
    writeTokenUsageFacts: true,
  })
  const ws = createMockWs()
  await router.registerDaemon(ws, {
    type: 'register', daemon_id: 'usage-no-seq', hostname: 'h', agents: [], started_at: 17,
  }, 1)
  ws._sent.length = 0

  router.handleDaemonMessage('usage-no-seq', {
    type: 'agent_text', session_id: 's1', usage: { input_tokens: 1 },
  })
  await tick()

  expect(ws._sent).toContainEqual(expect.objectContaining({
    type: 'relay_overloaded', retryable: true, reason: 'token_usage_requires_seq',
  }))
  expect(repository.persistBatch).not.toHaveBeenCalled()
  expect(pool._queries.some((query: any) => query.sql.includes('INSERT INTO events'))).toBe(false)
})

test('normalizes NUL payload text before inline persistence and advances the contiguous ACK', async () => {
  const pool = createMockPool()
  const router = new Router(pool)
  const daemonWs = createMockWs()
  await router.registerDaemon(daemonWs, { type: 'register', daemon_id: 'nul-inline', hostname: 'h', agents: [], started_at: 17 }, 1)
  daemonWs._sent.length = 0

  router.handleDaemonMessage('nul-inline', { type: 'agent_text', session_id: 's1', text: 'before\u0000after', seq: 1 })
  router.handleDaemonMessage('nul-inline', { type: 'agent_text', session_id: 's1', text: 'next', seq: 2 })
  await tick()

  const inserts = pool._queries.filter((query: any) => query.sql.includes('INSERT INTO events'))
  expect(JSON.parse(inserts[0].params[2]).text).toBe('before\uFFFDafter')
  daemonWs._sent.length = 0
  router.handleDaemonMessage('nul-inline', { type: 'ping' })
  expect(daemonWs._sent).toContainEqual(expect.objectContaining({ type: 'event_ack', up_to_seq: 2 }))
})

test('durable ingress commits Inbox before its single ACK and skips legacy persistence', async () => {
  const pool = createMockPool()
  const repository = {
    seedCheckpoint: vi.fn(async () => ({ daemonId: 'durable-d1', daemonGeneration: 17, ackSeq: 0 })),
    persistBatch: vi.fn(async () => new Map([[checkpointKey('durable-d1', 17), {
      daemonId: 'durable-d1', daemonGeneration: 17, ackSeq: 1,
    }]])),
  }
  const router = new Router(pool, { durableIngress: { mode: 'on', repository } })
  const ws = createMockWs()
  await router.registerDaemon(ws, { type: 'register', daemon_id: 'durable-d1', hostname: 'h', agents: [], started_at: 17 }, 1)
  expect(ws._sent.find((message: any) => message.type === 'register_ack')).toEqual(expect.objectContaining({
    capabilities: ['durable_inbox', 'ack_watermark', 'flow_control', 'tool_output_stream_v1'],
    event_window: 128,
    max_event_bytes: 1_048_576,
    max_chunk_bytes: 131_072,
  }))
  router.handleDaemonMessage('durable-d1', { type: 'agent_text', session_id: 's1', text: 'hello', seq: 1 })
  await tick()
  expect(repository.persistBatch).toHaveBeenCalledTimes(1)
  expect(pool.query).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO events'), expect.anything())
  expect(ws._sent.find((message: any) => message.type === 'event_ack')).toEqual(expect.objectContaining({
    up_to_seq: 1, event_window: 128, daemon_generation: 17,
  }))
})

test('normalizes NUL payload text before durable ingress commits its inbox', async () => {
  const repository = {
    seedCheckpoint: vi.fn(async () => ({ daemonId: 'nul-durable', daemonGeneration: 17, ackSeq: 0 })),
    persistBatch: vi.fn(async () => new Map([[checkpointKey('nul-durable', 17), {
      daemonId: 'nul-durable', daemonGeneration: 17, ackSeq: 1,
    }]])),
  }
  const router = new Router(createMockPool(), { durableIngress: { mode: 'on', repository } })
  const daemonWs = createMockWs()
  await router.registerDaemon(daemonWs, { type: 'register', daemon_id: 'nul-durable', hostname: 'h', agents: [], started_at: 17 }, 1)
  daemonWs._sent.length = 0

  router.handleDaemonMessage('nul-durable', { type: 'tool_result', session_id: 's1', output: 'before\u0000after', seq: 1 })
  await tick()

  expect(repository.persistBatch).toHaveBeenCalledWith([expect.objectContaining({
    payload: expect.objectContaining({ output: 'before\uFFFDafter' }),
  })])
  expect(daemonWs._sent).toContainEqual(expect.objectContaining({ type: 'event_ack', up_to_seq: 1 }))
})

test('durable ingress receipt-only title events share the Inbox ACK owner', async () => {
  const persisted = deferred<void>()
  const repository = {
    seedCheckpoint: vi.fn(async () => ({ daemonId: 'durable-title', daemonGeneration: 17, ackSeq: 0 })),
    persistBatch: vi.fn(async () => {
      await persisted.promise
      return new Map([[checkpointKey('durable-title', 17), {
        daemonId: 'durable-title', daemonGeneration: 17, ackSeq: 1,
      }]])
    }),
  }
  const router = new Router(createMockPool(), { durableIngress: { mode: 'on', repository } })
  const daemonWs = createMockWs()
  await router.registerDaemon(daemonWs, {
    type: 'register', daemon_id: 'durable-title', hostname: 'h', agents: [], started_at: 17,
  }, 1)
  const titleEffect = vi.spyOn(router as any, 'runEphemeralTitleEffect').mockImplementation(() => {})
  daemonWs._sent.length = 0

  router.handleDaemonMessage('durable-title', {
    type: 'generate_subagent_title_request',
    session_id: 'root',
    agent_id: 'child',
    event_id: 'jsonl:source:3:0:title',
    seq: 1,
  })
  const flushing = (router as any).durableIngress.flushNow()
  // The title path now authorizes against the DB before running its effect.
  await tick()

  expect(titleEffect).toHaveBeenCalledOnce()
  expect(repository.persistBatch).toHaveBeenCalledWith([
    expect.objectContaining({
      seq: 1,
      eventType: 'generate_subagent_title_request',
      receiptOnly: true,
    }),
  ])
  expect(daemonWs._sent.some((message: any) => message.type === 'event_ack')).toBe(false)

  persisted.resolve()
  await flushing
  expect(daemonWs._sent).toContainEqual(expect.objectContaining({
    type: 'event_ack', up_to_seq: 1, daemon_generation: 17,
  }))
})

test.each([
  { mode: 'on' as const, canaryDaemonIds: undefined },
  { mode: 'canary' as const, canaryDaemonIds: ['durable-controls'] },
])('durable ingress $mode receipts sequenced no-session controls without changing effects', async ({ mode, canaryDaemonIds }) => {
  const repository = {
    seedCheckpoint: vi.fn(async () => ({ daemonId: 'durable-controls', daemonGeneration: 17, ackSeq: 0 })),
    persistBatch: vi.fn(async () => new Map([[checkpointKey('durable-controls', 17), {
      daemonId: 'durable-controls', daemonGeneration: 17, ackSeq: 2,
    }]])),
  }
  const router = new Router(createMockPool(), {
    durableIngress: { mode, canaryDaemonIds, repository },
  })
  const daemonWs = createMockWs()
  await router.registerDaemon(daemonWs, {
    type: 'register', daemon_id: 'durable-controls', hostname: 'h', agents: [], started_at: 17,
  }, 1)
  const clientWs = createMockWs()
  router.registerClient(clientWs, 1)
  clientWs._sent.length = 0

  router.handleDaemonMessage('durable-controls', {
    type: 'model_list', models: ['gpt-5'], seq: 1,
  })
  router.handleDaemonMessage('durable-controls', {
    type: 'upgrade_result', ok: true, seq: 2,
  })
  await tick()

  expect(repository.persistBatch).toHaveBeenCalledWith([
    expect.objectContaining({ eventType: 'model_list', receiptOnly: true }),
    expect.objectContaining({ eventType: 'upgrade_result', receiptOnly: true }),
  ])
  expect(clientWs._sent).toContainEqual({
    type: 'model_list', models: ['gpt-5'], seq: 1, daemon_id: 'durable-controls',
  })
  expect(clientWs._sent).toContainEqual({ type: 'upgrade_result', ok: true, seq: 2 })
})

describe.each([
  { mode: 'on' as const, canaryDaemonIds: undefined },
  { mode: 'canary' as const, canaryDaemonIds: ['durable-error'] },
])('durable ingress $mode host-level error routing', ({ mode, canaryDaemonIds }) => {
  test.each([
    { shape: 'missing', sessionFields: {} },
    { shape: 'null', sessionFields: { session_id: null } },
    { shape: 'empty', sessionFields: { session_id: '' } },
    { shape: 'number', sessionFields: { session_id: 42 } },
    { shape: 'object', sessionFields: { session_id: { id: 'nested-session' } } },
    { shape: 'array', sessionFields: { session_id: ['nested-session'] } },
    { shape: 'nested-only', sessionFields: { session: { session_id: 'nested-session' } } },
  ])('treats $shape session_id as host-level control', async ({ sessionFields }) => {
    const repository = {
      seedCheckpoint: vi.fn(async () => ({
        daemonId: 'durable-error', daemonGeneration: 17, ackSeq: 0,
      })),
      persistBatch: vi.fn(async () => new Map([[checkpointKey('durable-error', 17), {
        daemonId: 'durable-error', daemonGeneration: 17, ackSeq: 1,
      }]])),
    }
    const router = new Router(createMockPool(), {
      durableIngress: { mode, canaryDaemonIds, repository },
    })
    const daemonWs = createMockWs()
    await router.registerDaemon(daemonWs, {
      type: 'register', daemon_id: 'durable-error', hostname: 'h', agents: [], started_at: 17,
    }, 1)
    const originWs = createMockWs()
    ;(router as any).pendingSessionCreate.set('durable-error', originWs)
    const durableAccept = vi.spyOn((router as any).durableIngress, 'accept')
    const payload = {
      type: 'error', request_id: 'request-1', error: 'session start failed', seq: 1,
      ...sessionFields,
    }

    router.handleDaemonMessage('durable-error', payload)
    await (router as any).durableIngress.flushNow()

    expect(repository.persistBatch).toHaveBeenCalledWith([
      expect.objectContaining({ eventType: 'error', receiptOnly: true, payload }),
    ])
    expect(durableAccept).toHaveBeenCalled()
    expect(originWs._sent).toEqual([payload])
    expect((router as any).pendingSessionCreate.get('durable-error')).toBe(originWs)
    expect((router as any).daemonSeq.get('durable-error').inflight.has(1)).toBe(false)
    expect(daemonWs._sent).toContainEqual(expect.objectContaining({
      type: 'event_ack', up_to_seq: 1,
    }))
  })
})

describe.each([
  { mode: 'on' as const, canaryDaemonIds: undefined },
  { mode: 'canary' as const, canaryDaemonIds: ['durable-session-error'] },
])('durable ingress $mode session error routing', ({ mode, canaryDaemonIds }) => {
  test.each([
    // Padded identities are not valid daemon session ids: they normalize to
    // null and route as host-level errors instead of session-scoped ones.
    { shape: 'ordinary non-empty string', sessionId: 'session-1', inboxSessionId: 'session-1', originGetsError: false },
    { shape: 'non-empty whitespace string', sessionId: '   ', inboxSessionId: null, originGetsError: true },
  ])('accepts $shape into Inbox', async ({ sessionId, inboxSessionId, originGetsError }) => {
    const persisted = deferred<void>()
    const repository = {
      seedCheckpoint: vi.fn(async () => ({
        daemonId: 'durable-session-error', daemonGeneration: 17, ackSeq: 0,
      })),
      persistBatch: vi.fn(async () => {
        persisted.resolve()
        return new Map()
      }),
    }
    const router = new Router(createMockPool(), {
      durableIngress: { mode, canaryDaemonIds, repository },
    })
    const daemonWs = createMockWs()
    await router.registerDaemon(daemonWs, {
      type: 'register', daemon_id: 'durable-session-error', hostname: 'h', agents: [], started_at: 17,
    }, 1)
    const originWs = createMockWs()
    ;(router as any).pendingSessionCreate.set('durable-session-error', originWs)
    const durableAccept = vi.spyOn((router as any).durableIngress, 'accept')
    const payload = {
      type: 'error', session_id: sessionId, error: 'turn failed', seq: 1,
    }

    router.handleDaemonMessage('durable-session-error', payload)
    const flushing = (router as any).durableIngress.flushNow()
    await persisted.promise
    await flushing

    expect(repository.persistBatch).toHaveBeenCalledWith([
      expect.objectContaining({ eventType: 'error', sessionId: inboxSessionId, payload }),
    ])
    expect(durableAccept).toHaveBeenCalledWith(
      expect.objectContaining({ daemonId: 'durable-session-error' }),
      payload,
      expect.objectContaining({ hostname: 'h' }),
    )
    if (originGetsError) {
      // A whitespace-only identity is not a session: the error routes as
      // host-level and reaches the pending session-create origin client.
      expect(originWs._sent).toEqual([payload])
    } else {
      expect(originWs._sent).toEqual([])
    }
  })
})

test('durable ingress on still executes graceful daemon shutdown immediately', async () => {
  const repository = {
    seedCheckpoint: vi.fn(async () => ({ daemonId: 'durable-shutdown', daemonGeneration: 17, ackSeq: 0 })),
    persistBatch: vi.fn(async () => new Map([[checkpointKey('durable-shutdown', 17), {
      daemonId: 'durable-shutdown', daemonGeneration: 17, ackSeq: 1,
    }]])),
  }
  const router = new Router(createMockPool(), { durableIngress: { mode: 'on', repository } })
  const daemonWs = createMockWs()
  await router.registerDaemon(daemonWs, {
    type: 'register', daemon_id: 'durable-shutdown', hostname: 'h', agents: [], started_at: 17,
  }, 1)
  const clientWs = createMockWs()
  router.registerClient(clientWs, 1)
  clientWs._sent.length = 0

  router.handleDaemonMessage('durable-shutdown', { type: 'daemon_shutdown', seq: 1 })
  await tick()

  expect(repository.persistBatch).toHaveBeenCalledWith([
    expect.objectContaining({ eventType: 'daemon_shutdown', receiptOnly: true }),
  ])
  expect(clientWs._sent).toContainEqual(expect.objectContaining({
    type: 'daemon_status', daemon_id: 'durable-shutdown', status: 'offline',
  }))
})

test('oversized durable admission sends a permanent sequence barrier without reconnecting', async () => {
  const repository = {
    seedCheckpoint: vi.fn(async () => ({ daemonId: 'durable-full', daemonGeneration: 17, ackSeq: 0 })),
    persistBatch: vi.fn(),
  }
  const router = new Router(createMockPool(), { durableIngress: { mode: 'on', repository } })
  const ws = createMockWs()
  await router.registerDaemon(ws, {
    type: 'register', daemon_id: 'durable-full', hostname: 'h', agents: [], started_at: 17,
  }, 1)

  router.handleDaemonMessage('durable-full', {
    type: 'agent_text', session_id: 's1', seq: 1, text: 'x'.repeat((1 << 20) + 1),
  }, ws, 17)

  const transport = ws._sent.filter((message: any) => ['flow_control', 'disconnect', 'event_ack'].includes(message.type))
  expect(transport).toEqual([expect.objectContaining({
    type: 'flow_control', reason: 'event_too_large', blocked_seq: 1,
    daemon_generation: 17,
  })])
  expect(ws.close).not.toHaveBeenCalled()
  expect(repository.persistBatch).not.toHaveBeenCalled()
})

test('transient durable capacity refusal still flow-controls and disconnects for replay', async () => {
  const repository = {
    seedCheckpoint: vi.fn(async () => ({ daemonId: 'durable-capacity', daemonGeneration: 17, ackSeq: 0 })),
    persistBatch: vi.fn(async () => new Map()),
  }
  const router = new Router(createMockPool(), { durableIngress: { mode: 'on', repository } })
  const ws = createMockWs()
  await router.registerDaemon(ws, {
    type: 'register', daemon_id: 'durable-capacity', hostname: 'h', agents: [], started_at: 17,
  }, 1)

  for (let seq = 1; seq <= 1_025; seq++) {
    router.handleDaemonMessage('durable-capacity', {
      type: 'agent_text', session_id: 's1', seq, text: 'capacity',
    }, ws, 17)
  }

  const transport = ws._sent.filter((message: any) => ['flow_control', 'disconnect', 'event_ack'].includes(message.type))
  expect(transport.slice(-2)).toEqual([
    expect.objectContaining({ type: 'flow_control', reason: 'ingest_backpressure' }),
    expect.objectContaining({
      type: 'disconnect', retryable: true, reason: 'ingest_backpressure', daemon_generation: 17,
    }),
  ])
  expect(ws.close).toHaveBeenCalledWith(1013, 'ingest_backpressure')
  expect(repository.persistBatch).not.toHaveBeenCalled()
  await router.stopDurableIngress({ flushDeadlineMs: 1_500 })
})

test('an old failed batch cannot flow-control or disconnect its replacement generation', async () => {
  const pending = deferred<Map<string, { daemonId: string; daemonGeneration: number; ackSeq: number }>>()
  const repository = {
    seedCheckpoint: vi.fn(async (daemonId: string, daemonGeneration: number, ackSeq: number) => ({
      daemonId, daemonGeneration, ackSeq,
    })),
    persistBatch: vi.fn(() => pending.promise),
  }
  const router = new Router(createMockPool(), { durableIngress: { mode: 'on', repository } })
  const oldWs = createMockWs()
  await router.registerDaemon(oldWs, {
    type: 'register', daemon_id: 'generation-safe', hostname: 'h', agents: [], started_at: 17,
  }, 1)
  router.handleDaemonMessage('generation-safe', {
    type: 'agent_text', session_id: 's1', seq: 1, text: 'old',
  }, oldWs, 17)
  const flushing = (router as any).durableIngress.flushNow()
  expect(repository.persistBatch).toHaveBeenCalledTimes(1)

  const newWs = createMockWs()
  await router.registerDaemon(newWs, {
    type: 'register', daemon_id: 'generation-safe', hostname: 'h', agents: [], started_at: 18,
  }, 1)
  pending.reject(new Error('old generation commit failed'))
  await flushing
  await router.stopDurableIngress({ flushDeadlineMs: 0 })

  expect(newWs._sent.some((message: any) => message.type === 'flow_control' || message.type === 'disconnect')).toBe(false)
  expect(newWs.close).not.toHaveBeenCalled()
})

test('heartbeat revocation uses control pool while event persistence uses ingest pool', async () => {
  const pools = createNamedMockPools()
  const router = new Router(pools)
  const daemonWs = createMockWs()
  await router.registerDaemon(daemonWs, {
    type: 'register', daemon_id: 'pool-daemon', hostname: 'test', agents: [],
  }, 1, 'token-jti')
  forceAuthLeaseRefresh(router, 'pool-daemon')

  router.handleDaemonMessage('pool-daemon', { type: 'ping' })
  router.handleDaemonMessage('pool-daemon', {
    type: 'agent_text', session_id: 'pool-session', seq: 1, text: 'hello',
  })
  await tick()

  expect(pools.control.query).toHaveBeenCalledWith(expect.stringContaining('revoked_tokens'), expect.anything())
  expect(pools.ingest.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO events'), expect.anything())
})

test('keeps a confirmed daemon alive during a short heartbeat token-lookup outage', async () => {
  const dbModule = await import('../db.js')
  let now = 1_000
  const router = new Router(createMockPool(), {
    authLeaseOptions: { now: () => now, jitter: () => 0 },
  })
  const ws = createMockWs()
  await router.registerDaemon(ws, {
    type: 'register', daemon_id: 'lease-daemon', hostname: 'test', agents: [], started_at: 100,
  }, 1, 'token-jti')
  const lookup = vi.spyOn(dbModule, 'isTokenRevokedWithTimeout').mockRejectedValue(new Error('control db unavailable'))

  now += 10_000
  router.handleDaemonMessage('lease-daemon', { type: 'ping' }, ws, 100)
  await tick()
  router.handleDaemonMessage('lease-daemon', { type: 'ping' }, ws, 100)

  expect(lookup).toHaveBeenCalledOnce()
  expect(ws.close).not.toHaveBeenCalled()
  expect(ws._sent.filter((message: any) => message.type === 'pong')).toHaveLength(2)
  vi.restoreAllMocks()
})

test('rejects a non-ping daemon payload once its auth lease expires during an outage', async () => {
  let now = 1_000
  const pool = createMockPool()
  const router = new Router(pool, { authLeaseOptions: { now: () => now, jitter: () => 0 } })
  const ws = createMockWs()
  await router.registerDaemon(ws, { type: 'register', daemon_id: 'expired-daemon', hostname: 'test', agents: [], started_at: 100 }, 1, 'jti')
  now += 30_000
  router.handleDaemonMessage('expired-daemon', { type: 'agent_text', session_id: 'must-not-persist', text: 'late', seq: 1 }, ws, 100)
  await tick()
  expect(ws._sent).toContainEqual(expect.objectContaining({ type: 'disconnect', reason: 'token_check_unavailable', retryable: true }))
  expect(pool._queries.some((query: any) => query.sql.includes('INSERT INTO events') && query.params.includes('must-not-persist'))).toBe(false)
})

test('does not observe an expired durable payload before failing its lease closed', async () => {
  let now = 1_000
  let observed = 0
  const router = new Router(createMockPool(), {
    authLeaseOptions: { now: () => now, jitter: () => 0 },
    observeIngressClass: () => { observed++ },
  })
  const ws = createMockWs()
  await router.registerDaemon(ws, { type: 'register', daemon_id: 'observer-expired', hostname: 'test', agents: [], started_at: 100 }, 1, 'jti')
  now += 30_000
  router.handleDaemonMessage('observer-expired', { type: 'agent_text', session_id: 's', text: 'late', seq: 1 }, ws, 100)
  expect(observed).toBe(0)
})

test('local command events use ingest while token revocations use control', async () => {
  const pools = createNamedMockPools()
  const router = new Router(pools)
  const clientWs = createMockWs()
  router.registerClient(clientWs, 1)
  await router.handleClientMessage(clientWs, {
    type: 'local_command_log', session_id: 'pool-session', user_text: '/model', command: '/model', receipt_status: 'ok', message: 'done',
  })
  await tick()
  expect(pools.ingest.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO events'), expect.anything())
  expect(pools.query.query).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO events'), expect.anything())

  const daemonWs = createMockWs()
  await router.registerDaemon(daemonWs, { type: 'register', daemon_id: 'secured-daemon', hostname: 'test', agents: [] }, 1, 'token-jti')
  pools.control.query.mockClear()
  pools.query.query.mockClear()
  await router.handleForceKick('secured-daemon', 1)
  expect(pools.control.query).toHaveBeenCalledWith(expect.stringContaining('revoked_tokens'), expect.anything())
  expect(pools.query.query).not.toHaveBeenCalledWith(expect.stringContaining('revoked_tokens'), expect.anything())

  const deleteWs = createMockWs()
  await router.registerDaemon(deleteWs, { type: 'register', daemon_id: 'delete-daemon', hostname: 'test', agents: [] }, 1, 'delete-jti')
  pools.control.query.mockClear()
  pools.query.query.mockClear()
  await router.handleDeleteDaemon('delete-daemon', 1)
  expect(pools.control.query).toHaveBeenCalled()
  expect(pools.query.query).not.toHaveBeenCalled()
})

describe('Router - daemon disconnect', () => {
  let pool: any
  let router: Router

  beforeEach(() => {
    pool = createMockPool()
    router = new Router(pool)
  })

  test('unregisterDaemon broadcasts daemon_status: offline with hostname', async () => {
    const daemonWs = createMockWs()
    await router.registerDaemon(daemonWs, {
      type: 'register',
      daemon_id: 'daemon-1',
      hostname: 'test-macbook',
      agents: ['claude-code'],
    }, 1)

    const clientWs = createMockWs()
    router.registerClient(clientWs, 1)

    router.unregisterDaemon('daemon-1')
    // Offline is now deferred behind the grace window (20ms), then broadcast
    // inside db.getDaemonAlias().then() — wait past the window + microtask.
    await new Promise(r => setTimeout(r, 80))

    const offlineEvent = clientWs._sent.find((m: any) => m.type === 'daemon_status' && m.status === 'offline')
    expect(offlineEvent).toBeDefined()
    expect(offlineEvent.hostname).toBe('test-macbook')
    expect(offlineEvent.daemon_id).toBe('daemon-1')
    expect(offlineEvent.last_seen_at).toBeDefined()
  })

  test('unregisterDaemon does not overwrite subscribed session lifecycle with disconnected', async () => {
    const daemonWs = createMockWs()
    await router.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'test', agents: [] }, 1)

    const clientWs = createMockWs()
    router.registerClient(clientWs, 1)

    router.handleDaemonMessage('daemon-1', {
      type: 'session_discovered', session_id: 'sess-1', cwd: '/tmp', status: 'running', source: 'terminal',
    })

    clientWs._sent.length = 0
    await router.handleClientMessage(clientWs, { type: 'replay', session_id: 'sess-1', last_seq: 0 })

    router.unregisterDaemon('daemon-1')
    // Daemon connectivity is deferred behind the grace window (20ms).
    await new Promise(r => setTimeout(r, 80))

    const discEvent = clientWs._sent.find((m: any) => m.type === 'session_status' && m.status === 'disconnected')
    expect(discEvent).toBeUndefined()
    expect((router as any).sessionToDaemon.has('sess-1')).toBe(false)
  })

  test('unregisterDaemon does NOT persist disconnected to DB', async () => {
    const daemonWs = createMockWs()
    await router.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'test', agents: [] }, 1)
    router.unregisterDaemon('daemon-1')
    await new Promise(r => setTimeout(r, 80))

    const disconnectUpdate = pool._queries.find((q: any) =>
      q.sql.includes('UPDATE sessions') && q.params.includes('disconnected')
    )
    expect(disconnectUpdate).toBeUndefined()
  })

  test('session_id_changed renames the owned temp id onto the real Codex id', async () => {
    const renameQueries: { sql: string; params: any[] }[] = []
    const pool: any = {
      query: vi.fn(async (sql: string, params?: any[]) => {
        renameQueries.push({ sql, params: params || [] })
        if (sql.includes('ORDER BY session_id FOR UPDATE')) {
          // Only the temp id exists; the real Codex id is free.
          const ids = params || []
          const rows = ids.filter((id) => id === 'temp-id')
            .map((id) => ({ session_id: id, user_id: null, daemon_id: 'daemon-1' }))
          return { rows, rowCount: rows.length }
        }
        if (sql.includes('INSERT INTO events')) {
          return { rows: [{ id: 1, inserted: true, effect_status: 'pending', effect_step: 0 }], rowCount: 1 }
        }
        if (sql.includes('session_allowed')) {
          return { rows: [{ session_exists: true, session_allowed: true }], rowCount: 1 }
        }
        if (sql.includes('SELECT effect_status')) {
          return { rows: [{ effect_status: 'pending', effect_step: 0 }], rowCount: 1 }
        }
        return { rows: [], rowCount: 1 }
      }),
      connect: vi.fn(async () => ({ query: (sql: string, params?: any[]) => pool.query(sql, params), release: vi.fn() })),
      _queries: renameQueries,
    }
    const router = new Router(pool)
    const daemonWs = createMockWs()
    await router.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'test', agents: [] }, 7)

    router.handleDaemonMessage('daemon-1', {
      type: 'session_id_changed',
      session_id: 'real-codex-id',
      old_session_id: 'temp-id',
    })
    await tick()

    const rename = renameQueries.find((q) =>
      q.sql.includes('UPDATE sessions SET') && q.sql.includes('session_id = $2'))
    expect(rename).toBeDefined()
    expect(rename?.params).toEqual(['temp-id', 'real-codex-id', 'daemon-1', 7])
    const eventsMove = renameQueries.find((q) =>
      q.sql.includes('UPDATE events SET session_id = $2'))
    expect(eventsMove).toBeDefined()
  })
})

describe('Router - daemon reconnect', () => {
  let pool: any
  let router: Router

  beforeEach(() => {
    pool = createMockPool()
    router = new Router(pool)
  })

  test('registerDaemon broadcasts daemon_status: online with hostname and agents', async () => {
    const clientWs = createMockWs()
    router.registerClient(clientWs, 1)

    const daemonWs = createMockWs()
    await router.registerDaemon(daemonWs, {
      type: 'register', daemon_id: 'daemon-2', hostname: 'mac-pro', agents: ['claude-code', 'opencode'],
    }, 1)

    const onlineEvent = clientWs._sent.find((m: any) => m.type === 'daemon_status' && m.status === 'online')
    expect(onlineEvent).toBeDefined()
    expect(onlineEvent.hostname).toBe('mac-pro')
    expect(onlineEvent.daemon_id).toBe('daemon-2')
    // registerDaemon composes agents as objects {type,version,latest,manageable}
    // (the web client consumes this shape), not a bare string array.
    expect(onlineEvent.agents.map((a: any) => a.type)).toEqual(['claude-code', 'opencode'])
  })
})

describe('Router - session_status with exit_reason', () => {
  let pool: any
  let router: Router

  beforeEach(() => {
    pool = createMockPool()
    router = new Router(pool)
  })

  test('session_status is UPDATE-only and never INSERTs a (phantom) session row', async () => {
    const daemonWs = createMockWs()
    router.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'test', agents: [] }, 1)

    router.handleDaemonMessage('daemon-1', {
      type: 'session_status', session_id: 'sess-exit', status: 'exited', exit_reason: 'user_interrupt',
    })
  await tick()

    // The status + exit_reason go out as an UPDATE...
    const updateCall = pool._queries.find((q: any) =>
      q.sql.includes('UPDATE sessions') && q.sql.includes('exit_reason') && q.params.includes('user_interrupt')
    )
    expect(updateCall).toBeDefined()
    // ...and crucially, no INSERT (which would materialise a phantom session).
    const insertCall = pool._queries.find((q: any) =>
      q.sql.includes('INSERT INTO sessions') && q.params.includes('sess-exit')
    )
    expect(insertCall).toBeUndefined()
    // Regression guard: user_id must use an explicit cast (COALESCE($8::int)),
    // NOT `CASE WHEN $8 IS NOT NULL` — that pattern left $8's type un-inferrable
    // for Postgres ("could not determine data type of parameter $8") whenever a
    // session_status arrived without a userId, silently dropping the status update.
    expect(updateCall!.sql).not.toMatch(/CASE\s+WHEN\s+\$8/i)
    expect(updateCall!.sql).toMatch(/COALESCE\(\$8::int/i)
  })

  test('session_status without exit_reason does not null existing reason (COALESCE)', async () => {
    const daemonWs = createMockWs()
    router.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'test', agents: [] }, 1)

    router.handleDaemonMessage('daemon-1', {
      type: 'session_status', session_id: 'sess-2', status: 'exited', exit_reason: 'normal_exit',
    })

    router.handleDaemonMessage('daemon-1', {
      type: 'session_status', session_id: 'sess-2', status: 'running',
    })
  await tick()

    const statusUpdates = pool._queries.filter((q: any) =>
      q.sql.includes('UPDATE sessions') && q.sql.includes('exit_reason') && q.params.includes('sess-2')
    )
    expect(statusUpdates.length).toBeGreaterThanOrEqual(2)
    // updateSessionStatusForEvent params prefix the event ledger coordinates;
    // exitReason remains nullable at index 6.
    // The second call carried no exit_reason → null, and COALESCE keeps the old value.
    expect(statusUpdates[1].params[6]).toBeNull()
  })
})

describe('Router - event insertion updates last_activity_at', () => {
  let pool: any
  let router: Router

  beforeEach(() => {
    pool = createMockPool()
    router = new Router(pool)
  })

  test('insertEvent triggers last_activity_at update', async () => {
    const daemonWs = createMockWs()
    router.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'test', agents: [] }, 1)

    router.handleDaemonMessage('daemon-1', {
      type: 'agent_text', session_id: 'sess-3', text: 'hello', streaming: false,
    })

    await new Promise(r => setTimeout(r, 50))

    const activityUpdate = pool._queries.find((q: any) =>
      q.sql.includes('UPDATE sessions') && q.sql.includes('last_activity_at')
    )
    expect(activityUpdate).toBeDefined()
    expect(activityUpdate.params).toContain('sess-3')
  })

  test('session_meta persistence does not update last_activity_at', async () => {
    const daemonWs = createMockWs()
    router.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'test', agents: [] }, 1)

    router.handleDaemonMessage('daemon-1', {
      type: 'session_meta', session_id: 'sess-3', request_id: 'session-meta-open-1', model: 'gpt-5.6-terra',
    })

    await new Promise(r => setTimeout(r, 50))

    const activityUpdate = pool._queries.find((q: any) =>
      q.sql.includes('UPDATE sessions') && q.sql.includes('last_activity_at')
    )
    expect(activityUpdate).toBeUndefined()
  })

  test('replayed discovery restores its source activity time', async () => {
    const daemonWs = createMockWs()
    router.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'test', agents: [] }, 1)
    const sourceActivity = '2026-08-01T12:30:00.000Z'

    router.handleDaemonMessage('daemon-1', {
      type: 'session_discovered', session_id: 'sess-3', status: 'idle', agent: 'codex',
      resync: true, last_activity_at: sourceActivity,
    })

    await new Promise(r => setTimeout(r, 50))

    const activityUpdate = pool._queries.find((q: any) =>
      q.sql.includes('UPDATE sessions') && q.sql.includes('last_activity_at')
    )
    expect(activityUpdate).toBeDefined()
    expect(activityUpdate.params[0]).toBe('sess-3')
    expect(activityUpdate.params[1]).toEqual(new Date(sourceActivity))
    expect(activityUpdate.sql).not.toContain('GREATEST')
  })

  test('OpenCode Part revisions are persisted and broadcast unchanged', async () => {
    const daemonWs = createMockWs()
    await router.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'test', agents: ['opencode'] }, 1)
    const clientWs = createMockWs()
    router.registerClient(clientWs, 1)
    await router.handleClientMessage(clientWs, { type: 'replay', session_id: 'test-sid', last_seq: 0 })
    clientWs._sent.length = 0

    const reasoning = {
      type: 'agent_reasoning', session_id: 'test-sid', text: 'checking', streaming: true,
      message_id: 'msg_1', part_id: 'prt_reason', revision: 2, replace: false,
    }
    const replacement = {
      type: 'agent_text', session_id: 'test-sid', text: 'final answer', streaming: false,
      message_id: 'msg_1', part_id: 'prt_text', revision: 3, replace: true,
    }
    const structured = {
      type: 'agent_patch', session_id: 'test-sid', message_id: 'msg_1', part_id: 'prt_patch',
      hash: 'abc123', files: ['a.go', 'b.go'],
    }

    router.handleDaemonMessage('daemon-1', reasoning)
    router.handleDaemonMessage('daemon-1', replacement)
    router.handleDaemonMessage('daemon-1', structured)
    await tick()

    expect(clientWs._sent).toContainEqual(reasoning)
    expect(clientWs._sent).toContainEqual(replacement)
    expect(clientWs._sent).toContainEqual(structured)
    const inserts = pool._queries.filter((q: any) => q.sql.includes('INSERT INTO events'))
    expect(inserts.some((q: any) => q.params[1] === 'agent_reasoning' && q.params[2]?.includes('"part_id":"prt_reason"'))).toBe(true)
    expect(inserts.some((q: any) => q.params[1] === 'agent_text' && q.params[2]?.includes('"replace":true'))).toBe(true)
    expect(inserts.some((q: any) => q.params[1] === 'agent_patch' && q.params[2]?.includes('"files":["a.go","b.go"]'))).toBe(true)
  })

  test('Codex plan snapshots are persisted and broadcast unchanged', async () => {
    const daemonWs = createMockWs()
    await router.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'test', agents: ['codex'] }, 1)
    const clientWs = createMockWs()
    router.registerClient(clientWs, 1)
    await router.handleClientMessage(clientWs, { type: 'replay', session_id: 'test-sid', last_seq: 0 })
    clientWs._sent.length = 0

    const plan = {
      type: 'agent_plan', session_id: 'test-sid', part_id: 'plan:test-sid', revision: 2,
      event_id: 'plan:2', previous_event_id: 'plan:1', explanation: 'Continuing',
      plan: [
        { step: 'Protocol', status: 'completed' },
        { step: 'Web panel', status: 'in_progress' },
      ],
    }

    router.handleDaemonMessage('daemon-1', plan)
    await tick()

    expect(clientWs._sent).toContainEqual(plan)
    const insert = pool._queries.find((query: any) =>
      query.sql.includes('INSERT INTO events') && query.params[1] === 'agent_plan'
    )
    expect(JSON.parse(insert.params[2])).toEqual(plan)
  })

  test('Codex file changes are persisted and broadcast unchanged', async () => {
    const daemonWs = createMockWs()
    await router.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'test', agents: ['codex'] }, 1)
    const clientWs = createMockWs()
    router.registerClient(clientWs, 1)
    await router.handleClientMessage(clientWs, { type: 'replay', session_id: 'test-sid', last_seq: 0 })
    clientWs._sent.length = 0

    const fileChange = {
      type: 'agent_file_change', session_id: 'test-sid', turn_id: 'turn-1',
      change_set_id: 'native:call-1', event_id: 'file-event-1', call_id: 'call-1',
      change_index: 0, change_total: 1, path: 'src/a.ts', change_kind: 'update',
      move_path: '', diff: '@@ -1 +1 @@\n-old\n+new\n', additions: 1, deletions: 1,
      status: 'completed',
    }

    router.handleDaemonMessage('daemon-1', fileChange)
    await tick()

    expect(clientWs._sent).toContainEqual(fileChange)
    const insert = pool._queries.find((query: any) =>
      query.sql.includes('INSERT INTO events') && query.params[1] === 'agent_file_change'
    )
    expect(insert).toBeDefined()
    expect(JSON.parse(insert.params[2])).toEqual(fileChange)
  })
})

describe('Router - list_sessions includes extended fields', () => {
  let pool: any
  let router: Router

  beforeEach(() => {
    pool = createMockPool()
    router = new Router(pool)
  })

  test('handleListSessions returns daemon_online field', async () => {
    const clientWs = createMockWs()
    router.registerClient(clientWs, 1)

    router.handleClientMessage(clientWs, { type: 'list_sessions' })

    await new Promise(r => setTimeout(r, 50))

    const listEvent = clientWs._sent.find((m: any) => m.type === 'session_list')
    expect(listEvent).toBeDefined()
    if (listEvent && listEvent.sessions && listEvent.sessions.length > 0) {
      const s = listEvent.sessions[0]
      expect(s).toHaveProperty('daemon_online')
      expect(s).toHaveProperty('last_activity_at')
      expect(s).toHaveProperty('exit_reason')
      expect(s).not.toHaveProperty('daemon_status')
    }
  })

  test('handleListSessions supports daemon scoped pagination', async () => {
    const clientWs = createMockWs()
    router.registerClient(clientWs, 1)

    router.handleClientMessage(clientWs, {
      type: 'list_sessions',
      daemon_id: 'daemon-1',
      limit: 1,
      cursor: '0',
    })

    await new Promise(r => setTimeout(r, 50))

    const listEvent = clientWs._sent.find((m: any) => m.type === 'session_list')
    expect(listEvent).toBeDefined()
    expect(listEvent.daemon_id).toBe('daemon-1')
    expect(listEvent.has_more).toBe(false)
    expect(pool.query.mock.calls.some(([sql, params]: [string, any[]]) =>
      sql.includes('s.daemon_id = $1') &&
      sql.includes('s.session_id DESC') &&
      sql.includes('LIMIT $2') &&
      !sql.includes('OFFSET') &&
      params[0] === 'daemon-1' && params[1] === 2 && params[2] === 1
    )).toBe(true)
  })

  test('handleListSessions uses keyset cursor for next page', async () => {
    const clientWs = createMockWs()
    router.registerClient(clientWs, 1)
    const cursor = Buffer.from(JSON.stringify({
      version: 2,
      pinned: 0,
      pinnedAt: '1970-01-01T00:00:00.000Z',
      activityAt: '2026-01-02T03:04:05.000Z',
      sessionId: 'sess-20',
    }), 'utf8').toString('base64url')

    router.handleClientMessage(clientWs, {
      type: 'list_sessions',
      daemon_id: 'daemon-1',
      limit: 20,
      cursor,
    })

    await new Promise(r => setTimeout(r, 50))

    expect(pool.query.mock.calls.some(([sql, params]: [string, any[]]) =>
      sql.includes(') < ($4, $5::timestamptz, $6::timestamptz, $7)') &&
      !sql.includes('OFFSET') &&
      params[0] === 'daemon-1' &&
      params[1] === 21 &&
      params[2] === 1 &&
      params[3] === 0 &&
      params[6] === 'sess-20'
    )).toBe(true)
  })
})

describe('Router - session→daemon routing resilience', () => {
  let pool: any
  let router: Router

  beforeEach(() => {
    pool = createMockPool()
    router = new Router(pool)
  })

  test('rebuildSessionRoutes rehydrates routes from reported + DB session IDs on register', async () => {
    const daemonWs = createMockWs()
    // Daemon reports two live sessions; DB mock additionally returns 'test-sid'.
    await router.registerDaemon(daemonWs, {
      type: 'register', daemon_id: 'daemon-1', hostname: 'test', agents: [],
      active_session_ids: ['sess-a', 'sess-b'],
    }, 1)
    // rebuildSessionRoutes fires async on register — let it settle.
    await new Promise(r => setTimeout(r, 20))

    const clientWs = createMockWs()
    router.registerClient(clientWs, 1)

    // A session never seen in-memory this connection (sess-a) should now route
    // to the daemon without hitting the "session not found" error.
    daemonWs._sent.length = 0
    await router.handleClientMessage(clientWs, { type: 'session_interrupt', session_id: 'sess-a' })

    expect(daemonWs._sent.some((m: any) => m.type === 'session_interrupt' && m.session_id === 'sess-a')).toBe(true)
    expect(clientWs._sent.some((m: any) => m.error === 'session not found or daemon offline')).toBe(false)
  })

  test('reconciles zombie sessions on register: closes running/busy rows not in active_session_ids and notifies clients', async () => {
    // Custom pool: the reconcile UPDATE returns one zombie that the daemon no
    // longer reports as live. Everything else falls through to empty results.
    const reconcilePool: any = {
      query: vi.fn((sql: string) => {
        if (sql.includes('RETURNING daemon_id')) return Promise.resolve({ rows: [{ daemon_id: 'daemon-1' }], rowCount: 1 })
        if (sql.includes('SELECT registration_id FROM daemons')) return Promise.resolve({ rows: [{ registration_id: 'current' }], rowCount: 1 })
        if (sql.includes("status = 'completed'") && sql.includes('RETURNING session_id')) {
          return Promise.resolve({ rows: [{ session_id: 'zombie-1' }], rowCount: 1 })
        }
        return Promise.resolve({ rows: [], rowCount: 0 })
      }),
      end: vi.fn(),
    }
    reconcilePool.connect = vi.fn(async () => ({ query: reconcilePool.query, release: vi.fn() }))
    const r = new Router(reconcilePool)

    const clientWs = createMockWs()
    r.registerClient(clientWs, 1)

    const daemonWs = createMockWs()
    // Daemon reports only 'live-1' as active; 'zombie-1' is stale running/busy in DB.
    await r.registerDaemon(daemonWs, {
      type: 'register', daemon_id: 'daemon-1', hostname: 'test', agents: [],
      active_session_ids: ['live-1'],
    }, 1)
    await new Promise(res => setTimeout(res, 20))

    // Reconcile UPDATE ran with the daemon's live set as the exclusion array.
    const reconcileCall = reconcilePool.query.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes("status = 'completed'") && c[0].includes('RETURNING session_id')
    )
    expect(reconcileCall).toBeDefined()
    expect(reconcileCall[1]).toEqual(['daemon-1', ['live-1']])

    // The closed session is pushed to the client as completed.
    const evt = clientWs._sent.find((m: any) => m.type === 'session_status' && m.session_id === 'zombie-1')
    expect(evt).toBeDefined()
    expect(evt.status).toBe('completed')
  })

  test('skips reconcile for legacy daemons that do not report active_session_ids', async () => {
    const reconcilePool: any = {
      query: vi.fn(() => Promise.resolve({ rows: [], rowCount: 0 })),
      connect: vi.fn(), end: vi.fn(),
    }
    const r = new Router(reconcilePool)
    const daemonWs = createMockWs()
    // No active_session_ids field → must NOT run the reconcile UPDATE.
    await r.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'test', agents: [] }, 1)
    await new Promise(res => setTimeout(res, 20))

    const ranReconcile = reconcilePool.query.mock.calls.some(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes("status = 'completed'") && c[0].includes('RETURNING session_id')
    )
    expect(ranReconcile).toBe(false)
  })

  test('routing falls back to DB daemon_id when in-memory map misses', async () => {
    const daemonWs = createMockWs()
    await router.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'test', agents: [] }, 1)
    await new Promise(r => setTimeout(r, 20))

    const clientWs = createMockWs()
    router.registerClient(clientWs, 1)

    // 'test-sid' was NOT in active_session_ids, but the DB mock maps it to daemon-1.
    daemonWs._sent.length = 0
    await router.handleClientMessage(clientWs, { type: 'session_interrupt', session_id: 'test-sid' })

    expect(daemonWs._sent.some((m: any) => m.type === 'session_interrupt')).toBe(true)
  })

  test('fails closed before native routing when the ownership-scoped runtime policy lookup fails', async () => {
    const policyPool = createMockPool()
    const originalQuery = policyPool.query.getMockImplementation()!
    policyPool.query = vi.fn((sql: string, params?: any[]) => {
      if (sql.includes('WITH owned_session')) {
        return Promise.reject(new Error('runtime policy unavailable'))
      }
      return originalQuery(sql, params)
    })
    const guardedRouter = new Router(policyPool)
    const daemonWs = createMockWs()
    await guardedRouter.registerDaemon(daemonWs, {
      type: 'register', daemon_id: 'daemon-1', hostname: 'test', agents: [],
      active_session_ids: ['test-sid'],
    }, 1)
    const clientWs = createMockWs()
    guardedRouter.registerClient(clientWs, 1)
    daemonWs._sent.length = 0

    await guardedRouter.handleClientMessage(clientWs, {
      type: 'session_interrupt', session_id: 'test-sid', request_id: 'interrupt-policy-outage',
    })

    expect(daemonWs._sent).toEqual([])
    expect(clientWs._sent).toContainEqual(expect.objectContaining({
      type: 'error', session_id: 'test-sid', error: 'session not found or not owned',
    }))
    expect((guardedRouter as any).clients.get(clientWs).subscribedSessions.has('test-sid')).toBe(false)
  })

  test('error for unroutable session includes session_id', async () => {
    const clientWs = createMockWs()
    router.registerClient(clientWs, 1)

    // Unknown session: DB returns no rows → falls through to the error.
    await router.handleClientMessage(clientWs, { type: 'session_interrupt', session_id: 'no-such-session' })
    await new Promise(r => setTimeout(r, 10))

    // session_not_found code distinguishes "session doesn't exist" from
    // "daemon unreachable" so the client can avoid pointless retries.
    const errEvent = clientWs._sent.find((m: any) => m.code === 'session_not_found')
    expect(errEvent).toBeDefined()
    expect(errEvent.session_id).toBe('no-such-session')
    expect(errEvent.error).toBe('session not found')
  })

  test('unregisterDaemon drops the daemon\'s session→daemon routes', async () => {
    const daemonWs = createMockWs()
    await router.registerDaemon(daemonWs, {
      type: 'register', daemon_id: 'daemon-1', hostname: 'test', agents: [],
      active_session_ids: ['sess-a'],
    }, 1)
    await new Promise(r => setTimeout(r, 20))

    router.unregisterDaemon('daemon-1')
    // Routes are pruned when the offline transition finalizes (after grace).
    await new Promise(r => setTimeout(r, 80))

    // After disconnect, sess-a is no longer in the routing map (pruned), so a
    // message to it does NOT get forwarded to the dead daemon socket.
    const clientWs = createMockWs()
    router.registerClient(clientWs, 1)
    daemonWs._sent.length = 0
    await router.handleClientMessage(clientWs, { type: 'session_interrupt', session_id: 'sess-a' })

    expect(daemonWs._sent.some((m: any) => m.type === 'session_interrupt')).toBe(false)
  })
})

describe('Router - offline debounce', () => {
  let pool: any
  let router: Router

  beforeEach(() => {
    pool = createMockPool()
    // Longer grace so a reconnect can race inside the window deterministically.
    process.env.DAEMON_OFFLINE_GRACE_MS = '80'
    router = new Router(pool)
  })

  test('reconnect within the grace window cancels the offline transition', async () => {
    const clientWs = createMockWs()
    router.registerClient(clientWs, 42)

    const ws1 = createMockWs()
    await router.registerDaemon(ws1, { type: 'register', daemon_id: 'daemon-1', hostname: 'host', agents: [] }, 42)

    clientWs._sent.length = 0
    pool._queries.length = 0

    // Disconnect, then reconnect well within the 80ms window.
    router.unregisterDaemon('daemon-1', ws1)
    await new Promise(r => setTimeout(r, 20))
    const ws2 = createMockWs()
    await router.registerDaemon(ws2, { type: 'register', daemon_id: 'daemon-1', hostname: 'host', agents: [] }, 42)

    // Wait past where the original timer would have fired.
    await new Promise(r => setTimeout(r, 120))

    const offline = clientWs._sent.find((m: any) => m.type === 'daemon_status' && m.status === 'offline')
    expect(offline).toBeUndefined()
    // No offline push lookup happened either.
    const pushQuery = pool._queries.find((q: any) => q.sql.includes('FROM devices'))
    expect(pushQuery).toBeUndefined()
  })

  test('recovery observer follows accepted online and post-grace confirmed offline generations', async () => {
    const recoveryObserver = {
      confirmedOffline: vi.fn().mockResolvedValue(undefined),
      confirmedOnline: vi.fn().mockResolvedValue(undefined),
    }
    router = new Router(pool, { recoveryObserver })
    const ws = createMockWs()

    await router.registerDaemon(ws, {
      type: 'register', daemon_id: 'daemon-1', hostname: 'host', agents: [],
    }, 42)
    await vi.waitFor(() => expect(recoveryObserver.confirmedOnline).toHaveBeenCalledOnce())
    const generation = recoveryObserver.confirmedOnline.mock.calls[0]?.[0].registrationGeneration

    router.unregisterDaemon('daemon-1', ws)
    await new Promise(r => setTimeout(r, 20))
    expect(recoveryObserver.confirmedOffline).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(recoveryObserver.confirmedOffline).toHaveBeenCalledOnce())
    expect(recoveryObserver.confirmedOffline).toHaveBeenCalledWith({
      userId: 42, daemonId: 'daemon-1', registrationGeneration: generation,
      daemonDisplayName: 'host',
    })
  })

  test('does not project offline after reconnect wins and isolates observer failures', async () => {
    const recoveryObserver = {
      confirmedOffline: vi.fn().mockRejectedValue(new Error('projection unavailable')),
      confirmedOnline: vi.fn().mockRejectedValue(new Error('projection unavailable')),
    }
    router = new Router(pool, { recoveryObserver })
    const first = createMockWs()
    await expect(router.registerDaemon(first, {
      type: 'register', daemon_id: 'daemon-1', hostname: 'host', agents: [],
    }, 42)).resolves.toBe(true)

    router.unregisterDaemon('daemon-1', first)
    await new Promise(r => setTimeout(r, 20))
    const successor = createMockWs()
    await expect(router.registerDaemon(successor, {
      type: 'register', daemon_id: 'daemon-1', hostname: 'host', agents: [],
    }, 42)).resolves.toBe(true)
    await new Promise(r => setTimeout(r, 120))

    expect(recoveryObserver.confirmedOffline).not.toHaveBeenCalled()
    expect(recoveryObserver.confirmedOnline).toHaveBeenCalledTimes(2)
  })

  test('daemon_shutdown declares offline immediately without waiting for grace', async () => {
    const clientWs = createMockWs()
    router.registerClient(clientWs, 42)

    const ws1 = createMockWs()
    await router.registerDaemon(ws1, { type: 'register', daemon_id: 'daemon-1', hostname: 'host', agents: [] }, 42)

    clientWs._sent.length = 0
    pool._queries.length = 0

    router.handleDaemonMessage('daemon-1', { type: 'daemon_shutdown', seq: 1 })
    await new Promise(r => setTimeout(r, 20))

    const offline = clientWs._sent.find((m: any) => m.type === 'daemon_status' && m.status === 'offline')
    expect(offline).toBeDefined()
    expect(offline.daemon_id).toBe('daemon-1')
    expect(offline.hostname).toBe('host')
    const offlineUpdate = pool._queries.find((q: any) =>
      q.sql.includes('UPDATE daemons') && q.params.includes('daemon-1')
    )
    expect(offlineUpdate).toBeDefined()
  })

  test('past the grace window the daemon is declared offline and pushed', async () => {
    const clientWs = createMockWs()
    router.registerClient(clientWs, 42)

    const ws1 = createMockWs()
    await router.registerDaemon(ws1, { type: 'register', daemon_id: 'daemon-1', hostname: 'host', agents: [] }, 42)

    clientWs._sent.length = 0
    pool._queries.length = 0

    router.unregisterDaemon('daemon-1', ws1)
    await new Promise(r => setTimeout(r, 160))

    const offline = clientWs._sent.find((m: any) => m.type === 'daemon_status' && m.status === 'offline')
    expect(offline).toBeDefined()
    const pushQuery = pool._queries.find((q: any) => q.sql.includes('FROM devices'))
    expect(pushQuery).toBeDefined()
  })

  test('graceful shutdown suppresses the offline push (but still broadcasts)', async () => {
    const recoveryObserver = {
      confirmedOffline: vi.fn().mockResolvedValue(undefined),
      confirmedOnline: vi.fn().mockResolvedValue(undefined),
    }
    router = new Router(pool, { recoveryObserver })
    const clientWs = createMockWs()
    router.registerClient(clientWs, 42)

    const ws1 = createMockWs()
    await router.registerDaemon(ws1, { type: 'register', daemon_id: 'daemon-1', hostname: 'host', agents: [] }, 42)

    clientWs._sent.length = 0
    pool._queries.length = 0

    router.beginShutdown()
    router.unregisterDaemon('daemon-1', ws1)
    await new Promise(r => setTimeout(r, 160))

    // No APNs push lookup while shutting down...
    const pushQuery = pool._queries.find((q: any) => q.sql.includes('FROM devices'))
    expect(pushQuery).toBeUndefined()
    expect(recoveryObserver.confirmedOffline).not.toHaveBeenCalled()
  })

  test('stale-socket close does not schedule an offline transition for the live connection', async () => {
    const clientWs = createMockWs()
    router.registerClient(clientWs, 42)

    const ws1 = createMockWs()
    await router.registerDaemon(ws1, { type: 'register', daemon_id: 'daemon-1', hostname: 'host', agents: [] }, 42)
    // Reconnect on a new socket BEFORE the old one's close arrives.
    const ws2 = createMockWs()
    await router.registerDaemon(ws2, { type: 'register', daemon_id: 'daemon-1', hostname: 'host', agents: [] }, 42)

    clientWs._sent.length = 0
    // Late close from the superseded socket — must be ignored.
    router.unregisterDaemon('daemon-1', ws1)
    await new Promise(r => setTimeout(r, 160))

    const offline = clientWs._sent.find((m: any) => m.type === 'daemon_status' && m.status === 'offline')
    expect(offline).toBeUndefined()
  })

  test('broadcastRelayRestarting notifies connected daemons', async () => {
    const ws1 = createMockWs()
    await router.registerDaemon(ws1, { type: 'register', daemon_id: 'daemon-1', hostname: 'host', agents: [] }, 42)
    ws1._sent.length = 0
    router.broadcastRelayRestarting()
    expect(ws1._sent.some((m: any) => m.type === 'relay_restarting')).toBe(true)
  })
})

describe('Router - event delivery dedup + ack', () => {
  let pool: any
  let router: Router

  beforeEach(() => {
    pool = createMockPool()
    router = new Router(pool)
  })

  test('register_ack advertises event and chunk limits with stream support', async () => {
    router = new Router(pool, {
      transport: {
        maxEventBytes: 900_000,
        maxChunkBytes: 96_000,
        replayBatchMaxEvents: 20,
        replayBatchMaxBytes: 400_000,
      },
    })
    const daemonWs = createMockWs()
    await router.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'h', agents: [], started_at: 100 }, 1)
    const ack = daemonWs._sent.find((m: any) => m.type === 'register_ack')
    expect(ack).toEqual(expect.objectContaining({
      supports_event_ack: true,
      capabilities: ['tool_output_stream_v1'],
      max_event_bytes: 900_000,
      max_chunk_bytes: 96_000,
    }))
  })

  test('an already-persisted seq is dropped on replay; a new seq is forwarded', async () => {
    const daemonWs = createMockWs()
    await router.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'h', agents: [], started_at: 100 }, 1)
    const clientWs = createMockWs()
    router.registerClient(clientWs, 1)
    await router.handleClientMessage(clientWs, { type: 'replay', session_id: 'sess-1', last_seq: 0 }) // subscribe

    clientWs._sent.length = 0
    // First delivery (seq 1) forwards, then (once persisted) advances the mark.
    router.handleDaemonMessage('daemon-1', { type: 'agent_text', session_id: 'sess-1', text: 'hi', seq: 1 })
    await tick()
    expect(clientWs._sent.filter((m: any) => m.type === 'agent_text').length).toBe(1)

    // Replay of the same (now-persisted) seq is dropped — not re-forwarded.
    router.handleDaemonMessage('daemon-1', { type: 'agent_text', session_id: 'sess-1', text: 'hi', seq: 1 })
    await tick()
    expect(clientWs._sent.filter((m: any) => m.type === 'agent_text').length).toBe(1)

    // A higher seq is a new event and is forwarded.
    router.handleDaemonMessage('daemon-1', { type: 'agent_text', session_id: 'sess-1', text: 'next', seq: 2 })
    await tick()
    expect(clientWs._sent.filter((m: any) => m.type === 'agent_text').length).toBe(2)
  })

  test('replays delivery after a crash between business effects and delivery before finalizing the ledger', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const r = new Router(createMockPool())
    const daemonWs = createMockWs()
    await r.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'h', agents: [], started_at: 100 }, 1)
    const clientWs = createMockWs()
    r.registerClient(clientWs, 1)
    ;(r as any).clients.get(clientWs).subscribedSessions.add('sess-1')
    const applyEffects = vi.fn().mockResolvedValue(undefined)
    const finalizeEffect = vi.fn().mockResolvedValue(undefined)
    ;(r as any).materializer = {
      materialize: vi.fn().mockResolvedValue({
        eventId: 91,
        inserted: false,
        completed: false,
        deliveries: [{
          eventId: 91, userId: 1, audience: 'session', sessionId: 'sess-1',
          requestId: null, ordinal: 0, deliveryKey: 'event:91:session:-:0',
          type: 'agent_text', payload: { type: 'agent_text', session_id: 'sess-1', text: 'hello' },
        }],
        applyEffects,
        finalizeEffect,
      }),
    }
    const realDelivery = (r as any).deliverMaterializedEvent.bind(r)
    vi.spyOn(r as any, 'deliverMaterializedEvent')
      .mockImplementationOnce(() => { throw new Error('crash before delivery') })
      .mockImplementation(realDelivery)

    r.handleDaemonMessage('daemon-1', { type: 'agent_text', session_id: 'sess-1', text: 'hello', seq: 1 })
    await tick()
    expect(finalizeEffect).not.toHaveBeenCalled()
    expect(clientWs._sent.filter((message: any) => message.type === 'agent_text')).toHaveLength(0)

    r.handleDaemonMessage('daemon-1', { type: 'agent_text', session_id: 'sess-1', text: 'hello', seq: 1 })
    await tick()
    expect(clientWs._sent.filter((message: any) => message.type === 'agent_text')).toHaveLength(1)
    expect(finalizeEffect).toHaveBeenCalledOnce()
    daemonWs._sent.length = 0
    r.handleDaemonMessage('daemon-1', { type: 'ping' })
    expect(daemonWs._sent.find((message: any) => message.type === 'event_ack')?.up_to_seq).toBe(1)
    log.mockRestore()
  })

  test('keeps the legacy at-least-once duplicate boundary when finalization fails after delivery', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const r = new Router(createMockPool())
    const daemonWs = createMockWs()
    await r.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'h', agents: [], started_at: 100 }, 1)
    const clientWs = createMockWs()
    r.registerClient(clientWs, 1)
    ;(r as any).clients.get(clientWs).subscribedSessions.add('sess-1')
    const finalizeEffect = vi.fn()
      .mockRejectedValueOnce(new Error('finalize unavailable'))
      .mockResolvedValueOnce(undefined)
    ;(r as any).materializer = {
      materialize: vi.fn().mockResolvedValue({
        eventId: 92,
        inserted: false,
        completed: false,
        deliveries: [{
          eventId: 92, userId: 1, audience: 'session', sessionId: 'sess-1',
          requestId: null, ordinal: 0, deliveryKey: 'event:92:session:-:0',
          type: 'agent_text', payload: { type: 'agent_text', session_id: 'sess-1', text: 'hello' },
        }],
        applyEffects: vi.fn().mockResolvedValue(undefined),
        finalizeEffect,
      }),
    }

    r.handleDaemonMessage('daemon-1', { type: 'agent_text', session_id: 'sess-1', text: 'hello', seq: 1 })
    await tick()
    r.handleDaemonMessage('daemon-1', { type: 'agent_text', session_id: 'sess-1', text: 'hello', seq: 1 })
    await tick()

    expect(clientWs._sent.filter((message: any) => message.type === 'agent_text')).toHaveLength(2)
    expect(finalizeEffect).toHaveBeenCalledTimes(2)
    daemonWs._sent.length = 0
    r.handleDaemonMessage('daemon-1', { type: 'ping' })
    expect(daemonWs._sent.find((message: any) => message.type === 'event_ack')?.up_to_seq).toBe(1)
    log.mockRestore()
  })

  test('a stable event replay with a new seq is acked without duplicate fanout or side effects', async () => {
  const queries: { sql: string; params: any[] }[] = []
  let eventInserts = 0
  const dedupPool: any = {
    query: vi.fn((sql: string, params?: any[]) => {
    queries.push({ sql, params: params || [] })
    if (sql.includes('INSERT INTO events')) {
      eventInserts++
      return Promise.resolve({
        rows: [{
          id: 41,
          inserted: eventInserts === 1,
          effect_status: eventInserts === 1 ? 'pending' : 'completed',
          effect_step: eventInserts === 1 ? 0 : 2,
        }],
      })
    }
    if (sql.includes('FROM daemons')) return Promise.resolve({ rows: [{ daemon_id: 'daemon-1', status: 'online' }] })
    if (sql.includes('SELECT 1 FROM sessions')) return Promise.resolve({ rows: [{ '?column?': 1 }], rowCount: 1 })
    if (sql.includes('session_target AS')) return Promise.resolve({ rows: [{ session_exists: true, claimed: true, applied: true }], rowCount: 1 })
    return Promise.resolve({ rows: [], rowCount: 1 })
    }),
    connect: vi.fn(async () => ({
    query: (sql: string, params?: any[]) => dedupPool.query(sql, params),
    release: vi.fn(),
    })),
    end: vi.fn(),
  }
  const r = new Router(dedupPool)
  const daemonWs = createMockWs()
  await r.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'h', agents: [], started_at: 100 }, 1)
  const clientWs = createMockWs()
  r.registerClient(clientWs, 1)
  await r.handleClientMessage(clientWs, { type: 'replay', session_id: 'sess-1', last_seq: 0 })
  clientWs._sent.length = 0

  const event = {
    type: 'approval_request', session_id: 'sess-1', event_id: 'opencode:tool:call_1:running',
    request_id: '', tool: 'read', usage: { input_tokens: 3 },
  }
  r.handleDaemonMessage('daemon-1', { ...event, seq: 1 })
  r.handleDaemonMessage('daemon-1', { ...event, seq: 2 })
  await tick()

  expect(clientWs._sent.filter((m: any) => m.type === 'approval_request')).toHaveLength(1)
  expect(queries.filter(q => q.sql.includes('total_tokens = COALESCE')).length).toBe(1)
  expect(queries.filter(q => q.sql.includes('FROM devices WHERE user_id')).length).toBe(1)

  daemonWs._sent.length = 0
  r.handleDaemonMessage('daemon-1', { type: 'ping' })
  expect(daemonWs._sent.find((m: any) => m.type === 'event_ack')?.up_to_seq).toBe(2)
  })

  test.each(['session_discovered'])(
  '%s upsert replay only fans out the inserted event while acking both seqs',
  async (type) => {
    const dedupPool = createMockPool([51, 0])
    const r = new Router(dedupPool)
    const daemonWs = createMockWs()
    await r.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'h', agents: [], started_at: 100 }, 1)
    const clientWs = createMockWs()
    r.registerClient(clientWs, 1)
    clientWs._sent.length = 0
    const event = {
    type, session_id: `sess-${type}`, event_id: `opencode:${type}:stable`,
    cwd: '/tmp', agent: 'opencode', status: 'running',
    }
    r.handleDaemonMessage('daemon-1', { ...event, seq: 1 })
    r.handleDaemonMessage('daemon-1', { ...event, seq: 2 })
    await tick()
    expect(clientWs._sent.filter((m: any) => m.type === type)).toHaveLength(1)

    daemonWs._sent.length = 0
    r.handleDaemonMessage('daemon-1', { type: 'ping' })
    expect(daemonWs._sent.find((m: any) => m.type === 'event_ack')?.up_to_seq).toBe(2)
  },
  )

  // Fence/authorization infrastructure that necessarily runs for every
  // daemon event; it is not a business side effect.
  const infraQuery = (sql: string) =>
    sql.includes('INSERT INTO events')
    || sql.includes('SELECT 1 FROM deleted_sessions')
    || sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK'
    || sql.includes('pg_advisory_xact_lock')
    || sql.includes('session_allowed')

  test.each([
  { type: 'session_id_changed', extra: { old_session_id: 'old-sess' } },
  { type: 'session_created', extra: { title: 'Created' } },
  { type: 'session_discovered', extra: { cwd: '/tmp', agent: 'opencode', status: 'running' } },
  { type: 'session_model_changed', extra: { model: 'openai/gpt-5' } },
  { type: 'session_agent_changed', extra: { current_agent: 'build' } },
  ])('$type conflict advances ack without DB/session/quota/subscription/fanout effects', async ({ type, extra }) => {
  const conflictPool = createMockPool([0])
  const r = new Router(conflictPool)
  const daemonWs = createMockWs()
  await r.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'h', agents: [], started_at: 100 }, 1)
  const clientWs = createMockWs()
  r.registerClient(clientWs, 1)
  await tick()
  conflictPool._queries.length = 0
  clientWs._sent.length = 0
  ;(r as any).clients.get(clientWs).subscribedSessions.add('old-sess')

  r.handleDaemonMessage('daemon-1', {
    type, session_id: 'new-sess', event_id: `stable:${type}`, seq: 1, ...extra,
  })
  await tick()

  const nonEventWrites = conflictPool._queries.filter((q: any) => !infraQuery(q.sql))
  expect(nonEventWrites).toEqual([])
  expect((r as any).sessionToDaemon.has('new-sess')).toBe(false)
  expect((r as any).clients.get(clientWs).subscribedSessions.has('new-sess')).toBe(false)
  expect((r as any).clients.get(clientWs).subscribedSessions.has('old-sess')).toBe(true)
  expect(clientWs._sent).toEqual([])

  daemonWs._sent.length = 0
  r.handleDaemonMessage('daemon-1', { type: 'ping' })
  expect(daemonWs._sent.find((m: any) => m.type === 'event_ack')?.up_to_seq).toBe(1)
  })

  test('special-branch effects await DB completion in daemon seq order', async () => {
  const releases = new Map<number, (result: any) => void>()
  const updates: string[] = []
  let releaseModel!: (result: any) => void
  const orderedPool: any = {
    query: vi.fn((sql: string, params?: any[]) => {
    if (sql.includes('INSERT INTO events')) {
      const payload = JSON.parse(params?.[2] || '{}')
      return new Promise(resolve => releases.set(payload.seq, resolve))
    }
    if (sql.includes('UPDATE sessions SET model')) {
      updates.push(`model:${params?.[0]}`)
      return new Promise(resolve => { releaseModel = resolve })
    }
    if (sql.includes('UPDATE sessions SET active_agent')) {
      updates.push(`agent:${params?.[0]}`)
      return Promise.resolve({ rows: [], rowCount: 1 })
    }
    if (sql.includes('FROM daemons')) return Promise.resolve({ rows: [{ daemon_id: 'daemon-1', status: 'online' }] })
    return Promise.resolve({ rows: [], rowCount: 1 })
    }),
    connect: vi.fn(async () => ({ query: (sql: string, params?: any[]) => orderedPool.query(sql, params), release: vi.fn() })),
    end: vi.fn(),
  }
  const r = new Router(orderedPool)
  const daemonWs = createMockWs()
  await r.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'h', agents: [], started_at: 100 }, 1)
  const clientWs = createMockWs()
  r.registerClient(clientWs, 1)
  ;(r as any).clients.get(clientWs).subscribedSessions.add('sess-1')
  clientWs._sent.length = 0
  r.handleDaemonMessage('daemon-1', { type: 'session_model_changed', session_id: 'sess-1', event_id: 'model:first', model: 'first', seq: 1 })
  r.handleDaemonMessage('daemon-1', { type: 'session_agent_changed', session_id: 'sess-1', event_id: 'agent:build', current_agent: 'build', seq: 2 })

  // The session fence defers the INSERT behind a pool.connect microtask;
  // flush before releasing so both pending writes exist.
  await tick()
  releases.get(2)!({ rows: [{ id: 2 }] })
  await tick()
  expect(updates).toEqual([])
  expect(clientWs._sent.filter((m: any) => m.type === 'session_model_changed')).toEqual([])
  releases.get(1)!({ rows: [{ id: 1 }] })
  await tick()
  expect(updates).toEqual(['model:first'])
  expect(clientWs._sent.filter((m: any) => m.type === 'session_agent_changed')).toEqual([])
  releaseModel({ rows: [], rowCount: 1 })
  await tick()
  expect(updates).toEqual(['model:first', 'agent:build'])
  expect(clientWs._sent.filter((m: any) => ['session_model_changed', 'session_agent_changed'].includes(m.type)).map((m: any) => m.type)).toEqual(['session_model_changed', 'session_agent_changed'])

  daemonWs._sent.length = 0
  r.handleDaemonMessage('daemon-1', { type: 'ping' })
  expect(daemonWs._sent.find((m: any) => m.type === 'event_ack')?.up_to_seq).toBe(2)
  })

  test('session status waits for the preceding session create upsert', async () => {
    const writes: string[] = []
    let releaseCreate!: (result: any) => void
    let eventID = 0
    const orderedPool: any = {
      query: vi.fn((sql: string) => {
        if (sql.includes('WITH target AS MATERIALIZED')) {
          return Promise.resolve({ rows: [{ matched: true, changed: true }], rowCount: 1 })
        }
        if (sql.includes('FROM quota_reservations reservation')) {
          return Promise.resolve({ rows: [{
            id: '00000000-0000-0000-0000-000000000771',
            resource: 'concurrent_session', operation: 'create', daemon_id: 'daemon-1',
            session_id: null, state: 'pending', settlement_reason: null,
            agent_type: 'codex', cwd: '/repo', hostname: 'h',
          }], rowCount: 1 })
        }
        if (sql.includes('INSERT INTO events')) return Promise.resolve({ rows: [{ id: ++eventID }] })
        if (sql.includes('INSERT INTO sessions')) {
          writes.push('create')
          return new Promise(resolve => { releaseCreate = resolve })
        }
        if (sql.includes('UPDATE sessions SET') && sql.includes('status = input.status')) {
          writes.push('status')
          return Promise.resolve({ rows: [], rowCount: 1 })
        }
        if (sql.includes('FROM daemons')) return Promise.resolve({ rows: [{ daemon_id: 'daemon-1', status: 'online' }] })
        return Promise.resolve({ rows: [], rowCount: 1 })
      }),
      connect: vi.fn(async () => ({ query: (sql: string, params?: any[]) => orderedPool.query(sql, params), release: vi.fn() })), end: vi.fn(),
    }
    const r = new Router(orderedPool)
    const daemonWs = createMockWs()
    await r.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'h', agents: [], started_at: 100 }, 1)
    r.handleDaemonMessage('daemon-1', {
      type: 'session_created', session_id: 'sess-1', event_id: 'create',
      request_id: 'create-request', seq: 1,
    })
    r.handleDaemonMessage('daemon-1', { type: 'session_status', session_id: 'sess-1', event_id: 'status', status: 'completed', seq: 2 })
    await tick()
    expect(writes).toEqual(['create'])
    releaseCreate({ rows: [], rowCount: 1 })
    await vi.waitFor(() => {
      expect(writes).toEqual(['create', 'status'])
    })
  })

  test('special-branch persistence rejection withholds ack and all effects', async () => {
  const rejectedPool: any = {
    query: vi.fn((sql: string) => {
    if (sql.includes('INSERT INTO events')) return Promise.reject(new Error('db down'))
    if (sql.includes('FROM daemons')) return Promise.resolve({ rows: [{ daemon_id: 'daemon-1', status: 'online' }] })
    return Promise.resolve({ rows: [], rowCount: 1 })
    }),
    connect: vi.fn(async () => ({ query: (sql: string) => rejectedPool.query(sql), release: vi.fn() })), end: vi.fn(),
  }
  const r = new Router(rejectedPool)
  const daemonWs = createMockWs()
  await r.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'h', agents: [], started_at: 100 }, 1)
  const clientWs = createMockWs()
  r.registerClient(clientWs, null)
  clientWs._sent.length = 0
  r.handleDaemonMessage('daemon-1', {
    type: 'session_model_changed', session_id: 'sess-1', event_id: 'model:new', model: 'new', seq: 1,
  })
  await new Promise(resolve => setTimeout(resolve, 4500))
  expect(rejectedPool.query.mock.calls.some(([sql]: [string]) => sql.includes('UPDATE sessions SET model'))).toBe(false)
  expect(clientWs._sent).toEqual([])
  daemonWs._sent.length = 0
  r.handleDaemonMessage('daemon-1', { type: 'ping' })
  expect(daemonWs._sent.some((m: any) => m.type === 'event_ack')).toBe(false)
  }, 7000)

  test('acks subagent agent_text usage without requiring a root session token row', async () => {
    const tokenUpdates: string[] = []
    const missingRootPool: any = {
      query: vi.fn((sql: string) => {
        if (sql.includes('INSERT INTO events')) {
          return Promise.resolve({ rows: [{ id: 1, inserted: true, effect_status: 'pending', effect_step: 0 }] })
        }
        if (sql.includes('total_tokens = COALESCE')) {
          tokenUpdates.push(sql)
          return Promise.resolve({ rows: [{ session_exists: false, claimed: false, applied: false }], rowCount: 1 })
        }
        if (sql.includes("effect_status = 'completed'")) return Promise.resolve({ rows: [], rowCount: 1 })
        if (sql.includes('FROM daemons')) return Promise.resolve({ rows: [{ daemon_id: 'daemon-1', status: 'online' }] })
        return Promise.resolve({ rows: [], rowCount: 1 })
      }),
      connect: vi.fn(async () => ({ query: (sql: string, params?: any[]) => missingRootPool.query(sql, params), release: vi.fn() })), end: vi.fn(),
    }
    const r = new Router(missingRootPool)
    const daemonWs = createMockWs()
    await r.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'h', agents: [], started_at: 100 }, 1)

    r.handleDaemonMessage('daemon-1', {
      type: 'agent_text', session_id: 'root-not-yet-discovered', agent_id: 'child-1', is_subagent: true,
      event_id: 'jsonl:child:1:0', usage: { input_tokens: 3 }, seq: 1,
    })
    await tick()

    expect(tokenUpdates).toEqual([])
    expect((r as any).daemonSeq.get('daemon-1').persistedHigh).toBe(1)
  })

  test('ping piggybacks event_ack with the highest CONTIGUOUS persisted seq', async () => {
    const daemonWs = createMockWs()
    await router.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'h', agents: [], started_at: 100 }, 1)
    router.handleDaemonMessage('daemon-1', { type: 'agent_text', session_id: 'sess-1', text: 'a', seq: 1 })
    router.handleDaemonMessage('daemon-1', { type: 'agent_text', session_id: 'sess-1', text: 'b', seq: 2 })
    router.handleDaemonMessage('daemon-1', { type: 'agent_text', session_id: 'sess-1', text: 'c', seq: 3 })
    await tick() // let the three persists complete and advance persistedHigh

    daemonWs._sent.length = 0
    router.handleDaemonMessage('daemon-1', { type: 'ping' })
    const ack = daemonWs._sent.find((m: any) => m.type === 'event_ack')
    expect(ack).toBeDefined()
    expect(ack.up_to_seq).toBe(3)
  })

  test('drops a duplicate seq while its first persistence is still in flight', async () => {
    let releaseInsert!: (result: any) => void
    let inserts = 0
    const inflightPool: any = {
      query: vi.fn((sql: string) => {
        if (sql.includes('RETURNING daemon_id')) return Promise.resolve({ rows: [{ daemon_id: 'daemon-1' }], rowCount: 1 })
        if (sql.includes('INSERT INTO events')) {
          inserts++
          return new Promise(resolve => { releaseInsert = resolve })
        }
        if (sql.includes('FROM daemons')) return Promise.resolve({ rows: [{ daemon_id: 'daemon-1', status: 'online' }] })
        return Promise.resolve({ rows: [], rowCount: 1 })
      }),
      connect: vi.fn(async () => ({ query: (sql: string, params?: any[]) => inflightPool.query(sql, params), release: vi.fn() })), end: vi.fn(),
    }
    const r = new Router(inflightPool)
    const daemonWs = createMockWs()
    await r.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'h', agents: [], started_at: 100 }, 1)
    const event = { type: 'agent_text', session_id: 'sess-1', event_id: 'same', text: 'hello', seq: 1 }
    r.handleDaemonMessage('daemon-1', event)
    r.handleDaemonMessage('daemon-1', event)
    await tick()
    expect(inserts).toBe(1)
    releaseInsert({ rows: [{ id: 1 }] })
    await tick()
    daemonWs._sent.length = 0
    r.handleDaemonMessage('daemon-1', { type: 'ping' })
    expect(daemonWs._sent.find((message: any) => message.type === 'event_ack')?.up_to_seq).toBe(1)
  })

  test('does not let an old daemon incarnation complete against the new cursor', async () => {
    const releases = new Map<string, (result: any) => void>()
    const updates: string[] = []
    const racePool: any = {
      query: vi.fn((sql: string, params?: any[]) => {
        if (sql.includes('INSERT INTO events')) {
          const payload = JSON.parse(params?.[2] || '{}')
          return new Promise(resolve => releases.set(payload.model, resolve))
        }
        if (sql.includes('UPDATE sessions SET model')) {
          updates.push(params?.[0])
          return Promise.resolve({ rows: [], rowCount: 1 })
        }
        if (sql.includes('FROM daemons')) return Promise.resolve({ rows: [{ daemon_id: 'daemon-1', status: 'online' }] })
        return Promise.resolve({ rows: [], rowCount: 1 })
      }),
      connect: vi.fn(async () => ({ query: (sql: string, params?: any[]) => racePool.query(sql, params), release: vi.fn() })), end: vi.fn(),
    }
    const r = new Router(racePool)
    const oldWs = createMockWs()
    await r.registerDaemon(oldWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'h', agents: [], started_at: 100 }, 1)
    r.handleDaemonMessage('daemon-1', { type: 'session_model_changed', session_id: 'sess-1', event_id: 'old', model: 'old', seq: 7 })

    const newWs = createMockWs()
    await r.registerDaemon(newWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'h', agents: [], started_at: 200 }, 1)
    r.handleDaemonMessage('daemon-1', { type: 'session_model_changed', session_id: 'sess-1', event_id: 'new', model: 'new', seq: 1 })

    releases.get('old')!({ rows: [{ id: 1 }] })
    await tick()
    releases.get('new')!({ rows: [{ id: 2 }] })
    await tick()

    expect(updates).toEqual(['new'])
    const cursor = (r as any).daemonSeq.get('daemon-1')
    expect(cursor.persistedHigh).toBe(1)
    expect([...cursor.pending]).toEqual([])
    newWs._sent.length = 0
    r.handleDaemonMessage('daemon-1', { type: 'ping' })
    expect(newWs._sent.find((message: any) => message.type === 'event_ack')?.up_to_seq).toBe(1)
  })

  test('rejects messages from a replaced daemon socket before they can seed the new cursor', async () => {
    const models: string[] = []
    const pool: any = {
      query: vi.fn(async (sql: string, params?: any[]) => {
        if (sql.includes('INSERT INTO events')) {
          return { rows: [{ id: 1, inserted: true, effect_status: 'pending', effect_step: 0 }] }
        }
        if (sql.includes('UPDATE sessions SET model')) {
          models.push(params?.[0])
          return { rows: [], rowCount: 1 }
        }
        if (sql.includes('FROM daemons')) return { rows: [{ daemon_id: 'daemon-1', status: 'online' }] }
        return { rows: [], rowCount: 1 }
      }),
      connect: vi.fn(async () => ({ query: (sql: string, params?: any[]) => pool.query(sql, params), release: vi.fn() })),
      end: vi.fn(),
    }
    const r = new Router(pool)
    const oldWs = createMockWs()
    const newWs = createMockWs()
    await r.registerDaemon(oldWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'old', agents: [], started_at: 100 }, 1)
    await r.registerDaemon(newWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'new', agents: [], started_at: 200 }, 1)

    expect(oldWs.close).toHaveBeenCalledWith(4009, 'replaced by new incarnation')
    r.handleDaemonMessage('daemon-1', {
      type: 'session_model_changed', session_id: 'sess-1', event_id: 'stale', model: 'stale', seq: 100,
    }, oldWs, 100)
    r.handleDaemonMessage('daemon-1', {
      type: 'session_model_changed', session_id: 'sess-1', event_id: 'fresh', model: 'fresh', seq: 1,
    }, newWs, 200)
    await tick()

    expect(models).toEqual(['fresh'])
    const cursor = (r as any).daemonSeq.get('daemon-1')
    expect(cursor.persistedHigh).toBe(1)
    expect([...cursor.pending]).toEqual([])
  })

  test('serializes competing daemon replacements and closes every losing socket', async () => {
    const r = new Router(createMockPool())
    const oldWs = createMockWs()
    const middleWs = createMockWs()
    const newestWs = createMockWs()
    await r.registerDaemon(oldWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'old', agents: [], started_at: 100 }, 1)
    await Promise.all([
      r.registerDaemon(middleWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'middle', agents: [], started_at: 200 }, 1),
      r.registerDaemon(newestWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'newest', agents: [], started_at: 300 }, 1),
    ])

    expect(oldWs.close).toHaveBeenCalledWith(4009, 'replaced by new incarnation')
    expect(middleWs.close).toHaveBeenCalledWith(4009, 'replaced by new incarnation')
    expect((r as any).daemons.get('daemon-1')).toMatchObject({ ws: newestWs, startedAt: 300 })
    expect((r as any).daemonSeq.get('daemon-1').startedAt).toBe(300)
  })

  test('does not activate a socket that closes while registration is awaiting pre-activation work', async () => {
    let releaseUpsert!: () => void
    const pool: any = {
      query: vi.fn((sql: string) => {
        if (sql.includes('INSERT INTO daemons')) return new Promise(resolve => { releaseUpsert = () => resolve({ rows: [], rowCount: 1 }) })
        if (sql.includes('SELECT user_id FROM daemons')) return Promise.resolve({ rows: [] })
        if (sql.includes('FROM daemons')) return Promise.resolve({ rows: [{ daemon_id: 'daemon-1', status: 'online' }] })
        return Promise.resolve({ rows: [], rowCount: 1 })
      }),
      connect: vi.fn(async () => ({ query: (sql: string, params?: any[]) => pool.query(sql, params), release: vi.fn() })),
      end: vi.fn(),
    }
    const r = new Router(pool)
    const ws = createMockWs()
    const registering = r.registerDaemon(ws, {
      type: 'register', daemon_id: 'daemon-1', hostname: 'h', agents: [], started_at: 100,
    }, 1)
    while (!releaseUpsert) await Promise.resolve()
    ws.readyState = 3
    releaseUpsert()

    await expect(registering).resolves.toBe(false)
    expect((r as any).daemons.has('daemon-1')).toBe(false)
    expect((r as any).daemonSeq.has('daemon-1')).toBe(false)
  })

  test('treats a post-activation alias rejection as best-effort and accepts a contender', async () => {
    const pool = createMockPool()
    pool.query.mockImplementation((sql: string, params?: any[]) => {
      if (sql.includes('SELECT alias FROM daemons')) return Promise.reject(new Error('alias unavailable'))
      return createMockPool().query(sql, params)
    })
    const r = new Router(pool)
    const first = createMockWs()
    const second = createMockWs()
    await expect(r.registerDaemon(first, {
      type: 'register', daemon_id: 'daemon-1', hostname: 'one', agents: [], started_at: 100,
    }, 1)).resolves.toBe(true)
    await expect(r.registerDaemon(second, {
      type: 'register', daemon_id: 'daemon-1', hostname: 'two', agents: [], started_at: 200,
    }, 1)).resolves.toBe(true)
    expect((r as any).daemons.get('daemon-1').ws).toBe(second)
  })

  test('does not let a hanging post-activation alias lookup block the registration chain', async () => {
    const pool = createMockPool()
    pool.query.mockImplementation((sql: string, params?: any[]) => {
      if (sql.includes('SELECT alias FROM daemons')) return new Promise(() => {})
      return createMockPool().query(sql, params)
    })
    const r = new Router(pool)
    const outcome = (promise: Promise<boolean>) => Promise.race([
      promise.then(() => 'registered'),
      new Promise<string>(resolve => setTimeout(() => resolve('timeout'), 30)),
    ])
    expect(await outcome(r.registerDaemon(createMockWs(), {
      type: 'register', daemon_id: 'daemon-1', hostname: 'one', agents: [], started_at: 100,
    }, 1))).toBe('registered')
    const contender = createMockWs()
    expect(await outcome(r.registerDaemon(contender, {
      type: 'register', daemon_id: 'daemon-1', hostname: 'two', agents: [], started_at: 200,
    }, 1))).toBe('registered')
    expect((r as any).daemons.get('daemon-1').ws).toBe(contender)
  })

  test('does not broadcast a changed-incarnation reconcile that completes after its replacement', async () => {
    let releaseOld!: (closed: string[]) => void
    const reconcile = vi.spyOn(await import('../db.js'), 'reconcileDaemonSessions')
      .mockImplementationOnce(() => new Promise(resolve => { releaseOld = resolve }))
      .mockResolvedValueOnce([])
    const r = new Router(createMockPool())
    const client = createMockWs()
    r.registerClient(client, 1)
    await r.registerDaemon(createMockWs(), {
      type: 'register', daemon_id: 'daemon-1', hostname: 'old', agents: [], started_at: 100,
      active_session_ids: ['A'],
    }, 1)
    await r.registerDaemon(createMockWs(), {
      type: 'register', daemon_id: 'daemon-1', hostname: 'new', agents: [], started_at: 200,
      active_session_ids: ['B'],
    }, 1)
    client._sent.length = 0
    releaseOld(['B'])
    await tick()
    expect(client._sent).not.toContainEqual(expect.objectContaining({ type: 'session_status', session_id: 'B', status: 'completed' }))
    reconcile.mockRestore()
  })

  test('does not broadcast a same-incarnation reconcile from a replaced connection', async () => {
    let releaseOld!: (closed: string[]) => void
    const reconcile = vi.spyOn(await import('../db.js'), 'reconcileDaemonSessions')
      .mockImplementationOnce(() => new Promise(resolve => { releaseOld = resolve }))
      .mockResolvedValueOnce([])
    const r = new Router(createMockPool())
    const client = createMockWs()
    r.registerClient(client, 1)
    await r.registerDaemon(createMockWs(), {
      type: 'register', daemon_id: 'daemon-1', hostname: 'old-socket', agents: [], started_at: 100,
      active_session_ids: ['A'],
    }, 1)
    await r.registerDaemon(createMockWs(), {
      type: 'register', daemon_id: 'daemon-1', hostname: 'new-socket', agents: [], started_at: 100,
      active_session_ids: ['B'],
    }, 1)
    client._sent.length = 0
    releaseOld(['B'])
    await tick()
    expect(client._sent).not.toContainEqual(expect.objectContaining({ type: 'session_status', session_id: 'B', status: 'completed' }))
    reconcile.mockRestore()
  })

  test('restores old persisted identity and token when delayed activation finishes after close without rolling back a successor', async () => {
    const dbModule = await import('../db.js')
    let persisted = { hostname: 'none', startedAt: 0, token: 'none', registrationId: 'none' }
    let releaseContender!: () => void
    const activation = vi.spyOn(dbModule, 'activateDaemonRegistration')
      .mockImplementationOnce(async (_pool, input) => {
        persisted = { hostname: input.hostname, startedAt: input.startedAt || 0, token: input.tokenJti || '', registrationId: input.registrationId }
        return null
      })
      .mockImplementationOnce((_pool, input) => new Promise(resolve => {
        releaseContender = () => {
          const snapshot: any = {
            hostname: persisted.hostname, agents: [], status: 'online', last_heartbeat: null,
            arch: null, version: null, started_at: persisted.startedAt, active_token_jti: persisted.token,
            machine_id: null, last_login_at: null, registration_id: persisted.registrationId,
          }
          persisted = { hostname: input.hostname, startedAt: input.startedAt || 0, token: input.tokenJti || '', registrationId: input.registrationId }
          resolve(snapshot)
        }
      }))
      .mockImplementationOnce(async (_pool, input) => {
        const snapshot: any = {
          hostname: persisted.hostname, agents: [], status: 'online', last_heartbeat: null,
          arch: null, version: null, started_at: persisted.startedAt, active_token_jti: persisted.token,
          machine_id: null, last_login_at: null, registration_id: persisted.registrationId,
        }
        persisted = { hostname: input.hostname, startedAt: input.startedAt || 0, token: input.tokenJti || '', registrationId: input.registrationId }
        return snapshot
      })
    let restoreAttempts = 0
    const restore = vi.spyOn(dbModule, 'restoreDaemonRegistration').mockImplementation(async (_pool, _daemonId, expected, snapshot) => {
      restoreAttempts++
      if (restoreAttempts === 1) return { status: 'sql_failure', error: new Error('transient') } as const
      if (persisted.registrationId !== expected || !snapshot) return { status: 'stale_successor' } as const
      persisted = {
        hostname: snapshot.hostname || '', startedAt: Number(snapshot.started_at) || 0,
        token: snapshot.active_token_jti || '', registrationId: snapshot.registration_id || '',
      }
      return { status: 'confirmed_restored' } as const
    })
    const r = new Router(createMockPool())
    await r.registerDaemon(createMockWs(), {
      type: 'register', daemon_id: 'daemon-1', hostname: 'old', agents: [], started_at: 100,
    }, 1, 'old-token')

    const contenderWs = createMockWs()
    const contender = r.registerDaemon(contenderWs, {
      type: 'register', daemon_id: 'daemon-1', hostname: 'contender', agents: [], started_at: 200,
    }, 1, 'contender-token')
    while (!releaseContender) await Promise.resolve()
    contenderWs.readyState = 3
    releaseContender()
    await expect(contender).resolves.toBe(false)
    expect(persisted).toMatchObject({ hostname: 'old', startedAt: 100, token: 'old-token' })

    await r.registerDaemon(createMockWs(), {
      type: 'register', daemon_id: 'daemon-1', hostname: 'successor', agents: [], started_at: 300,
    }, 1, 'successor-token')
    expect(persisted).toMatchObject({ hostname: 'successor', startedAt: 300, token: 'successor-token' })
    expect(restore).toHaveBeenCalledTimes(2)
    activation.mockRestore()
    restore.mockRestore()
  })

  test('fails both local generations closed when activation compensation permanently fails', async () => {
    const dbModule = await import('../db.js')
    let contenderWs: any
    const activation = vi.spyOn(dbModule, 'activateDaemonRegistration').mockImplementation(async (_pool, input) => {
      if (input.hostname === 'contender') contenderWs.readyState = 3
      return null
    })
    const restore = vi.spyOn(dbModule, 'restoreDaemonRegistration').mockResolvedValue({
      status: 'sql_failure', error: new Error('still unavailable'),
    })
    const r = new Router(createMockPool())
    const oldWs = createMockWs()
    await r.registerDaemon(oldWs, {
      type: 'register', daemon_id: 'daemon-1', hostname: 'old', agents: [], started_at: 100,
    }, 1)
    contenderWs = createMockWs()
    await expect(r.registerDaemon(contenderWs, {
      type: 'register', daemon_id: 'daemon-1', hostname: 'contender', agents: [], started_at: 200,
    }, 1)).resolves.toBe(false)

    expect(restore).toHaveBeenCalledTimes(3)
    expect(oldWs.close).toHaveBeenCalled()
    expect((r as any).daemons.has('daemon-1')).toBe(false)
    expect((r as any).daemonSeq.has('daemon-1')).toBe(false)
    oldWs._sent.length = 0
    r.handleDaemonMessage('daemon-1', { type: 'ping', seq: 1 })
    expect(oldWs._sent.some((message: any) => message.type === 'event_ack')).toBe(false)
    activation.mockRestore()
    restore.mockRestore()
  })

  test('does not remove or close an already-winning successor when compensation CAS misses', async () => {
    const dbModule = await import('../db.js')
    let contenderWs: any
    const activation = vi.spyOn(dbModule, 'activateDaemonRegistration').mockImplementation(async (_pool, input) => {
      if (input.hostname === 'contender') contenderWs.readyState = 3
      return null
    })
    const r = new Router(createMockPool())
    const oldWs = createMockWs()
    await r.registerDaemon(oldWs, {
      type: 'register', daemon_id: 'daemon-1', hostname: 'old', agents: [], started_at: 100,
    }, 1)
    const successorWs = createMockWs()
    const restore = vi.spyOn(dbModule, 'restoreDaemonRegistration').mockImplementation(async () => {
      ;(r as any).daemons.set('daemon-1', {
        ws: successorWs, daemonId: 'daemon-1', hostname: 'successor', agents: [], userId: null,
        startedAt: 300, registrationId: 'successor-generation',
      })
      return { status: 'stale_successor' } as const
    })
    contenderWs = createMockWs()
    await r.registerDaemon(contenderWs, {
      type: 'register', daemon_id: 'daemon-1', hostname: 'contender', agents: [], started_at: 200,
    }, 1)
    expect((r as any).daemons.get('daemon-1').ws).toBe(successorWs)
    expect(successorWs.close).not.toHaveBeenCalled()
    activation.mockRestore()
    restore.mockRestore()
  })

  test('ignores a late offline finalizer captured from a replaced generation', async () => {
    const dbModule = await import('../db.js')
    const offline = vi.spyOn(dbModule, 'setDaemonOfflineWithTimeout').mockResolvedValue(true as any)
    const r = new Router(createMockPool())
    const oldWs = createMockWs()
    await r.registerDaemon(oldWs, {
      type: 'register', daemon_id: 'daemon-1', hostname: 'old', agents: [], started_at: 100,
    }, 1)
    const capturedOld = (r as any).daemons.get('daemon-1')
    const successorWs = createMockWs()
    await r.registerDaemon(successorWs, {
      type: 'register', daemon_id: 'daemon-1', hostname: 'successor', agents: [], started_at: 200,
    }, 1)
    await (r as any).finalizeDaemonOffline('daemon-1', capturedOld)
    expect((r as any).daemons.get('daemon-1').ws).toBe(successorWs)
    expect(offline).not.toHaveBeenCalled()
    offline.mockRestore()
  })

  test('retries a transient generation-bound offline failure and discloses permanent failure without broadcasting', async () => {
    const dbModule = await import('../db.js')
    const transient = vi.spyOn(dbModule, 'setDaemonOfflineWithTimeout')
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce(true as any)
    const first = new Router(createMockPool())
    const firstWs = createMockWs()
    const firstClient = createMockWs()
    first.registerClient(firstClient, 1)
    await first.registerDaemon(firstWs, {
      type: 'register', daemon_id: 'daemon-1', hostname: 'first', agents: [], started_at: 100,
    }, 1)
    const capturedFirst = (first as any).daemons.get('daemon-1')
    firstClient._sent.length = 0
    await (first as any).finalizeDaemonOffline('daemon-1', capturedFirst)
    await tick()
    expect(transient).toHaveBeenCalledTimes(2)
    expect(firstClient._sent).toContainEqual(expect.objectContaining({ type: 'daemon_status', status: 'offline' }))
    transient.mockRestore()

    const permanent = vi.spyOn(dbModule, 'setDaemonOfflineWithTimeout').mockRejectedValue(new Error('down'))
    const second = new Router(createMockPool())
    const secondWs = createMockWs()
    const secondClient = createMockWs()
    second.registerClient(secondClient, 1)
    await second.registerDaemon(secondWs, {
      type: 'register', daemon_id: 'daemon-2', hostname: 'second', agents: [], started_at: 100,
    }, 1)
    const capturedSecond = (second as any).daemons.get('daemon-2')
    secondClient._sent.length = 0
    await (second as any).finalizeDaemonOffline('daemon-2', capturedSecond)
    expect(permanent).toHaveBeenCalledTimes(3)
    expect(secondClient._sent).not.toContainEqual(expect.objectContaining({ type: 'daemon_status', status: 'offline' }))
    permanent.mockRestore()
  })

  test('withholds token-event ack while the session is missing, then retries exactly once', async () => {
    let sessionExists = false
    let effectStep = 0
    let effectStatus = 'pending'
    let tokenTotal = 0
    let insertCount = 0
    const pool: any = {
      query: vi.fn(async (sql: string, params?: any[]) => {
        if (sql.includes('INSERT INTO events')) {
          insertCount++
          return { rows: [{ id: 1, inserted: insertCount === 1, effect_status: effectStatus, effect_step: effectStep }] }
        }
        if (sql.includes('SELECT effect_status, effect_step')) {
          return { rows: [{ effect_status: effectStatus, effect_step: effectStep }] }
        }
        if (sql.includes('session_target AS')) {
          if (!sessionExists) return { rows: [{ session_exists: false, claimed: false, applied: false }], rowCount: 1 }
          if (effectStep >= (params?.[1] || 0)) return { rows: [{ session_exists: true, claimed: false, applied: false }], rowCount: 1 }
          effectStep = params?.[1] || 0
          tokenTotal += params?.[2] || 0
          return { rows: [{ session_exists: true, claimed: true, applied: true }], rowCount: 1 }
        }
        if (sql.includes("effect_status = 'completed'")) {
          effectStatus = 'completed'
          return { rows: [], rowCount: 1 }
        }
        if (sql.includes('FROM daemons')) return { rows: [{ daemon_id: 'daemon-1', status: 'online' }] }
        return { rows: [], rowCount: 1 }
      }),
      connect: vi.fn(async () => ({ query: (sql: string, params?: any[]) => pool.query(sql, params), release: vi.fn() })),
      end: vi.fn(),
    }
    const r = new Router(pool)
    const ws = createMockWs()
    await r.registerDaemon(ws, { type: 'register', daemon_id: 'daemon-1', hostname: 'h', agents: [], started_at: 100 }, 1)
    const event = {
      type: 'agent_text', session_id: 'sess-late', event_id: 'token-late', snapshot: 'done',
      usage: { input_tokens: 3, output_tokens: 4 }, seq: 1,
    }

    r.handleDaemonMessage('daemon-1', event)
    await tick()
    ws._sent.length = 0
    r.handleDaemonMessage('daemon-1', { type: 'ping' })
    expect(ws._sent.some((message: any) => message.type === 'event_ack')).toBe(false)
    expect(effectStep).toBe(0)
    expect(tokenTotal).toBe(0)

    sessionExists = true
    r.handleDaemonMessage('daemon-1', event)
    await tick()
    ws._sent.length = 0
    r.handleDaemonMessage('daemon-1', { type: 'ping' })
    expect(ws._sent.find((message: any) => message.type === 'event_ack')?.up_to_seq).toBe(1)
    expect(effectStep).toBe(1)
    expect(effectStatus).toBe('completed')
    expect(tokenTotal).toBe(7)
  })

  test('retires an already-running old drain before installing the new incarnation', async () => {
    let releaseOld!: (result: any) => void
    const completed: string[] = []
    const pool: any = {
      query: vi.fn((sql: string, params?: any[]) => {
        if (sql.includes('INSERT INTO events')) {
          return Promise.resolve({ rows: [{ id: params?.[2]?.includes('old') ? 1 : 2, inserted: true, effect_status: 'pending', effect_step: 0 }] })
        }
        if (sql.includes('UPDATE sessions SET model')) {
          if (params?.[0] === 'old') return new Promise(resolve => { releaseOld = (result) => { completed.push('old'); resolve(result) } })
          completed.push('new')
          return Promise.resolve({ rows: [], rowCount: 1 })
        }
        if (sql.includes('FROM daemons')) return Promise.resolve({ rows: [{ daemon_id: 'daemon-1', status: 'online' }] })
        return Promise.resolve({ rows: [], rowCount: 1 })
      }),
      connect: vi.fn(async () => ({ query: (sql: string, params?: any[]) => pool.query(sql, params), release: vi.fn() })), end: vi.fn(),
    }
    const r = new Router(pool)
    await r.registerDaemon(createMockWs(), { type: 'register', daemon_id: 'daemon-1', hostname: 'h', agents: [], started_at: 100 }, 1)
    r.handleDaemonMessage('daemon-1', { type: 'session_model_changed', session_id: 'sess-1', event_id: 'old', model: 'old', seq: 1 })
    await tick()
    let registered = false
    const newWs = createMockWs()
    const registering = r.registerDaemon(newWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'h', agents: [], started_at: 200 }, 1)
      .then(() => { registered = true })
    await Promise.resolve()
    expect(registered).toBe(false)
    releaseOld({ rows: [], rowCount: 1 })
    await registering
    r.handleDaemonMessage('daemon-1', { type: 'session_model_changed', session_id: 'sess-1', event_id: 'new', model: 'new', seq: 1 })
    await tick()
    expect(completed).toEqual(['old', 'new'])
  })

  test('does not deadlock new registration when the retiring effect rejects', async () => {
    const pool: any = {
      query: vi.fn((sql: string) => {
        if (sql.includes('INSERT INTO events')) {
          return Promise.resolve({ rows: [{ id: 1, inserted: true, effect_status: 'pending', effect_step: 0 }] })
        }
        if (sql.includes('UPDATE sessions SET model')) return Promise.reject(new Error('retiring effect failed'))
        if (sql.includes('FROM daemons')) return Promise.resolve({ rows: [{ daemon_id: 'daemon-1', status: 'online' }] })
        return Promise.resolve({ rows: [], rowCount: 1 })
      }),
      connect: vi.fn(async () => ({ query: (sql: string, params?: any[]) => pool.query(sql, params), release: vi.fn() })), end: vi.fn(),
    }
    const r = new Router(pool)
    await r.registerDaemon(createMockWs(), { type: 'register', daemon_id: 'daemon-1', hostname: 'h', agents: [], started_at: 100 }, 1)
    r.handleDaemonMessage('daemon-1', { type: 'session_model_changed', session_id: 'sess-1', event_id: 'old', model: 'old', seq: 1 })
    await tick()
    await expect(r.registerDaemon(createMockWs(), {
      type: 'register', daemon_id: 'daemon-1', hostname: 'h', agents: [], started_at: 200,
    }, 1)).resolves.toBe(true)
    expect((r as any).daemonSeq.get('daemon-1').startedAt).toBe(200)
  })

  test('bounds retirement wait when an old effect never settles', async () => {
    const previous = process.env.DAEMON_CURSOR_RETIRE_MS
    process.env.DAEMON_CURSOR_RETIRE_MS = '100'
    let releaseOld!: (result: any) => void
    const pool: any = {
      query: vi.fn((sql: string) => {
        if (sql.includes('INSERT INTO events')) {
          return Promise.resolve({ rows: [{ id: 1, inserted: true, effect_status: 'pending', effect_step: 0 }] })
        }
        if (sql.includes('UPDATE sessions SET model')) return new Promise(resolve => { releaseOld = resolve })
        if (sql.includes('FROM daemons')) return Promise.resolve({ rows: [{ daemon_id: 'daemon-1', status: 'online' }] })
        return Promise.resolve({ rows: [], rowCount: 1 })
      }),
      connect: vi.fn(async () => ({ query: (sql: string, params?: any[]) => pool.query(sql, params), release: vi.fn() })), end: vi.fn(),
    }
    try {
      const r = new Router(pool)
      await r.registerDaemon(createMockWs(), { type: 'register', daemon_id: 'daemon-1', hostname: 'h', agents: [], started_at: 100 }, 1)
      r.handleDaemonMessage('daemon-1', { type: 'session_model_changed', session_id: 'sess-1', event_id: 'old', model: 'old', seq: 1 })
      await tick()
      const newWs = createMockWs()
      await r.registerDaemon(newWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'h', agents: [], started_at: 200 }, 1)
      expect(newWs._sent).toContainEqual(expect.objectContaining({ type: 'register_rejected', reason: 'previous_effect_draining' }))
      expect(newWs.close).toHaveBeenCalledWith(4012, 'previous effect still draining')
      releaseOld({ rows: [], rowCount: 1 })
    } finally {
      if (previous === undefined) delete process.env.DAEMON_CURSOR_RETIRE_MS
      else process.env.DAEMON_CURSOR_RETIRE_MS = previous
    }
  })

  test('awaits cumulative cost writes before starting the next seq effect', async () => {
    const costs: number[] = []
    let releaseFirstCost!: (result: any) => void
    let eventID = 0
    const costPool: any = {
      query: vi.fn((sql: string, params?: any[]) => {
        if (sql.includes('INSERT INTO events')) return Promise.resolve({ rows: [{ id: ++eventID }] })
        if (sql.includes('status = $3')) return Promise.resolve({ rows: [], rowCount: 1 })
        if (sql.includes('SET cost_usd = $1')) {
          costs.push(params?.[0])
          if (costs.length === 1) return new Promise(resolve => { releaseFirstCost = resolve })
          return Promise.resolve({ rows: [], rowCount: 1 })
        }
        if (sql.includes('FROM daemons')) return Promise.resolve({ rows: [{ daemon_id: 'daemon-1', status: 'online' }] })
        return Promise.resolve({ rows: [], rowCount: 1 })
      }),
      connect: vi.fn(async () => ({ query: (sql: string, params?: any[]) => costPool.query(sql, params), release: vi.fn() })), end: vi.fn(),
    }
    const r = new Router(costPool)
    const daemonWs = createMockWs()
    await r.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'h', agents: [], started_at: 100 }, 1)
    r.handleDaemonMessage('daemon-1', { type: 'session_status', session_id: 'sess-1', event_id: 'cost-1', status: 'running', cost_usd: '1', seq: 1 })
    r.handleDaemonMessage('daemon-1', { type: 'session_status', session_id: 'sess-1', event_id: 'cost-2', status: 'running', cost_usd: '2', seq: 2 })
    await tick()
    expect(costs).toEqual([1])
    releaseFirstCost({ rows: [], rowCount: 1 })
    await tick()
    expect(costs).toEqual([1, 2])
  })

  test('withholds ack on durable-effect rejection and retries it after insert conflict', async () => {
    let eventInsert = 0
    let modelAttempts = 0
    const retryPool: any = {
      query: vi.fn((sql: string) => {
        if (sql.includes('INSERT INTO events')) {
          eventInsert++
          return Promise.resolve(eventInsert === 1
            ? { rows: [{ id: 1, inserted: true, effect_status: 'pending', effect_step: 0 }] }
            : { rows: [{ id: 1, inserted: false, effect_status: 'pending', effect_step: 0 }] })
        }
        if (sql.includes('UPDATE sessions SET model')) {
          modelAttempts++
          if (modelAttempts === 1) return Promise.reject(new Error('model write failed'))
          return Promise.resolve({ rows: [], rowCount: 1 })
        }
        if (sql.includes('FROM daemons')) return Promise.resolve({ rows: [{ daemon_id: 'daemon-1', status: 'online' }] })
        return Promise.resolve({ rows: [], rowCount: 1 })
      }),
      connect: vi.fn(async () => ({ query: (sql: string, params?: any[]) => retryPool.query(sql, params), release: vi.fn() })), end: vi.fn(),
    }
    const r = new Router(retryPool)
    const daemonWs = createMockWs()
    await r.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'h', agents: [], started_at: 100 }, 1)
    const event = { type: 'session_model_changed', session_id: 'sess-1', event_id: 'model-retry', model: 'new', seq: 1 }
    r.handleDaemonMessage('daemon-1', event)
    await tick()
    daemonWs._sent.length = 0
    r.handleDaemonMessage('daemon-1', { type: 'ping' })
    expect(daemonWs._sent.some((message: any) => message.type === 'event_ack')).toBe(false)

    r.handleDaemonMessage('daemon-1', event)
    await tick()
    expect(modelAttempts).toBe(2)
    daemonWs._sent.length = 0
    r.handleDaemonMessage('daemon-1', { type: 'ping' })
    expect(daemonWs._sent.find((message: any) => message.type === 'event_ack')?.up_to_seq).toBe(1)
  })

  test('resumes a partially completed effect from its durable step checkpoint', async () => {
    let effectStep = 0
    let effectStatus = 'pending'
    let tokenUpdates = 0
    let deviceReads = 0
    const checkpointPool: any = {
      query: vi.fn((sql: string, params?: any[]) => {
        if (sql.includes('INSERT INTO events')) {
          return Promise.resolve({ rows: [{
            id: 1, inserted: effectStep === 0 && deviceReads === 0,
            effect_status: effectStatus, effect_step: effectStep,
          }] })
        }
        if (sql.includes('effect_step = GREATEST')) {
          effectStep = Math.max(effectStep, params?.[1] || 0)
          return Promise.resolve({ rows: [], rowCount: 1 })
        }
        if (sql.includes("effect_status = 'completed'")) {
          effectStatus = 'completed'
          return Promise.resolve({ rows: [], rowCount: 1 })
        }
        if (sql.includes('total_tokens = COALESCE')) {
          tokenUpdates++
          effectStep = Math.max(effectStep, params?.[1] || 0)
          return Promise.resolve({ rows: [{ session_exists: true, claimed: true, applied: true }], rowCount: 1 })
        }
        if (sql.includes('FROM devices WHERE user_id')) {
          deviceReads++
          if (deviceReads === 1) return Promise.reject(new Error('device query failed'))
          return Promise.resolve({ rows: [] })
        }
        if (sql.includes('SELECT plan, whitelist')) return Promise.resolve({ rows: [{ plan: 'free', whitelist: false }] })
        if (sql.includes('FROM daemons')) return Promise.resolve({ rows: [{ daemon_id: 'daemon-1', status: 'online' }] })
        return Promise.resolve({ rows: [], rowCount: 1 })
      }),
      connect: vi.fn(async () => ({ query: (sql: string, params?: any[]) => checkpointPool.query(sql, params), release: vi.fn() })), end: vi.fn(),
    }
    const r = new Router(checkpointPool)
    const daemonWs = createMockWs()
    await r.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'h', agents: [], started_at: 100 }, 1)
    const event = {
      type: 'approval_request', session_id: 'sess-1', event_id: 'approval-retry', request_id: 'request-1',
      tool: 'read', usage: { input_tokens: 3 }, seq: 1,
    }
    r.handleDaemonMessage('daemon-1', event)
    await tick()
    expect(tokenUpdates).toBe(1)
    expect(effectStep).toBe(1)
    daemonWs._sent.length = 0
    r.handleDaemonMessage('daemon-1', { type: 'ping' })
    expect(daemonWs._sent.some((message: any) => message.type === 'event_ack')).toBe(false)

    r.handleDaemonMessage('daemon-1', event)
    await tick()
    expect(tokenUpdates).toBe(1)
    expect(deviceReads).toBe(2)
    expect(effectStatus).toBe('completed')
    daemonWs._sent.length = 0
    r.handleDaemonMessage('daemon-1', { type: 'ping' })
    expect(daemonWs._sent.find((message: any) => message.type === 'event_ack')?.up_to_seq).toBe(1)
  })

  test('recovers a pending durable effect after relay restart and insert conflict', async () => {
    let firstInsert = true
    let status = 'pending'
    let attempts = 0
    const restartPool: any = {
      query: vi.fn((sql: string) => {
        if (sql.includes('INSERT INTO events')) {
          const inserted = firstInsert
          firstInsert = false
          return Promise.resolve({ rows: [{ id: 21, inserted, effect_status: status, effect_step: 0 }] })
        }
        if (sql.includes("effect_status = 'completed'")) {
          status = 'completed'
          return Promise.resolve({ rows: [], rowCount: 1 })
        }
        if (sql.includes('UPDATE sessions SET model')) {
          attempts++
          if (attempts === 1) return Promise.reject(new Error('first relay lost DB connection'))
          return Promise.resolve({ rows: [], rowCount: 1 })
        }
        if (sql.includes('FROM daemons')) return Promise.resolve({ rows: [{ daemon_id: 'daemon-1', status: 'online' }] })
        return Promise.resolve({ rows: [], rowCount: 1 })
      }),
      connect: vi.fn(async () => ({ query: (sql: string, params?: any[]) => restartPool.query(sql, params), release: vi.fn() })), end: vi.fn(),
    }
    const event = { type: 'session_model_changed', session_id: 'sess-1', event_id: 'restart-pending', model: 'new', seq: 1 }
    const first = new Router(restartPool)
    const firstWs = createMockWs()
    await first.registerDaemon(firstWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'h', agents: [], started_at: 100 }, 1)
    first.handleDaemonMessage('daemon-1', event)
    await tick()
    first.stop()

    const restarted = new Router(restartPool)
    const restartedWs = createMockWs()
    await restarted.registerDaemon(restartedWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'h', agents: [], started_at: 100 }, 1)
    restarted.handleDaemonMessage('daemon-1', event)
    await tick()
    expect(attempts).toBe(2)
    expect(status).toBe('completed')
    restartedWs._sent.length = 0
    restarted.handleDaemonMessage('daemon-1', { type: 'ping' })
    expect(restartedWs._sent.find((message: any) => message.type === 'event_ack')?.up_to_seq).toBe(1)
    restarted.stop()
  })

  test('rechecks the ledger before a queued duplicate event effect runs', async () => {
    let status = 'pending'
    let modelUpdates = 0
    const pool: any = {
      query: vi.fn((sql: string) => {
        if (sql.includes('INSERT INTO events')) {
          return Promise.resolve({ rows: [{ id: 31, inserted: false, effect_status: status, effect_step: 0 }] })
        }
        if (sql.includes("SELECT effect_status, effect_step FROM events")) {
          return Promise.resolve({ rows: [{ effect_status: status, effect_step: 0 }] })
        }
        if (sql.includes("effect_status = 'completed'")) {
          status = 'completed'
          return Promise.resolve({ rows: [], rowCount: 1 })
        }
        if (sql.includes('UPDATE sessions SET model')) {
          modelUpdates++
          return Promise.resolve({ rows: [], rowCount: 1 })
        }
        if (sql.includes('FROM daemons')) return Promise.resolve({ rows: [{ daemon_id: 'daemon-1', status: 'online' }] })
        return Promise.resolve({ rows: [], rowCount: 1 })
      }),
      connect: vi.fn(async () => ({ query: (sql: string, params?: any[]) => pool.query(sql, params), release: vi.fn() })), end: vi.fn(),
    }
    const r = new Router(pool)
    await r.registerDaemon(createMockWs(), { type: 'register', daemon_id: 'daemon-1', hostname: 'h', agents: [], started_at: 100 }, 1)
    const event = { type: 'session_model_changed', session_id: 'sess-1', event_id: 'same-event', model: 'new' }
    r.handleDaemonMessage('daemon-1', { ...event, seq: 1 })
    r.handleDaemonMessage('daemon-1', { ...event, seq: 2 })
    await tick()
    expect(modelUpdates).toBe(1)
  })

  test('ack-after-persist: the mark does not advance until the DB write completes', async () => {
    // Pool whose event INSERT stays pending until we release it, so the persist
    // is in flight when we ping.
    let releaseInsert: (() => void) | undefined
    const pendingPool: any = {
      query: vi.fn((sql: string) => {
        if (sql.includes('RETURNING daemon_id')) {
          return Promise.resolve({ rows: [{ daemon_id: 'daemon-1' }], rowCount: 1 })
        }
        if (sql.includes('session_allowed')) {
          return Promise.resolve({ rows: [{ session_exists: true, session_allowed: true }], rowCount: 1 })
        }
        if (sql.includes('INSERT INTO events')) {
          return new Promise((res) => { releaseInsert = () => res({ rows: [{ id: 1 }] }) })
        }
        if (sql.includes('FROM daemons')) return Promise.resolve({ rows: [{ daemon_id: 'daemon-1', status: 'online' }] })
        return Promise.resolve({ rows: [], rowCount: 0 })
      }),
      end: vi.fn(),
    }
    pendingPool.connect = vi.fn(async () => ({ query: pendingPool.query, release: vi.fn() }))
    const r = new Router(pendingPool)
    const daemonWs = createMockWs()
    await r.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'h', agents: [], started_at: 100 }, 1)

    r.handleDaemonMessage('daemon-1', { type: 'agent_text', session_id: 'sess-1', text: 'x', seq: 1 })
    // The fence opens the write behind a connect microtask; flush so the
    // INSERT is pending, then verify the ack withholds while it is in flight.
    await tick()
    daemonWs._sent.length = 0
    r.handleDaemonMessage('daemon-1', { type: 'ping' })
    expect(daemonWs._sent.find((m: any) => m.type === 'event_ack')).toBeUndefined()

    // Release the DB write → the mark advances and the next ping acks it.
    releaseInsert!()
    await tick()
    daemonWs._sent.length = 0
    r.handleDaemonMessage('daemon-1', { type: 'ping' })
    const ack = daemonWs._sent.find((m: any) => m.type === 'event_ack')
    expect(ack).toBeDefined()
    expect(ack.up_to_seq).toBe(1)
  })

  test('daemon restart (changed started_at) resets the seq cursor', async () => {
    const ws1 = createMockWs()
    await router.registerDaemon(ws1, { type: 'register', daemon_id: 'daemon-1', hostname: 'h', agents: [], started_at: 100 }, 1)
    const clientWs = createMockWs()
    router.registerClient(clientWs, 1)
    await router.handleClientMessage(clientWs, { type: 'replay', session_id: 'sess-1', last_seq: 0 })

    router.handleDaemonMessage('daemon-1', { type: 'agent_text', session_id: 'sess-1', text: 'a', seq: 9 })

    // Daemon process restarts: new started_at, seq counter back to 1.
    const ws2 = createMockWs()
    await router.registerDaemon(ws2, { type: 'register', daemon_id: 'daemon-1', hostname: 'h', agents: [], started_at: 200 }, 1)

    clientWs._sent.length = 0
    // seq 1 from the new process must NOT be treated as a duplicate of the old 9.
    router.handleDaemonMessage('daemon-1', { type: 'agent_text', session_id: 'sess-1', text: 'b', seq: 1 })
  await tick()
    expect(clientWs._sent.filter((m: any) => m.type === 'agent_text').length).toBe(1)
  })

  test('register acked_seq seeds the mark so a replayed tail acks without a phantom gap', async () => {
    const daemonWs = createMockWs()
    // Daemon reconnected after the grace window (our entry was dropped) reporting
    // it already had seq 50 acked, and replays only its unacked tail 51,52.
    await router.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'h', agents: [], started_at: 100, acked_seq: 50 }, 1)
    router.handleDaemonMessage('daemon-1', { type: 'agent_text', session_id: 'sess-1', text: 'a', seq: 51 })
    router.handleDaemonMessage('daemon-1', { type: 'agent_text', session_id: 'sess-1', text: 'b', seq: 52 })
    await tick()

    daemonWs._sent.length = 0
    router.handleDaemonMessage('daemon-1', { type: 'ping' })
    const ack = daemonWs._sent.find((m: any) => m.type === 'event_ack')
    expect(ack).toBeDefined()
    expect(ack.up_to_seq).toBe(52) // advanced from the seeded baseline 50, no 1..50 stall
  })

  test('a legacy daemon (no acked_seq) replaying a tail still acks via the first-seq floor', async () => {
    const daemonWs = createMockWs()
    await router.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'h', agents: [], started_at: 100 }, 1) // no acked_seq
    // Replays its unacked tail 71,72 — nothing below was resent.
    router.handleDaemonMessage('daemon-1', { type: 'agent_text', session_id: 'sess-1', text: 'a', seq: 71 })
    router.handleDaemonMessage('daemon-1', { type: 'agent_text', session_id: 'sess-1', text: 'b', seq: 72 })
    await tick()

    daemonWs._sent.length = 0
    router.handleDaemonMessage('daemon-1', { type: 'ping' })
    const ack = daemonWs._sent.find((m: any) => m.type === 'event_ack')
    expect(ack).toBeDefined()
    expect(ack.up_to_seq).toBe(72) // floored at 70 from the first seq, no 1..70 stall
  })

  test('legacy events without seq are always processed', async () => {
    const daemonWs = createMockWs()
    await router.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'h', agents: [], started_at: 100 }, 1)
    const clientWs = createMockWs()
    router.registerClient(clientWs, 1)
    await router.handleClientMessage(clientWs, { type: 'replay', session_id: 'sess-1', last_seq: 0 })

    clientWs._sent.length = 0
    router.handleDaemonMessage('daemon-1', { type: 'agent_text', session_id: 'sess-1', text: 'x' })
    router.handleDaemonMessage('daemon-1', { type: 'agent_text', session_id: 'sess-1', text: 'y' })
  await tick()
    expect(clientWs._sent.filter((m: any) => m.type === 'agent_text').length).toBe(2)
  })
})

describe('Router - WS authorization gate (P0-1)', () => {
  // Pool whose ownership check always denies (SELECT 1 FROM sessions → no row),
  // simulating a session that belongs to a different user than the caller.
  function denyingPool(): any {
    const pool: any = {
      query: vi.fn((sql: string) => {
        if (sql.includes('SELECT 1 FROM sessions')) return Promise.resolve({ rows: [], rowCount: 0 })
        if (sql.includes('FROM sessions') && sql.includes('SELECT')) {
          return Promise.resolve({ rows: [{ daemon_id: 'daemon-1' }] })
        }
        return Promise.resolve({ rows: [], rowCount: 0 })
      }),
      end: vi.fn(),
    }
    pool.connect = vi.fn(async () => ({ query: pool.query, release: vi.fn() }))
    return pool
  }

  test('replay on a non-owned session is rejected and leaks no events', async () => {
    const router = new Router(denyingPool())
    const clientWs = createMockWs()
    router.registerClient(clientWs, 2) // attacker

    await router.handleClientMessage(clientWs, { type: 'replay', session_id: 'victim-sess', last_seq: 0 })

    const err = clientWs._sent.find((m: any) => m.type === 'error')
    expect(err).toBeDefined()
    expect(err.error).toBe('session not found or not owned')
    expect(clientWs._sent.some((m: any) => m.type === 'replay_batch')).toBe(false)
  })

  test('a control command on a non-owned session is not forwarded to the daemon', async () => {
    const router = new Router(denyingPool())
    const daemonWs = createMockWs()
    await router.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'h', agents: [] }, 1)

    const clientWs = createMockWs()
    router.registerClient(clientWs, 2) // different user
    daemonWs._sent.length = 0

    await router.handleClientMessage(clientWs, { type: 'set_permission_config', session_id: 'victim-sess', permission: { agent: 'codex', preset: 'custom', approval_policy: 'never', sandbox_mode: 'workspace-write' } })

    expect(daemonWs._sent.some((m: any) => m.type === 'set_permission_config')).toBe(false)
    expect(clientWs._sent.some((m: any) => m.error === 'session not found or not owned')).toBe(true)
  })

  test('owned permission config is routed unchanged through session ownership, ignoring supplied daemon id', async () => {
    const router = new Router(createMockPool())
    const ownerDaemon = createMockWs()
    const otherDaemon = createMockWs()
    await router.registerDaemon(ownerDaemon, { type: 'register', daemon_id: 'daemon-1', hostname: 'owner', agents: [] }, 1)
    await router.registerDaemon(otherDaemon, { type: 'register', daemon_id: 'daemon-2', hostname: 'other', agents: [] }, 1)
    const clientWs = createMockWs()
    router.registerClient(clientWs, 1)
    ownerDaemon._sent.length = 0
    otherDaemon._sent.length = 0
    const permission = { agent: 'codex', preset: 'custom', approval_policy: 'never', sandbox_mode: 'workspace-write' }

    await router.handleClientMessage(clientWs, { type: 'set_permission_config', session_id: 'test-sid', daemon_id: 'daemon-2', permission })

    expect(ownerDaemon._sent).toContainEqual({ type: 'set_permission_config', session_id: 'test-sid', daemon_id: 'daemon-2', permission })
    expect(otherDaemon._sent.some((m: any) => m.type === 'set_permission_config')).toBe(false)
  })

  test('permission_config_changed is broadcast unchanged to subscribed clients', async () => {
    const router = new Router(createMockPool())
    const daemonWs = createMockWs()
    await router.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'h', agents: [] }, 1)
    const clientWs = createMockWs()
    router.registerClient(clientWs, 1)
    await router.handleClientMessage(clientWs, { type: 'replay', session_id: 'test-sid', last_seq: 0 })
    clientWs._sent.length = 0
    const event = { type: 'permission_config_changed', session_id: 'test-sid', permission: { agent: 'codex', preset: 'custom', approval_policy: 'never', sandbox_mode: 'workspace-write' }, permission_effective: 'next_turn' }

    router.handleDaemonMessage('daemon-1', event)
  await tick()

    expect(clientWs._sent).toContainEqual(event)
  })

  test('a rejected non-owned session does not subscribe the attacker to its event stream', async () => {
    const router = new Router(denyingPool())
    const daemonWs = createMockWs()
    await router.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'h', agents: [] }, 1)

    const attackerWs = createMockWs()
    router.registerClient(attackerWs, 2)
    await router.handleClientMessage(attackerWs, { type: 'replay', session_id: 'victim-sess', last_seq: 0 })

    attackerWs._sent.length = 0
    // A live event for the victim's session must not reach the attacker.
    router.handleDaemonMessage('daemon-1', { type: 'agent_text', session_id: 'victim-sess', text: 'secret' })
    expect(attackerWs._sent.some((m: any) => m.type === 'agent_text')).toBe(false)
  })

  test('anonymous (userId=null) connection may not act on a specific session', async () => {
    const router = new Router(denyingPool())
    const clientWs = createMockWs()
    router.registerClient(clientWs, null)

    await router.handleClientMessage(clientWs, { type: 'replay', session_id: 'any-sess', last_seq: 0 })

    const err = clientWs._sent.find((m: any) => m.type === 'error')
    expect(err).toBeDefined()
    expect(err.error).toBe('forbidden')
  })
})

describe('Router - force kick revokes the daemon-specific token (P0-2)', () => {
  test('handleForceKick revokes daemons.active_token_jti, not an empty jti', async () => {
    const revokeInserts: any[][] = []
    const pool: any = {
      query: vi.fn((sql: string, params?: any[]) => {
        if (sql.includes('RETURNING daemon_id')) return Promise.resolve({ rows: [{ daemon_id: 'daemon-1' }], rowCount: 1 })
        if (sql.includes('SELECT active_token_jti')) {
          return Promise.resolve({ rows: [{ active_token_jti: 'jti-abc' }], rowCount: 1 })
        }
        if (sql.includes('INSERT INTO revoked_tokens')) {
          revokeInserts.push(params || [])
          return Promise.resolve({ rows: [], rowCount: 1 })
        }
        return Promise.resolve({ rows: [], rowCount: 0 })
      }),
      end: vi.fn(),
    }
    pool.connect = vi.fn(async () => ({ query: pool.query, release: vi.fn() }))
    const router = new Router(pool)
    const daemonWs = createMockWs()
    await router.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'h', agents: [] }, 7, 'jti-abc')

    const res = await router.handleForceKick('daemon-1', 7)
    expect(res.success).toBe(true)

    // The revocation row must carry the daemon's real jti — the old code inserted
    // an empty jti that isTokenRevoked (WHERE jti=$1) could never match.
    expect(revokeInserts.length).toBe(1)
    expect(revokeInserts[0][0]).toBe('jti-abc')      // jti
    expect(revokeInserts[0][1]).toBe(7)              // userId
    expect(revokeInserts[0][2]).toBe('force_kick')   // reason
  })

  test('serializes replacement behind force kick and revokes only the captured generation token', async () => {
    const dbModule = await import('../db.js')
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const capturedRevoke = vi.spyOn(dbModule, 'revokeToken').mockImplementation(async () => gate)
    const rereadRevoke = vi.spyOn(dbModule, 'revokeDaemonToken').mockImplementation(async () => gate)
    const audit = vi.spyOn(dbModule, 'insertAuditLog').mockResolvedValue(undefined)
    const offline = vi.spyOn(dbModule, 'setDaemonOfflineWithTimeout').mockResolvedValue(true as any)
    const router = new Router(createMockPool())
    const oldWs = createMockWs()
    await router.registerDaemon(oldWs, {
      type: 'register', daemon_id: 'daemon-1', hostname: 'old', agents: [], started_at: 100,
    }, 7, 'old-token')

    const kicking = router.handleForceKick('daemon-1', 7)
    await Promise.resolve()
    const replacementWs = createMockWs()
    const replacing = router.registerDaemon(replacementWs, {
      type: 'register', daemon_id: 'daemon-1', hostname: 'replacement', agents: [], started_at: 200,
    }, 7, 'new-token')
    await tick()
    expect(replacementWs._sent.some((message: any) => message.type === 'register_ack')).toBe(false)

    release()
    await kicking
    await replacing
    expect(capturedRevoke).toHaveBeenCalledWith(expect.anything(), 'old-token', 7, 'force_kick')
    expect(rereadRevoke).not.toHaveBeenCalled()
    expect((router as any).daemons.get('daemon-1').ws).toBe(replacementWs)
    expect(replacementWs.close).not.toHaveBeenCalled()
    capturedRevoke.mockRestore()
    rereadRevoke.mockRestore()
    audit.mockRestore()
    offline.mockRestore()
  })

  test('rejects an already-authenticated old-token registration queued behind force kick but accepts a new token', async () => {
    const dbModule = await import('../db.js')
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const revoked = new Set<string>()
    const revoke = vi.spyOn(dbModule, 'revokeToken').mockImplementation(async (_pool, jti) => {
      await gate
      revoked.add(jti)
    })
    const check = vi.spyOn(dbModule, 'isTokenRevoked').mockImplementation(async (_pool, jti) => revoked.has(jti))
    const audit = vi.spyOn(dbModule, 'insertAuditLog').mockResolvedValue(undefined)
    const offline = vi.spyOn(dbModule, 'setDaemonOfflineWithTimeout').mockResolvedValue(true as any)
    const router = new Router(createMockPool())
    await router.registerDaemon(createMockWs(), {
      type: 'register', daemon_id: 'daemon-1', hostname: 'old', agents: [], started_at: 100,
    }, 7, 'old-token')
    const kicking = router.handleForceKick('daemon-1', 7)
    await Promise.resolve()
    const queuedOldWs = createMockWs()
    const queuedOld = router.registerDaemon(queuedOldWs, {
      type: 'register', daemon_id: 'daemon-1', hostname: 'queued-old', agents: [], started_at: 100,
    }, 7, 'old-token')
    release()
    await expect(kicking).resolves.toEqual({ success: true })
    await expect(queuedOld).resolves.toBe(false)
    expect(queuedOldWs._sent).toContainEqual(expect.objectContaining({ type: 'register_rejected', reason: 'token_revoked' }))
    expect(queuedOldWs._sent.some((message: any) => message.type === 'register_ack')).toBe(false)

    const newWs = createMockWs()
    await expect(router.registerDaemon(newWs, {
      type: 'register', daemon_id: 'daemon-1', hostname: 'new', agents: [], started_at: 200,
    }, 7, 'new-token')).resolves.toBe(true)
    expect(newWs._sent).toContainEqual(expect.objectContaining({ type: 'register_ack' }))
    revoke.mockRestore(); check.mockRestore(); audit.mockRestore(); offline.mockRestore()
  })

  test('rejects a cross-relay activation that observed an old standalone revocation check', async () => {
    const dbModule = await import('../db.js')
    const oldRelay = new Router(createMockPool())
    const oldWs = createMockWs()
    await oldRelay.registerDaemon(oldWs, {
      type: 'register', daemon_id: 'daemon-1', hostname: 'old-relay', agents: [], started_at: 100,
    }, 7, 'old-token')

    let releaseRevoke!: () => void
    const revokeGate = new Promise<void>((resolve) => { releaseRevoke = resolve })
    let revokeHasFence!: () => void
    const revokeFence = new Promise<void>((resolve) => { revokeHasFence = resolve })
    let revoked = false
    vi.spyOn(dbModule, 'revokeToken').mockImplementation(async () => {
      revokeHasFence()
      await revokeGate
      revoked = true
    })
    // Router-level precheck deliberately observes the old value. The activation
    // transaction below represents the independent relay waiting on DB fence.
    vi.spyOn(dbModule, 'isTokenRevoked').mockResolvedValue(false)
    vi.spyOn(dbModule, 'activateDaemonRegistration').mockImplementation(async () => {
      await revokeGate
      if (revoked) throw new dbModule.TokenRevokedDuringActivationError()
      return null
    })
    vi.spyOn(dbModule, 'insertAuditLog').mockResolvedValue(undefined)
    vi.spyOn(dbModule, 'setDaemonOfflineWithTimeout').mockResolvedValue(true as any)

    const kicking = oldRelay.handleForceKick('daemon-1', 7)
    await revokeFence
    const newRelay = new Router(createMockPool())
    const racingWs = createMockWs()
    const racing = newRelay.registerDaemon(racingWs, {
      type: 'register', daemon_id: 'daemon-1', hostname: 'other-relay', agents: [], started_at: 200,
    }, 7, 'old-token')
    await Promise.resolve()
    releaseRevoke()

    await expect(kicking).resolves.toEqual({ success: true })
    await expect(racing).resolves.toBe(false)
    expect(oldWs.close).toHaveBeenCalled()
    expect(racingWs._sent).toContainEqual(expect.objectContaining({ type: 'register_rejected', reason: 'token_revoked' }))
    expect(racingWs._sent.some((message: any) => message.type === 'register_ack')).toBe(false)
    expect((newRelay as any).daemons.has('daemon-1')).toBe(false)
    vi.restoreAllMocks()
  })

  test('fails closed and clears a bounded gate when pending messages overflow', async () => {
    const dbModule = await import('../db.js')
    let finish!: (revoked: boolean) => void
    const check = vi.spyOn(dbModule, 'isTokenRevokedWithTimeout').mockResolvedValue(false)
    vi.spyOn(dbModule, 'setDaemonOfflineWithTimeout').mockResolvedValue(true as any)
    const relay = new Router(createMockPool())
    const ws = createMockWs()
    await relay.registerDaemon(ws, {
      type: 'register', daemon_id: 'daemon-1', hostname: 'relay', agents: [], started_at: 200,
    }, 7, 'token-1')
    forceAuthLeaseRefresh(relay)
    check.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finish = resolve }))

    relay.handleDaemonMessage('daemon-1', { type: 'ping', seq: 1 }, ws, 200)
    for (let seq = 2; seq <= 5; seq++) {
      relay.handleDaemonMessage('daemon-1', {
        type: 'agent_text', session_id: 'bounded', text: `queued-${seq}`, seq,
      }, ws, 200)
    }

    expect(ws.close).toHaveBeenCalledWith(1011, 'revocation gate overflow')
    expect((relay as any).daemonRevocationGates.size).toBe(0)
    finish(false)
    await tick()
    expect((relay as any).daemonRevocationGates.size).toBe(0)
    vi.restoreAllMocks()
  })

  test('fails closed when one queued message exceeds the gate byte budget', async () => {
    const dbModule = await import('../db.js')
    let finish!: (revoked: boolean) => void
    const check = vi.spyOn(dbModule, 'isTokenRevokedWithTimeout').mockImplementationOnce(
      () => new Promise<boolean>((resolve) => { finish = resolve }),
    )
    vi.spyOn(dbModule, 'setDaemonOfflineWithTimeout').mockResolvedValue(true as any)
    const relay = new Router(createMockPool())
    const ws = createMockWs()
    await relay.registerDaemon(ws, {
      type: 'register', daemon_id: 'daemon-1', hostname: 'relay', agents: [], started_at: 200,
    }, 7, 'token-1')
    forceAuthLeaseRefresh(relay)

    relay.handleDaemonMessage('daemon-1', { type: 'ping', seq: 1, padding: 'x'.repeat(2048) }, ws, 200)

    expect(check).toHaveBeenCalledOnce()
    expect(ws.close).toHaveBeenCalledWith(1011, 'revocation gate overflow')
    expect((relay as any).daemonRevocationGates.size).toBe(0)
    finish(false)
    await Promise.resolve()
    vi.restoreAllMocks()
  })

  test('fails closed and releases the bounded lookup client after PostgreSQL statement timeout', async () => {
    const dbModule = await import('../db.js')
    vi.spyOn(dbModule, 'setDaemonOfflineWithTimeout').mockResolvedValue(true as any)
    const pool = createMockPool()
    const originalConnect = pool.connect
    let boundedReleaseCount = 0
    const boundedSql: string[] = []
    pool.connect = vi.fn(async () => {
      const client = await originalConnect()
      let boundedLookup = false
      return {
        query: vi.fn(async (sql: string, params?: any[]) => {
          if (sql.includes("set_config('statement_timeout'")) boundedLookup = true
          if (boundedLookup) boundedSql.push(sql)
          if (boundedLookup && sql.includes('FROM revoked_tokens')) {
            throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })
          }
          return client.query(sql, params)
        }),
        release: vi.fn(() => {
          if (boundedLookup) boundedReleaseCount++
          client.release()
        }),
      }
    })
    const relay = new Router(pool)
    const ws = createMockWs()
    await relay.registerDaemon(ws, {
      type: 'register', daemon_id: 'daemon-1', hostname: 'relay', agents: [], started_at: 200,
    }, 7, 'token-1')
    expireAuthLease(relay)

    relay.handleDaemonMessage('daemon-1', { type: 'ping', seq: 1 }, ws, 200)
    await tick()

    expect(ws.close).toHaveBeenCalledWith(1011, 'token check unavailable')
    expect(boundedSql).toHaveLength(0)
    expect(boundedReleaseCount).toBe(0)
    expect((relay as any).daemonRevocationGates.size).toBe(0)
    vi.restoreAllMocks()
  })

  test('clears the pending revocation gate and queued messages on socket disconnect', async () => {
    const dbModule = await import('../db.js')
    let finish!: (revoked: boolean) => void
    const check = vi.spyOn(dbModule, 'isTokenRevokedWithTimeout').mockResolvedValue(false)
    const pool = createMockPool()
    const relay = new Router(pool)
    const ws = createMockWs()
    await relay.registerDaemon(ws, {
      type: 'register', daemon_id: 'daemon-1', hostname: 'relay', agents: [], started_at: 200,
    }, 7, 'token-1')
    forceAuthLeaseRefresh(relay)
    check.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finish = resolve }))
    relay.handleDaemonMessage('daemon-1', { type: 'ping', seq: 1 }, ws, 200)
    relay.handleDaemonMessage('daemon-1', {
      type: 'agent_text', session_id: 'disconnect-gated', text: 'queued', seq: 2,
    }, ws, 200)

    relay.unregisterDaemon('daemon-1', ws)
    expect((relay as any).daemonRevocationGates.size).toBe(0)
    finish(false)
    await tick()
    expect(pool._queries.some((query: any) => query.sql.includes('INSERT INTO events') && query.params.includes('disconnect-gated'))).toBe(false)
    vi.restoreAllMocks()
  })

  test('cancels an old queued gate on replacement and never replays it after late success', async () => {
    const dbModule = await import('../db.js')
    const heartbeatCheck = vi.spyOn(dbModule, 'isTokenRevokedWithTimeout').mockResolvedValue(false)
    const pool = createMockPool()
    const relay = new Router(pool)
    const oldWs = createMockWs()
    await relay.registerDaemon(oldWs, {
      type: 'register', daemon_id: 'daemon-1', hostname: 'old', agents: [], started_at: 100,
    }, 7, 'old-token')
    forceAuthLeaseRefresh(relay)
    let finish!: (revoked: boolean) => void
    heartbeatCheck.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finish = resolve })).mockResolvedValue(false)
    relay.handleDaemonMessage('daemon-1', { type: 'ping', seq: 1 }, oldWs, 100)
    relay.handleDaemonMessage('daemon-1', {
      type: 'agent_text', session_id: 'old-queued', text: 'never replay', seq: 2,
    }, oldWs, 100)

    const successorWs = createMockWs()
    await relay.registerDaemon(successorWs, {
      type: 'register', daemon_id: 'daemon-1', hostname: 'successor', agents: [], started_at: 200,
    }, 7, 'new-token')
    expect((relay as any).daemonRevocationGates.size).toBe(0)
    finish(false)
    await tick()

    expect((relay as any).daemons.get('daemon-1').ws).toBe(successorWs)
    expect(pool._queries.some((query: any) => query.sql.includes('INSERT INTO events') && query.params.includes('old-queued'))).toBe(false)
    vi.restoreAllMocks()
  })

  test('tears down a gate before pool checkout timeout and reconnects without accumulating waiters', async () => {
    const pool = createMockPool()
    const relay = new Router(pool)
    const oldWs = createMockWs()
    await relay.registerDaemon(oldWs, {
      type: 'register', daemon_id: 'daemon-1', hostname: 'old', agents: [], started_at: 100,
    }, 7, 'old-token')
    forceAuthLeaseRefresh(relay)

    const originalConnect = pool.connect
    let waitingCount = 0
    pool.connect = vi.fn(() => new Promise((_, reject) => {
      waitingCount++
      const timer = setTimeout(() => {
        waitingCount--
        reject(new Error('timeout exceeded when trying to connect'))
      }, 20)
      timer.unref?.()
    }))
    relay.handleDaemonMessage('daemon-1', { type: 'ping', seq: 1 }, oldWs, 100)
    relay.handleDaemonMessage('daemon-1', {
      type: 'agent_text', session_id: 'checkout-queued', text: 'never replay', seq: 2,
    }, oldWs, 100)
    expect(waitingCount).toBe(1)

    relay.unregisterDaemon('daemon-1', oldWs)
    expect((relay as any).daemonRevocationGates.size).toBe(0)
    pool.connect = originalConnect
    const successorWs = createMockWs()
    await relay.registerDaemon(successorWs, {
      type: 'register', daemon_id: 'daemon-1', hostname: 'successor', agents: [], started_at: 200,
    }, 7, 'new-token')
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(waitingCount).toBe(0)
    expect((relay as any).daemonRevocationGates.size).toBe(0)
    expect((relay as any).daemons.get('daemon-1').ws).toBe(successorWs)
    expect(successorWs.close).not.toHaveBeenCalled()
    expect(pool._queries.some((query: any) => query.sql.includes('INSERT INTO events') && query.params.includes('checkout-queued'))).toBe(false)
  })

  test('disconnects an activation-first cross-relay connection on its next heartbeat after revoke', async () => {
    const dbModule = await import('../db.js')
    const check = vi.spyOn(dbModule, 'isTokenRevokedWithTimeout').mockResolvedValue(false)
    const relay = new Router(createMockPool())
    const ws = createMockWs()
    await relay.registerDaemon(ws, {
      type: 'register', daemon_id: 'daemon-1', hostname: 'other-relay', agents: [], started_at: 200,
    }, 7, 'token-1')
    forceAuthLeaseRefresh(relay)
    check.mockResolvedValue(true)

    relay.handleDaemonMessage('daemon-1', { type: 'ping' }, ws, 200)
    await Promise.resolve()

    expect(ws.close).toHaveBeenCalledWith(4001, 'token revoked')
    vi.restoreAllMocks()
  })

  test('gates later events before seq admission while a heartbeat token check is pending', async () => {
    const dbModule = await import('../db.js')
    const check = vi.spyOn(dbModule, 'isTokenRevokedWithTimeout').mockResolvedValue(false)
    const pool = createMockPool()
    const relay = new Router(pool)
    const ws = createMockWs()
    await relay.registerDaemon(ws, {
      type: 'register', daemon_id: 'daemon-1', hostname: 'relay', agents: [], started_at: 200,
    }, 7, 'token-1')
    forceAuthLeaseRefresh(relay)
    let finishCheck!: (revoked: boolean) => void
    check.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finishCheck = resolve }))

    relay.handleDaemonMessage('daemon-1', { type: 'ping', seq: 1 }, ws, 200)
    relay.handleDaemonMessage('daemon-1', {
      type: 'agent_text', session_id: 'session-gated', text: 'after heartbeat', seq: 2,
    }, ws, 200)
    await Promise.resolve()
    expect(pool._queries.some((query: any) => query.sql.includes('INSERT INTO events') && query.params.includes('session-gated'))).toBe(false)

    finishCheck(false)
    await tick()
    expect(pool._queries.some((query: any) => query.sql.includes('INSERT INTO events') && query.params.includes('session-gated'))).toBe(true)
    vi.restoreAllMocks()
  })

  test('settles concurrent heartbeat seqs in order after one shared successful check', async () => {
    const dbModule = await import('../db.js')
    const check = vi.spyOn(dbModule, 'isTokenRevokedWithTimeout').mockResolvedValue(false)
    const relay = new Router(createMockPool())
    const ws = createMockWs()
    await relay.registerDaemon(ws, {
      type: 'register', daemon_id: 'daemon-1', hostname: 'relay', agents: [], started_at: 200,
    }, 7, 'token-1')
    forceAuthLeaseRefresh(relay)
    const cursor = (relay as any).daemonSeq.get('daemon-1')
    let finishCheck!: (revoked: boolean) => void
    check.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finishCheck = resolve }))

    relay.handleDaemonMessage('daemon-1', { type: 'ping', seq: 1 }, ws, 200)
    relay.handleDaemonMessage('daemon-1', { type: 'ping', seq: 2 }, ws, 200)
    expect(cursor.inflight.size).toBe(0)
    finishCheck(false)
    await tick()

    expect(check).toHaveBeenCalledOnce()
    expect(cursor.persistedHigh).toBe(2)
    expect(cursor.inflight.size).toBe(0)
    expect(ws._sent.filter((message: any) => message.type === 'pong')).toHaveLength(2)
    vi.restoreAllMocks()
  })

  test.each([
    ['rejection', undefined],
    ['revocation', true],
  ])('fails closed after the lease expires when the shared check ends in %s', async (_label, revoked) => {
    const dbModule = await import('../db.js')
    const check = vi.spyOn(dbModule, 'isTokenRevokedWithTimeout').mockResolvedValue(false)
    vi.spyOn(dbModule, 'setDaemonOfflineWithTimeout').mockResolvedValue(true as any)
    const relay = new Router(createMockPool())
    const ws = createMockWs()
    await relay.registerDaemon(ws, {
      type: 'register', daemon_id: 'daemon-1', hostname: 'relay', agents: [], started_at: 200,
    }, 7, 'token-1')
    expireAuthLease(relay)
    const cursor = (relay as any).daemonSeq.get('daemon-1')
    relay.handleDaemonMessage('daemon-1', { type: 'ping', seq: 1 }, ws, 200)
    relay.handleDaemonMessage('daemon-1', { type: 'ping', seq: 2 }, ws, 200)
    await tick()

    expect(cursor.inflight.size).toBe(0)
    expect(cursor.pending.size).toBe(0)
    expect(cursor.persistedHigh).toBe(0)
    expect(ws._sent.some((message: any) => message.type === 'pong')).toBe(false)
    vi.restoreAllMocks()
  })

  test('fails the captured heartbeat generation closed after its lease expires when revocation lookup errors', async () => {
    const dbModule = await import('../db.js')
    const check = vi.spyOn(dbModule, 'isTokenRevokedWithTimeout').mockResolvedValue(false)
    const heartbeat = vi.spyOn(dbModule, 'updateHeartbeat').mockResolvedValue(undefined as any)
    const offline = vi.spyOn(dbModule, 'setDaemonOfflineWithTimeout').mockResolvedValue(true as any)
    const pool = createMockPool()
    const relay = new Router(pool)
    const ws = createMockWs()
    await relay.registerDaemon(ws, {
      type: 'register', daemon_id: 'daemon-1', hostname: 'relay', agents: [], started_at: 200,
    }, 7, 'token-1')
    expireAuthLease(relay)
    const cursor = (relay as any).daemonSeq.get('daemon-1')
    check.mockRejectedValue(new Error('revocation database unavailable'))

    relay.handleDaemonMessage('daemon-1', { type: 'ping', seq: 1 }, ws, 200)
    await tick()

    expect(ws.close).toHaveBeenCalledWith(1011, 'token check unavailable')
    expect(cursor.accepting).toBe(false)
    expect(ws._sent.some((message: any) => message.type === 'pong')).toBe(false)
    expect(heartbeat).not.toHaveBeenCalled()
    expect(offline).toHaveBeenCalledWith(expect.anything(), 'daemon-1', expect.any(String), 20)
    const eventWritesBefore = pool._queries.filter((query: any) => query.sql.includes('INSERT INTO events')).length
    relay.handleDaemonMessage('daemon-1', {
      type: 'agent_text', session_id: 'session-after-failure', text: 'must not persist', seq: 2,
    }, ws, 200)
    await tick()
    expect(pool._queries.filter((query: any) => query.sql.includes('INSERT INTO events'))).toHaveLength(eventWritesBefore)
    vi.restoreAllMocks()
  })

  test('does not let an old heartbeat lookup failure close or freeze its successor generation', async () => {
    const dbModule = await import('../db.js')
    const check = vi.spyOn(dbModule, 'isTokenRevokedWithTimeout').mockResolvedValue(false)
    const offline = vi.spyOn(dbModule, 'setDaemonOfflineWithTimeout').mockResolvedValue(true as any)
    const relay = new Router(createMockPool())
    const oldWs = createMockWs()
    await relay.registerDaemon(oldWs, {
      type: 'register', daemon_id: 'daemon-1', hostname: 'old', agents: [], started_at: 100,
    }, 7, 'token-1')
    forceAuthLeaseRefresh(relay)
    let rejectOld!: (error: Error) => void
    const oldLookup = new Promise<boolean>((_, reject) => { rejectOld = reject })
    check.mockImplementationOnce(() => oldLookup).mockResolvedValue(false)
    relay.handleDaemonMessage('daemon-1', { type: 'ping' }, oldWs, 100)

    const successorWs = createMockWs()
    await relay.registerDaemon(successorWs, {
      type: 'register', daemon_id: 'daemon-1', hostname: 'successor', agents: [], started_at: 200,
    }, 7, 'token-2')
    successorWs.close.mockClear()
    rejectOld(new Error('late old lookup failure'))
    await Promise.resolve()
    await Promise.resolve()

    expect(successorWs.close).not.toHaveBeenCalled()
    expect((relay as any).daemons.get('daemon-1').ws).toBe(successorWs)
    expect((relay as any).daemonSeq.get('daemon-1').accepting).toBe(true)
    expect(offline).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  test('retries transient token revoke failure before reporting force-kick success', async () => {
    const dbModule = await import('../db.js')
    const revoke = vi.spyOn(dbModule, 'revokeToken')
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce(undefined)
    vi.spyOn(dbModule, 'insertAuditLog').mockResolvedValue(undefined)
    vi.spyOn(dbModule, 'setDaemonOfflineWithTimeout').mockResolvedValue(true as any)
    const router = new Router(createMockPool())
    const ws = createMockWs()
    await router.registerDaemon(ws, {
      type: 'register', daemon_id: 'daemon-1', hostname: 'h', agents: [], started_at: 100,
    }, 7, 'token')
    await expect(router.handleForceKick('daemon-1', 7)).resolves.toEqual({ success: true })
    expect(revoke).toHaveBeenCalledTimes(2)
    expect(ws.close).toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  test('keeps the old generation online and reports error when token revoke permanently fails', async () => {
    const dbModule = await import('../db.js')
    const revoke = vi.spyOn(dbModule, 'revokeToken').mockRejectedValue(new Error('permanent'))
    const offline = vi.spyOn(dbModule, 'setDaemonOfflineWithTimeout').mockResolvedValue(true as any)
    const router = new Router(createMockPool())
    const ws = createMockWs()
    await router.registerDaemon(ws, {
      type: 'register', daemon_id: 'daemon-1', hostname: 'h', agents: [], started_at: 100,
    }, 7, 'token')
    await expect(router.handleForceKick('daemon-1', 7)).resolves.toEqual({ success: false, error: 'token revocation failed' })
    expect(revoke).toHaveBeenCalledTimes(3)
    expect(ws.close).not.toHaveBeenCalled()
    expect((router as any).daemons.get('daemon-1').ws).toBe(ws)
    expect(offline).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  test('audit failure does not undo a successfully revoked force kick', async () => {
    const dbModule = await import('../db.js')
    const revoke = vi.spyOn(dbModule, 'revokeToken').mockResolvedValue(undefined)
    vi.spyOn(dbModule, 'insertAuditLog').mockRejectedValue(new Error('audit down'))
    vi.spyOn(dbModule, 'setDaemonOfflineWithTimeout').mockResolvedValue(true as any)
    const router = new Router(createMockPool())
    const ws = createMockWs()
    await router.registerDaemon(ws, {
      type: 'register', daemon_id: 'daemon-1', hostname: 'h', agents: [], started_at: 100,
    }, 7, 'token')
    await expect(router.handleForceKick('daemon-1', 7)).resolves.toEqual({ success: true })
    expect(revoke).toHaveBeenCalledOnce()
    expect(ws.close).toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  test('does not hold force-kick safety or the registration lock on a hanging audit write', async () => {
    const dbModule = await import('../db.js')
    vi.spyOn(dbModule, 'revokeToken').mockResolvedValue(undefined)
    vi.spyOn(dbModule, 'insertAuditLog').mockImplementation(() => new Promise<void>(() => {}))
    vi.spyOn(dbModule, 'setDaemonOfflineWithTimeout').mockResolvedValue(true as any)
    const router = new Router(createMockPool())
    const oldWs = createMockWs()
    await router.registerDaemon(oldWs, {
      type: 'register', daemon_id: 'daemon-1', hostname: 'old', agents: [], started_at: 100,
    }, 7, 'old-token')

    const kick = router.handleForceKick('daemon-1', 7)
    const newWs = createMockWs()
    const replacement = router.registerDaemon(newWs, {
      type: 'register', daemon_id: 'daemon-1', hostname: 'new', agents: [], started_at: 200,
    }, 7, 'new-token')
    const deadline = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('force kick remained blocked on audit')), 100))

    await expect(Promise.race([kick, deadline])).resolves.toEqual({ success: true })
    await expect(Promise.race([replacement, deadline])).resolves.toBe(true)
    expect(oldWs.close).toHaveBeenCalled()
    expect((router as any).daemons.get('daemon-1').ws).toBe(newWs)
    vi.restoreAllMocks()
  })

  test('does not hold force-kick or replacement while statement timeout cancels each offline CAS', async () => {
    const dbModule = await import('../db.js')
    vi.spyOn(dbModule, 'revokeToken').mockResolvedValue(undefined)
    vi.spyOn(dbModule, 'insertAuditLog').mockResolvedValue(undefined)
    const pool = createMockPool()
    const originalConnect = pool.connect
    let offlineReleases = 0
    pool.connect = vi.fn(async () => {
      const client = await originalConnect()
      let offlineTransaction = false
      return {
        query: vi.fn(async (sql: string, params?: any[]) => {
          if (sql.includes("set_config('statement_timeout'")) offlineTransaction = true
          if (sql.includes("UPDATE daemons SET status = 'offline'")) {
            throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })
          }
          return client.query(sql, params)
        }),
        release: vi.fn(() => {
          if (offlineTransaction) offlineReleases++
          client.release()
        }),
      }
    })
    const router = new Router(pool)
    const oldWs = createMockWs()
    await router.registerDaemon(oldWs, {
      type: 'register', daemon_id: 'daemon-1', hostname: 'old', agents: [], started_at: 100,
    }, 7, 'old-token')

    const kick = router.handleForceKick('daemon-1', 7)
    const replacementWs = createMockWs()
    const replacement = router.registerDaemon(replacementWs, {
      type: 'register', daemon_id: 'daemon-1', hostname: 'replacement', agents: [], started_at: 200,
    }, 7, 'new-token')
    const deadline = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('offline CAS held registration lock')), 100))

    await expect(Promise.race([kick, deadline])).resolves.toEqual({ success: true })
    await expect(Promise.race([replacement, deadline])).resolves.toBe(true)
    expect(replacementWs._sent).toContainEqual(expect.objectContaining({ type: 'register_ack' }))
    expect((router as any).daemons.get('daemon-1').ws).toBe(replacementWs)
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(offlineReleases).toBe(3)
    vi.restoreAllMocks()
  })

  test('late force-kick offline completion cannot remove or close a replacement generation', async () => {
    const dbModule = await import('../db.js')
    vi.spyOn(dbModule, 'revokeToken').mockResolvedValue(undefined)
    vi.spyOn(dbModule, 'insertAuditLog').mockResolvedValue(undefined)
    let finishOffline!: (value: boolean) => void
    vi.spyOn(dbModule, 'setDaemonOfflineWithTimeout').mockImplementationOnce(() => new Promise<boolean>((resolve) => { finishOffline = resolve }))
    const router = new Router(createMockPool())
    await router.registerDaemon(createMockWs(), {
      type: 'register', daemon_id: 'daemon-1', hostname: 'old', agents: [], started_at: 100,
    }, 7, 'old-token')

    await expect(router.handleForceKick('daemon-1', 7)).resolves.toEqual({ success: true })
    const replacementWs = createMockWs()
    await expect(router.registerDaemon(replacementWs, {
      type: 'register', daemon_id: 'daemon-1', hostname: 'replacement', agents: [], started_at: 200,
    }, 7, 'new-token')).resolves.toBe(true)
    finishOffline(true)
    await Promise.resolve()

    expect((router as any).daemons.get('daemon-1').ws).toBe(replacementWs)
    expect(replacementWs.close).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  test('contains detached force-kick offline rejection and stops after finite attempts', async () => {
    const dbModule = await import('../db.js')
    vi.spyOn(dbModule, 'revokeToken').mockResolvedValue(undefined)
    vi.spyOn(dbModule, 'insertAuditLog').mockResolvedValue(undefined)
    const offline = vi.spyOn(dbModule, 'setDaemonOfflineWithTimeout').mockRejectedValue(new Error('offline database down'))
    const router = new Router(createMockPool())
    await router.registerDaemon(createMockWs(), {
      type: 'register', daemon_id: 'daemon-1', hostname: 'old', agents: [], started_at: 100,
    }, 7, 'old-token')

    await expect(router.handleForceKick('daemon-1', 7)).resolves.toEqual({ success: true })
    await vi.waitFor(() => {
      expect(offline).toHaveBeenCalledTimes(3)
    }, { timeout: 1_000 })
    vi.restoreAllMocks()
  })
})

describe('Router - shutdown connections', () => {
  let pool: any
  let router: Router
  beforeEach(() => { pool = createMockPool(); router = new Router(pool) })

  test('terminateAllConnections terminates every daemon and client socket', async () => {
    const daemonWs = createMockWs()
    await router.registerDaemon(daemonWs, { type: 'register', daemon_id: 'd1', hostname: 'h', agents: [] }, 1)
    const clientWs = createMockWs()
    router.registerClient(clientWs, 1)

    router.terminateAllConnections()

    expect(daemonWs.terminate).toHaveBeenCalledTimes(1)
    expect(clientWs.terminate).toHaveBeenCalledTimes(1)
  })

  test('broadcastRelayRestarting notifies clients too', () => {
    const clientWs = createMockWs()
    router.registerClient(clientWs, 1)

    router.broadcastRelayRestarting()

    expect(clientWs._sent.find((m: any) => m.type === 'relay_restarting')).toBeDefined()
  })
})

describe('Router - list_daemons restart grace', () => {
  let pool: any
  let router: Router
  beforeEach(() => { pool = createMockPool(); router = new Router(pool) })

  test('DB-online daemon not in memory is optimistic online within startup grace', async () => {
    pool.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM daemons')) {
        return { rows: [{ daemon_id: 'd-db', hostname: 'host-db', agents: [], alias: null, status: 'online', last_heartbeat: new Date().toISOString(), user_id: 1 }] }
      }
      return { rows: [], rowCount: 0 }
    })
    const clientWs = createMockWs()
    await (router as any).handleListDaemons(clientWs, 1)
    const list = clientWs._sent.find((m: any) => m.type === 'daemon_list')
    expect(list.daemons).toHaveLength(1)
    expect(list.daemons[0].daemon_online).toBe(true)
    expect(list.daemons[0].status).toBe('online')
  })

  test('DB-online daemon not in memory goes offline after startup grace elapses', async () => {
    process.env.RELAY_LIST_GRACE_MS = '0'
    const router2 = new Router(pool)
    pool.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM daemons')) {
        return { rows: [{ daemon_id: 'd-db', hostname: 'host-db', agents: [], alias: null, status: 'online', last_heartbeat: new Date().toISOString(), user_id: 1 }] }
      }
      return { rows: [], rowCount: 0 }
    })
    const clientWs = createMockWs()
    await (router2 as any).handleListDaemons(clientWs, 1)
    const list = clientWs._sent.find((m: any) => m.type === 'daemon_list')
    expect(list.daemons[0].daemon_online).toBe(false)
    expect(list.daemons[0].status).toBe('offline')
    delete process.env.RELAY_LIST_GRACE_MS
  })
})

// C1: title generation must never reach the LLM provider during tests.
vi.mock('../title.js', () => ({
  generateTitle: vi.fn(async () => 'Mocked Title'),
  generateSubagentTitle: vi.fn(async () => 'Mocked Subagent Title'),
}))
import { generateTitle, generateSubagentTitle } from '../title.js'

describe('Router - daemon session ownership enforcement', () => {
  const ATTACKER_DAEMON = 'daemon-attacker'
  const ATTACKER_USER = 2

  /** createMockPool plus a daemon-session ownership probe answer map. */
  function createOwnershipPool(
    sessions: Record<string, { user_id?: number | null; daemon_id?: string | null }>,
  ) {
    const pool = createMockPool()
    const original = pool.query
    pool.query = vi.fn(async (sql: string, params?: any[]) => {
      if (sql.includes('session_allowed')) {
        // Mirror the SQL rule: params are [sessionId, userId, daemonId].
        const row = sessions[params?.[0] ?? '']
        const userId = params?.[1] ?? null
        const daemonId = String(params?.[2] ?? '')
        const allowed = row
          ? userId !== null
            ? row.user_id === userId || (row.user_id == null && row.daemon_id === daemonId)
            : row.user_id == null && row.daemon_id === daemonId
          : false
        return { rows: [{ session_exists: Boolean(row), session_allowed: allowed }], rowCount: 1 }
      }
      return original(sql, params)
    })
    return pool
  }

  function victimPool() {
    return createOwnershipPool({
      'victim-session': { user_id: 1, daemon_id: 'daemon-victim' },
      'attacker-session': { user_id: ATTACKER_USER, daemon_id: ATTACKER_DAEMON },
    })
  }

  async function registerAttacker(router: Router) {
    const attackerWs = createMockWs()
    await router.registerDaemon(attackerWs, {
      type: 'register', daemon_id: ATTACKER_DAEMON, hostname: 'attacker-host', agents: [], started_at: 17,
    }, ATTACKER_USER)
    attackerWs._sent.length = 0
    return attackerWs
  }

  function subscribeVictimClient(router: Router) {
    const clientWs = createMockWs()
    router.registerClient(clientWs, 1)
    router.handleClientMessage(clientWs, { type: 'set_locale', session_id: 'victim-session', locale: 'zh' })
    clientWs._sent.length = 0
    return clientWs
  }

  test('attacker daemon cannot inject canonical events into a foreign session', async () => {
    const pool = victimPool()
    const router = new Router(pool)
    await registerAttacker(router)

    router.handleDaemonMessage(ATTACKER_DAEMON, {
      type: 'agent_text', session_id: 'victim-session', text: 'injected', seq: 1,
    })
    await tick()

    const injected = pool._queries.filter((q: any) => q.sql.includes('INSERT INTO events'))
    expect(injected).toHaveLength(0)
  })

  test('attacker daemon cannot take over routing of a foreign session', async () => {
    const pool = victimPool()
    const router = new Router(pool)
    const attackerWs = await registerAttacker(router)
    const victimClient = subscribeVictimClient(router)
    ;(router as any).sessionToDaemon.set('victim-session', 'daemon-victim')

    for (const payload of [
      { type: 'session_created', session_id: 'victim-session', title: 'Hijacked' },
      { type: 'session_discovered', session_id: 'victim-session', agent: 'codex' },
      { type: 'session_status', session_id: 'victim-session', status: 'completed' },
      { type: 'subagent_discovered', session_id: 'victim-session', agent: 'codex', agent_id: 'child' },
    ]) {
      router.handleDaemonMessage(ATTACKER_DAEMON, payload)
      await tick()
    }

    expect((router as any).sessionToDaemon.get('victim-session')).toBe('daemon-victim')
    const client = (router as any).clients.get(victimClient)
    expect(client.subscribedSessions.has('victim-session')).toBe(true)
    expect(victimClient._sent.filter((m: any) => m.type === 'session_status')).toHaveLength(0)
    expect(attackerWs._sent).not.toContainEqual(expect.objectContaining({ type: 'event_ack', up_to_seq: 0 }))
  })

  test('attacker session_id_changed cannot move a foreign session or its subscribers', async () => {
    const pool = victimPool()
    const router = new Router(pool)
    await registerAttacker(router)
    const victimClient = subscribeVictimClient(router)
    ;(router as any).sessionToDaemon.set('victim-session', 'daemon-victim')
    ;(router as any).pendingOriginClient.set('victim-session', victimClient)

    router.handleDaemonMessage(ATTACKER_DAEMON, {
      type: 'session_id_changed', session_id: 'attacker-new-id', old_session_id: 'victim-session', seq: 1,
    })
    await tick()

    expect((router as any).sessionToDaemon.get('victim-session')).toBe('daemon-victim')
    expect((router as any).sessionToDaemon.has('attacker-new-id')).toBe(false)
    expect((router as any).pendingOriginClient.get('victim-session')).toBe(victimClient)
    expect((router as any).pendingOriginClient.has('attacker-new-id')).toBe(false)
    const client = (router as any).clients.get(victimClient)
    expect(client.subscribedSessions.has('victim-session')).toBe(true)
    expect(client.subscribedSessions.has('attacker-new-id')).toBe(false)
    const moved = pool._queries.filter((q: any) =>
      q.sql.startsWith('UPDATE sessions') && q.sql.includes('session_id = $1'))
    expect(moved).toHaveLength(0)
  })

  test('attacker session_title_update cannot mutate a foreign title and does not stall the ACK spool', async () => {
    const pool = victimPool()
    const router = new Router(pool)
    const attackerWs = await registerAttacker(router)

    router.handleDaemonMessage(ATTACKER_DAEMON, {
      type: 'session_title_update', session_id: 'victim-session', title: 'Hijacked Title', seq: 1,
    })
    await tick()

    const titleUpdate = pool._queries.filter((q: any) =>
      q.sql.includes('UPDATE sessions SET title'))
    expect(titleUpdate).toHaveLength(0)
    router.handleDaemonMessage(ATTACKER_DAEMON, { type: 'ping' })
    expect(attackerWs._sent).toContainEqual(expect.objectContaining({ type: 'event_ack', up_to_seq: 1 }))
  })

  test('attacker generate_title_request never reaches title generation or the title row', async () => {
    const pool = victimPool()
    const router = new Router(pool)
    await registerAttacker(router)

    router.handleDaemonMessage(ATTACKER_DAEMON, {
      type: 'generate_title_request', session_id: 'victim-session',
      user_message: 'hi', assistant_message: 'there', seq: 1,
    })
    await tick()

    expect(vi.mocked(generateTitle)).not.toHaveBeenCalled()
    const titleUpdate = pool._queries.filter((q: any) => q.sql.includes('UPDATE sessions SET title'))
    expect(titleUpdate).toHaveLength(0)
    vi.mocked(generateTitle).mockClear()
  })

  test('attacker generate_subagent_title_request never reaches subagent title generation', async () => {
    const pool = victimPool()
    const router = new Router(pool)
    await registerAttacker(router)
    // A default-titled subagent row exists, so the vulnerable path would run
    // the full generate → update sequence for the foreign victim session.
    const hasDefault = vi.spyOn(db, 'hasDefaultSubagentTitle').mockResolvedValue(true)
    const update = vi.spyOn(db, 'updateSubagentTitleIfDefault').mockResolvedValue(true)

    router.handleDaemonMessage(ATTACKER_DAEMON, {
      type: 'generate_subagent_title_request', session_id: 'victim-session',
      agent_id: 'child', user_message: 'hi', seq: 1,
    })
    await tick()

    expect(vi.mocked(generateSubagentTitle)).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
    hasDefault.mockRestore()
    update.mockRestore()
    vi.mocked(generateSubagentTitle).mockClear()
  })

  test('an inline ownership rejection does not poison the daemon ACK spool', async () => {
    const pool = victimPool()
    const router = new Router(pool)
    const attackerWs = await registerAttacker(router)

    router.handleDaemonMessage(ATTACKER_DAEMON, {
      type: 'agent_text', session_id: 'victim-session', text: 'rejected', seq: 1,
    })
    await tick()
    router.handleDaemonMessage(ATTACKER_DAEMON, {
      type: 'agent_text', session_id: 'attacker-session', text: 'legitimate', seq: 2,
    })
    await tick()
    router.handleDaemonMessage(ATTACKER_DAEMON, { type: 'ping' })

    expect(attackerWs._sent).toContainEqual(expect.objectContaining({ type: 'event_ack', up_to_seq: 2 }))
    const injected = pool._queries.filter((q: any) =>
      q.sql.includes('INSERT INTO events') && q.params[0] === 'victim-session')
    expect(injected).toHaveLength(0)
    const legitimate = pool._queries.filter((q: any) =>
      q.sql.includes('INSERT INTO events') && q.params[0] === 'attacker-session')
    expect(legitimate).toHaveLength(1)
  })

  test('an inline ownership rejection policy-closes the attacker connection without leaking target metadata', async () => {
    const pool = victimPool()
    const router = new Router(pool)
    const attackerWs = await registerAttacker(router)

    router.handleDaemonMessage(ATTACKER_DAEMON, {
      type: 'agent_text', session_id: 'victim-session', text: 'rejected', seq: 1,
    })
    await tick()

    expect(attackerWs.close).toHaveBeenCalled()
    const kicked = attackerWs._sent.find((m: any) => m.type === 'kicked' || m.type === 'disconnect')
    expect(kicked).toBeDefined()
    expect(JSON.stringify(kicked)).not.toContain('victim-session')
    expect(JSON.stringify(kicked)).not.toContain('daemon-victim')
  })
})

describe('Router - legacy null-user identity fail-closed (H-3)', () => {
  test('registerDaemon with userId=null rejects without owner lookup or activation', async () => {
    const pool = createMockPool()
    const router = new Router(pool)
    const ws = createMockWs()

    const registered = await router.registerDaemon(ws, {
      type: 'register', daemon_id: 'legacy-daemon', hostname: 'h', agents: [], started_at: 1,
    }, null)

    expect(registered).toBe(false)
    const rejection = ws._sent.find((m: any) => m.type === 'register_rejected')
    expect(rejection?.reason).toBe('auth_required')
    expect(ws.close).toHaveBeenCalledWith(4001, expect.any(String))
    // No owner recovery, no quota probe, no activation: the only observable
    // effect is the rejection itself.
    const observed = pool._queries.map((q: any) => q.sql).join('\n')
    expect(observed).not.toContain('FROM daemons')
    expect((router as any).daemons.has('legacy-daemon')).toBe(false)
  })

  test('list_sessions from a null-user client fails closed without a global query', async () => {
    const pool = createMockPool()
    const router = new Router(pool)
    const clientWs = createMockWs()
    router.registerClient(clientWs, null)

    await router.handleClientMessage(clientWs, { type: 'list_sessions' })

    const reply = clientWs._sent.at(-1)
    expect(reply?.type).toBe('error')
    // The unfiltered session enumeration query must never run.
    const observed = pool._queries.map((q: any) => q.sql).join('\n')
    expect(observed).not.toContain('FROM sessions')
    expect(JSON.stringify(clientWs._sent)).not.toContain('test-sid')
  })

  test('a null-user list_sessions with daemon_id also fails closed', async () => {
    const pool = createMockPool()
    const router = new Router(pool)
    const clientWs = createMockWs()
    router.registerClient(clientWs, null)

    await router.handleClientMessage(clientWs, { type: 'list_sessions', daemon_id: 'daemon-1' })

    const reply = clientWs._sent.at(-1)
    expect(reply?.type).toBe('error')
  })
})
