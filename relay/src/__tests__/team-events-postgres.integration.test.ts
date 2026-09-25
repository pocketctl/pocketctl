import pg from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { initDB } from '../db.js'
import { TeamRepository, TeamRepositoryError } from '../team/repository.js'
import { TeamSessionService } from '../team/session-service.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RUN_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = enabled ? describe : describe.skip

describeWithDatabase('Team shared events (PostgreSQL)', () => {
  let pool: pg.Pool

  beforeAll(async () => {
    const url = new URL(databaseUrl!)
    const database = decodeURIComponent(url.pathname.slice(1))
    if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)
      || !/test/i.test(database) || decodeURIComponent(url.username) !== database) {
      throw new Error('Refusing Team event integration test outside the isolated test database')
    }
    pool = new pg.Pool({ connectionString: databaseUrl })
    const identity = await pool.query<{ database: string; user: string; superuser: boolean }>(`
      SELECT current_database() AS database, current_user AS "user",
             (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser
    `)
    if (identity.rows[0]?.database !== database || identity.rows[0]?.user !== database || identity.rows[0]?.superuser) {
      throw new Error('Unexpected Team event test database identity')
    }
    await initDB(pool)
  }, 30_000)

  afterAll(async () => {
    if (pool) {
      await pool.query(`TRUNCATE users, daemons RESTART IDENTITY CASCADE`)
      await pool.end()
    }
  })

  test('persists fixed targets, replay cursors, lifecycle fences, and participant revocation', async () => {
    const users = await pool.query<{ id: number; email: string }>(
      `INSERT INTO users (email, password_hash) VALUES
        ('event.creator@example.test', 'x'), ('event.member@example.test', 'x')
       RETURNING id, email`,
    )
    const creatorId = users.rows.find(row => row.email.startsWith('event.creator'))!.id
    const memberId = users.rows.find(row => row.email.startsWith('event.member'))!.id
    const repository = new TeamRepository(pool)
    const created = await repository.createTeam({ actorUserId: creatorId, name: 'Event team', requestId: 'event-team-create' })
    const teamId = created.team.id
    const invitation = await repository.invite({ teamId, actorUserId: creatorId, email: 'event.member@example.test', expectedRevision: 1, requestId: 'event-invite' })
    await repository.respondToInvitation({ invitationId: invitation.id, actorUserId: memberId, action: 'accepted', expectedRevision: 1, requestId: 'event-accept' })

    await pool.query(
      `INSERT INTO daemons (daemon_id, hostname, agents, status, user_id, collaboration_capabilities) VALUES
       ('event-daemon-one', 'one', '[{"type":"codex","manageable":true}]'::jsonb, 'online', $1, '["team_collaboration_dispatch_v1","team_collaboration_context_v1"]'::jsonb),
       ('event-daemon-two', 'two', '[{"type":"claude-code","manageable":true}]'::jsonb, 'online', $2, '["team_collaboration_dispatch_v1","team_collaboration_context_v1"]'::jsonb)`,
      [creatorId, memberId],
    )
    const firstOffer = await repository.addAgentOffer({ teamId, actorUserId: creatorId, daemonId: 'event-daemon-one', provider: 'codex', runtimeProfileId: null, expectedRevision: 3, requestId: 'event-offer-one' })
    const secondOffer = await repository.addAgentOffer({ teamId, actorUserId: memberId, daemonId: 'event-daemon-two', provider: 'claude-code', runtimeProfileId: null, expectedRevision: 4, requestId: 'event-offer-two' })

    const notifications: Array<{ users: number[]; seq: number }> = []
    const revoked: number[] = []
    const service = new TeamSessionService(pool, {
      event: (_sessionId, participantUserIds, event) => notifications.push({ users: participantUserIds, seq: event.event_seq }),
      revoked: (_sessionId, userId) => revoked.push(userId),
    })
    const session = await service.createSession({
      teamId, actorUserId: creatorId, title: 'Shared investigation', taskId: null,
      offerIds: [firstOffer.id, secondOffer.id], requestId: 'event-session-create',
    })
    expect(session.participants.map(participant => participant.user_id)).toEqual([creatorId, memberId])
    expect(session.agent_bindings).toHaveLength(2)

    const first = await service.appendMessage({
      sessionId: session.id, actorUserId: creatorId, requestId: 'event-message-one', content: 'Compare both approaches',
      targetMode: 'all', targetOfferIds: [], referenceEventId: null,
    })
    expect(first.event).toMatchObject({ event_seq: 1, author_user_id: creatorId, target_mode: 'all' })
    expect(first.event.target_offer_ids.sort()).toEqual([firstOffer.id, secondOffer.id].sort())
    expect(first.call_ids).toHaveLength(2)
    expect(notifications).toEqual([{ users: [creatorId, memberId], seq: 1 }])

    const replayed = await service.appendMessage({
      sessionId: session.id, actorUserId: creatorId, requestId: 'event-message-one', content: 'Compare both approaches',
      targetMode: 'all', targetOfferIds: [], referenceEventId: null,
    })
    expect(replayed.event.id).toBe(first.event.id)
    expect(replayed.call_ids.sort()).toEqual(first.call_ids.sort())
    expect((await pool.query(`SELECT latest_event_seq FROM collaboration_sessions WHERE team_session_id = $1`, [session.id])).rows[0].latest_event_seq).toBe('1')

    await expect(service.appendMessage({
      sessionId: session.id, actorUserId: creatorId, requestId: 'event-message-one', content: 'Changed content',
      targetMode: 'all', targetOfferIds: [], referenceEventId: null,
    })).rejects.toMatchObject({ code: 'idempotency_conflict' })

    const discussion = await service.appendMessage({
      sessionId: session.id, actorUserId: memberId, requestId: 'event-message-two', content: 'Human note',
      targetMode: 'discussion', targetOfferIds: [], referenceEventId: first.event.id,
    })
    expect(discussion).toMatchObject({ event: { event_seq: 2, reference: { event_id: first.event.id, event_seq: 1 } }, call_ids: [] })
    const page = await service.listEvents(session.id, memberId, 0, 1)
    expect(page.events.map(event => event.event_seq)).toEqual([1])
    expect(page.next_cursor).toBe(1)
    const next = await service.listEvents(session.id, memberId, page.next_cursor!, 10)
    expect(next.events.map(event => event.event_seq)).toEqual([2])

    const filtered = await service.listSessions(teamId, memberId, { daemonId: 'event-daemon-one', provider: 'codex' })
    expect(filtered.map(item => item.id)).toEqual([session.id])

    const bindingRemoved = await service.changeBinding({ sessionId: session.id, actorUserId: memberId, offerId: secondOffer.id, active: false, expectedRevision: 1, requestId: 'remove-own-binding' })
    expect(bindingRemoved.revision).toBe(2)
    const participantRemoved = await service.removeParticipant({ sessionId: session.id, actorUserId: creatorId, userId: memberId, expectedRevision: 2, requestId: 'remove-participant' })
    expect(participantRemoved.revision).toBe(3)
    expect(revoked).toEqual([memberId])
    await expect(service.listEvents(session.id, memberId, 0, 10)).rejects.toBeInstanceOf(TeamRepositoryError)

    const paused = await service.updateSession({ sessionId: session.id, actorUserId: creatorId, state: 'paused', expectedRevision: 3, requestId: 'pause-session' })
    expect(paused.state).toBe('paused')
    await expect(service.appendMessage({
      sessionId: session.id, actorUserId: creatorId, requestId: 'message-while-paused', content: 'blocked',
      targetMode: 'discussion', targetOfferIds: [], referenceEventId: null,
    })).rejects.toMatchObject({ code: 'invalid_state' })
  })
})
