import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { initDB } from '../db.js'
import { createInboxWorker } from '../inbox-worker.js'
import { IngressController } from '../ingress/controller.js'
import { InboxRepository } from '../ingress/inbox-repository.js'
import { EventMaterializer } from '../materialization/event-materializer.js'
import { RealtimeOutboxWriter } from '../materialization/realtime-outbox.js'
import {
  getQuotaSnapshot,
  markQuotaReservationUncertain,
  reserveConcurrentSession,
  settleQuotaReservation,
  type QuotaReservationBinding,
} from '../quota.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const integrationEnabled = Boolean(databaseUrl && process.env.RUN_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = integrationEnabled ? describe : describe.skip

describeWithDatabase('quota reservation binding PostgreSQL integration', () => {
  let pool: pg.Pool
  let userId: number

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl })
    const database = await pool.query<{ database_name: string }>('SELECT current_database() AS database_name')
    const databaseName = database.rows[0]?.database_name ?? ''
    if (!/test/i.test(databaseName)) {
      throw new Error(`Refusing PostgreSQL integration test against non-test database: ${databaseName || '<unknown>'}`)
    }
    await initDB(pool)
  }, 30_000)

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE realtime_outbox, event_inbox_receipt, daemon_ack_checkpoint,
                event_inbox, events, quota_reservations, sessions, daemons, users
       RESTART IDENTITY CASCADE`,
    )
    const user = await pool.query<{ id: number }>(
      `INSERT INTO users (email, password_hash) VALUES ('quota-binding@test.invalid', 'x') RETURNING id`,
    )
    userId = user.rows[0]!.id
    await pool.query(
      `INSERT INTO daemons (daemon_id, hostname, status, user_id)
       VALUES ('quota-daemon-a', 'a', 'online', $1), ('quota-daemon-b', 'b', 'online', $1)`,
      [userId],
    )
  })

  async function createReservation(requestId = 'request-create'): Promise<QuotaReservationBinding> {
    const decision = await reserveConcurrentSession(pool, {
      userId,
      daemonId: 'quota-daemon-a',
      requestId,
      operation: 'create',
      limit: 4,
    })
    if (!decision.allowed || !decision.reservationId) throw new Error('expected create reservation')
    return {
      reservationId: decision.reservationId,
      userId,
      daemonId: 'quota-daemon-a',
      requestId,
      operation: 'create',
      sessionId: 'created-session',
    }
  }

  test('create settlement binds every server identity and then pins the created session', async () => {
    const binding = await createReservation()
    await pool.query(
      `INSERT INTO sessions (session_id, daemon_id, agent_type, cwd, source, status, user_id)
       VALUES ($1, $2, 'codex', '/repo', 'daemon', 'running', $3)`,
      [binding.sessionId, binding.daemonId, userId],
    )

    await expect(settleQuotaReservation(pool, { ...binding, userId: userId + 999 }, 'session_created'))
      .resolves.toEqual({ matched: false, changed: false })
    await expect(settleQuotaReservation(pool, { ...binding, daemonId: 'quota-daemon-b' }, 'session_created'))
      .resolves.toEqual({ matched: false, changed: false })
    await expect(settleQuotaReservation(pool, { ...binding, requestId: 'wrong-request' }, 'session_created'))
      .resolves.toEqual({ matched: false, changed: false })
    await expect(settleQuotaReservation(pool, { ...binding, operation: 'resume' }, 'session_active'))
      .resolves.toEqual({ matched: false, changed: false })

    await expect(settleQuotaReservation(pool, binding, 'session_created'))
      .resolves.toEqual({ matched: true, changed: true })
    await expect(settleQuotaReservation(pool, binding, 'session_created'))
      .resolves.toEqual({ matched: true, changed: false })
    await expect(settleQuotaReservation(pool, { ...binding, sessionId: 'other-session' }, 'session_created'))
      .resolves.toEqual({ matched: false, changed: false })

    const row = await pool.query(
      `SELECT user_id, daemon_id, request_id, operation, session_id, state, settlement_reason
       FROM quota_reservations WHERE id = $1`,
      [binding.reservationId],
    )
    expect(row.rows[0]).toMatchObject({
      user_id: userId,
      daemon_id: 'quota-daemon-a',
      request_id: 'request-create',
      operation: 'create',
      session_id: 'created-session',
      state: 'settled',
      settlement_reason: 'session_created',
    })
  })

  test('resume and uncertain transitions require the pre-bound session', async () => {
    await pool.query(
      `INSERT INTO sessions (session_id, daemon_id, agent_type, cwd, source, status, user_id)
       VALUES ('existing-session', 'quota-daemon-a', 'codex', '/repo', 'daemon', 'exited', $1)`,
      [userId],
    )
    const resume = await reserveConcurrentSession(pool, {
      userId,
      daemonId: 'quota-daemon-a',
      requestId: 'request-resume',
      operation: 'resume',
      sessionId: 'existing-session',
      limit: 4,
    })
    if (!resume.allowed || !resume.reservationId) throw new Error('expected resume reservation')
    const binding: QuotaReservationBinding = {
      reservationId: resume.reservationId,
      userId,
      daemonId: 'quota-daemon-a',
      requestId: 'request-resume',
      operation: 'resume',
      sessionId: 'existing-session',
    }

    await expect(settleQuotaReservation(pool, { ...binding, sessionId: 'other-session' }, 'session_active'))
      .resolves.toEqual({ matched: false, changed: false })
    await expect(settleQuotaReservation(pool, binding, 'session_active'))
      .resolves.toEqual({ matched: true, changed: true })

    const uncertain = await createReservation('request-uncertain')
    const pendingBinding = { ...uncertain, sessionId: null }
    await expect(markQuotaReservationUncertain(pool, { ...pendingBinding, requestId: 'wrong-request' }, 'grant_timeout'))
      .resolves.toEqual({ matched: false, changed: false })
    await expect(markQuotaReservationUncertain(pool, pendingBinding, 'grant_timeout'))
      .resolves.toEqual({ matched: true, changed: true })
  })

  test('a create reservation cannot be settled by re-announcing an older owned session', async () => {
    await pool.query(
      `INSERT INTO sessions (session_id, daemon_id, agent_type, cwd, source, status, user_id, created_at)
       VALUES ('older-session', 'quota-daemon-a', 'codex', '/repo', 'daemon', 'running', $1,
               NOW() - interval '1 hour')`,
      [userId],
    )
    const binding = await createReservation('request-old-session')

    await expect(settleQuotaReservation(pool, { ...binding, sessionId: 'older-session' }, 'session_created'))
      .resolves.toEqual({ matched: false, changed: false })
    const row = await pool.query<{ state: string; session_id: string | null }>(
      'SELECT state, session_id FROM quota_reservations WHERE id = $1',
      [binding.reservationId],
    )
    expect(row.rows[0]).toEqual({ state: 'pending', session_id: null })
  })

  test('a settled failure cannot be rewritten as a later success for the same request', async () => {
    const successBinding = await createReservation('request-conflicting-outcome')
    const failureBinding = { ...successBinding, sessionId: null }

    await expect(settleQuotaReservation(pool, failureBinding, 'session_create_failed'))
      .resolves.toEqual({ matched: true, changed: true })
    await pool.query(
      `INSERT INTO sessions (session_id, daemon_id, agent_type, cwd, source, status, user_id)
       VALUES ($1, $2, 'codex', '/repo', 'daemon', 'running', $3)`,
      [successBinding.sessionId, successBinding.daemonId, userId],
    )
    await expect(settleQuotaReservation(pool, successBinding, 'session_created'))
      .resolves.toEqual({ matched: false, changed: false })

    const row = await pool.query<{ state: string; session_id: string | null; settlement_reason: string }>(
      'SELECT state, session_id, settlement_reason FROM quota_reservations WHERE id = $1',
      [successBinding.reservationId],
    )
    expect(row.rows[0]).toEqual({
      state: 'settled', session_id: null, settlement_reason: 'session_create_failed',
    })
  })

  test('duplicate request reuse rejects a different daemon or session binding', async () => {
    await createReservation('duplicate-request')

    await expect(reserveConcurrentSession(pool, {
      userId,
      daemonId: 'quota-daemon-b',
      requestId: 'duplicate-request',
      operation: 'create',
      limit: 4,
    })).resolves.toEqual({ allowed: false, reason: 'quota_reservation_binding_conflict' })
  })

  test('a finalized request returns a deterministic non-retryable result', async () => {
    const binding = await createReservation('finalized-request')
    await settleQuotaReservation(pool, { ...binding, sessionId: null }, 'session_create_failed')

    await expect(reserveConcurrentSession(pool, {
      userId,
      daemonId: 'quota-daemon-a',
      requestId: 'finalized-request',
      operation: 'create',
      limit: 4,
    })).resolves.toEqual({ allowed: false, reason: 'quota_request_already_finalized' })
  })

  test('quota cutover is one-time and never settles unconfirmed runtime reservations', async () => {
    await pool.query("DELETE FROM quota_reservation_migrations WHERE key = 'strong-binding-v1'")
    await pool.query(
      `INSERT INTO quota_reservations
         (id, user_id, resource, operation, daemon_id, session_id, request_id, expires_at, state, created_at)
       VALUES ('00000000-0000-0000-0000-000000000101', $1, 'concurrent_session', 'create',
               'quota-daemon-a', NULL, 'pre-cutover', NOW() - interval '2 hours', 'pending',
               NOW() - interval '2 hours')`,
      [userId],
    )

    await initDB(pool)
    const migrated = await pool.query<{ state: string; settlement_reason: string }>(
      "SELECT state, settlement_reason FROM quota_reservations WHERE request_id = 'pre-cutover'",
    )
    expect(migrated.rows[0]).toEqual({ state: 'uncertain', settlement_reason: 'strong_binding_cutover' })

    await pool.query(
      `INSERT INTO quota_reservations
         (id, user_id, resource, operation, daemon_id, session_id, request_id, expires_at, state, created_at)
       VALUES ('00000000-0000-0000-0000-000000000102', $1, 'concurrent_session', 'create',
               'quota-daemon-a', NULL, 'runtime-pending', NOW() - interval '2 hours', 'pending',
               NOW() - interval '2 hours')`,
      [userId],
    )
    await initDB(pool)
    const runtime = await pool.query<{ state: string; settlement_reason: string | null }>(
      "SELECT state, settlement_reason FROM quota_reservations WHERE request_id = 'runtime-pending'",
    )
    expect(runtime.rows[0]).toEqual({ state: 'pending', settlement_reason: null })
  })

  test('failure ACK is backed by a replayable inbox outcome before reservation settlement', async () => {
    const binding = await createReservation('durable-failure-request')
    const repository = new InboxRepository(pool)
    let ackedSeq = 0
    const controller = new IngressController({
      repository,
      sendAck: (_daemonId, checkpoint) => { ackedSeq = checkpoint.ackSeq },
      disconnectRetryable: () => undefined,
      setTimer: () => ({ unref() {} }) as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => undefined,
    })
    expect(controller.accept({
      daemonId: binding.daemonId,
      registrationId: 'quota-failure-registration',
      userId,
      daemonGeneration: 901,
    }, {
      type: 'session_create_failed',
      request_id: binding.requestId,
      reservation_id: 'daemon-forged',
      reason: 'start_fail',
      seq: 1,
    }, {
      requestId: binding.requestId,
      reservationId: binding.reservationId,
      quotaOperation: 'create',
      hostname: 'quota-host',
    })).toMatchObject({ kind: 'accepted' })

    await controller.flushNow()
    expect(ackedSeq).toBe(1)
    expect((await pool.query(
      'SELECT state FROM quota_reservations WHERE id = $1', [binding.reservationId],
    )).rows[0]).toEqual({ state: 'pending' })
    expect((await pool.query(
      `SELECT COUNT(*)::int AS count FROM event_inbox
       WHERE event_type = 'session_create_failed' AND payload->>'request_id' = $1`,
      [binding.requestId],
    )).rows[0]).toEqual({ count: 1 })

    const worker = createInboxWorker({
      repository,
      materializer: new EventMaterializer({ pool }),
      outboxWriter: new RealtimeOutboxWriter(pool),
      workerId: 'quota-failure-worker',
      shardCount: 1,
      shardIndex: 0,
    })
    await worker.runOnce()

    expect((await pool.query(
      'SELECT state, settlement_reason FROM quota_reservations WHERE id = $1',
      [binding.reservationId],
    )).rows[0]).toEqual({ state: 'settled', settlement_reason: 'session_create_failed' })
    const outbox = await pool.query(
      `SELECT audience, request_id, payload->>'reservation_id' AS reservation_id
       FROM realtime_outbox WHERE event_type = 'session_create_failed'`,
    )
    expect(outbox.rows[0]).toEqual({
      audience: 'user', request_id: binding.requestId, reservation_id: binding.reservationId,
    })
  })

  test('same request id failures use distinct tenant and daemon effect ledgers', async () => {
    const first = await createReservation('shared-failure-request')
    const secondUser = await pool.query<{ id: number }>(
      `INSERT INTO users (email, password_hash) VALUES ('quota-binding-2@test.invalid', 'x') RETURNING id`,
    )
    const secondUserId = secondUser.rows[0]!.id
    await pool.query(
      `INSERT INTO daemons (daemon_id, hostname, status, user_id)
       VALUES ('quota-daemon-c', 'c', 'online', $1)`,
      [secondUserId],
    )
    const secondDecision = await reserveConcurrentSession(pool, {
      userId: secondUserId,
      daemonId: 'quota-daemon-c',
      requestId: 'shared-failure-request',
      operation: 'create',
      limit: 4,
    })
    if (!secondDecision.allowed || !secondDecision.reservationId) {
      throw new Error('expected second tenant reservation')
    }

    const materializer = new EventMaterializer({ pool })
    await materializer.materialize({
      inboxId: 9_101,
      userId,
      daemonId: first.daemonId,
      sessionId: null,
      eventType: 'session_create_failed',
      payload: { type: 'session_create_failed', request_id: first.requestId, reason: 'start_fail' },
      context: {
        requestId: first.requestId,
        reservationId: first.reservationId,
        quotaOperation: 'create',
        hostname: 'a',
      },
    })
    await materializer.materialize({
      inboxId: 9_102,
      userId: secondUserId,
      daemonId: 'quota-daemon-c',
      sessionId: null,
      eventType: 'session_create_failed',
      payload: { type: 'session_create_failed', request_id: first.requestId, reason: 'start_fail' },
      context: {
        requestId: first.requestId,
        reservationId: secondDecision.reservationId,
        quotaOperation: 'create',
        hostname: 'c',
      },
    })

    const reservations = await pool.query<{ state: string }>(
      `SELECT state FROM quota_reservations
       WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[first.reservationId, secondDecision.reservationId]],
    )
    expect(reservations.rows).toEqual([{ state: 'settled' }, { state: 'settled' }])
    const ledgers = await pool.query<{ session_id: string }>(
      `SELECT session_id FROM events
       WHERE event_type = 'session_create_failed'
         AND payload->>'request_id' = 'shared-failure-request'
       ORDER BY session_id`,
    )
    expect(ledgers.rows).toHaveLength(2)
    expect(ledgers.rows[0]!.session_id).not.toBe(ledgers.rows[1]!.session_id)
  })

  test('failure replay after relay restart recovers its durable reservation binding', async () => {
    const binding = await createReservation('restart-failure-request')
    const result = await new EventMaterializer({ pool }).materialize({
      inboxId: 9_103,
      userId,
      daemonId: binding.daemonId,
      sessionId: null,
      eventType: 'session_create_failed',
      payload: { type: 'session_create_failed', request_id: binding.requestId, reason: 'start_fail' },
      context: { requestId: binding.requestId, hostname: 'a' },
    })

    expect((await pool.query(
      'SELECT state, settlement_reason FROM quota_reservations WHERE id = $1',
      [binding.reservationId],
    )).rows[0]).toEqual({ state: 'settled', settlement_reason: 'session_create_failed' })
    expect(result.deliveries[0]?.payload).toEqual(expect.objectContaining({
      reservation_id: binding.reservationId,
    }))
  })

  test('session creation replay after relay restart recovers binding and create metadata', async () => {
    const decision = await reserveConcurrentSession(pool, {
      userId,
      daemonId: 'quota-daemon-a',
      requestId: 'restart-success-request',
      operation: 'create',
      limit: 4,
      agentType: 'opencode',
      cwd: '/recovered/repo',
    })
    if (!decision.allowed || !decision.reservationId) throw new Error('expected restart reservation')

    const result = await new EventMaterializer({ pool }).materialize({
      inboxId: 9_104,
      userId,
      daemonId: 'quota-daemon-a',
      sessionId: 'restart-created-session',
      eventType: 'session_created',
      payload: {
        type: 'session_created', session_id: 'restart-created-session',
        request_id: 'restart-success-request', event_id: 'restart-success-event',
      },
      context: { requestId: 'restart-success-request', hostname: 'a' },
    })

    expect((await pool.query(
      `SELECT agent_type, cwd, user_id, daemon_id FROM sessions
       WHERE session_id = 'restart-created-session'`,
    )).rows[0]).toEqual({
      agent_type: 'opencode', cwd: '/recovered/repo', user_id: userId, daemon_id: 'quota-daemon-a',
    })
    expect((await pool.query(
      'SELECT state, session_id, settlement_reason FROM quota_reservations WHERE id = $1',
      [decision.reservationId],
    )).rows[0]).toEqual({
      state: 'settled', session_id: 'restart-created-session', settlement_reason: 'session_created',
    })
    expect(result.deliveries[0]?.payload).toEqual(expect.objectContaining({
      reservation_id: decision.reservationId,
    }))
  })

  test('a failure-finalized request rejects a contradictory success before session creation', async () => {
    const binding = await createReservation('failure-then-success-request')
    await new EventMaterializer({ pool }).materialize({
      inboxId: 9_105,
      userId,
      daemonId: binding.daemonId,
      sessionId: null,
      eventType: 'session_create_failed',
      payload: { type: 'session_create_failed', request_id: binding.requestId, reason: 'start_fail' },
      context: {
        requestId: binding.requestId,
        reservationId: binding.reservationId,
        quotaOperation: 'create',
        hostname: 'a',
      },
    })

    await expect(new EventMaterializer({ pool }).materialize({
      inboxId: 9_106,
      userId,
      daemonId: binding.daemonId,
      sessionId: 'contradictory-created-session',
      eventType: 'session_created',
      payload: {
        type: 'session_created', session_id: 'contradictory-created-session',
        request_id: binding.requestId, event_id: 'contradictory-success-event',
      },
      context: {
        agentType: 'codex', cwd: '/repo', requestId: binding.requestId,
        reservationId: binding.reservationId, quotaOperation: 'create', hostname: 'a',
      },
    })).rejects.toMatchObject({ code: 'quota_reservation_binding_mismatch' })

    expect((await pool.query(
      `SELECT COUNT(*)::int AS count FROM sessions
       WHERE session_id = 'contradictory-created-session'`,
    )).rows[0]).toEqual({ count: 0 })
    expect((await pool.query(
      'SELECT state, session_id, settlement_reason FROM quota_reservations WHERE id = $1',
      [binding.reservationId],
    )).rows[0]).toEqual({
      state: 'settled', session_id: null, settlement_reason: 'session_create_failed',
    })
  })

  test('a non-enforcing grant remains durable and recoverable across relay restart', async () => {
    const decision = await reserveConcurrentSession(pool, {
      userId,
      daemonId: 'quota-daemon-a',
      requestId: 'observe-restart-request',
      operation: 'create',
      limit: null,
      agentType: 'codex',
      cwd: '/observe/repo',
    })
    expect(decision.allowed).toBe(true)
    if (!decision.allowed || !decision.reservationId) throw new Error('expected durable observe reservation')

    await new EventMaterializer({ pool }).materialize({
      inboxId: 9_107,
      userId,
      daemonId: 'quota-daemon-a',
      sessionId: 'observe-restart-session',
      eventType: 'session_created',
      payload: {
        type: 'session_created', session_id: 'observe-restart-session',
        request_id: 'observe-restart-request', event_id: 'observe-restart-event',
      },
      context: { requestId: 'observe-restart-request', hostname: 'a' },
    })

    expect((await pool.query(
      'SELECT state, session_id, settlement_reason FROM quota_reservations WHERE id = $1',
      [decision.reservationId],
    )).rows[0]).toEqual({
      state: 'settled', session_id: 'observe-restart-session', settlement_reason: 'session_created',
    })
    expect((await pool.query(
      `SELECT agent_type, cwd FROM sessions WHERE session_id = 'observe-restart-session'`,
    )).rows[0]).toEqual({ agent_type: 'codex', cwd: '/observe/repo' })
  })

  test('a legacy reservation with missing create metadata uses conservative recovered defaults', async () => {
    const binding = await createReservation('legacy-metadata-request')
    await pool.query(
      'UPDATE quota_reservations SET agent_type = NULL, cwd = NULL WHERE id = $1',
      [binding.reservationId],
    )

    await new EventMaterializer({ pool }).materialize({
      inboxId: 9_108,
      userId,
      daemonId: binding.daemonId,
      sessionId: 'legacy-metadata-session',
      eventType: 'session_created',
      payload: {
        type: 'session_created', session_id: 'legacy-metadata-session',
        request_id: binding.requestId, event_id: 'legacy-metadata-event',
      },
      context: { requestId: binding.requestId, hostname: 'a' },
    })

    expect((await pool.query(
      `SELECT agent_type, cwd FROM sessions WHERE session_id = 'legacy-metadata-session'`,
    )).rows[0]).toEqual({ agent_type: 'unknown', cwd: '' })
    expect((await pool.query(
      'SELECT state, settlement_reason FROM quota_reservations WHERE id = $1',
      [binding.reservationId],
    )).rows[0]).toEqual({ state: 'settled', settlement_reason: 'session_created' })
  })

  test('concurrent deferred create outcomes claim one session before either session upsert', async () => {
    const binding = await createReservation('parallel-create-request')
    const materializer = new EventMaterializer({ pool })
    const input = (sessionId: string, inboxId: number) => ({
      inboxId,
      userId,
      daemonId: binding.daemonId,
      sessionId,
      eventType: 'session_created',
      payload: {
        type: 'session_created', session_id: sessionId,
        request_id: binding.requestId, event_id: `event-${sessionId}`,
      },
      context: {
        agentType: 'codex', cwd: '/repo', requestId: binding.requestId,
        reservationId: binding.reservationId, quotaOperation: 'create' as const, hostname: 'a',
      },
    })
    const prepared = await Promise.all([
      materializer.materialize(input('parallel-session-a', 9_109), undefined, { deferEffects: true }),
      materializer.materialize(input('parallel-session-b', 9_110), undefined, { deferEffects: true }),
    ])

    const applied = await Promise.allSettled(prepared.map(async result => {
      await result.applyEffects?.()
      await result.finalizeEffect?.()
    }))
    expect(applied.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(applied.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect((await pool.query(
      `SELECT COUNT(*)::int AS count FROM sessions
       WHERE session_id IN ('parallel-session-a', 'parallel-session-b')`,
    )).rows[0]).toEqual({ count: 1 })
    expect((await pool.query(
      'SELECT session_id, state, settlement_reason FROM quota_reservations WHERE id = $1',
      [binding.reservationId],
    )).rows[0]).toEqual(expect.objectContaining({
      state: 'settled', settlement_reason: 'session_created',
    }))
  })

  test('account deletion removes synthetic quota failure ledgers', async () => {
    const binding = await createReservation('delete-failure-ledger-request')
    await new EventMaterializer({ pool }).materialize({
      inboxId: 9_111,
      userId,
      daemonId: binding.daemonId,
      sessionId: null,
      eventType: 'session_create_failed',
      payload: { type: 'session_create_failed', request_id: binding.requestId, reason: 'start_fail' },
      context: {
        requestId: binding.requestId, reservationId: binding.reservationId,
        quotaOperation: 'create', hostname: 'a',
      },
    })
    expect((await pool.query(
      `SELECT COUNT(*)::int AS count FROM events
       WHERE event_type = 'session_create_failed'
         AND payload->>'request_id' = 'delete-failure-ledger-request'`,
    )).rows[0]).toEqual({ count: 1 })

    const { deleteDaemon, deleteUserAccount } = await import('../db.js')
    await expect(deleteDaemon(pool, userId, binding.daemonId)).resolves.toBe(true)
    await expect(deleteUserAccount(pool, userId)).resolves.toBe(true)
    expect((await pool.query(
      `SELECT COUNT(*)::int AS count FROM events
       WHERE event_type = 'session_create_failed'
         AND payload->>'request_id' = 'delete-failure-ledger-request'`,
    )).rows[0]).toEqual({ count: 0 })
  })

  test.each([
    {
      name: 'session_created', sessionId: 'ungranted-created-session',
      payload: {
        type: 'session_created', session_id: 'ungranted-created-session',
        request_id: 'ungranted-create-request', event_id: 'ungranted-create-event',
      },
    },
    {
      name: 'session_create_failed', sessionId: null,
      payload: {
        type: 'session_create_failed', request_id: 'ungranted-failure-request',
        reason: 'start_fail',
      },
    },
  ])('legacy rejects ungranted $name before ledger or session mutation', async ({ name, sessionId, payload }) => {
    await expect(new EventMaterializer({ pool }).materialize({
      inboxId: 0,
      userId,
      daemonId: 'quota-daemon-a',
      sessionId,
      eventType: name,
      payload,
      context: {
        agentType: 'codex', cwd: '/borrowed/pending/meta',
        requestId: String(payload.request_id), hostname: 'a',
      },
    })).rejects.toMatchObject({ code: 'quota_reservation_binding_mismatch' })

    expect((await pool.query(
      `SELECT COUNT(*)::int AS count FROM events
       WHERE payload->>'request_id' = $1`,
      [payload.request_id],
    )).rows[0]).toEqual({ count: 0 })
    if (sessionId) {
      expect((await pool.query(
        'SELECT COUNT(*)::int AS count FROM sessions WHERE session_id = $1',
        [sessionId],
      )).rows[0]).toEqual({ count: 0 })
    }
  })

  test('durable ingress dead-letters an ungranted create without event, session, or outbox', async () => {
    const repository = new InboxRepository(pool)
    const controller = new IngressController({
      repository,
      sendAck: () => undefined,
      disconnectRetryable: () => undefined,
      setTimer: () => ({ unref() {} }) as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => undefined,
    })
    expect(controller.accept({
      daemonId: 'quota-daemon-a', registrationId: 'ungranted-registration',
      userId, daemonGeneration: 902,
    }, {
      type: 'session_created', session_id: 'ungranted-durable-session',
      request_id: 'ungranted-durable-request', event_id: 'ungranted-durable-event', seq: 1,
    }, {
      requestId: 'ungranted-durable-request', agentType: 'codex',
      cwd: '/borrowed/pending/meta', hostname: 'a',
    })).toMatchObject({ kind: 'accepted' })
    await controller.flushNow()

    const worker = createInboxWorker({
      repository,
      materializer: new EventMaterializer({ pool }),
      outboxWriter: new RealtimeOutboxWriter(pool),
      workerId: 'ungranted-worker',
      shardCount: 1,
      shardIndex: 0,
    })
    await worker.runOnce()

    expect((await pool.query(
      `SELECT status, last_error FROM event_inbox
       WHERE payload->>'request_id' = 'ungranted-durable-request'`,
    )).rows[0]).toEqual({ status: 3, last_error: 'quota_reservation_binding_mismatch' })
    expect((await pool.query(
      `SELECT COUNT(*)::int AS count FROM events
       WHERE payload->>'request_id' = 'ungranted-durable-request'`,
    )).rows[0]).toEqual({ count: 0 })
    expect((await pool.query(
      `SELECT COUNT(*)::int AS count FROM sessions
       WHERE session_id = 'ungranted-durable-session'`,
    )).rows[0]).toEqual({ count: 0 })
    expect((await pool.query(
      `SELECT COUNT(*)::int AS count FROM realtime_outbox
       WHERE request_id = 'ungranted-durable-request'`,
    )).rows[0]).toEqual({ count: 0 })
  })
  test('a claimed create reservation and its active root session count as one slot before settlement', async () => {
    const binding = await createReservation('claimed-window')
    await pool.query("UPDATE quota_reservations SET session_id=$1 WHERE id=$2",[binding.sessionId,binding.reservationId])
    await pool.query("INSERT INTO sessions(session_id,daemon_id,agent_type,cwd,status,user_id) VALUES($1,$2,'codex','/repo','running',$3)",[binding.sessionId,binding.daemonId,userId])
    const snapshot = await getQuotaSnapshot(pool,userId,{maxBoundDaemons:2,maxConcurrentSessions:2})
    expect(snapshot.resources.concurrent_sessions).toMatchObject({used:1,reserved:0})
    await pool.query("UPDATE sessions SET status='exited' WHERE session_id=$1",[binding.sessionId])
    expect(await reserveConcurrentSession(pool,{userId,daemonId:binding.daemonId,sessionId:binding.sessionId!,requestId:'resume-claimed-slot',operation:'resume',limit:1})).toMatchObject({allowed:true})
    expect((await getQuotaSnapshot(pool,userId,{maxBoundDaemons:2,maxConcurrentSessions:1})).resources.concurrent_sessions).toMatchObject({used:0,reserved:1})
  })

})
