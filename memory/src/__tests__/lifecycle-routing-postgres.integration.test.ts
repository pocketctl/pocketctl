import pg from 'pg'
import {createHash,randomUUID} from 'node:crypto'
import {beforeAll,beforeEach,afterAll,describe,test,expect} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {governanceFixture} from '../testing/governance-fixture.js'
import {createEpisodeRepository} from '../episodes/repository.js'
import {createSourceProjector} from '../projection/source-projector.js'
const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('lifecycle routing',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 afterAll(async()=>{await pool?.end()})
 beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE')})
 async function setup(mode:string,skill=false){
  const f=await governanceFixture(pool),session='lifecycle-session',turn='lifecycle-turn'
  await pool.query('INSERT INTO memory_curation_policies(installation_id,mode) VALUES($1,$2)',[f.personal,mode])
  const proof={version:1,producer:'claude',session_id:session,turn_id:turn,event_id:'source-1',sequence:'1',invocation_id:'input',source_role:'user',skill_state:skill?'skill':'non_skill',lineage_complete:true,derived_from_event_ids:[]}
  for(const [id,type,data,classification]of [[1,'user_text',{text:'SYNTHETIC_BODY'},{memory_source:proof}],[2,'turn_status',{turn_status:'completed'},{}]]as const){
   await pool.query(`INSERT INTO memory_feed_inbox(installation_id,feed_id,envelope_version,topic,source_kind,source_id,session_id,turn_id,event_type,recorded_at,classification,data,payload_hash)
    VALUES($1,$2::bigint,1,'session.event.v1','canonical_event',$2::bigint::text,$3,$4,$5,NOW()-interval '1 minute',$6::jsonb,$7::jsonb,$8)`,[f.personal,id,session,turn,type,JSON.stringify(classification),JSON.stringify(data),createHash('sha256').update(String(id)).digest()])
  }
  await createSourceProjector(pool,{stabilizationMs:0}).projectOnce(f.personal)
  return{...f,turn}
 }
 test('AC-03 source_projection_preserves_trusted_channel',async()=>{
  const f=await setup('off')
  const row=(await pool.query("SELECT source_provenance FROM source_events WHERE installation_id=$1 AND event_type='user_text'",[f.personal])).rows[0]
  expect(row.source_provenance.memory.skill_state).toBe('non_skill')
 })
 test('AC-08 enabled_owns_source',async()=>{
  const f=await setup('enabled')
  const repository=createEpisodeRepository(pool,{stabilizationMs:0,lifecycleMode:'enabled'} as any)
  await repository.compileTurn(f.personal,f.turn)
  await repository.compileTurn(f.personal,f.turn)
  expect((await pool.query('SELECT count(*)::int n FROM memory_task_bundles WHERE installation_id=$1',[f.personal])).rows[0].n).toBe(1)
  expect((await pool.query('SELECT count(*)::int n FROM work_episodes WHERE installation_id=$1 AND turn_id=$2',[f.personal,f.turn])).rows[0].n).toBe(0)
  expect((await pool.query("SELECT count(*)::int n FROM memory_jobs WHERE installation_id=$1 AND job_type='consolidate_task'",[f.personal])).rows[0].n).toBe(1)
 })
 test('AC-08 off_keeps_legacy_owner',async()=>{
  const f=await setup('enabled')
  await createEpisodeRepository(pool,{stabilizationMs:0}).compileTurn(f.personal,f.turn)
  expect((await pool.query('SELECT count(*)::int n FROM memory_task_bundles')).rows[0].n).toBe(0)
  expect((await pool.query('SELECT count(*)::int n FROM work_episodes WHERE installation_id=$1 AND turn_id=$2',[f.personal,f.turn])).rows[0].n).toBe(1)
 })
 test('AC-03 excluded_source_has_no_bundle_body',async()=>{
  const f=await setup('enabled',true)
  await createEpisodeRepository(pool,{stabilizationMs:0,lifecycleMode:'enabled'} as any).compileTurn(f.personal,f.turn)
  expect((await pool.query('SELECT count(*)::int n FROM memory_task_bundle_sources')).rows[0].n).toBe(0)
  expect((await pool.query('SELECT count(*)::int n FROM memory_source_processing_receipts')).rows[0].n).toBe(1)
  expect((await pool.query('SELECT count(*)::int n FROM memory_candidates')).rows[0].n).toBe(0)
 })
})
