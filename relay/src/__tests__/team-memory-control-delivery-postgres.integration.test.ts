import { randomUUID } from 'node:crypto'
import pg from 'pg'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { initDB } from '../db.js'
import { TeamRepository } from '../team/repository.js'
import { TeamMemorySourceProjector } from '../team/memory-source-projector.js'
import { projectFeedBatch } from '../extensions/feed-projector.js'
import { registerFeedRoutes } from '../extensions/feed-routes.js'
import { signProviderExtensionToken } from '../extensions/provider-auth.js'

const url = process.env.RELAY_TEST_DATABASE_URL
const suite = url && process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip
const secret = 'task07-content-free-control-secret', issuer = 'task07-control-test'

suite('Team Memory mandatory content-free cleanup delivery (real HTTP/PostgreSQL)', () => {
  let pool: pg.Pool, app: FastifyInstance, baseUrl: string
  beforeAll(async () => {
    const parsed = new URL(url!)
    if (parsed.hostname !== '127.0.0.1' || parsed.username !== 'pocketctl_relay_upgrade_test'
      || parsed.pathname !== '/pocketctl_relay_upgrade_test' || parsed.search) throw new Error('isolated Relay database required')
    pool = new pg.Pool({ connectionString: url })
    expect((await pool.query(`SELECT current_database() AS db,current_user AS role,
      (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser`)).rows[0])
      .toEqual({ db: 'pocketctl_relay_upgrade_test', role: 'pocketctl_relay_upgrade_test', superuser: false })
    await initDB(pool)
    app = Fastify()
    registerFeedRoutes(app, { pool, mode: 'enabled', providerJwtSecret: secret, issuer,
      cursorSecret: 'task07-control-cursor', leaseTtlSeconds: 30 })
    baseUrl = await app.listen({ host: '127.0.0.1', port: 0 })
  }, 60000)
  afterAll(async () => { await app?.close(); await pool?.end() })
  beforeEach(async () => { await pool.query('TRUNCATE extension_feed,extension_source_outbox,extension_providers,users RESTART IDENTITY CASCADE') })
  async function pull(installation: string, provider = 'pocketctl-memory') {
    const token = signProviderExtensionToken({ providerId: provider, credentialId: 'control-fixture', secret, issuer })
    const response = await fetch(`${baseUrl}/api/extensions/v1/feed?installation_id=${installation}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    return { status: response.status, body: await response.json() as any, token }
  }
  async function ack(installation: string, response: Awaited<ReturnType<typeof pull>>) {
    const result = await fetch(`${baseUrl}/api/extensions/v1/feed/ack`, { method: 'POST',
      headers: { authorization: `Bearer ${response.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ installation_id: installation, cursor: response.body.next_cursor, lease_token: response.body.lease_token }),
    })
    expect(result.status).toBe(200)
  }
  async function fixture() {
    const key = randomUUID(), personal = randomUUID(), target = randomUUID(), session = 'css_' + key, binding = 'cmbd_' + key
    const users = (await pool.query("INSERT INTO users(email,password_hash,team_enabled) VALUES($1,'x',true),($2,'x',true) RETURNING id", [key + '-owner@test.invalid', key + '-reader@test.invalid'])).rows
    const owner = Number(users[0].id), reader = Number(users[1].id), sources = new TeamMemorySourceProjector(true), teams = new TeamRepository(pool, sources)
    const team = (await teams.createTeam({ actorUserId: owner, name: 'Control delivery', requestId: key })).team
    await pool.query('INSERT INTO collaboration_team_memberships(membership_id,team_id,user_id) VALUES($1,$2,$3)', ['cmm_' + key, team.id, reader])
    await pool.query("INSERT INTO extension_providers(provider_id,manifest_version,manifest) VALUES('pocketctl-memory',1,'{}'),('other-provider',1,'{}')")
    await pool.query(`INSERT INTO extension_installations(installation_id,provider_id,owner_user_id,owner_scope_kind,owner_scope_id,status,granted_scopes,subscriptions,enabled_services,event_filter,start_policy)
      VALUES($1,'pocketctl-memory',$2,'personal',$1,'active','{session:events:read}','{session.event.v1}','{memory.manage}','{}','from_now')`, [personal, reader])
    await pool.query(`INSERT INTO extension_installations(installation_id,provider_id,owner_scope_kind,owner_scope_id,status,granted_scopes,subscriptions,enabled_services,event_filter,start_policy)
      VALUES($1,'pocketctl-memory','team',$1,'active','{}','{}','{}','{}','from_now')`, [target])
    await pool.query("INSERT INTO collaboration_sessions(team_session_id,team_id,creator_user_id,title) VALUES($1,$2,$3,'Control delivery')", [session, team.id, owner])
    for (const user of [owner, reader]) await pool.query('INSERT INTO collaboration_session_participants(participant_id,team_session_id,user_id,added_by_user_id) VALUES($1,$2,$3,$4)', ['csp_' + key + user, session, user, owner])
    await pool.query("INSERT INTO team_memory_bindings(binding_id,team_id,owner_scope_kind,owner_scope_id,installation_id,created_by_user_id) VALUES($1,$2,'team',$3,$3,$4)", [binding, team.id, target, owner])
    const daemon = 'daemon_' + key, offer = 'cao_' + key, agentBinding = 'cab_' + key
    await pool.query("INSERT INTO daemons(daemon_id,hostname,agents,status,user_id) VALUES($1,'control-test','[]','online',$2)", [daemon, owner])
    await pool.query("INSERT INTO team_agent_offers(offer_id,team_id,owner_user_id,daemon_id,provider) VALUES($1,$2,$3,$4,'codex')", [offer, team.id, owner, daemon])
    await pool.query('INSERT INTO collaboration_session_agent_bindings(binding_id,team_session_id,offer_id,owner_user_id) VALUES($1,$2,$3,$4)', [agentBinding, session, offer, owner])
    async function capture(label: string) {
      const call = 'ccl_' + randomUUID(), client = await pool.connect()
      try {
        await client.query('BEGIN')
        const seq = Number((await client.query('SELECT latest_event_seq FROM collaboration_sessions WHERE team_session_id=$1 FOR UPDATE', [session])).rows[0].latest_event_seq)
        await client.query("INSERT INTO collaboration_events(event_id,team_session_id,event_seq,kind,author_user_id,content) VALUES($1,$2,$3,'member_message',$4,$5)", [call + '_goal', session, seq + 1, owner, 'CONTROL RAW GOAL ' + label])
        await client.query("INSERT INTO collaboration_calls(call_id,team_session_id,event_id,offer_id,binding_id,context_version,state) VALUES($1,$2,$3,$4,$5,0,'completed')", [call, session, call + '_goal', offer, agentBinding])
        await client.query("INSERT INTO collaboration_events(event_id,team_session_id,event_seq,kind,author_offer_id,call_id,content) VALUES($1,$2,$3,'agent_message',$4,$5,$6),($7,$2,$8,'status',$4,$5,'completed')", [call + '_reply', session, seq + 2, offer, call, 'CONTROL RAW BODY ' + label, call + '_done', seq + 3])
        await client.query('UPDATE collaboration_sessions SET latest_event_seq=$2 WHERE team_session_id=$1', [session, seq + 3])
        expect(await sources.projectCompletedCall(client, call, { id: call + '_done', team_session_id: session, event_seq: seq + 3, kind: 'status', author_user_id: null, author_offer_id: offer, target_mode: null, target_offer_ids: [], reference: null, context_version: null, call_id: call, content: 'completed', created_at: new Date().toISOString() })).toBe(3)
        await client.query('COMMIT')
      } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    }
    async function revoke() { await teams.leaveTeam({ teamId: team.id, actorUserId: reader, expectedRevision: 1, requestId: 'leave' }); await projectFeedBatch(pool, { batchSize: 100 }) }
    return { key, personal, target, session, binding, owner, reader, capture, revoke }
  }
  function assertControls(result: Awaited<ReturnType<typeof pull>>, f: Awaited<ReturnType<typeof fixture>>) {
    expect(result.status).toBe(200)
    expect(result.body.items).toHaveLength(2)
    for (const item of result.body.items) {
      expect(item.topic).toBe('session.access.revoked.v1')
      expect(item.classification).toEqual({})
      expect(Object.keys(item.data).sort()).toEqual(['reason', 'team_id', 'team_session_id', 'team_memory_binding_id', 'team_memory_binding_revision', 'participant_user_id', 'participant_revision'].sort())
      expect(item.data).toMatchObject({ participant_user_id: f.reader, participant_revision: 1, team_memory_binding_id: f.binding })
    }
    expect(JSON.stringify(result.body)).not.toContain('CONTROL RAW')
  }
  test('valid raw-only Memory configuration always receives its Team cleanup controls', async () => {
    const f = await fixture(); await f.capture('raw-only'); await projectFeedBatch(pool, { batchSize: 100 })
    const captured = await pull(f.personal); expect(captured.status).toBe(200); expect(captured.body.items).toHaveLength(3); await ack(f.personal, captured)
    await f.revoke(); const cleanup = await pull(f.personal); assertControls(cleanup, f); await ack(f.personal, cleanup)
    expect((await pull(f.personal)).body.items).toEqual([])
  })
  test.each(['empty', 'event-only'])('withdrawing capture configuration (%s) preserves prior Team cleanup without deletion read permission', async variant => {
    const f = await fixture()
    await pool.query("UPDATE extension_installations SET granted_scopes='{session:events:read,session:deletion:read}',subscriptions='{session.event.v1,session.access.revoked.v1}' WHERE installation_id=$1", [f.personal])
    await f.capture('before-withdrawal'); await projectFeedBatch(pool, { batchSize: 100 }); const captured = await pull(f.personal); expect(captured.body.items).toHaveLength(3); await ack(f.personal, captured)
    if (variant === 'empty') await f.capture('never-authorized-after-withdrawal')
    await pool.query('UPDATE extension_installations SET subscriptions=$2,granted_scopes=$3,config_version=config_version+1 WHERE installation_id=$1', [f.personal, variant === 'empty' ? [] : ['session.event.v1'], variant === 'empty' ? [] : ['session:events:read']])
    await f.revoke(); assertControls(await pull(f.personal), f)
  })
  test('cleanup-only pull excludes ordinary controls, malformed Team packets and unrelated owners', async () => {
    const f = await fixture(); await f.capture('hidden'); await f.revoke()
    const marker = (await pool.query("SELECT * FROM extension_feed WHERE source_kind='session_access_revoked' AND source_id LIKE '%:i%' LIMIT 1")).rows[0]
    const variants = [
      { ...marker.payload, data: { reason: 'ordinary_session_revoked' } },
      { ...marker.payload, data: { ...marker.payload.data, text: 'CONTROL RAW MALICIOUS' } },
      { ...marker.payload, classification: { text: 'CONTROL RAW MALICIOUS' } },
      { ...marker.payload, data: { ...marker.payload.data, participant_user_id: f.owner } },
      { ...marker.payload, data: 'CONTROL RAW MALICIOUS' },
    ]
    for (let i = 0; i < variants.length; i++) {
      const data = variants[i].data, revision = i + 20
      const participant = typeof data === 'object' && data.participant_user_id !== undefined ? data.participant_user_id : f.reader
      const sourceId = `team-access:${f.session}:u${participant}:b1:p${revision}:i${f.binding}`
      const payload = { ...variants[i], source: { ...marker.payload.source, id: sourceId },
        data: typeof data === 'object' ? { ...data, participant_revision: revision } : data }
      await pool.query("INSERT INTO extension_feed(owner_user_id,topic,source_kind,source_id,session_id,payload) VALUES($1,'session.access.revoked.v1','session_access_revoked',$2,$3,$4)", [f.reader, sourceId, marker.session_id, JSON.stringify(payload)])
    }
    await pool.query("INSERT INTO extension_feed(owner_user_id,topic,source_kind,source_id,session_id,payload) VALUES($1,'session.access.revoked.v1','session_access_revoked',$2,$3,$4)", [f.owner, marker.source_id + '-foreign', marker.session_id, JSON.stringify(marker.payload)])
    await pool.query("UPDATE extension_installations SET subscriptions='{}',granted_scopes='{}' WHERE installation_id=$1", [f.personal])
    assertControls(await pull(f.personal), f)
  })
  test('ordinary providers retain their subscription gates and cannot receive Memory mandatory controls', async () => {
    const f = await fixture(); await f.capture('other-provider'); await f.revoke(); const other = randomUUID()
    await pool.query(`INSERT INTO extension_installations(installation_id,provider_id,owner_user_id,status,granted_scopes,subscriptions,enabled_services,event_filter,start_policy)
      VALUES($1,'other-provider',$2,'active','{session:events:read}','{session.lifecycle.v1}','{}','{}','from_now')`, [other, f.reader])
    expect(await pull(other, 'other-provider')).toMatchObject({ status: 200, body: { items: [] } })
    await pool.query("UPDATE extension_installations SET subscriptions='{}',granted_scopes='{}' WHERE installation_id=$1", [other])
    expect(await pull(other, 'other-provider')).toMatchObject({ status: 400, body: { error: { code: 'invalid_request' } } })
    expect(await pull(f.personal, 'other-provider')).toMatchObject({ status: 404 })
  })
  test('nonempty subscriptions with missing content grants remain forbidden', async () => {
    const f = await fixture(); await f.capture('invalid-scope'); await f.revoke()
    await pool.query("UPDATE extension_installations SET granted_scopes='{}' WHERE installation_id=$1", [f.personal])
    expect(await pull(f.personal)).toMatchObject({ status: 403, body: { error: { code: 'forbidden' } } })
  })
})
