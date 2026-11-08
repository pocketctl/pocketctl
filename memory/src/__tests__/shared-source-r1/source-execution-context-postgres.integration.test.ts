import {installRetainedInputStartFixture,beginFreshInputFixture} from './input-start-fixture.js'
import pg from 'pg'
import {randomUUID,createHash} from 'node:crypto'
import {beforeAll,afterAll,describe,test,expect,vi} from 'vitest'
import {applyMemorySchema} from '../../schema.js'
import {applySharedSourceContract} from '../../migrations/shared-db/contract.js'
import {createMemoryPool} from '../../db.js'
import {withTextProviderBudget,withEmbeddingProviderBudget,createProviderBudgetStore} from '../../model/provider-budget.js'
import type {TextGenerator} from '../../ports/text-generator.js'
import {createJobRepository} from '../../jobs/repository.js'
import {createJobWorker} from '../../jobs/worker.js'
import {createSkillAdmissionService} from '../../skills/admission-service.js'
import {createSkillWorker} from '../../skills/worker.js'
import {createSkillGenerator} from '../../skills/generator.js'
import {loadSkillConfig} from '../../skills/config.js'
import {prepareSourceReferences} from '../../sources/prepared-sources.js'
import {canonicalPayloadHash} from '@pocketctl/session-source'
import {createClaimIndexer} from '../../retrieval/indexer.js'
import {createSourceIngestService} from '../../codegraph/ingest-service.js'
import {computeManifestHash} from '../../codegraph/source-repository.js'
import {createCodeGraphBuildService} from '../../codegraph/build-service.js'
import {parseCodeSnapshot} from '../../codegraph/typescript-parser.js'
import {governanceFixture} from '../../testing/governance-fixture.js'
import {createAutomationRepository} from '../../governance/automation-repository.js'
import {recordGenerationProviderEffect} from '../../generation/provider-effect.js'
import {createGenerationRunRepository} from '../../generation/repository.js'
import {createSourceProjector} from '../../projection/source-projector.js'
import {createFeedConsumer} from '../../inbox/feed-worker.js'
import type {V2GrantFacts} from '../../governance/authorization.js'
import {withSourceJobExecution,withSourceProviderAccounting,currentSourceExecutionBranch,assertSourceProviderExecution,guardSourceExecutionCommit} from '../../sources/source-execution.js'
const url=process.env.SHARED_R1_INPUT_TEST_DATABASE_URL,suite=url?describe:describe.skip
suite('source execution context and synthetic provider dispatch',()=>{
 let admin:pg.Pool,runtime:pg.Pool
 beforeAll(async()=>{
  if(!url||!/(^|_)test$/.test(new URL(url).pathname.slice(1)))throw Error('isolated_test_required')
  admin=new pg.Pool({connectionString:url,max:6})
  await admin.query('DROP SCHEMA IF EXISTS memory CASCADE;DROP SCHEMA IF EXISTS shared CASCADE;DROP SCHEMA public CASCADE;CREATE SCHEMA public')
  const inputFoundation=await beginFreshInputFixture(admin)
  await applyMemorySchema(admin,{namespace:'memory'});await applySharedSourceContract(admin)
  await admin.query('UPDATE shared.memory_source_contract SET activation_ready=TRUE')
  await admin.query(`CREATE TABLE public.users(id int PRIMARY KEY);INSERT INTO public.users VALUES(1);
   CREATE TABLE public.extension_providers(provider_id text PRIMARY KEY,status text);INSERT INTO public.extension_providers VALUES('pocketctl-memory','enabled');
   CREATE TABLE public.extension_installations(installation_id uuid PRIMARY KEY,provider_id text,owner_user_id int,owner_scope_kind text,owner_scope_id uuid,status text,authorization_epoch bigint,config_version bigint,granted_scopes text[],enabled_services text[],event_filter jsonb,start_policy text NOT NULL DEFAULT 'retained_history',start_feed_id bigint NOT NULL DEFAULT 0);
   CREATE TABLE public.extension_organizations(organization_id uuid PRIMARY KEY,state text,authorization_epoch bigint);
   CREATE TABLE public.extension_teams(team_id uuid PRIMARY KEY,organization_id uuid,state text,authorization_epoch bigint);
   CREATE TABLE public.extension_scope_memberships(membership_id uuid PRIMARY KEY,scope_kind text,scope_id uuid,user_id int,roles text[],state text,membership_revision bigint)`)
  await installRetainedInputStartFixture(admin,'retained_history',inputFoundation)
  runtime=createMemoryPool({databaseUrl:url,databaseNamespace:'memory',dbPoolMax:6})
  await admin.query('CREATE TABLE memory.execution_test_outputs(job_id UUID PRIMARY KEY)')
 },60000)
 afterAll(async()=>{await runtime?.end();await admin?.end()})
 async function fixture(shadow:boolean|'active'=false){
  // Prior cases have finished their synthetic handlers; do not let their
  // deliberately retained running fixtures consume the global queue cap.
  await runtime.query("UPDATE memory_jobs SET state='completed',claim_expires_at=NULL WHERE state IN('running','pending')")
  const installationId=randomUUID(),jobId=randomUUID()
  await runtime.query("INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[installationId])
  await runtime.query("INSERT INTO memory_jobs(job_id,installation_id,job_type,idempotency_key,priority,state,claimed_by,claim_epoch,claim_expires_at) VALUES($1,$2,'extract_candidates',$1::uuid::text,85,'running','worker',1,clock_timestamp()+interval '5 minutes')",[jobId,installationId])
  if(shadow){
   await admin.query("INSERT INTO public.extension_installations VALUES($1,'pocketctl-memory',1,'personal',$1,'active',1,1,ARRAY['session:events:read'],ARRAY['memory.manage'],'{}')",[installationId])
   await admin.query('SELECT shared.transition_memory_source_mode($1,1,$2)',[installationId,shadow==='active'?'shared-active':'shared-shadow'])
  }
  return {installationId,jobId,fence:{jobId,claimedBy:'worker',claimEpoch:'1'}}
 }
 const request=()=>({operation:'skill_extract' as const,requestKey:'synthetic-stable-call',system:'synthetic',document:{},schema:{},timeoutMs:1000,signal:new AbortController().signal})
 const budgeted=(provider:TextGenerator,key:string)=>withTextProviderBudget(provider,createProviderBudgetStore(runtime),{key,maxRequests:10,maxInputTokens:1000000,maxOutputTokens:10000,maxOutputTokensPerRequest:100})
 test.each([false,true])('native cutover retains an original attempt until independent accounting finishes (callback failure=%s)',async fail=>{
  const f=await fixture(),key=randomUUID()
  let release!:()=>void,bookkeepingStarted!:()=>void,calls=0
  const wait=new Promise<void>(r=>{release=r}),started=new Promise<void>(r=>{bookkeepingStarted=r})
  const provider=budgeted({async generateJson(){calls++;return {ok:true,value:{},usage:{model:'synthetic',inputTokens:7,outputTokens:3}}}} as TextGenerator,key)
  let receipt:any
  const pending=withSourceJobExecution(runtime,f.fence,()=>withSourceProviderAccounting(async()=>{
   const result=await provider.generateJson(request());receipt=result
   bookkeepingStarted();await wait
   if(fail)throw Error('synthetic_accounting_failed')
   await runtime.query(`INSERT INTO memory_usage_outbox(installation_id,usage_id,operation,model,input_tokens,output_tokens,embedding_tokens,cached_tokens,cost_micros,occurred_at)
    VALUES($1,$2,'review_shadow','synthetic',7,3,0,0,0,clock_timestamp())`,[f.installationId,'synthetic-accounting:'+key])
   return result
  }))
  // Consume the intentional rejection immediately, before any lock checks.
  const outcome=pending.then(result=>({result}),error=>({error}))
  await Promise.race([started,outcome.then(()=>{throw Error('provider_accounting_ended_before_callback')})])
  try{
   expect((await runtime.query('SELECT state FROM memory_provider_budget_reservations WHERE reservation_id=$1',[receipt.budgetReservationId])).rows).toEqual([{state:'settled'}])
   expect((await admin.query('SELECT state FROM shared.memory_source_provider_attempts WHERE reservation_id=$1',[receipt.budgetReservationId])).rows).toEqual([{state:'inflight'}])
   await admin.query("SELECT shared.transition_memory_source_mode($1,1,'paused')",[f.installationId])
   await expect(admin.query("SELECT shared.transition_memory_source_mode($1,2,'legacy-feed')",[f.installationId])).rejects.toThrow('source_executions_not_drained')
  }finally{release()}
  const completed=await outcome
  expect(calls).toBe(1)
  if(fail){
   expect(completed).toMatchObject({error:new Error('synthetic_accounting_failed')})
   expect((await admin.query('SELECT state FROM shared.memory_source_provider_attempts WHERE reservation_id=$1',[receipt.budgetReservationId])).rows).toEqual([{state:'inflight'}])
   await expect(admin.query("SELECT shared.transition_memory_source_mode($1,2,'legacy-feed')",[f.installationId])).rejects.toThrow('source_executions_not_drained')
  }else{
   expect(completed).toHaveProperty('result')
   expect((await admin.query('SELECT state FROM shared.memory_source_provider_attempts WHERE reservation_id=$1',[receipt.budgetReservationId])).rows).toEqual([{state:'accounted'}])
   expect((await runtime.query('SELECT input_tokens::text,output_tokens::text FROM memory_usage_outbox WHERE installation_id=$1',[f.installationId])).rows).toEqual([{input_tokens:'7',output_tokens:'3'}])
   await admin.query("SELECT shared.transition_memory_source_mode($1,2,'legacy-feed')",[f.installationId])
  }
 })
 test('legacy public namespace adds no target capture or shared lookup',async()=>{
  const f=await fixture()
  expect(await withSourceJobExecution(admin,f.fence,async()=>7)).toBe(7)
  expect((await admin.query('SELECT 1 FROM shared.memory_source_executions WHERE job_id=$1',[f.jobId])).rowCount).toBe(0)
 })
 test('the original generation survives pause/resume and its private context does not leak',async()=>{
  const f=await fixture()
  expect(currentSourceExecutionBranch()).toBeUndefined()
  await withSourceJobExecution(runtime,f.fence,async()=>{
   expect(currentSourceExecutionBranch()).toBe('legacy-active')
   await assertSourceProviderExecution(true)
   await admin.query("SELECT shared.transition_memory_source_mode($1,1,'paused')",[f.installationId])
   await admin.query("SELECT shared.transition_memory_source_mode($1,2,'legacy-feed')",[f.installationId])
   await expect(assertSourceProviderExecution(true)).rejects.toThrow('source_execution_generation_changed')
   const client=await runtime.connect()
   try{await client.query('BEGIN');await expect(guardSourceExecutionCommit(client)).rejects.toThrow('source_execution_generation_changed')}
   finally{await client.query('ROLLBACK');client.release()}
  })
  expect(currentSourceExecutionBranch()).toBeUndefined()
  expect((await admin.query('SELECT generation::text FROM shared.memory_source_executions WHERE job_id=$1',[f.jobId])).rows).toEqual([{generation:'1'}])
 })
 test('active dispatch captures canonical-active atomically when that mode is current',async()=>{
  const f=await fixture('active')
  await withSourceJobExecution(runtime,f.fence,async()=>{
   expect(currentSourceExecutionBranch()).toBe('canonical-active')
   await assertSourceProviderExecution(true)
  })
 })
 test.each([true,'active']as const)('canonical dispatch chooses its immutable %s branch under the mode lock',async mode=>{
  const f=await fixture(mode)
  await withSourceJobExecution(runtime,f.fence,async()=>{
   expect(currentSourceExecutionBranch()).toBe(mode===true?'canonical-shadow':'canonical-active')
   if(mode===true)await expect(assertSourceProviderExecution(true)).rejects.toThrow('source_shadow_provider_forbidden')
   else await assertSourceProviderExecution(true)
  },{branch:'canonical'})
 })
 test.each(['shadow','cycle']as const)('legacy input cannot advance from a %s execution',async branch=>{
  const f=await fixture(branch==='shadow')
  await withSourceJobExecution(runtime,f.fence,async()=>{
   if(branch==='cycle'){
    await admin.query("SELECT shared.transition_memory_source_mode($1,1,'paused')",[f.installationId])
    await admin.query("SELECT shared.transition_memory_source_mode($1,2,'legacy-feed')",[f.installationId])
   }
   await expect(createSourceProjector(runtime).projectOnce(f.installationId)).rejects.toThrow('source_execution_generation_changed')
  },branch==='shadow'?{branch:'canonical-shadow'}:{})
 })
 test('a Feed HTTP response cannot recapture a later legacy mode generation',async()=>{
  const f=await fixture(),ack=vi.fn(async()=>1),errors:string[]=[]
  await runtime.query('UPDATE memory_installations SET snapshot_required=TRUE WHERE installation_id<>$1',[f.installationId])
  const pull=vi.fn(async()=>{
   await admin.query("SELECT shared.transition_memory_source_mode($1,1,'paused')",[f.installationId]);await admin.query("SELECT shared.transition_memory_source_mode($1,2,'legacy-feed')",[f.installationId])
   return {installation_id:f.installationId,items:[],next_cursor:'synthetic',lease_token:'synthetic',lease_expires_at:new Date(Date.now()+60000).toISOString()}
  })
  await createFeedConsumer({pool:runtime,pullFeed:pull,ackFeed:ack,workerId:'worker',signal:new AbortController().signal,onError:error=>errors.push(error instanceof Error?error.message:'unknown')}).runOnce()
  expect(pull).toHaveBeenCalledTimes(1);expect(ack).not.toHaveBeenCalled()
  expect(errors).toEqual(['source_mode_generation_changed'])
  expect((await runtime.query('SELECT 1 FROM memory_inbox_checkpoints WHERE installation_id=$1',[f.installationId])).rowCount).toBe(0)
 })
 test('shared-shadow active jobs still prepare their Feed input for a separate canonical comparison',async()=>{
  const f=await fixture(true),source=randomUUID(),payload={text:'legacy active body'}
  await runtime.query("INSERT INTO source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES($1,'shadow-session',now(),now())",[f.installationId])
  await runtime.query("INSERT INTO source_events(source_event_id,installation_id,origin,origin_position,session_id,event_type,occurred_at,payload,payload_hash) VALUES($1,$2,'feed','shadow-feed','shadow-session','agent_text',now(),$3::jsonb,$4)",[source,f.installationId,JSON.stringify(payload),canonicalPayloadHash(payload)])
  await withSourceJobExecution(runtime,f.fence,async()=>{
   const prepared=await prepareSourceReferences(runtime,f.installationId,[source])
   expect(prepared.events[0].payload).toEqual(payload)
   const client=await runtime.connect()
   try{await client.query('BEGIN');await prepared.assertCurrent(client,{forCommit:true});await client.query('COMMIT')}
   finally{await client.query('ROLLBACK');client.release()}
  })
  await runtime.query('UPDATE memory_jobs SET claim_epoch=2 WHERE job_id=$1',[f.jobId])
  await withSourceJobExecution(runtime,{...f.fence,claimEpoch:'2'},async()=>{
   await expect(prepareSourceReferences(runtime,f.installationId,[source])).rejects.toThrow('source_reference_unproven')
  },{branch:'canonical-shadow'})
  const other=await fixture()
  await withSourceJobExecution(runtime,other.fence,async()=>{
   await expect(prepareSourceReferences(runtime,f.installationId,[source])).rejects.toThrow('source_reference_unproven')
  })
 })
 test('canonical shadow fails before any reservation or model call',async()=>{
  const f=await fixture(true),call=vi.fn().mockResolvedValue({ok:true,value:{},usage:{inputTokens:1,outputTokens:1,model:'synthetic'}}),key=randomUUID()
  await withSourceJobExecution(runtime,f.fence,async()=>{
   await expect(budgeted({generateJson:call} as TextGenerator,key).generateJson(request())).rejects.toThrow('source_shadow_provider_forbidden')
  },{branch:'canonical-shadow'})
  expect(call).not.toHaveBeenCalled()
  expect((await runtime.query('SELECT 1 FROM memory_provider_budget_reservations WHERE budget_key=$1',[key])).rowCount).toBe(0)
 })
 test('canonical shadow cannot reserve or call an embedding provider',async()=>{
  const f=await fixture(true),key=randomUUID(),embed=vi.fn().mockResolvedValue({vectors:[[1]],model:'synthetic',tokens:1})
  const provider=withEmbeddingProviderBudget({dimensions:1,embed},createProviderBudgetStore(runtime),{key,maxRequests:10,maxTokens:1000})
  await withSourceJobExecution(runtime,f.fence,async()=>{
   await expect(provider.embed({operation:'claim_index',texts:['private input'],signal:new AbortController().signal})).rejects.toThrow('source_shadow_provider_forbidden')
  },{branch:'canonical-shadow'})
  expect(embed).not.toHaveBeenCalled()
  expect((await runtime.query('SELECT 1 FROM memory_provider_budget_reservations WHERE budget_key=$1',[key])).rowCount).toBe(0)
 })
 test('embedding dispatch is durable, retained across mode change and not repeated by a new job claim',async()=>{
  const f=await fixture(),key=randomUUID(),embed=vi.fn(async()=>{
   expect((await admin.query("SELECT 1 FROM shared.memory_source_provider_attempts a JOIN shared.memory_source_executions e USING(execution_id) WHERE e.job_id=$1 AND a.state='inflight'",[f.jobId])).rowCount).toBe(1)
   await admin.query("SELECT shared.transition_memory_source_mode($1,1,'paused')",[f.installationId])
   return {vectors:[[1]],model:'synthetic',tokens:5}
  })
  const provider=withEmbeddingProviderBudget({dimensions:1,embed},createProviderBudgetStore(runtime),{key,maxRequests:10,maxTokens:1000})
  const input={operation:'claim_index' as const,texts:['private input'],signal:new AbortController().signal}
  await withSourceJobExecution(runtime,f.fence,async()=>{expect((await provider.embed(input)).tokens).toBe(5)})
  await admin.query("SELECT shared.transition_memory_source_mode($1,2,'legacy-feed')",[f.installationId])
  await runtime.query('UPDATE memory_jobs SET claim_epoch=2 WHERE job_id=$1',[f.jobId])
  await withSourceJobExecution(runtime,{...f.fence,claimEpoch:'2'},async()=>{await expect(provider.embed(input)).rejects.toThrow('provider_result_unknown')})
  expect(embed).toHaveBeenCalledTimes(1)
  expect((await runtime.query('SELECT state,actual_input_tokens::text FROM memory_provider_budget_reservations WHERE budget_key=$1',[key])).rows).toEqual([{state:'settled',actual_input_tokens:'5'}])
  expect((await admin.query('SELECT a.state FROM shared.memory_source_provider_attempts a JOIN shared.memory_source_executions e USING(execution_id) WHERE e.job_id=$1',[f.jobId])).rows).toEqual([{state:'accounted'}])
 })
 test('legacy active in shared-shadow keeps its budget and commits admission before external IO',async()=>{
  const f=await fixture(true),key=randomUUID()
  const call=vi.fn(async()=>{
   expect((await admin.query("SELECT count(*)::int AS attempts FROM shared.memory_source_provider_attempts a JOIN shared.memory_source_executions e USING(execution_id) WHERE e.job_id=$1 AND a.state='inflight'",[f.jobId])).rows[0].attempts).toBe(1)
   expect((await admin.query("SELECT count(*)::int AS held FROM pg_stat_activity WHERE datname=current_database() AND application_name='pocketctl-memory' AND state='idle in transaction'")).rows[0].held).toBe(0)
   return {ok:true as const,value:{},usage:{inputTokens:3,outputTokens:2,model:'synthetic'}}
  })
  await withSourceJobExecution(runtime,f.fence,async()=>{expect((await budgeted({generateJson:call} as TextGenerator,key).generateJson(request())).ok).toBe(true)})
  expect(call).toHaveBeenCalledTimes(1)
  expect((await admin.query('SELECT a.state FROM shared.memory_source_provider_attempts a JOIN shared.memory_source_executions e USING(execution_id) WHERE e.job_id=$1',[f.jobId])).rows).toEqual([{state:'accounted'}])
 })
 test('pausing during HTTP blocks output and further dispatch while still recording incurred effects',async()=>{
  const f=await fixture(),key=randomUUID(),call=vi.fn(async()=>{
   await admin.query("SELECT shared.transition_memory_source_mode($1,1,'paused')",[f.installationId])
   return {ok:true as const,value:{},usage:{inputTokens:3,outputTokens:2,model:'synthetic'}}
  })
  await withSourceJobExecution(runtime,f.fence,async()=>{
   const generator=budgeted({generateJson:call} as TextGenerator,key)
   expect((await generator.generateJson(request())).ok).toBe(true)
   await expect(generator.generateJson({...request(),requestKey:'another'})).rejects.toThrow('source_execution_generation_changed')
   const client=await runtime.connect()
   try{await client.query('BEGIN');await expect(guardSourceExecutionCommit(client)).rejects.toThrow('source_execution_generation_changed')}
   finally{await client.query('ROLLBACK');client.release()}
  })
  expect(call).toHaveBeenCalledTimes(1)
  expect((await runtime.query('SELECT state,actual_input_tokens::text FROM memory_provider_budget_reservations WHERE budget_key=$1',[key])).rows).toEqual([{state:'settled',actual_input_tokens:'3'}])
  expect((await admin.query('SELECT a.state FROM shared.memory_source_provider_attempts a JOIN shared.memory_source_executions e USING(execution_id) WHERE e.job_id=$1',[f.jobId])).rows).toEqual([{state:'accounted'}])
 })
 test('a failed attempt receipt cannot erase known provider usage or permit publication',async()=>{
  const f=await fixture(),key=randomUUID()
  // A fixture trigger injects failure after the HTTP response and successful
  // budget settlement, independently of the caller's output transaction.
  await admin.query("CREATE FUNCTION shared.test_reject_attempt_finish() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic_finish_failed';END$$;CREATE TRIGGER test_reject_attempt_finish BEFORE UPDATE ON shared.memory_source_provider_attempts FOR EACH ROW EXECUTE FUNCTION shared.test_reject_attempt_finish()")
  const call=vi.fn().mockResolvedValue({ok:true,value:{},usage:{inputTokens:11,outputTokens:7,costMicros:13,model:'synthetic'}})
  try{
   await withSourceJobExecution(runtime,f.fence,async()=>{
    const result=await budgeted({generateJson:call} as TextGenerator,key).generateJson(request())
    expect(result).toMatchObject({ok:false,code:'provider_result_unknown',usage:{inputTokens:11,outputTokens:7,costMicros:13},budgetReservationId:expect.any(String)})
    const client=await runtime.connect()
    try{await client.query('BEGIN');await expect(guardSourceExecutionCommit(client)).rejects.toThrow('source_provider_effect_unrecorded')}
    finally{await client.query('ROLLBACK');client.release()}
   })
  }finally{await admin.query('DROP TRIGGER test_reject_attempt_finish ON shared.memory_source_provider_attempts;DROP FUNCTION shared.test_reject_attempt_finish()')}
  expect(call).toHaveBeenCalledTimes(1)
  expect((await runtime.query('SELECT state,actual_input_tokens::text FROM memory_provider_budget_reservations WHERE budget_key=$1',[key])).rows).toEqual([{state:'settled',actual_input_tokens:'11'}])
 })
 test('the real queue worker captures before its handler and rolls back a stale derived commit after HTTP',async()=>{
  const f=await fixture(),key=randomUUID(),call=vi.fn(async()=>{
   await admin.query("SELECT shared.transition_memory_source_mode($1,1,'paused')",[f.installationId])
   return {ok:true as const,value:{},usage:{inputTokens:3,outputTokens:2,model:'synthetic'}}
  })
  await runtime.query("UPDATE memory_jobs SET state='pending',claimed_by=NULL,claim_expires_at=NULL WHERE job_id=$1",[f.jobId])
  const jobs=createJobRepository(runtime),worker=createJobWorker({pool:runtime,jobs,workerId:'worker',signal:new AbortController().signal})
  worker.register('extract_candidates',async()=>{
   expect(currentSourceExecutionBranch()).toBe('legacy-active')
   expect((await budgeted({generateJson:call} as TextGenerator,key).generateJson(request())).ok).toBe(true)
   const client=await runtime.connect()
   try{
    await client.query('BEGIN');await client.query('INSERT INTO execution_test_outputs VALUES($1)',[f.jobId])
    await guardSourceExecutionCommit(client);await client.query('COMMIT')
   }catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
  })
  try{await worker.tick()}finally{await worker.stop()}
  expect(call).toHaveBeenCalledTimes(1)
  expect((await runtime.query('SELECT 1 FROM execution_test_outputs WHERE job_id=$1',[f.jobId])).rowCount).toBe(0)
  expect((await runtime.query('SELECT state,actual_input_tokens::text FROM memory_provider_budget_reservations WHERE budget_key=$1',[key])).rows).toEqual([{state:'settled',actual_input_tokens:'3'}])
  expect((await admin.query('SELECT generation::text FROM shared.memory_source_executions WHERE job_id=$1',[f.jobId])).rows).toEqual([{generation:'1'}])
  expect(currentSourceExecutionBranch()).toBeUndefined()
 })
 async function acceptedClaim(installationId:string){
  const claim=randomUUID(),version=randomUUID()
  await runtime.query("INSERT INTO knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state) VALUES($1,$2,'work_method','installation','global',$1::uuid::text,'active')",[claim,installationId])
  await runtime.query("INSERT INTO knowledge_versions(version_id,installation_id,claim_id,version_number,statement,authority,confidence) VALUES($1,$2,$3,1,'Run tests first','user_accepted',1)",[version,installationId,claim])
  await runtime.query('UPDATE knowledge_claims SET current_version_id=$2 WHERE claim_id=$1',[claim,version]);return version
 }
 test('known generation accounting locks its existing parent before descendants to preserve purge order',async()=>{
  const f=await fixture(),run=await createGenerationRunRepository(runtime).reserve({installationId:f.installationId,operation:'build_wiki',subjectKind:'wiki',subjectKeyHash:Buffer.alloc(32,1),inputDigest:Buffer.alloc(32,2),effectivePolicyHash:Buffer.alloc(32,3)})
  const blocker=await admin.connect(),purger=await admin.connect(),key=8123071
  await admin.query("CREATE FUNCTION memory.test_effect_parent_order() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM pg_advisory_xact_lock(8123071);RETURN NEW;END$$;CREATE TRIGGER test_effect_parent_order BEFORE UPDATE ON memory.memory_generation_runs FOR EACH ROW EXECUTE FUNCTION memory.test_effect_parent_order()")
  let accounting:Promise<void>|undefined
  try{
   await blocker.query('SELECT pg_advisory_lock($1)',[key]);const pid=(await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
   accounting=recordGenerationProviderEffect(runtime,{installationId:f.installationId,generationRunId:run.runId,runId:randomUUID(),operation:'build_wiki',usage:{model:'synthetic',inputTokens:3,outputTokens:2,costMicros:4}})
   let waiting=false
   for(let n=0;n<50;n++){waiting=(await admin.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting',[pid])).rows[0].waiting;if(waiting)break;await new Promise(resolve=>setTimeout(resolve,5))}
   expect(waiting).toBe(true)
   await purger.query('BEGIN')
   const locked=await purger.query('SELECT installation_id FROM memory.memory_installations WHERE installation_id=$1 FOR UPDATE NOWAIT',[f.installationId]).then(()=>false,error=>error.code==='55P03')
   expect(locked).toBe(true)
  }finally{
   await purger.query('ROLLBACK');await blocker.query('SELECT pg_advisory_unlock($1)',[key]);await accounting;blocker.release();purger.release()
   await admin.query('DROP TRIGGER test_effect_parent_order ON memory.memory_generation_runs;DROP FUNCTION memory.test_effect_parent_order()')
  }
  expect((await runtime.query('SELECT input_tokens::text,cost_micros::text FROM memory_usage_outbox WHERE installation_id=$1',[f.installationId])).rows).toEqual([{input_tokens:'3',cost_micros:'4'}])
 })
 test('a late mode change fences review advice while retaining actual model usage',async()=>{
  await fixture()
  const f=await governanceFixture(runtime),organization=randomUUID(),jobId=randomUUID()
  await admin.query("INSERT INTO public.extension_organizations VALUES($1,'active',1);",[organization])
  await admin.query("INSERT INTO public.extension_teams VALUES($1,$2,'active',1)",[f.team,organization])
  for(const[id,kind]of[[f.personal,'personal'],[f.team,'team']])await admin.query("INSERT INTO public.extension_installations VALUES($1,'pocketctl-memory',1,$2,$1,'active',1,1,ARRAY['session:events:read'],ARRAY['memory.manage'],'{}')",[id,kind])
  for(const[id,roles]of[[f.proposer,['contributor']],[f.reviewer,['reviewer']],[f.publisher,['scope_administrator']]]as const)await admin.query("INSERT INTO public.extension_scope_memberships VALUES($1,'team',$2,1,$3,'active',1)",[id,f.team,roles])
  const proposed=await f.proposed(),repo=createAutomationRepository(runtime)
  await repo.setPolicy({installationId:f.team,grant:f.grant(f.publisher,['read','policy_admin']),expectedRevision:0,document:{mode:'shadow',model:'synthetic',promptVersion:'review-v1'}})
  await runtime.query("INSERT INTO memory_jobs(job_id,installation_id,job_type,idempotency_key,priority,state,claimed_by,claim_epoch,claim_expires_at) VALUES($1,$2,'evaluate_review_shadow',$1::uuid::text,85,'running','worker',1,clock_timestamp()+interval '5 minutes')",[jobId,f.team])
  const target={installationId:f.team,candidateId:proposed.candidate.candidate_id,subjectKind:'promotion' as const}
  await withSourceJobExecution(runtime,{jobId,claimedBy:'worker',claimEpoch:1},async()=>{
   const prepared=(await repo.prepare(target))!
   expect(prepared).not.toBeNull()
   await admin.query("SELECT shared.transition_memory_source_mode($1,1,'paused')",[f.team])
   await expect(repo.finish(prepared,{recommendation:'needs_human',reason:'semantic_review',usage:{inputTokens:12,outputTokens:3,costMicros:4,model:'synthetic'}})).rejects.toThrow('source_execution_generation_changed')
  })
  expect((await runtime.query('SELECT input_tokens::text,cost_micros::text FROM memory_usage_outbox WHERE installation_id=$1',[f.team])).rows).toEqual([{input_tokens:'12',cost_micros:'4'}])
  expect(await repo.currentAdvice(target)).toBeNull()
 })
 test.each([false,true])('CodeGraph activation is fenced across its lock-free parse (changed=%s)',async changed=>{
  const f=await fixture(),content='export const ready = true\n',bytes=Buffer.byteLength(content),blob=createHash('sha256').update(content).digest('hex')
  const manifest=computeManifestHash([{path:'src/index.ts',gitMode:'100644',language:'typescript',capability:'symbols_and_edges',blobSha256:blob,byteCount:bytes}])
  const ingest=createSourceIngestService(runtime),key=randomUUID()
  const snapshot=await ingest.startSnapshot({installationId:f.installationId,repository:{repository_key:key},gitObjectFormat:'sha1',commitSha:'a'.repeat(40),manifestSha256:manifest,expectedFileCount:1,expectedByteCount:bytes,idempotencyKey:key})
  await ingest.uploadBatch({installationId:f.installationId,snapshotId:snapshot.snapshotId,batchIndex:0,entries:[{path:'src/index.ts',git_mode:'100644',language:'typescript',capability:'symbols_and_edges',blob_sha256:blob,byte_count:bytes,content_base64:Buffer.from(content).toString('base64')}]})
  await ingest.finalizeSnapshot({installationId:f.installationId,snapshotId:snapshot.snapshotId,manifestSha256:manifest,expectedFileCount:1,expectedByteCount:bytes,idempotencyKey:'final-'+key})
  const parse=vi.fn(async(input:Parameters<typeof parseCodeSnapshot>[0])=>{
   if(changed){await admin.query("SELECT shared.transition_memory_source_mode($1,1,'paused')",[f.installationId]);await admin.query("SELECT shared.transition_memory_source_mode($1,2,'legacy-feed')",[f.installationId])}
   return parseCodeSnapshot(input)
  })
  const job=(await runtime.query('SELECT * FROM memory_jobs WHERE job_id=$1',[f.jobId])).rows[0];job.payload={snapshot_id:snapshot.snapshotId}
  await withSourceJobExecution(runtime,f.fence,async()=>{
   const result=createCodeGraphBuildService({pool:runtime,mode:'shadow',parse}).handleParseCodeSnapshot(job,new AbortController().signal,{fence:{...f.fence,claimEpoch:1}})
   if(changed)await expect(result).rejects.toThrow('source_execution_generation_changed');else await result
  })
  expect(parse).toHaveBeenCalledTimes(1)
  expect((await runtime.query('SELECT 1 FROM memory_code_graph_versions WHERE snapshot_id=$1',[snapshot.snapshotId])).rowCount).toBe(changed?0:1)
 })
 test.each(['canonical-shadow','paused'] as const)('index rebuild cannot enqueue active work from %s execution',async branch=>{
  const f=await fixture(branch==='canonical-shadow'),version=await acceptedClaim(f.installationId)
  const job=(await runtime.query('SELECT * FROM memory_jobs WHERE job_id=$1',[f.jobId])).rows[0]
  const indexer=createClaimIndexer({pool:runtime})
  await withSourceJobExecution(runtime,f.fence,async()=>{
   if(branch==='paused')await admin.query("SELECT shared.transition_memory_source_mode($1,1,'paused')",[f.installationId])
   await expect(indexer.handleRebuildClaimIndex(job,undefined,{fence:{...f.fence,claimEpoch:1}})).rejects.toThrow('source_execution_generation_changed')
  },branch==='canonical-shadow'?{branch}:{})
  expect((await runtime.query("SELECT 1 FROM memory_jobs WHERE installation_id=$1 AND job_type='index_claim_version' AND payload->>'version_id'=$2",[f.installationId,version])).rowCount).toBe(0)
 })
 test.each([false,true])('real embedding indexing retains known fees before its final source fence (changed=%s)',async changed=>{
  const f=await fixture(),version=await acceptedClaim(f.installationId),key=randomUUID()
  await runtime.query("INSERT INTO memory_feature_settings(installation_id,embedding_mode) VALUES($1,'enabled')",[f.installationId])
  const embed=vi.fn(async()=>{
   if(changed)await admin.query("SELECT shared.transition_memory_source_mode($1,1,'paused')",[f.installationId])
   return {vectors:[[1]],tokens:5,model:'synthetic',costMicros:9}
  })
  const provider=withEmbeddingProviderBudget({dimensions:1,embed},createProviderBudgetStore(runtime),{key,maxRequests:10,maxTokens:1000})
  const indexer=createClaimIndexer({pool:runtime,embed:{...provider,provider:'synthetic',model:'synthetic'}})
  await withSourceJobExecution(runtime,f.fence,async()=>{
   const result=indexer.indexVersion(f.installationId,version,new AbortController().signal)
   if(changed)await expect(result).rejects.toThrow('source_execution_generation_changed');else await result
  })
  expect(embed).toHaveBeenCalledTimes(1)
  expect((await runtime.query("SELECT embedding_tokens::text,cost_micros::text FROM memory_usage_outbox WHERE installation_id=$1 AND operation='embedding'",[f.installationId])).rows).toEqual([{embedding_tokens:'5',cost_micros:'9'}])
  expect((await runtime.query('SELECT embedding_status FROM claim_search_documents WHERE installation_id=$1 AND version_id=$2',[f.installationId,version])).rows).toEqual([{embedding_status:changed?'disabled':'ready'}])
 })
 test.each([{changed:false,finishFails:false},{changed:true,finishFails:false},{changed:false,finishFails:true}])('a real Skill response keeps fees and fences output (%j)',async({changed,finishFails})=>{
  const f=await fixture(),repository=randomUUID(),snapshot=randomUUID(),claim=randomUUID(),version=randomUUID(),capsule=randomUUID()
  await admin.query("INSERT INTO public.extension_installations VALUES($1,'pocketctl-memory',1,'personal',$1,'active',1,1,ARRAY['session:events:read'],ARRAY['memory.manage'],'{}')",[f.installationId])
  await runtime.query("INSERT INTO memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id) VALUES($1,'personal',$1)",[f.installationId])
  await runtime.query('INSERT INTO repositories(installation_id,repository_id,repository_key,first_observed_at,last_observed_at) VALUES($1,$2,$2::uuid::text,now(),now())',[f.installationId,repository])
  await runtime.query('INSERT INTO repo_snapshots(installation_id,repo_snapshot_id,repository_id,commit_sha,observed_at) VALUES($1,$2,$3,$4,now())',[f.installationId,snapshot,repository,'a'.repeat(40)])
  await runtime.query("INSERT INTO knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state) VALUES($1,$2,'work_method','repository',$3,'source-execution-skill','active')",[claim,f.installationId,repository])
  await runtime.query("INSERT INTO knowledge_versions(version_id,installation_id,claim_id,version_number,statement,authority,confidence,repository_id,repo_snapshot_id) VALUES($1,$2,$3,1,'Run the tests first','user_accepted',1,$4,$5)",[version,f.installationId,claim,repository,snapshot])
  await runtime.query('UPDATE knowledge_claims SET current_version_id=$2 WHERE claim_id=$1',[claim,version])
  await runtime.query("INSERT INTO knowledge_evidence_capsules(capsule_id,installation_id,version_id,retention_basis,source_content_hash) VALUES($1,$2,$3,'user_accepted',sha256(convert_to('Tests passed','UTF8')))",[capsule,f.installationId,version])
  await runtime.query("INSERT INTO knowledge_evidence(evidence_id,installation_id,version_id,capsule_id,evidence_kind,excerpt,excerpt_hash,occurred_at,ordinal) VALUES(gen_random_uuid(),$1,$2,$3,'accepted_excerpt','Tests passed',sha256(convert_to('Tests passed','UTF8')),now(),0)",[f.installationId,version,capsule])
  const grant:V2GrantFacts={primaryInstallationId:f.installationId,configVersion:'1',scopeBindings:[{installation_id:f.installationId,owner_scope_kind:'personal',owner_scope_id:f.installationId,membership_id:null,membership_revision:'0',authorization_epoch:'1',permissions:['read','contribute']}]}
  const context={globalMode:'enabled' as const,sharedMode:'off' as const,config:loadSkillConfig({MEMORY_SKILL_MODE:'shadow'})}
  const scheduled=await createSkillAdmissionService({pool:runtime,context}).schedule({installationId:f.installationId,grant,candidateKey:'source-mode-race',source:{kind:'claim_version',versionId:version,repositoryId:repository,repoSnapshotId:snapshot}})
  const key=randomUUID(),call=vi.fn(async()=>{
   if(changed)await admin.query("SELECT shared.transition_memory_source_mode($1,1,'paused')",[f.installationId])
   if(finishFails)await admin.query("CREATE FUNCTION shared.test_reject_skill_finish() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic_finish_failed';END$$;CREATE TRIGGER test_reject_skill_finish BEFORE UPDATE ON shared.memory_source_provider_attempts FOR EACH ROW EXECUTE FUNCTION shared.test_reject_skill_finish()")
   return {ok:true as const,value:{schema_version:'skill-candidate.v1',title:'Tests',trigger:'Before a change',preconditions:['Read repository'],steps:[{instruction:'Run tests',tool:'shell',permissions:['repository:read'],operation:'read'}],validation:['Check results'],failure_handling:['Report failure'],rollback:['Stop'],source_tokens:['source-1']},usage:{inputTokens:11,outputTokens:7,costMicros:13,model:'synthetic'}}
  })
  const jobs=createJobRepository(runtime),errors:string[]=[],queue=createJobWorker({pool:runtime,jobs,workerId:'worker',signal:new AbortController().signal,concurrencyLimits:{extract_candidates:0,extract_skill_candidate:1},onError:error=>errors.push(error instanceof Error?error.message:'unknown')})
  const original=createSkillGenerator({provider:budgeted({generateJson:call} as TextGenerator,key),timeoutMs:1000})
  const generator={generate:async(...args:Parameters<typeof original.generate>)=>{
   const result=await original.generate(...args);expect(result.ok).toBe(!finishFails)
   // Resume after the provider effect has been recorded, before the worker
   // revalidates fresh source rows. The old execution still owns generation 1.
   if(changed)await admin.query("SELECT shared.transition_memory_source_mode($1,2,'legacy-feed')",[f.installationId])
   return result
  }}
  queue.register('extract_skill_candidate',createSkillWorker({pool:runtime,context,generator}).handle)
  try{await queue.tick()}finally{await queue.stop();if(finishFails)await admin.query('DROP TRIGGER IF EXISTS test_reject_skill_finish ON shared.memory_source_provider_attempts;DROP FUNCTION IF EXISTS shared.test_reject_skill_finish()')}
  expect(call.mock.calls.length,errors.join(',')).toBe(1)
  expect((await runtime.query('SELECT 1 FROM memory_skill_candidates WHERE task_id=$1',[scheduled.taskId])).rowCount).toBe(changed||finishFails?0:1)
  expect((await runtime.query('SELECT input_tokens::text,output_tokens::text,cost_micros::text FROM memory_generation_runs WHERE installation_id=$1',[f.installationId])).rows).toEqual([{input_tokens:'11',output_tokens:'7',cost_micros:'13'}])
  expect((await runtime.query("SELECT input_tokens::text,output_tokens::text,cost_micros::text FROM memory_usage_outbox WHERE installation_id=$1 AND operation='extract_skill_candidate'",[f.installationId])).rows).toEqual([{input_tokens:'11',output_tokens:'7',cost_micros:'13'}])
 })
})
