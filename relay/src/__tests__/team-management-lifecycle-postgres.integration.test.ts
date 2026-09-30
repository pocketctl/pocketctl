import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import pg from 'pg'
import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { initDB } from '../db.js'
import { TeamRepository } from '../team/repository.js'
import { createTeamRouteService, registerTeamRoutes } from '../team/routes.js'
import { resolveTeamCollaborationConfig } from '../team/config.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const describeWithDatabase = databaseUrl && process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip

describeWithDatabase('Team management lifecycle acceptance (PostgreSQL)', () => {
  let pool: pg.Pool
  beforeAll(async () => {
    const url = new URL(databaseUrl!), database = decodeURIComponent(url.pathname.slice(1))
    if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)
      || !/test/i.test(database) || decodeURIComponent(url.username) !== database || url.searchParams.has('options')) {
      throw new Error('Refusing lifecycle tests outside an isolated loopback test database')
    }
    pool = new pg.Pool({ connectionString: databaseUrl })
    const identity = (await pool.query(`SELECT current_database() AS database, current_user AS "user",
      (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser`)).rows[0]
    if (identity.database !== database || identity.user !== database || identity.superuser) throw new Error('Unexpected test database identity')
    await initDB(pool)
  }, 30_000)
  afterAll(async () => {
    if (pool) { await pool.query('TRUNCATE users, daemons RESTART IDENTITY CASCADE'); await pool.end() }
  })

  async function fixture() {
    const key = randomUUID(), teams = new TeamRepository(pool)
    const emails = [`${key}.owner@example.test`, `${key}.recipient@example.test`]
    const users = (await pool.query(`INSERT INTO users (email,password_hash, team_enabled) VALUES ($1,'x',true),($2,'x',true) RETURNING id`, emails)).rows
    const owner = Number(users[0].id), recipient = Number(users[1].id)
    const created = await teams.createTeam({ actorUserId: owner, name: 'Lifecycle acceptance', requestId: key })
    const inviteInput = { teamId: created.team.id, actorUserId: owner, email: emails[1], expectedRevision: 1, requestId: key }
    const invitation = await teams.invite(inviteInput)
    return { key, teams, emails, owner, recipient, created, inviteInput, invitation }
  }

  test('expired invitation acceptance commits expiry and removes the stale pending item', async () => {
    const f = await fixture()
    // The only write outside product methods is an explicit expired-clock fixture.
    await pool.query("UPDATE collaboration_team_invitations SET expires_at=NOW()-INTERVAL '1 second' WHERE invitation_id=$1", [f.invitation.id])
    await expect(f.teams.respondToInvitation({ invitationId: f.invitation.id, actorUserId: f.recipient, action: 'accepted', expectedRevision: 1, requestId: 'expired' }))
      .rejects.toMatchObject({ code: 'invalid_state' })
    expect((await pool.query('SELECT state FROM collaboration_team_invitations WHERE invitation_id=$1', [f.invitation.id])).rows[0].state).toBe('expired')
    expect(await f.teams.listMyInvitations(f.recipient)).toEqual([])
    expect((await pool.query('SELECT count(*)::int AS n FROM collaboration_team_memberships WHERE team_id=$1 AND user_id=$2', [f.created.team.id,f.recipient])).rows[0].n).toBe(0)
    expect((await pool.query('SELECT count(*)::int AS n FROM collaboration_team_idempotency WHERE user_id=$1 AND request_id=$2',[f.recipient,'expired'])).rows[0].n).toBe(0)
  })
  test('expired pending items disappear before any response while creator history retains the expired invitation', async () => {
    const f = await fixture()
    await pool.query("UPDATE collaboration_team_invitations SET expires_at=NOW()-INTERVAL '1 second' WHERE invitation_id=$1",[f.invitation.id])
    expect(await f.teams.listMyInvitations(f.recipient)).toEqual([])
    expect(await f.teams.listInvitations(f.created.team.id,f.owner)).toMatchObject([{id:f.invitation.id,state:'expired'}])
  })
  test.each(['declined','revoked'] as const)('expired invitation %s commits expiry without a successful action receipt', async action => {
    const f = await fixture()
    await pool.query("UPDATE collaboration_team_invitations SET expires_at=NOW()-INTERVAL '1 second' WHERE invitation_id=$1",[f.invitation.id])
    const input = {invitationId:f.invitation.id,actorUserId:action==='revoked'?f.owner:f.recipient,expectedRevision:1,requestId:'expired-other'}
    await expect(action==='revoked'?f.teams.revokeInvitation(input):f.teams.respondToInvitation({...input,action})).rejects.toMatchObject({code:'invalid_state'})
    expect((await pool.query('SELECT state,revision,responded_at FROM collaboration_team_invitations WHERE invitation_id=$1',[f.invitation.id])).rows[0]).toMatchObject({state:'expired',revision:'2',responded_at:expect.any(Date)})
    expect((await pool.query('SELECT count(*)::int AS n FROM collaboration_team_idempotency WHERE user_id=$1 AND request_id=$2',[input.actorUserId,input.requestId])).rows[0].n).toBe(0)
  })
  test('an unauthorized recipient and stale CAS cannot mutate an expired invitation', async () => {
    const f = await fixture()
    await pool.query("UPDATE collaboration_team_invitations SET expires_at=NOW()-INTERVAL '1 second' WHERE invitation_id=$1",[f.invitation.id])
    const input = {invitationId:f.invitation.id,actorUserId:f.owner,action:'accepted' as const,expectedRevision:1,requestId:'unauthorized'}
    await expect(f.teams.respondToInvitation(input)).rejects.toMatchObject({code:'team_not_found'})
    await expect(f.teams.respondToInvitation({...input,actorUserId:f.recipient,expectedRevision:0,requestId:'stale'})).rejects.toMatchObject({code:'revision_conflict'})
    expect((await pool.query('SELECT state,revision FROM collaboration_team_invitations WHERE invitation_id=$1',[f.invitation.id])).rows[0]).toMatchObject({state:'pending',revision:'1'})
  })
  test('a fresh invite after expiry produces a usable new invitation instead of returning the expired pending row', async () => {
    const f = await fixture()
    await pool.query("UPDATE collaboration_team_invitations SET expires_at=NOW()-INTERVAL '1 second' WHERE invitation_id=$1", [f.invitation.id])
    const fresh = await f.teams.invite({ ...f.inviteInput, expectedRevision: 2, requestId: 'resend' })
    expect(fresh.id).not.toBe(f.invitation.id)
    expect(new Date(fresh.expires_at).getTime()).toBeGreaterThan(Date.now())
    const accepted = await f.teams.respondToInvitation({ invitationId: fresh.id, actorUserId: f.recipient, action: 'accepted', expectedRevision: 1, requestId: 'accept-fresh' })
    expect(accepted.membership?.state).toBe('active')
    expect((await pool.query('SELECT state FROM collaboration_team_invitations WHERE invitation_id=$1',[f.invitation.id])).rows[0].state).toBe('expired')
  })
  test('concurrent resend after expiry admits one usable invitation with one Team revision change', async () => {
    const f = await fixture()
    await pool.query("UPDATE collaboration_team_invitations SET expires_at=NOW()-INTERVAL '1 second' WHERE invitation_id=$1",[f.invitation.id])
    const results = await Promise.allSettled(['resend-one','resend-two'].map(requestId=>f.teams.invite({...f.inviteInput,expectedRevision:2,requestId})))
    expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1)
    expect(results.find(x=>x.status==='rejected')).toMatchObject({reason:{code:'revision_conflict'}})
    const fresh = results.find(x=>x.status==='fulfilled')!
    if(fresh.status!=='fulfilled') throw new Error('No usable invitation')
    expect(fresh.value.id).not.toBe(f.invitation.id)
    expect(await f.teams.getTeam(f.created.team.id,f.owner)).toMatchObject({revision:3})
    expect((await pool.query("SELECT count(*)::int AS n FROM collaboration_team_invitations WHERE team_id=$1 AND state='pending'",[f.created.team.id])).rows[0].n).toBe(1)
    expect((await f.teams.respondToInvitation({invitationId:fresh.value.id,actorUserId:f.recipient,action:'accepted',expectedRevision:1,requestId:'accept-resend'})).membership?.state).toBe('active')
  })
  test.each(['accepted','declined','revoked'] as const)('same %s terminal action remains idempotent with a new request ID; another action conflicts', async action => {
    const f = await fixture()
    const response = (value: 'accepted' | 'declined', requestId: string) => f.teams.respondToInvitation({ invitationId: f.invitation.id, actorUserId: f.recipient, action: value, expectedRevision: 1, requestId })
    const revoke = (requestId: string) => f.teams.revokeInvitation({ invitationId: f.invitation.id, actorUserId: f.owner, expectedRevision: 1, requestId })
    const original = action === 'revoked' ? await revoke('original') : await response(action,'original')
    expect(action === 'revoked' ? await revoke('fresh-id') : await response(action,'fresh-id')).toEqual(original)
    await expect(response(action === 'accepted' ? 'declined' : 'accepted','opposite')).rejects.toMatchObject({ code: 'invalid_state' })
  })
  test('simultaneous accept and decline settle one terminal action without a duplicate membership', async () => {
    const f = await fixture()
    const results = await Promise.allSettled(['accepted','declined'].map(action => f.teams.respondToInvitation({ invitationId: f.invitation.id, actorUserId: f.recipient, action: action as 'accepted' | 'declined', expectedRevision: 1, requestId: action })))
    expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1)
    expect(results.find(x=>x.status==='rejected')).toMatchObject({ reason: { code:'invalid_state' } })
    const current = (await pool.query('SELECT state FROM collaboration_team_invitations WHERE invitation_id=$1',[f.invitation.id])).rows[0]
    expect((await pool.query('SELECT count(*)::int AS n FROM collaboration_team_memberships WHERE team_id=$1 AND user_id=$2',[f.created.team.id,f.recipient])).rows[0].n).toBe(current.state==='accepted'?1:0)
  })
  test.each(['accepted','declined','revoked'] as const)('%s terminal invitation receipts and fresh-ID repeats survive dissolution', async action => {
    const f = await fixture()
    const input = {invitationId:f.invitation.id,actorUserId:action==='revoked'?f.owner:f.recipient,expectedRevision:1,requestId:'terminal'}
    const repeat = (requestId:string) => action==='revoked'?f.teams.revokeInvitation({...input,requestId}):f.teams.respondToInvitation({...input,action,requestId})
    const original = await repeat('terminal')
    await f.teams.dissolveTeam({teamId:f.created.team.id,actorUserId:f.owner,expectedRevision:3,requestId:'dissolve-terminal'})
    expect(await repeat('terminal')).toEqual(original)
    const fresh = await repeat('fresh-terminal')
    expect('invitation' in fresh?fresh.invitation:fresh).toMatchObject({id:f.invitation.id,state:action,revision:2})
    expect((await pool.query("SELECT count(*)::int AS n FROM collaboration_team_memberships WHERE team_id=$1 AND state='active'",[f.created.team.id])).rows[0].n).toBe(0)
  })

  test.each(['rename','invite'] as const)('cached %s denies current Team access after dissolution while dissolve replay still works', async operation => {
    const f = await fixture(), renamedInput = { teamId:f.created.team.id,actorUserId:f.owner,name:'Before dissolution',expectedRevision:2,requestId:'rename' }
    await f.teams.renameTeam(renamedInput)
    const dissolveInput = { teamId:f.created.team.id,actorUserId:f.owner,expectedRevision:3,requestId:'dissolve' }
    const dissolved = await f.teams.dissolveTeam(dissolveInput)
    await expect(f.teams.getTeam(f.created.team.id,f.owner)).rejects.toMatchObject({ code:'team_not_found' })
    await expect(operation==='rename'?f.teams.renameTeam({...renamedInput,requestId:'fresh'}):f.teams.invite({...f.inviteInput,requestId:'fresh',expectedRevision:4})).rejects.toMatchObject({ code:'team_not_found' })
    await expect(operation==='rename'?f.teams.renameTeam(renamedInput):f.teams.invite(f.inviteInput)).rejects.toMatchObject({ code:'team_not_found' })
    await expect(operation==='rename'?f.teams.renameTeam({...renamedInput,name:'Conflicting replay'}):f.teams.invite({...f.inviteInput,email:f.emails[0]})).rejects.toMatchObject({code:'team_not_found'})
    expect(await f.teams.dissolveTeam(dissolveInput)).toEqual(dissolved)
  })
  test.each(['rename','invite'] as const)('authorized cached %s preserves its original receipt after later revisions and invitation acceptance', async operation => {
    const f = await fixture(), input = {teamId:f.created.team.id,actorUserId:f.owner,name:'Original name',expectedRevision:2,requestId:'original-name'}
    const renamed = await f.teams.renameTeam(input)
    await f.teams.respondToInvitation({invitationId:f.invitation.id,actorUserId:f.recipient,action:'accepted',expectedRevision:1,requestId:'accepted-before-replay'})
    await f.teams.renameTeam({...input,name:'Current name',expectedRevision:4,requestId:'current-name'})
    const before = (await pool.query('SELECT to_jsonb(t) AS team FROM collaboration_teams t WHERE team_id=$1',[f.created.team.id])).rows[0]
    expect(operation==='rename'?await f.teams.renameTeam(input):await f.teams.invite(f.inviteInput)).toEqual(operation==='rename'?renamed:f.invitation)
    expect((await pool.query('SELECT to_jsonb(t) AS team FROM collaboration_teams t WHERE team_id=$1',[f.created.team.id])).rows[0]).toEqual(before)
    await expect(operation==='rename'?f.teams.renameTeam({...input,name:'Conflict'}):f.teams.invite({...f.inviteInput,email:f.emails[0]})).rejects.toMatchObject({code:'idempotency_conflict'})
  })
  test.each(['rename','invite'] as const)('cached %s waits for an in-flight Team revocation before authorizing its receipt', async operation => {
    const f = await fixture(), input = {teamId:f.created.team.id,actorUserId:f.owner,name:'Cached name',expectedRevision:2,requestId:'cached-name'}
    await f.teams.renameTeam(input)
    const client = await pool.connect()
    let replay:Promise<unknown>|undefined
    try {
      await client.query('BEGIN')
      const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      // Only the Team revocation is uncommitted; receipt authorization must
      // wait for the real PostgreSQL lock and then re-read current authority.
      await client.query("UPDATE collaboration_teams SET state='dissolved' WHERE team_id=$1",[f.created.team.id])
      replay = (operation==='rename'?f.teams.renameTeam(input):f.teams.invite(f.inviteInput)).then(value=>({value}),error=>({error}))
      await expect.poll(async()=>(await pool.query('SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid])).rowCount!>0,{timeout:1000}).toBe(true)
      await client.query('COMMIT')
      expect(await replay).toMatchObject({error:{code:'team_not_found'}})
    } finally {await client.query('ROLLBACK');await replay;client.release()}
  })

  // This proxy pauses only a real PostgreSQL query after it succeeds. It never
  // supplies fake rows, errors, locks, or transaction outcomes.
  function pauseInvitationRead(invitationId:string) {
    let release!:()=>void, reached!:(pid:number)=>void, paused=false
    const gate = new Promise<void>(resolve=>{release=resolve})
    const held = new Promise<number>(resolve=>{reached=resolve})
    const instrumented = new Proxy(pool, { get(target,key) {
      if(key!=='connect') { const value=Reflect.get(target,key); return typeof value==='function'?value.bind(target):value }
      return async()=> {
        const client=await target.connect(), pid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
        return new Proxy(client,{get(raw,property) {
          if(property!=='query') { const value=Reflect.get(raw,property); return typeof value==='function'?value.bind(raw):value }
          return async(text:string,values?:unknown[])=> {
            const result=await raw.query(text,values)
            if(!paused&&text.includes('FROM collaboration_team_invitations')&&text.includes('FOR UPDATE')&&values?.[0]===invitationId) {
              paused=true; reached(pid); await gate
            }
            return result
          }
        }})
      }
    }})
    return {instrumented,held,release}
  }
  test.each(['accept','decline','revoke'] as const)('%s racing dissolution returns controlled HTTP outcomes without a PostgreSQL deadlock', async action => {
    const f=await fixture(), barrier=pauseInvitationRead(f.invitation.id), app=Fastify()
    registerTeamRoutes(app,{config:resolveTeamCollaborationConfig({TEAM_COLLABORATION:'on'}),service:createTeamRouteService(barrier.instrumented),verifyAccessToken:async token=>({userId:Number(token)}),getDatabaseReady:()=>true})
    let first:Promise<unknown>|undefined, second:Promise<unknown>|undefined
    try {
      first=app.inject({method:action==='revoke'?'DELETE':'POST',url:'/api/team/invitations/'+f.invitation.id+(action==='revoke'?'':'/'+action),headers:{authorization:'Bearer '+(action==='revoke'?f.owner:f.recipient)},payload:{request_id:'first',expected_revision:1}})
      const pid=await barrier.held
      second=app.inject({method:'DELETE',url:'/api/team/teams/'+f.created.team.id,headers:{authorization:'Bearer '+f.owner},payload:{request_id:'dissolve-racing',expected_revision:2}})
      await expect.poll(async()=>(await pool.query('SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid])).rowCount!>0).toBe(true)
      const locks=(await pool.query('SELECT pid,pg_blocking_pids(pid) AS blockers,query FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid])).rows
      barrier.release()
      const outcomes=await Promise.all([first,second]) as Array<{statusCode:number;json:()=>unknown}>
      const directory=process.env.TEAM_LIFECYCLE_REPORT_DIR
      if(directory) {
        if(!['/reports/20260929-management-native-acceptance','/reports/20260929-f28-f30-fix'].includes(directory)) throw new Error('Unexpected acceptance evidence directory')
        writeFileSync(`${directory}/invitation-lock-cycle-${action}.json`,JSON.stringify({action,invitation_id:f.invitation.id,team_id:f.created.team.id,action_transaction_pid:pid,waiting_on_action_transaction:locks,query_result_mocked:false,outcomes:outcomes.map(x=>({status:x.statusCode,body:x.json()}))},null,2))
      }
      expect(outcomes.map(x=>x.statusCode)).not.toContain(500)
      expect(outcomes.every(x=>[200,404,409].includes(x.statusCode))).toBe(true)
      const team=(await pool.query('SELECT state FROM collaboration_teams WHERE team_id=$1',[f.created.team.id])).rows[0]
      expect(team.state).toBe(outcomes[1].statusCode===200?'dissolved':'active')
      if(outcomes[1].statusCode!==200) expect(outcomes[1].json()).toMatchObject({error:{code:'revision_conflict'}})
    } finally {barrier.release();await Promise.all([first,second]);await app.close()}
  },10_000)
})
