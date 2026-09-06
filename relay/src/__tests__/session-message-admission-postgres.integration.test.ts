import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { initDB, deleteSession, deleteDaemon, deleteUserAccount, consolidateOfflineMachineDaemons, renameOwnedDaemonSession } from '../db.js'
import * as admissionModule from '../session-message-admissions.js'
import { SESSION_STATUS_SUPPRESSED_EFFECT_STEP } from '../db.js'
import { admitSessionMessage } from '../session-message-admissions.js'
import { getQuotaSnapshot, reserveConcurrentSession } from '../quota.js'
import { resolveEntitlements } from '../entitlements.js'
import { Router } from '../router.js'
import { EventMaterializer } from '../materialization/event-materializer.js'

const enabled = process.env.RUN_POSTGRES_INTEGRATION === '1' && process.env.TEST_DATABASE_URL
const suite = enabled ? describe : describe.skip
suite('durable session message admission PostgreSQL', () => {
  let pool: pg.Pool
  let userId: number
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL })
    const db = await pool.query('SELECT current_database() AS name')
    if (!/test/i.test(db.rows[0].name)) throw new Error('test database required')
    await initDB(pool)
  }, 30000)
  afterAll(async () => { await pool?.end() })
  beforeEach(async () => {
    await pool.query('TRUNCATE deleted_sessions, users, daemons, sessions, quota_reservations, events, event_inbox, realtime_outbox RESTART IDENTITY CASCADE')
    userId = (await pool.query("INSERT INTO users(email,password_hash) VALUES('admission@test.invalid','x') RETURNING id")).rows[0].id
    await pool.query("INSERT INTO daemons(daemon_id,hostname,status,user_id) VALUES('admission-daemon','test','online',$1)", [userId])
    await pool.query("INSERT INTO sessions(session_id,daemon_id,agent_type,cwd,source,status,user_id) VALUES('admission-session','admission-daemon','codex','/repo','daemon','running',$1),('other-active','admission-daemon','codex','/repo','daemon','running',$1)", [userId])
  })
  function socket(): any { const sent: any[] = []; return { readyState: 1, send: vi.fn((raw: string) => sent.push(JSON.parse(raw))), close: vi.fn(), _sent: sent } }
  async function route() {
    const router = new Router(pool)
    const daemon = socket(), client = socket()
    await router.registerDaemon(daemon, { type: 'register', daemon_id: 'admission-daemon', hostname: 'test', agents: [], supports_quota_grant: true }, userId)
    router.registerClient(client, userId)
    daemon._sent.length = 0
    const command = { type: 'user_message', session_id: 'admission-session', msg_id: 'message-1', content: 'continue' }
    await router.handleClientMessage(client, command)
    const sent = daemon._sent.find((m: any) => m.type === 'user_message')
    expect(sent).toBeTruthy()
    return { router, daemon, client, command, sent }
  }
  test('reconstructed legacy RequiresResume outcome recovers persisted authorization and delivers at full quota', async () => {
    const { daemon, sent } = await route()
    const result = await new EventMaterializer({ pool }).materialize({ inboxId: 99001, userId, daemonId: 'admission-daemon', sessionId: 'admission-session', eventType: 'session_status', payload: { type: 'session_status', session_id: 'admission-session', request_id: sent.request_id, status: 'running' } })
    expect(result.deliveries.some(d => d.type === 'session_status')).toBe(true)
    expect(daemon.close).not.toHaveBeenCalled()
    expect((await pool.query('SELECT count(*)::int AS n FROM quota_reservations')).rows[0].n).toBe(0)
  })
  test('legacy ordinary message needs no lifecycle receipt and duplicate must not forward twice', async () => {
    const { router, client, daemon, command } = await route()
    await router.handleClientMessage(client, command)
    expect(daemon._sent.filter((m: any) => m.type === 'user_message')).toHaveLength(1)
  })
  async function snapshot() { return (await getQuotaSnapshot(pool,userId,resolveEntitlements('free',false))).resources.concurrent_sessions }
  async function admit(requestId: string, content = 'continue', sessionId = 'admission-session') {
    return admitSessionMessage(pool,{ userId,daemonId:'admission-daemon',sessionId,requestId,limit:2,
      command:{type:'user_message',session_id:sessionId,msg_id:requestId,content} })
  }
  test('unresolved legacy grants stay one held slot across inactive transitions and expiry', async () => {
    await admit('one'); await admit('two')
    expect(await snapshot()).toMatchObject({used:2,reserved:0})
    await pool.query("UPDATE session_message_admissions SET expires_at = NOW() - interval '1 hour'")
    await pool.query("UPDATE sessions SET status='exited' WHERE session_id='admission-session'")
    expect(await snapshot()).toMatchObject({used:1,reserved:1})
    await admit('one') // Standalone expiry maintenance, outside any session fence.
    expect((await pool.query("SELECT state FROM session_message_admissions")).rows.every(r => r.state === 'uncertain')).toBe(true)
    expect(await reserveConcurrentSession(pool,{userId,daemonId:'admission-daemon',requestId:'new-session',operation:'create',limit:2})).toMatchObject({allowed:false,reason:'concurrent_session_quota_exceeded'})
    expect(await admit('three')).toMatchObject({kind:'resume',decision:{allowed:true}})
    expect(await snapshot()).toMatchObject({used:1,reserved:1})
    expect(await admit('four')).toMatchObject({kind:'resume',decision:{allowed:true}})
    expect(await snapshot()).toMatchObject({used:1,reserved:1})
  })
  test('late active outcome and its replay recover after expiry without another slot', async () => {
    await admit('late')
    await pool.query("UPDATE session_message_admissions SET expires_at = NOW() - interval '1 hour', state='uncertain'")
    const input = {inboxId:99002,userId,daemonId:'admission-daemon',sessionId:'admission-session',eventType:'session_status',payload:{type:'session_status',session_id:'admission-session',request_id:'late',status:'running'}}
    await new EventMaterializer({pool}).materialize(input)
    await new EventMaterializer({pool}).materialize(input)
    expect((await pool.query('SELECT state,outcome FROM session_message_admissions')).rows[0]).toEqual({state:'completed',outcome:'session_active'})
    expect(await snapshot()).toMatchObject({used:2,reserved:0})
  })
  test('changed content and cross-session replay reject while exact retry is reused', async () => {
    expect(await admit('same')).toMatchObject({kind:'continue',reused:false})
    expect(await admit('same')).toMatchObject({kind:'continue',reused:true})
    expect(await admit('same','different')).toEqual({kind:'conflict'})
    expect(await admit('same','continue','other-active')).toEqual({kind:'conflict'})
    expect(await reserveConcurrentSession(pool,{userId,daemonId:'admission-daemon',requestId:'same',operation:'create',limit:null})).toMatchObject({allowed:false,reason:'quota_reservation_binding_conflict'})
    await reserveConcurrentSession(pool,{userId,daemonId:'admission-daemon',requestId:'create-first',operation:'create',limit:null})
    expect(await admit('create-first')).toMatchObject({kind:'resume',decision:{allowed:false,reason:'quota_reservation_binding_conflict'}})
  })
  test('continue admission never authorizes create lifecycle or wrong session/daemon', async () => {
    await admit('bound')
    const base = {inboxId:99003,userId,daemonId:'admission-daemon',sessionId:'admission-session',eventType:'session_status',payload:{request_id:'bound',status:'running'}}
    for (const changed of [{eventType:'session_created'}, {eventType:'session_create_failed'}, {sessionId:'other-active'}, {daemonId:'other-daemon'}, {userId:userId+1}]) {
      await expect(new EventMaterializer({pool}).materialize({...base,...changed})).rejects.toMatchObject({code:'quota_reservation_binding_mismatch'})
    }
  })
  test('deletion completes holds and tombstone prevents late replay resurrection', async () => {
    await admit('deleted')
    await deleteSession(pool,'admission-session')
    expect((await pool.query('SELECT state,outcome FROM session_message_admissions')).rows[0]).toEqual({state:'completed',outcome:'user_deleted'})
    await expect(new EventMaterializer({pool}).materialize({inboxId:99004,userId,daemonId:'admission-daemon',sessionId:'admission-session',eventType:'session_status',payload:{request_id:'deleted',status:'running'}})).rejects.toMatchObject({code:'unknown_daemon_session'})
    expect(await snapshot()).toMatchObject({used:1,reserved:0})
  })
  test.each(['accepted','rejected'])('exact %s receipt completes only its command', async status => {
    await admit('receipt'); await admit('other-message')
    await new EventMaterializer({pool}).materialize({inboxId:99005,userId,daemonId:'admission-daemon',sessionId:'admission-session',eventType:'user_message_receipt',payload:{type:'user_message_receipt',request_id:'receipt',msg_id:'receipt',status}})
    const rows = (await pool.query('SELECT request_id,state FROM session_message_admissions ORDER BY request_id')).rows
    expect(rows).toEqual([{request_id:'other-message',state:'issued'},{request_id:'receipt',state:'completed'}])
  })

  test('actual legacy Router ingress materializes and delivers running without rejecting the connection', async () => {
    const {router,daemon,client,sent} = await route()
    router.handleDaemonMessage('admission-daemon',{type:'session_status',session_id:'admission-session',request_id:sent.request_id,status:'running'})
    await vi.waitFor(() => expect(client._sent.some((m:any) => m.type === 'session_status')).toBe(true))
    expect(daemon.close).not.toHaveBeenCalled()
    expect(await snapshot()).toMatchObject({used:2,reserved:0})
  })
  test.each([['rejected','accepted'],['accepted','rejected'],['rejected','session_active'],['session_active','rejected']])('contradictory %s then %s outcome rejects before another event is persisted', async (first,second) => {
    await admit('contradict')
    const outcome = (status:string,inboxId:number) => ({inboxId,userId,daemonId:'admission-daemon',sessionId:'admission-session',eventType:status === 'session_active' ? 'session_status' : 'user_message_receipt',payload:{request_id:'contradict',msg_id:'contradict',status:status === 'session_active' ? 'running' : status}})
    await new EventMaterializer({pool}).materialize(outcome(first,99100))
    await expect(new EventMaterializer({pool}).materialize(outcome(second,99101))).rejects.toMatchObject({code:'quota_reservation_binding_mismatch'})
    expect((await pool.query('SELECT outcome FROM session_message_admissions')).rows[0].outcome).toBe(first)
  })
  test('accepted receipt after inactive transition retains uncertain hold until correlated running', async () => {
    await admit('race')
    await pool.query("UPDATE sessions SET status='exited' WHERE session_id='admission-session'")
    await new EventMaterializer({pool}).materialize({inboxId:99200,userId,daemonId:'admission-daemon',sessionId:'admission-session',eventType:'user_message_receipt',payload:{request_id:'race',msg_id:'race',status:'accepted'}})
    expect((await pool.query('SELECT state,completed_at FROM session_message_admissions')).rows[0]).toEqual({state:'uncertain',completed_at:null})
    expect(await snapshot()).toMatchObject({used:1,reserved:1})
    await new EventMaterializer({pool}).materialize({inboxId:99201,userId,daemonId:'admission-daemon',sessionId:'admission-session',eventType:'session_status',payload:{request_id:'race',status:'running'}})
    expect((await pool.query('SELECT state,outcome FROM session_message_admissions')).rows[0]).toEqual({state:'completed',outcome:'session_active'})
    expect(await snapshot()).toMatchObject({used:2,reserved:0})
  })
  test('concurrent exact requests issue once and different messages retain one logical slot', async () => {
    const exact = await Promise.all(Array.from({length:5}, () => admit('parallel')))
    expect(exact.filter(x => x.kind === 'continue' && !x.reused)).toHaveLength(1)
    await Promise.all(Array.from({length:5}, (_,i) => admit('different-'+i)))
    await pool.query("UPDATE sessions SET status='exited' WHERE session_id='admission-session'")
    expect(await snapshot()).toMatchObject({used:1,reserved:1})
  })
  test('trusted daemon migration rebinds grants, daemon deletion retires them, account deletion cascades', async () => {
    await admit('migrate')
    const machine = 'machine-' + 'a'.repeat(32)
    await pool.query("UPDATE daemons SET status='offline',machine_id=$1 WHERE daemon_id='admission-daemon'",[machine])
    await pool.query("INSERT INTO daemons(daemon_id,hostname,status,user_id,machine_id) VALUES('new-daemon','test','online',$1,$2)",[userId,machine])
    await consolidateOfflineMachineDaemons(pool,{userId,daemonId:'new-daemon',machineId:machine})
    expect((await pool.query('SELECT daemon_id FROM session_message_admissions')).rows[0].daemon_id).toBe('new-daemon')
    await deleteDaemon(pool,userId,'new-daemon')
    expect((await pool.query('SELECT state,outcome FROM session_message_admissions')).rows[0]).toEqual({state:'completed',outcome:'daemon_deleted'})
    await deleteUserAccount(pool,userId)
    expect((await pool.query('SELECT count(*)::int AS n FROM session_message_admissions')).rows[0].n).toBe(0)
  })

  test('deferred opposite outcomes cannot both persist before first effect runs', async () => {
    await admit('deferred-conflict')
    const materializer = new EventMaterializer({pool})
    const event = (status:string,inboxId:number) => ({inboxId,userId,daemonId:'admission-daemon',sessionId:'admission-session',eventType:status === 'running' ? 'session_status' : 'user_message_receipt',payload:{request_id:'deferred-conflict',msg_id:'deferred-conflict',status}})
    const first = await materializer.materialize(event('rejected',99300),undefined,{deferEffects:true})
    await expect(materializer.materialize(event('running',99301),undefined,{deferEffects:true})).rejects.toMatchObject({code:'quota_reservation_binding_mismatch'})
    expect((await pool.query("SELECT count(*)::int n FROM events WHERE payload->>'request_id'='deferred-conflict'")).rows[0].n).toBe(1)
    expect((await pool.query('SELECT state FROM session_message_admissions')).rows[0].state).toBe('issued')
    await first.applyEffects?.(); await first.finalizeEffect?.()
  })
  test('rename preserves one slot, original retry, current retry, late original outcome and deletion', async () => {
    const {router,client,daemon,command} = await route()
    await renameOwnedDaemonSession(pool,{userId,daemonId:'admission-daemon',oldSessionId:'admission-session',newSessionId:'renamed-session'})
    expect(await snapshot()).toMatchObject({used:2,reserved:0})
    await router.handleClientMessage(client,command)
    await router.handleClientMessage(client,{...command,session_id:'renamed-session'})
    expect(daemon._sent.filter((m:any) => m.type === 'user_message')).toHaveLength(1)
    expect(client._sent.filter((m:any) => m.type === 'user_message_ack')).toHaveLength(3)
    await new EventMaterializer({pool}).materialize({inboxId:99302,userId,daemonId:'admission-daemon',sessionId:'admission-session',eventType:'user_message_receipt',payload:{request_id:'message-1',msg_id:'message-1',status:'accepted'}})
    await deleteSession(pool,'renamed-session')
    expect((await pool.query('SELECT state FROM session_message_admissions')).rows[0].state).toBe('completed')
  })
  test('inline rejected receipt refreshes released quota to the waiting client', async () => {
    const {router,client} = await route()
    await pool.query("UPDATE sessions SET status='exited' WHERE session_id='admission-session'")
    client._sent.length=0
    router.handleDaemonMessage('admission-daemon',{type:'user_message_receipt',session_id:'admission-session',request_id:'message-1',msg_id:'message-1',status:'rejected'})
    await vi.waitFor(() => expect(client._sent.some((m:any) => m.type === 'quota_status' && m.resources.concurrent_sessions.reserved === 0)).toBe(true))
  })

  test('daemon unregister serializes migration before either can invert session/admission row locks', async () => {
    await admit('lock-order')
    const machine='machine-'+'b'.repeat(32)
    await pool.query("UPDATE daemons SET status='offline',machine_id=$1 WHERE daemon_id='admission-daemon'",[machine])
    await pool.query("INSERT INTO daemons(daemon_id,hostname,status,user_id,machine_id) VALUES('lock-new','test','online',$1,$2)",[userId,machine])
    let releaseDelete!:()=>void, deletePaused!:()=>void
    const paused=new Promise<void>(r=>{deletePaused=r}), release=new Promise<void>(r=>{releaseDelete=r})
    let migrationPID=0, migrationChangedSession=false
    const wrapped=(kind:'delete'|'migrate') => ({connect:async()=>{
      const client=await pool.connect()
      if(kind==='migrate') migrationPID=(client as any).processID
      return {release:()=>client.release(),query:async(sql:string,args?:any[])=>{
        const result=await client.query(sql,args)
        if(kind==='delete' && sql.includes('UPDATE session_message_admissions')) {deletePaused();await release}
        if(kind==='migrate' && sql.includes('UPDATE sessions SET daemon_id = $1')) migrationChangedSession=true
        return result
      }}
    }}) as unknown as pg.Pool
    const deletion=deleteDaemon(wrapped('delete'),userId,'admission-daemon')
    await paused
    const migration=consolidateOfflineMachineDaemons(wrapped('migrate'),{userId,daemonId:'lock-new',machineId:machine})
    const both=Promise.allSettled([deletion,migration])
    let changedBeforeDeleteReleased=false
    try {
      await vi.waitFor(async()=>{
        expect(migrationPID).toBeGreaterThan(0)
        const activity=await pool.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[migrationPID])
        expect(activity.rows[0]?.wait_event_type).toBe('Lock')
      })
      changedBeforeDeleteReleased=migrationChangedSession
    } finally {releaseDelete()}
    expect((await both).flatMap(r=>r.status==='rejected' ? [(r.reason as any).code ?? String(r.reason)] : [])).toEqual([])
    expect(changedBeforeDeleteReleased).toBe(false)
    expect((await pool.query("SELECT daemon_id FROM sessions WHERE session_id='admission-session'")).rows[0].daemon_id).toBeNull()
    expect((await pool.query('SELECT outcome FROM session_message_admissions')).rows[0].outcome).toBe('daemon_deleted')
  })
  test('deferred receipt quota refresh is reproduced at the durable delivery boundary', async () => {
    const {router,client}=await route()
    await pool.query("UPDATE sessions SET status='exited' WHERE session_id='admission-session'")
    const result=await new EventMaterializer({pool}).materialize({inboxId:99303,userId,daemonId:'admission-daemon',sessionId:'admission-session',eventType:'user_message_receipt',payload:{type:'user_message_receipt',request_id:'message-1',msg_id:'message-1',status:'rejected'}})
    client._sent.length=0
    for(const delivery of result.deliveries) await router.deliverDurableMaterializedEvent({...delivery,inboxId:99303})
    expect(client._sent).toContainEqual(expect.objectContaining({type:'quota_status',resources:expect.objectContaining({concurrent_sessions:expect.objectContaining({reserved:0})})}))
  })

  test('rename chain accepts only trusted intermediate request aliases and rebases deferred effects', async () => {
    await admit('chain')
    const materializer=new EventMaterializer({pool})
    const first=await materializer.materialize({inboxId:99304,userId,daemonId:'admission-daemon',sessionId:'admission-session',eventType:'session_status',payload:{request_id:'chain',status:'running'}},undefined,{deferEffects:true})
    await renameOwnedDaemonSession(pool,{userId,daemonId:'admission-daemon',oldSessionId:'admission-session',newSessionId:'middle-session'})
    await renameOwnedDaemonSession(pool,{userId,daemonId:'admission-daemon',oldSessionId:'middle-session',newSessionId:'final-session'})
    await first.applyEffects?.();await first.finalizeEffect?.()
    expect(first.deliveries[0].sessionId).toBe('final-session')
    await materializer.materialize({inboxId:99308,userId,daemonId:'admission-daemon',sessionId:'middle-session',eventType:'session_status',payload:{request_id:'chain',status:'running'}})
    expect((await pool.query("SELECT count(*)::int n FROM events WHERE event_type='session_status' AND payload->>'request_id'='chain'")).rows[0].n).toBe(1)
    await materializer.materialize({inboxId:99305,userId,daemonId:'admission-daemon',sessionId:'middle-session',eventType:'user_message_receipt',payload:{request_id:'chain',msg_id:'chain',status:'accepted'}})
    await expect(materializer.materialize({inboxId:99306,userId,daemonId:'admission-daemon',sessionId:'untrusted-alias',eventType:'user_message_receipt',payload:{request_id:'chain',msg_id:'chain',status:'accepted'}})).rejects.toMatchObject({code:'quota_reservation_binding_mismatch'})
    expect(await snapshot()).toMatchObject({used:2,reserved:0})
    await deleteSession(pool,'final-session')
    await expect(materializer.materialize({inboxId:99307,userId,daemonId:'admission-daemon',sessionId:'middle-session',eventType:'user_message_receipt',payload:{request_id:'chain',msg_id:'chain',status:'accepted'}})).rejects.toMatchObject({code:'unknown_daemon_session'})
  })
  test('Router barrier leaves contradictory running outside the ledger while first effect is paused', async () => {
    const {router,daemon}=await route()
    const materializer=(router as any).materializer as EventMaterializer
    const original=materializer.materialize.bind(materializer)
    let firstEntered!:()=>void, releaseFirst!:()=>void
    const entered=new Promise<void>(r=>{firstEntered=r}), released=new Promise<void>(r=>{releaseFirst=r})
    vi.spyOn(materializer,'materialize').mockImplementation(async(...args)=>{
      const result=await original(...args)
      if(args[0].payload.status==='rejected') {
        const apply=result.applyEffects
        result.applyEffects=async()=>{firstEntered();await released;await apply?.()}
      }
      return result
    })
    router.handleDaemonMessage('admission-daemon',{type:'user_message_receipt',session_id:'admission-session',request_id:'message-1',msg_id:'message-1',status:'rejected'})
    await entered
    try {
      router.handleDaemonMessage('admission-daemon',{type:'session_status',session_id:'admission-session',request_id:'message-1',status:'running'})
      await vi.waitFor(()=>expect(daemon.close).toHaveBeenCalled())
      expect((await pool.query("SELECT count(*)::int n FROM events WHERE payload->>'request_id'='message-1'")).rows[0].n).toBe(1)
      expect((await pool.query('SELECT state FROM session_message_admissions')).rows[0].state).toBe('issued')
    } finally {releaseFirst()}
    await vi.waitFor(async()=>expect((await pool.query('SELECT state FROM session_message_admissions')).rows[0].state).toBe('completed'))
  })

  test('concurrent fenced receipt effects read quota without mutating each others expired grants', async () => {
    await admit('read-only-one');await admit('read-only-two','continue','other-active')
    await pool.query("UPDATE session_message_admissions SET expires_at=NOW()-interval '1 hour'")
    const hooks={broadcastQuota:async()=>{await snapshot()}}
    await Promise.all(['admission-session','other-active'].map((sessionId,i)=>new EventMaterializer({pool,hooks}).materialize({inboxId:99400+i,userId,daemonId:'admission-daemon',sessionId,eventType:'user_message_receipt',payload:{request_id:i===0?'read-only-one':'read-only-two',msg_id:i===0?'read-only-one':'read-only-two',status:'accepted'}})))
    expect((await pool.query('SELECT state FROM session_message_admissions')).rows.every(r=>r.state==='completed')).toBe(true)
  })

  test('rename after deferred recovery cannot commit a missing-session suppression sentinel', async () => {
    await admit('between-recovery-and-status')
    await pool.query("UPDATE sessions SET status='exited' WHERE session_id='admission-session'")
    const materializer=new EventMaterializer({pool})
    const input={inboxId:99500,userId,daemonId:'admission-daemon',sessionId:'admission-session',eventType:'session_status',payload:{request_id:'between-recovery-and-status',status:'running'}}
    const result=await materializer.materialize(input,undefined,{deferEffects:true})
    let recoveryDone!:()=>void, resumeEffect!:()=>void
    const recovered=new Promise<void>(r=>{recoveryDone=r}), resume=new Promise<void>(r=>{resumeEffect=r})
    const original=admissionModule.recoverContinueAdmission
    const spy=vi.spyOn(admissionModule,'recoverContinueAdmission').mockImplementationOnce(async(...args)=>{
      const binding=await original(...args)
      recoveryDone();await resume
      return binding
    })
    const effects=result.applyEffects!()
    try {
      await recovered
      await renameOwnedDaemonSession(pool,{userId,daemonId:'admission-daemon',oldSessionId:'admission-session',newSessionId:'after-recovery'})
    } finally {resumeEffect()}
    try {
      await effects;await result.finalizeEffect?.()
      const row=(await pool.query('SELECT effect_step FROM events WHERE id=$1',[result.eventId])).rows[0]
      expect(row.effect_step).toBeLessThan(SESSION_STATUS_SUPPRESSED_EFFECT_STEP)
      expect((await pool.query("SELECT status FROM sessions WHERE session_id='after-recovery'")).rows[0].status).toBe('running')
      expect(result.deliveries).toEqual([expect.objectContaining({sessionId:'after-recovery',payload:expect.objectContaining({session_id:'after-recovery',status:'running'})})])
      const replay=await materializer.materialize(input)
      expect(replay.inserted).toBe(false)
      expect(replay.deliveries[0].sessionId).toBe('after-recovery')
    } finally {spy.mockRestore()}
  })

  test('genuine deletion after deferred recovery still rejects without resurrecting state or ledger', async () => {
    await admit('deleted-after-recovery')
    const materializer=new EventMaterializer({pool})
    const result=await materializer.materialize({inboxId:99501,userId,daemonId:'admission-daemon',sessionId:'admission-session',eventType:'session_status',payload:{request_id:'deleted-after-recovery',status:'running'}},undefined,{deferEffects:true})
    let recoveryDone!:()=>void,resumeEffect!:()=>void
    const recovered=new Promise<void>(r=>{recoveryDone=r}),resume=new Promise<void>(r=>{resumeEffect=r})
    const original=admissionModule.recoverContinueAdmission
    const spy=vi.spyOn(admissionModule,'recoverContinueAdmission').mockImplementationOnce(async(...args)=>{
      const binding=await original(...args);recoveryDone();await resume;return binding
    })
    const effects=result.applyEffects!()
    try {
      await recovered
      await deleteSession(pool,'admission-session')
    } finally {resumeEffect()}
    try {
      await expect(effects).rejects.toMatchObject({code:'unknown_daemon_session'})
      expect((await pool.query("SELECT count(*)::int n FROM sessions WHERE session_id='admission-session'")).rows[0].n).toBe(0)
      expect((await pool.query('SELECT count(*)::int n FROM events WHERE id=$1',[result.eventId])).rows[0].n).toBe(0)
      expect((await pool.query("SELECT count(*)::int n FROM deleted_sessions WHERE session_id='admission-session'")).rows[0].n).toBe(1)
    } finally {spy.mockRestore()}
  })

})
