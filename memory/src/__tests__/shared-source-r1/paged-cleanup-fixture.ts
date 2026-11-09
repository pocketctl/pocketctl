import {claimIdentityV2,claimDuplicateDigestV2} from '../../claims/identity.js'
import {normalizedClaimKey} from '../../retrieval/query-normalizer.js'
import {beforeEach,afterEach,afterAll} from 'vitest'
import {planPagedCleanup as plan,applyPagedCleanup as apply,verifyPagedCleanup as verify} from '../../migrations/shared-forward/paged-cleanup.js'
import {stat} from 'node:fs/promises'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {canonicalPayloadHash} from '@pocketctl/session-source'
/** Isolated synthetic fixture only. No environment discovery or production URLs. */
import pg from 'pg'
import {randomUUID} from 'node:crypto'
import {applyMemorySchema} from '../../schema.js'
import {applySharedSourceContract} from '../../migrations/shared-db/contract.js'
import {inspectPagedCleanupCatalog} from '../../migrations/shared-forward/paged-cleanup-catalog.js'
import {installNativeAliasFixture} from './native-alias-fixture.js'
export const pagedInstallation='10000000-0000-0000-0000-000000000074'
export const pagedRoot={installationId:pagedInstallation,sessionId:'paged-selected'}
export const pagedProbe=async()=>({api:{LoadState:'loaded',ActiveState:'inactive',SubState:'dead',MainPID:'0'},worker:{LoadState:'loaded',ActiveState:'inactive',SubState:'dead',MainPID:'0'},observedAt:new Date().toISOString()})
export async function createPagedFixture(url:string){
 if(!url||!new URL(url).pathname.endsWith('_test'))throw Error('isolated_paged_fixture_required')
 const sql=async(text:string,values?:unknown[])=>{const c=new pg.Client({connectionString:url});await c.connect();try{return await c.query(text,values)}finally{await c.end()}}
 const pool=new pg.Pool({connectionString:url})
 try{
  await applyMemorySchema(pool,{namespace:'memory'})
  await pool.query(`CREATE TABLE public.users(id int PRIMARY KEY);
   CREATE TABLE public.daemons(daemon_id text PRIMARY KEY,user_id int);
   CREATE TABLE public.sessions(session_id text PRIMARY KEY,user_id int,daemon_id text,source text,content_state text,agent_type text);
   CREATE TABLE public.extension_providers(provider_id text PRIMARY KEY,status text);
   CREATE TABLE public.extension_installations(installation_id uuid PRIMARY KEY,provider_id text,owner_user_id int,owner_scope_kind text,owner_scope_id uuid,status text,authorization_epoch bigint,config_version bigint,granted_scopes text[],subscriptions text[],enabled_services text[],event_filter jsonb);
   CREATE TABLE public.extension_organizations(organization_id uuid PRIMARY KEY,state text,authorization_epoch bigint);
   CREATE TABLE public.extension_teams(team_id uuid PRIMARY KEY,organization_id uuid,state text,authorization_epoch bigint);
   CREATE TABLE public.extension_scope_memberships(membership_id uuid PRIMARY KEY,scope_kind text,scope_id uuid,user_id int,roles text[],state text,membership_revision bigint);
   CREATE TABLE public.deleted_sessions(session_id text PRIMARY KEY);
   CREATE TABLE public.team_delivery_memory_sources(source_session_id text PRIMARY KEY,team_id text,team_session_id text,submission_id uuid,decision_id uuid,revoked_at timestamptz,withdrawn_at timestamptz);
   CREATE TABLE public.team_delivery_memory_withdrawals(team_id text,team_session_id text,submission_id uuid,decision_id uuid);
   CREATE TABLE public.team_artifact_revocations(submission_id uuid,artifact_id text);
   CREATE TABLE public.paged_cancel_probe(id integer PRIMARY KEY);
   CREATE TABLE public.paged_canonical_sentinel(id bigint PRIMARY KEY,body text);
   INSERT INTO public.paged_canonical_sentinel VALUES(9007199254740993,'canonical must survive');`)
  await pool.query("ALTER TABLE public.extension_installations ADD COLUMN start_policy TEXT NOT NULL DEFAULT 'retained_history'")
  await applySharedSourceContract(pool)
  await installNativeAliasFixture(pool)
  await pool.query(`ALTER TABLE public.events ADD COLUMN created_at timestamptz,ADD COLUMN source_header_version integer,ADD COLUMN source_sequence bigint,ADD COLUMN canonical_payload_hash text,ADD COLUMN source_classification jsonb`)
  for(const [moduleName,exportName] of [['capture-contract','RELAY_SOURCE_CAPTURE_SQL'],['session-capture','RELAY_SESSION_CAPTURE_SQL']]){
   const source=resolve('../relay/src/shared-source/'+moduleName+'.ts'),built=resolve('../relay/dist/shared-source/'+moduleName+'.js')
   if((await stat(source)).mtimeMs>(await stat(built)).mtimeMs)throw Error('native_capture_fixture_build_stale')
   for(const statement of (await import(pathToFileURL(built).href))[exportName])await pool.query(statement)
  }


  for(const row of(await pool.query("SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='memory' AND c.relkind='r'")).rows)await pool.query('ALTER TABLE memory."'+String(row.relname).replaceAll('"','""')+'" SET(autovacuum_enabled=false)')
  await pool.query("INSERT INTO public.users VALUES(1);INSERT INTO public.daemons VALUES('paged-daemon',1);INSERT INTO public.extension_providers VALUES('pocketctl-memory','enabled')")
  await pool.query("INSERT INTO public.extension_installations VALUES($1,'pocketctl-memory',1,'personal',$1,'active',1,1,'{}','{}','{}','{}')",[pagedInstallation])
  await pool.query("INSERT INTO memory.memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[pagedInstallation])
  await pool.query("INSERT INTO memory.memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id) VALUES($1,'personal',$1)",[pagedInstallation]);await pool.query("INSERT INTO shared.memory_source_modes(installation_id,mode) VALUES($1,'legacy-feed')",[pagedInstallation])
  const expected=(await pool.query(`SELECT current_database() AS database,current_user AS role,d.oid::text AS "databaseOid",inet_server_addr()::text AS "serverAddress",inet_server_port()::text AS "serverPort" FROM pg_database d WHERE datname=current_database()`)).rows[0]
  const catalogClient=await pool.connect();let reviewedCatalogHash:string;try{await catalogClient.query('BEGIN READ ONLY');await catalogClient.query('SET LOCAL search_path=pg_catalog');reviewedCatalogHash=(await inspectPagedCleanupCatalog(catalogClient as unknown as pg.Client)).hash}finally{await catalogClient.query('ROLLBACK');catalogClient.release()}
  const config={reviewedCatalogHash,database:{url,expected},installationIds:[pagedInstallation],units:{api:'synthetic-paged-api.service',worker:'synthetic-paged-worker.service',freshInstall:false},tombstoneHmacKeys:[{version:'paged-test',key:'synthetic-paged-native-hmac-key'}]}
  let nextEvent=9007199254740993n
  async function source(name=pagedRoot.sessionId,count=1,unknown=false,bodyBytes=0){
   await sql("INSERT INTO public.sessions(session_id,user_id,daemon_id,source,content_state,agent_type) VALUES($1,1,'paged-daemon','codex','hot','codex');",[name])
   await sql('INSERT INTO memory.source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES($1,$2,now(),now())',[pagedInstallation,name])
   for(let offset=0;offset<count;offset+=128){const records=[]
    for(let n=offset;n<Math.min(count,offset+128);n++){const id=String(nextEvent++),turn='native-turn-'+id,at='2026-11-07T00:00:00.000Z',payload={text:bodyBytes?'x'.repeat(bodyBytes):'private event '+n,turn_id:turn},proof={version:1,producer:'codex',session_id:name,turn_id:turn,event_id:'native-event-'+id,sequence:id,invocation_id:'native-invocation-'+id,source_role:'assistant',skill_state:'unknown',lineage_complete:false,derived_from_event_ids:[]},classification={memory_source:proof},hash=canonicalPayloadHash(payload).toString('hex');records.push({id,turn,at,payload,classification,hash,provenance:{state:'known',memory:proof}})}
    await sql(`INSERT INTO public.events(id,session_id,user_id,event_type,payload,created_at,source_header_version,source_sequence,canonical_payload_hash,source_classification)
     SELECT r.id::bigint,$1,1,'agent_text',r.payload,r.at::timestamptz,1,r.id::bigint,r.hash,r.classification FROM jsonb_to_recordset($2::jsonb)r(id text,at text,payload jsonb,hash text,classification jsonb)`,[name,JSON.stringify(records)])
    await sql("SELECT shared.mark_memory_source_dirty('relay_event','1:'||$1)",[name])
    await sql(`INSERT INTO memory.source_events(source_event_id,installation_id,origin,origin_position,session_id,turn_id,event_type,occurred_at,payload,payload_hash,classification,source_provenance,source_kind,canonical_key,canonical_session_key,source_sequence,content_hash,hash_version,mapping_state,adapter_version,source_version)
     SELECT gen_random_uuid(),$1,'feed',r.id,$2,r.turn,'agent_text',r.at::timestamptz,r.payload,decode(r.hash,'hex'),r.classification,r.provenance,CASE WHEN $4 THEN NULL ELSE 'relay_event' END,CASE WHEN $4 THEN NULL ELSE r.id END,CASE WHEN $4 THEN NULL ELSE $2 END,r.id::bigint,decode(r.hash,'hex'),'canonical-json-sha256-v1',CASE WHEN $4 THEN 'unproven' ELSE 'verified' END,CASE WHEN $4 THEN NULL ELSE 'm0-relay-fixture-v1' END,(SELECT jsonb_build_object('content',w.revision::text,'authorization',i.authorization_epoch::text,'storage',w.storage_revision::text) FROM shared.memory_source_work w JOIN public.extension_installations i ON i.installation_id=$1 WHERE w.source_kind='relay_event' AND w.root_key='1:'||$2)
     FROM jsonb_to_recordset($3::jsonb)r(id text,turn text,at text,payload jsonb,hash text,classification jsonb,provenance jsonb)`,[pagedInstallation,name,JSON.stringify(records),unknown])
   }
   await sql('INSERT INTO public.deleted_sessions VALUES($1)',[name])
  }
  async function episodes(count=1){await sql("INSERT INTO memory.work_episodes(installation_id,episode_id,session_id,turn_id,state,compiler_version,document,evidence_manifest,summary) SELECT $1,gen_random_uuid(),$2,'paged-turn-'||n,'ready','test',jsonb_build_object('text','private episode '||n),'{}',jsonb_build_object('text','private summary') FROM generate_series(1,$3::int)n",[pagedInstallation,pagedRoot.sessionId,count])}
  async function acceptedClaim(episodeId:string){
   const claim=randomUUID(),version=randomUUID(),capsule=randomUUID(),evidence=randomUUID()
   await sql("INSERT INTO memory.knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state) VALUES($1::uuid,$2::uuid,'test_invariant','installation',($2::uuid)::text,($1::uuid)::text,'active')",[claim,pagedInstallation])
   await sql("INSERT INTO memory.knowledge_versions(version_id,installation_id,claim_id,version_number,statement,authority,confidence) VALUES($1,$2,$3,1,'independently accepted statement','user_accepted',1)",[version,pagedInstallation,claim])
   await sql('UPDATE memory.knowledge_claims SET current_version_id=$2 WHERE claim_id=$1',[claim,version])
   await sql("INSERT INTO memory.knowledge_evidence(evidence_id,installation_id,version_id,episode_id,evidence_kind,excerpt,excerpt_hash,occurred_at,ordinal) VALUES(gen_random_uuid(),$1,$2,$3,'episode','selected private excerpt',sha256('selected private excerpt'),now(),0)",[pagedInstallation,version,episodeId])
   await sql("INSERT INTO memory.knowledge_evidence_capsules(capsule_id,installation_id,version_id,retention_basis,source_content_hash) VALUES($1,$2,$3,'user_accepted',decode(repeat('cc',32),'hex'))",[capsule,pagedInstallation,version])
   await sql("INSERT INTO memory.knowledge_evidence(evidence_id,installation_id,version_id,capsule_id,evidence_kind,excerpt,excerpt_hash,source_evidence_hash,occurred_at,ordinal) VALUES($1,$2,$3,$4,'accepted_excerpt','owned accepted excerpt',sha256('owned accepted excerpt'),repeat('cc',32),now(),1)",[evidence,pagedInstallation,version,capsule])
   return {claim,version,capsule,evidence}
  }
  async function acceptedClaims(episodeIds:string[]){
   const identity=(statement:string)=>{
    const frame={claimType:'test_invariant',scopeKind:'installation' as const,scopeKey:'',canonicalRepositoryKey:null,repositoryId:null,snapshotId:null,branch:null,statement,status:'verified' as const,structuredContent:{},validFrom:null,validUntil:null}
    const v2=claimIdentityV2(frame)
    return {normalized_key:normalizedClaimKey(frame),normalized_key_v2:v2.key,topic_key_v2:v2.topicKey,duplicate_digest_v2:claimDuplicateDigestV2(frame)}
   }
   const rows=episodeIds.map((episode,index)=>{
    const claim=randomUUID(),replacement=index%2===1,acceptedStatement='Independently accepted invariant for Claim '+claim,currentStatement='Source-only current invariant for Claim '+claim
    return {episode,claim,kept:randomUUID(),current:randomUUID(),capsule:randomUUID(),replacement,acceptedStatement,currentStatement,
     currentIdentity:identity(replacement?currentStatement:acceptedStatement),acceptedIdentity:identity(acceptedStatement)}
   })
   for(let at=0;at<rows.length;at+=128){const batch=JSON.stringify(rows.slice(at,at+128))
    const records='jsonb_to_recordset($2::jsonb)r(episode uuid,claim uuid,kept uuid,current uuid,capsule uuid,replacement boolean,"acceptedStatement" text,"currentStatement" text,"currentIdentity" jsonb,"acceptedIdentity" jsonb)'
    await sql(`INSERT INTO memory.knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,normalized_key_v2,topic_key_v2,duplicate_digest_v2,state)
     SELECT r.claim,$1,'test_invariant','installation','',r."currentIdentity"->>'normalized_key',r."currentIdentity"->>'normalized_key_v2',r."currentIdentity"->>'topic_key_v2',r."currentIdentity"->>'duplicate_digest_v2','active' FROM ${records}`,[pagedInstallation,batch])
    await sql(`INSERT INTO memory.knowledge_versions(version_id,installation_id,claim_id,version_number,statement,authority,confidence) SELECT r.kept,$1,r.claim,1,r."acceptedStatement",'user_accepted',1 FROM ${records}`,[pagedInstallation,batch])
    await sql(`INSERT INTO memory.knowledge_versions(version_id,installation_id,claim_id,version_number,statement,authority,confidence) SELECT r.current,$1,r.claim,2,r."currentStatement",'user_accepted',1 FROM ${records} WHERE replacement`,[pagedInstallation,batch])
    await sql(`UPDATE memory.knowledge_claims c SET current_version_id=CASE WHEN r.replacement THEN r.current ELSE r.kept END FROM ${records} WHERE c.claim_id=r.claim AND c.installation_id=$1`,[pagedInstallation,batch])
    await sql(`INSERT INTO memory.knowledge_evidence_capsules(capsule_id,installation_id,version_id,retention_basis,source_content_hash) SELECT r.capsule,$1,r.kept,'user_accepted',sha256(convert_to(r."acceptedStatement",'UTF8')) FROM ${records}`,[pagedInstallation,batch])
    await sql(`INSERT INTO memory.knowledge_evidence(evidence_id,installation_id,version_id,episode_id,evidence_kind,excerpt,excerpt_hash,occurred_at,ordinal) SELECT gen_random_uuid(),$1,CASE WHEN r.replacement THEN r.current ELSE r.kept END,r.episode,'episode',CASE WHEN r.replacement THEN r."currentStatement" ELSE r."acceptedStatement" END,sha256(convert_to(CASE WHEN r.replacement THEN r."currentStatement" ELSE r."acceptedStatement" END,'UTF8')),now(),0 FROM ${records}`,[pagedInstallation,batch])
    await sql(`INSERT INTO memory.knowledge_evidence(evidence_id,installation_id,version_id,capsule_id,evidence_kind,excerpt,excerpt_hash,source_evidence_hash,occurred_at,ordinal) SELECT gen_random_uuid(),$1,r.kept,r.capsule,'accepted_excerpt',r."acceptedStatement",sha256(convert_to(r."acceptedStatement",'UTF8')),encode(sha256(convert_to(r."acceptedStatement",'UTF8')),'hex'),now(),CASE WHEN r.replacement THEN 0 ELSE 1 END FROM ${records}`,[pagedInstallation,batch])
   }
   return rows
  }
  return {sql,config,source,episodes,acceptedClaim,acceptedClaims}
 }finally{await pool.end()}
}

/** A harness deadline must abort and drain the in-flight maintenance promise
 * before the next fixture can run. Cleanup never swallows the original error. */
export function pagedMaintenanceTestLifecycle(){
 let controller=new AbortController()
 const transactionStarts=new WeakMap<pg.Client,number>()
 let windows:number[]=[],queryMs=0,caseStart=performance.now(),startedWindows=0,identityStateReads=0,identityCandidateReads=0
 const originalQuery=pg.Client.prototype.query
 pg.Client.prototype.query=function(this:pg.Client,...args:unknown[]){
  const sql=typeof args[0]==='string'?args[0]:''
  const started=performance.now()
  if(sql.startsWith('SELECT identity_generation FROM memory_governance_v2_states'))identityStateReads++
  if(sql.startsWith('SELECT c.*,to_jsonb(v) AS current_version_metadata'))identityCandidateReads++
  if(/^BEGIN(?: |;|$)/.test(sql)){transactionStarts.set(this,started);startedWindows++}
  const inWindow=transactionStarts.has(this)
  const result=Reflect.apply(originalQuery,this,args)
  const measured=()=>{
   if(inWindow)queryMs=Math.max(queryMs,performance.now()-started)
   if(/^(COMMIT|ROLLBACK)(?: |;|$)/.test(sql)){
    const from=transactionStarts.get(this);if(from!==undefined)windows.push(performance.now()-from)
    transactionStarts.delete(this)
   }
  }
  return result?.then?(result as Promise<pg.QueryResult>).then(value=>{measured();return value},error=>{measured();throw error}):result
 } as pg.Client['query']
 afterAll(()=>{pg.Client.prototype.query=originalQuery})
 const active=new Set<Promise<unknown>>()
 beforeEach(({signal})=>{
  windows=[];queryMs=0;caseStart=performance.now();startedWindows=0;identityStateReads=0;identityCandidateReads=0
  controller=new AbortController();const current=controller
  signal.addEventListener('abort',()=>current.abort(),{once:true})
 })
 afterEach(async()=>{
  controller.abort()
  let timer:ReturnType<typeof setTimeout>|undefined
  try{await Promise.race([Promise.allSettled([...active]),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('paged_test_cleanup_not_drained')),2000)})])}
  finally{
   clearTimeout(timer)
   process.stdout.write(JSON.stringify({task7WindowMetrics:{caseWallMs:Math.ceil(performance.now()-caseStart),identityStateReads,identityCandidateReads,startedWindows,completedWindows:windows.length,totalCompletedWindowMs:Math.ceil(windows.reduce((sum,ms)=>sum+ms,0)),maxCompletedWindowMs:Math.ceil(Math.max(0,...windows)),maxQueryMs:Math.ceil(queryMs)}})+'\n')
  }
 })
 function track<T>(promise:Promise<T>){active.add(promise);void promise.then(()=>active.delete(promise),()=>active.delete(promise));return promise}
 return {
  planPagedCleanup:(...args:Parameters<typeof plan>)=>track(plan(args[0],args[1],args[2],{...args[3],signal:controller.signal})),
  applyPagedCleanup:(...args:Parameters<typeof apply>)=>track(apply(args[0],args[1],{...args[2],signal:controller.signal})),
  verifyPagedCleanup:(...args:Parameters<typeof verify>)=>track(verify(args[0],args[1],{...args[2],signal:controller.signal})),
 }
}
