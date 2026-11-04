import {createPurgeRepository} from '../purge/repository.js'
import pg from 'pg'
import {randomUUID,createHash} from 'node:crypto'
import {writeFile} from 'node:fs/promises'
import {performance} from 'node:perf_hooks'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {applyMemorySchema} from '../schema.js'
import {createContextCompiler} from '../context/compiler.js'
import {createContextRetrieval} from '../context/retrieval.js'
import {createSearchService} from '../retrieval/search-service.js'
import {createScopeResolver} from '../context/scope-resolver.js'
import {createLoadoutRepository} from '../context/loadout-repository.js'
import {createContextSettingsRepository} from '../context/settings-repository.js'
import {createPackRepository} from '../context/pack-repository.js'
import {createGenerationRunRepository} from '../generation/repository.js'
import {createPolicyRepository} from '../policies/repository.js'
import {createPolicyResolver} from '../policies/resolver.js'
import {createTrajectoryRepository} from '../context/trajectory-repository.js'
const url=process.env.MEMORY_TEST_DATABASE_URL,output=process.argv[2]
if(!url||!output)throw new Error('dedicated_database_and_output_required')
const pool=new pg.Pool({connectionString:url,max:8}),owners:string[]=[]
const requestCount=1000,corpusSize=500,concurrency=4,deadlineMs=750
try{
 await assertMemoryTestDatabase(pool,url);await applyMemorySchema(pool)
 const results=[]
 for(const mode of ['off','enabled'] as const){
  const installationId=randomUUID(),spaceId=randomUUID(),repositoryId=randomUUID();owners.push(installationId)
  await pool.query("INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[installationId])
  await pool.query("INSERT INTO memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id) VALUES($1,'personal',$1)",[installationId])
  await pool.query("INSERT INTO repositories(installation_id,repository_id,repository_key,first_observed_at,last_observed_at) VALUES($1,$2,'synthetic/performance',NOW(),NOW())",[installationId,repositoryId])
  await pool.query("INSERT INTO memory_curation_policies(installation_id,mode,consume_mode) VALUES($1,'enabled','enabled')",[installationId])
  await pool.query("INSERT INTO memory_spaces(installation_id,space_id,name,domain,destinations) VALUES($1,$2,'Synthetic work','work',ARRAY['work'])",[installationId,spaceId])
  await pool.query('INSERT INTO memory_space_bindings(installation_id,space_id,repository_id) VALUES($1,$2,$3)',[installationId,spaceId,repositoryId])
  await pool.query("INSERT INTO source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) SELECT $1,'perf-'||n,NOW(),NOW() FROM generate_series(0,3)n",[installationId])
  // Same corpus and query set in both modes. This measures consumer overhead,
  // not extraction quality, model cost or a previous-release binary baseline.
  const c=await pool.connect()
  try{await c.query('BEGIN')
   for(let i=0;i<corpusSize;i++){
    const claim=randomUUID(),version=randomUUID(),entity=randomUUID(),text=`Service group${i%10} timeout production ${30+i} seconds`
    await c.query("INSERT INTO knowledge_claims(installation_id,claim_id,claim_type,scope_kind,scope_key,normalized_key,state) VALUES($1::uuid,$2,'architecture_decision','installation',$1::text,$3,'active')",[installationId,claim,`perf-${i}`])
    await c.query("INSERT INTO knowledge_versions(installation_id,claim_id,version_id,version_number,statement,authority,confidence,freshness_at,repository_id) VALUES($1,$2,$3,1,$4,'user_accepted',1,NOW(),$5)",[installationId,claim,version,text,repositoryId])
    await c.query('UPDATE knowledge_claims SET current_version_id=$2 WHERE claim_id=$1',[claim,version])
    const capsule=(await c.query("INSERT INTO knowledge_evidence_capsules(installation_id,version_id,capsule_id,retention_basis,source_content_hash) VALUES($1,$2,gen_random_uuid(),'user_accepted',sha256(convert_to($3,'UTF8'))) RETURNING capsule_id",[installationId,version,text])).rows[0].capsule_id
    await c.query("INSERT INTO knowledge_evidence(installation_id,version_id,evidence_id,capsule_id,evidence_kind,excerpt,excerpt_hash,occurred_at,ordinal) VALUES($1,$2,gen_random_uuid(),$3,'accepted_excerpt',$4,sha256(convert_to($4,'UTF8')),NOW(),0)",[installationId,version,capsule,text])
    if(mode==='enabled'){
     await c.query("INSERT INTO memory_claim_lifecycle(installation_id,claim_id,kind,assertion_mode) VALUES($1,$2,'fact','user_asserted')",[installationId,claim])
     await c.query("INSERT INTO memory_entities(installation_id,space_id,entity_id,kind,name) VALUES($1,$2,$3,'service',$4)",[installationId,spaceId,entity,`service-${i}`])
     await c.query("INSERT INTO memory_logical_claims(installation_id,space_id,subject_entity_id,logical_key,predicate_id,cardinality,claim_id) VALUES($1,$2,$3,$4,'service.timeout','single',$5)",[installationId,spaceId,entity,createHash('sha256').update(String(i)).digest('hex'),claim])
    }
   }
   await c.query('COMMIT')
  }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
  const settings=createContextSettingsRepository(pool);await settings.upsert({installationId,scopeKind:'installation',scopeKey:'global',agent:null,mode:'enabled',maxTokens:null,expectedRevision:1})
  const compiler=createContextCompiler({pool,lifecycleMode:mode,retrieval:createContextRetrieval({pool,search:createSearchService({pool,recallEmbeddingTimeoutMs:100,cursorSigningKey:'synthetic'}),trajectory:createTrajectoryRepository(pool)}),scope:createScopeResolver(pool),loadouts:createLoadoutRepository(pool),settings,packs:createPackRepository(pool),generation:createGenerationRunRepository(pool),policyResolver:createPolicyResolver({pool,repository:createPolicyRepository(pool)})})
  const durations:number[]=[],outcomes:Record<string,number>={};let next=0
  async function run(i:number){const t=performance.now();const r=await compiler.compile({installationId,sessionId:`perf-${i%concurrency}`,clientRequestId:randomUUID(),agent:'codex',adapterCapability:'native_hidden_v1',repositoryId,...(mode==='enabled'?{sceneId:spaceId,destination:'work' as const}:{}),query:`group${i%10} timeout`,requestKey:{keyId:'synthetic',hmacKey:Buffer.alloc(32,1)}});return{ms:performance.now()-t,kind:r.kind}}
  for(let i=0;i<20;i++)if((await run(i)).kind!=='ready')throw new Error('benchmark_fixture_no_context')
  const start=performance.now()
  await Promise.all(Array.from({length:concurrency},async()=>{for(;;){const i=next++;if(i>=requestCount)break;const r=await run(i);durations.push(r.ms);outcomes[r.kind]=(outcomes[r.kind]??0)+1}}))
  durations.sort((a,b)=>a-b);const percentile=(q:number)=>durations[Math.ceil(q*durations.length)-1]
  results.push({mode,requests:durations.length,corpusSize,concurrency,p50_ms:percentile(.5),p95_ms:percentile(.95),p99_ms:percentile(.99),elapsed_ms:performance.now()-start,outcomes})
 }
 const regression=results[1].p95_ms/results[0].p95_ms-1
 const report={version:1,fixture:'synthetic-consumer-overhead-v1',baseline:'same-build legacy consumer route',status:regression<=.1&&results.every(r=>r.outcomes.ready===requestCount&&r.p95_ms<=deadlineMs)?'diagnostic_pass':'fail',official_acceptance:'insufficient',p95_regression:regression,deadline_ms:deadlineMs,results,limits:['No previous-release binary comparison','No representative production capacity corpus','No same-quality model cost comparison','Compile only; real adapter overhead unmeasured','Local concurrent workloads may influence this diagnostic comparison'],generated_at:new Date().toISOString()}
 await writeFile(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});process.stdout.write(JSON.stringify({status:report.status,official_acceptance:report.official_acceptance,p95_regression:regression})+'\n')
}finally{try{for(const installationId of owners)await createPurgeRepository(pool,{hmacKey:'synthetic-perf-only'}).purgeInstallation({installationId,requestId:randomUUID(),reason:'synthetic_benchmark_cleanup'})}finally{await pool.end()}}
