import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest'
import pg from 'pg'

vi.mock('../quota.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../quota.js')>()
  return {
    ...actual,
    reserveConcurrentSession: vi.fn(async () => ({
      allowed: true,
      reservationId: 'unexpected-observer-reservation',
      expiresAt: Date.now() + 60_000,
      reused: false,
    })),
  }
})

import { Router } from '../router.js'
import { EventMaterializer } from '../materialization/event-materializer.js'
import { reserveConcurrentSession } from '../quota.js'
import * as db from '../db.js'
import { createPostgresExtensionJournalSink } from '../extensions/journal.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const postgresIntegrationEnabled = Boolean(databaseUrl && process.env.RUN_POSTGRES_INTEGRATION === '1')
const describeWithPostgres = postgresIntegrationEnabled ? describe : describe.skip

interface SessionState {
  sessionId: string
  userId: number
  daemonId: string | null
  agentType: string
  source: string
  controlMode: string | null
  capabilities: string[]
  status: string
  totalTokens: number
  inputTokens: number
  outputTokens: number
  pinned: boolean
  deleted: boolean
}

interface SessionPoolControls {
  beforeObserverUpsert?: () => Promise<void>
  initialEffectStep?: number
  eventInserted?: boolean
  sessionExists?: boolean
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const nextTurn = () => new Promise((resolve) => setTimeout(resolve, 0))

function socket(): any {
  const sent: any[] = []
  return {
    readyState: 1,
    OPEN: 1,
    send: vi.fn((raw: string) => sent.push(JSON.parse(raw))),
    close: vi.fn(),
    terminate: vi.fn(),
    _sent: sent,
  }
}

function sessionPool(
  initial: Partial<SessionState> = {},
  controls: SessionPoolControls = {},
): any {
  const state: SessionState = {
    sessionId: 'desktop-session',
    userId: 7,
    daemonId: 'd1',
    agentType: 'codex-desktop',
    source: 'observer',
    controlMode: 'legacy_read_only',
    capabilities: ['history_sync'],
    status: 'exited',
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    pinned: false,
    deleted: false,
    ...initial,
  }
  const queries: Array<{ sql: string; params: any[] }> = []
  const fenceTails = new Map<string, Promise<void>>()
  let eventId = 40
  let effectStep = controls.initialEffectStep ?? 0
  let sessionExists = controls.sessionExists ?? true
  const acquireFence = async (sessionId: string): Promise<() => void> => {
    const previous = fenceTails.get(sessionId) ?? Promise.resolve()
    let releaseCurrent!: () => void
    const current = new Promise<void>((resolve) => { releaseCurrent = resolve })
    const tail = previous.then(() => current)
    fenceTails.set(sessionId, tail)
    await previous
    return () => {
      releaseCurrent()
      if (fenceTails.get(sessionId) === tail) fenceTails.delete(sessionId)
    }
  }
  const value: any = {
    state,
    queries,
    query: vi.fn(async (sql: string, params: any[] = []) => {
      queries.push({ sql, params })
      if (sql.includes('WITH owned_session')) {
        const owned = sessionExists && !state.deleted
          && params[0] === state.sessionId && params[1] === state.userId
        return {
          rows: owned ? [{
            daemon_id: state.daemonId,
            agent_type: state.agentType,
            source: state.source,
            control_mode: state.controlMode,
            capabilities: [...state.capabilities],
            status: state.status,
          }] : [],
          rowCount: owned ? 1 : 0,
        }
      }
      if (sql.includes('session_allowed')) {
        const exists = sessionExists && !state.deleted && params[0] === state.sessionId
        const allowed = exists && params[1] === state.userId && params[2] === state.daemonId
        return { rows: [{ session_exists: exists, session_allowed: allowed }], rowCount: 1 }
      }
      if (sql.includes('INSERT INTO events')) {
        eventId += 1
        return {
          rows: [{
            id: eventId,
            inserted: controls.eventInserted ?? true,
            effect_status: 'pending',
            effect_step: effectStep,
          }],
          rowCount: 1,
        }
      }
      if (sql.includes('SELECT effect_status')) {
        return { rows: [{ effect_status: 'pending', effect_step: effectStep }], rowCount: 1 }
      }
      if (sql.includes('WITH session_target AS') && sql.includes('session_update AS')) {
        const targetExists = sessionExists && !state.deleted && params[7] === state.sessionId
        const nextStep = Number(params[1] ?? 0)
        const claimed = targetExists && effectStep < nextStep
        if (claimed) {
          effectStep = nextStep
          state.totalTokens += Number(params[2] ?? 0)
          state.inputTokens += Number(params[3] ?? 0)
          state.outputTokens += Number(params[4] ?? 0)
        }
        return {
          rows: [{ session_exists: targetExists, claimed, applied: claimed }],
          rowCount: 1,
        }
      }
      if (sql.includes('UPDATE events SET effect_step')) {
        effectStep = Math.max(effectStep, Number(params[1] ?? 0))
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes('INSERT INTO sessions') && sql.includes('RETURNING session_id')) {
        const sameOwner = params[0] === state.sessionId && params[8] === state.userId
        if (!sameOwner) return { rows: [], rowCount: 0 }
        if (params[2] === 'codex-desktop') await controls.beforeObserverUpsert?.()
        state.daemonId = params[1]
        state.agentType = params[2]
        state.source = params[5]
        state.status = params[6]
        state.controlMode = params[10]
        state.capabilities = JSON.parse(params[11] ?? '[]')
        sessionExists = true
        return { rows: [{ session_id: state.sessionId }], rowCount: 1 }
      }
      if (sql.includes('UPDATE sessions SET control_mode = $1')) {
        if (params[2] === state.sessionId) {
          state.controlMode = params[0]
          state.capabilities = JSON.parse(params[1] ?? '[]')
          return { rows: [], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      }
      if (sql.includes('SELECT 1 FROM sessions')) {
        const owned = sessionExists && !state.deleted
          && params[0] === state.sessionId && params[1] === state.userId
        return { rows: owned ? [{ ok: 1 }] : [], rowCount: owned ? 1 : 0 }
      }
      if (sql.includes('SELECT daemon_id FROM sessions')) {
        const found = sessionExists && !state.deleted && params[0] === state.sessionId
        return { rows: found ? [{ daemon_id: state.daemonId }] : [], rowCount: found ? 1 : 0 }
      }
      if (sql.includes('SELECT status FROM sessions')) {
        return { rows: [{ status: state.status }], rowCount: 1 }
      }
      if (sql.includes('SELECT status, turn_started_at, last_activity_at FROM sessions')) {
        return { rows: [{ status: state.status, turn_started_at: null, last_activity_at: null }], rowCount: 1 }
      }
      if (sql.includes('SELECT s.session_id') && sql.includes('FROM sessions s')) {
        return {
          rows: state.deleted || !sessionExists ? [] : [{
            session_id: state.sessionId,
            user_id: state.userId,
            daemon_id: state.daemonId,
            agent_type: state.agentType,
            cwd: '/repo',
            title: 'Desktop observer',
            source: state.source,
            status: state.status,
            control_mode: state.controlMode,
            capabilities: [...state.capabilities],
            pinned: state.pinned,
            created_at: '2026-09-04T00:00:00.000Z',
            updated_at: '2026-09-04T00:00:00.000Z',
          }],
          rowCount: state.deleted || !sessionExists ? 0 : 1,
        }
      }
      if (sql.includes('FROM subagents')) return { rows: [], rowCount: 0 }
      if (sql.includes('FROM events')) return { rows: [], rowCount: 0 }
      if (sql.includes('SET pinned =')) {
        const owned = !state.deleted && params[1] === state.sessionId && params[2] === state.userId
        if (owned) state.pinned = params[0]
        return { rows: [], rowCount: owned ? 1 : 0 }
      }
      if (sql.includes('SELECT user_id FROM sessions')) {
        const found = sessionExists && !state.deleted
        return { rows: found ? [{ user_id: state.userId }] : [], rowCount: found ? 1 : 0 }
      }
      if (sql.includes('DELETE FROM sessions WHERE session_id = $1')) {
        state.deleted = true
        sessionExists = false
        return { rows: [], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    }),
  }
  value.connect = vi.fn(async () => {
    let releaseFence: (() => void) | undefined
    const closeFence = () => {
      releaseFence?.()
      releaseFence = undefined
    }
    return {
      query: async (sql: string, params: any[] = []) => {
        if (sql === 'BEGIN') return { rows: [], rowCount: 0 }
        if (sql.includes('pg_advisory_xact_lock')) {
          releaseFence = await acquireFence(String(params[1]))
          return { rows: [], rowCount: 1 }
        }
        if (sql === 'COMMIT' || sql === 'ROLLBACK') {
          closeFence()
          return { rows: [], rowCount: 0 }
        }
        return value.query(sql, params)
      },
      release: vi.fn(closeFence),
    }
  })
  return value
}

function routerFixture(
  initial: Partial<SessionState> = {},
  controls: SessionPoolControls = {},
) {
  const pool = sessionPool(initial, controls)
  const router = new Router(pool, { extensionJournalSink: null })
  const daemon = socket()
  const client = socket()
  ;(router as any).daemons.set('d1', {
    ws: daemon, daemonId: 'd1', hostname: 'host', agents: [], userId: 7,
    registrationId: 'registration-1', startedAt: 1,
  })
  ;(router as any).sessionToDaemon.set(pool.state.sessionId, 'd1')
  router.registerClient(client, 7)
  return { pool, router, daemon, client }
}

function reclassifyAsDesktopObserver(
  materializer: EventMaterializer,
  inboxId: number,
  options: { deferEffects?: boolean } = {},
) {
  return materializer.materialize({
    inboxId, userId: 7, daemonId: 'd1', sessionId: 'desktop-session',
    eventType: 'session_discovered',
    payload: {
      type: 'session_discovered', session_id: 'desktop-session', agent: 'codex-desktop',
      source: 'terminal', control_mode: 'managed', capabilities: ['message_acceptance_receipt'],
      status: 'idle', cwd: '/repo',
    },
  }, undefined, options)
}

describe('Codex Desktop observer Relay boundary', () => {
  beforeEach(() => vi.clearAllMocks())

  test.each(['codex-desktop', 'zcode'])('rejects %s create before quota, pending state, or daemon send', async (agent) => {
    const { router, daemon, client } = routerFixture()

    await router.handleClientMessage(client, {
      type: 'session_create', daemon_id: 'd1', agent, cwd: '/repo', request_id: `create-${agent}`,
    })

    expect(reserveConcurrentSession).not.toHaveBeenCalled()
    expect((router as any).pendingSessionOperations.size).toBe(0)
    expect((router as any).pendingSessionCreate.size).toBe(0)
    expect(daemon._sent).toEqual([])
    expect(client._sent).toContainEqual(expect.objectContaining({
      type: 'session_create_failed', request_id: `create-${agent}`,
      reason: 'observer_read_only', retryable: false,
    }))
  })

  test('generates observer create rejection correlation when Web/iOS omits request_id', async () => {
    const { router, daemon, client } = routerFixture()

    await router.handleClientMessage(client, {
      type: 'session_create', daemon_id: 'd1', agent: 'codex-desktop', cwd: '/repo',
    })

    expect(client._sent).toContainEqual(expect.objectContaining({
      type: 'session_create_failed',
      request_id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      reason: 'observer_read_only', retryable: false,
    }))
    expect(reserveConcurrentSession).not.toHaveBeenCalled()
    expect(daemon._sent).toEqual([])
  })

  test.each(['future-agent', 'Codex', 'codex-preview'])(
    'rejects unsupported create agent %s before daemon selection, quota, tracking, or send',
    async (agent) => {
      const { router, daemon, client } = routerFixture()

      await router.handleClientMessage(client, {
        type: 'session_create', daemon_id: 'd1', agent, cwd: '/repo', request_id: `create-${agent}`,
      })

      expect(reserveConcurrentSession).not.toHaveBeenCalled()
      expect((router as any).pendingSessionOperations.size).toBe(0)
      expect((router as any).pendingSessionCreate.size).toBe(0)
      expect(daemon._sent).toEqual([])
      expect(client._sent).toContainEqual(expect.objectContaining({
        type: 'session_create_failed', request_id: `create-${agent}`,
        reason: 'unsupported_agent', retryable: false,
      }))
    },
  )

  test.each(['claude-code', 'codex', 'opencode', ''])(
    'keeps create-capable and empty legacy agent %j routable',
    async (agent) => {
      const { router, daemon, client } = routerFixture()

      await router.handleClientMessage(client, {
        type: 'session_create', daemon_id: 'd1', agent, cwd: '/repo', request_id: `create-${agent || 'legacy'}`,
      })

      expect(reserveConcurrentSession).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        agentType: agent || 'claude-code',
      }))
      expect((router as any).pendingSessionOperations.size).toBe(1)
      expect(daemon._sent).toContainEqual(expect.objectContaining({
        type: 'session_create', request_id: `create-${agent || 'legacy'}`,
      }))
      expect(client._sent).not.toContainEqual(expect.objectContaining({
        type: 'session_create_failed', request_id: `create-${agent || 'legacy'}`,
      }))
    },
  )

  test('rejects every native drive command with correlation and no quota, tracking, or socket effects', async () => {
    const { router, daemon, client } = routerFixture()
    const driveTypes = [
      'user_message',
      'abort_create',
      'session_kill',
      'session_interrupt',
      'set_permission_config',
      'set_effort',
      'set_session_agent',
      'approval_response',
      'question_response',
      'question_reject',
      'mcp_elicitation_response',
      'interactive_response',
    ]

    for (const type of driveTypes) {
      const requestId = `request-${type}`
      const before = client._sent.length
      await router.handleClientMessage(client, {
        type,
        session_id: 'desktop-session',
        request_id: requestId,
        msg_id: type === 'user_message' ? 'observer-message' : undefined,
        content: type === 'user_message' ? 'must not resume' : undefined,
      })
      expect(client._sent).toHaveLength(before + 1)
      if (type === 'user_message') {
        expect(client._sent.at(-1)).toMatchObject({
          type: 'user_message_nack', session_id: 'desktop-session', request_id: requestId,
          msg_id: 'observer-message', reason: 'observer_read_only', retryable: false,
        })
      } else {
        expect(client._sent.at(-1)).toMatchObject({
          type: 'error', session_id: 'desktop-session', request_id: requestId,
          operation: type, code: 'observer_read_only',
        })
      }
    }

    expect(reserveConcurrentSession).not.toHaveBeenCalled()
    expect((router as any).pendingSessionOperations.size).toBe(0)
    expect((router as any).pendingInteractionClients.size).toBe(0)
    expect((router as any).clients.get(client).subscribedSessions.size).toBe(0)
    expect(daemon._sent).toEqual([])
  })

  test('keeps replay, list queries, pin, and Relay-only delete usable without native writes', async () => {
    const { pool, router, daemon, client } = routerFixture({ status: 'idle' })

    await router.handleClientMessage(client, {
      type: 'replay', session_id: 'desktop-session', last_seq: 0, req_id: 9,
    })
    await vi.waitFor(() => {
      expect(client._sent.find((message: any) => message.type === 'replay_end')).toMatchObject({
        type: 'replay_end', session_id: 'desktop-session', req_id: 9,
      })
    })

    await router.handleClientMessage(client, { type: 'list_sessions' })
    await vi.waitFor(() => expect(client._sent).toContainEqual(expect.objectContaining({
      type: 'session_list', sessions: [expect.objectContaining({ session_id: 'desktop-session' })],
    })))

    for (const type of ['list_commands', 'list_session_agents', 'get_session_meta']) {
      await router.handleClientMessage(client, { type, session_id: 'desktop-session' })
    }
    expect(daemon._sent.map((message: any) => message.type)).toEqual([
      'list_commands', 'list_session_agents', 'get_session_meta',
    ])
    daemon._sent.length = 0

    await router.handleClientMessage(client, {
      type: 'session_pin', session_id: 'desktop-session', pinned: true,
    })
    await vi.waitFor(() => expect(pool.state.pinned).toBe(true))
    expect(client._sent).toContainEqual({
      type: 'session_pinned', session_id: 'desktop-session', pinned: true,
    })
    expect(daemon._sent).toEqual([])

    await router.handleClientMessage(client, { type: 'session_delete', session_id: 'desktop-session' })
    await vi.waitFor(() => expect(pool.state.deleted).toBe(true))
    expect(client._sent).toContainEqual({ type: 'session_deleted', session_id: 'desktop-session' })
    expect(daemon._sent).toEqual([])
  })

  test('reclassifies one owned session in place and does not expose observer policy to another user', async () => {
    const { pool, router, daemon, client } = routerFixture({
      agentType: 'codex', source: 'terminal', controlMode: 'managed',
      capabilities: ['shared_runtime'], status: 'running',
    })
    await router.handleClientMessage(client, {
      type: 'session_interrupt', session_id: 'desktop-session', request_id: 'before-reclassification',
    })
    expect(daemon._sent).toContainEqual(expect.objectContaining({
      type: 'session_interrupt', request_id: 'before-reclassification',
    }))
    daemon._sent.length = 0

    const materializer = new EventMaterializer({
      pool,
      extensionJournalSink: null,
    })
    await materializer.materialize({
      inboxId: 81,
      userId: 7,
      daemonId: 'd1',
      sessionId: 'desktop-session',
      eventType: 'session_discovered',
      payload: {
        type: 'session_discovered', session_id: 'desktop-session', agent: 'codex-desktop',
        source: 'terminal', control_mode: 'managed', capabilities: ['message_acceptance_receipt'],
        status: 'idle', cwd: '/repo',
      },
    })

    expect(pool.state).toMatchObject({
      sessionId: 'desktop-session', userId: 7, agentType: 'codex-desktop',
      source: 'observer', controlMode: 'legacy_read_only', capabilities: ['history_sync'],
    })

    const foreign = socket()
    router.registerClient(foreign, 8)
    await router.handleClientMessage(foreign, {
      type: 'session_kill', session_id: 'desktop-session', request_id: 'foreign-kill',
    })
    expect(foreign._sent).toContainEqual(expect.objectContaining({
      type: 'error', session_id: 'desktop-session', error: 'session not found or not owned',
    }))
    expect(JSON.stringify(foreign._sent)).not.toContain('observer_read_only')

    await router.handleClientMessage(client, {
      type: 'session_kill', session_id: 'desktop-session', request_id: 'owner-kill',
    })
    expect(client._sent).toContainEqual(expect.objectContaining({
      type: 'error', session_id: 'desktop-session', request_id: 'owner-kill',
      operation: 'session_kill', code: 'observer_read_only',
    }))
    expect(daemon._sent).toEqual([])
  })

  test('normalizes discovery delivery and prevents later forged session_meta from restoring write capability', async () => {
    const { pool } = routerFixture({
      agentType: 'codex', source: 'terminal', controlMode: 'managed',
      capabilities: ['shared_runtime'], status: 'running',
    })
    const materializer = new EventMaterializer({ pool, extensionJournalSink: null })

    const discovered = await materializer.materialize({
      inboxId: 91, userId: 7, daemonId: 'd1', sessionId: 'desktop-session',
      eventType: 'session_discovered',
      payload: {
        type: 'session_discovered', session_id: 'desktop-session', agent: 'codex-desktop',
        source: 'terminal', control_mode: 'managed',
        capabilities: ['shared_runtime', 'message_acceptance_receipt'], status: 'idle', cwd: '/repo',
      },
    })

    expect(discovered.deliveries[0].payload).toMatchObject({
      source: 'observer', control_mode: 'legacy_read_only', capabilities: ['history_sync'],
    })
    expect(pool.state).toMatchObject({
      agentType: 'codex-desktop', source: 'observer', controlMode: 'legacy_read_only',
      capabilities: ['history_sync'],
    })

    const metadata = await materializer.materialize({
      inboxId: 92, userId: 7, daemonId: 'd1', sessionId: 'desktop-session',
      eventType: 'session_meta',
      payload: {
        type: 'session_meta', session_id: 'desktop-session', request_id: 'forged-meta',
        control_mode: 'managed', capabilities: ['shared_runtime', 'message_acceptance_receipt'],
      },
    })

    expect(metadata.deliveries[0].payload).toMatchObject({
      control_mode: 'legacy_read_only', capabilities: ['history_sync'],
    })
    expect(pool.state).toMatchObject({
      agentType: 'codex-desktop', source: 'observer', controlMode: 'legacy_read_only',
      capabilities: ['history_sync'],
    })
  })

  test('lets committed observer classification win before an exited message can reserve or route', async () => {
    const upsertEntered = deferred()
    const allowUpsert = deferred()
    let blocked = false
    const { pool, router, daemon, client } = routerFixture({
      agentType: 'codex', source: 'terminal', controlMode: 'managed',
      capabilities: ['shared_runtime'], status: 'exited',
    }, {
      beforeObserverUpsert: async () => {
        if (blocked) return
        blocked = true
        upsertEntered.resolve()
        await allowUpsert.promise
      },
    })
    const materializer = new EventMaterializer({ pool, extensionJournalSink: null })
    const classification = reclassifyAsDesktopObserver(materializer, 101)
    await upsertEntered.promise
    vi.mocked(reserveConcurrentSession).mockClear()

    const routed = router.handleClientMessage(client, {
      type: 'user_message', session_id: 'desktop-session', request_id: 'classification-wins',
      msg_id: 'classification-wins-message', content: 'must not resume',
    })
    await nextTurn()
    allowUpsert.resolve()
    await Promise.all([classification, routed])

    expect(reserveConcurrentSession).not.toHaveBeenCalled()
    expect((router as any).pendingSessionOperations.size).toBe(0)
    expect((router as any).pendingInteractionClients.size).toBe(0)
    expect((router as any).clients.get(client).subscribedSessions.size).toBe(0)
    expect(daemon._sent).toEqual([])
    expect(client._sent).toContainEqual(expect.objectContaining({
      type: 'user_message_nack', request_id: 'classification-wins',
      reason: 'observer_read_only', retryable: false,
    }))
  })

  test('commits legacy deferred observer classification before routing can see stale managed policy', async () => {
    const { pool, router, daemon, client } = routerFixture({
      agentType: 'codex', source: 'terminal', controlMode: 'managed',
      capabilities: ['shared_runtime'], status: 'exited',
    })
    const materializer = new EventMaterializer({ pool, extensionJournalSink: null })

    const classification = await reclassifyAsDesktopObserver(materializer, 104, {
      deferEffects: true,
    })
    vi.mocked(reserveConcurrentSession).mockClear()
    await router.handleClientMessage(client, {
      type: 'user_message', session_id: 'desktop-session', request_id: 'legacy-deferred',
      msg_id: 'legacy-deferred-message', content: 'must not resume',
    })
    await classification.applyEffects?.()

    expect(pool.state.agentType).toBe('codex-desktop')
    expect(pool.queries.filter(({ sql, params }: any) => (
      sql.includes('INSERT INTO sessions') && params[2] === 'codex-desktop'
    ))).toHaveLength(1)
    expect(reserveConcurrentSession).not.toHaveBeenCalled()
    expect((router as any).pendingSessionOperations.size).toBe(0)
    expect((router as any).pendingInteractionClients.size).toBe(0)
    expect((router as any).clients.get(client).subscribedSessions.size).toBe(0)
    expect(daemon._sent).toEqual([])
    expect(client._sent).toContainEqual(expect.objectContaining({
      type: 'user_message_nack', request_id: 'legacy-deferred',
      reason: 'observer_read_only', retryable: false,
    }))
  })

  test('applies usage-bearing deferred observer discovery after the policy upsert', async () => {
    const { pool } = routerFixture({
      agentType: 'codex', source: 'terminal', controlMode: 'managed',
      capabilities: ['shared_runtime'], status: 'exited',
    })
    const broadcastQuota = vi.fn(async () => undefined)
    const materializer = new EventMaterializer({
      pool, extensionJournalSink: null, hooks: { broadcastQuota },
    })

    const result = await materializer.materialize({
      inboxId: 105, userId: 7, daemonId: 'd1', sessionId: 'desktop-session',
      eventType: 'session_discovered',
      payload: {
        type: 'session_discovered', session_id: 'desktop-session', agent: 'codex-desktop',
        source: 'terminal', control_mode: 'managed', capabilities: ['message_acceptance_receipt'],
        status: 'idle', cwd: '/repo', usage: { input_tokens: 3, output_tokens: 2 },
      },
    }, undefined, { deferEffects: true })
    expect(pool.state).toMatchObject({
      agentType: 'codex-desktop', source: 'observer', controlMode: 'legacy_read_only',
      capabilities: ['history_sync'], totalTokens: 5, inputTokens: 3, outputTokens: 2,
    })
    expect(broadcastQuota).not.toHaveBeenCalled()
    expect(result.deliveries[0].payload).toMatchObject({
      source: 'observer', control_mode: 'legacy_read_only', capabilities: ['history_sync'],
    })

    await result.applyEffects?.()

    expect(broadcastQuota).toHaveBeenCalledOnce()
    expect(broadcastQuota).toHaveBeenCalledWith(7)
    const usageIndex = pool.queries.findIndex(({ sql }: any) => sql.includes('WITH session_target AS'))
    const observerUpsertIndexes = pool.queries
      .map(({ sql, params }: any, index: number) => (
        sql.includes('INSERT INTO sessions') && params[2] === 'codex-desktop' ? index : -1
      ))
      .filter((index: number) => index >= 0)
    expect(usageIndex).toBeGreaterThanOrEqual(0)
    expect(observerUpsertIndexes).toHaveLength(1)
    expect(observerUpsertIndexes[0]).toBeLessThan(usageIndex)
  })

  test('creates a missing observer session before applying its usage exactly once', async () => {
    const { pool } = routerFixture({
      agentType: 'codex', source: 'terminal', controlMode: 'managed',
      capabilities: ['shared_runtime'], status: 'exited',
    }, { sessionExists: false })
    const broadcastQuota = vi.fn(async () => undefined)
    const materializer = new EventMaterializer({
      pool, extensionJournalSink: null, hooks: { broadcastQuota },
    })

    const result = await materializer.materialize({
      inboxId: 107, userId: 7, daemonId: 'd1', sessionId: 'desktop-session',
      eventType: 'session_discovered',
      payload: {
        type: 'session_discovered', session_id: 'desktop-session', agent: 'codex-desktop',
        source: 'terminal', control_mode: 'managed', capabilities: ['message_acceptance_receipt'],
        status: 'idle', cwd: '/repo', usage: { input_tokens: 3, output_tokens: 2 },
      },
    }, undefined, { deferEffects: true })

    expect(pool.state).toMatchObject({
      agentType: 'codex-desktop', source: 'observer', controlMode: 'legacy_read_only',
      capabilities: ['history_sync'], totalTokens: 5, inputTokens: 3, outputTokens: 2,
    })
    expect(result.deliveries[0].payload).toMatchObject({
      source: 'observer', control_mode: 'legacy_read_only', capabilities: ['history_sync'],
    })
    expect(broadcastQuota).not.toHaveBeenCalled()

    await result.applyEffects?.()
    await result.applyEffects?.()

    expect(pool.state).toMatchObject({ totalTokens: 5, inputTokens: 3, outputTokens: 2 })
    expect(broadcastQuota).toHaveBeenCalledOnce()
    const observerUpsertIndex = pool.queries.findIndex(({ sql, params }: any) => (
      sql.includes('INSERT INTO sessions') && params[2] === 'codex-desktop'
    ))
    const usageIndex = pool.queries.findIndex(({ sql }: any) => sql.includes('WITH session_target AS'))
    expect(observerUpsertIndex).toBeGreaterThanOrEqual(0)
    expect(usageIndex).toBeGreaterThan(observerUpsertIndex)
  })

  test('keeps immediate observer discovery binding with policy-first usage ordering', async () => {
    const pool = sessionPool({
      agentType: 'codex', source: 'terminal', controlMode: 'managed',
      capabilities: ['shared_runtime'], status: 'exited',
    })
    const bindSession = vi.fn()
    const materializer = new EventMaterializer({
      pool, extensionJournalSink: null, hooks: { bindSession },
    })

    await materializer.materialize({
      inboxId: 109, userId: 7, daemonId: 'd1', sessionId: 'desktop-session',
      eventType: 'session_discovered',
      payload: {
        type: 'session_discovered', session_id: 'desktop-session', agent: 'codex-desktop',
        status: 'idle', cwd: '/repo', usage: { input_tokens: 3, output_tokens: 2 },
      },
    })

    expect(bindSession).toHaveBeenCalledOnce()
    expect(bindSession).toHaveBeenCalledWith('desktop-session', 'd1')
    expect(pool.state).toMatchObject({
      source: 'observer', controlMode: 'legacy_read_only', capabilities: ['history_sync'],
      totalTokens: 5, inputTokens: 3, outputTokens: 2,
    })
  })

  test('replays a Fix Round 1 usage observer at nextStep 1 without repeating its upsert', async () => {
    const { pool } = routerFixture({ status: 'idle' }, {
      initialEffectStep: 1,
      eventInserted: false,
    })
    const broadcastQuota = vi.fn(async () => undefined)
    const materializer = new EventMaterializer({
      pool, extensionJournalSink: null, hooks: { broadcastQuota },
    })

    const result = await materializer.materialize({
      inboxId: 108, userId: 7, daemonId: 'd1', sessionId: 'desktop-session',
      eventType: 'session_discovered',
      payload: {
        type: 'session_discovered', session_id: 'desktop-session', agent: 'codex-desktop',
        source: 'observer', control_mode: 'legacy_read_only', capabilities: ['history_sync'],
        status: 'idle', cwd: '/repo', usage: { input_tokens: 3, output_tokens: 2 },
      },
    }, undefined, { deferEffects: true })
    await result.applyEffects?.()
    await result.applyEffects?.()

    expect(pool.state).toMatchObject({ totalTokens: 5, inputTokens: 3, outputTokens: 2 })
    expect(pool.queries.filter(({ sql }: any) => sql.includes('WITH session_target AS'))).toHaveLength(1)
    expect(pool.queries.filter(({ sql, params }: any) => (
      sql.includes('INSERT INTO sessions') && params[2] === 'codex-desktop'
    ))).toHaveLength(0)
    expect(broadcastQuota).toHaveBeenCalledOnce()
  })

  test('resumes a pending observer discovery at nextStep 1 without repeating its recorded upsert', async () => {
    const { pool } = routerFixture({}, {
      initialEffectStep: 1,
      eventInserted: false,
    })
    const materializer = new EventMaterializer({ pool, extensionJournalSink: null })

    const result = await reclassifyAsDesktopObserver(materializer, 106, { deferEffects: true })
    await result.applyEffects?.()

    expect(pool.queries.filter(({ sql, params }: any) => (
      sql.includes('INSERT INTO sessions') && params[2] === 'codex-desktop'
    ))).toHaveLength(0)
    expect(pool.state).toMatchObject({
      agentType: 'codex-desktop', source: 'observer', controlMode: 'legacy_read_only',
      capabilities: ['history_sync'], totalTokens: 0,
    })
    expect(result.deliveries[0].payload).toMatchObject({
      source: 'observer', control_mode: 'legacy_read_only', capabilities: ['history_sync'],
    })
  })

  test('lets an already-fenced managed route finish before observer classification commits', async () => {
    const quotaEntered = deferred()
    const allowQuota = deferred<{
      allowed: true
      reservationId: string
      expiresAt: number
      reused: false
    }>()
    vi.mocked(reserveConcurrentSession).mockImplementationOnce(async () => {
      quotaEntered.resolve()
      return allowQuota.promise
    })
    const { pool, router, daemon, client } = routerFixture({
      agentType: 'codex', source: 'terminal', controlMode: 'managed',
      capabilities: ['shared_runtime'], status: 'exited',
    })
    const materializer = new EventMaterializer({ pool, extensionJournalSink: null })

    const routed = router.handleClientMessage(client, {
      type: 'user_message', session_id: 'desktop-session', request_id: 'route-wins',
      msg_id: 'route-wins-message', content: 'allowed before classification',
    })
    await quotaEntered.promise
    let classificationCompleted = false
    const classification = reclassifyAsDesktopObserver(materializer, 102)
      .then(() => { classificationCompleted = true })
    await nextTurn()

    expect(classificationCompleted).toBe(false)
    expect(pool.state.agentType).toBe('codex')

    allowQuota.resolve({
      allowed: true, reservationId: 'route-wins-reservation',
      expiresAt: Date.now() + 60_000, reused: false,
    })
    await Promise.all([routed, classification])

    expect(reserveConcurrentSession).toHaveBeenCalledTimes(1)
    expect(daemon._sent).toContainEqual(expect.objectContaining({
      type: 'user_message', request_id: 'route-wins',
    }))
    expect(pool.state.agentType).toBe('codex-desktop')
  })

  test('serializes Attention HTTP interaction routing behind observer classification', async () => {
    const upsertEntered = deferred()
    const allowUpsert = deferred()
    const { pool, router, daemon } = routerFixture({
      agentType: 'codex', source: 'terminal', controlMode: 'managed',
      capabilities: ['shared_runtime'], status: 'waiting',
    }, {
      beforeObserverUpsert: async () => {
        upsertEntered.resolve()
        await allowUpsert.promise
      },
    })
    const materializer = new EventMaterializer({ pool, extensionJournalSink: null })
    const classification = reclassifyAsDesktopObserver(materializer, 103)
    await upsertEntered.promise

    const routed = router.submitAttentionInboxInteraction(7, {
      type: 'approval_response', session_id: 'desktop-session',
      request_id: 'attention-race', action: 'once',
    })
    await nextTurn()
    allowUpsert.resolve()

    await expect(routed).resolves.toEqual({ accepted: false, code: 'observer_read_only' })
    await classification
    expect(daemon._sent).toEqual([])
  })

  test('does not serialize advisory fences for unrelated session ids', async () => {
    const pool = sessionPool()
    const firstEntered = deferred()
    const releaseFirst = deferred()
    const first = db.withSessionMaterializationFence(pool, 'session-a', async () => {
      firstEntered.resolve()
      await releaseFirst.promise
    })
    await firstEntered.promise

    let secondCompleted = false
    await db.withSessionMaterializationFence(pool, 'session-b', async () => {
      secondCompleted = true
    })

    expect(secondCompleted).toBe(true)
    releaseFirst.resolve()
    await first
  })

  test('releases the advisory fence after callback failure', async () => {
    const pool = sessionPool()
    await expect(db.withSessionMaterializationFence(pool, 'desktop-session', async () => {
      throw new Error('route failed')
    })).rejects.toThrow('route failed')

    await expect(db.withSessionMaterializationFence(
      pool, 'desktop-session', async () => 'released',
    )).resolves.toBe('released')
  })
})

describeWithPostgres('Codex Desktop observer cross-pool PostgreSQL fence', () => {
  const sessionId = 'task6-observer-fence-session'
  const daemonId = 'task6-observer-fence-daemon'
  const email = 'task6-observer-fence@example.test'
  let controlPool: pg.Pool
  let queryPool: pg.Pool
  let ingestPool: pg.Pool
  let workerPool: pg.Pool
  let userId: number

  afterAll(async () => {
    await Promise.all([
      controlPool?.end(), queryPool?.end(), ingestPool?.end(), workerPool?.end(),
    ])
  })

  beforeEach(async () => {
    controlPool ??= new pg.Pool({ connectionString: databaseUrl, max: 2 })
    queryPool ??= new pg.Pool({ connectionString: databaseUrl, max: 2 })
    ingestPool ??= new pg.Pool({ connectionString: databaseUrl, max: 2 })
    workerPool ??= new pg.Pool({ connectionString: databaseUrl, max: 2 })
    await db.initDB(controlPool)
    await controlPool.query('DELETE FROM extension_source_outbox WHERE session_id = $1', [sessionId])
    await controlPool.query('DELETE FROM events WHERE session_id = $1', [sessionId])
    await controlPool.query('DELETE FROM sessions WHERE session_id = $1', [sessionId])
    await controlPool.query('DELETE FROM daemons WHERE daemon_id = $1', [daemonId])
    await controlPool.query('DELETE FROM users WHERE email = $1', [email])
    const user = await controlPool.query<{ id: number }>(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
      [email, ''],
    )
    userId = user.rows[0].id
    await controlPool.query(
      `INSERT INTO daemons (daemon_id, user_id, hostname, status)
       VALUES ($1, $2, 'task6-host', 'online')`,
      [daemonId, userId],
    )
    await controlPool.query(
      `INSERT INTO sessions (
         session_id, daemon_id, user_id, agent_type, source,
         control_mode, capabilities, status
       ) VALUES ($1, $2, $3, 'codex', 'terminal', 'managed', '["shared_runtime"]'::jsonb, 'exited')`,
      [sessionId, daemonId, userId],
    )
    vi.mocked(reserveConcurrentSession).mockClear()
  }, 30_000)

  function localCommandRouter(extensionJournalSink: any = null) {
    const router = new Router({
      control: controlPool, query: queryPool, ingest: ingestPool, worker: workerPool,
    }, { extensionJournalSink })
    const daemon = socket()
    const origin = socket()
    const peer = socket()
    ;(router as any).daemons.set(daemonId, {
      ws: daemon, daemonId, hostname: 'task6-host', agents: [], userId,
      registrationId: 'task6-registration', startedAt: 1,
    })
    router.registerClient(origin, userId)
    router.registerClient(peer, userId)
    return { router, daemon, origin, peer }
  }

  const localCommand = (suffix: string) => ({
    type: 'local_command_log',
    session_id: sessionId,
    request_id: `local-${suffix}`,
    user_text: '/model',
    command: '/model',
    receipt_status: 'ok',
    message: 'gpt-5.6',
  })

  test('materializer classification wins before local command commit across process pools', async () => {
    const preservedActivity = new Date('2026-09-01T01:02:03.000Z')
    await controlPool.query(
      'UPDATE sessions SET last_activity_at = $2 WHERE session_id = $1',
      [sessionId, preservedActivity],
    )
    const classificationEntered = deferred()
    const allowClassification = deferred()
    let held = false
    const materializer = new EventMaterializer({ pool: workerPool, extensionJournalSink: null })
    const classification = materializer.materialize({
      inboxId: 0, userId, daemonId, sessionId, eventType: 'session_discovered',
      payload: {
        type: 'session_discovered', session_id: sessionId, agent: 'codex-desktop',
        source: 'terminal', control_mode: 'managed', capabilities: ['message_acceptance_receipt'],
        status: 'idle', cwd: '/repo', last_activity_at: preservedActivity.toISOString(),
        event_id: 'desktop-local-command-race-classification',
      },
    }, undefined, {
      deferEffects: true,
      assertClaim: async () => {
        if (held) return
        held = true
        classificationEntered.resolve()
        await allowClassification.promise
      },
    })
    await classificationEntered.promise

    const { router, origin, peer } = localCommandRouter()
    const routed = router.handleClientMessage(origin, localCommand('classification-wins'))
    await nextTurn()
    expect(peer._sent).toEqual([])
    expect((await queryPool.query(
      `SELECT COUNT(*)::int AS count FROM events
       WHERE session_id = $1 AND event_type IN ('user_text', 'command_receipt')`,
      [sessionId],
    )).rows[0].count).toBe(0)

    allowClassification.resolve()
    await Promise.all([classification, routed])

    expect((await queryPool.query(
      `SELECT agent_type, source, last_activity_at
       FROM sessions WHERE session_id = $1`,
      [sessionId],
    )).rows[0]).toMatchObject({
      agent_type: 'codex-desktop', source: 'observer', last_activity_at: preservedActivity,
    })
    expect((await queryPool.query(
      `SELECT COUNT(*)::int AS count FROM events
       WHERE session_id = $1 AND event_type IN ('user_text', 'command_receipt')`,
      [sessionId],
    )).rows[0].count).toBe(0)
    expect(origin._sent).toContainEqual(expect.objectContaining({
      type: 'error', session_id: sessionId, request_id: 'local-classification-wins',
      operation: 'local_command_log', code: 'observer_read_only', reason: 'observer_read_only',
    }))
    expect(peer._sent).toEqual([])
  }, 30_000)

  test('codex local command pair commits events, journals, activity, and broadcast together', async () => {
    const oldActivity = new Date('2026-09-01T02:03:04.000Z')
    await controlPool.query(
      'UPDATE sessions SET last_activity_at = $2 WHERE session_id = $1',
      [sessionId, oldActivity],
    )
    const { router, origin, peer } = localCommandRouter(createPostgresExtensionJournalSink())

    await router.handleClientMessage(origin, localCommand('commit'))

    expect((await queryPool.query(
      `SELECT event_type FROM events
       WHERE session_id = $1 AND event_type IN ('user_text', 'command_receipt') ORDER BY id`,
      [sessionId],
    )).rows.map(row => row.event_type)).toEqual(['user_text', 'command_receipt'])
    expect((await queryPool.query(
      'SELECT COUNT(*)::int AS count FROM extension_source_outbox WHERE session_id = $1',
      [sessionId],
    )).rows[0].count).toBe(2)
    expect((await queryPool.query(
      'SELECT last_activity_at FROM sessions WHERE session_id = $1', [sessionId],
    )).rows[0].last_activity_at.getTime()).toBeGreaterThan(oldActivity.getTime())
    expect(peer._sent).toEqual([
      expect.objectContaining({ type: 'user_text', session_id: sessionId }),
      expect.objectContaining({ type: 'command_receipt', session_id: sessionId }),
    ])
  })

  test('local command replay deduplicates rows, repairs journal, and does not advance activity', async () => {
    const { router, origin } = localCommandRouter(createPostgresExtensionJournalSink())
    await router.handleClientMessage(origin, localCommand('replay'))
    const before = (await queryPool.query(
      'SELECT last_activity_at FROM sessions WHERE session_id = $1', [sessionId],
    )).rows[0].last_activity_at as Date
    await controlPool.query(
      `DELETE FROM extension_source_outbox
       WHERE session_id = $1 AND event_type = 'command_receipt'`,
      [sessionId],
    )

    await router.handleClientMessage(origin, localCommand('replay'))

    expect((await queryPool.query(
      `SELECT COUNT(*)::int AS count FROM events
       WHERE session_id = $1 AND event_type IN ('user_text', 'command_receipt')`,
      [sessionId],
    )).rows[0].count).toBe(2)
    expect((await queryPool.query(
      'SELECT COUNT(*)::int AS count FROM extension_source_outbox WHERE session_id = $1',
      [sessionId],
    )).rows[0].count).toBe(2)
    expect((await queryPool.query(
      'SELECT last_activity_at FROM sessions WHERE session_id = $1', [sessionId],
    )).rows[0].last_activity_at).toEqual(before)
  })

  test('second journal failure rolls back the pair, activity, and broadcast', async () => {
    const oldActivity = new Date('2026-09-01T03:04:05.000Z')
    await controlPool.query(
      'UPDATE sessions SET last_activity_at = $2 WHERE session_id = $1',
      [sessionId, oldActivity],
    )
    const postgresSink = createPostgresExtensionJournalSink()
    const failingSink = {
      appendCanonicalEvent: async (client: any, input: any) => {
        await postgresSink.appendCanonicalEvent(client, input)
        if (input.eventType === 'command_receipt') throw new Error('second journal failure')
      },
    }
    const { router, origin, peer } = localCommandRouter(failingSink)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      await router.handleClientMessage(origin, localCommand('journal-failure'))
      await nextTurn()

      expect((await queryPool.query(
        `SELECT COUNT(*)::int AS count FROM events
         WHERE session_id = $1 AND event_type IN ('user_text', 'command_receipt')`,
        [sessionId],
      )).rows[0].count).toBe(0)
      expect((await queryPool.query(
        'SELECT COUNT(*)::int AS count FROM extension_source_outbox WHERE session_id = $1',
        [sessionId],
      )).rows[0].count).toBe(0)
      expect((await queryPool.query(
        'SELECT last_activity_at FROM sessions WHERE session_id = $1', [sessionId],
      )).rows[0].last_activity_at).toEqual(oldActivity)
      expect(peer._sent).toEqual([])
      expect(consoleError).toHaveBeenCalledWith(
        '[router] local_command_log persistence failed',
        expect.objectContaining({ errorName: 'Error' }),
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  test('commits usage and legacy deferred observer projection before returning the materialized result', async () => {
    const materializer = new EventMaterializer({ pool: workerPool, extensionJournalSink: null })
    const result = await materializer.materialize({
      inboxId: 0, userId, daemonId, sessionId, eventType: 'session_discovered',
      payload: {
        type: 'session_discovered', session_id: sessionId, agent: 'codex-desktop',
        source: 'terminal', control_mode: 'managed',
        capabilities: ['message_acceptance_receipt'], status: 'idle', cwd: '/repo',
        usage: { input_tokens: 3, output_tokens: 2 },
      },
    }, undefined, { deferEffects: true })

    expect((await queryPool.query(
      `SELECT agent_type, source, control_mode, capabilities,
              total_tokens::int AS total_tokens,
              tok_input::int AS tok_input,
              tok_output::int AS tok_output
       FROM sessions WHERE session_id = $1 AND user_id = $2`,
      [sessionId, userId],
    )).rows[0]).toEqual({
      agent_type: 'codex-desktop', source: 'observer', control_mode: 'legacy_read_only',
      capabilities: ['history_sync'], total_tokens: 5, tok_input: 3, tok_output: 2,
    })
    expect((await queryPool.query(
      'SELECT effect_step FROM events WHERE id = $1', [result.eventId],
    )).rows[0].effect_step).toBe(2)

    const router = new Router({
      control: controlPool, query: queryPool, ingest: ingestPool, worker: workerPool,
    }, { extensionJournalSink: null })
    const daemon = socket()
    const client = socket()
    ;(router as any).daemons.set(daemonId, {
      ws: daemon, daemonId, hostname: 'task6-host', agents: [], userId,
      registrationId: 'task6-registration', startedAt: 1,
    })
    router.registerClient(client, userId)
    await router.handleClientMessage(client, {
      type: 'user_message', session_id: sessionId, request_id: 'postgres-legacy-deferred',
      msg_id: 'postgres-legacy-deferred-message', content: 'must not resume',
    })
    await result.applyEffects?.()
    await result.finalizeEffect?.()

    expect((await queryPool.query(
      `SELECT total_tokens::int AS total_tokens,
              tok_input::int AS tok_input,
              tok_output::int AS tok_output
       FROM sessions WHERE session_id = $1 AND user_id = $2`,
      [sessionId, userId],
    )).rows[0]).toEqual({ total_tokens: 5, tok_input: 3, tok_output: 2 })
    expect(reserveConcurrentSession).not.toHaveBeenCalled()
    expect(daemon._sent).toEqual([])
    expect(client._sent).toContainEqual(expect.objectContaining({
      type: 'user_message_nack', request_id: 'postgres-legacy-deferred',
      reason: 'observer_read_only', retryable: false,
    }))
  })

  test('creates a missing PostgreSQL observer session before applying usage exactly once', async () => {
    await controlPool.query('DELETE FROM sessions WHERE session_id = $1', [sessionId])
    const broadcastQuota = vi.fn(async () => undefined)
    const materializer = new EventMaterializer({
      pool: workerPool, extensionJournalSink: null, hooks: { broadcastQuota },
    })

    const result = await materializer.materialize({
      inboxId: 0, userId, daemonId, sessionId, eventType: 'session_discovered',
      payload: {
        type: 'session_discovered', session_id: sessionId, agent: 'codex-desktop',
        source: 'terminal', control_mode: 'managed',
        capabilities: ['message_acceptance_receipt'], status: 'idle', cwd: '/repo',
        usage: { input_tokens: 3, output_tokens: 2 },
      },
    }, undefined, { deferEffects: true })

    expect((await queryPool.query(
      `SELECT agent_type, source, control_mode, capabilities,
              total_tokens::int AS total_tokens,
              tok_input::int AS tok_input,
              tok_output::int AS tok_output
       FROM sessions WHERE session_id = $1 AND user_id = $2`,
      [sessionId, userId],
    )).rows[0]).toEqual({
      agent_type: 'codex-desktop', source: 'observer', control_mode: 'legacy_read_only',
      capabilities: ['history_sync'], total_tokens: 5, tok_input: 3, tok_output: 2,
    })
    expect((await queryPool.query(
      'SELECT effect_step FROM events WHERE id = $1', [result.eventId],
    )).rows[0].effect_step).toBe(2)
    expect(result.deliveries[0].payload).toMatchObject({
      source: 'observer', control_mode: 'legacy_read_only', capabilities: ['history_sync'],
    })
    expect(broadcastQuota).not.toHaveBeenCalled()

    await result.applyEffects?.()
    await result.applyEffects?.()
    await result.finalizeEffect?.()

    expect((await queryPool.query(
      `SELECT total_tokens::int AS total_tokens,
              tok_input::int AS tok_input,
              tok_output::int AS tok_output
       FROM sessions WHERE session_id = $1 AND user_id = $2`,
      [sessionId, userId],
    )).rows[0]).toEqual({ total_tokens: 5, tok_input: 3, tok_output: 2 })
    expect(broadcastQuota).toHaveBeenCalledOnce()
  })

  test('replays a Fix Round 1 PostgreSQL usage observer without another upsert', async () => {
    const canonicalPayload = {
      type: 'session_discovered', session_id: sessionId, agent: 'codex-desktop',
      source: 'observer', control_mode: 'legacy_read_only',
      capabilities: ['history_sync'], status: 'idle', cwd: '/repo',
      usage: { input_tokens: 3, output_tokens: 2 },
    }
    const ledger = await db.persistEventWithEffect(
      controlPool, sessionId, 'session_discovered', canonicalPayload, 1, userId,
    )
    await controlPool.query('UPDATE events SET effect_step = 1 WHERE id = $1', [ledger.rowID])
    // Fix Round 1 already committed the discovery upsert at step 1. A later
    // status event makes any stale repeat of that upsert observable here.
    await controlPool.query(
      `UPDATE sessions
       SET agent_type = 'codex-desktop', source = 'observer',
           control_mode = 'legacy_read_only', capabilities = '["history_sync"]'::jsonb,
           status = 'waiting', cwd = '/repo', total_tokens = 0, tok_input = 0, tok_output = 0
       WHERE session_id = $1 AND user_id = $2`,
      [sessionId, userId],
    )
    const materializer = new EventMaterializer({ pool: workerPool, extensionJournalSink: null })

    const result = await materializer.materialize({
      inboxId: 0, userId, daemonId, sessionId, eventType: 'session_discovered',
      payload: {
        ...canonicalPayload,
        source: 'terminal', control_mode: 'managed',
        capabilities: ['message_acceptance_receipt'],
      },
    }, undefined, { deferEffects: true })
    expect(result.inserted).toBe(false)
    expect((await queryPool.query(
      `SELECT status, total_tokens::int AS total_tokens,
              tok_input::int AS tok_input, tok_output::int AS tok_output
       FROM sessions WHERE session_id = $1`,
      [sessionId],
    )).rows[0]).toEqual({
      status: 'waiting', total_tokens: 5, tok_input: 3, tok_output: 2,
    })
    expect((await queryPool.query(
      'SELECT effect_step FROM events WHERE id = $1', [result.eventId],
    )).rows[0].effect_step).toBe(2)

    await result.applyEffects?.()
    await result.applyEffects?.()
    await result.finalizeEffect?.()

    expect((await queryPool.query(
      `SELECT status, total_tokens::int AS total_tokens,
              tok_input::int AS tok_input, tok_output::int AS tok_output
       FROM sessions WHERE session_id = $1`,
      [sessionId],
    )).rows[0]).toEqual({
      status: 'waiting', total_tokens: 5, tok_input: 3, tok_output: 2,
    })
  })

  test('shares the committed-classification fence across independent API and worker pools', async () => {
    const classificationUpdated = deferred()
    const allowClassificationCommit = deferred()
    const classification = db.withSessionMaterializationFence(workerPool, sessionId, async (client) => {
      await client.query(
        `UPDATE sessions
         SET agent_type = 'codex-desktop', source = 'observer',
             control_mode = 'legacy_read_only', capabilities = '["history_sync"]'::jsonb
         WHERE session_id = $1 AND user_id = $2`,
        [sessionId, userId],
      )
      classificationUpdated.resolve()
      await allowClassificationCommit.promise
    })
    await classificationUpdated.promise

    const router = new Router({
      control: controlPool, query: queryPool, ingest: ingestPool, worker: workerPool,
    }, { extensionJournalSink: null })
    const daemon = socket()
    const client = socket()
    ;(router as any).daemons.set(daemonId, {
      ws: daemon, daemonId, hostname: 'task6-host', agents: [], userId,
      registrationId: 'task6-registration', startedAt: 1,
    })
    router.registerClient(client, userId)
    const routed = router.handleClientMessage(client, {
      type: 'user_message', session_id: sessionId, request_id: 'postgres-classification-wins',
      msg_id: 'postgres-observer-message', content: 'must not resume',
    })
    await nextTurn()
    const reserveCallsBeforeCommit = vi.mocked(reserveConcurrentSession).mock.calls.length
    const sendsBeforeCommit = daemon._sent.length
    allowClassificationCommit.resolve()
    await Promise.all([classification, routed])

    expect(reserveCallsBeforeCommit).toBe(0)
    expect(sendsBeforeCommit).toBe(0)
    expect(reserveConcurrentSession).not.toHaveBeenCalled()
    expect((router as any).pendingSessionOperations.size).toBe(0)
    expect((router as any).pendingInteractionClients.size).toBe(0)
    expect((router as any).clients.get(client).subscribedSessions.size).toBe(0)
    expect(daemon._sent).toEqual([])
    expect(client._sent).toContainEqual(expect.objectContaining({
      type: 'user_message_nack', request_id: 'postgres-classification-wins',
      reason: 'observer_read_only', retryable: false,
    }))
  })
})
