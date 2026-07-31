import { describe, expect, test, vi } from 'vitest'
import { EventMaterializer } from '../materialization/event-materializer.js'
import type { MaterializationInput } from '../materialization/types.js'
import { agentEventContracts } from './fixtures/agent-event-contracts.js'
import * as db from '../db.js'

function inputFor(payload: Record<string, unknown>): MaterializationInput {
  return {
    inboxId: 7,
    userId: 42,
    daemonId: 'daemon-1',
    sessionId: typeof payload.session_id === 'string' ? payload.session_id : null,
    eventType: String(payload.type),
    payload,
    context: {
      agentType: 'codex',
      cwd: '/repo',
      requestId: typeof payload.request_id === 'string' ? payload.request_id : undefined,
      hostname: 'host-1',
    },
  }
}

function pools() {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('INSERT INTO events')) return { rows: [{ id: 91, inserted: true, effect_status: 'pending', effect_step: 0 }], rowCount: 1 }
    if (sql.includes('SELECT effect_status')) return { rows: [{ effect_status: 'pending', effect_step: 0 }], rowCount: 1 }
    return { rows: [], rowCount: 1 }
  })
  return { query }
}

describe('EventMaterializer', () => {
  test.each(agentEventContracts)('preserves $agent $name payload in a deterministic delivery', async ({ payload }) => {
    const materializer = new EventMaterializer({ pool: pools() as never })

    const result = await materializer.materialize(inputFor(payload))

    expect(result.deliveries).toEqual([expect.objectContaining({
      eventId: 91,
      userId: 42,
      audience: 'session',
      sessionId: payload.session_id ?? null,
      requestId: 'request_id' in payload ? payload.request_id : null,
      ordinal: 0,
      deliveryKey: `event:91:session:${'request_id' in payload ? payload.request_id : '-'}:0`,
      type: payload.type,
      payload,
    })])
  })

  test('completed ledger rows skip effects but still return their delivery for outbox recovery', async () => {
    const apply = vi.fn()
    const materializer = new EventMaterializer({
      pool: { query: vi.fn(async (sql: string) => {
        if (sql.includes('INSERT INTO events')) return { rows: [{ id: 99, inserted: false, effect_status: 'completed', effect_step: 3 }], rowCount: 1 }
        return { rows: [], rowCount: 1 }
      }) } as never,
    })
    const payload = { type: 'agent_text', session_id: 'ses-1', usage: { input_tokens: 3 } }

    const result = await materializer.materialize(inputFor(payload), apply)

    expect(apply).not.toHaveBeenCalled()
    expect(result).toMatchObject({ eventId: 99, completed: true, deliveries: [{ payload }] })
  })

  test('keeps effect application and ledger finalization as separate crash-safe phases', async () => {
    const apply = vi.fn(async (effect: { step: (fn: () => void) => Promise<void> }) => {
      await effect.step(() => undefined)
    })
    const pool = pools()
    const materializer = new EventMaterializer({ pool: pool as never })

    const result = await materializer.materialize(
      inputFor({ type: 'agent_text', session_id: 'ses-1' }),
      apply,
      { deferEffects: true },
    )
    await result.applyEffects?.()

    expect(apply).toHaveBeenCalledOnce()
    expect(pool.query).not.toHaveBeenCalledWith(expect.stringContaining('effect_status = \'completed\''), [91])
    await result.finalizeEffect?.()
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('effect_status = \'completed\''), [91])
  })

  test('checks the active claim before every effect step and stops later mutations after lease loss', async () => {
    const firstMutation = vi.fn()
    const secondMutation = vi.fn()
    const assertClaim = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('claim lost'))
    const materializer = new EventMaterializer({ pool: pools() as never })

    await expect(materializer.materialize(
      inputFor({ type: 'agent_text', session_id: 'ses-1' }),
      async (effect) => {
        await effect.step(firstMutation)
        await effect.step(secondMutation)
      },
      { assertClaim },
    )).rejects.toThrow('claim lost')

    expect(firstMutation).toHaveBeenCalledOnce()
    expect(secondMutation).not.toHaveBeenCalled()
  })

  test('does not create a delivery for an unknown session_status', async () => {
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('INSERT INTO events')) return { rows: [{ id: 32, inserted: true, effect_status: 'pending', effect_step: 0 }], rowCount: 1 }
        if (sql.includes('SELECT effect_status')) return { rows: [{ effect_status: 'pending', effect_step: 0 }], rowCount: 1 }
        if (sql.includes('UPDATE sessions')) return { rows: [], rowCount: 0 }
        return { rows: [], rowCount: 1 }
      }),
    }
    const materializer = new EventMaterializer({ pool: pool as never })

    const result = await materializer.materialize(inputFor({ type: 'session_status', session_id: 'missing', status: 'busy' }))

    expect(result.deliveries).toEqual([])
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE sessions'), expect.any(Array))
  })

  test('keeps an unknown session_status suppressed after the session later appears', async () => {
    let sessionExists = false
    let effectStatus = 'pending'
    let effectStep = 0
    let decisionWrites = 0
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('INSERT INTO events')) {
          return {
            rows: [{ id: 44, inserted: effectStatus === 'pending' && effectStep === 0, effect_status: effectStatus, effect_step: effectStep }],
            rowCount: 1,
          }
        }
        if (sql.includes('session_status_decision')) {
          decisionWrites++
          effectStep = sessionExists ? 1 : 1_000_000_000
          return { rows: [{ session_exists: sessionExists, suppressed: !sessionExists }], rowCount: 1 }
        }
        if (sql.includes("effect_status = 'completed'")) {
          effectStatus = 'completed'
          return { rows: [], rowCount: 1 }
        }
        if (sql.includes('SELECT effect_status')) {
          return { rows: [{ effect_status: effectStatus, effect_step: effectStep }], rowCount: 1 }
        }
        return { rows: [], rowCount: 1 }
      }),
    }
    const materializer = new EventMaterializer({ pool: pool as never })
    const input = inputFor({ type: 'session_status', session_id: 'late', status: 'busy' })

    expect((await materializer.materialize(input)).deliveries).toEqual([])
    sessionExists = true
    expect((await materializer.materialize(input)).deliveries).toEqual([])
    expect(decisionWrites).toBe(1)
  })

  test('keeps suppression stable when the process crashes after recording the decision', async () => {
    let effectStep = 0
    let failCompletion = true
    let sessionExists = false
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('INSERT INTO events')) {
          return { rows: [{ id: 45, inserted: effectStep === 0, effect_status: 'pending', effect_step: effectStep }], rowCount: 1 }
        }
        if (sql.includes('session_status_decision')) {
          effectStep = sessionExists ? 1 : 1_000_000_000
          return { rows: [{ session_exists: sessionExists, suppressed: !sessionExists }], rowCount: 1 }
        }
        if (sql.includes("effect_status = 'completed'")) {
          if (failCompletion) {
            failCompletion = false
            throw new Error('crash before completion')
          }
          return { rows: [], rowCount: 1 }
        }
        if (sql.includes('SELECT effect_status')) {
          return { rows: [{ effect_status: 'pending', effect_step: effectStep }], rowCount: 1 }
        }
        return { rows: [], rowCount: 1 }
      }),
    }
    const materializer = new EventMaterializer({ pool: pool as never })
    const input = inputFor({ type: 'session_status', session_id: 'late', status: 'busy' })

    await expect(materializer.materialize(input)).rejects.toThrow('crash before completion')
    sessionExists = true
    expect((await materializer.materialize(input)).deliveries).toEqual([])
  })

  test('returns the same non-zero event id after completion is retried', async () => {
    let completed = false
    let inserted = true
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('INSERT INTO events')) {
          const row = { id: 73, inserted, effect_status: completed ? 'completed' : 'pending', effect_step: 0 }
          inserted = false
          return { rows: [row], rowCount: 1 }
        }
        if (sql.includes('SELECT effect_status')) {
          return { rows: [{ effect_status: completed ? 'completed' : 'pending', effect_step: 0 }], rowCount: 1 }
        }
        if (sql.includes("effect_status = 'completed'")) {
          completed = true
          return { rows: [], rowCount: 1 }
        }
        return { rows: [], rowCount: 1 }
      }),
    }
    const materializer = new EventMaterializer({ pool: pool as never })
    const input = inputFor({ type: 'agent_text', session_id: 'ses-1', text: 'same' })

    const first = await materializer.materialize(input)
    const replay = await materializer.materialize(input)

    expect(first.eventId).toBe(73)
    expect(replay.eventId).toBe(73)
    expect(replay.deliveries[0]?.eventId).toBe(73)
  })

  test('routes subagent usage through the legacy child usage ledger without parent delivery', async () => {
    const usage = vi.spyOn(db, 'recordSubagentUsageInTransaction').mockResolvedValue(true)
    const pool = pools()
    const materializer = new EventMaterializer({ pool: pool as never })

    const result = await materializer.materialize(inputFor({
      type: 'subagent_usage', session_id: 'root', agent_id: 'child', event_id: 'turn-1', seq: 9,
      usage: { input_tokens: 2, output_tokens: 3, cache_read_tokens: 4, cache_create_tokens: 5 },
    }))

    expect(usage).toHaveBeenCalledWith(pool, {
      daemonId: 'daemon-1', seq: 9, eventId: 'turn-1', parentSessionId: 'root', agentId: 'child',
      inputTokens: 2, outputTokens: 3, cacheRead: 4, cacheCreate: 5,
    })
    expect(result.deliveries).toEqual([])
    expect(pool.query).not.toHaveBeenCalledWith(expect.stringContaining('incrementSessionTokensForEvent'), expect.anything())
    usage.mockRestore()
  })

  test('reuses the session-fence PoolClient for subagent usage', async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('INSERT INTO subagent_usage_seen')) {
          return { rows: [{ usage_hash: 'hash' }], rowCount: 1 }
        }
        return { rows: [], rowCount: 1 }
      }),
      connect: vi.fn().mockRejectedValue(new Error('Client has already been connected. You cannot reuse a client.')),
      release: vi.fn(),
    }
    const pool = { connect: vi.fn().mockResolvedValue(client), query: vi.fn() }
    const materializer = new EventMaterializer({ pool: pool as never })

    await expect(materializer.materialize(inputFor({
      type: 'subagent_usage',
      session_id: 'root',
      agent_id: 'child',
      event_id: 'jsonl:source:3:0:usage',
      seq: 9,
      usage: { input_tokens: 2, output_tokens: 3, cache_read_tokens: 4, cache_create_tokens: 5 },
    }))).resolves.toMatchObject({ completed: true })

    expect(client.connect).not.toHaveBeenCalled()
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      expect.stringContaining('pg_advisory_xact_lock'),
      expect.stringContaining('deleted_sessions'),
      expect.stringContaining('INSERT INTO subagent_usage_seen'),
      expect.stringContaining('INSERT INTO subagents'),
      'COMMIT',
    ])
    expect(client.release).toHaveBeenCalledOnce()
  })

  test('rejects title generation from the durable materializer', async () => {
    const pool = pools()
    const materializer = new EventMaterializer({ pool: pool as never })

    await expect(materializer.materialize(inputFor({
      type: 'generate_title_request', session_id: 'ses-1',
      user_message: 'hello', assistant_message: 'world',
    }))).rejects.toMatchObject({ name: 'EphemeralMaterializationError' })
    expect(pool.query).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO events'), expect.anything())
  })

  test('uses stable collision-free inbox identities for retried non-event deliveries', async () => {
    const materializer = new EventMaterializer({ pool: pools() as never })
    const interaction = inputFor({
      type: 'interaction_result',
      session_id: 'ses-1',
      request_id: 'req-1',
      operation: 'approval_response',
    })

    const first = await materializer.materialize(interaction)
    const retry = await materializer.materialize(interaction)
    const otherInbox = await materializer.materialize({ ...interaction, inboxId: 8 })

    expect(first.deliveries[0]).toMatchObject({
      eventId: null,
      deliveryKey: 'inbox:7:interaction-origin:req-1:0',
    })
    expect(retry.deliveries[0]?.deliveryKey).toBe(first.deliveries[0]?.deliveryKey)
    expect(otherInbox.deliveries[0]).toMatchObject({
      eventId: null,
      deliveryKey: 'inbox:8:interaction-origin:req-1:0',
    })
    expect(new Set([
      first.deliveries[0]?.deliveryKey,
      otherInbox.deliveries[0]?.deliveryKey,
    ]).size).toBe(2)
  })

  test('rejects title updates from the durable materializer', async () => {
    const updatePool = { query: vi.fn() }
    const materializer = new EventMaterializer({ pool: updatePool as never })
    await expect(materializer.materialize(inputFor({
      type: 'session_title_update', session_id: 'ses-1', title: 'Recovered title',
    }))).rejects.toMatchObject({ name: 'EphemeralMaterializationError' })
    expect(updatePool.query).not.toHaveBeenCalled()
  })

  test('materializes session lifecycle mutations before returning owner delivery', async () => {
    const bindSession = vi.fn()
    const releasePendingOperation = vi.fn()
    const pool = pools()
    const upsert = vi.spyOn(db, 'upsertSession').mockResolvedValue(undefined)
    const materializer = new EventMaterializer({
      pool: pool as never,
      hooks: { bindSession, releasePendingOperation },
      durableHooks: {
        releaseQuotaReservation: vi.fn(),
        notifyUser: vi.fn(),
        notifyProUser: vi.fn(),
      },
    })

    const result = await materializer.materialize(inputFor({
      type: 'session_created', session_id: 'ses-new', request_id: 'req-1',
      title: 'Created', model: 'gpt-5', control_mode: 'managed', capabilities: ['approval'],
    }))

    expect(upsert).toHaveBeenCalledWith(
      pool, 'ses-new', 'daemon-1', 'codex', '/repo', 'running', 'Created', 'daemon',
      undefined, 42, 'gpt-5', 'managed', ['approval'],
    )
    expect(bindSession).toHaveBeenCalledWith('ses-new', 'daemon-1')
    expect(releasePendingOperation).toHaveBeenCalledWith('daemon-1', 'req-1')
    expect(result.deliveries[0]).toMatchObject({ audience: 'user', payload: expect.objectContaining({ type: 'session_created' }) })
    upsert.mockRestore()
  })

  test('rechecks a session tombstone before materialization and emits no delivery', async () => {
    const pool = pools()
    const deleted = vi.spyOn(db, 'isSessionDeleted').mockResolvedValue(true)
    const upsert = vi.spyOn(db, 'upsertSession').mockResolvedValue(undefined)
    const materializer = new EventMaterializer({ pool: pool as never })

    const result = await materializer.materialize(inputFor({
      type: 'session_created',
      session_id: 'deleted-session',
      request_id: 'request-deleted',
    }))

    expect(result).toMatchObject({ eventId: 91, completed: true, deliveries: [] })
    expect(upsert).not.toHaveBeenCalled()
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("effect_status = 'completed'"),
      [91],
    )
    upsert.mockRestore()
    deleted.mockRestore()
  })

  test('fresh worker materializes session creation from persisted context and durable hooks', async () => {
    const releaseQuotaReservation = vi.fn().mockResolvedValue(undefined)
    const pool = pools()
    const upsert = vi.spyOn(db, 'upsertSession').mockResolvedValue(undefined)
    const materializer = new EventMaterializer({
      pool: pool as never,
      durableHooks: {
        releaseQuotaReservation,
        notifyUser: vi.fn(),
        notifyProUser: vi.fn(),
      },
    })
    const input = inputFor({
      type: 'session_created', session_id: 'ses-restarted', request_id: 'req-restarted',
    })
    input.context = {
      agentType: 'opencode', cwd: '/persisted', requestId: 'req-restarted',
      reservationId: 'reservation-restarted', hostname: 'persisted-host',
    }

    const result = await materializer.materialize(input)

    expect(upsert).toHaveBeenCalledWith(
      pool, 'ses-restarted', 'daemon-1', 'opencode', '/persisted', 'running',
      undefined, 'daemon', undefined, 42, undefined, undefined, undefined,
    )
    expect(releaseQuotaReservation).toHaveBeenCalledWith('reservation-restarted')
    expect(result.deliveries[0]?.payload).toEqual(expect.objectContaining({
      request_id: 'req-restarted',
      reservation_id: 'reservation-restarted',
      hostname: 'persisted-host',
    }))
    upsert.mockRestore()
  })

  test('fails safely instead of completing session creation without required context', async () => {
    const pool = pools()
    const upsert = vi.spyOn(db, 'upsertSession').mockResolvedValue(undefined)
    const materializer = new EventMaterializer({ pool: pool as never })
    const input = inputFor({ type: 'session_created', session_id: 'ses-missing-context' })
    input.context = {}

    await expect(materializer.materialize(input)).rejects.toMatchObject({
      name: 'MaterializationContextError',
    })
    expect(upsert).not.toHaveBeenCalled()
    upsert.mockRestore()
  })

  test('materializes approval push and keeps the native decision payload unchanged', async () => {
    const notifyUser = vi.fn().mockResolvedValue(undefined)
    const pool = pools()
    const payload = {
      type: 'approval_request', session_id: 'ses-1', request_id: 'approval-1',
      approval_kind: 'tool', tool: 'Bash', input: { command: 'git status' },
      available_decisions: ['once', 'reject'],
    }
    const materializer = new EventMaterializer({
      pool: pool as never,
      hooks: { shouldPush: () => true },
      durableHooks: {
        releaseQuotaReservation: vi.fn(),
        notifyUser,
        notifyProUser: vi.fn(),
      },
    })

    const result = await materializer.materialize(inputFor(payload))

    expect(notifyUser).toHaveBeenCalledWith(42, expect.objectContaining({
      data: expect.objectContaining({ session_id: 'ses-1', request_id: 'approval-1' }),
    }))
    expect(result.deliveries[0]?.payload).toEqual(payload)
  })

  test('materializes Codex subagent relation without changing parent/root delivery fields', async () => {
    const reconcile = vi.spyOn(db, 'reconcileSubagent').mockResolvedValue(undefined)
    const bindSession = vi.fn()
    const pool = pools()
    const payload = {
      type: 'subagent_discovered', session_id: 'thr_parent', agent: 'codex',
      agent_id: 'thr_child', parent_session_id: 'thr_parent', root_session_id: 'thr_root',
      call_id: 'call-1', subagent_type: 'explorer',
    }
    const materializer = new EventMaterializer({ pool: pool as never, hooks: { bindSession } } as never)

    const result = await materializer.materialize(inputFor(payload))

    expect(reconcile).toHaveBeenCalledWith(pool, {
      parentSessionId: 'thr_parent', agentId: 'thr_child', rootSessionId: 'thr_root',
      kind: 'codex_subagent', toolUseId: 'call-1', agentType: 'explorer', title: undefined,
    })
    expect(result.deliveries[0]?.payload).toEqual(payload)
    bindSession.mockRestore()
    reconcile.mockRestore()
  })
})
