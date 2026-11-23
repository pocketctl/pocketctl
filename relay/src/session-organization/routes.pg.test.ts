import pg from 'pg'
import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

process.env.JWT_SECRET ||= 'session-organization-test-secret'

const { initDB, insertEvent, listSessionsWithChildren, setSessionPin, upsertSession } = await import('../db.js')
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

  test('receipt lookup reports only durable evidence for the requested owner and session', async () => {
    const sessionId = `org-session-1-${suffix}`
    const otherId = `org-session-2-${suffix}`
    const events: Array<[string, string, Record<string, unknown>]> = [
      [sessionId, 'user_message_receipt', { request_id: 'accepted-1', status: 'accepted', text: 'private prompt' }],
      [sessionId, 'user_message_receipt', { msg_id: 'rejected-1', status: 'rejected' }],
      [sessionId, 'user_text', { msg_id: 'echo-1', text: 'confirmed by the canonical echo' }],
      [sessionId, 'user_text', { msg_id: 'child-1', agent_id: 'child', text: 'different actor' }],
      [otherId, 'user_message_receipt', { msg_id: 'other-1', status: 'accepted' }],
    ]
    for (const [id, type, event] of events) {
      await insertEvent(pool, id, type, event)
    }
    const path = `/api/sessions/${sessionId}/message-receipts?ids=accepted-1,rejected-1,echo-1,child-1,other-1,missing-1`
    const response = await request('GET', path, tokenA)
    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(Object.fromEntries(response.json().receipts.map((r: any) => [r.request_id, r.status]))).toEqual({
      'accepted-1': 'accepted', 'rejected-1': 'rejected', 'echo-1': 'accepted',
      'child-1': 'unknown', 'other-1': 'unknown', 'missing-1': 'unknown',
    })
    expect(response.body).not.toContain('private prompt')
    expect((await request('GET', path, tokenB)).statusCode).toBe(404)
    expect((await request('GET', path.replace(/ids=.*/, 'ids=a%20b'), tokenA)).statusCode).toBe(400)
  })

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

  test('pull refresh limits each host across projects and reuses a successful scoped response for five seconds', async () => {
    const host = `org-host-a-${suffix}`
    const ids = Array.from({length: 5}, (_, n) => `pull-${n}-${suffix}`)
    const project = (await request('GET','/api/session-projects',tokenA)).json().projects[0].id
    try {
      for (const [n, id] of ids.entries()) await pool.query(
        `INSERT INTO sessions(session_id,daemon_id,user_id,title,project_id,last_activity_at)
         VALUES($1::text,$2,$3,$1::text,$4,'2090-01-01'::date + $5::int)`, [id,host,userA,n % 2 ? project : null,n])
      const url = '/api/session-list-refresh'
      const all = (await request('GET',url,tokenA)).json()
      expect(all.sessions.filter((s: any) => s.daemon_id === host).map((s: any) => s.session_id)).toEqual(ids.slice(-3).reverse())
      expect(all.sessions.some((s: any) => s.daemon_id !== host)).toBe(true)
      const scoped = url + '?daemon_id=' + host
      // Subtract the connections used for per-request authorization. The
      // concurrent cold burst should acquire just one extra snapshot client.
      async function burst() {
        let acquisitions = 0
        const acquired = () => { acquisitions++ }
        pool.on('acquire', acquired)
        try {
          const replies = await Promise.all(Array.from({ length: 4 }, () => request('GET', scoped, tokenA)))
          const page = replies[0].json()
          for (const response of replies) {
            expect(response.statusCode).toBe(200)
            expect(response.json()).toEqual(page)
          }
          return { acquisitions, page }
        } finally { pool.off('acquire', acquired) }
      }
      const cold = await burst()
      const hot = await burst()
      expect(cold.acquisitions - hot.acquisitions).toBe(1)
      const first = cold.page
      expect(first.sessions).toHaveLength(3)
      expect(first.counts.every((c: any) => c.daemon_id === host)).toBe(true)
      await pool.query('UPDATE sessions SET title=$1 WHERE session_id=$2',['changed',ids[4]])
      expect((await request('GET',scoped,tokenA)).json()).toEqual(first)
      expect((await request('GET',scoped,tokenB)).json().sessions).toEqual([])
      await new Promise(resolve => setTimeout(resolve, 5050))
      expect((await request('GET',scoped,tokenA)).json().sessions[0].title).toBe('changed')
    } finally { await pool.query('DELETE FROM sessions WHERE session_id=ANY($1)',[ids]) }
  }, 15_000)

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
