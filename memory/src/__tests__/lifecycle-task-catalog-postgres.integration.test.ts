import pg from 'pg'
import {randomUUID} from 'node:crypto'
import {beforeAll,beforeEach,afterEach,afterAll,describe,test,expect} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {governanceFixture} from '../testing/governance-fixture.js'
import {createCurationWorker} from '../curation/worker.js'
import {stageLifecycleTurn} from '../curation/task-repository.js'
import {loadTaskCatalog} from '../curation/task-catalog.js'
import {canonicalPayloadHash} from '../inbox/canonical-json.js'
import type {TextGenerator} from '../ports/text-generator.js'
import type {JobClaim} from '../jobs/types.js'
const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('lifecycle task continuity (synthetic provider; real persistence and admission)',()=>{
 let pool:pg.Pool,f:Awaited<ReturnType<typeof governanceFixture>>,space:string,other:string
 const session='topic-continuity'
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url,max:5});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 beforeEach(async()=>{f=await governanceFixture(pool);space=randomUUID();other=randomUUID();await pool.query("INSERT INTO memory_curation_policies(installation_id,mode) VALUES($1,'enabled')",[f.personal]);for(const id of [space,other])await pool.query("INSERT INTO memory_spaces(installation_id,space_id,name,domain,destinations) VALUES($1,$2,'fixture','work',ARRAY['work'])",[f.personal,id])})
 afterEach(async()=>{await pool.query('DELETE FROM knowledge_claims WHERE installation_id=ANY($1::uuid[])',[[f.personal,f.team]]);await pool.query('DELETE FROM memory_installations WHERE installation_id=ANY($1::uuid[])',[[f.personal,f.team]])})
 afterAll(async()=>{await pool?.end()})
 async function stage(text:string){
  const id=randomUUID(),turn=randomUUID(),payload={text},proof={version:1,producer:'claude',session_id:session,turn_id:turn,event_id:id,sequence:'1',invocation_id:'user-input',source_role:'user',skill_state:'non_skill',lineage_complete:true,derived_from_event_ids:[]}
  await pool.query(`INSERT INTO source_events(source_event_id,installation_id,origin,origin_position,session_id,turn_id,event_type,occurred_at,payload,payload_hash,source_provenance) VALUES($1,$2,'feed',$3,$4,$3,'user_text',clock_timestamp(),$5,$6,$7)`,[id,f.personal,turn,session,payload,canonicalPayloadHash(payload),{memory:proof}])
  const c=await pool.connect();try{await c.query('BEGIN');const events=(await c.query('SELECT * FROM source_events WHERE source_event_id=$1',[id])).rows;await stageLifecycleTurn(c,{installationId:f.personal,sessionId:session,turnId:turn,events},{mode:'enabled',revision:1,authorizationEpoch:'1',version:'memory-lifecycle-v1'});await c.query('COMMIT')}finally{c.release()}
  const job=(await pool.query("SELECT j.* FROM memory_jobs j JOIN memory_task_bundles b ON b.installation_id=j.installation_id AND b.bundle_id::text=j.payload->>'bundle_id' WHERE j.installation_id=$1 AND b.task_key=$2 AND j.job_type='consolidate_task'",[f.personal,`source:${turn}`])).rows[0] as JobClaim
  return{id,text,job}
 }
 const part=(source:{id:string;text:string},spaceId=space,taskId:string|null=null)=>({space_id:spaceId,task_id:taskId,spans:[{event_id:source.id,start:0,end:source.text.length}],conclusions:[] as unknown[]})
 async function consolidate(source:Awaited<ReturnType<typeof stage>>,fn:(document:any)=>unknown[]|Promise<unknown[]>){
  const generator={generateJson:async({document}:any)=>({ok:true,value:{tasks:await fn(document)},usage:{inputTokens:20,outputTokens:5,model:'synthetic'}})} as TextGenerator
  await createCurationWorker({pool,mode:'enabled',textGenerator:generator,modelFingerprint:'catalog-test'}).consolidate(source.job,new AbortController().signal)
 }
 test('AC-09 AC-10 two topics persist bounded source hints and a later turn resumes the matching identity',async()=>{
  const first=await stage('Discuss deployment timeout. Discuss railway preference.')
  await consolidate(first,()=>[{space_id:space,task_id:null,spans:[{event_id:first.id,start:0,end:27}],conclusions:[]},{space_id:other,task_id:null,spans:[{event_id:first.id,start:28,end:first.text.length}],conclusions:[]}])
  const catalog=await loadTaskCatalog(pool,f.personal,session)
  expect(catalog).toHaveLength(2);expect(catalog.every(t=>t.topic.length<=512)).toBe(true)
  const original=catalog.find(t=>t.topic.includes('deployment'))!
  const later=await stage('Continue deployment timeout discussion.')
  await consolidate(later,document=>{
   expect(document.tasks).toHaveLength(2);expect(JSON.stringify(document.tasks)).not.toContain('revision')
   const task=document.tasks.find((t:any)=>t.topic.includes('deployment'));return[part(later,space,task.id)]
  })
  const after=await loadTaskCatalog(pool,f.personal,session)
  expect(after).toHaveLength(2);expect(after.find(t=>t.id===original.id)).toMatchObject({revision:2,topic:later.text})
 })
 test('AC-10 pending prior conclusions are never overwritten by resumed task revisions',async()=>{
  const first=await stage('I prefer concise answers.')
  await consolidate(first,()=>[{...part(first),conclusions:[{kind:'preference',assertion_mode:'user_asserted',subject:'self',predicate:'user.preference',value:'concise',conditions:{},fact_at:null,valid_until:null,statement:first.text,confirmed:true,evidence:{subject:[first.id],predicate:[first.id],value:[first.id]}}]}])
  expect((await pool.query("SELECT count(*)::int n FROM memory_candidates WHERE installation_id=$1 AND source_kind='task_bundle'",[f.personal])).rows[0].n).toBe(1)
  expect(await loadTaskCatalog(pool,f.personal,session)).toEqual([])
 })
 test('AC-05 changed/excluded prior source cannot leak its persisted descriptor into the next provider call',async()=>{
  const first=await stage('SECRET_WITHDRAWN_TOPIC');await consolidate(first,()=>[part(first)])
  await pool.query("UPDATE source_events SET source_provenance=jsonb_set(source_provenance,'{memory,skill_state}','\"skill\"') WHERE source_event_id=$1",[first.id])
  const later=await stage('A new topic.');await consolidate(later,document=>{expect(document.tasks).toEqual([]);expect(JSON.stringify(document)).not.toContain('SECRET_WITHDRAWN_TOPIC');return[]})
 })
 test('AC-16 prior source mutation while model is running rejects the stale resume',async()=>{
  const first=await stage('Discuss deployment.');await consolidate(first,()=>[part(first)])
  const original=(await loadTaskCatalog(pool,f.personal,session))[0],later=await stage('Continue deployment.')
  await expect(consolidate(later,async()=>{const payload={text:'WITHDRAWN'};await pool.query('UPDATE source_events SET payload=$2,payload_hash=$3 WHERE source_event_id=$1',[first.id,payload,canonicalPayloadHash(payload)]);return[part(later,space,original.id)]})).rejects.toThrow('task_binding_changed')
  expect((await pool.query('SELECT revision::int FROM memory_task_bundles WHERE bundle_id=$1',[original.id])).rows[0].revision).toBe(1)
 })
})
