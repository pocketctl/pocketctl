import pg from 'pg'
import Fastify from 'fastify'
import {createHash,randomUUID} from 'node:crypto'
import {lifecycleSourceDigest} from '../curation/task-repository.js'
import {canonicalPacketJson} from '../episodes/packet.js'
import {canonicalPayloadHash} from '../inbox/canonical-json.js'
import {createCurationExecutor} from '../curation/executor.js'
import type {JobClaim} from '../jobs/types.js'
import {createPublicationService} from '../governance/publication-service.js'
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {governanceFixture} from '../testing/governance-fixture.js'
import {writeManualEntry} from '../claims/manual-entry.js'
import {createClaimRepository} from '../claims/repository.js'
import {createTransactionBoundPool} from '../api/transaction-bound-pool.js'
import {createCorsHostPolicy} from '../auth/cors-host-policy.js'
import {createPurgeRepository} from '../purge/repository.js'
import {registerReadRoutes} from '../api/read-routes.js'
import {registerMcpRoute} from '../mcp/server.js'
import {initializePlatformStatistics,recordCollectorHeartbeat} from './schema.js'
import {actorUsageContext,loadStatisticsSnapshot,parseSnapshotQuery,purgeStatistics,recordFirstClaim,recordUsage} from './service.js'
const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('durable private statistics (isolated PostgreSQL)',()=>{
 let pool:pg.Pool,stopApi:()=>void,stopWorker:()=>void,f:Awaited<ReturnType<typeof governanceFixture>>
 const query=()=>{const end=new Date(Date.now()+500),start=new Date(end.getTime()-86_400_000);return {from:start,to:end,previousFrom:new Date(start.getTime()-86_400_000),previousTo:start,excludeInstallationIds:[]}}
 beforeAll(async()=>{
  vi.stubEnv('PLATFORM_STATS_ENABLED','true')
  pool=new pg.Pool({connectionString:url,max:5});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)
  stopApi=await initializePlatformStatistics(pool,{role:'api',internalToken:'a'.repeat(32)})
  stopWorker=await initializePlatformStatistics(pool,{role:'worker'})
 },60_000)
 beforeEach(async()=>{
  await pool.query('TRUNCATE memory_installations CASCADE')
  await pool.query('TRUNCATE memory_platform_stats_claims,memory_platform_stats_usage,memory_platform_stats_gaps')
  f=await governanceFixture(pool)
 })
 afterAll(async()=>{stopApi?.();stopWorker?.();await pool?.end();vi.unstubAllEnvs()})
 async function transaction<T>(run:(c:pg.PoolClient)=>Promise<T>){const c=await pool.connect();try{await c.query('BEGIN');const r=await run(c);await c.query('COMMIT');return r}catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}}
 async function manual(statement='Statistics manual entry'){
  return transaction(c=>writeManualEntry(c,{installationId:f.personal,statement,claimType:'work_method',repositoryId:null},[]))
 }
 async function setup(){const f=await governanceFixture(pool),space=randomUUID();await pool.query("INSERT INTO memory_curation_policies(installation_id,mode) VALUES($1,'enabled')",[f.personal]);await pool.query("INSERT INTO memory_spaces(installation_id,space_id,domain,name,destinations) VALUES($1,$2,'life','Travel',ARRAY['personal'])",[f.personal,space]);return {...f,space}}
 async function candidate(f:Awaited<ReturnType<typeof setup>>,value='trains',space=f.space,occurredAt=new Date()){
  const parent=randomUUID(),bundle=randomUUID(),run=randomUUID(),event=randomUUID(),id=randomUUID(),session='s-'+id,turn='t-'+id,text=`I prefer ${value} for personal travel.`,payload={text},digest=canonicalPayloadHash(payload)
  const provenance={memory:{version:1,producer:'claude',session_id:session,turn_id:turn,event_id:event,sequence:'1',invocation_id:'user',source_role:'user',skill_state:'non_skill',lineage_complete:true,derived_from_event_ids:[]}}
  await pool.query(`INSERT INTO source_events(source_event_id,installation_id,origin,origin_position,session_id,turn_id,event_type,occurred_at,payload,payload_hash,source_provenance) VALUES($1::uuid,$2,'feed',$1::text,$3,$4,'user_text',$8,$5::jsonb,$6,$7::jsonb)`,[event,f.personal,session,turn,JSON.stringify(payload),digest,JSON.stringify(provenance),occurredAt])
  const storedEvents=(await pool.query('SELECT * FROM source_events WHERE installation_id=$1 AND source_event_id=$2',[f.personal,event])).rows
  const parentDigest=lifecycleSourceDigest(f.personal,storedEvents),spans=[{event_id:event,start:0,end:text.length}],childDigest=createHash('sha256').update(canonicalPacketJson({source:parentDigest.toString('hex'),spans,space})).digest()
  await pool.query(`INSERT INTO memory_task_bundles(installation_id,bundle_id,session_id,task_key,source_digest,watermark,state) VALUES($1,$2::uuid,$3,$5,$4,1,'completed')`,[f.personal,parent,session,parentDigest,'source:'+turn])
  await pool.query(`INSERT INTO memory_task_bundles(installation_id,bundle_id,session_id,task_key,space_id,source_digest,watermark,state,bundle_kind,parent_bundle_id,parent_revision,spans) VALUES($1,$2::uuid,$3,$2::text,$4,$5,1,'completed','task',$6,1,$7::jsonb)`,[f.personal,bundle,session,space,childDigest,parent,JSON.stringify(spans)])
  for(const b of [parent,bundle])await pool.query('INSERT INTO memory_task_bundle_sources(installation_id,bundle_id,source_event_id,source_digest,source_sequence) VALUES($1,$2,$3,$4,1)',[f.personal,b,event,digest])
  await pool.query(`INSERT INTO memory_curation_runs(installation_id,run_id,bundle_id,bundle_revision,source_digest,policy_revision,policy_hash,model_config_hash,mode,state) VALUES($1,$2,$3,1,$4,1,$5,$5,'enabled','completed')`,[f.personal,run,bundle,childDigest,'a'.repeat(64)])
  const conclusion={kind:'preference',assertion_mode:'user_asserted',subject:'self',predicate:'travel.transport',value,conditions:{},fact_at:null,valid_until:null,statement:text,confirmed:true,evidence:{subject:[event],predicate:[event],value:[event]}}
  await pool.query(`INSERT INTO memory_candidates(candidate_id,installation_id,ordinal,claim_type,statement,structured_content,normalized_key,scope_kind,scope_key,confidence,freshness_at,status,source_kind,bundle_id,curation_run_id,bundle_revision) VALUES($1::uuid,$2,0,'work_method',$3,$4::jsonb,$1::text,'task',$5,1,clock_timestamp(),'validated','task_bundle',$6,$7,1)`,[id,f.personal,text,JSON.stringify(conclusion),space,bundle,run])
  const job={job_id:randomUUID(),installation_id:f.personal,payload:{candidate_id:id,bundle_id:bundle,run_id:run}} as unknown as JobClaim
  return {job,event,id,bundle,parent,run}
 }
 const execute=(job:JobClaim)=>createCurationExecutor({pool,mode:'enabled',tombstoneKeys:[]}).curate(job,new AbortController().signal)
 it('curation creates automatic facts; replacement, replay and evidence links are not',async()=>{
  const context=await setup(),one=await candidate(context),created=await execute(one.job)
  expect(created?.action).toBe('create');expect((await execute(one.job))?.claimId).toBe(created?.claimId)
  expect((await execute((await candidate(context,'planes')).job))?.action).toBe('replace')
  expect((await execute((await candidate(context,'planes')).job))?.action).toBe('link_evidence')
  const space=randomUUID();await pool.query("INSERT INTO memory_spaces(installation_id,space_id,domain,name,destinations) VALUES($1,$2,'life','Other',ARRAY['personal'])",[context.personal,space])
  expect((await execute((await candidate(context,'buses',space)).job))?.action).toBe('create')
  expect((await pool.query('SELECT source,count(*)::int AS n FROM memory_platform_stats_claims GROUP BY source')).rows).toEqual([{source:'automatic',n:2}])
  expect((await pool.query('SELECT count(*)::int AS n FROM memory_platform_stats_usage')).rows[0].n).toBe(0)
 })
 it.each([false,true])('candidate acceptance actual authority classifies automatic=%s and replay stays idempotent',async automationAuthority=>{
  const episode=randomUUID(),run=randomUUID(),id=randomUUID(),handle='h0-aaaaaaaa'
  await pool.query(`INSERT INTO source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES($1,'stats-candidate',NOW(),NOW())`,[f.personal])
  await pool.query(`INSERT INTO source_turns(installation_id,turn_id,session_id,state,terminal_at) VALUES($1,'stats-turn','stats-candidate','completed',NOW())`,[f.personal])
  await pool.query(`INSERT INTO work_episodes(installation_id,episode_id,session_id,turn_id,state,compiler_version,document,evidence_manifest,compiled_at,source_digest)
    VALUES($1,$2,'stats-candidate','stats-turn','ready','v1',$3::jsonb,$4::jsonb,NOW(),'x'::bytea)`,[f.personal,episode,JSON.stringify({final_outcome:{text:'Statistics accepted candidate',evidence_handle:handle}}),JSON.stringify({[handle]:{kind:'episode'}})])
  await pool.query(`INSERT INTO memory_extraction_runs(run_id,installation_id,episode_id,episode_source_digest,extractor_version,prompt_version,model_config_hash,input_digest,mode,state,provider,model)
    VALUES($1,$2,$3,'x'::bytea,'e1','p1','x'::bytea,'x'::bytea,'enabled','succeeded','openai-compatible','m')`,[run,f.personal,episode])
  await pool.query(`INSERT INTO memory_candidates(candidate_id,installation_id,run_id,episode_id,ordinal,claim_type,statement,structured_content,normalized_key,scope_kind,scope_key,confidence,freshness_at,evidence_handles,status)
    VALUES($1,$2,$3,$4,0,'work_method','Statistics accepted candidate','{}'::jsonb,'stats-candidate','installation','global',0.9,NOW(),$5::jsonb,'validated')`,[id,f.personal,run,episode,JSON.stringify([handle])])
  const input={installationId:f.personal,candidateId:id,expectedRevision:1,automationAuthority}
  if(automationAuthority){
    // The actual automatic service adds its authority proof before outer
    // commit. The candidate writer's nested transaction must preserve both
    // classification and rollback until that proof exists.
    const c=await pool.connect();await c.query('BEGIN')
    try{
      expect(await createClaimRepository(createTransactionBoundPool(c)).acceptCandidate(input)).toMatchObject({ok:true})
      expect((await c.query('SELECT source FROM memory_platform_stats_claims')).rows).toEqual([{source:'automatic'}])
    }finally{await c.query('ROLLBACK');c.release()}
    expect((await pool.query('SELECT count(*)::int AS n FROM memory_platform_stats_claims')).rows[0].n).toBe(0)
    return
  }
  const repository=createClaimRepository(pool)
  expect(await repository.acceptCandidate(input)).toMatchObject({ok:true})
  expect(await repository.acceptCandidate(input)).toMatchObject({ok:false})
  expect((await pool.query('SELECT source,count(*)::int AS n FROM memory_platform_stats_claims GROUP BY source')).rows).toEqual([{source:automationAuthority?'automatic':'manual',n:1}])
 })
 it('publishing a shared copy creates no duplicate first-formal fact',async()=>{
  const proposal=await f.approved()
  const revision=(await pool.query('SELECT revision FROM memory_promotion_candidates WHERE candidate_id=$1',[proposal.candidate.candidate_id])).rows[0].revision
  await createPublicationService(pool).publish({grant:f.grant(f.publisher,['read','review','publish']),targetInstallationId:f.team,candidateId:proposal.candidate.candidate_id,expectedCandidateRevision:Number(revision),resolution:'new'})
  expect((await pool.query('SELECT count(*)::int AS n FROM memory_platform_stats_claims')).rows[0].n).toBe(0)
 })
 it('captures only first manual formal creation; revisions and rollback do not add facts',async()=>{
  const first=await manual();expect(first.ok).toBe(true);if(!first.ok)throw new Error('manual failed')
  await transaction(c=>writeManualEntry(c,{installationId:f.personal,claimId:first.metadata.claim_id,expectedRevision:1,statement:'Statistics revised entry',claimType:'work_method',repositoryId:null},[]))
  await expect(transaction(async c=>{await writeManualEntry(c,{installationId:f.personal,statement:'rolled back text',claimType:'work_method',repositoryId:null},[]);throw new Error('abort')})).rejects.toThrow('abort')
  expect((await pool.query('SELECT source,count(*)::int AS n FROM memory_platform_stats_claims GROUP BY source')).rows).toEqual([{source:'manual',n:1}])
  expect((await pool.query('SELECT count(*)::int AS n FROM memory_platform_stats_usage')).rows[0].n).toBe(0)
 })
 it('deduplicates immutable first facts independently of replay and source classification',async()=>{
  await transaction(async c=>{for(const source of ['automatic','manual','unclassified'] as const)await recordFirstClaim(c,{installationId:f.personal,claimId:f.claim,source})})
  expect((await pool.query('SELECT source FROM memory_platform_stats_claims')).rows).toEqual([{source:'automatic'}])
  expect((await loadStatisticsSnapshot(pool,query())).periods.current).toMatchObject({memory:1,automatic:1,manual:0,unclassified:0})
 })
 it('successful caller usage deduplicates requests and distinguishes explicit human activity',async()=>{
  const request={installationId:f.personal,requestId:'same',kind:'read' as const,operation:'search',humanActivity:true}
  await recordUsage(pool,request);await recordUsage(pool,request)
  await recordUsage(pool,{...request,requestId:'write',kind:'write'})
  const snapshot=await loadStatisticsSnapshot(pool,query())
  expect(snapshot.coverageStart).not.toBeNull()
  expect(snapshot.periods.current.actors).toEqual([{installationId:f.personal,readRequests:1,writeRequests:1,humanActivity:true}])
  expect(snapshot.periods.current.dailyActors).toHaveLength(1)
  expect(snapshot.periods.current.dailyActors[0]).not.toHaveProperty('membershipId')
 })
 it('uses exact verified shared membership and refuses missing actor attribution',async()=>{
  const grant={version:'v2',installationId:f.team,primaryInstallationId:f.team,scopeBindings:[{installation_id:f.team,owner_scope_kind:'team',membership_id:f.reviewer}]}
  await recordUsage(pool,{...actorUsageContext(grant),requestId:'shared',kind:'read',operation:'search'})
  let snapshot=await loadStatisticsSnapshot(pool,query())
  expect(snapshot.periods.current.actors).toEqual([{installationId:f.team,membershipId:f.reviewer,readRequests:1,writeRequests:0,humanActivity:false}])
  await recordUsage(pool,{...actorUsageContext({...grant,scopeBindings:[]}),requestId:'unknown',kind:'read',operation:'search'})
  snapshot=await loadStatisticsSnapshot(pool,query());expect(snapshot.gaps.some(g=>g.metric==='usage')).toBe(true)
 })
 it('a recovered live heartbeat retains downtime as durable gaps',async()=>{
  await pool.query("UPDATE memory_platform_stats_collectors SET last_seen=clock_timestamp()-interval '5 minutes' WHERE collector='worker'")
  await recordCollectorHeartbeat(pool,'worker')
  const snapshot=await loadStatisticsSnapshot(pool,query())
  expect(snapshot.gaps.map(g=>g.metric).sort()).toEqual(['memory','usage'])
  expect((await pool.query("SELECT last_seen>clock_timestamp()-interval '10 seconds' AS live FROM memory_platform_stats_collectors WHERE collector='worker'")).rows[0].live).toBe(true)
 })
 it('zero histories remain unavailable until both collector roles establish coverage',async()=>{
  await pool.query("DELETE FROM memory_platform_stats_collectors WHERE collector='worker'")
  expect((await loadStatisticsSnapshot(pool,query())).coverageStart).toBeNull()
  const stop=await initializePlatformStatistics(pool,{role:'worker'});stop()
 })
 it('uses Shanghai day boundaries and filters excluded installations',async()=>{
  const t='2026-11-01T15:59:59Z',u='2026-11-01T16:00:00Z'
  await pool.query(`INSERT INTO memory_platform_stats_claims(installation_id,claim_id,source,occurred_at) VALUES($1,$2,'manual',$3),($1,$4,'automatic',$5)`,[f.personal,randomUUID(),t,randomUUID(),u])
  const q=parseSnapshotQuery({from:'2026-11-01T00:00:00Z',to:'2026-11-03T00:00:00Z',previousFrom:'2026-10-30T00:00:00Z',previousTo:'2026-11-01T00:00:00Z'})
  const snapshot=await loadStatisticsSnapshot(pool,q)
  expect(snapshot.periods.current.daily).toEqual([{date:'2026-11-01',memory:1,automatic:0,manual:1,unclassified:0},{date:'2026-11-02',memory:1,automatic:1,manual:0,unclassified:0}])
  expect((await loadStatisticsSnapshot(pool,{...q,excludeInstallationIds:[f.personal]})).periods.current.memory).toBe(0)
 })
 it('privacy purge atomically removes identifiers and marks historical gaps',async()=>{
  await manual();await recordUsage(pool,{installationId:f.personal,requestId:'r',kind:'read',operation:'search'})
  await expect(transaction(async c=>{await purgeStatistics(c,f.personal);throw new Error('rollback')})).rejects.toThrow()
  expect((await loadStatisticsSnapshot(pool,query())).periods.current.memory).toBe(1)
  await transaction(c=>purgeStatistics(c,f.personal))
  const snapshot=await loadStatisticsSnapshot(pool,query());expect(snapshot.periods.current.memory).toBe(0);expect(snapshot.periods.current.actors).toEqual([])
  expect(new Set(snapshot.gaps.map(g=>g.metric))).toEqual(new Set(['memory','usage']))
 })
 it('privacy cleanup still removes previously recorded facts after collection opt-out',async()=>{
  await manual();await recordUsage(pool,{installationId:f.personal,requestId:'r',kind:'read',operation:'search'})
  vi.stubEnv('PLATFORM_STATS_ENABLED','false')
  try{await transaction(c=>purgeStatistics(c,f.personal))}finally{vi.stubEnv('PLATFORM_STATS_ENABLED','true')}
  const snapshot=await loadStatisticsSnapshot(pool,query());expect(snapshot.periods.current.memory).toBe(0);expect(snapshot.periods.current.actors).toEqual([])
  expect(snapshot.gaps).toHaveLength(2)
 })
 it('the actual installation purge transaction clears identifying statistics',async()=>{
  await manual();await recordUsage(pool,{installationId:f.personal,requestId:'r',kind:'read',operation:'search'})
  await createPurgeRepository(pool,{hmacKey:'stats-test-purge-key'}).purgeInstallation({installationId:f.personal,requestId:randomUUID(),reason:'test privacy deletion'})
  const snapshot=await loadStatisticsSnapshot(pool,query());expect(snapshot.periods.current.memory).toBe(0);expect(snapshot.periods.current.actors).toEqual([])
  expect(snapshot.gaps).toHaveLength(2)
 })
 it('installation revocation removes recorded identities in its own transaction',async()=>{
  await manual();await recordUsage(pool,{installationId:f.personal,requestId:'r',kind:'read',operation:'search'})
  await pool.query("UPDATE memory_installations SET relay_status='revoked' WHERE installation_id=$1",[f.personal])
  const snapshot=await loadStatisticsSnapshot(pool,query());expect(snapshot.periods.current.memory).toBe(0);expect(snapshot.periods.current.actors).toEqual([])
  expect(snapshot.gaps).toHaveLength(2)
 })
 it('capture and purge serialize; a request queued behind revocation cannot restore identifiers',async()=>{
  const c=await pool.connect();await c.query('BEGIN');await c.query("UPDATE memory_installations SET local_status='purged' WHERE installation_id=$1",[f.personal])
  const pending=recordUsage(pool,{installationId:f.personal,requestId:'racing',kind:'read',operation:'search'})
  await c.query('COMMIT');c.release();await pending
  expect((await pool.query('SELECT count(*)::int AS n FROM memory_platform_stats_usage')).rows[0].n).toBe(0)
 })
 it('unguarded revocation waits an in-flight capture and then deletes its identifying fact',async()=>{
  const c=await pool.connect();await c.query('BEGIN')
  await recordUsage(c,{installationId:f.personal,requestId:'before-revoke',kind:'read',operation:'search'})
  const revoke=pool.query("UPDATE memory_installations SET relay_status='revoked' WHERE installation_id=$1",[f.personal])
  await c.query('COMMIT');c.release();await revoke
  expect((await pool.query('SELECT count(*)::int AS n FROM memory_platform_stats_usage')).rows[0].n).toBe(0)
 })
 it('REST list counts distinct requests despite repeated untrusted keys and rejects failed reads',async()=>{
  await manual()
  const grant={installationId:f.personal,callerType:'web',configVersion:'1',services:['memory.search']}
  const guard={guard:async()=>grant,guardMcp:async()=>grant} as any
  const app=Fastify();registerReadRoutes(app,{pool,guard,policy:createCorsHostPolicy({allowedHosts:['memory.test'],allowedOrigins:[],isProduction:true}),recallEmbeddingTimeoutMs:20,cursorSigningKey:'test-key'})
  const options={headers:{host:'memory.test',authorization:'Bearer test','idempotency-key':'same-list'}}
  expect((await app.inject({url:'/api/v1/memory/claims',...options})).statusCode).toBe(200)
  expect((await app.inject({url:'/api/v1/memory/claims',...options})).statusCode).toBe(200)
  expect((await app.inject({url:'/api/v1/memory/claims/'+randomUUID(),...options})).statusCode).toBe(404)
  const snapshot=await loadStatisticsSnapshot(pool,query());expect(snapshot.periods.current.actors).toEqual([{installationId:f.personal,readRequests:2,writeRequests:0,humanActivity:false}])
  await app.close()
 })
 it('server request identities do not collide after a Fastify process restart',async()=>{
  const grant={installationId:f.personal,callerType:'web',configVersion:'1',services:['memory.search']}
  for(let i=0;i<2;i++){
    const app=Fastify();registerReadRoutes(app,{pool,guard:{guard:async()=>grant,guardMcp:async()=>grant} as any,policy:createCorsHostPolicy({allowedHosts:['memory.test'],allowedOrigins:[],isProduction:true}),recallEmbeddingTimeoutMs:20,cursorSigningKey:'test-key'})
    expect((await app.inject({url:'/api/v1/memory/claims',headers:{host:'memory.test',authorization:'Bearer test'}})).statusCode).toBe(200)
    await app.close()
  }
  expect((await loadStatisticsSnapshot(pool,query())).periods.current.actors[0].readRequests).toBe(2)
 })
 it('caps actor-day identities and marks overflow instead of silently claiming completeness',async()=>{
  await pool.query(`INSERT INTO memory_platform_stats_usage(installation_id,request_key,kind) SELECT gen_random_uuid(),'overflow','read' FROM generate_series(1,20001)`)
  const snapshot=await loadStatisticsSnapshot(pool,query())
  expect(snapshot.actorLimitExceeded).toBe(true)
  expect(snapshot.periods.current.dailyActors.length).toBeLessThanOrEqual(20000)
 })
 it('MCP protocol and not-found errors do not count; each valid business request counts',async()=>{
  const grant={installationId:f.personal,callerType:'agent',configVersion:'1',services:['memory.mcp']}
  const app=Fastify();registerMcpRoute(app,{pool,guard:{guardMcp:async()=>grant} as any,policy:createCorsHostPolicy({allowedHosts:['memory.test'],allowedOrigins:[],isProduction:true}),providerVersion:'test',recallEmbeddingTimeoutMs:20,cursorSigningKey:'test-key'})
  const call=(method:string,params:unknown={},key=method)=>app.inject({method:'POST',url:'/mcp',headers:{host:'memory.test',authorization:'Bearer test','content-type':'application/json','idempotency-key':key},payload:{jsonrpc:'2.0',id:1,method,params}})
  await call('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'}})
  await call('tools/list')
  await call('tools/call',{name:'memory_get_claim',arguments:{claim_id:randomUUID()}},'missing')
  expect((await pool.query('SELECT count(*)::int AS n FROM memory_platform_stats_usage')).rows[0].n).toBe(0)
  const result=await call('tools/call',{name:'memory_get_claim',arguments:{claim_id:f.claim}},'claim');expect(result.statusCode).toBe(200)
  await call('tools/call',{name:'memory_get_claim',arguments:{claim_id:f.claim}},'claim')
  expect((await loadStatisticsSnapshot(pool,query())).periods.current.actors[0]).toMatchObject({installationId:f.personal,readRequests:2,humanActivity:false})
  await app.close()
 })
})
