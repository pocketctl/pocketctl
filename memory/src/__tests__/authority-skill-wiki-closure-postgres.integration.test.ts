import pg from 'pg'
import {createHash,randomUUID} from 'node:crypto'
import {afterAll,beforeAll,beforeEach,describe,expect,test} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {createSkillAdmissionService} from '../skills/admission-service.js'
import {loadSkillConfig} from '../skills/config.js'
import type {V2GrantFacts} from '../governance/authorization.js'
import {createWikiBuildService} from '../wiki/build-service.js'
import {createPurgeRepository} from '../purge/repository.js'
import {insertWikiCandidateFixture} from './helpers/phase4-wiki-fixture.js'
import {createSkillGovernanceFixture,skillFixtureDocument} from '../testing/skill-fixture.js'
import {createSkillReviewService} from '../skills/review-service.js'
import {createSkillPublicationFixture} from '../testing/skill-publication-fixture.js'
import {createSkillPublicationService} from '../skills/publication-service.js'
import {createSkillReplayService} from '../skills/replay-service.js'
import {createSkillExecutionService} from '../skills/execution-service.js'
import {createSkillRolloutService} from '../skills/rollout-service.js'
import {createSkillWorker} from '../skills/worker.js'
import {createJobRepository} from '../jobs/repository.js'
import {SkillCandidateDocumentSchema} from '../skills/types.js'
import {createSkillReadService} from '../skills/read-service.js'

const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('Task06 Skill source rediscovery and Wiki scheduling closure',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url,max:8});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 beforeEach(async()=>{await pool.query('TRUNCATE memory_session_tombstones,memory_purge_receipts,memory_installations CASCADE')})
 afterAll(async()=>{await pool.end()})
 function gate(){let reach!:()=>void,release!:()=>void;return {reached:new Promise<void>(r=>{reach=r}),allowed:new Promise<void>(r=>{release=r}),reach:()=>reach(),release:()=>release()}}
 function hook(after:(sql:string)=>Promise<void>,onPid?:(pid:number)=>void){
  return {query:pool.query.bind(pool),connect:async()=>{const client=await pool.connect();onPid?.((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
   return new Proxy(client,{get(target,key){
    if(key==='query')return async(...args:unknown[])=>{const result=await Reflect.apply(target.query,target,args);if(typeof args[0]==='string')await after(args[0]);return result}
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
   }})}} as unknown as pg.Pool
 }
 async function block(pid:()=>number|undefined,finished:()=>boolean){
  for(let i=0;i<150;i++){const id=pid();if(id&&(await pool.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked',[id])).rows[0].blocked)return
   if(finished())return;await new Promise(r=>setTimeout(r,10))}
  throw new Error('operation never reached lifecycle wait')
 }
 async function episodeFixture(){
  const installationId=randomUUID(),repositoryId=randomUUID(),snapshotId=randomUUID(),episodeId=randomUUID(),sessionId='source-original'
  await pool.query("INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[installationId])
  await pool.query("INSERT INTO memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id) VALUES($1,'personal',$1)",[installationId])
  for(const id of [sessionId,'source-replaced'])await pool.query('INSERT INTO source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES($1,$2,NOW(),NOW())',[installationId,id])
  await pool.query('INSERT INTO repositories(installation_id,repository_id,repository_key,first_observed_at,last_observed_at) VALUES($1,$2,$2::uuid::text,NOW(),NOW())',[installationId,repositoryId])
  await pool.query('INSERT INTO repo_snapshots(installation_id,repo_snapshot_id,repository_id,commit_sha,observed_at) VALUES($1,$2,$3,$4,NOW())',[installationId,snapshotId,repositoryId,'a'.repeat(40)])
  const excerpt='tests passed',hash=createHash('sha256').update(excerpt).digest('hex').slice(0,16)
  await pool.query(`INSERT INTO work_episodes(installation_id,episode_id,session_id,turn_id,state,outcome,ready_at,compiler_version,
    repository_id,repo_snapshot_id,source_digest,document,evidence_manifest,document_compiler_version,compiled_at)
    VALUES($1,$2,$3,$2::uuid::text,'ready','completed',NOW()-interval '1 second','fixture',$4,$5,decode($6,'hex'),$7,$8,'packet.v1',NOW())`,
   [installationId,episodeId,sessionId,repositoryId,snapshotId,'b'.repeat(64),{tests:[{status:'passed',text:excerpt,evidence_handle:'e1'}]},
    {e1:{kind:'episode',excerpt_hash:hash,excerpt_length:excerpt.length,truncated:false}}])
  const grant:V2GrantFacts={primaryInstallationId:installationId,configVersion:'1',scopeBindings:[{installation_id:installationId,owner_scope_kind:'personal',owner_scope_id:installationId,membership_id:null,membership_revision:'0',authorization_epoch:'1',permissions:['read','contribute']}]}
  return {installationId,episodeId,sessionId,grant}
 }
 test('Skill admission rejects an actual locked Episode Session outside its discovered set and fresh retry succeeds',async()=>{
  const f=await episodeFixture(),g=gate();let paused=false
  const wrapped=hook(async sql=>{if(!paused&&sql.includes('SELECT session_id FROM work_episodes')){paused=true;g.reach();await g.allowed}})
  const context={globalMode:'enabled' as const,sharedMode:'off' as const,config:loadSkillConfig({MEMORY_SKILL_MODE:'shadow'})}
  const input={installationId:f.installationId,grant:f.grant,candidateKey:'closure-source',source:{kind:'episode',episodeId:f.episodeId}}
  const pending=createSkillAdmissionService({pool:wrapped,context}).schedule(input),outcome=pending.then(value=>({value}),error=>({error}))
  try{
   await Promise.race([g.reached,outcome.then(r=>{throw 'error' in r?r.error:new Error('Skill source lookup missed barrier')})])
   // Bridge-compatible direct writer replaces provenance between preliminary
   // Session lookup and the actual row-locked source read.
   await pool.query("UPDATE work_episodes SET session_id='source-replaced' WHERE installation_id=$1 AND episode_id=$2",[f.installationId,f.episodeId]);g.release()
   expect(await outcome).toMatchObject({error:{code:'skill_source_invalid'}})
   expect((await pool.query('SELECT 1 FROM memory_skill_tasks')).rowCount).toBe(0)
   expect((await pool.query("SELECT 1 FROM memory_jobs WHERE job_type='extract_skill_candidate'")).rowCount).toBe(0)
   expect(await createSkillAdmissionService({pool,context}).schedule(input)).toMatchObject({deduplicated:false})
   expect((await pool.query('SELECT e.session_id FROM memory_skill_task_runs r JOIN work_episodes e USING(installation_id,episode_id)')).rows[0]).toEqual({session_id:'source-replaced'})
  }finally{g.release();await pending.catch(()=>undefined)}
 },15000)
 for(const action of ['draft','edit','approve'] as const){
  for(const phase of ['before_source_read','after_final_write'] as const){
   test(`native Skill ${action} rejects source expiry ${phase} and rolls back formal records`,async()=>{
    const context={globalMode:'enabled' as const,sharedMode:'shadow' as const,config:loadSkillConfig({MEMORY_SKILL_MODE:'shadow'})}
    const f=await createSkillGovernanceFixture(pool,context,'team'),plain=createSkillReviewService({pool,context}),g=gate();let paused=false
    const draft=action==='draft'?null:await plain.execute(f.author,{action:'draft',candidateId:f.candidateId,expectedRevision:0})
    const identity=action==='approve'?await f.actor(['reviewer'],['read','review']):f.author
    const sourceVersion=(await pool.query('SELECT a.claim_version_id FROM memory_skill_archives a JOIN memory_skill_candidates c USING(installation_id,archive_id) WHERE c.installation_id=$1 AND c.candidate_id=$2',[f.installationId,f.candidateId])).rows[0].claim_version_id
    const beforeVersions=(await pool.query('SELECT 1 FROM memory_skill_versions WHERE installation_id=$1',[f.installationId])).rowCount
    const deadline=Number((await pool.query('SELECT extract(epoch FROM clock_timestamp())::float8 AS now')).rows[0].now)+1
    await pool.query('UPDATE knowledge_versions SET valid_until=to_timestamp($2) WHERE installation_id=$1 AND version_id=$3',[f.installationId,deadline,sourceVersion])
    const wrapped=hook(async sql=>{
     const matches=phase==='before_source_read'?sql.includes('SELECT 1 FROM memory_installations')&&sql.includes('FOR SHARE'):sql.includes('INSERT INTO memory_skill_audit_events')
     if(!paused&&matches){paused=true;g.reach();await g.allowed}
    })
    const request=action==='draft'?{action,candidateId:f.candidateId,expectedRevision:0}:action==='edit'?{action,skillId:draft!.skillId,expectedRevision:1,document:{...skillFixtureDocument(),title:'Source clock edit'}}:{action,skillId:draft!.skillId,expectedRevision:1}
    const pending=createSkillReviewService({pool:wrapped,context}).execute(identity,request),outcome=pending.then(value=>({value}),error=>({error}))
    try{
     await Promise.race([g.reached,outcome.then(r=>{throw 'error' in r?r.error:new Error('Skill source clock missed barrier')})])
     await pool.query('SELECT pg_sleep(GREATEST(0,$1-extract(epoch FROM clock_timestamp()))::float8)',[deadline+0.03]);g.release()
     expect(await outcome).toMatchObject({error:{code:'source_invalid'}})
     expect((await pool.query('SELECT 1 FROM memory_skill_versions WHERE installation_id=$1',[f.installationId])).rowCount).toBe(beforeVersions)
     expect((await pool.query('SELECT 1 FROM memory_skill_review_decisions WHERE installation_id=$1',[f.installationId])).rowCount).toBe(0)
     if(draft)expect((await pool.query('SELECT revision::int,state FROM memory_skill_heads WHERE installation_id=$1 AND skill_id=$2',[f.installationId,draft.skillId])).rows[0]).toEqual({revision:1,state:'draft'})
    }finally{g.release();await pending.catch(()=>undefined)}
   },15000)
  }
 }
 for(const action of ['admission','publish','replay_start','replay_complete','execution_start','execution_complete'] as const){for(const expiry of action.startsWith('execution')?['source','publisher','reviewer'] as const:['source'] as const){
  test(`Skill ${action} ${expiry} expiry at the final write rolls back positive state`,async()=>{
   const f=await createSkillPublicationFixture(pool,{publish:action.startsWith('execution')}),g=gate();let writes=0,paused=false
   const sourceVersion=(await pool.query('SELECT claim_version_id FROM memory_skill_archives WHERE installation_id=$1',[f.installationId])).rows[0].claim_version_id
   const startRequest={skillId:f.reviewed.skillId,versionId:f.reviewed.versionId,expectedPublicationRevision:f.published?.publicationRevision??1,sessionId:f.sessionId,idempotencyKey:'clock-start'}
   const execution=createSkillExecutionService(f.deps)
   let executionId:string|undefined
   if(action.startsWith('execution')){
    await createSkillRolloutService(f.deps).configure(f.publisher,{skillId:f.reviewed.skillId,expectedRevision:0,state:'canary',basisPoints:10000})
    if(action==='execution_complete')executionId=(await execution.start(f.reader,startRequest)).executionId
   }
   const beforeRuns=(await pool.query('SELECT 1 FROM memory_skill_replay_runs WHERE installation_id=$1',[f.installationId])).rowCount
   const beforeTasks=(await pool.query('SELECT 1 FROM memory_skill_tasks WHERE installation_id=$1',[f.installationId])).rowCount
   const deadline=Number((await pool.query('SELECT extract(epoch FROM clock_timestamp())::float8 AS now')).rows[0].now)+1
   if(expiry==='source')await pool.query('UPDATE knowledge_versions SET valid_until=to_timestamp($2) WHERE installation_id=$1 AND version_id=$3',[f.installationId,deadline,sourceVersion])
   else await pool.query('UPDATE memory_scope_memberships SET valid_until=to_timestamp($2) WHERE installation_id=$1 AND membership_id=$3',[f.installationId,deadline,(expiry==='publisher'?f.publisher:f.reviewer).membershipId])
   const wrapped=hook(async sql=>{
    const matching=action==='admission'?sql.includes('INSERT INTO memory_jobs'):action==='execution_start'?sql.includes('INSERT INTO memory_skill_executions'):action==='execution_complete'?sql.includes('UPDATE memory_skill_executions SET state'):sql.includes('INSERT INTO memory_skill_audit_events')
    if(matching)writes++
    if(!paused&&matching&&writes===(action==='replay_complete'?2:1)){paused=true;g.reach();await g.allowed}
   }),deps={...f.deps,pool:wrapped}
   const pending=action==='admission'?createSkillAdmissionService(deps).schedule({...f.author,candidateKey:'clock-new-task',source:{kind:'claim_version',versionId:sourceVersion,repositoryId:f.repositoryId,repoSnapshotId:f.snapshotId}})
    :action==='publish'?createSkillPublicationService(deps).execute(f.publisher,f.publishRequest)
    :action==='execution_start'?createSkillExecutionService(deps).start(f.reader,startRequest)
    :action==='execution_complete'?createSkillExecutionService(deps).complete(f.reader,{executionId,expectedRevision:1,outcome:'succeeded',idempotencyKey:'clock-complete'})
    :createSkillReplayService(deps).execute(f.reviewer,{...f.reviewed.subject,caseIds:f.reviewed.records.map(c=>c.case_id),idempotencyKey:'clock-replay'})
   const outcome=pending.then(value=>({value}),error=>({error}))
   try{
    await Promise.race([g.reached,outcome.then(r=>{throw 'error' in r?r.error:new Error('Skill final write missed expiry barrier')})])
    await pool.query('SELECT pg_sleep(GREATEST(0,$1-extract(epoch FROM clock_timestamp()))::float8)',[deadline+0.03]);g.release()
    expect(await outcome).toMatchObject({error:{code:expiry==='source'?(action==='admission'?'skill_source_invalid':'source_invalid'):'review_required'}})
    if(action==='admission')expect((await pool.query('SELECT 1 FROM memory_skill_tasks WHERE installation_id=$1',[f.installationId])).rowCount).toBe(beforeTasks)
    if(action==='publish')expect((await pool.query('SELECT 1 FROM memory_skill_publication_heads WHERE installation_id=$1',[f.installationId])).rowCount).toBe(0)
    if(action==='replay_start')expect((await pool.query('SELECT 1 FROM memory_skill_replay_runs WHERE installation_id=$1',[f.installationId])).rowCount).toBe(beforeRuns)
    if(action==='replay_complete')expect((await pool.query('SELECT state FROM memory_skill_replay_runs WHERE installation_id=$1 ORDER BY sequence DESC LIMIT 1',[f.installationId])).rows[0]).toEqual({state:'cancelled'})
    if(action==='execution_start')expect((await pool.query('SELECT 1 FROM memory_skill_executions WHERE installation_id=$1',[f.installationId])).rowCount).toBe(0)
    if(action==='execution_complete')expect((await pool.query('SELECT state,revision::int,receipt_key FROM memory_skill_executions WHERE execution_id=$1',[executionId])).rows[0]).toEqual({state:'started',revision:1,receipt_key:null})
   }finally{g.release();await pending.catch(()=>undefined)}
  },15000)
 }}
 for(const phase of ['start','completion'] as const){for(const expiry of ['source','member'] as const){
  test(`Skill worker ${phase} denies ${expiry} expiry after its last write without retaining a candidate`,async()=>{
   const context={globalMode:'enabled' as const,sharedMode:'shadow' as const,config:loadSkillConfig({MEMORY_SKILL_MODE:'shadow'})}
   const f=await createSkillGovernanceFixture(pool,context,'team'),g=gate();let paused=false,calls=0
   const sourceVersion=(await pool.query('SELECT claim_version_id FROM memory_skill_archives WHERE installation_id=$1',[f.installationId])).rows[0].claim_version_id
   const scheduled=await createSkillAdmissionService({pool,context}).schedule({...f.author,candidateKey:'worker-clock',source:{kind:'claim_version',versionId:sourceVersion,repositoryId:f.repositoryId,repoSnapshotId:f.snapshotId}})
   const claim=(await createJobRepository(pool).claimJobs({workerId:'worker-clock',limit:1,leaseMs:30000}))[0]!
   const beforeArchives=(await pool.query('SELECT 1 FROM memory_skill_archives WHERE installation_id=$1',[f.installationId])).rowCount
   const deadline=Number((await pool.query('SELECT extract(epoch FROM clock_timestamp())::float8 AS now')).rows[0].now)+1
   if(expiry==='source')await pool.query('UPDATE knowledge_versions SET valid_until=to_timestamp($2) WHERE installation_id=$1 AND version_id=$3',[f.installationId,deadline,sourceVersion])
   else await pool.query('UPDATE memory_scope_memberships SET valid_until=to_timestamp($2) WHERE installation_id=$1 AND membership_id=$3',[f.installationId,deadline,f.author.membershipId])
   const wrapped=hook(async sql=>{
    const match=phase==='start'?sql.includes("UPDATE memory_skill_tasks SET state='running'"):sql.includes("UPDATE memory_skill_tasks SET state='candidate'")
    if(!paused&&match){paused=true;g.reach();await g.allowed}
   })
   const pending=createSkillWorker({pool:wrapped,context,generator:{generate:async()=>{
    calls++;return {ok:true,document:SkillCandidateDocumentSchema.parse(skillFixtureDocument()),usage:{inputTokens:1,outputTokens:1,model:'fixture'}}
   }}})
    .handle(claim,new AbortController().signal,{fence:{jobId:claim.job_id,claimedBy:'worker-clock',claimEpoch:claim.claim_epoch}})
   const outcome=pending.then(()=>({done:true}),error=>({error}))
   try{
    await Promise.race([g.reached,outcome.then(r=>{throw 'error' in r?r.error:new Error('worker missed expiry barrier')})])
    await pool.query('SELECT pg_sleep(GREATEST(0,$1-extract(epoch FROM clock_timestamp()))::float8)',[deadline+0.03]);g.release()
    expect(await outcome).toEqual({done:true})
    expect(calls).toBe(phase==='start'?0:1)
    expect((await pool.query('SELECT state,error_code FROM memory_skill_task_runs WHERE task_id=$1',[scheduled.taskId])).rows[0]).toEqual({state:'failed',error_code:expiry==='source'?'skill_source_invalid':'skill_forbidden'})
    expect((await pool.query('SELECT 1 FROM memory_skill_candidates WHERE task_id=$1',[scheduled.taskId])).rowCount).toBe(0)
    expect((await pool.query('SELECT 1 FROM memory_skill_archives WHERE installation_id=$1',[f.installationId])).rowCount).toBe(beforeArchives)
   }finally{g.release();await pending.catch(()=>undefined)}
  },15000)
 }}
 for(const action of ['resolve','archive','list'] as const){
  test(`Skill ${action} read denies a source expiring after its detail query`,async()=>{
   const f=await createSkillPublicationFixture(pool,{publish:false}),g=gate();let paused=false
   const sourceVersion=(await pool.query('SELECT claim_version_id FROM memory_skill_archives WHERE installation_id=$1',[f.installationId])).rows[0].claim_version_id
   const deadline=Number((await pool.query('SELECT extract(epoch FROM clock_timestamp())::float8 AS now')).rows[0].now)+1
   await pool.query('UPDATE knowledge_versions SET valid_until=to_timestamp($2) WHERE installation_id=$1 AND version_id=$3',[f.installationId,deadline,sourceVersion])
   const wrapped=hook(async sql=>{if(!paused&&sql.includes('SELECT version_id,version_number,document_hash')){paused=true;g.reach();await g.allowed}})
   const read=createSkillReadService({pool:wrapped,context:f.context,cursorSigningKey:'closure-only'})
   const pending=action==='list'?read.list(f.reader,{}):action==='archive'?read.archive(f.reader,f.reviewed.skillId):read.resolve(f.reader,f.reviewed.skillId)
   const outcome=pending.then(value=>({value}),error=>({error}))
   try{
    await Promise.race([g.reached,outcome.then(r=>{throw 'error' in r?r.error:new Error('Skill read missed expiry barrier')})])
    await pool.query('SELECT pg_sleep(GREATEST(0,$1-extract(epoch FROM clock_timestamp()))::float8)',[deadline+0.03]);g.release()
    expect(await outcome).toMatchObject({error:{code:'not_found'}})
   }finally{g.release();await pending.catch(()=>undefined)}
  },15000)
 }
 for(const foreground of [false,true]){
  test(`Wiki ${foreground?'foreground':'background'} scheduling racing repository cleanup leaves no queued generation or job`,async()=>{
   const f=await insertWikiCandidateFixture(pool,'closure-schedule'),g=gate();let pid:number|undefined,finished=false,paused=false
   const purgePool=hook(async sql=>{if(!paused&&sql.includes('INSERT INTO memory_repository_tombstones')){paused=true;g.reach();await g.allowed}})
   const schedulingPool=hook(async()=>{},id=>{pid=id})
   const purging=createPurgeRepository(purgePool,{hmacKey:'closure-only'}).purgeRepository({installationId:f.installationId,repositoryId:f.repositoryId,reasonCode:'user_delete'})
   const purgeOutcome=purging.then(value=>({value}),error=>({error}));let scheduling:Promise<unknown>|undefined
   try{
    await Promise.race([g.reached,purgeOutcome.then(r=>{throw 'error' in r?r.error:new Error('repository purge missed barrier')})])
    scheduling=createWikiBuildService({pool:schedulingPool}).scheduleBuild({installationId:f.installationId,repositoryId:f.repositoryId,...(foreground?{grant:f.grant}:{})})
    const outcome=scheduling.then(value=>{finished=true;return {value}},error=>{finished=true;return {error}})
    await block(()=>pid,()=>finished).catch(async error=>{
     const result=await outcome
     throw new Error(JSON.stringify({wait:error.message,outcome:'error' in result?{code:result.error.code,message:result.error.message}:result}))
    });const committedBeforePurge=finished;g.release()
    expect(await purgeOutcome).toMatchObject({value:{purged:true}})
    expect((await pool.query("SELECT 1 FROM memory_generation_runs WHERE installation_id=$1 AND operation='build_wiki' AND state IN('queued','running')",[f.installationId])).rowCount).toBe(0)
    if(committedBeforePurge)expect(await outcome).toHaveProperty('value.runId')
    else expect(await outcome).toMatchObject({error:{message:'wiki_repository_not_found'}})
    expect((await pool.query('SELECT 1 FROM memory_wiki_build_runs WHERE installation_id=$1',[f.installationId])).rowCount).toBe(0)
    expect((await pool.query("SELECT 1 FROM memory_jobs WHERE installation_id=$1 AND job_type='build_wiki'",[f.installationId])).rowCount).toBe(0)
   }finally{g.release();await purging.catch(()=>undefined);await scheduling?.catch(()=>undefined)}
  },15000)
 }
})
