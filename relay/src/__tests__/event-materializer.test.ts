import { describe, expect, test, vi } from 'vitest'
import { EventMaterializer } from '../materialization/event-materializer.js'
import type { MaterializationInput } from '../materialization/types.js'
import { normalizeSessionId } from '../ingress/event-policy.js'
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
    if (sql.includes('session_allowed')) return { rows: [{ session_exists: true, session_allowed: true }], rowCount: 1 }
    return { rows: [], rowCount: 1 }
  })
  return { query }
}

describe('EventMaterializer', () => {
  test('passes server receipt time to the immutable fact writer only when explicitly enabled', async () => {
    const increment = vi.spyOn(db, 'incrementSessionTokensForEvent').mockResolvedValue(undefined)
    const receivedAt = new Date('2026-08-09T12:34:56.000Z')
    const materializer = new EventMaterializer({
      pool: pools() as never,
      writeTokenUsageFacts: true,
    })
    const input = {
      ...inputFor({ type: 'agent_text', session_id: 'ses-1', usage: { input_tokens: 3 } }),
      receivedAt,
    }

    await materializer.materialize(input)

    expect(increment).toHaveBeenCalledWith(
      expect.anything(), 91, 1, 'ses-1', { input_tokens: 3 },
      { writeFact: true, receivedAt, factKey: 'inbox:7' },
    )
    increment.mockRestore()
  })

  test('writes direct subagent agent_text usage as a fact without mutating parent session totals', async () => {
    const increment = vi.spyOn(db, 'incrementSessionTokensForEvent').mockResolvedValue(undefined)
    const fact = vi.spyOn(db, 'recordTokenUsageFactForEvent').mockResolvedValue(undefined)
    const receivedAt = new Date('2026-08-09T12:34:56.000Z')
    const materializer = new EventMaterializer({
      pool: pools() as never,
      writeTokenUsageFacts: true,
    })

    await materializer.materialize({
      ...inputFor({
        type: 'agent_text', session_id: 'root', agent_id: 'child-1', is_subagent: true,
        agent: 'codex', model: 'gpt-5', usage: { input_tokens: 7, output_tokens: 3 },
      }),
      receivedAt,
    })

    expect(increment).not.toHaveBeenCalled()
    expect(fact).toHaveBeenCalledWith(expect.anything(), 91, 1, {
      factKey: 'inbox:7', userId: 42, daemonId: 'daemon-1', sessionId: 'root',
      agentType: 'codex', model: 'gpt-5', receivedAt,
      usage: { input_tokens: 7, output_tokens: 3 },
    })
    fact.mockRestore()
    increment.mockRestore()
  })

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
    const fact = vi.spyOn(db, 'recordTokenUsageFactForEvent').mockResolvedValue(undefined)
    const pool = pools()
    const materializer = new EventMaterializer({ pool: pool as never, writeTokenUsageFacts: true })

    const result = await materializer.materialize(inputFor({
      type: 'subagent_usage', session_id: 'root', agent_id: 'child', event_id: 'turn-1', seq: 9,
      usage: { input_tokens: 2, output_tokens: 3, cache_read_tokens: 4, cache_create_tokens: 5 },
    }))

    expect(usage).toHaveBeenCalledWith(pool, {
      daemonId: 'daemon-1', seq: 9, eventId: 'turn-1', parentSessionId: 'root', agentId: 'child',
      inputTokens: 2, outputTokens: 3, cacheRead: 4, cacheCreate: 5,
    })
    expect(result.deliveries).toEqual([])
    expect(fact).not.toHaveBeenCalled()
    expect(pool.query).not.toHaveBeenCalledWith(expect.stringContaining('incrementSessionTokensForEvent'), expect.anything())
    fact.mockRestore()
    usage.mockRestore()
  })

  test('reuses the session-fence PoolClient for subagent usage', async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('INSERT INTO subagent_usage_seen')) {
          return { rows: [{ usage_hash: 'hash' }], rowCount: 1 }
        }
        if (sql.includes('session_allowed')) {
          return { rows: [{ session_exists: true, session_allowed: true }], rowCount: 1 }
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
      expect.stringContaining('session_allowed'),
      expect.stringContaining('INSERT INTO subagent_usage_seen'),
      expect.stringContaining('INSERT INTO subagents'),
      'COMMIT',
    ])
    expect(client.release).toHaveBeenCalledOnce()
  })

  test('reuses the session-fence PoolClient for subagent discovery', async () => {
    let relationApplied = false
    let ledgerCompleted = false
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('INSERT INTO events')) {
          return { rows: [{ id: 92, inserted: true, effect_status: 'pending', effect_step: 0 }], rowCount: 1 }
        }
        if (sql.includes('SELECT effect_status')) {
          return { rows: [{ effect_status: 'pending', effect_step: 0 }], rowCount: 1 }
        }
        if (sql.includes('INSERT INTO subagents')) relationApplied = true
        if (sql.includes("effect_status = 'completed'")) ledgerCompleted = true
        return { rows: [], rowCount: 1 }
      }),
      connect: vi.fn().mockRejectedValue(new Error('Client has already been connected. You cannot reuse a client.')),
      release: vi.fn(),
    }
    const pool = { connect: vi.fn().mockResolvedValue(client), query: vi.fn() }
    const materializer = new EventMaterializer({ pool: pool as never })

    await expect(materializer.materialize(inputFor({
      type: 'subagent_discovered',
      session_id: 'root',
      agent: 'codex',
      agent_id: 'child',
      root_session_id: 'root',
      call_id: 'call-1',
      subagent_type: 'explorer',
    }))).resolves.toMatchObject({ eventId: 92 })

    expect(client.connect).not.toHaveBeenCalled()
    expect(relationApplied).toBe(true)
    expect(ledgerCompleted).toBe(true)
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
    const reconcile = vi.spyOn(db, 'reconcileSubagentInTransaction').mockResolvedValue(undefined)
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

describe('zcode observer session source', () => {
  function materializerFor() {
    const pool = pools()
    const upsert = vi.spyOn(db, 'upsertSession').mockResolvedValue(undefined)
    const materializer = new EventMaterializer({ pool: pool as never })
    return { pool, upsert, materializer }
  }

  test('zcode observer session_discovered is recorded with source=observer', async () => {
    const { upsert, materializer } = materializerFor()
    await materializer.materialize(inputFor({
      type: 'session_discovered', session_id: 'zcode-wire1',
      agent: 'zcode', source: 'observer', control_mode: 'legacy_read_only',
      capabilities: ['history_sync'], status: 'completed', title: 't', model: 'm',
    }))
    // 8th positional arg (index 7) is source.
    const args = upsert.mock.calls[0]
    expect(args[7]).toBe('observer')
    expect(args[3]).toBe('zcode') // agentType
    upsert.mockRestore()
  })

  test('non-zcode agent forging source=observer is recorded as terminal', async () => {
    const { upsert, materializer } = materializerFor()
    await materializer.materialize(inputFor({
      type: 'session_discovered', session_id: 'ses1',
      agent: 'claude-code', source: 'observer', // forged
    }))
    expect(upsert.mock.calls[0][7]).toBe('terminal')
    upsert.mockRestore()
  })

  test('zcode without source=observer falls back to terminal', async () => {
    const { upsert, materializer } = materializerFor()
    await materializer.materialize(inputFor({
      type: 'session_discovered', session_id: 'ses2',
      agent: 'zcode', // missing source=observer
    }))
    expect(upsert.mock.calls[0][7]).toBe('terminal')
    upsert.mockRestore()
  })

  test('legacy daemon without source field is terminal', async () => {
    const { upsert, materializer } = materializerFor()
    await materializer.materialize(inputFor({
      type: 'session_discovered', session_id: 'ses3',
      agent: 'claude-code', // no source field
    }))
    expect(upsert.mock.calls[0][7]).toBe('terminal')
    upsert.mockRestore()
  })

  test('control_mode and capabilities persist for zcode observer', async () => {
    const { upsert, materializer } = materializerFor()
    await materializer.materialize(inputFor({
      type: 'session_discovered', session_id: 'zcode-wire2',
      agent: 'zcode', source: 'observer',
      control_mode: 'legacy_read_only', capabilities: ['history_sync'],
    }))
    const args = upsert.mock.calls[0]
    expect(args[11]).toBe('legacy_read_only') // controlMode (index 11)
    expect(args[12]).toEqual(['history_sync']) // capabilities (index 12)
    upsert.mockRestore()
  })
})

describe('EventMaterializer daemon session ownership', () => {
  const ATTACKER_USER = 43
  const ATTACKER_DAEMON = 'daemon-attacker'

  /** Session rows visible to the authorization probe, keyed by session id. */
  function ownershipPool(
    sessions: Record<string, { user_id?: number | null; daemon_id?: string | null }>,
  ) {
    const queries: { sql: string; params: any[] }[] = []
    const pool = {
      query: vi.fn(async (sql: string, params?: any[]) => {
        queries.push({ sql, params: params ?? [] })
        if (sql.includes('INSERT INTO events')) {
          return { rows: [{ id: 91, inserted: true, effect_status: 'pending', effect_step: 0 }], rowCount: 1 }
        }
        if (sql.includes('SELECT effect_status')) {
          return { rows: [{ effect_status: 'pending', effect_step: 0 }], rowCount: 1 }
        }
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
        if (sql.includes('INSERT INTO sessions')) {
          return { rows: [{ session_id: params?.[0] ?? null }], rowCount: 1 }
        }
        if (sql.includes('session_status_decision')) {
          // Mirror the real CTE: the update targets params[3] (session id).
          const exists = Boolean(sessions[params?.[3] ?? ''])
          return { rows: [{ session_exists: exists, suppressed: !exists }], rowCount: 1 }
        }
        if (sql.includes('UPDATE sessions') || sql.includes('UPDATE events')) {
          return { rows: [], rowCount: 1 }
        }
        return { rows: [], rowCount: 1 }
      }),
      _queries: queries,
    }
    return pool
  }

  function attackerInput(
    eventType: string,
    payload: Record<string, unknown>,
    overrides: Partial<MaterializationInput> = {},
  ): MaterializationInput {
    return {
      inboxId: 31,
      userId: ATTACKER_USER,
      daemonId: ATTACKER_DAEMON,
      sessionId: typeof payload.session_id === 'string' ? payload.session_id : 'victim-session',
      eventType,
      payload: { type: eventType, session_id: 'victim-session', ...payload },
      context: { agentType: 'codex', cwd: '/attacker', hostname: 'attacker-host' },
      ...overrides,
    }
  }

  const foreignVictim = {
    'victim-session': { user_id: 42, daemon_id: 'daemon-victim' },
  }

  test.each(['session_created', 'session_discovered'])(
    'attacker %s against a foreign session is a permanent rejection before any write',
    async (eventType) => {
      const pool = ownershipPool(foreignVictim)
      const bindSession = vi.fn()
      const materializer = new EventMaterializer({ pool: pool as never, hooks: { bindSession } })

      await expect(materializer.materialize(attackerInput(eventType, {
        title: 'Hijacked', agent: 'codex', cwd: '/attacker', status: 'busy',
      }))).rejects.toMatchObject({ code: 'session_ownership_violation', permanent: true })

      expect(pool._queries.filter((query) => query.sql.includes('INSERT INTO events'))).toHaveLength(0)
      expect(pool._queries.filter((query) => query.sql.includes('INSERT INTO sessions'))).toHaveLength(0)
      expect(bindSession).not.toHaveBeenCalled()
    },
  )

  test('attacker session_status against a foreign session is a violation, not suppression', async () => {
    const pool = ownershipPool(foreignVictim)
    const materializer = new EventMaterializer({ pool: pool as never })

    await expect(materializer.materialize(attackerInput('session_status', {
      status: 'completed',
    }))).rejects.toMatchObject({ code: 'session_ownership_violation', permanent: true })

    expect(pool._queries.filter((query) => query.sql.includes('INSERT INTO events'))).toHaveLength(0)
    expect(pool._queries.filter((query) => query.sql.includes('UPDATE sessions'))).toHaveLength(0)
  })

  test.each([
    ['agent_text', { text: 'injected' }],
    ['approval_request', { request_id: 'req-approval', tool: 'Bash', input: { command: 'ls' } }],
    ['question_request', { request_id: 'req-question', questions: [{ question: 'q' }] }],
    ['subagent_discovered', { agent: 'codex', agent_id: 'child', root_session_id: 'victim-session' }],
  ])('attacker %s against a foreign session never reaches canonical persistence', async (eventType, extra) => {
    const pool = ownershipPool(foreignVictim)
    const notifyUser = vi.fn().mockResolvedValue(undefined)
    const materializer = new EventMaterializer({
      pool: pool as never,
      durableHooks: { releaseQuotaReservation: vi.fn(), notifyUser, notifyProUser: vi.fn() },
    })

    await expect(materializer.materialize(attackerInput(eventType, extra)))
      .rejects.toMatchObject({ code: 'session_ownership_violation', permanent: true })

    expect(pool._queries.filter((query) => query.sql.includes('INSERT INTO events'))).toHaveLength(0)
    expect(notifyUser).not.toHaveBeenCalled()
  })

  test('ordinary events for a missing session are permanently rejected', async () => {
    const pool = ownershipPool({})
    const materializer = new EventMaterializer({ pool: pool as never })

    await expect(materializer.materialize(attackerInput('agent_text', {
      session_id: 'ghost-session', text: 'orphan',
    }, { sessionId: 'ghost-session' }))).rejects.toMatchObject({
      code: 'unknown_daemon_session', permanent: true,
    })

    expect(pool._queries.filter((query) => query.sql.includes('INSERT INTO events'))).toHaveLength(0)
  })

  test('unknown session_status for a missing session remains suppressed', async () => {
    const pool = ownershipPool({})
    const materializer = new EventMaterializer({ pool: pool as never })

    const result = await materializer.materialize(attackerInput('session_status', {
      session_id: 'ghost-session', status: 'busy',
    }, { sessionId: 'ghost-session' }))

    expect(result.deliveries).toEqual([])
  })

  test('attacker session_id_changed with a foreign old id is rejected without moving rows', async () => {
    const pool = ownershipPool({
      ...foreignVictim,
      'attacker-new-id': {},
    })
    const renameSession = vi.fn()
    const materializer = new EventMaterializer({ pool: pool as never, hooks: { renameSession } })

    await expect(materializer.materialize(attackerInput('session_id_changed', {
      session_id: 'attacker-new-id', old_session_id: 'victim-session',
    }, { sessionId: 'attacker-new-id' }))).rejects.toMatchObject({
      code: 'session_ownership_violation', permanent: true,
    })

    expect(pool._queries.filter((query) =>
      query.sql.includes('UPDATE sessions') && query.sql.includes('session_id'))).toHaveLength(0)
    expect(pool._queries.filter((query) => query.sql.includes('INSERT INTO events'))).toHaveLength(0)
    expect(renameSession).not.toHaveBeenCalled()
  })

  test('attacker session_id_changed onto a foreign existing new id is rejected', async () => {
    const pool = ownershipPool({
      ...foreignVictim,
      'attacker-owned': { user_id: ATTACKER_USER, daemon_id: ATTACKER_DAEMON },
    })
    const materializer = new EventMaterializer({ pool: pool as never })

    await expect(materializer.materialize(attackerInput('session_id_changed', {
      session_id: 'victim-session', old_session_id: 'attacker-owned',
    }))).rejects.toMatchObject({ code: 'session_ownership_violation', permanent: true })

    expect(pool._queries.filter((query) =>
      query.sql.includes('UPDATE sessions') && query.sql.includes('session_id'))).toHaveLength(0)
    expect(pool._queries.filter((query) => query.sql.includes('INSERT INTO events'))).toHaveLength(0)
  })

  test('a same-user or legacy same-daemon owner keeps full lifecycle rights', async () => {
    const pool = ownershipPool({
      'victim-session': { user_id: ATTACKER_USER, daemon_id: 'daemon-victim' },
      'legacy-session': { user_id: null, daemon_id: ATTACKER_DAEMON },
    })
    const upsert = vi.spyOn(db, 'upsertSession').mockResolvedValue(undefined)
    const bindSession = vi.fn()
    const materializer = new EventMaterializer({ pool: pool as never, hooks: { bindSession } })

    await expect(materializer.materialize(attackerInput('session_discovered', {
      agent: 'codex', cwd: '/attacker',
    }))).resolves.toBeTruthy()
    expect(upsert).toHaveBeenCalled()

    await expect(materializer.materialize(attackerInput('session_status', {
      session_id: 'legacy-session', status: 'idle',
    }, { sessionId: 'legacy-session' }))).resolves.toBeTruthy()
    expect(bindSession).toHaveBeenCalled()
    upsert.mockRestore()
  })
})

describe('normalizeSessionId daemon session identity', () => {
  test('accepts agent session id formats without a uuid-only regex', () => {
    expect(normalizeSessionId('a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890')
    expect(normalizeSessionId('codex-77af52')).toBe('codex-77af52')
    expect(normalizeSessionId('z'.repeat(64))).toBe('z'.repeat(64))
  })

  test('rejects non-strings, empty, oversized, padded, and pending- identities', () => {
    expect(normalizeSessionId(undefined)).toBeNull()
    expect(normalizeSessionId(1234)).toBeNull()
    expect(normalizeSessionId('')).toBeNull()
    expect(normalizeSessionId('z'.repeat(65))).toBeNull()
    expect(normalizeSessionId(' padded ')).toBeNull()
    expect(normalizeSessionId('pending-1712345678')).toBeNull()
  })
})
