import { createHash } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { initDB } from '../db.js'
import {
  buildTeamMemorySourceRecords,
  TeamMemorySourceProjector,
  TEAM_MEMORY_SOURCE_KIND,
} from '../team/memory-source-projector.js'

const input = {
  teamId: 'ctm_1',
  teamSessionId: 'css_1',
  callId: 'ccl_1',
  contextVersion: 3,
  binding: {
    id: 'cmbd_1',
    revision: 4,
    installationId: '123e4567-e89b-42d3-a456-426614174000',
    ownerScopeKind: 'team' as const,
    ownerScopeId: '223e4567-e89b-42d3-a456-426614174000',
  },
  goal: {
    eventId: 'cev_goal', eventSeq: 10, content: 'Find the cause', authorUserId: 7,
    occurredAt: new Date('2026-09-26T01:00:00.000Z'),
  },
  reply: {
    eventIds: ['cev_reply_1', 'cev_reply_2'], eventSeqs: [11, 12],
    content: 'The root cause is a stale revision.', authorOfferId: 'cao_1',
    occurredAt: new Date('2026-09-26T01:00:02.000Z'),
  },
  outcome: {
    eventId: 'cev_done', eventSeq: 13, status: 'completed',
    occurredAt: new Date('2026-09-26T01:00:03.000Z'),
  },
  readers: [
    { userId: 7, participantRevision: 2 },
    { userId: 8, participantRevision: 5 },
  ],
}

describe('Team Memory source projection', () => {
  test('maps one Agent reply to one stable personal episode per authorized reader', () => {
    const first = buildTeamMemorySourceRecords(input)
    const replay = buildTeamMemorySourceRecords(input)

    expect(first).toEqual(replay)
    expect(first).toHaveLength(6)
    expect(new Set(first.map(record => record.sourceId)).size).toBe(6)
    expect(new Set(first.map(record => record.sessionId)).size).toBe(2)
    expect(first.every(record => record.sourceKind === TEAM_MEMORY_SOURCE_KIND)).toBe(true)
    expect(first.filter(record => record.payload.source_role === 'reply')).toHaveLength(2)
    expect(first.find(record => record.ownerUserId === 7 && record.payload.source_role === 'reply')?.payload)
      .toMatchObject({
        text: 'The root cause is a stale revision.',
        final: true,
        team_event_ids: ['cev_reply_1', 'cev_reply_2'],
        read_scope: {
          team_id: 'ctm_1', team_session_id: 'css_1',
          team_memory_binding_revision: 4, participant_user_id: 7, participant_revision: 2,
        },
      })
  })

  test('does not copy a private native session identifier or emit empty replies', () => {
    const records = buildTeamMemorySourceRecords(input)
    expect(JSON.stringify(records)).not.toContain('native_session')
    expect(buildTeamMemorySourceRecords({
      ...input,
      reply: { ...input.reply, eventIds: [], eventSeqs: [], content: '' },
    })).toEqual([])
  })

  test('isolates a replacement binding even when its revision restarts at the same value', () => {
    const original = buildTeamMemorySourceRecords(input)
    const rebound = buildTeamMemorySourceRecords({
      ...input, binding: { ...input.binding, id: 'cmbd_rebound' },
    })

    expect(rebound.map(record => record.sessionId))
      .not.toEqual(original.map(record => record.sessionId))
    // Call IDs still deduplicate replay across a binding change.
    expect(rebound.map(record => record.sourceId)).toEqual(original.map(record => record.sourceId))
    expect(rebound[0].payload.read_scope).toMatchObject({
      team_memory_binding_id: 'cmbd_rebound', team_memory_binding_revision: 4,
    })
  })
})

const databaseUrl = process.env.TEST_DATABASE_URL
const integrationEnabled = Boolean(databaseUrl && process.env.RUN_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = integrationEnabled ? describe : describe.skip

describeWithDatabase('Team Memory source projection (PostgreSQL)', () => {
  let pool: pg.Pool

  beforeAll(async () => {
    const url = new URL(databaseUrl!)
    const database = decodeURIComponent(url.pathname.slice(1))
    if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)
      || !database.includes('test') || decodeURIComponent(url.username) !== database) {
      throw new Error('Refusing Team source projection test outside the isolated test database')
    }
    pool = new pg.Pool({ connectionString: databaseUrl })
    const identity = await pool.query<{ database: string; user: string; superuser: boolean }>(`
      SELECT current_database() AS database, current_user AS "user",
             (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser
    `)
    if (identity.rows[0]?.database !== database || identity.rows[0]?.user !== database
      || identity.rows[0]?.superuser) {
      throw new Error('Unexpected Team source projection test database identity')
    }
    await initDB(pool)
  }, 30_000)

  beforeEach(async () => {
    await pool.query(`TRUNCATE extension_source_outbox, extension_providers, users, daemons RESTART IDENTITY CASCADE`)
  })

  afterAll(async () => {
    await pool?.end()
  })

  test('writes one stable three-event source packet and collapses replay', async () => {
    const user = await pool.query<{ id: number }>(`
      INSERT INTO users (email, password_hash, team_enabled) VALUES ('team-source@example.test', 'x',true) RETURNING id
    `)
    const userId = user.rows[0].id
    const installationId = '61616161-6161-4616-8616-616161616161'
    await pool.query(`
      INSERT INTO extension_providers (provider_id, manifest_version, manifest)
      VALUES ('pocketctl-memory', 1, '{}'::jsonb)
    `)
    await pool.query(`
      INSERT INTO extension_installations
        (installation_id, provider_id, owner_user_id, status, granted_scopes,
         subscriptions, enabled_services, event_filter, start_policy)
      VALUES ($1, 'pocketctl-memory', $2, 'active', ARRAY['session:events:read'],
              ARRAY['session.event.v1'], ARRAY['memory.manage'], '{}'::jsonb, 'from_now')
    `, [installationId, userId])
    await pool.query(`
      INSERT INTO collaboration_teams (team_id, name, creator_user_id)
      VALUES ('ctm_source', 'Source Team', ${userId});
      INSERT INTO collaboration_team_memberships (membership_id, team_id, user_id)
      VALUES ('cmb_source', 'ctm_source', ${userId});
      INSERT INTO daemons (daemon_id, hostname, agents, status, user_id)
      VALUES ('daemon-source', 'source-host', '[]'::jsonb, 'online', ${userId});
      INSERT INTO team_agent_offers (offer_id, team_id, owner_user_id, daemon_id, provider)
      VALUES ('cao_source', 'ctm_source', ${userId}, 'daemon-source', 'codex');
      INSERT INTO collaboration_sessions
        (team_session_id, team_id, creator_user_id, title, current_context_version)
      VALUES ('css_source', 'ctm_source', ${userId}, 'Source session', 0);
      INSERT INTO collaboration_session_participants
        (participant_id, team_session_id, user_id, added_by_user_id, revision)
      VALUES ('csp_source', 'css_source', ${userId}, ${userId}, 2);
      INSERT INTO collaboration_session_agent_bindings
        (binding_id, team_session_id, offer_id, owner_user_id)
      VALUES ('cab_source', 'css_source', 'cao_source', ${userId});
      INSERT INTO team_memory_bindings
        (binding_id, team_id, owner_scope_kind, owner_scope_id, installation_id,
         revision, created_by_user_id)
      VALUES ('cmbd_source', 'ctm_source', 'personal', '${installationId}', '${installationId}', 4, ${userId})
    `)
    await pool.query(`
      INSERT INTO collaboration_events
        (event_id, team_session_id, event_seq, kind, author_user_id, context_version, content)
      VALUES ('cev_goal_source', 'css_source', 1, 'member_message', ${userId}, 0, 'Find the root cause');
      INSERT INTO collaboration_calls
        (call_id, team_session_id, event_id, offer_id, binding_id, context_version, state)
      VALUES ('ccl_source', 'css_source', 'cev_goal_source', 'cao_source', 'cab_source', 0, 'completed');
      INSERT INTO collaboration_events
        (event_id, team_session_id, event_seq, kind, author_offer_id, call_id, content)
      VALUES ('cev_reply_source_1', 'css_source', 2, 'agent_message', 'cao_source', 'ccl_source', 'The cause '),
             ('cev_reply_source_2', 'css_source', 3, 'agent_message', 'cao_source', 'ccl_source', 'is stale state.');
      INSERT INTO collaboration_events
        (event_id, team_session_id, event_seq, kind, author_offer_id, call_id, content)
      VALUES ('cev_done_source', 'css_source', 4, 'status', 'cao_source', 'ccl_source', 'completed')
    `)

    const outcome = {
      id: 'cev_done_source', team_session_id: 'css_source', event_seq: 4,
      kind: 'status' as const, author_user_id: null, author_offer_id: 'cao_source',
      target_mode: null, target_offer_ids: [], reference: null, context_version: null,
      call_id: 'ccl_source', content: 'completed', created_at: '2026-09-26T01:00:03.000Z',
    }
    const projector = new TeamMemorySourceProjector(true)
    expect(await projector.projectCompletedCall(pool, 'ccl_source', outcome)).toBe(3)
    expect(await projector.projectCompletedCall(pool, 'ccl_source', outcome)).toBe(0)
    const rows = await pool.query<{ source_id: string; payload: Record<string, unknown> }>(`
      SELECT source_id, payload FROM extension_source_outbox ORDER BY source_id
    `)
    expect(rows.rows).toHaveLength(3)
    expect(rows.rows.find(row => row.source_id.includes(':reply:'))?.payload).toMatchObject({
      text: 'The cause is stale state.',
      team_event_ids: ['cev_reply_source_1', 'cev_reply_source_2'],
      context_version: 0,
      read_scope: { team_memory_binding_revision: 4, participant_revision: 2 },
    })
    expect(JSON.stringify(rows.rows)).not.toContain('native_session')

    const originalSessionId = buildTeamMemorySourceRecords({
      ...input, teamSessionId: 'css_source', readers: [{ userId, participantRevision: 2 }],
      binding: { ...input.binding, id: 'cmbd_source' },
    })[0].sessionId
    const legacySessionId = 'team_' + createHash('sha256')
      .update('css_source:4:2').digest('hex').slice(0, 32)
    expect(originalSessionId).not.toBe(legacySessionId)
    expect(await projector.revokeTeamBinding(pool, {
      teamId: 'ctm_source', bindingId: 'cmbd_source', bindingRevision: 4,
    })).toBe(2)
    expect(await projector.revokeTeamBinding(pool, {
      teamId: 'ctm_source', bindingId: 'cmbd_source', bindingRevision: 4,
    })).toBe(0)
    const revoked = await pool.query<{ session_id: string }>(`
      SELECT session_id FROM extension_source_outbox WHERE source_kind = 'session_access_revoked'
    `)
    expect(new Set(revoked.rows.map(row => row.session_id)))
      .toEqual(new Set([originalSessionId, legacySessionId]))

    await pool.query(`
      UPDATE team_memory_bindings SET state = 'removed', revision = 5 WHERE binding_id = 'cmbd_source';
      INSERT INTO team_memory_bindings
        (binding_id, team_id, owner_scope_kind, owner_scope_id, installation_id, revision, created_by_user_id)
      VALUES ('cmbd_rebound', 'ctm_source', 'personal', '${installationId}', '${installationId}', 4, ${userId});
      INSERT INTO collaboration_events
        (event_id, team_session_id, event_seq, kind, author_user_id, context_version, content)
      VALUES ('cev_goal_rebound', 'css_source', 5, 'member_message', ${userId}, 0, 'Check the new binding');
      INSERT INTO collaboration_calls
        (call_id, team_session_id, event_id, offer_id, binding_id, context_version, state)
      SELECT 'ccl_rebound', team_session_id, 'cev_goal_rebound', offer_id, binding_id, context_version, state
      FROM collaboration_calls WHERE call_id = 'ccl_source';
      INSERT INTO collaboration_events
        (event_id, team_session_id, event_seq, kind, author_offer_id, call_id, content)
      VALUES ('cev_reply_rebound', 'css_source', 6, 'agent_message', 'cao_source', 'ccl_rebound', 'New binding reply'),
             ('cev_done_rebound', 'css_source', 7, 'status', 'cao_source', 'ccl_rebound', 'completed')
    `)
    expect(await projector.projectCompletedCall(pool, 'ccl_source', outcome)).toBe(0)
    expect(await projector.projectCompletedCall(pool, 'ccl_rebound', {
      ...outcome, id: 'cev_done_rebound', event_seq: 7, call_id: 'ccl_rebound',
    })).toBe(3)
    const reboundRows = await pool.query<{ session_id: string }>(`
      SELECT session_id FROM extension_source_outbox WHERE source_kind = $1 AND source_id LIKE 'team:ccl_rebound:%'
    `, [TEAM_MEMORY_SOURCE_KIND])
    expect(reboundRows.rows).toHaveLength(3)
    const reboundSessionId = reboundRows.rows[0].session_id
    expect(reboundSessionId).not.toBe(originalSessionId)
    expect(reboundSessionId).not.toBe(legacySessionId)
    expect(await projector.revokeReaderSession(pool, {
      teamSessionId: 'css_source', userId, participantRevision: 2, reason: 'participant_removed',
    })).toBe(1)
    expect((await pool.query(`
      SELECT session_id FROM extension_source_outbox WHERE source_kind = 'session_access_revoked'
    `)).rows.map(row => row.session_id)).toContain(reboundSessionId)
  })
})
