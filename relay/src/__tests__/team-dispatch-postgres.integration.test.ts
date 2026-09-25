import pg from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { initDB } from '../db.js'
import { TeamDispatchRepository } from '../team/dispatch-repository.js'
import { TeamContextDeliveryService } from '../team/context-delivery.js'
import { TeamContextService } from '../team/context-service.js'
import { TeamRepository } from '../team/repository.js'
import { TeamSessionService } from '../team/session-service.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RUN_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = enabled ? describe : describe.skip

describeWithDatabase('Team dispatch state machine (PostgreSQL)', () => {
  let pool: pg.Pool

  beforeAll(async () => {
    const url = new URL(databaseUrl!)
    const database = decodeURIComponent(url.pathname.slice(1))
    if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)
      || !/test/i.test(database) || decodeURIComponent(url.username) !== database) {
      throw new Error('Refusing Team dispatch integration test outside the isolated test database')
    }
    pool = new pg.Pool({ connectionString: databaseUrl })
    const identity = await pool.query<{ database: string; user: string; superuser: boolean }>(`
      SELECT current_database() AS database, current_user AS "user",
             (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser
    `)
    if (identity.rows[0]?.database !== database || identity.rows[0]?.user !== database || identity.rows[0]?.superuser) {
      throw new Error('Unexpected Team dispatch test database identity')
    }
    await initDB(pool)
  }, 30_000)

  afterAll(async () => {
    if (pool) {
      await pool.query(`TRUNCATE users, daemons RESTART IDENTITY CASCADE`)
      await pool.end()
    }
  })

  test('claims once, serializes a binding, and projects only allowlisted events', async () => {
    const user = await pool.query<{ id: number }>(
      `INSERT INTO users (email, password_hash) VALUES ('dispatch.owner@example.test', 'x') RETURNING id`,
    )
    const ownerUserId = user.rows[0].id
    const teams = new TeamRepository(pool)
    const created = await teams.createTeam({ actorUserId: ownerUserId, name: 'Dispatch team', requestId: 'dispatch-team' })
    await pool.query(
      `INSERT INTO daemons (daemon_id, hostname, agents, status, user_id, collaboration_capabilities)
       VALUES ('dispatch-daemon', 'dispatch-host', '[{"type":"codex","manageable":true}]'::jsonb,
               'online', $1, '["team_collaboration_dispatch_v1","team_collaboration_context_v1","team_collaboration_reconcile_v1"]'::jsonb)`,
      [ownerUserId],
    )
    const offer = await teams.addAgentOffer({
      teamId: created.team.id, actorUserId: ownerUserId, daemonId: 'dispatch-daemon', provider: 'codex',
      runtimeProfileId: null, expectedRevision: 1, requestId: 'dispatch-offer',
    })
    const sessions = new TeamSessionService(pool)
    const shared = await sessions.createSession({
      teamId: created.team.id, actorUserId: ownerUserId, title: 'Dispatch session', taskId: null,
      offerIds: [offer.id], requestId: 'dispatch-session',
    })
    const contexts = new TeamContextService(pool)
    const context = await contexts.create({
      sessionId: shared.id, actorUserId: ownerUserId, expectedRevision: 0, requestId: 'context-v1',
      goal: 'Produce a safe recommendation', consensus: ['Use explicit capability checks'],
      openQuestions: ['Which provider completes first?'], references: [],
    })
    expect(context.context).toMatchObject({ version: 1, revision: 1, goal: 'Produce a safe recommendation' })
    expect(await contexts.get(shared.id, ownerUserId)).toMatchObject({ id: context.context.id, content_hash: context.context.content_hash })
    await expect(contexts.create({
      sessionId: shared.id, actorUserId: ownerUserId, expectedRevision: 0, requestId: 'stale-context',
      goal: 'Overwrite', consensus: [], openQuestions: [], references: [],
    })).rejects.toMatchObject({ code: 'context_revision_conflict', currentRevision: 1 })
    const firstMessage = await sessions.appendMessage({
      sessionId: shared.id, actorUserId: ownerUserId, requestId: 'dispatch-message-1', content: 'Investigate',
      targetMode: 'all', targetOfferIds: [], referenceEventId: null,
    })
    const repository = new TeamDispatchRepository(pool)
    const first = await repository.claim(firstMessage.call_ids[0])
    expect(first).toMatchObject({
      provider: 'codex', nativeSessionId: null,
      authorization: { owner_user_id: ownerUserId, daemon_id: 'dispatch-daemon', operation: 'create' },
    })
    const deliveries = new TeamContextDeliveryService(pool)
    const delivery = await deliveries.prepare(first!.callId)
    expect(delivery).toMatchObject({ context_version: 1, content_hash: context.context.content_hash, truncated: false })
    expect(delivery.stable_text).toContain('Goal: Produce a safe recommendation')
    expect(delivery.stable_text).toContain('Consensus: Use explicit capability checks')
    await deliveries.markDispatched(first!.callId)
    expect(await deliveries.recordReceipt({
      callId: first!.callId, daemonId: 'dispatch-daemon', ownerUserId,
      contextVersion: 1, contentHash: delivery.content_hash, payloadHash: delivery.payload_hash,
      accepted: true, outcome: null,
    })).toBe(true)
    expect((await pool.query(`SELECT state FROM collaboration_context_deliveries WHERE call_id = $1`, [first!.callId])).rows[0].state).toBe('accepted')
    expect(await repository.claim(firstMessage.call_ids[0])).toBeNull()
    expect(await repository.bindNativeSession(first!.callId, 'dispatch-daemon', ownerUserId, 'native-team-session')).toBe(true)
    expect(await repository.recordReceipt(first!.callId, 'dispatch-daemon', ownerUserId, 'accepted', null)).toBe(true)

    const secondMessage = await sessions.appendMessage({
      sessionId: shared.id, actorUserId: ownerUserId, requestId: 'dispatch-message-2', content: 'Overlap',
      targetMode: 'all', targetOfferIds: [], referenceEventId: null,
    })
    expect(await repository.claim(secondMessage.call_ids[0])).toBeNull()
    expect((await pool.query(`SELECT state, outcome FROM collaboration_calls WHERE call_id = $1`, [secondMessage.call_ids[0]])).rows[0])
      .toMatchObject({ state: 'blocked', outcome: 'native_session_busy' })

    const projected = await repository.projectDaemonEvent('dispatch-daemon', ownerUserId, {
      type: 'agent_text', session_id: 'native-team-session', seq: 10, text: 'Shared answer',
    })
    expect(projected?.event).toMatchObject({ kind: 'agent_message', content: 'Shared answer', author_offer_id: offer.id })
    expect(await repository.projectDaemonEvent('dispatch-daemon', ownerUserId, {
      type: 'tool_call', session_id: 'native-team-session', seq: 11, text: 'private tool input',
    })).toBeNull()
    expect(await repository.projectDaemonEvent('dispatch-daemon', ownerUserId, {
      type: 'agent_text', session_id: 'native-team-session', seq: 10, text: 'Shared answer',
    })).toBeNull()
    const terminal = await repository.projectDaemonEvent('dispatch-daemon', ownerUserId, {
      type: 'turn_status', session_id: 'native-team-session', seq: 12, status: 'completed',
    })
    expect(terminal?.event).toMatchObject({ kind: 'status', content: 'completed' })
    expect((await pool.query(`SELECT state FROM collaboration_calls WHERE call_id = $1`, [first!.callId])).rows[0].state).toBe('completed')
    const contextV2 = await contexts.create({
      sessionId: shared.id, actorUserId: ownerUserId, expectedRevision: 1, requestId: 'context-v2',
      goal: 'Produce the final recommendation', consensus: ['The first call completed'], openQuestions: [],
      references: [{
        source_kind: 'team_event', source_id: firstMessage.event.id,
        source_version: String(firstMessage.event.event_seq), owner_scope_id: null, installation_id: null,
      }],
    })
    expect(contextV2.context.version).toBe(2)
    expect((await pool.query(
      `SELECT context_version, context_snapshot_hash FROM collaboration_calls WHERE call_id = $1`, [first!.callId],
    )).rows[0]).toMatchObject({ context_version: '1', context_snapshot_hash: context.context.content_hash })
  })
})
