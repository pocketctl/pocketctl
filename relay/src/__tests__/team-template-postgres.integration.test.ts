import pg from 'pg'
import Fastify from 'fastify'
import {randomUUID} from 'node:crypto'
import {beforeAll,beforeEach,afterAll,describe,test,expect} from 'vitest'
import {TeamDeliveryService} from '../team/delivery-service.js'
import {initDB} from '../db.js'
import {humanTeamFixture} from './fixtures/team-v2.js'
import {templateFixture} from './fixtures/team-template.js'
import {TeamTemplateService} from '../team/template-service.js'
import {TeamPlanService} from '../team/plan-service.js'
import {TeamPlanExecutionService} from '../team/plan-execution-service.js'
import {TeamSessionService} from '../team/session-service.js'
import {registerTeamTemplateRoutes} from '../team/template-routes.js'
const enabled=process.env.RUN_POSTGRES_INTEGRATION==='1'&&!!process.env.TEST_DATABASE_URL
;(enabled?describe:describe.skip)('templates (dedicated disposable PostgreSQL19030)',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{
  const url=new URL(process.env.TEST_DATABASE_URL!)
  if(url.hostname!=='127.0.0.1'||url.port!=='19030'||url.pathname!=='/team_relay_test'||url.username!=='team_relay_test')throw Error('dedicated disposable template database required')
  pool=new pg.Pool({connectionString:url.toString()})
  const id=(await pool.query('SELECT current_user u,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) superuser')).rows[0]
  if(id.u!=='team_relay_test'||id.superuser)throw Error('non-superuser required')
  await initDB(pool)
  expect((await pool.query("SELECT 1 FROM pg_constraint WHERE conrelid='team_task_template_sources'::regclass AND conname='team_template_source_session_team_fk'")).rowCount).toBe(1)
 },30000)
 beforeEach(async()=>{await pool.query('TRUNCATE users,daemons RESTART IDENTITY CASCADE')})
 afterAll(async()=>{await pool?.end()})
 async function fixture(){
  const f=await humanTeamFixture(pool),offer='template-offer-'+randomUUID(),daemon='template-daemon-'+randomUUID()
  await pool.query(`INSERT INTO daemons(daemon_id,hostname,status,user_id,agents,collaboration_capabilities) VALUES($1,'template-test','online',$2,'[{"type":"codex","manageable":true}]','["team_collaboration_dispatch_v1","team_collaboration_context_v1","team_task_delivery_v1","team_task_steps_v1"]')`,[daemon,f.users[0]])
  await pool.query("INSERT INTO team_agent_offers(offer_id,team_id,owner_user_id,daemon_id,provider) VALUES($1,$2,$3,$4,'codex')",[offer,f.teamId,f.users[0],daemon])
  await new TeamSessionService(pool,{},undefined,undefined,()=>true).changeBinding({sessionId:f.session.id,actorUserId:f.users[0],offerId:offer,active:true,expectedRevision:f.session.revision,requestId:'bind'})
  const service=new TeamTemplateService(pool,team=>team===f.teamId),definition=templateFixture()
  await service.save(f.teamId,'repair',f.users[0],{request_id:'v1',expected_revision:0,definition})
  const input={request_id:'create',template_id:'repair',template_revision:1,team_session_id:f.session.id,context_version:0,role_bindings:{builder:offer,reviewer:f.users[1]}}
  return {...f,offer,daemon,service,definition,input,create:(patch={})=>service.createTask(f.teamId,f.users[0],{...input,...patch})}
 }
 async function counts(){return (await pool.query(`SELECT (SELECT count(*)::int FROM team_tasks) tasks,(SELECT count(*)::int FROM collaboration_calls) calls,(SELECT count(*)::int FROM team_task_plan_revisions) plans,(SELECT count(*)::int FROM team_task_template_sources) sources`)).rows[0]}
 test('v1/v2 task snapshots and role bindings freeze atomically; budget is only a suggestion',async()=>{
  const f=await fixture(),first=await f.create(),v2={...f.definition,name:'新版',goal:'新版目标'}
  await f.service.save(f.teamId,'repair',f.users[0],{request_id:'v2',expected_revision:1,definition:v2})
  const second=await f.create({request_id:'second',template_revision:2})
  const old=await f.service.taskSource(f.teamId,first.task_id,f.users[0]),next=await f.service.taskSource(f.teamId,second.task_id,f.users[0])
  expect(old.source.snapshot).toEqual(f.definition);expect(next.source.snapshot).toEqual(v2);expect(old.source.role_bindings).toEqual(f.input.role_bindings)
  expect(await counts()).toEqual({tasks:2,calls:0,plans:2,sources:2})
  const delivery=new TeamDeliveryService(pool,{writesEnabledForTeam:()=>true})
  expect((await delivery.sessionCards(f.session.id,f.users[0])).items.map((x:any)=>x.task_id).sort()).toEqual([first.task_id,second.task_id].sort())
  expect((await delivery.management(first.task_id,f.users[0])).can_manage).toBe(false)
  await expect(new TeamSessionService(pool,{},undefined,undefined,()=>true).executeTask({sessionId:f.session.id,taskId:first.task_id,actorUserId:f.users[0],request_id:'legacy',expected_revision:1,spec_revision:1,context_version:0,target_offer_ids:[f.offer]})).rejects.toMatchObject({code:'invalid_state'})
  const plans=new TeamPlanService(pool,{writesEnabledForTeam:()=>true})
  expect((await plans.editingOptions(first.task_id,f.users[0])).sessions[0].team_session_id).toBe(f.session.id)
  const controls=new TeamPlanExecutionService(pool,()=>true)
  expect((await controls.getExecution(first.task_id,f.users[0])).runtime).toBeNull()
  const activated=await controls.control(first.task_id,f.users[0],{request_id:'explicit',expected_revision:0,plan_revision:1,action:'activate',invocation_limit:3})
  expect(activated.budget).toEqual({});expect((await counts()).calls).toBe(0)
  await expect(pool.query("UPDATE team_task_template_sources SET role_bindings='{}' WHERE task_id=$1",[first.task_id])).rejects.toMatchObject({code:'23514'})
  await expect(pool.query("UPDATE team_template_revisions SET content_hash=$1 WHERE team_id=$2",['0'.repeat(64),f.teamId])).rejects.toMatchObject({code:'23514'})
 })
 test('concurrent create replays one task; exact original receipt survives restart and gate off',async()=>{
  const f=await fixture(),results=await Promise.all(Array.from({length:8},()=>f.create()))
  expect(new Set(results.map(r=>r.task_id)).size).toBe(1);expect(await counts()).toEqual({tasks:1,calls:0,plans:1,sources:1})
  const off=new TeamTemplateService(pool),receipt=await off.lookup(f.teamId,f.users[0],'create')
  expect(receipt.response).toEqual(results[0]);expect(receipt.found).toBe(true)
  await expect(f.create({goal:'changed'})).rejects.toMatchObject({code:'idempotency_conflict'})
  await expect(off.createTask(f.teamId,f.users[0],{...f.input,request_id:'off'})).rejects.toMatchObject({code:'team_feature_disabled'})
  expect((await off.get(f.teamId,'repair',f.users[0],1)).definition).toEqual(f.definition)
 })
 test('20 competing revision pairs produce exactly one winner each',async()=>{
  const f=await fixture()
  for(let revision=1;revision<=20;revision++){
   const result=await Promise.allSettled([0,1].map(n=>f.service.save(f.teamId,'repair',f.users[0],{request_id:`cas-${revision}-${n}`,expected_revision:revision,definition:{...f.definition,name:`Revision ${revision}/${n}`}})))
   expect(result.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(result.filter(r=>r.status==='rejected')).toHaveLength(1)
  }
  expect((await f.service.get(f.teamId,'repair',f.users[0])).revision).toBe(21);expect((await counts()).tasks).toBe(0)
 })
 test('missing role, stale Context and unavailable Agent roll back the entire new task',async()=>{
  const f=await fixture(),before=await counts()
  await expect(f.create({role_bindings:{builder:f.offer}})).rejects.toMatchObject({code:'invalid_request'})
  await expect(f.create({context_version:1})).rejects.toMatchObject({code:'context_revision_conflict'})
  await pool.query("UPDATE daemons SET status='offline' WHERE daemon_id=$1",[f.daemon])
  await expect(f.create()).rejects.toMatchObject({code:'agent_unavailable'})
  expect(await counts()).toEqual(before);expect((await f.service.lookup(f.teamId,f.users[0],'create')).found).toBe(false)
 })
 test('current membership, participant and reviewer authority cannot be supplied by the template',async()=>{
  const f=await fixture(),other=await humanTeamFixture(pool)
  await expect(f.service.save(f.teamId,'repair',f.users[1],{request_id:'member',expected_revision:1,definition:f.definition})).rejects.toMatchObject({code:'team_access_denied'})
  await expect(f.service.get(f.teamId,'repair',other.users[0])).rejects.toMatchObject({code:'team_not_found'})
  await expect(f.create({role_bindings:{builder:f.offer,reviewer:other.users[0]}})).rejects.toMatchObject({code:'reviewer_required'})
  const created=await f.create()
  await pool.query("UPDATE collaboration_team_memberships SET state='removed' WHERE team_id=$1 AND user_id=$2",[f.teamId,f.users[0]])
  await expect(f.service.lookup(f.teamId,f.users[0],'create')).rejects.toMatchObject({code:'team_not_found'})
  await expect(f.service.taskSource(f.teamId,created.task_id,f.users[0])).rejects.toMatchObject({code:'team_not_found'})
 })
 test('HTTP routes authenticate, bound queries, return original create receipt and frozen source',async()=>{
  const f=await fixture(),app=Fastify()
  registerTeamTemplateRoutes(app,{service:f.service,verifyAccessToken:async token=>token==='valid'?{userId:f.users[0]}:null,getDatabaseReady:()=>true})
  const base=`/api/teams/${f.teamId}`,headers={authorization:'Bearer valid'}
  try{
   expect((await app.inject({method:'GET',url:base+'/templates'})).statusCode).toBe(401)
   expect((await app.inject({method:'GET',url:base+'/templates?unexpected=1',headers})).statusCode).toBe(400)
   expect((await app.inject({method:'GET',url:base+'/templates/repair?revision=2147483648',headers})).statusCode).toBe(400)
   const list=await app.inject({method:'GET',url:base+'/templates',headers});expect(list.json().items).toHaveLength(1);expect(list.headers['cache-control']).toBe('no-store')
   const created=await app.inject({method:'POST',url:base+'/template-tasks',headers,payload:f.input});expect(created.statusCode).toBe(200);expect(created.json().call_ids).toEqual([])
   const receipt=await app.inject({method:'GET',url:base+'/template-tasks/receipt-lookup/create',headers});expect(receipt.json().response).toEqual(created.json())
   const source=await app.inject({method:'GET',url:base+`/tasks/${created.json().task_id}/template-source`,headers});expect(source.json().source.template_revision).toBe(1)
  }finally{await app.close()}
 })
})
