import pg from 'pg'
import {randomUUID} from 'node:crypto'
import {governanceFixture} from '../testing/governance-fixture.js'
import {canonicalPayloadHash} from '../inbox/canonical-json.js'
import {stageLifecycleTurn} from '../curation/task-repository.js'
import {createCurationWorker} from '../curation/worker.js'
import {createCurationExecutor} from '../curation/executor.js'
import {createSearchService} from '../retrieval/search-service.js'
import {createContextCompiler} from '../context/compiler.js'
import {createAdmissionService} from '../context/admission-service.js'
import {createContextRetrieval} from '../context/retrieval.js'
import {createScopeResolver} from '../context/scope-resolver.js'
import {createLoadoutRepository} from '../context/loadout-repository.js'
import {createContextSettingsRepository} from '../context/settings-repository.js'
import {createPackRepository} from '../context/pack-repository.js'
import {createGenerationRunRepository} from '../generation/repository.js'
import {createPolicyRepository} from '../policies/repository.js'
import {createPolicyResolver} from '../policies/resolver.js'
import {createTrajectoryRepository} from '../context/trajectory-repository.js'
import type {Conclusion} from '../curation/conclusion-validator.js'
import type {TextGenerator} from '../ports/text-generator.js'

/** Synthetic local-test owner only. Callers must run the database identity guard. */
export function lifecyclePipelineFixture(pool:pg.Pool){
 async function fixture(){
  const f=await governanceFixture(pool),space=randomUUID(),other=randomUUID(),session='query-'+randomUUID()
  await pool.query("INSERT INTO memory_curation_policies(installation_id,mode,consume_mode) VALUES($1,'enabled','enabled')",[f.personal])
  for(const [id,name]of [[space,'Personal travel'],[other,'Work deployments']])await pool.query("INSERT INTO memory_spaces(installation_id,space_id,domain,name,destinations) VALUES($1,$2,'life',$3,ARRAY['personal'])",[f.personal,id,name])
  await pool.query('INSERT INTO source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES($1,$2,NOW(),NOW())',[f.personal,session])
  const settings=createContextSettingsRepository(pool);await settings.upsert({installationId:f.personal,scopeKind:'installation',scopeKey:'global',agent:null,mode:'enabled',maxTokens:null,expectedRevision:1})
  const search=createSearchService({pool,recallEmbeddingTimeoutMs:100,cursorSigningKey:'synthetic'})
  const compiler=createContextCompiler({pool,lifecycleMode:'enabled',retrieval:createContextRetrieval({pool,search,trajectory:createTrajectoryRepository(pool)}),scope:createScopeResolver(pool),loadouts:createLoadoutRepository(pool),settings,packs:createPackRepository(pool),generation:createGenerationRunRepository(pool),policyResolver:createPolicyResolver({pool,repository:createPolicyRepository(pool)})})
  const admission=createAdmissionService({pool,lifecycleMode:'enabled',nonceHmacKey:Buffer.alloc(32,5)})
  return {...f,space,other,session,compiler,admission}
 }
 async function ingest(f:Awaited<ReturnType<typeof fixture>>,value:string,space=f.space,inputGenerator?:TextGenerator,conclusionOverride:Partial<Pick<Conclusion,'kind'|'predicate'|'subject'|'statement'>>={}){
  const event=randomUUID(),session='source-'+event,turn='turn-'+event,text=conclusionOverride.statement??`I prefer ${value} for personal travel.`,payload={text},proof={memory:{version:1,producer:'claude',session_id:session,turn_id:turn,event_id:event,sequence:'1',invocation_id:'user',source_role:'user',skill_state:'non_skill',lineage_complete:true,derived_from_event_ids:[]}}
  await pool.query(`INSERT INTO source_events(source_event_id,installation_id,origin,origin_position,session_id,turn_id,event_type,occurred_at,payload,payload_hash,source_provenance) VALUES($1::uuid,$2,'feed',$1::text,$3,$4,'user_text',clock_timestamp(),$5::jsonb,$6,$7::jsonb)`,[event,f.personal,session,turn,JSON.stringify(payload),canonicalPayloadHash(payload),JSON.stringify(proof)])
  const events=(await pool.query('SELECT * FROM source_events WHERE installation_id=$1 AND session_id=$2',[f.personal,session])).rows
  await stageLifecycleTurn(pool,{installationId:f.personal,sessionId:session,turnId:turn,events},{mode:'enabled',revision:1,authorizationEpoch:'1',version:'memory-lifecycle-v1'})
  const job=(await pool.query("SELECT * FROM memory_jobs WHERE installation_id=$1 AND job_type='consolidate_task' ORDER BY created_at DESC LIMIT 1",[f.personal])).rows[0]
  const stub:TextGenerator=inputGenerator??{async generateJson<T>(){return {ok:true,value:{tasks:[{space_id:space,task_id:null,spans:[{event_id:event,start:0,end:text.length}],conclusions:[{kind:conclusionOverride.kind??'preference',assertion_mode:'user_asserted',subject:conclusionOverride.subject??'self',predicate:conclusionOverride.predicate??'travel.transport',value,conditions:{},fact_at:null,valid_until:null,statement:text,confirmed:true,evidence:{subject:[event],predicate:[event],value:[event]}}]}]} as T,usage:{inputTokens:1,outputTokens:1,model:'declared-test-stub'}}}}
  await createCurationWorker({pool,mode:'enabled',textGenerator:stub,modelFingerprint:'declared-test-stub'}).consolidate(job,new AbortController().signal)
  const child=(await pool.query("SELECT * FROM memory_jobs WHERE installation_id=$1 AND job_type='curate_conclusions' ORDER BY created_at DESC LIMIT 1",[f.personal])).rows[0]
  if(!child)throw new Error('curation_job_missing')
  const result=await createCurationExecutor({pool,mode:'enabled',tombstoneKeys:[]}).curate(child,new AbortController().signal)
  if(!result||(!result.claimId&&!['skip','defer'].includes(result.action)))throw new Error('curation_claim_missing');return result
 }
 async function deliver(f:Awaited<ReturnType<typeof fixture>>,scene=f.space,query='personal travel'){
  const request=randomUUID(),compiled=await f.compiler.compile({installationId:f.personal,sessionId:f.session,clientRequestId:request,agent:'codex',adapterCapability:'native_hidden_v1',sceneId:scene,destination:'personal',query,requestKey:{keyId:'synthetic',hmacKey:Buffer.alloc(32,3)}})
  if(compiled.kind!=='ready')throw new Error('compile_'+compiled.kind)
  const ticket=await f.admission.admit({installationId:f.personal,sessionId:f.session,clientRequestId:request,packId:compiled.packId,agent:'codex',adapter:'codex-app-server',grantConfigVersion:'1',sharedGrantAuthorized:true})
  if(!ticket.ok||!('nonce'in ticket))throw new Error('admission_failed')
  const consumed=await f.admission.consume({installationId:f.personal,sessionId:f.session,packId:compiled.packId,injectionId:ticket.injectionId,nonce:ticket.nonce})
  if(!consumed.ok)throw new Error('context_consume_failed')
  await f.admission.receipt({installationId:f.personal,sessionId:f.session,injectionId:ticket.injectionId,delivered:true})
  return {compiled,consumed,items:(await pool.query('SELECT claim_id,version_id FROM memory_context_pack_items WHERE pack_id=$1',[compiled.packId])).rows}
 }
 return {fixture,ingest,deliver}
}
