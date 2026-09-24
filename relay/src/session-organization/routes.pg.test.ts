import pg from 'pg'
import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

process.env.JWT_SECRET ||= 'session-organization-test-secret'

const { initDB, listSessionsWithChildren, setSessionPin, upsertSession } = await import('../db.js')
const { signAccessToken } = await import('../auth.js')
const { registerSessionOrganizationRoutes } = await import('./routes.js')
const { reserveConcurrentSession } = await import('../quota.js')
const { attachReservedSessionProject } = await import('./attach.js')

const databaseUrl = process.env.TEST_DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RUN_POSTGRES_INTEGRATION === '1')
const testWithDatabase = enabled ? describe : describe.skip

testWithDatabase('session projects, archive, and NEW PostgreSQL contract', () => {
  let pool: pg.Pool
  let app: ReturnType<typeof Fastify>
  let userA: number
  let userB: number
  let tokenA: string
  let tokenB: string
  const suffix = Date.now()
  const request = (method: string, url: string, token: string, payload?: object) => app.inject({
    method: method as any, url, headers: { authorization: `Bearer ${token}` }, payload,
  })

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl })
    const database = (await pool.query('SELECT current_database() AS name')).rows[0].name as string
    if (!/test/i.test(database)) throw new Error('Refusing organization test against a non-test database')
    await initDB(pool)
    const users = await pool.query(`INSERT INTO users(email,password_hash) VALUES($1,'x'),($2,'x') RETURNING id,email`,
      [`org-a-${suffix}@test.invalid`, `org-b-${suffix}@test.invalid`])
    userA = users.rows[0].id; userB = users.rows[1].id
    await pool.query(`INSERT INTO daemons(daemon_id,hostname,status,user_id) VALUES
      ($1,'host A','online',$3),($2,'host B','online',$3)`, [`org-host-a-${suffix}`, `org-host-b-${suffix}`, userA])
    for (const i of [1,2,3]) await pool.query(`INSERT INTO sessions(session_id,daemon_id,user_id,title,source,status)
      VALUES($1,$2,$3,$4,'terminal','running')`, [`org-session-${i}-${suffix}`, `org-host-${i === 3 ? 'b' : 'a'}-${suffix}`, userA, `Session ${i}`])
    tokenA = await signAccessToken(userA, users.rows[0].email)
    tokenB = await signAccessToken(userB, users.rows[1].email)
    app = Fastify()
    registerSessionOrganizationRoutes(app, { pool, broadcast: () => {} })
    await app.ready()
  }, 30_000)
  afterAll(async () => { await app?.close(); await pool?.end() })

  test('account-wide projects and host-filtered counts, with tenant isolation', async () => {
    const created = await request('POST','/api/session-projects',tokenA,{ name: 'Work' })
    expect(created.statusCode).toBe(201)
    const id = created.json().id
    expect((await request('POST','/api/session-projects',tokenA,{ name: 'work' })).statusCode).toBe(409)
    const moved = await request('PUT',`/api/sessions/org-session-3-${suffix}/project`,tokenA,{ project_id:id })
    expect(moved.statusCode).toBe(200)
    expect((await request('PUT',`/api/sessions/org-session-1-${suffix}/project`,tokenB,{ project_id:id })).statusCode).toBe(404)
    expect((await request('PUT',`/api/sessions/org-session-1-${suffix}/project`,tokenA,{ project_id:crypto.randomUUID() })).statusCode).toBe(404)
    const global = (await request('GET','/api/session-projects',tokenA)).json()
    expect(global.projects[0].count).toBe(1)
    const hostA = (await request('GET',`/api/session-projects?daemon_id=org-host-a-${suffix}`,tokenA)).json()
    expect(hostA.projects[0].count).toBe(0)
    expect((await request('GET','/api/session-projects',tokenB)).json().projects).toEqual([])
  })

  test('project rename rejects stale revisions and hidden project IDs', async () => {
    const initial = (await request('GET','/api/session-projects',tokenA)).json().projects[0]
    const renamed = await request('PATCH',`/api/session-projects/${initial.id}`,tokenA,
      {name:'Work notes',expected_revision:Number(initial.revision)})
    expect(renamed.statusCode).toBe(200)
    expect((await request('PATCH',`/api/session-projects/${initial.id}`,tokenA,
      {name:'Stale name',expected_revision:Number(initial.revision)})).statusCode).toBe(409)
    expect((await request('PATCH',`/api/session-projects/${initial.id}`,tokenB,
      {name:'Other account',expected_revision:Number(initial.revision)})).statusCode).toBe(404)
  })

  test('bucket pagination, reorder conflict, archive/restore, and seen', async () => {
    const first = (await request('GET','/api/organized-sessions?bucket=ungrouped&limit=1',tokenA)).json()
    expect(first.sessions).toHaveLength(1)
    expect(first.has_more).toBe(true)
    const second = (await request('GET',`/api/organized-sessions?bucket=ungrouped&limit=1&cursor=${encodeURIComponent(first.next_cursor)}`,tokenA)).json()
    expect(second.sessions[0].session_id).not.toBe(first.sessions[0].session_id)
    const order = await request('PUT','/api/session-order',tokenA,{ bucket:'ungrouped',session_id:second.sessions[0].session_id,before_id:first.sessions[0].session_id,expected_revision:first.revision })
    expect(order.statusCode).toBe(200)
    expect((await request('PUT','/api/session-order',tokenA,{ bucket:'ungrouped',session_id:first.sessions[0].session_id,before_id:null,expected_revision:first.revision })).statusCode).toBe(409)
    const id = first.sessions[0].session_id
    expect((await request('PUT',`/api/sessions/${id}/archive`,tokenA,{archived:true})).statusCode).toBe(200)
    expect((await listSessionsWithChildren(pool,userA)).some(s => s.session_id === id)).toBe(false)
    expect((await request('GET','/api/organized-sessions?view=archived',tokenA)).json().sessions[0].session_id).toBe(id)
    expect(await setSessionPin(pool,userA,id,true)).toBe(false)
    expect((await request('PUT',`/api/sessions/${id}/archive`,tokenA,{archived:false})).statusCode).toBe(200)
    await pool.query('UPDATE sessions SET new_badge_pending=true WHERE session_id=$1',[id])
    expect((await request('PUT',`/api/sessions/${id}/seen`,tokenA)).statusCode).toBe(200)
    expect((await pool.query('SELECT new_badge_pending FROM sessions WHERE session_id=$1',[id])).rows[0].new_badge_pending).toBe(false)
  })

  test('terminal NEW is cutover gated, inserted once, and never reappears after seen', async () => {
    const daemonId = `org-host-a-${suffix}`
    const id = `org-new-${suffix}`
    const cutover = (await pool.query(`SELECT enabled_at FROM session_organization_cutover WHERE key='terminal-new-v1'`)).rows[0].enabled_at as Date
    await upsertSession(pool,id,daemonId,'claude-code','/tmp','running',undefined,'terminal',undefined,userA,
      undefined,undefined,undefined,undefined,undefined,new Date(cutover.getTime()+1000).toISOString())
    expect((await pool.query('SELECT new_badge_pending FROM sessions WHERE session_id=$1',[id])).rows[0].new_badge_pending).toBe(true)
    await request('PUT',`/api/sessions/${id}/seen`,tokenA)
    await upsertSession(pool,id,daemonId,'claude-code','/tmp','idle',undefined,'terminal',undefined,userA,
      undefined,undefined,undefined,undefined,undefined,new Date(cutover.getTime()+1000).toISOString())
    expect((await pool.query('SELECT new_badge_pending FROM sessions WHERE session_id=$1',[id])).rows[0].new_badge_pending).toBe(false)
    const oldId = `org-historical-${suffix}`
    await upsertSession(pool,oldId,daemonId,'claude-code','/tmp','idle',undefined,'terminal',undefined,userA,
      undefined,undefined,undefined,undefined,undefined,new Date(cutover.getTime()-1000).toISOString())
    expect((await pool.query('SELECT new_badge_pending FROM sessions WHERE session_id=$1',[oldId])).rows[0].new_badge_pending).toBe(false)
  })

  test('create request ID retains its project binding across retries', async () => {
    const id = (await pool.query('SELECT id FROM session_projects WHERE user_id=$1 LIMIT 1',[userA])).rows[0].id as string
    const input = { userId:userA, requestId:`org-create-${suffix}`, operation:'create' as const,
      daemonId:`org-host-a-${suffix}`, projectId:id, agentType:'claude-code', cwd:'/tmp', limit:null }
    expect((await reserveConcurrentSession(pool,input)).allowed).toBe(true)
    const reused = await reserveConcurrentSession(pool,input)
    expect(reused.allowed && reused.reused).toBe(true)
    expect(await reserveConcurrentSession(pool,{ ...input, projectId:null })).toEqual({
      allowed:false, reason:'quota_reservation_binding_conflict',
    })
  })

  test('session creation attaches the reserved project exactly once', async () => {
    const projectId = (await pool.query('SELECT id FROM session_projects WHERE user_id=$1 LIMIT 1',[userA])).rows[0].id as string
    const daemonId = `org-host-a-${suffix}`
    const sessionId = `org-created-in-project-${suffix}`
    const requestId = `org-attached-${suffix}`
    const reserved = await reserveConcurrentSession(pool,{userId:userA,requestId,operation:'create',
      daemonId,projectId,agentType:'codex',cwd:'/tmp',limit:null})
    expect(reserved.allowed).toBe(true)
    if (!reserved.allowed || !reserved.reservationId) throw new Error('reservation missing')
    await pool.query(`INSERT INTO sessions(session_id,daemon_id,user_id,title,source,status)
      VALUES($1,$2,$3,'New project session','daemon','running')`,[sessionId,daemonId,userA])
    const before = Number((await pool.query('SELECT revision FROM session_projects WHERE id=$1',[projectId])).rows[0].revision)
    const input = {reservationId:reserved.reservationId,userId:userA,daemonId,requestId,sessionId}
    await attachReservedSessionProject(pool,input)
    await attachReservedSessionProject(pool,input)
    const attached = (await pool.query('SELECT project_id,membership_changed_at FROM sessions WHERE session_id=$1',[sessionId])).rows[0]
    expect(attached.project_id).toBe(projectId)
    expect(attached.membership_changed_at).not.toBeNull()
    expect(Number((await pool.query('SELECT revision FROM session_projects WHERE id=$1',[projectId])).rows[0].revision)).toBe(before+1)
  })

  test('trusted terminal discovery marks a new placeholder unless it was already opened', async () => {
    const daemonId = `org-host-a-${suffix}`
    const started = new Date(Date.now()+1000).toISOString()
    for (const [name, opened] of [['unseen',false],['opened',true]] as const) {
      const id = `org-placeholder-${name}-${suffix}`
      await pool.query(`INSERT INTO sessions(session_id,daemon_id,user_id,agent_type,source,status) VALUES($1,$2,$3,'','daemon','running')`,[id,daemonId,userA])
      if (opened) await request('PUT',`/api/sessions/${id}/seen`,tokenA)
      await upsertSession(pool,id,daemonId,'codex','/tmp','idle',undefined,'terminal',undefined,userA,
        undefined,undefined,undefined,undefined,undefined,started)
      const row = (await pool.query('SELECT source,new_badge_pending FROM sessions WHERE session_id=$1',[id])).rows[0]
      expect(row.source).toBe('terminal')
      expect(row.new_badge_pending).toBe(!opened)
    }
  })

  test('pin changes preserve manual bucket order and invalidate old cursors', async () => {
    const bucket = (await request('GET','/api/organized-sessions?bucket=ungrouped&limit=2',tokenA)).json()
    const first = bucket.sessions[0].session_id as string
    const second = bucket.sessions[1].session_id as string
    if (bucket.order_mode !== 'manual') {
      expect((await request('PUT','/api/session-order',tokenA,{bucket:'ungrouped',session_id:second,
        before_id:first,expected_revision:bucket.revision})).statusCode).toBe(200)
    }
    const beforePin = (await request('GET','/api/organized-sessions?bucket=ungrouped&limit=1',tokenA)).json()
    expect(await setSessionPin(pool,userA,second,true)).toBe(true)
    const afterPin = (await request('GET','/api/organized-sessions?bucket=ungrouped&limit=2',tokenA)).json()
    expect(afterPin.sessions[0].session_id).toBe(second)
    expect(afterPin.revision).toBeGreaterThan(beforePin.revision)
    expect((await request('GET',`/api/organized-sessions?bucket=ungrouped&limit=1&cursor=${encodeURIComponent(beforePin.next_cursor)}`,tokenA)).statusCode).toBe(409)
  })
})
