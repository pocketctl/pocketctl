import Fastify, { type FastifyInstance } from 'fastify'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { initDB } from '../db.js'
import { attentionInboxConfig } from '../attention-inbox/config.js'
import { createAttentionProjectionWorker } from '../attention-inbox/projection-worker.js'
import { AttentionInboxRepository } from '../attention-inbox/repository.js'
import { AttentionRecoveryRepository } from '../attention-inbox/recovery-repository.js'
import { registerAttentionInboxRoutes } from '../attention-inbox/routes.js'
import { AttentionInboxService } from '../attention-inbox/service.js'
import { Router } from '../router.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const integrationEnabled = Boolean(databaseUrl && process.env.RUN_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = integrationEnabled ? describe : describe.skip

describeWithDatabase('Attention Inbox PostgreSQL transaction boundaries', () => {
  let pool: pg.Pool
  let repository: AttentionInboxRepository
  let userId: number

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 8 })
    const database = await pool.query<{ database_name: string }>('SELECT current_database() AS database_name')
    if (!/test/i.test(database.rows[0]?.database_name ?? '')) {
      throw new Error('Refusing PostgreSQL integration test against non-test database')
    }
    await initDB(pool)
    repository = new AttentionInboxRepository(pool, 'integration-cursor-secret')
  }, 30_000)

  afterAll(async () => { await pool?.end() })

  beforeEach(async () => {
    await pool.query(`DELETE FROM sessions WHERE session_id = 'attention-session'`)
    await pool.query(`DELETE FROM daemons WHERE daemon_id = 'attention-daemon'`)
    await pool.query(`DELETE FROM users WHERE email = 'attention-inbox@example.test'`)
    const user = await pool.query<{ id: number }>(
      `INSERT INTO users (email, password_hash) VALUES ('attention-inbox@example.test', '') RETURNING id`,
    )
    userId = user.rows[0].id
    await pool.query(
      `INSERT INTO daemons (daemon_id, user_id, hostname, status)
       VALUES ('attention-daemon', $1, 'test-host', 'online')`,
      [userId],
    )
    await pool.query(
      `INSERT INTO sessions (
         session_id, daemon_id, user_id, agent_type, control_mode, capabilities, status, title
       ) VALUES (
         'attention-session', 'attention-daemon', $1, 'codex', 'managed',
         '["terminal_coapproval","questions"]'::jsonb, 'waiting_approval', 'Release'
       )`,
      [userId],
    )
    await pool.query(
      `UPDATE attention_projection_cursor
       SET last_event_id = COALESCE((SELECT MAX(id) FROM events), 0)
       WHERE projector_name = 'attention-inbox-v1'`,
    )
  })

  async function insertRequest(requestId: string): Promise<void> {
    await pool.query(
      `INSERT INTO events (session_id, event_type, payload)
       VALUES ('attention-session', 'approval_request', $1::jsonb)`,
      [JSON.stringify({
        type: 'approval_request', session_id: 'attention-session', request_id: requestId,
        available_decisions: ['accept', 'decline'], command: 'git status',
      })],
    )
  }

  function daemonSocket(): any {
    const sent: Record<string, unknown>[] = []
    return {
      readyState: 1,
      send(raw: string) { sent.push(JSON.parse(raw)) },
      close() {},
      terminate() {},
      _sent: sent,
    }
  }

  function httpApp(router: Router): FastifyInstance {
    const app = Fastify()
    const service = new AttentionInboxService({
      mode: 'on', repository, router, requestHashSecret: 'integration-request-secret',
    })
    registerAttentionInboxRoutes(app, {
      pool,
      config: attentionInboxConfig({ ATTENTION_INBOX_V1: 'on' }),
      repository,
      recoveryRepository: new AttentionRecoveryRepository(pool),
      service,
      verifyAccessToken: async (token) => token === 'valid' ? { userId } : null,
    })
    return app
  }

  async function resolveRequest(requestId: string, action = 'once'): Promise<void> {
    await pool.query(
      `INSERT INTO events (session_id, event_type, payload)
       VALUES ('attention-session', 'approval_resolved', $1::jsonb)`,
      [JSON.stringify({ request_id: requestId, action, approved: action !== 'reject' })],
    )
    await createAttentionProjectionWorker({ pool, repository }).runOnce()
  }

  test('two projector instances claim one cursor batch without duplicate items', async () => {
    await insertRequest('projection-race')
    const first = createAttentionProjectionWorker({ pool, repository })
    const second = createAttentionProjectionWorker({ pool, repository })
    const counts = await Promise.all([first.runOnce(), second.runOnce()])
    expect(counts.sort((a, b) => a - b)).toEqual([0, 1])
    const items = await pool.query(
      `SELECT request_id FROM attention_items WHERE user_id = $1 AND request_id = 'projection-race'`,
      [userId],
    )
    expect(items.rows).toEqual([{ request_id: 'projection-race' }])
  })

  test('two REST claims send only one winner and preserve the submitting row', async () => {
    await insertRequest('action-race')
    await createAttentionProjectionWorker({ pool, repository }).runOnce()
    const row = await pool.query(
      `SELECT item_id, revision FROM attention_items WHERE user_id = $1 AND request_id = 'action-race'`,
      [userId],
    )
    const input = {
      userId, itemId: row.rows[0].item_id, requestHash: 'same-content',
      request: { expectedRevision: Number(row.rows[0].revision), actionId: 'once' as const },
    }
    const claims = await Promise.all([
      repository.claimAction({ ...input, idempotencyKey: '11111111-1111-4111-8111-111111111111' }),
      repository.claimAction({ ...input, idempotencyKey: '22222222-2222-4222-8222-222222222222' }),
    ])
    expect(claims.map((claim) => claim.outcome).sort()).toEqual(['already_submitting', 'claimed'])
    expect((await pool.query(
      `SELECT state FROM attention_items WHERE item_id = $1`, [input.itemId],
    )).rows[0].state).toBe('submitting')
  })

  test('send-failure restore cannot overwrite an authoritative terminal resolution', async () => {
    await insertRequest('resolve-race')
    await createAttentionProjectionWorker({ pool, repository }).runOnce()
    const row = await pool.query(
      `SELECT item_id, revision FROM attention_items WHERE user_id = $1 AND request_id = 'resolve-race'`,
      [userId],
    )
    const key = '33333333-3333-4333-8333-333333333333'
    expect((await repository.claimAction({
      userId, itemId: row.rows[0].item_id, idempotencyKey: key, requestHash: 'content',
      request: { expectedRevision: Number(row.rows[0].revision), actionId: 'once' },
    })).outcome).toBe('claimed')

    const resolvedEvent = await pool.query<{ id: string }>(
      `INSERT INTO events (session_id, event_type, payload)
       VALUES ('attention-session', 'approval_resolved', $1::jsonb)
       RETURNING id`,
      [JSON.stringify({ request_id: 'resolve-race', action: 'once', approved: true })],
    )

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await repository.applyProjection(client, {
        operation: 'resolve',
        identity: {
          userId, daemonId: 'attention-daemon', sessionId: 'attention-session',
          requestId: 'resolve-race', kind: 'approval',
        },
        resolutionEventId: Number(resolvedEvent.rows[0].id),
        resolution: { source: 'daemon', action: 'once', approved: true },
      })
      await client.query('COMMIT')
    } finally {
      client.release()
    }
    await repository.restoreSubmission({
      userId, itemId: row.rows[0].item_id, idempotencyKey: key, errorCode: 'daemon_unreachable',
    })
    expect((await pool.query(
      `SELECT state, last_error_code FROM attention_items WHERE item_id = $1`, [row.rows[0].item_id],
    )).rows[0]).toEqual({ state: 'resolved', last_error_code: null })
    expect((await pool.query(
      `SELECT status FROM attention_action_receipts WHERE item_id = $1 AND idempotency_key = $2`,
      [row.rows[0].item_id, key],
    )).rows[0].status).toBe('accepted')

    expect((await repository.claimAction({
      userId, itemId: row.rows[0].item_id, idempotencyKey: key, requestHash: 'content',
      request: { expectedRevision: Number(row.rows[0].revision), actionId: 'once' },
    })).outcome).toBe('resolved_elsewhere')
  })

  test('maintenance marks timed-out submissions unknown and removes old terminal rows', async () => {
    await insertRequest('maintenance')
    await createAttentionProjectionWorker({ pool, repository }).runOnce()
    const row = await pool.query(
      `SELECT item_id, revision FROM attention_items WHERE user_id = $1 AND request_id = 'maintenance'`,
      [userId],
    )
    const itemId = row.rows[0].item_id
    const key = '44444444-4444-4444-8444-444444444444'
    expect((await repository.claimAction({
      userId, itemId, idempotencyKey: key, requestHash: 'maintenance-content',
      request: { expectedRevision: Number(row.rows[0].revision), actionId: 'once' },
    })).outcome).toBe('claimed')
    await pool.query(
      `UPDATE attention_items SET submission_deadline_at = NOW() - INTERVAL '1 second' WHERE item_id = $1`,
      [itemId],
    )

    expect(await repository.runMaintenance()).toBe(1)
    expect((await pool.query(
      `SELECT state, last_error_code FROM attention_items WHERE item_id = $1`, [itemId],
    )).rows[0]).toEqual({ state: 'result_unknown', last_error_code: 'result_unknown' })
    expect((await pool.query(
      `SELECT status FROM attention_action_receipts WHERE item_id = $1 AND idempotency_key = $2`,
      [itemId, key],
    )).rows[0].status).toBe('result_unknown')

    await pool.query(
      `UPDATE attention_items
       SET state = 'resolved', handled_at = NOW() - INTERVAL '31 days'
       WHERE item_id = $1`,
      [itemId],
    )
    expect(await repository.runMaintenance()).toBe(1)
    expect((await pool.query(
      `SELECT item_id FROM attention_items WHERE item_id = $1`, [itemId],
    )).rowCount).toBe(0)
  })

  test('HTTP action reaches the owned daemon once and converges from its authoritative resolution', async () => {
    await insertRequest('http-first')
    await createAttentionProjectionWorker({ pool, repository }).runOnce()
    const router = new Router(pool)
    const daemon = daemonSocket()
    ;(router as any).daemons.set('attention-daemon', {
      ws: daemon, daemonId: 'attention-daemon', userId,
    })
    const app = httpApp(router)
    try {
      const snapshot = await app.inject({
        method: 'GET', url: '/api/attention-inbox/v1/items',
        headers: { authorization: 'Bearer valid' },
      })
      expect(snapshot.statusCode).toBe(200)
      const item = snapshot.json().items.find((candidate: any) => candidate.request_id === 'http-first')
      expect(item).toEqual(expect.objectContaining({ state: 'open', provider: 'codex' }))

      const key = '55555555-5555-4555-8555-555555555555'
      const request = {
        method: 'POST' as const,
        url: `/api/attention-inbox/v1/items/${item.item_id}/actions`,
        headers: { authorization: 'Bearer valid', 'idempotency-key': key },
        payload: { expected_revision: item.revision, action_id: 'once' },
      }
      const submitted = await app.inject(request)
      expect(submitted.statusCode).toBe(202)
      expect(submitted.json()).toEqual(expect.objectContaining({
        outcome: 'submitted', final: false,
        item: expect.objectContaining({ state: 'submitting' }),
      }))
      expect(daemon._sent).toEqual([{
        type: 'approval_response', session_id: 'attention-session',
        request_id: 'http-first', action: 'once',
      }])

      await resolveRequest('http-first')
      const resolved = await app.inject({
        method: 'GET', url: '/api/attention-inbox/v1/items?states=resolved',
        headers: { authorization: 'Bearer valid' },
      })
      expect(resolved.json().items).toEqual([
        expect.objectContaining({ request_id: 'http-first', state: 'resolved' }),
      ])

      const replay = await app.inject(request)
      expect(replay.statusCode).toBe(200)
      expect(replay.json()).toEqual(expect.objectContaining({
        outcome: 'resolved_elsewhere', final: true,
      }))
      expect(daemon._sent).toHaveLength(1)
    } finally {
      await app.close()
    }
  })

  test('terminal-first resolution wins before HTTP submission and emits no daemon command', async () => {
    await insertRequest('terminal-first')
    await createAttentionProjectionWorker({ pool, repository }).runOnce()
    await resolveRequest('terminal-first', 'reject')
    const row = await pool.query(
      `SELECT item_id, revision FROM attention_items
       WHERE user_id = $1 AND request_id = 'terminal-first'`,
      [userId],
    )
    const router = new Router(pool)
    const daemon = daemonSocket()
    ;(router as any).daemons.set('attention-daemon', {
      ws: daemon, daemonId: 'attention-daemon', userId,
    })
    const app = httpApp(router)
    try {
      const response = await app.inject({
        method: 'POST', url: `/api/attention-inbox/v1/items/${row.rows[0].item_id}/actions`,
        headers: {
          authorization: 'Bearer valid',
          'idempotency-key': '66666666-6666-4666-8666-666666666666',
        },
        payload: { expected_revision: Number(row.rows[0].revision), action_id: 'once' },
      })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual(expect.objectContaining({
        outcome: 'resolved_elsewhere', final: true,
        item: expect.objectContaining({ state: 'resolved' }),
      }))
      expect(daemon._sent).toEqual([])
    } finally {
      await app.close()
    }
  })

  test('offline HTTP submission restores open state and a later terminal resolution still wins', async () => {
    await insertRequest('offline-terminal')
    await createAttentionProjectionWorker({ pool, repository }).runOnce()
    const row = await pool.query(
      `SELECT item_id, revision FROM attention_items
       WHERE user_id = $1 AND request_id = 'offline-terminal'`,
      [userId],
    )
    const app = httpApp(new Router(pool))
    try {
      const response = await app.inject({
        method: 'POST', url: `/api/attention-inbox/v1/items/${row.rows[0].item_id}/actions`,
        headers: {
          authorization: 'Bearer valid',
          'idempotency-key': '77777777-7777-4777-8777-777777777777',
        },
        payload: { expected_revision: Number(row.rows[0].revision), action_id: 'once' },
      })
      expect(response.statusCode).toBe(503)
      expect(response.json()).toEqual(expect.objectContaining({
        error: expect.objectContaining({ code: 'daemon_unreachable', retryable: true }),
      }))
      expect((await pool.query(
        `SELECT state FROM attention_items WHERE item_id = $1`, [row.rows[0].item_id],
      )).rows[0].state).toBe('open')

      await resolveRequest('offline-terminal', 'reject')
      expect((await pool.query(
        `SELECT state, resolution->>'action' AS action
         FROM attention_items WHERE item_id = $1`,
        [row.rows[0].item_id],
      )).rows[0]).toEqual({ state: 'resolved', action: 'reject' })
    } finally {
      await app.close()
    }
  })

  test('managed OpenCode request uses the same bounded HTTP-to-daemon contract', async () => {
    await pool.query(
      `UPDATE sessions
       SET agent_type = 'opencode', control_mode = 'managed'
       WHERE session_id = 'attention-session'`,
    )
    await insertRequest('opencode-http')
    await createAttentionProjectionWorker({ pool, repository }).runOnce()
    const router = new Router(pool)
    const daemon = daemonSocket()
    ;(router as any).daemons.set('attention-daemon', {
      ws: daemon, daemonId: 'attention-daemon', userId,
    })
    const app = httpApp(router)
    try {
      const snapshot = await app.inject({
        method: 'GET', url: '/api/attention-inbox/v1/items',
        headers: { authorization: 'Bearer valid' },
      })
      const item = snapshot.json().items.find((candidate: any) => candidate.request_id === 'opencode-http')
      expect(item).toEqual(expect.objectContaining({
        provider: 'opencode', state: 'open',
        allowed_actions: [
          expect.objectContaining({ id: 'once' }),
          expect.objectContaining({ id: 'reject' }),
        ],
      }))

      const response = await app.inject({
        method: 'POST', url: `/api/attention-inbox/v1/items/${item.item_id}/actions`,
        headers: {
          authorization: 'Bearer valid',
          'idempotency-key': '88888888-8888-4888-8888-888888888888',
        },
        payload: { expected_revision: item.revision, action_id: 'once' },
      })
      expect(response.statusCode).toBe(202)
      expect(daemon._sent).toEqual([{
        type: 'approval_response', session_id: 'attention-session',
        request_id: 'opencode-http', action: 'once',
      }])
    } finally {
      await app.close()
    }
  })

  test('recovery projection is generation-bound, deduplicated, and resolved by a current online generation', async () => {
    const recoveryRepository = new AttentionRecoveryRepository(pool)
    await pool.query(
      `UPDATE daemons
       SET status = 'offline', registration_id = 'recovery-generation-1', last_heartbeat = NULL
       WHERE daemon_id = 'attention-daemon' AND user_id = $1`,
      [userId],
    )

    const created = await recoveryRepository.recordConfirmedOffline({
      userId, daemonId: 'attention-daemon', registrationGeneration: 'recovery-generation-1',
      daemonDisplayName: 'test-host',
    })
    expect(created.outcome).toBe('created')
    expect((created as any).item.lastSeenAt).toBeInstanceOf(Date)
    await expect(recoveryRepository.recordConfirmedOffline({
      userId, daemonId: 'attention-daemon', registrationGeneration: 'stale-generation',
      daemonDisplayName: 'test-host',
    })).resolves.toEqual({ outcome: 'noop' })
    expect((await pool.query(
      `SELECT COUNT(*)::int AS count FROM attention_recovery_items WHERE user_id = $1`, [userId],
    )).rows[0].count).toBe(1)

    await pool.query(
      `UPDATE daemons SET status = 'online', registration_id = 'recovery-generation-2'
       WHERE daemon_id = 'attention-daemon' AND user_id = $1`,
      [userId],
    )
    await expect(recoveryRepository.recordConfirmedOnline({
      userId, daemonId: 'attention-daemon', registrationGeneration: 'recovery-generation-2',
    })).resolves.toEqual({ resolved: 1, quickResolved: 1 })
    expect((await pool.query(
      `SELECT state, resolution->>'source' AS source
       FROM attention_recovery_items WHERE user_id = $1`, [userId],
    )).rows[0]).toEqual({ state: 'resolved', source: 'daemon_online' })
  })
})
