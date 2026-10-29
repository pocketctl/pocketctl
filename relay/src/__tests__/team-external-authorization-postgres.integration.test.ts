import pg from 'pg'
import {TeamExternalStopService} from '../team/external-stop.js'
import { TeamSessionService } from '../team/session-service.js'
import { TeamRepository } from '../team/repository.js'
import { beforeAll, beforeEach, afterAll, describe, test, expect } from 'vitest'
import { initDB } from '../db.js'
import { humanTeamFixture } from './fixtures/team-v2.js'
import { TeamDispatchRepository } from '../team/dispatch-repository.js'
import { TeamExternalAuthorizationService } from '../team/external-authorization.js'
import { TeamExternalRecoveryService } from '../team/external-recovery.js'
import { TeamExternalUsageService } from '../team/external-usage.js'

const enabled = process.env.RUN_POSTGRES_INTEGRATION === '1' && Boolean(process.env.TEST_DATABASE_URL)
;(enabled ? describe : describe.skip)('external execution current authority', () => {
  let pool: pg.Pool
  beforeAll(async () => {
    const url = new URL(process.env.TEST_DATABASE_URL!)
    if (url.hostname !== '127.0.0.1' || url.port !== '19030' || url.pathname !== '/team_relay_test' || url.username !== 'team_relay_test') throw Error('dedicated disposable database required')
    pool = new pg.Pool({ connectionString: url.href })
    expect((await pool.query('SELECT rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0].rolsuper).toBe(false)
    await initDB(pool)
  }, 30000)
  beforeEach(async () => { await pool.query('TRUNCATE users,daemons RESTART IDENTITY CASCADE') })
  afterAll(async () => { await pool?.end() })

  async function fixture() {
    const f = await humanTeamFixture(pool), owner = f.users[0], daemon = 'external-daemon', offer = 'external-offer'
    await pool.query(`INSERT INTO daemons(daemon_id,hostname,status,user_id,agents,collaboration_capabilities) VALUES($1,'isolated','online',$2,'[{"type":"agentteams","manageable":true}]','["team_collaboration_dispatch_v1","team_collaboration_context_v1","team_external_agentteams_v1"]')`, [daemon, owner])
    await pool.query(`INSERT INTO team_agent_offers(offer_id,team_id,owner_user_id,daemon_id,provider) VALUES($1,$2,$3,$4,'agentteams')`, [offer, f.teamId, owner, daemon])
    f.service = new TeamSessionService(pool, {}, undefined, undefined, () => true, team => team === f.teamId)
    await f.service.changeBinding({ sessionId: f.session.id, actorUserId: owner, offerId: offer, active: true, expectedRevision: f.session.revision, requestId: 'bind' })
    const message = await f.service.appendMessage({ sessionId: f.session.id, actorUserId: f.users[1], requestId: 'request', content: 'One external invocation', targetMode: 'offers', targetOfferIds: [offer], referenceEventId: null, contextVersion: 0 })
    const repo = new TeamDispatchRepository(pool, undefined, undefined, () => true)
    const claimed = (await repo.claim(message.call_ids[0]))!
    expect(claimed).toBeTruthy()
    const body = { authorization: claimed.authorization, request_id: claimed.providerRequestId, native_session_id: '', phase: 'prepare' as 'prepare' | 'execute' | 'observe' }
    const service = new TeamExternalAuthorizationService(pool, () => true)
    const authorize = () => service.authorize(owner, daemon, claimed.callId, body)
    return { ...f, owner, daemon, offer, repo, claimed, body, service, authorize }
  }

  async function recoveryFixture() {
    const f = await fixture()
    await f.repo.bindNativeSession(f.claimed.callId, f.daemon, f.owner, 'owned-native')
    await f.repo.recordReceipt(f.claimed.callId, f.daemon, f.owner, 'accepted', null)
    const recovery = new TeamExternalRecoveryService(pool, () => true, () => true)
    const enqueue = (request_id: string, action: 'query' | 'retry_original' = 'query', expected_query_id?: string) =>
      recovery.enqueue(f.owner, f.session.id, f.claimed.callId, {request_id, action, ...(expected_query_id ? {expected_query_id} : {})})
    const report = (operation_id: string, state: 'absent' | 'unknown' | 'running') => recovery.report(f.owner, f.daemon, f.claimed.callId, {
      ...f.body, native_session_id: 'owned-native', phase: 'account', operation_id,
      result: {state, remote_task_id: state === 'running' ? 'project/task' : null},
    })
    return {...f, recovery, enqueue, report}
  }

  test.each(['ordered','late-receipt','other-generation','report-replay'] as const)('uncertain terminal uses durable transport receipt order: %s', async mode => {
    const f = await recoveryFixture()
    await pool.query("UPDATE collaboration_calls SET state='uncertain',outcome='daemon_disconnected' WHERE call_id=$1",[f.claimed.callId])
    const receipt = {type:'collaboration_dispatch_receipt',session_id:'owned-native',seq:30,status:'accepted',collaboration:f.claimed.authorization}
    const terminal = {type:'turn_status',session_id:'owned-native',seq:3,turn_status:'completed',turn_id:'original-turn',source_turn_id:'project/task'}
    const insert = async (generation:number,seq:number,payload:Record<string,unknown>) => (await pool.query(`INSERT INTO event_inbox(user_id,daemon_id,daemon_generation,seq,dedup_key,session_id,event_type,priority_class,payload,status) VALUES($1,$2,$3,$4,$5,'owned-native',$6,0,$7,2) RETURNING inbox_id`,[f.owner,f.daemon,generation,seq,`${f.claimed.callId}:${generation}:${seq}`,payload.type,payload])).rows[0].inbox_id
    const acceptedID=await insert(1,30,receipt),terminalID=await insert(2,3,terminal)
    await pool.query('INSERT INTO event_inbox_receipt(inbox_id,daemon_id,daemon_generation,seq) VALUES($1,$2,$3,$4),($5,$2,2,3)',[acceptedID,f.daemon,mode==='other-generation'?3:2,mode==='late-receipt'?4:2,terminalID])
    if(mode==='report-replay') {
      let first=true
      const recovery=new TeamExternalRecoveryService(pool,()=>true,()=>true,async(daemon,owner,call,remote,state)=>{
        if(first){first=false;throw new Error('projection unavailable after durable report')}
        await f.repo.reconcileExternalTerminal(daemon,owner,call,remote,state)
      })
      await recovery.enqueue(f.owner,f.session.id,f.claimed.callId,{request_id:'recover-terminal',action:'query'})
      const report={...f.body,native_session_id:'owned-native',phase:'account' as const,operation_id:'recover-terminal',result:{state:'succeeded' as const,remote_task_id:'project/task'}}
      await expect(recovery.report(f.owner,f.daemon,f.claimed.callId,report)).rejects.toThrow('projection unavailable')
      expect((await pool.query('SELECT state FROM team_external_recovery_operations WHERE call_id=$1',[f.claimed.callId])).rows[0].state).toBe('done')
      expect(await f.repo.reconcileExternalTerminal(f.daemon,f.owner,f.claimed.callId,'different/task','succeeded')).toBeNull()
      await recovery.report(f.owner,f.daemon,f.claimed.callId,report)
      await recovery.report(f.owner,f.daemon,f.claimed.callId,report)
      expect((await pool.query('SELECT state FROM collaboration_calls WHERE call_id=$1',[f.claimed.callId])).rows[0].state).toBe('completed')
      expect((await pool.query("SELECT count(*)::int n FROM collaboration_events WHERE call_id=$1 AND kind='status' AND content='completed'",[f.claimed.callId])).rows[0].n).toBe(1)
      return
    }
    const projected=await f.repo.projectDaemonEvent(f.daemon,f.owner,terminal,2)
    if(mode==='ordered') {
      expect(projected?.event).toMatchObject({call_id:f.claimed.callId,content:'completed'})
      expect(await f.repo.projectDaemonEvent(f.daemon,f.owner,terminal,2)).toBeNull()
    } else expect(projected).toBeNull()
    expect((await pool.query('SELECT state FROM collaboration_calls WHERE call_id=$1',[f.claimed.callId])).rows[0].state).toBe(mode==='ordered'?'completed':'uncertain')
  })

  test('confirmed stop accounting survives binding revocation without restoring execution authority', async()=>{
    const f=await recoveryFixture(),stops=new TeamExternalStopService(pool)
    await pool.query("UPDATE collaboration_session_agent_bindings SET state='removed',revision=revision+1 WHERE binding_id=$1",[f.claimed.authorization.binding_id])
    const input={authorization:f.claimed.authorization,request_id:f.body.request_id,native_session_id:'owned-native',state:'cancelled' as const}
    await expect(stops.record(f.users[1],f.daemon,f.claimed.callId,input)).rejects.toMatchObject({code:'team_access_denied'})
    await expect(stops.record(f.owner,f.daemon,f.claimed.callId,{...input,request_id:'replacement'})).rejects.toMatchObject({code:'team_access_denied'})
    await stops.record(f.owner,f.daemon,f.claimed.callId,input)
    await stops.record(f.owner,f.daemon,f.claimed.callId,input)
    expect((await pool.query('SELECT state,outcome FROM collaboration_calls WHERE call_id=$1',[f.claimed.callId])).rows[0]).toEqual({state:'failed',outcome:'external_stop_confirmed'})
    expect((await pool.query("SELECT count(*)::int n FROM collaboration_events WHERE call_id=$1 AND content='interrupted'",[f.claimed.callId])).rows[0].n).toBe(1)
    await expect(f.service.authorize(f.owner,f.daemon,f.claimed.callId,{...f.body,native_session_id:'owned-native',phase:'execute'})).rejects.toMatchObject({code:'team_access_denied'})
  })

  test('availability follows the same allowlist across candidates, offers and session bindings', async () => {
    const f = await fixture()
    const closed = new TeamRepository(pool)
    const opened = new TeamRepository(pool, undefined, team => team === f.teamId)
    expect((await closed.listAgentCandidates(f.teamId, f.owner)).find(c=>c.provider==='agentteams')).toMatchObject({availability:'unsupported',managed_callable:false})
    expect((await opened.listAgentCandidates(f.teamId, f.owner)).find(c=>c.provider==='agentteams')).toMatchObject({availability:'online',managed_callable:true})
    expect((await closed.listAgentOffers(f.teamId, f.owner)).find(c=>c.id===f.offer)).toMatchObject({availability:'unsupported',managed_callable:false})
    expect((await opened.listAgentOffers(f.teamId, f.owner)).find(c=>c.id===f.offer)).toMatchObject({availability:'online',managed_callable:true})
    expect((await new TeamSessionService(pool).getSession(f.session.id,f.owner)).agent_bindings.find(b=>b.offer_id===f.offer)).toMatchObject({availability:'unsupported'})
    expect((await new TeamSessionService(pool, {}, undefined, undefined, () => true, team => team === f.teamId).getSession(f.session.id,f.owner)).agent_bindings.find(b=>b.offer_id===f.offer)).toMatchObject({availability:'online'})
  })

  test('recovery persists one original command and requires fresh exact absence before retry', async () => {
    const f = await recoveryFixture()
    await expect(f.enqueue('retry', 'retry_original', 'missing')).rejects.toMatchObject({code:'invalid_state'})
    expect(await f.enqueue('query')).toMatchObject({can_query:false, can_retry_original:false, operation:{state:'pending'}})
    await f.enqueue('query')
    await expect(f.enqueue('query', 'retry_original', 'missing')).rejects.toMatchObject({code:'idempotency_conflict'})
    await expect(f.enqueue('other')).rejects.toMatchObject({code:'source_busy'})
    expect(await f.recovery.pending(f.owner, f.daemon)).toMatchObject({commands:[{call_id:f.claimed.callId, operation_id:'query', original_request_id:f.body.request_id}]})
    await f.report('query', 'absent')
    await f.report('query', 'absent')
    await expect(f.report('query', 'unknown')).rejects.toMatchObject({code:'revision_conflict'})
    expect(await f.recovery.get(f.owner, f.session.id, f.claimed.callId)).toMatchObject({can_retry_original:true})
    await expect(f.enqueue('retry', 'retry_original', 'wrong-query')).rejects.toMatchObject({code:'invalid_state'})
    await f.enqueue('retry', 'retry_original', 'query')
    await expect(f.report('retry', 'absent')).rejects.toMatchObject({code:'invalid_request'})
    await f.report('retry', 'running')
    expect((await pool.query('SELECT call_id FROM collaboration_calls')).rows).toEqual([{call_id:f.claimed.callId}])
    expect((await pool.query('SELECT count(*)::int n FROM team_external_recovery_operations')).rows[0].n).toBe(2)
  })

  test.each(['unknown', 'expired', 'settled'])('recovery %s never authorizes another submit', async scenario => {
    const f = await recoveryFixture()
    await f.enqueue('query')
    if (scenario === 'unknown') await f.report('query', 'unknown')
    if (scenario === 'expired') {
      await pool.query("UPDATE team_external_recovery_operations SET expires_at=NOW()-INTERVAL '1 second'")
      await expect(f.report('query', 'absent')).rejects.toMatchObject({code:'invalid_state'})
      expect((await f.recovery.pending(f.owner, f.daemon)).commands).toHaveLength(0)
    }
    if (scenario === 'settled') {
      await f.report('query', 'absent')
      await pool.query("UPDATE collaboration_calls SET state='completed'")
    }
    expect(await f.recovery.get(f.owner, f.session.id, f.claimed.callId)).toMatchObject({can_retry_original:false})
    await expect(f.enqueue('retry', 'retry_original', 'query')).rejects.toMatchObject({code:'invalid_state'})
    if (scenario === 'expired') expect(await f.enqueue('new-query')).toMatchObject({operation:{request_id:'new-query',state:'pending'}})
  })

  test('recovery absence expires and concurrent commands serialize', async () => {
    const f = await recoveryFixture()
    const outcomes = await Promise.allSettled([f.enqueue('one'), f.enqueue('two')])
    expect(outcomes.filter(x => x.status === 'fulfilled')).toHaveLength(1)
    const pending = (await f.recovery.pending(f.owner, f.daemon)).commands[0]
    await f.report(pending.operation_id, 'absent')
    await pool.query("UPDATE team_external_recovery_operations SET updated_at=NOW()-INTERVAL '3 minutes'")
    await expect(f.enqueue('retry', 'retry_original', pending.operation_id)).rejects.toMatchObject({code:'invalid_state'})
  })

  test('recovery current owner, participant and full frozen grants gate results', async () => {
    const f = await recoveryFixture()
    await expect(f.recovery.enqueue(f.users[1], f.session.id, f.claimed.callId, {request_id:'other',action:'query'})).rejects.toMatchObject({code:'team_access_denied'})
    await f.enqueue('query')
    const disabled = new TeamExternalRecoveryService(pool, () => false, () => true)
    expect((await disabled.pending(f.owner, f.daemon)).commands).toHaveLength(0)
    await expect(disabled.enqueue(f.owner, f.session.id, f.claimed.callId, {request_id:'off',action:'query'})).rejects.toMatchObject({code:'team_access_denied'})
    await pool.query("UPDATE collaboration_session_participants SET state='removed' WHERE user_id=$1", [f.owner])
    expect((await f.recovery.pending(f.owner, f.daemon)).commands).toHaveLength(0)
    await expect(f.report('query', 'absent')).rejects.toMatchObject({code:'team_access_denied'})
    await pool.query("UPDATE collaboration_session_participants SET state='active' WHERE user_id=$1", [f.owner])
    await pool.query("UPDATE collaboration_team_memberships SET state='removed' WHERE user_id=$1", [f.users[1]])
    await expect(f.report('query', 'absent')).rejects.toMatchObject({code:'team_access_denied'})
    expect((await pool.query('SELECT state FROM team_external_recovery_operations')).rows[0].state).toBe('pending')
  })

  test('late external usage is idempotent, immutable and currently authorized', async () => {
    const f = await fixture()
    await f.repo.bindNativeSession(f.claimed.callId,f.daemon,f.owner,'owned-native')
    await f.repo.recordReceipt(f.claimed.callId,f.daemon,f.owner,'accepted',null)
    await pool.query("UPDATE collaboration_calls SET state='completed' WHERE call_id=$1",[f.claimed.callId])
    await pool.query("INSERT INTO sessions(session_id,daemon_id,user_id,agent_type) VALUES('owned-native',$1,$2,'agentteams')",[f.daemon,f.owner])
    const service=new TeamExternalUsageService(pool,()=>true,()=>true)
    const body={...f.body,native_session_id:'owned-native',phase:'account' as const,remote_task_id:'project/task',usage:{chat_id:'chat-1',session_id:'matrix:!room:local',turns:[{original_id:'turn-1',model:'m',finished_at:new Date().toISOString(),input_tokens:20,output_tokens:10,cache_read_tokens:80,cache_create_tokens:0,total_tokens:110}]}}
    const first=await service.record(f.owner,f.daemon,f.claimed.callId,body)
    expect(first.recorded_turns).toBe(1)
    await Promise.all(Array.from({length:5},()=>service.record(f.owner,f.daemon,f.claimed.callId,body)))
    expect((await pool.query('SELECT count(*)::int n,SUM(input+output+cache_read+cache_create)::text tokens FROM token_usage_facts')).rows[0]).toEqual({n:1,tokens:'110'})
    expect((await pool.query("SELECT tok_input::text,tok_output::text,tok_cache_read::text,total_tokens::text FROM sessions WHERE session_id='owned-native'")).rows[0]).toEqual({tok_input:'20',tok_output:'10',tok_cache_read:'80',total_tokens:'110'})
    await expect(service.record(f.owner,f.daemon,f.claimed.callId,{...body,usage:{...body.usage,turns:[{...body.usage.turns[0],model:'rewritten'}]}})).rejects.toMatchObject({code:'revision_conflict'})
    await pool.query("UPDATE collaboration_team_memberships SET state='removed' WHERE user_id=$1",[f.owner])
    await expect(service.record(f.owner,f.daemon,f.claimed.callId,body)).rejects.toMatchObject({code:'team_access_denied'})
    expect((await pool.query('SELECT count(*)::int n FROM token_usage_facts')).rows[0].n).toBe(1)
  })

  test('a settled step is not classified as revoked during recovery', async () => {
    const f=await fixture()
    await pool.query("UPDATE collaboration_calls SET state='completed' WHERE call_id=$1",[f.claimed.callId])
    // Exercise the settled-step projection on top of real current membership,
    // owner, daemon and binding rows; recovery must receive settled, not 403.
    const projected={query:async(text:string,values:unknown[])=>{
      const result=await pool.query(text,values)
      for(const row of result.rows){row.delivery_attempt_id='settled-attempt';row.attempt_state='accepted'}
      return result
    }} as unknown as Pick<pg.Pool,'query'>
    const authority=new TeamExternalAuthorizationService(projected,()=>true,()=>true)
    await expect(authority.authorize(f.owner,f.daemon,f.claimed.callId,{...f.body,phase:'observe'})).rejects.toMatchObject({code:'external_call_settled'})
    await pool.query("UPDATE collaboration_team_memberships SET state='removed' WHERE user_id=$1",[f.owner])
    await expect(authority.authorize(f.owner,f.daemon,f.claimed.callId,{...f.body,phase:'observe'})).rejects.toMatchObject({code:'team_access_denied'})
  })

  test('requires registration and accepted receipt before execute; observe cannot authorize another submit', async () => {
    const f = await fixture()
    expect(await f.authorize()).toMatchObject({ authorized: true, phase: 'prepare', call_id: f.claimed.callId })
    f.body.phase = 'execute'; f.body.native_session_id = 'owned-native'
    await expect(f.authorize()).rejects.toMatchObject({ code: 'external_call_not_ready' })
    await f.repo.bindNativeSession(f.claimed.callId, f.daemon, f.owner, 'owned-native')
    await expect(f.authorize()).rejects.toMatchObject({ code: 'external_call_not_ready' })
    await f.repo.recordReceipt(f.claimed.callId, f.daemon, f.owner, 'accepted', null)
    expect(await f.authorize()).toMatchObject({ authorized: true, phase: 'execute' })
    await f.repo.markDaemonUncertain(f.daemon)
    await expect(f.authorize()).rejects.toMatchObject({ code: 'external_call_not_ready' })
    f.body.phase = 'observe'
    expect(await f.authorize()).toMatchObject({ authorized: true, phase: 'observe' })
    f.body.native_session_id = 'another-native'
    await expect(f.authorize()).rejects.toMatchObject({ code: 'team_access_denied' })
  })

  test('default-off claim stays pending and disabling after claim prevents transport handoff', async () => {
    const f = await fixture()
    let sent = false
    const disabled = new TeamDispatchRepository(pool)
    expect(await disabled.sendIfEnabled(f.claimed.callId, () => { sent = true; return true })).toBe('unavailable')
    expect(sent).toBe(false)
    await pool.query("UPDATE collaboration_calls SET state='pending' WHERE call_id=$1", [f.claimed.callId])
    expect(await disabled.claim(f.claimed.callId)).toBeNull()
    expect((await pool.query('SELECT state FROM collaboration_calls WHERE call_id=$1', [f.claimed.callId])).rows[0].state).toBe('pending')
    expect(await f.repo.claim(f.claimed.callId)).toMatchObject({ callId: f.claimed.callId, provider: 'agentteams' })
  })

  test('missing original Call and unknown operation never grant authority', async () => {
    const f = await fixture()
    await expect(f.service.authorize(f.owner, f.daemon, 'missing-original', f.body)).rejects.toMatchObject({ code: 'team_access_denied' })
    f.body.phase = 'retry' as typeof f.body.phase
    await expect(f.authorize()).rejects.toMatchObject({ code: 'invalid_request' })
  })

  test.each(['owner-access', 'initiator-access', 'initiator-membership', 'owner-viewer', 'offer-revision', 'binding-revision', 'offer-revoked', 'session-removed', 'daemon-owner', 'feature-off', 'request-id', 'call-id', 'delivery-injected', 'completed', 'capability-removed'])('denies %s without creating another Call', async scenario => {
    const f = await fixture(), call = f.claimed.callId
    if (scenario === 'owner-access') await pool.query('UPDATE users SET team_enabled=false WHERE id=$1', [f.owner])
    if (scenario === 'initiator-access') await pool.query('UPDATE users SET team_enabled=false WHERE id=$1', [f.users[1]])
    if (scenario === 'initiator-membership') await pool.query("UPDATE collaboration_team_memberships SET state='removed' WHERE user_id=$1", [f.users[1]])
    if (scenario === 'owner-viewer') await pool.query("UPDATE collaboration_team_memberships SET role='viewer' WHERE user_id=$1", [f.owner])
    if (scenario === 'offer-revision') await pool.query('UPDATE team_agent_offers SET revision=revision+1')
    if (scenario === 'binding-revision') await pool.query('UPDATE collaboration_session_agent_bindings SET revision=revision+1')
    if (scenario === 'offer-revoked') await pool.query("UPDATE team_agent_offers SET state='revoked'")
    if (scenario === 'session-removed') await pool.query("UPDATE collaboration_sessions SET state='archived'")
    if (scenario === 'daemon-owner') await pool.query('UPDATE daemons SET user_id=$1', [f.users[2]])
    if (scenario === 'request-id') f.body.request_id = 'another-request'
    if (scenario === 'call-id') f.body.authorization.call_id = 'another-call'
    if (scenario === 'delivery-injected') f.body.authorization.delivery = { task_id: 'injected', spec_revision: 1 }
    if (scenario === 'completed') await pool.query("UPDATE collaboration_calls SET state='completed'")
    if (scenario === 'capability-removed') await pool.query("UPDATE daemons SET collaboration_capabilities='[]'")
    const action = scenario === 'feature-off' ? new TeamExternalAuthorizationService(pool, () => false).authorize(f.owner, f.daemon, call, f.body) : f.authorize()
    await expect(action).rejects.toMatchObject({ code: scenario === 'completed' ? 'external_call_settled' : 'team_access_denied' })
    expect((await pool.query('SELECT call_id FROM collaboration_calls')).rows).toEqual([{ call_id: call }])
  })
})
