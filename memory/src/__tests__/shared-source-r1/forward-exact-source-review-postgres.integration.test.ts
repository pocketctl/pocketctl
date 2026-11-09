import {installNativeAliasFixture} from './native-alias-fixture.js'
import {JSON_COLUMN_POLICY} from '../../migrations/shared-source/json-reference-policy.js'
import {SOURCE_REFERENCE_FIELDS,UNREVIEWED_SESSION_ARRAY_KEYS,retainedReferenceRoster,matchesSourceReferenceSql,retainedArrayExpansionSql,retainedScalarReferenceSql} from '../../migrations/shared-forward/source-reference-contract.js'
import {exactReferenceChannels} from '../../migrations/shared-forward/forward-exact-source.js'
import {seal} from '../../migrations/shared-forward/source-maintenance-common.js'
import {createProviderBudgetStore} from '../../model/provider-budget.js'
import {skillFixtureDocument} from '../../testing/skill-fixture.js'
import {randomUUID} from 'node:crypto'
import pg from 'pg'
import {planForwardCleanup,applyForwardCleanup,verifyForwardCleanup,type ForwardCleanupConfig} from '../../migrations/shared-forward/forward-cleanup.js'
import {createMemoryPool} from '../../db.js'
import {afterAll,beforeAll,beforeEach,describe,expect,test} from 'vitest'
import {applyMemorySchema} from '../../schema.js'
import {applySharedSourceContract} from '../../migrations/shared-db/contract.js'
import {planPrivacyOverlay as rawPlanPrivacyOverlay,applyPrivacyOverlay as rawApplyPrivacyOverlay,verifyPrivacyOverlay as rawVerifyPrivacyOverlay,type PrivacyOverlayConfig} from '../../migrations/shared-forward/privacy-overlay.js'
const url=process.env.SHARED_W4_SOURCE_POLICY_REVIEW_TEST_DATABASE_URL,suite=url?describe:describe.skip
const installation='10000000-0000-0000-0000-000000000064',submission='20000000-0000-0000-0000-000000000064',decision='30000000-0000-0000-0000-000000000064'
suite('exact cross-Session source policy',()=>{
 let config:PrivacyOverlayConfig,capsule:string,sentinel:string
 const schemaSeeds:{table:string;columns:string[];rows:string}[]=[]
 const quote=(identifier:string)=>'"'+identifier.replaceAll('"','""')+'"'
 const probe=async()=>({api:{LoadState:'loaded',ActiveState:'inactive',SubState:'dead',MainPID:'0'},worker:{LoadState:'loaded',ActiveState:'inactive',SubState:'dead',MainPID:'0'},observedAt:new Date().toISOString()})
 const options={probe}
 async function fixtureDrained(){
  const monitorUrl=new URL(url!);monitorUrl.pathname='/postgres';const monitor=new pg.Client({connectionString:monitorUrl.toString()});await monitor.connect()
  try{for(let attempt=0;attempt<100;attempt++){if(!(await monitor.query('SELECT 1 FROM pg_stat_activity WHERE datname=$1 LIMIT 1',[new URL(url!).pathname.slice(1)])).rowCount)return;await new Promise(resolve=>setTimeout(resolve,20))}throw Error('owned_fixture_backend_not_drained')}finally{await monitor.end()}
 }
 const planPrivacyOverlay=async(...args:Parameters<typeof rawPlanPrivacyOverlay>)=>{await fixtureDrained();return rawPlanPrivacyOverlay(...args)}
 const applyPrivacyOverlay=async(...args:Parameters<typeof rawApplyPrivacyOverlay>)=>{await fixtureDrained();return rawApplyPrivacyOverlay(...args)}
 const verifyPrivacyOverlay=async(...args:Parameters<typeof rawVerifyPrivacyOverlay>)=>{await fixtureDrained();return rawVerifyPrivacyOverlay(...args)}
 async function sql(text:string,params?:unknown[]){const c=new pg.Client({connectionString:url});await c.connect();try{return await c.query(text,params)}finally{await c.end()}}
 async function checkpointCount(planHash:string){if(!(await sql("SELECT to_regclass('shared.memory_forward_cleanup_steps') AS relation")).rows[0].relation)return 0;return(await sql('SELECT count(*)::int AS n FROM shared.memory_forward_cleanup_steps WHERE plan_hash=$1',[planHash])).rows[0].n as number}
 async function reserveUnknownBudget(key:string){
  const input={key,requestKey:'stable-selected-call',kind:'text' as const,inputTokens:37,outputTokens:19,maxRequests:2,maxInputTokens:1000,maxOutputTokens:1000},runtime=createMemoryPool({databaseUrl:url!,databaseNamespace:'memory',dbPoolMax:1})
  try{const store=createProviderBudgetStore(runtime),reserved=await store.reserve(input);expect(reserved.ok).toBe(true);expect(await store.reserve(input)).toMatchObject({ok:false,reason:'provider_result_unknown'});return input}finally{await runtime.end()}
 }
 async function assertUnknownBudget(input:Awaited<ReturnType<typeof reserveUnknownBudget>>){const runtime=createMemoryPool({databaseUrl:url!,databaseNamespace:'memory',dbPoolMax:1});try{expect(await createProviderBudgetStore(runtime).reserve(input)).toMatchObject({ok:false,reason:'provider_result_unknown'})}finally{await runtime.end()}}
 async function ensureDeliveryPrivacyCapture(){
  await sql("ALTER TABLE shared.memory_source_contract ADD COLUMN IF NOT EXISTS delivery_privacy_capture_version int NOT NULL DEFAULT 1;UPDATE shared.memory_source_contract SET delivery_privacy_capture_version=1")
  for(const relation of ['public.team_delivery_memory_withdrawals','public.team_artifact_revocations'])if(!(await sql("SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass($1) AND tgname='memory_delivery_privacy_fence'",[relation])).rowCount)await sql('CREATE TRIGGER memory_delivery_privacy_fence BEFORE INSERT OR UPDATE OR DELETE ON '+relation+' FOR EACH ROW EXECUTE FUNCTION shared.fence_memory_delivery_withdrawal()')
 }
 beforeAll(async()=>{
  if(!url||!new URL(url).pathname.endsWith('_test'))throw Error('isolated_test_required')
  const pool=new pg.Pool({connectionString:url});await applyMemorySchema(pool,{namespace:'memory'});await applySharedSourceContract(pool)
  // This long synthetic suite deliberately creates/deletes >1024 rows. Keep
  // autonomous VACUUM out of its deterministic maintenance window; explicit
  // lock-contention tests below still exercise the real NOWAIT refusal.
  for(const row of (await pool.query("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='memory' AND c.relkind='r'")).rows)await pool.query('ALTER TABLE memory."'+String(row.relname).replaceAll('"','""')+'" SET(autovacuum_enabled=false)')
  // Capture only migration-created seed DATA once, before any synthetic user
  // fixture exists. Preserve exact JSON text/bigints; no application backup.
  const seeded=(await pool.query(`SELECT n.nspname,c.relname,ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND a.attgenerated='' ORDER BY a.attnum) AS columns FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('memory','shared') AND c.relkind IN('r','p') AND c.relname NOT IN('memory_schema_migrations','memory_source_contract') ORDER BY n.nspname,c.relname`)).rows
  for(const row of seeded){const table=quote(row.nspname)+'.'+quote(row.relname),rows=(await pool.query(`SELECT COALESCE(jsonb_agg(to_jsonb(t)),'[]'::jsonb)::text AS value FROM ${table} t`)).rows[0].value;if(rows!=='[]')schemaSeeds.push({table,columns:row.columns,rows})}
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
   CREATE TABLE public.canonical_sentinel(id bigint PRIMARY KEY,body text);`)
  await installNativeAliasFixture(pool)
  await pool.end()
 },60000)
 async function seedFixture(pool:Pick<pg.Pool,'query'>){
  await pool.query(`INSERT INTO public.users VALUES(1);INSERT INTO public.daemons VALUES('daemon',1);INSERT INTO public.sessions VALUES('session',1,'daemon','codex','hot','codex');INSERT INTO public.extension_providers VALUES('pocketctl-memory','enabled');INSERT INTO public.canonical_sentinel VALUES(9007199254740993,'canonical body')`)
  await pool.query(`INSERT INTO public.extension_installations VALUES($1,'pocketctl-memory',1,'personal',$1,'active',1,1,'{}','{}','{}','{}')`,[installation])
  await pool.query(`INSERT INTO memory.memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)`,[installation])
  await pool.query("INSERT INTO memory.memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id) VALUES($1,'personal',$1)",[installation])
  await pool.query("INSERT INTO shared.memory_source_modes(installation_id,mode) VALUES($1,'legacy-feed')",[installation])
  for(const s of ['session','delivery'])await pool.query('INSERT INTO memory.source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES($1,$2,now(),now())',[installation,s])
  await pool.query("INSERT INTO public.team_delivery_memory_sources VALUES('delivery','team','team-session',$1,$2,NULL,NULL)",[submission,decision])
  const claim=(await pool.query(`INSERT INTO memory.knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state) VALUES(gen_random_uuid(),$1::uuid,'repository_convention','installation',$1::text,'accepted','active') RETURNING claim_id::text`,[installation])).rows[0].claim_id
  const version=(await pool.query(`INSERT INTO memory.knowledge_versions(version_id,installation_id,claim_id,version_number,statement,authority,confidence,freshness_at) VALUES(gen_random_uuid(),$1,$2,1,'accepted survives','user_accepted',0.9,now()) RETURNING version_id::text`,[installation,claim])).rows[0].version_id
  await pool.query(`INSERT INTO memory.knowledge_evidence_capsules(capsule_id,installation_id,version_id,retention_basis,source_content_hash) VALUES(gen_random_uuid(),$1,$2,'user_accepted',decode(repeat('ab',32),'hex'))`,[installation,version])
  capsule=JSON.stringify((await pool.query('SELECT row_to_json(c)::text FROM memory.knowledge_evidence_capsules c')).rows)
  sentinel=JSON.stringify((await pool.query('TABLE public.canonical_sentinel')).rows)
  const expected=(await pool.query(`SELECT current_database() AS database,current_user AS role,d.oid::text AS "databaseOid",inet_server_addr()::text AS "serverAddress",inet_server_port()::text AS "serverPort" FROM pg_database d WHERE datname=current_database()`)).rows[0]
  config={database:{url:url!,expected},installationIds:[installation],units:{api:'synthetic-api.service',worker:'synthetic-worker.service',freshInstall:false}}
 }
 beforeEach(async()=>{
  await fixtureDrained()
  const client=new pg.Client({connectionString:url});await client.connect()
  try{
   await client.query('BEGIN')
   // Reset all owned fixture DATA, including independent rows without an
   // installation FK, control modes and durable cleanup receipts. Keep schema
   // and its reviewed version/contract rows installed once for this file.
   const tables=(await client.query(`SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('memory','shared','public') AND c.relkind IN('r','p') AND c.relname NOT IN('memory_schema_migrations','memory_source_contract') ORDER BY n.nspname,c.relname`)).rows
   await client.query('TRUNCATE '+tables.map(row=>quote(row.nspname)+'.'+quote(row.relname)).join(',')+' RESTART IDENTITY CASCADE')
   for(const seed of schemaSeeds){const columns=seed.columns.map(quote).join(',');await client.query('INSERT INTO '+seed.table+'('+columns+') OVERRIDING SYSTEM VALUE SELECT '+columns+' FROM jsonb_populate_recordset(NULL::'+seed.table+',$1::jsonb)',[seed.rows])}
   await seedFixture(client)
   await client.query('COMMIT')
  }catch(error){await client.query('ROLLBACK');throw error}finally{await client.end()}
 })
 afterAll(async()=>{})

 const keys=[{version:'test',key:'synthetic-only-maintenance-hmac-key'}]
 const cleanupConfig=()=>({...config,tombstoneHmacKeys:keys}) satisfies ForwardCleanupConfig
 async function source(name:string){
  await sql("INSERT INTO public.sessions VALUES($1,1,'daemon','codex','hot','codex')",[name]);await sql('INSERT INTO public.deleted_sessions VALUES($1)',[name])
  await sql('INSERT INTO memory.source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES($1,$2,now(),now())',[installation,name])
  await sql("INSERT INTO memory.source_events(source_event_id,installation_id,origin,origin_position,session_id,event_type,occurred_at,payload,payload_hash) VALUES(gen_random_uuid(),$1,'feed',$2,$2,'test',now(),'{\"text\":\"private source body\"}',decode(repeat('ab',32),'hex'))",[installation,name])
 }
 async function plan(){await fixtureDrained();const overlay=await planPrivacyOverlay(config,options);await applyPrivacyOverlay(config,overlay,options);await fixtureDrained();return planForwardCleanup(cleanupConfig(),overlay,options)}


 test.each(['source_event_ids','sourceEventIds','artifact_ids','artifactIds'])('review witness unparsed episode.document %s must refuse before source purge',async key=>{
  const name='review-array-'+key;await source(name);const event=(await sql('SELECT source_event_id FROM memory.source_events WHERE session_id=$1',[name])).rows[0].source_event_id,artifact=randomUUID(),episode=randomUUID()
  await sql("INSERT INTO memory.source_artifacts(artifact_id,installation_id,session_id,source_event_id,artifact_type,identity_key,details,occurred_at) VALUES($1,$2,$3,$4,'other',$1::uuid::text,'{}',now())",[artifact,installation,name,event])
  await sql("INSERT INTO memory.work_episodes(installation_id,episode_id,session_id,turn_id,state,compiler_version,document,evidence_manifest) VALUES($1,$2,'session',$2::uuid::text,'ready','test',$3,'{}')",[installation,episode,{unparsed:{[key]:[key.startsWith('artifact')?artifact:event],body:'synthetic reference-bearing derived body'}}])
  const before=JSON.stringify((await sql('SELECT row_to_json(t) AS value FROM memory.work_episodes t WHERE episode_id=$1',[episode])).rows)
  let outcome='refused'
  try{const p=await plan(),applied=await applyForwardCleanup(cleanupConfig(),p,options);outcome=applied.privacyCatchupReadyForReopen?'admitted_ready':'admitted_not_ready'}catch(error){if(!String(error).includes('cleanup_exact_source_unknown_reference_metadata'))throw error}
  if(outcome!=='refused'){expect((await sql('SELECT count(*)::int AS n FROM memory.source_events WHERE source_event_id=$1',[event])).rows[0].n).toBe(0);expect(JSON.stringify((await sql('SELECT row_to_json(t) AS value FROM memory.work_episodes t WHERE episode_id=$1',[episode])).rows)).toBe(before)}
  if(outcome==='refused'){expect((await sql('SELECT count(*)::int AS n FROM memory.source_events WHERE source_event_id=$1',[event])).rows[0].n).toBe(1);expect(JSON.stringify((await sql('SELECT row_to_json(t) AS value FROM memory.work_episodes t WHERE episode_id=$1',[episode])).rows)).toBe(before)}
  await sql('DELETE FROM memory.work_episodes WHERE episode_id=$1',[episode])
  expect(outcome,'unparsed array reference requires pre-mutation refusal').toBe('refused')
 },30000)
 test.each(['source_event_id','source_event_ids'])('review witness task-bundle spans %s without source FK must refuse',async key=>{
  const name='review-bundle-'+key;await source(name);const event=(await sql('SELECT source_event_id FROM memory.source_events WHERE session_id=$1',[name])).rows[0].source_event_id,bundle=randomUUID()
  await sql("INSERT INTO memory.memory_task_bundles(installation_id,bundle_id,task_key,session_id,source_digest,watermark,spans,topic_descriptor) VALUES($1,$2,$2::uuid::text,'session',sha256('review-original-source'),1,$3,'synthetic private bundle descriptor')",[installation,bundle,JSON.stringify([{[key]:key.endsWith('_ids')?[event]:event,start:0,end:4}])])
  const before=JSON.stringify((await sql('SELECT row_to_json(t) AS value FROM memory.memory_task_bundles t WHERE bundle_id=$1',[bundle])).rows)
  let outcome='refused'
  try{const p=await plan(),applied=await applyForwardCleanup(cleanupConfig(),p,options);outcome=applied.privacyCatchupReadyForReopen?'admitted_ready':'admitted_not_ready'}catch(error){if(!String(error).includes('cleanup_exact_source_cross_session_bundle_requires_policy'))throw error}
  if(outcome!=='refused'){expect((await sql('SELECT count(*)::int AS n FROM memory.source_events WHERE source_event_id=$1',[event])).rows[0].n).toBe(0);expect(JSON.stringify((await sql('SELECT row_to_json(t) AS value FROM memory.memory_task_bundles t WHERE bundle_id=$1',[bundle])).rows)).toBe(before)}
  if(outcome==='refused'){expect((await sql('SELECT count(*)::int AS n FROM memory.source_events WHERE source_event_id=$1',[event])).rows[0].n).toBe(1);expect(JSON.stringify((await sql('SELECT row_to_json(t) AS value FROM memory.memory_task_bundles t WHERE bundle_id=$1',[bundle])).rows)).toBe(before)}
  await sql('DELETE FROM memory.memory_task_bundles WHERE bundle_id=$1',[bundle])
  expect(outcome,'unreviewed bundle spans reference requires pre-mutation refusal').toBe('refused')
 },30000)
 test('all declared retained reference channels share the negative roster and SQL spellings',async()=>{
  expect(exactReferenceChannels()).toEqual(expect.arrayContaining([...retainedReferenceRoster(),...Object.entries(JSON_COLUMN_POLICY).filter(([,policy])=>policy.kind==='reference').map(([path])=>path)]));expect(exactReferenceChannels()).toContain('source_events.source_version')
  const id=randomUUID(),variables={events:[id],artifacts:[id],episodes:[id],roots:[{installationId:installation,sessionId:'scoped-selected'}]},predicate=matchesSourceReferenceSql('$1::jsonb','$2::jsonb',"'"+installation+"'::uuid")
  for(const field of SOURCE_REFERENCE_FIELDS)for(const key of [...field.scalar,...field.arrays]){
   const value=field.domain==='sessions'?'scoped-selected':id.toUpperCase(),metadata={nested:{[key]:(field.arrays as readonly string[]).includes(key)?[value]:value}}
   expect((await sql('SELECT '+predicate+' AS matched',[metadata,variables])).rows[0].matched,key).toBe(true)
  }
  for(const key of UNREVIEWED_SESSION_ARRAY_KEYS)expect((await sql('SELECT '+predicate+' AS matched',[{nested:{[key]:['scoped-selected']}},variables])).rows[0].matched,key).toBe(true)
  // Retained ->> also coerces non-string Session values. These unreviewed
  // shapes must refuse when they name an actual scoped Session.
  for(const value of [123,true,{id:'native-handle'},['native-handle']]){const metadata={session_id:value},sessionId=(await sql("SELECT $1::jsonb->>'session_id' AS id",[metadata])).rows[0].id;expect((await sql('SELECT '+predicate+' AS matched',[metadata,{...variables,roots:[{installationId:installation,sessionId}]}])).rows[0].matched).toBe(true)}
  // One spelling cannot mask another, even when the sibling is malformed.
  expect((await sql('SELECT '+predicate+' AS matched',[{source_event_id:'unrelated',sourceEventId:id,source_event_ids:'malformed',sourceEventIds:[id]},variables])).rows[0].matched).toBe(true)
  expect((await sql('SELECT '+predicate+' AS matched',[{body:'ordinary prose '+id,ordinary_uuid:id,nested:{sessionIds:['unrelated']}},variables])).rows[0].matched).toBe(false)
  // Session names are scoped; UUID-looking body text never grants authority.
  expect((await sql('SELECT '+matchesSourceReferenceSql('$1::jsonb','$2::jsonb',"'"+randomUUID()+"'::uuid")+' AS matched',[{session_id:'scoped-selected'},variables])).rows[0].matched).toBe(false)
  // The retained extractor keeps its previous COALESCE precedence/output.
  const extracted=(await sql(`WITH objects AS(SELECT $1::jsonb AS object),expanded AS(SELECT value AS object FROM objects CROSS JOIN LATERAL jsonb_array_elements(${retainedArrayExpansionSql('object')}) value) SELECT jsonb_strip_nulls(jsonb_build_object(${retainedScalarReferenceSql('object')})) AS refs FROM expanded`,[{source_event_ids:[id],artifactIds:[id],episode_ids:[id],session_id:'scoped-selected',canonical_session_key:'scoped-selected'}])).rows.map(r=>r.refs)
  expect(extracted).toEqual(expect.arrayContaining([{sourceEventId:id},{artifactId:id},{episodeId:id},{sessionId:'scoped-selected',canonicalSessionId:'scoped-selected'}]))
 })
 async function selectedEvent(name:string){await source(name);return(await sql('SELECT source_event_id FROM memory.source_events WHERE session_id=$1',[name])).rows[0].source_event_id as string}
 async function currentPack(){const pack=randomUUID();await sql("INSERT INTO memory.memory_context_packs(pack_id,installation_id,session_id,client_request_id,agent,mode,effective_policy_hash,input_digest,state,stable_text) VALUES($1,$2,'session',$1::uuid::text,'codex','enabled',sha256('policy'),sha256('input'),'ready','synthetic current context body')",[pack,installation]);return pack}
 test.each(['context','provenance','artifact','source-version'] as const)('unreviewed %s channel refuses without a typed dependent FK',async channel=>{
  const event=await selectedEvent('channel-'+channel),pack=channel==='context'?await currentPack():null,other=randomUUID(),artifact=randomUUID()
  if(channel==='context')await sql('UPDATE memory.memory_context_packs SET selected_references=$2 WHERE pack_id=$1',[pack,JSON.stringify([{sourceEventIds:[event]}])])
  else{
   await sql("INSERT INTO memory.source_events(source_event_id,installation_id,origin,origin_position,session_id,event_type,occurred_at,payload,payload_hash,source_provenance,source_version) VALUES($1,$2,'feed',$1::uuid::text,'session','test',now(),'{}',sha256('independent'),$3,$4)",[other,installation,channel==='provenance'?{sourceEventIds:[event]}:{},channel==='source-version'?{source_event_ids:[event]}:null])
   if(channel==='artifact')await sql("INSERT INTO memory.source_artifacts(artifact_id,installation_id,session_id,source_event_id,artifact_type,identity_key,details,occurred_at) VALUES($1,$2,'session',$3,'other',$1::uuid::text,$4,now())",[artifact,installation,other,{nested:{source_event_ids:[event]}}])
  }
  await expect(plan()).rejects.toThrow('cleanup_exact_source_unknown_reference_metadata:')
  expect((await sql('SELECT count(*)::int AS n FROM memory.source_events WHERE source_event_id=$1',[event])).rows[0].n).toBe(1)
  if(pack)await sql('DELETE FROM memory.memory_context_packs WHERE pack_id=$1',[pack]);else await sql('DELETE FROM memory.source_events WHERE source_event_id=$1',[other])
 },30000)
 test.each(['episode_id','episodeId','episode_ids','episodeIds','session_id','sessionId','session_ids','sessionIds','canonical_session_key'] as const)('unreviewed %s handles remain negative-only',async key=>{
  const name='reference-key-'+key,event=await selectedEvent(name),selected=randomUUID(),dependent=randomUUID()
  await sql("INSERT INTO memory.work_episodes(installation_id,episode_id,session_id,turn_id,state,compiler_version) VALUES($1,$2,$3,$2::uuid::text,'ready','test')",[installation,selected,name])
  const value=key.startsWith('episode')?selected:name,plural=key.endsWith('_ids')||key.endsWith('Ids')
  await sql("INSERT INTO memory.work_episodes(installation_id,episode_id,session_id,turn_id,state,compiler_version,document) VALUES($1,$2,'session',$2::uuid::text,'ready','test',$3)",[installation,dependent,{unparsed:{[key]:plural?[value]:value}}])
  await expect(plan()).rejects.toThrow('cleanup_exact_source_unknown_reference_metadata:work_episodes.document');expect((await sql('SELECT count(*)::int AS n FROM memory.source_events WHERE source_event_id=$1',[event])).rows[0].n).toBe(1)
  await sql('DELETE FROM memory.work_episodes WHERE episode_id=$1',[dependent])
 },30000)
 test.each(['narrow','linked','exact'] as const)('late reference on pre-existing parent refuses %s apply resume verify before and after source deletion',async shape=>{
  const name='late-contract-'+shape,event=await selectedEvent(name),episode=randomUUID(),pack=await currentPack()
  if(shape!=='narrow'){
   await sql("INSERT INTO memory.work_episodes(installation_id,episode_id,session_id,turn_id,state,compiler_version,document_compiler_version,evidence_manifest) VALUES($1,$2,$3,$2::uuid::text,'ready','test','memory-episode-packet-v6',$4)",[installation,episode,shape==='exact'?'session':name,shape==='exact'?{e1:{kind:'event',evidence_role:'substantive',source_event_id:event,excerpt_hash:'b'.repeat(64),excerpt_length:20,truncated:false}}:{}])
   if(shape==='linked'){
    const claim=randomUUID(),version=randomUUID();await sql("INSERT INTO memory.knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state) VALUES($1,$2,'test_invariant','installation','',$1::uuid::text,'active')",[claim,installation]);await sql("INSERT INTO memory.knowledge_versions(version_id,installation_id,claim_id,version_number,statement,authority,confidence) VALUES($1,$2,$3,1,'selected raw fact','user_accepted',1)",[version,installation,claim]);await sql('UPDATE memory.knowledge_claims SET current_version_id=$2 WHERE claim_id=$1',[claim,version]);await sql("INSERT INTO memory.knowledge_evidence(evidence_id,installation_id,version_id,episode_id,evidence_kind,excerpt,excerpt_hash,occurred_at,ordinal) VALUES(gen_random_uuid(),$1,$2,$3,'episode','selected',sha256('selected'),now(),0)",[installation,version,episode])
   }
  }
  const p=await plan();expect(p.schemaVersion).toBe({narrow:1,linked:2,exact:3}[shape]);if(shape==='exact'){
   expect(p.dependencies.linked!.exactSources!.version).toBe(2)
   const {manifestHash:_,...body}=p,old=seal({...body,dependencies:{...p.dependencies,linked:{...p.dependencies.linked!,exactSources:{...p.dependencies.linked!.exactSources!,version:1}}}}) as unknown as typeof p
   for(const operation of [applyForwardCleanup,verifyForwardCleanup])await expect(operation(cleanupConfig(),old,options)).rejects.toThrow('cleanup_exact_source_policy_version_unsupported');expect(await checkpointCount(old.manifestHash)).toBe(0)
  }
  const rawBefore=JSON.stringify((await sql('SELECT row_to_json(t) AS value FROM memory.source_events t WHERE source_event_id=$1',[event])).rows)
  await sql('UPDATE memory.memory_context_packs SET selected_references=$2 WHERE pack_id=$1',[pack,JSON.stringify([{sourceEventIds:[event]}])])
  for(const operation of [applyForwardCleanup,verifyForwardCleanup,applyForwardCleanup])await expect(operation(cleanupConfig(),p,options)).rejects.toThrow('cleanup_exact_source_unknown_reference_metadata:memory_context_packs.selected_references')
  expect(await checkpointCount(p.manifestHash)).toBe(0);expect(JSON.stringify((await sql('SELECT row_to_json(t) AS value FROM memory.source_events t WHERE source_event_id=$1',[event])).rows)).toBe(rawBefore)
  await sql("UPDATE memory.memory_context_packs SET selected_references='[]' WHERE pack_id=$1",[pack]);const fresh=await plan()
  await expect(applyForwardCleanup(cleanupConfig(),fresh,{...options,afterCommit:async index=>{const step=fresh.steps[index];if(step.kind==='session'&&step.sessionId===name)throw Error('contract_lost_commit')}})).rejects.toThrow('contract_lost_commit')
  expect((await sql('SELECT count(*)::int AS n FROM memory.source_events WHERE source_event_id=$1',[event])).rows[0].n).toBe(0);const committed=await checkpointCount(fresh.manifestHash);expect(committed).toBeGreaterThan(0)
  await sql('UPDATE memory.memory_context_packs SET selected_references=$2 WHERE pack_id=$1',[pack,JSON.stringify([{source_event_ids:[event]}])])
  for(const operation of [applyForwardCleanup,verifyForwardCleanup,applyForwardCleanup])await expect(operation(cleanupConfig(),fresh,options)).rejects.toThrow('cleanup_exact_source_unknown_reference_metadata:memory_context_packs.selected_references')
  expect(await checkpointCount(fresh.manifestHash)).toBe(committed);await sql('DELETE FROM memory.memory_context_packs WHERE pack_id=$1',[pack])
 },60000)
 test('unrelated large derived metadata and ordinary UUID prose survive genuine selected source cleanup',async()=>{
  const event=await selectedEvent('large-unrelated-reference'),prefix='unrelated-large-',ordinary='ordinary prose mentions '+event
  await sql("INSERT INTO memory.work_episodes(installation_id,episode_id,session_id,turn_id,state,compiler_version,document,evidence_manifest) SELECT $1,gen_random_uuid(),'session',$2||n,'ready','test',jsonb_build_object('ordinary_uuid',$3::text,'body',repeat($4,24)),'{}' FROM generate_series(1,1600)n",[installation,prefix,event,ordinary])
  const counts=async()=> (await sql("SELECT count(*)::int AS n,min(document->>'ordinary_uuid') AS original,max(octet_length(document::text))::int AS bytes FROM memory.work_episodes WHERE turn_id LIKE 'unrelated-large-%'")).rows[0]
  const before=await counts();expect(before.n).toBe(1600);const p=await plan();expect(p.initialState.find(t=>t.table==='work_episodes')!.rows).toBe(p.dependencies.episodeIds.length);await applyForwardCleanup(cleanupConfig(),p,options);expect(await counts()).toEqual(before)
  expect((await sql('SELECT count(*)::int AS n FROM memory.source_events WHERE source_event_id=$1',[event])).rows[0].n).toBe(0)
  // This case proved exact noninterference above. Retire only its own 1600
  // large synthetic rows so later scoped plans do not accumulate fixture cost.
  await sql("DELETE FROM memory.work_episodes WHERE installation_id=$1 AND left(turn_id,length($2))=$2",[installation,prefix])
 },60000)

 test.each(['valid','mismatched'] as const)('independently accepted locator %s requires the exact native capsule tuple',async mode=>{
  const name='accepted-locator-'+mode,event=await selectedEvent(name),claim=randomUUID(),version=randomUUID(),other=randomUUID(),capsule=randomUUID(),evidence=randomUUID()
  await sql("INSERT INTO memory.knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state) VALUES($1,$2,'test_invariant','installation','',$1::uuid::text,'active')",[claim,installation])
  for(const [id,number] of [[version,1],[other,2]])await sql("INSERT INTO memory.knowledge_versions(version_id,installation_id,claim_id,version_number,statement,authority,confidence) VALUES($1,$2,$3,$4,'independent accepted result','user_accepted',1)",[id,installation,claim,number])
  await sql('UPDATE memory.knowledge_claims SET current_version_id=$2 WHERE claim_id=$1',[claim,version]);await sql("INSERT INTO memory.knowledge_evidence_capsules(capsule_id,installation_id,version_id,retention_basis,source_content_hash) VALUES($1,$2,$3,'user_accepted',sha256('independent accepted result'))",[capsule,installation,version])
  await sql("INSERT INTO memory.knowledge_evidence(evidence_id,installation_id,version_id,capsule_id,evidence_kind,excerpt,excerpt_hash,occurred_at,ordinal,locator) VALUES($1,$2,$3,$4,'accepted_excerpt','independent accepted result',sha256('independent accepted result'),now(),0,$5)",[evidence,installation,mode==='valid'?version:other,capsule,{nested:{sessionId:name,source_event_ids:[event]}}])
  const state=async()=>JSON.stringify((await sql('SELECT (SELECT to_jsonb(t) FROM memory.knowledge_versions t WHERE version_id=$1) AS version,(SELECT to_jsonb(t) FROM memory.knowledge_evidence t WHERE evidence_id=$2) AS evidence,(SELECT to_jsonb(t) FROM memory.knowledge_evidence_capsules t WHERE capsule_id=$3) AS capsule',[version,evidence,capsule])).rows),before=await state()
  if(mode==='valid'){await applyForwardCleanup(cleanupConfig(),await plan(),options);expect((await sql('SELECT count(*)::int AS n FROM memory.source_events WHERE source_event_id=$1',[event])).rows[0].n).toBe(0)}
  else{await expect(plan()).rejects.toThrow('cleanup_exact_source_unknown_reference_metadata:knowledge_evidence.locator');expect((await sql('SELECT count(*)::int AS n FROM memory.source_events WHERE source_event_id=$1',[event])).rows[0].n).toBe(1)}
  expect(await state()).toBe(before);await sql('DELETE FROM memory.knowledge_evidence WHERE evidence_id=$1',[evidence])
 },30000)

})
