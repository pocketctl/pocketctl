import type pg from 'pg'
import {beforeAll,beforeEach,afterAll,describe,test,expect} from 'vitest'
import {TeamRunWorker} from '../team/run-worker.js'
import {TeamContextDeliveryService} from '../team/context-delivery.js'
import {TeamRunRepository} from '../team/run-repository.js'
import {TeamContextService} from '../team/context-service.js'
import {TeamRunService} from '../team/run-service.js'
import {teamV2DatabaseEnabled,teamV2Pool,humanTeamFixture} from './fixtures/team-v2.js'
;(teamV2DatabaseEnabled?describe:describe.skip)('Team v2 frozen run participants and rounds (PostgreSQL)',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=await teamV2Pool()});afterAll(async()=>{if(pool){await pool.query('TRUNCATE users,daemons RESTART IDENTITY CASCADE');await pool.end()}})
 beforeEach(async()=>{await pool.query('TRUNCATE users,daemons RESTART IDENTITY CASCADE')})
 async function fixture(){
  const f=await humanTeamFixture(pool),offers:string[]=[]
  for(let n=0;n<2;n++){
   const daemon=`round-d-${f.key}-${n}`,offer=`round-o-${f.key}-${n}`;offers.push(offer)
   const cap={schema_version:2,revision:'round-cap',models:[{id:'model',reasoning_efforts:[]}],permission_profiles:['request_approval','read_only'],default_config:{model:'model',reasoning_effort:null,permission_profile:'request_approval'},runtime_switch:'recreate',read_only:true}
   await pool.query(`INSERT INTO daemons(daemon_id,hostname,status,user_id,agents,collaboration_capabilities) VALUES($1,'round','online',$2,$3::jsonb,'["team_collaboration_dispatch_v1","team_collaboration_context_v1","team_collaboration_config_v2"]')`,[daemon,f.users[n],JSON.stringify([{type:'codex',manageable:true,team_config:cap}])])
   await pool.query(`INSERT INTO team_agent_offers(offer_id,team_id,owner_user_id,daemon_id,provider) VALUES($1,$2,$3,$4,'codex')`,[offer,f.teamId,f.users[n],daemon])
   await f.service.changeBinding({sessionId:f.session.id,actorUserId:f.users[0],offerId:offer,active:true,expectedRevision:n+1,requestId:`bind-${n}`})
  }
  const context=await new TeamContextService(pool).create({sessionId:f.session.id,actorUserId:f.users[0],expectedRevision:0,requestId:'context',goal:'round test',consensus:[],openQuestions:[],references:[]})
  const repository=new TeamRunRepository(pool),service=new TeamRunService(pool)
  const create=(ids=offers,options:Partial<Parameters<TeamRunService['create']>[0]>={})=>service.create({sessionId:f.session.id,actorUserId:f.users[0],coordinatorOfferId:offers[0],participantOfferIds:ids,contextVersion:context.context.version,mode:'discussion',maxRounds:2,requestId:`create-${ids.length}`,...options})
  return {...f,offers,repository,runService:service,create}
 }
 test('validates distinct participants and narrows calls to daemon-enforced read-only configuration',async()=>{
  const f=await fixture()
  await expect(f.create([f.offers[0]])).rejects.toMatchObject({code:'invalid_state'})
  const run=await f.create();expect(run).toMatchObject({max_rounds:2,rounds_used:0,budget:{max_calls:20},mode:'discussion',participant_offer_ids:f.offers})
  await pool.query(`UPDATE collaboration_runs SET lease_token=100,lease_expires_at=NOW()+INTERVAL '60 seconds' WHERE run_id=$1`,[run.id])
  const first=await f.repository.scheduleCall({runId:run.id,leaseToken:100,offerId:f.offers[0],role:'coordinator',content:'observe',processedCallStep:0})
  const call=(await pool.query(`SELECT requested_config,config_hash FROM collaboration_calls WHERE call_id=$1`,[first.callId])).rows[0]
  expect(call.requested_config.permission_profile).toBe('read_only');expect(call.config_hash).toHaveLength(64)
 })
 test('counts only settled worker rounds once and detects equivalent instruction/results without new evidence',async()=>{
  const f=await fixture(),run=await f.create()
  let processed=0
  for(let n=0;n<2;n++){
   await pool.query(`UPDATE collaboration_runs SET lease_token=200,lease_expires_at=NOW()+INTERVAL '60 seconds' WHERE run_id=$1`,[run.id])
   const scheduled=await f.repository.scheduleCall({runId:run.id,leaseToken:200,offerId:f.offers[1],role:'worker',content:n?'  CHECK    status  ':'check status',processedCallStep:processed})
   await pool.query(`UPDATE collaboration_calls SET state='completed' WHERE call_id=$1`,[scheduled.callId])
   const step=(await pool.query(`SELECT run_step FROM collaboration_calls WHERE call_id=$1`,[scheduled.callId])).rows[0].run_step
   await pool.query(`WITH seq AS (UPDATE collaboration_sessions SET latest_event_seq=latest_event_seq+1 WHERE team_session_id=$1 RETURNING latest_event_seq)
     INSERT INTO collaboration_events(event_id,team_session_id,event_seq,kind,call_id,content) SELECT $2,$1,latest_event_seq,'agent_message',$3,'No change.' FROM seq`,[f.session.id,`answer-${f.key}-${n}`,scheduled.callId])
   await pool.query(`UPDATE collaboration_runs SET lease_expires_at=NOW()+INTERVAL '60 seconds' WHERE run_id=$1`,[run.id])
   const result=await f.repository.settleRound(run.id,200,step)
   expect(result.rounds_used).toBe(n+1);expect(result.no_progress_count).toBe(n+1)
   expect((await f.repository.settleRound(run.id,200,step)).rounds_used).toBe(n+1)
   processed=step
  }
  await expect(f.repository.scheduleCall({runId:run.id,leaseToken:200,offerId:f.offers[0],role:'coordinator',content:'more',processedCallStep:processed})).rejects.toMatchObject({dimension:'rounds'})
  await expect(f.repository.settleRound(run.id,199,processed)).rejects.toThrow('lease lost')
 })
 test('freezes the input boundary and rejects changed starting configuration before scheduling',async()=>{
  const f=await fixture(),run=await f.create()
  const initial=(await pool.query('SELECT input_through_event_seq FROM collaboration_runs WHERE run_id=$1',[run.id])).rows[0].input_through_event_seq
  await f.send('FUTURE_CHAT_MUST_NOT_BECOME_RUN_INPUT')
  await pool.query(`UPDATE collaboration_runs SET lease_token=300,lease_expires_at=NOW()+INTERVAL '60 seconds' WHERE run_id=$1`,[run.id])
  const scheduled=await f.repository.scheduleCall({runId:run.id,leaseToken:300,offerId:f.offers[0],role:'coordinator',content:'bounded input',processedCallStep:0})
  const prepared=await new TeamContextDeliveryService(pool).prepare(scheduled.callId)
  expect(prepared.history_through_event_seq).toBe(Number(initial));expect(prepared.stable_text).not.toContain('FUTURE_CHAT_MUST_NOT_BECOME_RUN_INPUT')
  await pool.query(`UPDATE collaboration_calls SET state='completed' WHERE call_id=$1`,[scheduled.callId])
  await pool.query(`UPDATE collaboration_runs SET lease_expires_at=NOW()+INTERVAL '60 seconds' WHERE run_id=$1`,[run.id])
  await pool.query(`UPDATE collaboration_session_agent_bindings SET config_revision=config_revision+1 WHERE team_session_id=$1 AND offer_id=$2`,[f.session.id,f.offers[1]])
  await expect(f.repository.scheduleCall({runId:run.id,leaseToken:300,offerId:f.offers[1],role:'worker',content:'changed config',processedCallStep:1})).rejects.toMatchObject({code:'agent_unavailable'})
  expect(Number((await pool.query('SELECT count(*) FROM collaboration_calls WHERE run_id=$1',[run.id])).rows[0].count)).toBe(1)
 })
 test('expires dormant paused and waiting-input Runs against the same wall-clock deadline',async()=>{
  for(const state of ['paused','waiting_input']){
   const f=await fixture(),run=await f.create()
   await pool.query(`UPDATE collaboration_runs SET state=$2,deadline_at=NOW()-INTERVAL '1 second' WHERE run_id=$1`,[run.id,state])
   expect(await new TeamRunWorker({repository:f.repository,workerId:'deadline-test'}).runOnce()).toBe(true)
   expect(await f.repository.get(run.id,f.users[0])).toMatchObject({state:'failed',terminal_reason:'budget_exhausted',calls_used:0})
   expect((await f.service.getSession(f.session.id,f.users[0])).state).toBe('active')
  }
 })
 test('fences a lease after expiry even before another worker takes ownership',async()=>{
  const f=await fixture(),run=await f.create(),lease=await f.repository.claimNext('expired-owner',1000)
  expect(lease?.run.id).toBe(run.id)
  await pool.query(`UPDATE collaboration_runs SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE run_id=$1`,[run.id])
  await expect(f.repository.scheduleCall({runId:run.id,leaseToken:lease!.leaseToken,offerId:f.offers[0],role:'coordinator',content:'stale effect',processedCallStep:0})).rejects.toThrow('lease lost')
  expect(Number((await pool.query('SELECT count(*) FROM collaboration_calls WHERE run_id=$1',[run.id])).rows[0].count)).toBe(0)
 })

 async function driver(f:Awaited<ReturnType<typeof fixture>>,runId:string){
  const worker=new TeamRunWorker({repository:f.repository,workerId:'matrix-worker'})
  const latest=async()=>(await pool.query('SELECT * FROM collaboration_calls WHERE run_id=$1 ORDER BY run_step DESC LIMIT 1',[runId])).rows[0]
  const wake=async()=>{await pool.query('UPDATE collaboration_runs SET next_wake_at=NOW() WHERE run_id=$1',[runId])}
  const finish=async(response:unknown)=>{
   const c=await latest();await pool.query(`UPDATE collaboration_calls SET state='completed' WHERE call_id=$1`,[c.call_id])
   const text=typeof response==='string'?response:JSON.stringify(response)
   await pool.query(`WITH seq AS (UPDATE collaboration_sessions SET latest_event_seq=latest_event_seq+1 WHERE team_session_id=$1 RETURNING latest_event_seq)
     INSERT INTO collaboration_events(event_id,team_session_id,event_seq,kind,call_id,content) SELECT $2,$1,latest_event_seq,'agent_message',$3,$4 FROM seq`,[f.session.id,`answer-${f.key}-${c.run_step}`,c.call_id,text])
   await wake();return c
  }
  const advance=async(response:unknown)=>{await finish(response);expect(await worker.runOnce()).toBe(true)}
  return {worker,latest,wake,finish,advance}
 }
 const complete={schema_version:2,action:'complete',context_version:1,summary:'verified result',todo:[],disagreements:[]}
 test('waiting input admits one versioned supplement without replaying completed calls',async()=>{
  const f=await fixture(),run=await f.create(),d=await driver(f,run.id)
  await d.worker.runOnce();await d.advance({action:'request_input',context_version:1,question:'Which option?'})
  const waiting=await f.repository.get(run.id,f.users[0]);expect(waiting).toMatchObject({state:'waiting_input',calls_used:1})
  expect(await d.worker.runOnce()).toBe(false)
  const input={runId:run.id,actorUserId:f.users[0],content:'Use option A',expectedRevision:waiting.revision,requestId:'one-supplement'}
  const supplemented=await f.repository.supplement(input);expect(await f.repository.supplement(input)).toMatchObject({run:supplemented.run,replayed:true})
  await d.worker.runOnce();await d.advance(complete)
  expect(await f.repository.get(run.id,f.users[0])).toMatchObject({state:'completed',calls_used:2,rounds_used:0,structured_result:{conclusion:'verified result'}})
  expect((await f.service.getSession(f.session.id,f.users[0])).state).toBe('active')
 })
 test('pause drains a completed native decision without scheduling and resume does not duplicate it',async()=>{
  const f=await fixture(),run=await f.create(),d=await driver(f,run.id);await d.worker.runOnce()
  const current=await f.repository.get(run.id,f.users[0]);const paused=await f.repository.control({runId:run.id,actorUserId:f.users[0],action:'pause',expectedRevision:current.revision,requestId:'pause'})
  await d.finish(complete);expect(await d.worker.runOnce()).toBe(false);await f.send('group chat continues while Run paused')
  expect(Number((await pool.query('SELECT COUNT(*) FROM collaboration_calls WHERE run_id=$1',[run.id])).rows[0].count)).toBe(1)
  await f.repository.control({runId:run.id,actorUserId:f.users[0],action:'resume',expectedRevision:paused.run.revision,requestId:'resume'})
  await d.worker.runOnce();expect(await f.repository.get(run.id,f.users[0])).toMatchObject({state:'completed',calls_used:1})
 })
 for(const dimension of ['calls','rounds'])test(`stops at the frozen ${dimension} reservation boundary including coordinator calls`,async()=>{
  const f=await fixture(),run=await f.create(f.offers,{maxRounds:dimension==='rounds'?1:5,budget:{max_calls:dimension==='calls'?2:20,max_concurrent_calls:2,max_duration_seconds:1800}}),d=await driver(f,run.id)
  await d.worker.runOnce();await d.advance({action:'call_agent',context_version:1,target_offer_id:f.offers[1],instruction:'Check bounded work'})
  await d.advance({artifacts:['new-check'],conclusions:['checked']})
  expect(await f.repository.get(run.id,f.users[0])).toMatchObject({state:'failed',calls_used:2,rounds_used:1,terminal_reason:dimension==='calls'?'budget_exhausted':'rounds_exhausted'})
  expect(Number((await pool.query('SELECT COUNT(*) FROM collaboration_calls WHERE run_id=$1',[run.id])).rows[0].count)).toBe(2)
 })
 test('recovers a crash after round settlement without dispatching beyond no-progress',async()=>{
  const f=await fixture(),run=await f.create(f.offers,{maxRounds:5}),d=await driver(f,run.id),decision={action:'call_agent',context_version:1,target_offer_id:f.offers[1],instruction:'Repeat status check'}
  await d.worker.runOnce();await d.advance(decision);await d.advance({artifacts:[],conclusions:[]});await d.advance(decision)
  const c=await d.finish({artifacts:[],conclusions:[]}),lease=await f.repository.claimNext('crash-after-settlement',15000)
  expect(lease?.run.id).toBe(run.id);expect((await f.repository.settleRound(run.id,lease!.leaseToken,Number(c.run_step))).no_progress_count).toBe(2)
  await pool.query(`UPDATE collaboration_runs SET lease_expires_at=NOW()-INTERVAL '1 second',next_wake_at=NOW() WHERE run_id=$1`,[run.id])
  await new TeamRunWorker({repository:f.repository,workerId:'after-crash'}).runOnce()
  const blocked=await f.repository.get(run.id,f.users[0]);expect(blocked).toMatchObject({state:'blocked',terminal_reason:'no_progress',calls_used:4,rounds_used:2})
  await expect(f.repository.scheduleCall({runId:run.id,leaseToken:lease!.leaseToken,offerId:f.offers[0],role:'coordinator',content:'stale',processedCallStep:4})).rejects.toThrow('lease lost')
  await expect(f.repository.control({runId:run.id,actorUserId:f.users[0],action:'resume',expectedRevision:blocked.revision,requestId:'empty-resume'})).rejects.toMatchObject({code:'invalid_state'})
  await f.repository.supplement({runId:run.id,actorUserId:f.users[0],content:'New verifiable input',expectedRevision:blocked.revision,requestId:'supplement-progress'});await d.worker.runOnce()
  expect((await f.repository.get(run.id,f.users[0])).calls_used).toBe(5)
 })
 test('stop before dispatch and terminal stop are idempotent without a new event or side effect',async()=>{
  const f=await fixture(),run=await f.create(),d=await driver(f,run.id)
  await f.repository.control({runId:run.id,actorUserId:f.users[0],action:'cancel',expectedRevision:run.revision,requestId:'stop-before-call'})
  await d.worker.runOnce();const terminal=await f.repository.get(run.id,f.users[0]);expect(terminal).toMatchObject({state:'cancelled',calls_used:0,terminal_reason:'stop_requested'})
  const before=Number((await pool.query('SELECT COUNT(*) FROM collaboration_events WHERE team_session_id=$1',[f.session.id])).rows[0].count)
  const result=await f.repository.control({runId:run.id,actorUserId:f.users[0],action:'cancel',expectedRevision:1,requestId:'stop-terminal'})
  expect(result.run).toEqual(terminal);expect(result.replayed).toBe(true)
  expect(Number((await pool.query('SELECT COUNT(*) FROM collaboration_events WHERE team_session_id=$1',[f.session.id])).rows[0].count)).toBe(before)
 })
 test('one lease cannot reserve twice after its first call released ownership',async()=>{
  const f=await fixture(),run=await f.create(),lease=await f.repository.claimNext('one-lease',15000)
  const results=await Promise.allSettled(f.offers.map(offer=>f.repository.scheduleCall({runId:run.id,leaseToken:lease!.leaseToken,offerId:offer,role:'coordinator',content:'one decision',processedCallStep:0})))
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.find(r=>r.status==='rejected')).toMatchObject({reason:expect.objectContaining({message:'run lease lost'})})
  expect(Number((await pool.query('SELECT COUNT(*) FROM collaboration_calls WHERE run_id=$1',[run.id])).rows[0].count)).toBe(1)
 })

})
