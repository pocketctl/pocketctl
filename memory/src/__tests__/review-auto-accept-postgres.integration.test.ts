import {startGovernanceBackfill,backfillGovernance,governanceEnvironmentFingerprint} from '../migrations/governance-v2/backfill.js'
import {validateGovernanceMigration} from '../migrations/governance-v2/validate.js'
import {ensureGovernanceIndexes} from '../migrations/governance-v2/cutover.js'
import {createMemoryPool} from '../db.js'
import {randomUUID,createHash} from 'node:crypto'
import {createAutomationRepository} from '../governance/automation-repository.js'
import {createLifecycleService} from '../claims/lifecycle-service.js'
import {createClaimRepository} from '../claims/repository.js'
import pg from 'pg'
import {beforeAll,beforeEach,afterAll,describe,test,expect} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {governanceFixture} from '../testing/governance-fixture.js'
import {personalAcceptanceDigest,createAutomationAcceptanceService,validatePersonalFact} from '../governance/automation-acceptance-service.js'
const url=process.env.MEMORY_TEST_DATABASE_URL,suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('A2 closed gate and exact personal facts',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=createMemoryPool({databaseUrl:url!,dbPoolMax:8});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 afterAll(async()=>{await pool?.end()})
 beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE')})
 async function eligibleFixture(){
  const f=await governanceFixture(pool),repository=randomUUID(),repoSnapshot=randomUUID(),snapshot=randomUUID(),episode=randomUUID(),event=randomUUID(),run=randomUUID(),candidateId=randomUUID(),principalId=randomUUID()
  const sha='b'.repeat(40),blob=createHash('sha256').update('x').digest('hex'),path='src/a.ts',handle='event-fact-proof'
  const statement=`Snapshot ${sha} contains file "${path}" with SHA-256 ${blob}.`,structured={fact_kind:'file_digest',path,blob_hash:blob}
  await pool.query(`INSERT INTO repositories(repository_id,installation_id,repository_key,canonical_remote,first_observed_at,last_observed_at) VALUES($1,$2,'confirmed-fact','https://example.invalid/fact.git',NOW(),NOW())`,[repository,f.personal])
  await pool.query(`INSERT INTO repo_snapshots(repo_snapshot_id,installation_id,repository_id,commit_sha,observed_at) VALUES($1,$2,$3,$4,NOW())`,[repoSnapshot,f.personal,repository,sha])
  await pool.query(`INSERT INTO memory_source_snapshots(snapshot_id,installation_id,repository_id,commit_sha,git_object_format,manifest_hash,state,generation,parser_matrix_version,file_count,byte_count) VALUES($1,$2,$3,$4,'sha1',$5,'active',1,'fixture',1,1)`,[snapshot,f.personal,repository,sha,'c'.repeat(64)])
  await pool.query(`INSERT INTO memory_source_blobs(installation_id,blob_hash,byte_count,utf8_content) VALUES($1,$2,1,'x')`,[f.personal,blob])
  await pool.query(`INSERT INTO memory_source_snapshot_entries(snapshot_id,installation_id,path,blob_hash,language,capability,byte_count,mode) VALUES($1,$2,$3,$4,'typescript','file_only',1,'100644')`,[snapshot,f.personal,path,blob])
  await pool.query(`INSERT INTO source_events(source_event_id,installation_id,origin,origin_position,session_id,turn_id,event_type,occurred_at,payload,payload_hash,source_provenance) VALUES($1,$2,'feed','fact-proof','fact-session','fact-turn','user_message',NOW(),'{}','x'::bytea,'{"source_class":"native_personal"}')`,[event,f.personal])
  await pool.query(`INSERT INTO work_episodes(installation_id,episode_id,session_id,turn_id,state,compiler_version,source_digest,document,evidence_manifest) VALUES($1,$2,'fact-session','fact-turn','ready','fixture','x'::bytea,$3,$4)`,[f.personal,episode,{final_outcome:{text:statement,evidence_handle:handle}},{[handle]:{kind:'event',source_event_id:event}}])
  await pool.query(`INSERT INTO memory_extraction_runs(run_id,installation_id,episode_id,episode_source_digest,extractor_version,prompt_version,model_config_hash,input_digest,mode,state,provider,model) VALUES($1,$2,$3,'x'::bytea,'fixture','fixture','x'::bytea,'x'::bytea,'enabled','succeeded','openai-compatible','fixture')`,[run,f.personal,episode])
  await pool.query(`INSERT INTO memory_candidates(candidate_id,installation_id,run_id,episode_id,ordinal,claim_type,statement,structured_content,normalized_key,scope_kind,scope_key,repository_id,repo_snapshot_id,confidence,freshness_at,status,evidence_handles) VALUES($1,$2,$3,$4,0,'implementation_map',$5,$6,'exact-file-fact','snapshot',$7,$8,$9,0.9,NOW(),'validated',$10)`,[candidateId,f.personal,run,episode,statement,structured,sha,repository,repoSnapshot,JSON.stringify([handle])])
  const own={primaryInstallationId:f.personal,configVersion:'1',scopeBindings:[{installation_id:f.personal,owner_scope_kind:'personal' as const,owner_scope_id:f.personal,membership_id:null,membership_revision:'0',authorization_epoch:'1',permissions:['read','policy_admin']}]}
  const policy=await createAutomationRepository(pool).setPolicy({installationId:f.personal,grant:own,expectedRevision:0,document:{mode:'assist',model:'no-model-rule',promptVersion:'review-v1',personalAutoAccept:true}})
  await pool.query(`INSERT INTO memory_governance_executor_principals(principal_id,installation_id,provider_client_id,state,permissions,authorization_epoch,valid_until,max_accepts_per_day,authorized_by_owner_id) VALUES($1,$2,'fixture-executor','active',ARRAY['auto_accept_personal'],1,NOW()+interval '1 hour',5,$2)`,[principalId,f.personal])
  await pool.query(`INSERT INTO memory_governance_v2_states(installation_id,identity_generation,phase,writer_floor) VALUES($1,2,'active','identity_v2') ON CONFLICT(installation_id) DO UPDATE SET identity_generation=2,phase='active',writer_floor='identity_v2'`,[f.personal])
  const row=(await pool.query('SELECT to_jsonb(c) AS row FROM memory_candidates c WHERE candidate_id=$1',[candidateId])).rows[0].row
  const input={installationId:f.personal,candidateId,expectedRevision:1,principalId,expectedDigest:personalAcceptanceDigest({candidate:row,sourceDigest:'78',policyHash:(await pool.query('SELECT policy_hash FROM memory_review_automation_policies WHERE policy_id=$1',[policy.policyId])).rows[0].policy_hash,snapshot:{commit_sha:sha,path,blob_hash:blob},authorizationEpoch:'1'})}
  const deps={pool,mode:'canary' as const,executorGrant:{providerClientId:'fixture-executor',installationId:f.personal,authorizationEpoch:'1',permissionRevision:'1',expiresAt:Math.floor(Date.now()/1000)+3600},canaryGate:async()=>({approved:true,reason:'fixture-only',proofHash:'d'.repeat(64)})}
  return {f,input,deps,principalId,event}
 }
 test('isolated canary contract commits independent machine authority and respects human withdrawal',async()=>{
  const {input,deps}=await eligibleFixture(),service=createAutomationAcceptanceService(deps)
  const first=await service.accept(input);expect(first).toMatchObject({accepted:true,reason:'exact_file_digest'})
  expect(await service.accept(input)).toMatchObject({accepted:true,reason:'replayed',versionId:first.versionId})
  expect((await pool.query('SELECT authority FROM knowledge_versions WHERE version_id=$1',[first.versionId])).rows[0].authority).toBe('automation_accepted')
  expect((await pool.query('SELECT COUNT(*)::int n FROM memory_review_decisions')).rows[0].n).toBe(0)
  await createLifecycleService(pool,createClaimRepository(pool)).revokeClaim({installationId:input.installationId,claimId:first.claimId!,expectedRevision:1})
  expect(await service.accept(input)).toMatchObject({accepted:false,reason:'human_override'})
 })
 test('incremental backfill preserves populated independent machine authority',async()=>{
  const {input,deps}=await eligibleFixture();expect((await createAutomationAcceptanceService(deps).accept(input)).accepted).toBe(true)
  const before=(await pool.query('SELECT to_jsonb(a) AS row FROM memory_automation_authority_records a')).rows
  const runId=await startGovernanceBackfill(pool,{installationIds:[input.installationId],environmentFingerprint:await governanceEnvironmentFingerprint(pool)})
  await backfillGovernance(pool,{runId,batchSize:2});await backfillGovernance(pool,{runId,batchSize:2});await ensureGovernanceIndexes(pool)
  expect((await validateGovernanceMigration(pool,runId)).violations).toEqual([])
  expect((await pool.query('SELECT to_jsonb(a) AS row FROM memory_automation_authority_records a')).rows).toEqual(before)
  expect((await pool.query("SELECT COUNT(*)::int n FROM memory_governance_migration_actions WHERE run_id=$1 AND entity_kind='memory_automation_authority_records'",[runId])).rows[0].n).toBe(1)
 })
 test('automatic admission waits for the session fence before owning the installation purge fence',async()=>{
  const {input,deps}=await eligibleFixture(),blocker=await pool.connect()
  try{
   await blocker.query('BEGIN');await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended('purge:session:'||$1||':fact-session',0))",[input.installationId])
   const pid=(await blocker.query('SELECT pg_backend_pid() pid')).rows[0].pid
   const work=createAutomationAcceptanceService(deps).accept(input)
   let blocked=false;for(let i=0;i<80;i++){blocked=(await pool.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS yes',[pid])).rows[0].yes;if(blocked)break;await new Promise(r=>setTimeout(r,10))};expect(blocked).toBe(true)
   const available=(await blocker.query("SELECT pg_try_advisory_xact_lock(hashtextextended('purge:installation:'||$1,0)) available",[input.installationId])).rows[0].available
   await blocker.query('ROLLBACK');await work
   expect(available).toBe(true)
  }finally{await blocker.query('ROLLBACK').catch(()=>undefined);blocker.release()}
 })
 test('actual commit blocking past principal expiry rolls back version, authority, feedback and index job',async()=>{
  const {input,deps,principalId}=await eligibleFixture(),blocker=await pool.connect(),key=8122062
  await pool.query(`CREATE FUNCTION automation_test_commit_block() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(8122062);RETURN NEW;END $$`)
  await pool.query(`CREATE TRIGGER automation_test_commit_block BEFORE INSERT ON memory_automation_authority_records FOR EACH ROW EXECUTE FUNCTION automation_test_commit_block()`)
  try{await blocker.query('SELECT pg_advisory_lock($1)',[key]);const pid=(await blocker.query('SELECT pg_backend_pid() pid')).rows[0].pid
   await pool.query("UPDATE memory_governance_executor_principals SET valid_until=clock_timestamp()+interval '500 milliseconds' WHERE principal_id=$1",[principalId])
   const work=createAutomationAcceptanceService(deps).accept(input)
   let blocked=false;for(let i=0;i<40;i++){blocked=(await pool.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS yes',[pid])).rows[0].yes;if(blocked)break;await new Promise(r=>setTimeout(r,10))};expect(blocked).toBe(true)
   for(let i=0;i<80;i++){if((await pool.query('SELECT valid_until<=clock_timestamp() expired FROM memory_governance_executor_principals WHERE principal_id=$1',[principalId])).rows[0].expired)break;await new Promise(r=>setTimeout(r,10))}
   await blocker.query('SELECT pg_advisory_unlock($1)',[key])
   expect(await work).toMatchObject({accepted:false,reason:'automation_actor_expired'})
   expect((await pool.query('SELECT COUNT(*)::int n FROM memory_automation_authority_records')).rows[0].n).toBe(0)
   expect((await pool.query('SELECT status FROM memory_candidates WHERE candidate_id=$1',[input.candidateId])).rows[0].status).toBe('validated')
   expect((await pool.query('SELECT COUNT(*)::int n FROM memory_feedback WHERE candidate_id=$1',[input.candidateId])).rows[0].n).toBe(0)
  }finally{await blocker.query('SELECT pg_advisory_unlock($1)',[key]);blocker.release();await pool.query('DROP TRIGGER automation_test_commit_block ON memory_automation_authority_records;DROP FUNCTION automation_test_commit_block()')}
 })
 test.each(['principal','policy','revision','origin','budget','grant'])('%s invalidation cannot write authority',async changed=>{
  const {input,deps,principalId,event}=await eligibleFixture()
  if(changed==='principal')await pool.query("UPDATE memory_governance_executor_principals SET state='disabled' WHERE principal_id=$1",[principalId])
  if(changed==='policy')await pool.query('DELETE FROM memory_review_automation_policy_heads WHERE installation_id=$1',[input.installationId])
  if(changed==='revision')await pool.query('UPDATE memory_candidates SET revision=2 WHERE candidate_id=$1',[input.candidateId])
  if(changed==='origin')await pool.query("UPDATE source_events SET origin='team' WHERE source_event_id=$1",[event])
  if(changed==='budget')await pool.query('UPDATE memory_governance_executor_principals SET max_accepts_per_day=0 WHERE principal_id=$1',[principalId])
  if(changed==='grant')deps.executorGrant.expiresAt=1
  expect((await createAutomationAcceptanceService(deps).accept(input)).accepted).toBe(false)
  expect((await pool.query('SELECT COUNT(*)::int n FROM memory_automation_authority_records')).rows[0].n).toBe(0)
 })
 test('off/assist cannot create automatic authority or accept a candidate',async()=>{
  const f=await governanceFixture(pool)
  for(const mode of ['off','assist'] as const){const result=await createAutomationAcceptanceService({pool,mode}).accept({installationId:f.personal,candidateId:f.claim,expectedRevision:1,expectedDigest:'a'.repeat(64),principalId:f.proposer});expect(result).toMatchObject({accepted:false,reason:'automatic_gate_closed'})}
  expect((await pool.query('SELECT COUNT(*)::int n FROM memory_automation_authority_records')).rows[0].n).toBe(0)
 })
 test('declared labels and insufficient holdout remain assist',async()=>{
  const f=await governanceFixture(pool),service=createAutomationAcceptanceService({pool,mode:'canary',canaryGate:async()=>({approved:false,reason:'human_calibration_required'})})
  expect(await service.accept({installationId:f.personal,candidateId:f.claim,expectedRevision:1,expectedDigest:'a'.repeat(64),principalId:f.proposer})).toMatchObject({accepted:false,reason:'human_calibration_required'})
 })
 test.each(['operational_runbook','bug_root_cause','repository_convention','test_invariant'])('whole claim type %s is not a whitelist',async claimType=>{
  expect(validatePersonalFact({claimType,scopeKind:'snapshot',statement:'Run the deploy command',structured:{fact_kind:'file_digest',path:'src/a.ts',blob_hash:'a'.repeat(64)},snapshot:{commitSha:'b'.repeat(40),path:'src/a.ts',blobHash:'a'.repeat(64)},origin:'native_personal'}).eligible).toBe(false)
 })
 test('a file fact requires the exact immutable snapshot, digest and statement',()=>{
  const fact={claimType:'implementation_map',scopeKind:'snapshot',statement:`Snapshot ${'b'.repeat(40)} contains file "src/a.ts" with SHA-256 ${'a'.repeat(64)}.`,structured:{fact_kind:'file_digest',path:'src/a.ts',blob_hash:'a'.repeat(64)},snapshot:{commitSha:'b'.repeat(40),path:'src/a.ts',blobHash:'a'.repeat(64)},origin:'native_personal'}
  expect(validatePersonalFact(fact).eligible).toBe(true)
  for(const changed of [{...fact,origin:'team'},{...fact,origin:'unknown'},{...fact,statement:'This file fixes all race conditions'},{...fact,snapshot:{...fact.snapshot,blobHash:'c'.repeat(64)}}])expect(validatePersonalFact(changed).eligible).toBe(false)
 })
})
