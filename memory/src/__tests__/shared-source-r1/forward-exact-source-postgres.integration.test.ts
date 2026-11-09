import {installNativeAliasFixture} from './native-alias-fixture.js'
import {seal} from '../../migrations/shared-forward/source-maintenance-common.js'
import {createProviderBudgetStore} from '../../model/provider-budget.js'
import {skillFixtureDocument} from '../../testing/skill-fixture.js'
import {randomUUID} from 'node:crypto'
import pg from 'pg'
import {planForwardCleanup,applyForwardCleanup,verifyForwardCleanup,type ForwardCleanupConfig} from '../../migrations/shared-forward/forward-cleanup.js'
import {createMemoryPool} from '../../db.js'
import {afterAll,beforeAll,describe,expect,test} from 'vitest'
import {applyMemorySchema} from '../../schema.js'
import {applySharedSourceContract} from '../../migrations/shared-db/contract.js'
import {planPrivacyOverlay as rawPlanPrivacyOverlay,applyPrivacyOverlay as rawApplyPrivacyOverlay,verifyPrivacyOverlay as rawVerifyPrivacyOverlay,type PrivacyOverlayConfig} from '../../migrations/shared-forward/privacy-overlay.js'
const url=process.env.SHARED_W4_SOURCE_POLICY_TEST_DATABASE_URL,suite=url?describe:describe.skip
const installation='10000000-0000-0000-0000-000000000064',submission='20000000-0000-0000-0000-000000000064',decision='30000000-0000-0000-0000-000000000064'
suite('exact cross-Session source policy',()=>{
 let config:PrivacyOverlayConfig,capsule:string,sentinel:string
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
  await pool.query(`CREATE TABLE public.users(id int PRIMARY KEY);INSERT INTO public.users VALUES(1);
   CREATE TABLE public.daemons(daemon_id text PRIMARY KEY,user_id int);INSERT INTO public.daemons VALUES('daemon',1);
   CREATE TABLE public.sessions(session_id text PRIMARY KEY,user_id int,daemon_id text,source text,content_state text,agent_type text);INSERT INTO public.sessions VALUES('session',1,'daemon','codex','hot','codex');
   CREATE TABLE public.extension_providers(provider_id text PRIMARY KEY,status text);INSERT INTO public.extension_providers VALUES('pocketctl-memory','enabled');
   CREATE TABLE public.extension_installations(installation_id uuid PRIMARY KEY,provider_id text,owner_user_id int,owner_scope_kind text,owner_scope_id uuid,status text,authorization_epoch bigint,config_version bigint,granted_scopes text[],subscriptions text[],enabled_services text[],event_filter jsonb);
   CREATE TABLE public.extension_organizations(organization_id uuid PRIMARY KEY,state text,authorization_epoch bigint);
   CREATE TABLE public.extension_teams(team_id uuid PRIMARY KEY,organization_id uuid,state text,authorization_epoch bigint);
   CREATE TABLE public.extension_scope_memberships(membership_id uuid PRIMARY KEY,scope_kind text,scope_id uuid,user_id int,roles text[],state text,membership_revision bigint);
   CREATE TABLE public.deleted_sessions(session_id text PRIMARY KEY);
   CREATE TABLE public.team_delivery_memory_sources(source_session_id text PRIMARY KEY,team_id text,team_session_id text,submission_id uuid,decision_id uuid,revoked_at timestamptz,withdrawn_at timestamptz);
   CREATE TABLE public.team_delivery_memory_withdrawals(team_id text,team_session_id text,submission_id uuid,decision_id uuid);
   CREATE TABLE public.team_artifact_revocations(submission_id uuid,artifact_id text);
   CREATE TABLE public.canonical_sentinel(id bigint PRIMARY KEY,body text);INSERT INTO public.canonical_sentinel VALUES(9007199254740993,'canonical body');`)
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
  config={database:{url,expected},installationIds:[installation],units:{api:'synthetic-api.service',worker:'synthetic-worker.service',freshInstall:false}}
  await installNativeAliasFixture(pool)
  await pool.end()
 },60000)
 afterAll(async()=>{})

 const keys=[{version:'test',key:'synthetic-only-maintenance-hmac-key'}]
 const cleanupConfig=()=>({...config,tombstoneHmacKeys:keys}) satisfies ForwardCleanupConfig
 async function source(name:string){
  await sql("INSERT INTO public.sessions VALUES($1,1,'daemon','codex','hot','codex')",[name]);await sql('INSERT INTO public.deleted_sessions VALUES($1)',[name])
  await sql('INSERT INTO memory.source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES($1,$2,now(),now())',[installation,name])
  await sql("INSERT INTO memory.source_events(source_event_id,installation_id,origin,origin_position,session_id,event_type,occurred_at,payload,payload_hash) VALUES(gen_random_uuid(),$1,'feed',$2,$2,'test',now(),'{\"text\":\"private source body\"}',decode(repeat('ab',32),'hex'))",[installation,name])
 }
 async function plan(){await fixtureDrained();const overlay=await planPrivacyOverlay(config,options);await applyPrivacyOverlay(config,overlay,options);await fixtureDrained();return planForwardCleanup(cleanupConfig(),overlay,options)}

 test('typed event/artifact dependency removes only other Session derived episode and source-only claim',async()=>{
  await source('exact-root');const event=(await sql("SELECT source_event_id::text AS id FROM memory.source_events WHERE session_id='exact-root'")).rows[0].id
  const episode=randomUUID(),independent=randomUUID(),artifact=randomUUID(),claim=randomUUID(),version=randomUUID()
  await sql("INSERT INTO memory.source_artifacts(artifact_id,installation_id,session_id,source_event_id,artifact_type,identity_key,details,occurred_at) VALUES($1,$2,'exact-root',$3,'other',$1::uuid::text,'{}',now())",[artifact,installation,event])
  for(const [id,manifest] of [[episode,{h0:{kind:'artifact',evidence_role:'substantive',excerpt_hash:'a'.repeat(64),excerpt_length:9,truncated:false,source_event_id:event,artifact_id:artifact}}],[independent,{}]])await sql("INSERT INTO memory.work_episodes(installation_id,episode_id,session_id,turn_id,state,compiler_version,document_compiler_version,document,evidence_manifest) VALUES($1,$2,'session',$2::uuid::text,'ready','test','memory-episode-packet-v6',$3,$4)",[installation,id,{sensitive:'derived'},manifest])
  await sql("INSERT INTO memory.source_events(source_event_id,installation_id,origin,origin_position,session_id,event_type,occurred_at,payload,payload_hash) VALUES(gen_random_uuid(),$1,'feed','independent-exact','session','test',now(),'{\"text\":\"independent raw\"}',sha256('raw'))",[installation])
  await sql("INSERT INTO memory.knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state) VALUES($1,$2,'test_invariant','installation','',$1::uuid::text,'active')",[claim,installation]);await sql("INSERT INTO memory.knowledge_versions(version_id,installation_id,claim_id,version_number,statement,authority,confidence) VALUES($1,$2,$3,1,'source dependent','user_accepted',1)",[version,installation,claim]);await sql('UPDATE memory.knowledge_claims SET current_version_id=$2 WHERE claim_id=$1',[claim,version])
  await sql("INSERT INTO memory.knowledge_evidence(evidence_id,installation_id,version_id,episode_id,evidence_kind,artifact_id,source_event_id,excerpt,excerpt_hash,occurred_at,ordinal) VALUES(gen_random_uuid(),$1,$2,$3,'artifact',$4,$5,'source dependent',sha256('source dependent'),now(),0)",[installation,version,episode,artifact,event])
  const raw=JSON.stringify((await sql("SELECT row_to_json(t) AS value FROM memory.source_events t WHERE session_id='session'")).rows),other=JSON.stringify((await sql('SELECT row_to_json(t) AS value FROM memory.work_episodes t WHERE episode_id=$1',[independent])).rows)
  const p=await plan();expect(p.dependencies.linked!.version).toBe(3)
  const {manifestHash:_,...body}=p,unsupported=seal({...body,dependencies:{...p.dependencies,linked:{...p.dependencies.linked!,exactSources:{...p.dependencies.linked!.exactSources!,version:99}}}}) as unknown as typeof p
  for(const operation of [applyForwardCleanup,verifyForwardCleanup])await expect(operation(cleanupConfig(),unsupported,options)).rejects.toThrow('cleanup_exact_source_policy_version_unsupported');expect(await checkpointCount(unsupported.manifestHash)).toBe(0)
  await expect(applyForwardCleanup(cleanupConfig(),p,{...options,afterCommit:async()=>{throw Error('exact_lost_commit')}})).rejects.toThrow('exact_lost_commit')
  const prefix=await checkpointCount(p.manifestHash);expect(prefix).toBe(1)
  await applyForwardCleanup(cleanupConfig(),p,options)
  expect((await sql("SELECT count(*)::int AS n FROM memory.work_episodes WHERE episode_id=$1 AND(state<>'invalidated' OR document<>'{}'::jsonb OR evidence_manifest<>'{}'::jsonb OR summary<>'{}'::jsonb)",[episode])).rows[0].n).toBe(0);expect((await sql('SELECT count(*)::int AS n FROM memory.knowledge_claims WHERE claim_id=$1',[claim])).rows[0].n).toBe(0)
  expect(JSON.stringify((await sql("SELECT row_to_json(t) AS value FROM memory.source_events t WHERE session_id='session'")).rows)).toBe(raw);expect(JSON.stringify((await sql('SELECT row_to_json(t) AS value FROM memory.work_episodes t WHERE episode_id=$1',[independent])).rows)).toBe(other)
  expect((await sql("SELECT count(*)::int AS n FROM memory.memory_session_tombstones WHERE session_id='session'")).rows[0].n).toBe(0)
  expect((await verifyForwardCleanup(cleanupConfig(),p,options)).privacyCatchupReadyForReopen).toBe(true)
 },30000)
 function manifest(event:string){return {e1:{kind:'event',evidence_role:'substantive',source_event_id:event,excerpt_hash:'b'.repeat(64),excerpt_length:20,truncated:false}}}
 async function eventFor(name:string){await source(name);return(await sql('SELECT source_event_id::text AS id FROM memory.source_events WHERE session_id=$1',[name])).rows[0].id as string}
 async function episodeFor(event:string,extra:Record<string,unknown>={}){const id=randomUUID();await sql("INSERT INTO memory.work_episodes(installation_id,episode_id,session_id,turn_id,state,outcome,compiler_version,document_compiler_version,source_digest,document,evidence_manifest) VALUES($1,$2,'session',$2::uuid::text,'ready','completed','test','memory-episode-packet-v6',sha256('original audit digest'),$3,$4)",[installation,id,{body:'derived private',...extra},manifest(event)]);return id}
 test('JSON-only source handles trigger invalidation and a late typed edge cannot widen apply verify or resume',async()=>{
  const event=await eventFor('json-exact-root'),episode=await episodeFor(event),late=await episodeFor(event);await sql("UPDATE memory.work_episodes SET evidence_manifest='{}' WHERE episode_id=$1",[late]);const p=await plan();expect(p.schemaVersion).toBe(3)
  await sql('UPDATE memory.work_episodes SET evidence_manifest=$2 WHERE episode_id=$1',[late,manifest(event)])
  for(const operation of [applyForwardCleanup,verifyForwardCleanup,applyForwardCleanup])await expect(operation(cleanupConfig(),p,options)).rejects.toThrow('cleanup_exact_source_dependency_drift')
  expect(await checkpointCount(p.manifestHash)).toBe(0)
  await sql("UPDATE memory.work_episodes SET evidence_manifest='{}' WHERE episode_id=$1",[late]);const fresh=await plan();await applyForwardCleanup(cleanupConfig(),fresh,options)
  expect((await sql('SELECT state,document,evidence_manifest FROM memory.work_episodes WHERE episode_id=$1',[episode])).rows[0]).toEqual({state:'invalidated',document:{},evidence_manifest:{}})
  // The original immutable source UUID remains a root after its own deletion.
  await sql('UPDATE memory.work_episodes SET evidence_manifest=$2 WHERE episode_id=$1',[late,manifest(event)])
  await expect(verifyForwardCleanup(cleanupConfig(),fresh,options)).rejects.toThrow('cleanup_exact_source_dependency_drift');await expect(applyForwardCleanup(cleanupConfig(),fresh,options)).rejects.toThrow('cleanup_exact_source_dependency_drift');await sql('DELETE FROM memory.work_episodes WHERE episode_id=$1',[late])
 },30000)
 test.each(['unknown_json','unknown_packet','unknown_provenance','cross_owner','duplicate_episode_owner'] as const)('refuses %s before writes and preserves original bodies',async scenario=>{
  const event=await eventFor('negative-'+scenario),episode=await episodeFor(event)
  if(scenario==='unknown_json')await sql('UPDATE memory.work_episodes SET document=$2 WHERE episode_id=$1',[episode,{unparsed:{source_event_id:event}}])
  if(scenario==='unknown_packet')await sql("UPDATE memory.work_episodes SET document_compiler_version='future-unknown' WHERE episode_id=$1",[episode])
  if(scenario==='unknown_provenance')await sql("UPDATE memory.work_episodes SET evidence_manifest=jsonb_set(evidence_manifest,'{e1,source_provenance}','{\"untrusted\":true}') WHERE episode_id=$1",[episode])
  if(scenario==='cross_owner'||scenario==='duplicate_episode_owner'){
   const other=randomUUID();await sql("INSERT INTO memory.memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[other]);await sql("INSERT INTO memory.source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES($1,'session',now(),now())",[other]);if(scenario==='cross_owner')await sql('UPDATE memory.work_episodes SET installation_id=$2 WHERE episode_id=$1',[episode,other]);else await sql("INSERT INTO memory.work_episodes(installation_id,episode_id,session_id,turn_id,state,compiler_version) VALUES($1,$2,'session',$2::uuid::text,'ready','test')",[other,episode])
  }
  const before=JSON.stringify((await sql('SELECT row_to_json(t) AS value FROM memory.work_episodes t WHERE episode_id=$1',[episode])).rows)
  const reason={unknown_json:'cleanup_exact_source_unknown_reference_metadata',unknown_packet:'cleanup_exact_source_packet_version_unsupported',unknown_provenance:'cleanup_exact_source_provenance_requires_authority_adapter',cross_owner:'cleanup_exact_source_cross_owner_unproven',duplicate_episode_owner:'cleanup_exact_source_ambiguous_episode_owner'}[scenario]
  await expect(plan()).rejects.toThrow(reason);expect(JSON.stringify((await sql('SELECT row_to_json(t) AS value FROM memory.work_episodes t WHERE episode_id=$1',[episode])).rows)).toBe(before)
  expect((await sql('SELECT count(*)::int AS n FROM memory.source_events WHERE source_event_id=$1',[event])).rows[0].n).toBe(1);await sql('DELETE FROM memory.work_episodes WHERE episode_id=$1',[episode])
 },30000)
 test('cross-Session Skill invalidation retains actual unknown attempt generation reservation and usage linkage',async()=>{
  const event=await eventFor('skill-exact-root'),episode=await episodeFor(event),repository=randomUUID(),snapshot=randomUUID(),archive=randomUUID(),task=randomUUID(),generation=randomUUID(),taskRun=randomUUID()
  await sql('INSERT INTO memory.repositories(installation_id,repository_id,repository_key,first_observed_at,last_observed_at) VALUES($1,$2,$2::uuid::text,now(),now())',[installation,repository]);await sql("INSERT INTO memory.repo_snapshots(installation_id,repository_id,repo_snapshot_id,commit_sha,observed_at) VALUES($1,$2,$3,repeat('a',40),now())",[installation,repository,snapshot]);await sql('UPDATE memory.work_episodes SET repository_id=$2,repo_snapshot_id=$3,source_digest=decode(repeat(\'aa\',32),\'hex\') WHERE episode_id=$1',[episode,repository,snapshot])
  async function archiveFixture(name:string,event:string|null){
   const episode=randomUUID(),archive=randomUUID(),task=randomUUID(),generation=randomUUID(),candidate=randomUUID(),skill=randomUUID(),version=randomUUID(),publication=randomUUID()
   await sql("INSERT INTO memory.work_episodes(installation_id,episode_id,session_id,turn_id,state,outcome,compiler_version,repository_id,repo_snapshot_id,source_digest,evidence_manifest) VALUES($1,$2,$6,$2::uuid::text,'ready','completed','test',$3,$4,decode(repeat('aa',32),'hex'),$5)",[installation,episode,repository,snapshot,{e1:{kind:event?'event':'episode',excerpt_hash:'b'.repeat(16),excerpt_length:20,...(event?{source_event_id:event}:{})}},event?'skill-closure-selected':'session'])
   const c=new pg.Client({connectionString:url});await c.connect()
   try{await c.query('BEGIN');await c.query('SET LOCAL search_path=memory,pg_catalog,shared');
    await c.query("INSERT INTO memory_skill_tasks(task_id,installation_id,repository_id,candidate_key,current_generation,state) VALUES($1,$2,$3,$4,1,'candidate')",[task,installation,repository,name]);
    await c.query("INSERT INTO memory_generation_runs(run_id,installation_id,operation,subject_kind,subject_key_hash,input_digest,effective_policy_hash,state) VALUES($1,$2,'extract_skill_candidate','task',sha256($3),sha256($3),sha256($3),'succeeded')",[generation,installation,name]);
    await c.query("INSERT INTO memory_skill_task_runs(run_id,installation_id,task_id,generation,source_kind,repository_id,repo_snapshot_id,episode_id,source_digest,input_digest,policy_version,owner_scope_kind,authorization_epoch,grant_snapshot,state,generation_run_id) VALUES(gen_random_uuid(),$1,$2,1,'episode',$3,$4,$5,repeat('aa',32),repeat('b',64),'test','personal',1,'{}','candidate',$6)",[installation,task,repository,snapshot,episode,generation]);
    await c.query("INSERT INTO memory_skill_archives(archive_id,installation_id,repository_id,repo_snapshot_id,episode_id,task_id,generation,candidate_key,policy_version,source_digest,input_digest,content_hash,document_hash,document) VALUES($1,$2,$3,$4,$5,$6,1,$7,'test',repeat('aa',32),repeat('b',64),repeat('c',64),repeat('d',64),$8)",[archive,installation,repository,snapshot,episode,task,name,skillFixtureDocument()]);
    await c.query("INSERT INTO memory_skill_archive_sources(installation_id,archive_id,source_token,evidence_handle,excerpt_hash,evidence_kind,source_event_id) VALUES($1,$2,'source-1','e1',repeat('b',16),$3,$4)",[installation,archive,event?'event':'episode',event]);
    await c.query("INSERT INTO memory_skill_candidates(candidate_id,installation_id,task_id,generation,archive_id,generation_run_id,document_hash) VALUES($1,$2,$3,1,$4,$5,repeat('d',64))",[candidate,installation,task,archive,generation]);
    await c.query('INSERT INTO memory_skills(skill_id,installation_id,task_id) VALUES($1,$2,$3)',[skill,installation,task]);
    await c.query("INSERT INTO memory_skill_versions(version_id,installation_id,skill_id,version_number,candidate_id,archive_id,document,document_hash,source_digest,archive_content_hash,policy_snapshot,policy_hash,risk,author_kind,author_id,authorization_epoch) VALUES($1,$2,$3,1,$4,$5,$6,repeat('d',64),repeat('aa',32),repeat('c',64),'{}',repeat('e',64),'low','personal',$2,1)",[version,installation,skill,candidate,archive,skillFixtureDocument()]);
    await c.query("INSERT INTO memory_skill_heads(installation_id,skill_id,current_version_id,revision,state) VALUES($1,$2,$3,1,'reviewed')",[installation,skill,version]);
    await c.query("INSERT INTO memory_skill_publication_events(event_id,installation_id,skill_id,version_id,revision,mode,provenance,actor_kind,actor_id,authorization_epoch,policy_hash,replay_run_id) VALUES($1,$2,$3,$4,1,'manual','fixture','personal',$2,1,repeat('e',64),gen_random_uuid())",[publication,installation,skill,version]);
    await c.query("INSERT INTO memory_skill_publication_heads(installation_id,skill_id,current_version_id,revision,state,publication_event_id) VALUES($1,$2,$3,1,'active',$4)",[installation,skill,version,publication]);
    await c.query('COMMIT')
   }catch(e){await c.query('ROLLBACK');throw e}finally{await c.end()}
   return {episode,archive,task,generation,candidate,skill,version}
  }
  const kept=await archiveFixture('independent-published-cross-source',null)
  const keptState=async()=>JSON.stringify((await sql('SELECT (SELECT to_jsonb(t) FROM memory.memory_skill_versions t WHERE version_id=$1) AS version,(SELECT to_jsonb(t) FROM memory.memory_skill_archives t WHERE archive_id=$2) AS archive,(SELECT to_jsonb(t) FROM memory.memory_skill_publication_heads t WHERE skill_id=$3) AS publication',[kept.version,kept.archive,kept.skill])).rows)
  const keptBefore=await keptState()
  const unknown=await reserveUnknownBudget('cross-source-unknown'),reservation=(await sql("SELECT reservation_id FROM memory.memory_provider_budget_reservations WHERE budget_key='cross-source-unknown'")).rows[0].reservation_id
  const c=new pg.Client({connectionString:url});await c.connect()
  try{await c.query('BEGIN');await c.query('SET LOCAL search_path=memory,pg_catalog,shared');
   await c.query("INSERT INTO memory_skill_tasks(task_id,installation_id,repository_id,candidate_key,current_generation,state) VALUES($1,$2,$3,'cross-source',1,'running')",[task,installation,repository]);
   await c.query("INSERT INTO memory_generation_runs(run_id,installation_id,operation,subject_kind,subject_key_hash,input_digest,effective_policy_hash,state,error_code,input_tokens,output_tokens,cost_micros) VALUES($1,$2,'extract_skill_candidate','task',sha256('cross-source'),sha256('cross-source'),sha256('cross-source'),'failed','provider_result_unknown',37,19,71)",[generation,installation]);
   await c.query("INSERT INTO memory_skill_task_runs(run_id,installation_id,task_id,generation,source_kind,repository_id,repo_snapshot_id,episode_id,source_digest,input_digest,policy_version,owner_scope_kind,authorization_epoch,grant_snapshot,state,generation_run_id,budget_reservation_id,error_code) VALUES($1,$2,$3,1,'episode',$4,$5,$6,repeat('aa',32),repeat('b',64),'test','personal',1,'{}','failed',$7,$8,'provider_result_unknown')",[taskRun,installation,task,repository,snapshot,episode,generation,reservation]);
   await c.query("INSERT INTO memory_skill_archives(archive_id,installation_id,repository_id,repo_snapshot_id,episode_id,task_id,generation,candidate_key,policy_version,source_digest,input_digest,content_hash,document_hash,document) VALUES($1,$2,$3,$4,$5,$6,1,'cross-source','test',repeat('aa',32),repeat('b',64),repeat('c',64),repeat('d',64),$7)",[archive,installation,repository,snapshot,episode,task,skillFixtureDocument()]);await c.query("INSERT INTO memory_skill_archive_sources(installation_id,archive_id,source_token,evidence_handle,excerpt_hash,evidence_kind,source_event_id) VALUES($1,$2,'source-1','e1',repeat('b',64),'event',$3)",[installation,archive,event]);
   await c.query("INSERT INTO memory_usage_outbox(installation_id,usage_id,operation,model,input_tokens,output_tokens,cost_micros,occurred_at) VALUES($1,$2,'extract_skill_candidate','synthetic-model',37,19,71,now())",[installation,'generation:'+generation]);await c.query('COMMIT')
  }catch(e){await c.query('ROLLBACK');throw e}finally{await c.end()}
  const saved=async()=>JSON.stringify((await sql(`SELECT (SELECT to_jsonb(t) FROM memory.memory_skill_task_runs t WHERE run_id=$1) AS attempt,(SELECT to_jsonb(t) FROM memory.memory_generation_runs t WHERE run_id=$2) AS generation,(SELECT to_jsonb(t) FROM memory.memory_provider_budget_reservations t WHERE reservation_id=$3) AS reservation,(SELECT to_jsonb(t) FROM memory.memory_usage_outbox t WHERE usage_id=$4) AS outbox`,[taskRun,generation,reservation,'generation:'+generation])).rows)
  const before=await saved(),p=await plan();await applyForwardCleanup(cleanupConfig(),p,options);expect(await saved()).toBe(before);await assertUnknownBudget(unknown);expect(await keptState()).toBe(keptBefore)
  expect((await sql('SELECT count(*)::int AS n FROM memory.memory_skill_archives WHERE archive_id=$1',[archive])).rows[0].n).toBe(0)
  expect((await sql('SELECT state FROM memory.work_episodes WHERE episode_id=$1',[episode])).rows[0].state).toBe('invalidated')
 },30000)

 test.each(['same-version','accepted-only-replacement'] as const)('retains actual independent accepted support for %s across derived episode loss',async shape=>{
  const event=await eventFor('accepted-cross-'+shape),episode=await episodeFor(event),claim=randomUUID(),selected=randomUUID(),accepted=shape==='same-version'?selected:randomUUID(),cap=randomUUID(),evidence=randomUUID()
  await sql("INSERT INTO memory.knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state) VALUES($1,$2,'test_invariant','installation','',$1::uuid::text,'active')",[claim,installation])
  for(const [version,number] of [...(accepted===selected?[]:[[accepted,1]]),[selected,2]])await sql("INSERT INTO memory.knowledge_versions(version_id,installation_id,claim_id,version_number,statement,authority,confidence) VALUES($1,$2,$3,$4,$1::uuid::text,'user_accepted',1)",[version,installation,claim,number])
  await sql('UPDATE memory.knowledge_claims SET current_version_id=$2 WHERE claim_id=$1',[claim,selected]);await sql("INSERT INTO memory.knowledge_evidence(evidence_id,installation_id,version_id,episode_id,evidence_kind,source_event_id,excerpt,excerpt_hash,occurred_at,ordinal) VALUES(gen_random_uuid(),$1,$2,$3,'event',$4,'sensitive',sha256('sensitive'),now(),0)",[installation,selected,episode,event])
  await sql("INSERT INTO memory.knowledge_evidence_capsules(capsule_id,installation_id,version_id,retention_basis,source_content_hash) VALUES($1,$2,$3,'user_accepted',sha256('accepted fact'))",[cap,installation,accepted]);await sql("INSERT INTO memory.knowledge_evidence(evidence_id,installation_id,version_id,capsule_id,evidence_kind,excerpt,excerpt_hash,occurred_at,ordinal) VALUES($1,$2,$3,$4,'accepted_excerpt','independent accepted fact',sha256('independent accepted fact'),now(),1)",[evidence,installation,accepted,cap])
  const saved=async()=>JSON.stringify((await sql('SELECT (SELECT to_jsonb(t) FROM memory.knowledge_versions t WHERE version_id=$1) AS version,(SELECT to_jsonb(t) FROM memory.knowledge_evidence t WHERE evidence_id=$2) AS evidence,(SELECT to_jsonb(t) FROM memory.knowledge_evidence_capsules t WHERE capsule_id=$3) AS capsule',[accepted,evidence,cap])).rows)
  const before=await saved(),p=await plan();await applyForwardCleanup(cleanupConfig(),p,options);expect(await saved()).toBe(before);expect((await sql('SELECT current_version_id FROM memory.knowledge_claims WHERE claim_id=$1',[claim])).rows[0].current_version_id).toBe(accepted)
  expect((await sql('SELECT count(*)::int AS n FROM memory.knowledge_evidence WHERE episode_id=$1',[episode])).rows[0].n).toBe(0)
 },30000)
 test('ignores huge unrelated raw sources but refuses the actual affected episode bound',async()=>{
  await sql("INSERT INTO memory.source_events(source_event_id,installation_id,origin,origin_position,session_id,event_type,occurred_at,payload,payload_hash) SELECT gen_random_uuid(),$1,'feed','exact-unrelated-'||n,'session','test',now(),'{\"text\":\"unrelated\"}',sha256('unrelated') FROM generate_series(1,1600)n",[installation])
  const event=await eventFor('actual-exact-bound'),episode=await episodeFor(event),p=await plan();expect(p.initialState.find(t=>t.table==='source_events')!.rows).toBe(1)
  await sql("INSERT INTO memory.work_episodes(installation_id,episode_id,session_id,turn_id,state,compiler_version,document_compiler_version,evidence_manifest) SELECT $1,id,'session',id::text,'ready','test','memory-episode-packet-v6',$2 FROM(SELECT gen_random_uuid() AS id FROM generate_series(1,1025)) t",[installation,manifest(event)])
  await expect(plan()).rejects.toThrow('cleanup_exact_source_row_bound_exceeded:work_episodes');expect((await sql('SELECT count(*)::int AS n FROM memory.source_events WHERE source_event_id=$1',[event])).rows[0].n).toBe(1)
  await sql("DELETE FROM memory.work_episodes WHERE episode_id<>$1 AND evidence_manifest=$2",[episode,manifest(event)]);await applyForwardCleanup(cleanupConfig(),await plan(),options)
  expect((await sql("SELECT count(*)::int AS n FROM memory.source_events WHERE origin_position LIKE 'exact-unrelated-%'")).rows[0].n).toBe(1600)
 },30000)

 test('unreviewed cross-Session lifecycle bundle is a precise refusal before source mutation',async()=>{
  const event=await eventFor('cross-lifecycle-bundle'),bundle=randomUUID()
  await sql("INSERT INTO memory.memory_task_bundles(installation_id,bundle_id,task_key,session_id,source_digest,watermark) VALUES($1,$2,$2::uuid::text,'session',sha256('original source digest'),1)",[installation,bundle]);await sql("INSERT INTO memory.memory_task_bundle_sources(installation_id,bundle_id,source_event_id,source_digest,source_sequence) VALUES($1,$2,$3,sha256('original source digest'),1)",[installation,bundle,event])
  const before=JSON.stringify((await sql('SELECT row_to_json(t) AS value FROM memory.memory_task_bundles t WHERE bundle_id=$1',[bundle])).rows)
  await expect(plan()).rejects.toThrow('cleanup_exact_source_cross_session_bundle_requires_policy');expect(JSON.stringify((await sql('SELECT row_to_json(t) AS value FROM memory.memory_task_bundles t WHERE bundle_id=$1',[bundle])).rows)).toBe(before);expect((await sql('SELECT count(*)::int AS n FROM memory.source_events WHERE source_event_id=$1',[event])).rows[0].n).toBe(1)
 },30000)

})
