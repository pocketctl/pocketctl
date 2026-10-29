import {TeamDispatchRepository} from '../team/dispatch-repository.js'
import {TeamContextDeliveryService} from '../team/context-delivery.js'
import {randomUUID} from 'node:crypto'
import {TeamSessionService} from '../team/session-service.js'
import pg from 'pg'
import {beforeAll,afterAll,describe,test,expect} from 'vitest'
import {initDB} from '../db.js'
import {humanTeamFixture} from './fixtures/team-v2.js'
import {TeamTaskService} from '../team/task-service.js'
const enabled=process.env.RUN_POSTGRES_INTEGRATION==='1'&&Boolean(process.env.TEST_DATABASE_URL)
;(enabled?describe:describe.skip)('Task requirements and holder transactions',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{
  const u=new URL(process.env.TEST_DATABASE_URL!)
  if(u.hostname!=='127.0.0.1'||u.pathname!=='/team_readiness_test'||u.username!=='team_readiness_test')throw Error('dedicated readiness database required')
  pool=new pg.Pool({connectionString:u.href})
  const role=(await pool.query('SELECT rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0]
  if(role.rolsuper)throw Error('non-superuser required')
  await initDB(pool)
 },30000)
 afterAll(async()=>{if(pool){await pool.query('TRUNCATE users,daemons RESTART IDENTITY CASCADE');await pool.end()}})
 test.each(['short','multibyte-limit'])('explicit execution freezes %s requirements through dispatch, edit and replay',async(size)=>{
  const f=await humanTeamFixture(pool),actor=f.users[0],tasks=new TeamTaskService(pool)
  const sessions=new TeamSessionService(pool,{},undefined,undefined,id=>id===f.teamId)
  const daemon=`readiness-d-${randomUUID()}`,offer=`readiness-o-${randomUUID()}`
  await pool.query(`INSERT INTO daemons(daemon_id,hostname,status,user_id,agents,collaboration_capabilities) VALUES($1,'readiness-test','online',$2,
    '[{"type":"codex","manageable":true}]','["team_collaboration_dispatch_v1","team_collaboration_context_v1","team_task_delivery_v1"]')`,[daemon,actor])
  await pool.query(`INSERT INTO team_agent_offers(offer_id,team_id,owner_user_id,daemon_id,provider) VALUES($1,$2,$3,$4,'codex')`,[offer,f.teamId,actor,daemon])
  const session=await sessions.getSession(f.session.id,actor)
  await sessions.changeBinding({sessionId:session.id,actorUserId:actor,offerId:offer,active:true,expectedRevision:session.revision,requestId:'bind'})
  const assigned=await sessions.assignTask({sessionId:session.id,actorUserId:actor,requestId:'assign',instruction:'Original spec',acceptance:'Reviewed',targetOfferIds:[offer],contextVersion:0,
    reviewPolicy:{reviewer_user_id:f.users[1],primary_offer_id:offer,required_checks:[]}})
  // Synthetic terminal fixture only; no model or daemon is invoked.
  await pool.query("UPDATE collaboration_calls SET state='completed',finished_at=NOW() WHERE task_id=$1",[assigned.task_id])
  const legacyInput={sessionId:session.id,taskId:assigned.task_id,actorUserId:actor,request_id:'legacy-execute',expected_revision:1,spec_revision:1,context_version:0,target_offer_ids:[offer]}
  const legacy=await sessions.executeTask(legacyInput) // No requirements existed when this old request committed.
  await pool.query("UPDATE collaboration_calls SET state='completed',finished_at=NOW() WHERE call_id=$1",[legacy.call_ids[0]])
  expect((await tasks.listTasks(f.teamId,actor)).find(t=>t.id===assigned.task_id)?.has_delivery_contract).toBe(true)
  let task=await tasks.getTask(assigned.task_id,actor)
  expect(task.has_delivery_contract).toBe(true)
  const frozenGoal=size==='short'?'Frozen goal':'需'.repeat(10000)
  task=await tasks.updateRequirements({taskId:task.id,actorUserId:actor,expectedRevision:task.revision,requestId:'draft',requirements:{goal:frozenGoal,scope:size==='short'?'Scope one':'范'.repeat(10000),acceptance:size==='short'?'Human review':'验'.repeat(10000),repository:null}})
  task=await tasks.overrideRequirements({taskId:task.id,actorUserId:actor,expectedRevision:task.revision,requestId:'override',reason:'Investigation without repository'})
  const input={sessionId:session.id,taskId:task.id,actorUserId:actor,request_id:'execute-frozen',expected_revision:2,spec_revision:1,context_version:0,target_offer_ids:[offer]}
  expect(await sessions.executeTask(legacyInput)).toEqual(legacy) // New requirements must not strand an old committed receipt.
  await expect(sessions.executeTask(input)).rejects.toMatchObject({code:'revision_conflict'})
  await expect(sessions.executeTask({...input,expected_task_revision:task.revision-1})).rejects.toMatchObject({code:'revision_conflict'})
  const confirmedInput={...input,expected_task_revision:task.revision}
  const result=await sessions.executeTask(confirmedInput)
  expect(result.event.content).toContain(JSON.stringify(frozenGoal))
  expect(result.event.content).toContain('"revision":1')
  expect(result.event.content).toContain('Investigation without repository')
  task=await tasks.getTask(task.id,actor)
  await tasks.updateRequirements({taskId:task.id,actorUserId:actor,expectedRevision:task.revision,requestId:'new-draft',requirements:{goal:'Later goal',scope:'New scope',acceptance:'Changed',repository:null}})
  expect(await sessions.executeTask(confirmedInput)).toEqual(result)
  const stored=(await pool.query('SELECT content FROM collaboration_events WHERE event_id=$1',[result.event.id])).rows[0].content
  expect(stored).toBe(result.event.content)
  expect(stored).not.toContain('Later goal')
  expect((await pool.query('SELECT call_id FROM collaboration_calls WHERE event_id=$1',[result.event.id])).rows).toHaveLength(1)
  const dispatched=await new TeamDispatchRepository(pool).claim(result.call_ids[0])
  expect(dispatched?.content).toBe(result.event.content)
  const context=await new TeamContextDeliveryService(pool).prepare(result.call_ids[0])
  expect(Buffer.byteLength(context.stable_text,'utf8')).toBeLessThanOrEqual(32000)
  if(size==='multibyte-limit') {
    expect(Buffer.byteLength(dispatched!.content,'utf8')).toBeGreaterThan(90000)
    expect(dispatched!.content).toContain('验'.repeat(10000))
  }
  // The current request is delivered independently from bounded optional history.
  // A concurrent edit must either win before execution, or fail task CAS after it.
  await pool.query("UPDATE collaboration_calls SET state='completed',finished_at=NOW() WHERE call_id=$1",[result.call_ids[0]])
  task=await tasks.getTask(task.id,actor)
  const [edited,executed]=await Promise.allSettled([
    tasks.updateRequirements({taskId:task.id,actorUserId:actor,expectedRevision:task.revision,requestId:'race-edit',requirements:{goal:'Race winner',scope:'Race scope',acceptance:'Race check',repository:null}}),
    sessions.executeTask({...input,request_id:'race-execute',expected_revision:3,expected_task_revision:task.revision}),
  ])
  expect([edited,executed].filter(r=>r.status==='fulfilled')).toHaveLength(1)
  if(executed.status==='fulfilled') {
    expect(edited.status).toBe('rejected')
    if(edited.status==='rejected')expect(edited.reason).toMatchObject({code:'revision_conflict'})
    expect(executed.value.event.content).toContain('"goal":"Later goal"')
    expect(executed.value.event.content).toContain('"revision":2')
    expect(executed.value.event.content).toContain('"override":null')
  } else {
    expect(executed.reason).toMatchObject({code:'revision_conflict'})
    expect((await pool.query("SELECT 1 FROM team_delivery_receipts WHERE task_id=$1 AND request_id='race-execute'",[task.id])).rows).toHaveLength(0)
  }


 })
 test('records authorized overrides, invalidates on edit and preserves receipt/CAS semantics',async()=>{
  const f=await humanTeamFixture(pool),service=new TeamTaskService(pool)
  const task=await service.createTask({teamId:f.teamId,actorUserId:f.users[0],title:'Requirements',background:'',requestId:'create'})
  expect(task.requirements).toBeUndefined()
  const input={taskId:task.id,actorUserId:f.users[0],expectedRevision:1,requestId:'requirements',requirements:{goal:'Goal',scope:'',acceptance:'',repository:null}}
  const saved=await service.updateRequirements(input)
  expect(saved.requirements?.readiness.missing).toEqual(['scope','repository','acceptance'])
  expect(await service.updateRequirements(input)).toEqual(saved)
  await expect(service.updateRequirements({...input,requirements:{...input.requirements,goal:'Different'}})).rejects.toMatchObject({code:'idempotency_conflict'})
  const override={taskId:task.id,actorUserId:f.users[1],expectedRevision:saved.revision,requestId:'override',reason:'Investigation task; details will follow'}
  await expect(service.overrideRequirements(override)).rejects.toMatchObject({code:'creator_required'})
  const own={...override,actorUserId:f.users[0]},overridden=await service.overrideRequirements(own)
  expect(overridden.requirements?.override).toMatchObject({actor_user_id:f.users[0],reason:own.reason,requirements_revision:1})
  expect(await service.overrideRequirements(own)).toEqual(overridden)
  expect(await service.requirementReceipt(task.id,f.users[0],'save','requirements')).toMatchObject({found:true,response:saved})
  expect(await service.requirementReceipt(task.id,f.users[1],'save','requirements')).toMatchObject({found:false,response:null})
  expect(await service.requirementReceipt(task.id,f.users[0],'override','requirements')).toMatchObject({found:false,response:null})
  const edited=await service.updateRequirements({...input,requestId:'edit',expectedRevision:overridden.revision,requirements:{...input.requirements,scope:'API'}})
  expect(edited.requirements?.override).toBeNull()
  expect(edited.requirements?.revision).toBe(2)
  const audit=(await pool.query('SELECT kind,requirements_revision::int FROM team_task_requirement_events WHERE task_id=$1 ORDER BY created_at,event_id',[task.id])).rows
  expect(audit).toEqual([{kind:'updated',requirements_revision:1},{kind:'override',requirements_revision:1},{kind:'updated',requirements_revision:2}])
  expect((await service.requirementReceipt(task.id,f.users[0],'save','requirements')).response).toEqual(saved)
  await pool.query("UPDATE collaboration_team_memberships SET state='removed' WHERE team_id=$1 AND user_id=$2",[f.teamId,f.users[0]])
  await expect(service.requirementReceipt(task.id,f.users[0],'save','requirements')).rejects.toMatchObject({code:'team_not_found'})
  await expect(service.overrideRequirements(own)).rejects.toMatchObject({code:'team_not_found'})
  await expect(service.requirementHistory(task.id,f.users[0])).rejects.toMatchObject({code:'team_not_found'})
 })
 test('self-holder receipts retain exact results across release and isolate actor/task/operation',async()=>{
  const f=await humanTeamFixture(pool),service=new TeamTaskService(pool),actor=f.users[0]
  const task=await service.createTask({teamId:f.teamId,actorUserId:actor,title:'Receipt',background:'',requestId:'receipt-task'})
  const input={taskId:task.id,actorUserId:actor,holderUserId:actor,active:true,expectedRevision:1,requestId:'self-claim'}
  const claim=await service.setHolder(input)
  const release=await service.setHolder({...input,active:false,expectedRevision:claim.revision,requestId:'self-release'})
  expect((await service.selfHolderReceipt(task.id,actor,'self-claim')).response).toEqual(claim)
  expect((await service.selfHolderReceipt(task.id,actor,'self-release')).response).toEqual(release)
  expect((await service.getTask(task.id,actor)).holder_user_ids).toEqual([])
  expect(await service.setHolder(input)).toEqual(claim)
  expect((await service.getTask(task.id,actor)).revision).toBe(release.revision)
  expect(await service.selfHolderReceipt(task.id,f.users[1],'self-claim')).toMatchObject({found:false,response:null})
  expect(await service.selfHolderReceipt(task.id,actor,'receipt-task')).toMatchObject({found:false,response:null})
  const other=await service.createTask({teamId:f.teamId,actorUserId:actor,title:'Other',background:'',requestId:'receipt-other'})
  expect(await service.selfHolderReceipt(other.id,actor,'self-claim')).toMatchObject({found:false,response:null})
  await service.setHolder({taskId:task.id,actorUserId:actor,holderUserId:f.users[1],active:true,expectedRevision:release.revision,requestId:'other-holder'})
  expect(await service.selfHolderReceipt(task.id,actor,'other-holder')).toMatchObject({found:false,response:null})
  await pool.query("UPDATE collaboration_team_memberships SET role='viewer' WHERE team_id=$1 AND user_id=$2",[f.teamId,actor])
  await expect(service.selfHolderReceipt(task.id,actor,'self-claim')).rejects.toMatchObject({code:'team_access_denied'})
  await pool.query("UPDATE collaboration_team_memberships SET state='removed' WHERE team_id=$1 AND user_id=$2",[f.teamId,actor])
  await expect(service.selfHolderReceipt(task.id,actor,'self-claim')).rejects.toMatchObject({code:'team_not_found'})
 })
 test('history pages by task revision without duplicates when a new edit arrives',async()=>{
  const f=await humanTeamFixture(pool),service=new TeamTaskService(pool)
  let task=await service.createTask({teamId:f.teamId,actorUserId:f.users[0],title:'History',background:'',requestId:'history-create'})
  for(let i=0;i<52;i++)task=await service.updateRequirements({taskId:task.id,actorUserId:f.users[0],expectedRevision:task.revision,requestId:`edit-${i}`,requirements:{goal:`Goal ${i}`,scope:'',repository:null,acceptance:''}})
  const first=await service.requirementHistory(task.id,f.users[1])
  expect(first.events).toHaveLength(50);expect(first.next_before_revision).toBe(4)
  task=await service.updateRequirements({taskId:task.id,actorUserId:f.users[0],expectedRevision:task.revision,requestId:'late-edit',requirements:{goal:'Newer',scope:'',repository:null,acceptance:''}})
  const second=await service.requirementHistory(task.id,f.users[1],first.next_before_revision!)
  expect(second.events.map(e=>e.task_revision)).toEqual([3,2]);expect(second.next_before_revision).toBeNull()
  expect(new Set([...first.events,...second.events].map(e=>e.event_id)).size).toBe(52)
  expect(first.events[0].details).toEqual({requirements:{goal:'Goal 51',scope:'',repository:null,acceptance:''}})
 })
 test('competing claims use existing task CAS and release/reclaim does not duplicate identity',async()=>{
  const f=await humanTeamFixture(pool),service=new TeamTaskService(pool)
  let task=await service.createTask({teamId:f.teamId,actorUserId:f.users[0],title:'Pool',background:'',requestId:'pool'})
  expect((await service.getTask(task.id,f.users[0])).has_delivery_contract).toBe(false)
  expect((await service.listTasks(f.teamId,f.users[0])).find(t=>t.id===task.id)?.has_delivery_contract).toBe(false)
  expect((await service.listTasks(f.teamId,f.users[0],false,'unclaimed')).map(t=>t.id)).toContain(task.id)
  const results=await Promise.allSettled(f.users.slice(0,2).map(user=>service.setHolder({taskId:task.id,actorUserId:user,holderUserId:user,active:true,expectedRevision:1,requestId:'claim'})))
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1)
  expect(results.filter(r=>r.status==='rejected')).toHaveLength(1)
  task=await service.getTask(task.id,f.users[0]);const winner=task.holder_user_ids[0]
  expect(await service.listTasks(f.teamId,f.users[0],false,'unclaimed')).toEqual([])
  expect((await service.listTasks(f.teamId,winner,false,'mine')).map(t=>t.id)).toEqual([task.id])
  const other=f.users.find(u=>u!==winner)!
  expect(await service.listTasks(f.teamId,other,false,'mine')).toEqual([])
  task=await service.setHolder({taskId:task.id,actorUserId:winner,holderUserId:winner,active:false,expectedRevision:task.revision,requestId:'release'})
  expect(task.holder_user_ids).toEqual([])
  expect((await service.listTasks(f.teamId,other,false,'unclaimed')).map(t=>t.id)).toEqual([task.id])
  task=await service.setHolder({taskId:task.id,actorUserId:winner,holderUserId:winner,active:true,expectedRevision:task.revision,requestId:'reclaim'})
  expect(task.holder_user_ids).toEqual([winner])
  expect((await pool.query('SELECT count(*)::int n FROM team_task_holders WHERE task_id=$1',[task.id])).rows[0].n).toBe(1)
 })
})
