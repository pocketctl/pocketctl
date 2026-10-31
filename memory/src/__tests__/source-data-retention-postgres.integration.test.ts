import {measureInventoryRecovery} from '../testing/measure-inventory-recovery.js'
import {inventoryMemory} from '../migrations/governance-v2/inventory.js'
import type {ExtensionFeedEnvelopeV1} from '../relay/contracts.js'
import {createSourceProjector} from '../projection/source-projector.js'
import {createInboxRepository} from '../inbox/repository.js'
import {createSnapshotRepository} from '../snapshot/repository.js'
import {createScopeResolver} from '../context/scope-resolver.js'
import pg from 'pg'
import {randomUUID,createHash} from 'node:crypto'
import {afterAll,beforeAll,beforeEach,describe,expect,test} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {previewSourceRetention,reclaimSourceTurn,type SourceRetentionSettings} from '../retention/source.js'
import {createEpisodeRepository} from '../episodes/repository.js'
import {createExtractionRepository} from '../extraction/repository.js'
import {capturePrivacyWatermarks,replayPrivacyWatermarks} from '../migrations/governance-v2/reconcile.js'
import {createPurgeRepository} from '../purge/repository.js'

const url=process.env.MEMORY_TEST_DATABASE_URL,suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
const installationId='72727272-7272-4272-8272-727272727272'
const settings:SourceRetentionSettings={mode:'enabled',bodyDays:14,batchSize:1,intervalMs:86400000}
suite('source-chain body reclamation (PostgreSQL)',()=>{
 let pool:pg.Pool,episodeId:string,runId:string,eventId:string,candidateId:string
 const key=()=>({installationId,sessionId:'ret-session',turnId:'ret-turn',episodeId})
 const read=async(table:string)=>(await pool.query(`SELECT * FROM ${table} WHERE installation_id=$1`,[installationId])).rows[0]
 async function event(position:string,turnId:string|null='ret-turn'){
  return (await pool.query(`INSERT INTO source_events(source_event_id,installation_id,origin,origin_position,session_id,turn_id,event_type,occurred_at,payload,payload_hash,created_at)
   VALUES(gen_random_uuid(),$1,'feed',$2,'ret-session',$3,'message',NOW()-INTERVAL '20 days',$4,decode($5,'hex'),NOW()-INTERVAL '20 days') RETURNING source_event_id`,
   [installationId,position,turnId,{text:'sensitive source body',repository_id:'git:stable-repository',turn_id:turnId,event_id:position},createHash('sha256').update(position).digest('hex')])).rows[0].source_event_id
 }
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url,max:6});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 afterAll(async()=>{await pool?.end()})
 beforeEach(async()=>{
  await pool.query('TRUNCATE memory_purge_receipts,memory_session_tombstones,memory_installations CASCADE')
  await pool.query('TRUNCATE memory_governance_migration_summaries,memory_governance_migration_runs CASCADE')
  await pool.query(`INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)`,[installationId])
  await pool.query(`INSERT INTO memory_feature_settings(installation_id,extraction_mode) VALUES($1,'enabled')`,[installationId])
  await pool.query(`INSERT INTO source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES($1,'ret-session',NOW()-INTERVAL '20 days',NOW()-INTERVAL '20 days')`,[installationId])
  await pool.query(`INSERT INTO source_turns(installation_id,turn_id,session_id,state,terminal_at,updated_at) VALUES($1,'ret-turn','ret-session','completed',NOW()-INTERVAL '20 days',NOW()-INTERVAL '20 days')`,[installationId])
  eventId=await event('1');await event('2')
  episodeId=(await pool.query(`INSERT INTO work_episodes(installation_id,episode_id,session_id,turn_id,state,compiler_version,document_compiler_version,document,evidence_manifest,summary,compiled_at,source_digest)
    VALUES($1,gen_random_uuid(),'ret-session','ret-turn','ready','v1','v1','{"text":"episode body"}','{"h":{"text":"evidence"}}','{"text":"summary","references":{"repository_id":"git:stable-repository"}}',NOW()-INTERVAL '20 days','x'::bytea) RETURNING episode_id`,[installationId])).rows[0].episode_id
  runId=(await pool.query(`INSERT INTO memory_extraction_runs(run_id,installation_id,episode_id,episode_source_digest,extractor_version,prompt_version,model_config_hash,input_digest,mode,state,provider,model,completed_at)
    VALUES(gen_random_uuid(),$1,$2,'x'::bytea,'e1','p1','x'::bytea,'x'::bytea,'enabled','succeeded','openai-compatible','m',NOW()-INTERVAL '19 days') RETURNING run_id`,[installationId,episodeId])).rows[0].run_id
  candidateId=(await pool.query(`INSERT INTO memory_candidates(candidate_id,installation_id,run_id,episode_id,ordinal,claim_type,statement,normalized_key,scope_kind,scope_key,confidence,freshness_at,evidence_handles,status,created_at)
   VALUES(gen_random_uuid(),$1,$2,$3,0,'repository_convention','candidate body','key','installation','global',0.9,NOW(),'["h"]','validated',NOW()-INTERVAL '18 days') RETURNING candidate_id`,[installationId,runId,episodeId])).rows[0].candidate_id
  await pool.query(`INSERT INTO source_artifacts(artifact_id,installation_id,session_id,turn_id,source_event_id,artifact_type,identity_key,details,occurred_at)
    VALUES(gen_random_uuid(),$1,'ret-session','ret-turn',$2,'file_change','file:a','{"body":"artifact body"}',NOW())`,[installationId,eventId])
 })
 test('preview is read-only; bounded passes freeze a whole turn and preserve hashes/context/identities',async()=>{
  const before=await read('source_events')
  expect((await previewSourceRetention(pool)).eligible).toHaveLength(1)
  expect((await pool.query('SELECT count(*)::int n FROM memory_source_retention_receipts')).rows[0].n).toBe(0)
  const first=await reclaimSourceTurn(pool,key(),settings)
  expect(first).toMatchObject({events:1,candidates:1,artifacts:1,episodes:0,finished:false})
  expect((await previewSourceRetention(pool)).reclaiming).toHaveLength(1)
  const second=await reclaimSourceTurn(pool,key(),settings)
  expect(second).toMatchObject({events:1,episodes:1,finished:true})
  expect(await read('work_episodes')).toMatchObject({document:{},evidence_manifest:{},source_digest:Buffer.from('x')})
  expect((await read('work_episodes')).retained_content_hash).toMatch(/^[a-f0-9]{64}$/)
  expect(await read('memory_candidates')).toMatchObject({candidate_id:candidateId,status:'expired',statement:'[content reclaimed]',evidence_handles:[],revision:'2'})
  expect((await pool.query('SELECT payload,payload_hash FROM source_events WHERE source_event_id=$1',[before.source_event_id])).rows[0]).toEqual({payload:{repository_id:'git:stable-repository',turn_id:'ret-turn',event_id:before.payload.event_id},payload_hash:before.payload_hash})
  expect((await read('memory_extraction_runs')).run_id).toBe(runId)
  expect(await reclaimSourceTurn(pool,key(),settings)).toMatchObject({events:0,episodes:0,candidates:0,finished:true})
 })
 test.each([
  ["UPDATE memory_extraction_runs SET completed_at=NOW()-INTERVAL '13 days'",'young extraction'],
  ["UPDATE memory_extraction_runs SET state='failed'",'failed extraction'],
  ["UPDATE memory_extraction_runs SET episode_source_digest='other'::bytea",'old source version'],
  ["UPDATE memory_candidates SET created_at=NOW()",'unexpired review'],
  ["UPDATE memory_feature_settings SET extraction_mode='off'",'disabled extraction'],
  ["UPDATE source_turns SET terminal_at=NULL",'unterminated turn'],
  ["UPDATE source_events SET created_at=NOW()",'unprocessed late event'],
  ["UPDATE memory_installations SET snapshot_required=TRUE",'snapshot required'],
 ])('fails closed for %s (%s)',async(sql)=>{
  await pool.query(sql)
  expect((await previewSourceRetention(pool)).eligible).toHaveLength(0)
  expect((await reclaimSourceTurn(pool,key(),settings)).skipped).not.toBeNull()
  expect((await read('work_episodes')).document).toEqual({text:'episode body'})
 })
 test('zero-candidate success is eligible, session-level observations are retained',async()=>{
  await pool.query('DELETE FROM memory_candidates');await event('3',null)
  expect((await reclaimSourceTurn(pool,key(),{...settings,batchSize:10})).finished).toBe(true)
  const observation=(await pool.query('SELECT payload,body_reclaimed_at FROM source_events WHERE turn_id IS NULL')).rows[0]
  expect(observation.body_reclaimed_at).toBeNull();expect(observation.payload.text).toBe('sensitive source body')
 })
 test('unsealed scoped migrations block all body cleanup, even when validated',async()=>{
  await pool.query(`INSERT INTO memory_governance_migration_runs(run_id,environment_fingerprint,schema_version,manifest,state) VALUES(gen_random_uuid(),'test',72,$1,'validated')`,[{installationIds:[installationId],startWatermark:'0'}])
  expect((await previewSourceRetention(pool)).eligible).toHaveLength(0)
  expect((await reclaimSourceTurn(pool,key(),settings)).skipped).toBe('migration')
 })
 test('installation writer fence prevents clearing in-flight source data',async()=>{
  const c=await pool.connect();try{await c.query('BEGIN');await c.query(`SELECT pg_advisory_xact_lock_shared(hashtextextended('purge:installation:'||$1,0))`,[installationId])
   expect((await reclaimSourceTurn(pool,key(),settings)).skipped).toBe('busy')
  }finally{await c.query('ROLLBACK');c.release()}
  expect((await reclaimSourceTurn(pool,key(),settings)).events).toBe(1)
 })
 test('receipt prevents source rehydration, source hash modification and half-source recompilation',async()=>{
  await reclaimSourceTurn(pool,key(),settings)
  const late=await event('3')
  expect((await pool.query('SELECT payload,body_reclaimed_at FROM source_events WHERE source_event_id=$1',[late])).rows[0].payload.text).toBeUndefined()
  await expect(pool.query("UPDATE source_events SET payload_hash='new'::bytea WHERE source_event_id=$1",[late])).rejects.toThrow('retained_source_hash_changed')
  await pool.query(`UPDATE source_events SET payload=payload||'{"text":"replayed old body"}' WHERE source_event_id=$1`,[late])
  expect((await pool.query('SELECT payload FROM source_events WHERE source_event_id=$1',[late])).rows[0].payload.text).toBeUndefined()
  await createEpisodeRepository(pool).compileTurn(installationId,'ret-turn')
  expect((await read('work_episodes')).document).toEqual({text:'episode body'}) // frozen, pending remaining batch
  expect(await createExtractionRepository(pool).loadEpisodeForExtraction(installationId,'ret-turn')).toBeNull()
  await reclaimSourceTurn(pool,key(),{...settings,batchSize:10})
  await expect(pool.query("UPDATE memory_candidates SET statement='rehydrated' WHERE candidate_id=$1",[candidateId])).rejects.toThrow('source_body_reclaimed')
  await expect(pool.query("UPDATE work_episodes SET document='{\"text\":\"rehydrated\"}' WHERE episode_id=$1",[episodeId])).rejects.toThrow('source_body_reclaimed')
 })
 test('metadata-only source never gains new raw evidence or skill dependency',async()=>{
  await reclaimSourceTurn(pool,key(),settings)
  // Guard executes before FKs; no synthetic knowledge version can attach to it.
  await expect(pool.query(`INSERT INTO knowledge_evidence(evidence_id,installation_id,version_id,evidence_kind,episode_id)
   VALUES(gen_random_uuid(),$1,gen_random_uuid(),'episode',$2)`,[installationId,episodeId])).rejects.toThrow('source_body_reclaimed')
 })
 test('late feed projection clears its inbox body and records metadata without rescheduling',async()=>{
  await reclaimSourceTurn(pool,key(),{...settings,batchSize:10})
  const inbox=createInboxRepository(pool),envelope:ExtensionFeedEnvelopeV1={envelope_version:1 as const,feed_id:'99',topic:'session.event.v1',
   source:{kind:'canonical_event',id:'late-event',recorded_at:'2026-01-01T00:00:00.000Z'},
   subject:{session_id:'ret-session',turn_id:'ret-turn',event_type:'agent_text'},
   classification:{actor_scope:'root',flow_scope:'main',content_class:'dialogue'},data:{event_id:'late-event',text:'late private body'}}
  await inbox.commitBatch({installationId,envelopes:[envelope],rawQuarantined:[],cursor:'c',leaseToken:'l',ack:async()=>99})
  await createSourceProjector(pool).projectOnce(installationId)
  expect(await read('memory_feed_inbox')).toMatchObject({projection_state:'projected',data:{},error_code:'source_body_reclaimed'})
  expect((await read('memory_source_retention_receipts')).late_events).toBe('1')
  expect((await pool.query(`SELECT count(*)::int n FROM memory_jobs WHERE job_type IN('compile_episode','extract_candidates')`)).rows[0].n).toBe(0)
 })
 test('snapshot replay retains archived identities, never refills bodies or schedules compilation',async()=>{
  await reclaimSourceTurn(pool,key(),{...settings,batchSize:10})
  const snapshot=createSnapshotRepository(pool),run=await snapshot.startRun(installationId),event={event_id:100,event_type:'agent_text',created_at:'2026-01-01T00:00:00Z',payload:{turn_id:'ret-turn',event_id:'event-100',text:'old snapshot body',repository_id:'git:stable-repository'}}
  await snapshot.persistSessionEvents(installationId,run.generation,'ret-session',[event])
  expect((await read('memory_snapshot_events')).payload.text).toBeUndefined()
  await snapshot.finalizeRun({installationId,generation:run.generation,inventorySessionIds:['ret-session'],sessionsSeen:1,eventsSeen:1})
  expect((await pool.query('SELECT 1 FROM source_events WHERE source_event_id=$1',[eventId])).rowCount).toBe(1)
  expect((await read('work_episodes')).document).toEqual({})
  expect((await pool.query(`SELECT count(*)::int n FROM memory_jobs WHERE job_type='compile_episode'`)).rows[0].n).toBe(0)
  await expect(snapshot.persistSessionEvents(installationId,run.generation,'ret-session',[{...event,payload:{...event.payload,text:'tampered'}}])).rejects.toThrow('snapshot integrity violation')
 })
 test('repository fallback and narrowing remain unchanged after body reclamation',async()=>{
  await pool.query(`INSERT INTO repositories(repository_id,installation_id,repository_key,first_observed_at,last_observed_at) VALUES(gen_random_uuid(),$1,'git:stable-repository',NOW(),NOW())`,[installationId])
  const resolver=createScopeResolver(pool),input={installationId,sessionId:'ret-session'},before=await resolver.resolve(input)
  expect(before.repositoryKnown).toBe(true)
  await reclaimSourceTurn(pool,key(),{...settings,batchSize:10})
  expect(await resolver.resolve(input)).toEqual(before)
  expect(await resolver.resolve({...input,repositoryKeyHint:'unknown'})).toMatchObject({repositoryKnown:false,personaOnly:true})
 })
 async function knowledge(){
  const claim=randomUUID(),version=randomUUID()
  await pool.query(`INSERT INTO knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state) VALUES($1,$2,'test_invariant','installation','global','ret-knowledge','active')`,[claim,installationId])
  await pool.query(`INSERT INTO knowledge_versions(version_id,installation_id,claim_id,version_number,statement,authority,confidence) VALUES($1,$2,$3,1,'independent formal knowledge','user_accepted',0.9)`,[version,installationId,claim])
  await pool.query('UPDATE knowledge_claims SET current_version_id=$2 WHERE claim_id=$1',[claim,version]);return version
 }
 test('a direct evidence reference blocks cleanup; independent accepted evidence and formal knowledge survive',async()=>{
  const version=await knowledge(),evidence=randomUUID()
  await pool.query(`INSERT INTO knowledge_evidence(evidence_id,installation_id,version_id,episode_id,ordinal,evidence_kind,excerpt,excerpt_hash,occurred_at) VALUES($1,$2,$3,$4,0,'episode','retained proof','hash'::bytea,NOW())`,[evidence,installationId,version,episodeId])
  expect((await previewSourceRetention(pool)).eligible).toHaveLength(0)
  expect((await reclaimSourceTurn(pool,key(),settings)).skipped).toBe('not_eligible')
  const capsule=(await pool.query(`INSERT INTO knowledge_evidence_capsules(capsule_id,installation_id,version_id,retention_basis,accepted_at,source_content_hash) VALUES(gen_random_uuid(),$1,$2,'user_accepted',NOW(),'hash'::bytea) RETURNING capsule_id`,[installationId,version])).rows[0].capsule_id
  await pool.query(`UPDATE knowledge_evidence SET episode_id=NULL,evidence_kind='accepted_excerpt',capsule_id=$2 WHERE evidence_id=$1`,[evidence,capsule])
  expect((await reclaimSourceTurn(pool,key(),{...settings,batchSize:10})).finished).toBe(true)
  expect((await read('knowledge_versions')).statement).toBe('independent formal knowledge')
  expect((await read('knowledge_evidence')).excerpt).toBe('retained proof')
  expect((await read('knowledge_evidence_capsules')).capsule_id).toBe(capsule)
 })
 test('off is inert; privacy purge removes the receipt along with the session',async()=>{
  expect((await reclaimSourceTurn(pool,key(),{...settings,mode:'off'})).skipped).toBe('disabled')
  await reclaimSourceTurn(pool,key(),settings)
  await createPurgeRepository(pool,{hmacKey:'test'}).purgeSession({installationId,sessionId:'ret-session',sourceFeedId:null,reason:'test'})
  expect((await pool.query('SELECT count(*)::int n FROM memory_source_retention_receipts')).rows[0].n).toBe(0)
 })
 test.skipIf(!url?.includes('/pocketctl_memory_upgrade_test'))('actual dump/restore applies newer body reclamation before consumers resume',async()=>{
  let capsule:Awaited<ReturnType<typeof capturePrivacyWatermarks>>|undefined
  await measureInventoryRecovery(pool,url!,{beforeRestore:async()=>{
   await reclaimSourceTurn(pool,key(),{...settings,batchSize:10});capsule=await capturePrivacyWatermarks(pool)
  }})
  expect((await read('work_episodes')).document).toEqual({text:'episode body'})
  await replayPrivacyWatermarks(pool,JSON.parse(JSON.stringify(capsule)),{purgeHmacKey:'test'})
  expect((await read('work_episodes')).document).toEqual({})
  expect((await read('memory_installations')).local_status).toBe('integrity_error')
 })
 test('inventory distinguishes expected reclaimed bodies without exposing them',async()=>{
  await reclaimSourceTurn(pool,key(),{...settings,batchSize:10})
  const inventory=await inventoryMemory(pool)
  expect(inventory.counts['retention.source_events.reclaimed']).toBe(2)
  expect(inventory.counts['retention.turns.reclaimed']).toBe(1)
  expect(JSON.stringify(inventory)).not.toContain('sensitive source body')
 })
 test('recovery capsule clears old backup bodies before service may resume',async()=>{
  const original=await read('work_episodes')
  await reclaimSourceTurn(pool,key(),{...settings,batchSize:10})
  const capsule=JSON.parse(JSON.stringify(await capturePrivacyWatermarks(pool)))
  // Simulate a backup from before reclamation. Consumer hold is restored first.
  await pool.query('DELETE FROM memory_source_retention_receipts')
  await pool.query('ALTER TABLE work_episodes DISABLE TRIGGER memory_retention_episode_guard')
  try{await pool.query('UPDATE work_episodes SET document=$2,evidence_manifest=$3,body_reclaimed_at=NULL WHERE episode_id=$1',[episodeId,original.document,original.evidence_manifest])}finally{await pool.query('ALTER TABLE work_episodes ENABLE TRIGGER memory_retention_episode_guard')}
  await replayPrivacyWatermarks(pool,capsule,{purgeHmacKey:'test'})
  expect((await read('work_episodes')).document).toEqual({})
  expect((await read('memory_installations')).local_status).toBe('integrity_error')
  expect((await read('memory_source_retention_receipts')).state).toBe('reclaimed')
 })
})
