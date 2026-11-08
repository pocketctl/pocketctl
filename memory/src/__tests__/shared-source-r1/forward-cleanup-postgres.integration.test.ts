import {installNativeAliasFixture} from './native-alias-fixture.js'
import {seal} from '../../migrations/shared-forward/source-maintenance-common.js'
import {createProviderBudgetStore} from '../../model/provider-budget.js'
import {createPurgeRepository} from '../../purge/repository.js'
import {skillFixtureDocument} from '../../testing/skill-fixture.js'
import {mkdtemp,writeFile,stat,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {main} from '../../migrations/shared-forward/source-maintenance-cli.js'
import {randomUUID} from 'node:crypto'
import {retainedSourceRead} from '../../sources/retained-read.js'
import {guardRetainedVersions} from '../../sources/retained-versions.js'
import pg from 'pg'
import {planForwardCleanup,applyForwardCleanup,verifyForwardCleanup,type ForwardCleanupConfig} from '../../migrations/shared-forward/forward-cleanup.js'
import {createScopeAuthorization} from '../../governance/authorization.js'
import {createMemoryPool} from '../../db.js'
import {afterAll,beforeAll,beforeEach,describe,expect,test,vi} from 'vitest'
import {applyMemorySchema} from '../../schema.js'
import {applySharedSourceContract} from '../../migrations/shared-db/contract.js'
import {planPrivacyOverlay as rawPlanPrivacyOverlay,applyPrivacyOverlay as rawApplyPrivacyOverlay,verifyPrivacyOverlay as rawVerifyPrivacyOverlay,type PrivacyOverlayConfig} from '../../migrations/shared-forward/privacy-overlay.js'
const url=process.env.SHARED_W4_CLEANUP_TEST_DATABASE_URL!,suite=url?describe:describe.skip
const installation='10000000-0000-0000-0000-000000000064',submission='20000000-0000-0000-0000-000000000064',decision='30000000-0000-0000-0000-000000000064'
suite('bounded actual forward privacy cleanup',()=>{
 let config:PrivacyOverlayConfig,capsule:string,sentinel:string
 const schemaSeeds:{table:string;columns:string[];rows:string}[]=[]
 const quote=(identifier:string)=>'"'+identifier.replaceAll('"','""')+'"'
 const probe=async()=>({api:{LoadState:'loaded',ActiveState:'inactive',SubState:'dead',MainPID:'0'},worker:{LoadState:'loaded',ActiveState:'inactive',SubState:'dead',MainPID:'0'},observedAt:new Date().toISOString()})
 const options={probe}
 async function fixtureDrained(attempts=100){
  const monitorUrl=new URL(url!);monitorUrl.pathname='/postgres';const monitor=new pg.Client({connectionString:monitorUrl.toString()});await monitor.connect()
  try{for(let attempt=0;attempt<attempts;attempt++){if(!(await monitor.query('SELECT 1 FROM pg_stat_activity WHERE datname=$1 LIMIT 1',[new URL(url!).pathname.slice(1)])).rowCount)return;await new Promise(resolve=>setTimeout(resolve,20))}throw Error('owned_fixture_backend_not_drained')}finally{await monitor.end()}
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
  for(const s of ['session'])await pool.query('INSERT INTO memory.source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES($1,$2,now(),now())',[installation,s])
  const claim=(await pool.query(`INSERT INTO memory.knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state) VALUES(gen_random_uuid(),$1::uuid,'repository_convention','installation',$1::text,'accepted','active') RETURNING claim_id::text`,[installation])).rows[0].claim_id
  const version=(await pool.query(`INSERT INTO memory.knowledge_versions(version_id,installation_id,claim_id,version_number,statement,authority,confidence,freshness_at) VALUES(gen_random_uuid(),$1,$2,1,'accepted survives','user_accepted',0.9,now()) RETURNING version_id::text`,[installation,claim])).rows[0].version_id
  await pool.query(`INSERT INTO memory.knowledge_evidence_capsules(capsule_id,installation_id,version_id,retention_basis,source_content_hash) VALUES(gen_random_uuid(),$1,$2,'user_accepted',decode(repeat('ab',32),'hex'))`,[installation,version])
  capsule=JSON.stringify((await pool.query('SELECT row_to_json(c)::text FROM memory.knowledge_evidence_capsules c')).rows)
  sentinel=JSON.stringify((await pool.query('TABLE public.canonical_sentinel')).rows)
  const expected=(await pool.query(`SELECT current_database() AS database,current_user AS role,d.oid::text AS "databaseOid",inet_server_addr()::text AS "serverAddress",inet_server_port()::text AS "serverPort" FROM pg_database d WHERE datname=current_database()`)).rows[0]
  config={database:{url,expected},installationIds:[installation],units:{api:'synthetic-api.service',worker:'synthetic-worker.service',freshInstall:false}}
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
 test('already applied tombstone still requires physical purge and preserves accepted ownership',async()=>{
  await source('deleted-body');const p=await plan()
  await applyForwardCleanup(cleanupConfig(),p,options)
  expect((await sql("SELECT count(*)::int AS n FROM memory.source_events WHERE session_id='deleted-body'")).rows[0].n).toBe(0)
  expect(JSON.stringify((await sql('SELECT row_to_json(c)::text FROM memory.knowledge_evidence_capsules c')).rows)).toBe(capsule)
  expect(JSON.stringify((await sql('TABLE public.canonical_sentinel')).rows)).toBe(sentinel)
  expect((await verifyForwardCleanup(cleanupConfig(),p,options)).privacyCatchupReadyForReopen).toBe(true)
 },30000)

 test('same-version independent accepted excerpt and capsule survive selected episode raw purge',async()=>{
  await source('same-version-independent-accepted');const episode=randomUUID(),claim=randomUUID(),version=randomUUID(),acceptedCapsule=randomUUID(),acceptedEvidence=randomUUID()
  await sql("INSERT INTO memory.work_episodes(installation_id,episode_id,session_id,turn_id,state,compiler_version) VALUES($1,$2,'same-version-independent-accepted',$2::uuid::text,'ready','test')",[installation,episode]);
  await sql("INSERT INTO memory.knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state) VALUES($1,$2::uuid,'test_invariant','installation',$2::text,'independent-accepted-same-version','active')",[claim,installation]);
  await sql("INSERT INTO memory.knowledge_versions(version_id,installation_id,claim_id,version_number,statement,authority,confidence) VALUES($1,$2,$3,1,'independently accepted same-version fact','user_accepted',1)",[version,installation,claim]);
  await sql('UPDATE memory.knowledge_claims SET current_version_id=$2 WHERE claim_id=$1',[claim,version]);
  await sql("INSERT INTO memory.knowledge_evidence(evidence_id,installation_id,version_id,episode_id,evidence_kind,excerpt,excerpt_hash,occurred_at,ordinal) VALUES(gen_random_uuid(),$1,$2,$3,'episode','selected raw episode evidence',sha256('selected raw episode evidence'),now(),0)",[installation,version,episode]);
  await sql("INSERT INTO memory.knowledge_evidence_capsules(capsule_id,installation_id,version_id,retention_basis,source_content_hash) VALUES($1,$2,$3,'user_accepted',decode(repeat('cc',32),'hex'))",[acceptedCapsule,installation,version]);
  await sql("INSERT INTO memory.knowledge_evidence(evidence_id,installation_id,version_id,episode_id,capsule_id,evidence_kind,excerpt,excerpt_hash,source_evidence_hash,occurred_at,ordinal) VALUES($1,$2,$3,NULL,$4,'accepted_excerpt','independently accepted owned excerpt',sha256('independently accepted owned excerpt'),repeat('cc',32),now(),1)",[acceptedEvidence,installation,version,acceptedCapsule]);
  const beforeVersion=JSON.stringify((await sql('SELECT row_to_json(v) AS value FROM memory.knowledge_versions v WHERE version_id=$1',[version])).rows),beforeCapsule=JSON.stringify((await sql('SELECT row_to_json(c) AS value FROM memory.knowledge_evidence_capsules c WHERE capsule_id=$1',[acceptedCapsule])).rows),beforeEvidence=JSON.stringify((await sql('SELECT row_to_json(e) AS value FROM memory.knowledge_evidence e WHERE evidence_id=$1',[acceptedEvidence])).rows)
  const budgetInput=await reserveUnknownBudget('same-version-independent-budget'),budgetBefore=JSON.stringify((await sql('TABLE memory.memory_provider_budget_reservations')).rows)
  const p=await plan();expect(p.schemaVersion).toBe(2);expect(p.dependencies.linked!.version).toBe(2);expect(p.dependencies.linked!.removableCapsuleIds).toEqual([])
  const {manifestHash:_,...body}=p,legacy=seal({...body,dependencies:{...p.dependencies,linked:{...p.dependencies.linked!,version:1}}}) as unknown as typeof p
  await expect(applyForwardCleanup(cleanupConfig(),legacy,options)).rejects.toThrow('cleanup_linked_manifest_version_unsupported');await expect(verifyForwardCleanup(cleanupConfig(),legacy,options)).rejects.toThrow('cleanup_linked_manifest_version_unsupported');expect(await checkpointCount(legacy.manifestHash)).toBe(0)
  await expect(applyForwardCleanup(cleanupConfig(),p,{...options,afterCommit:async ordinal=>{const step=p.steps[ordinal];if(step.kind==='session'&&step.sessionId==='same-version-independent-accepted')throw Error('same_version_lost_commit_response')}})).rejects.toThrow('same_version_lost_commit_response')
  const result=await applyForwardCleanup(cleanupConfig(),p,options);expect(result.privacyCatchupReadyForReopen).toBe(true)
  const actual=(await sql(`SELECT
   (SELECT count(*)::int FROM memory.source_events WHERE installation_id=$1 AND session_id='same-version-independent-accepted') AS raw,
   (SELECT count(*)::int FROM memory.work_episodes WHERE episode_id=$2) AS episode,
   (SELECT count(*)::int FROM memory.knowledge_claims WHERE claim_id=$3 AND current_version_id=$4) AS claim,
   (SELECT count(*)::int FROM memory.knowledge_versions WHERE version_id=$4) AS version,
   (SELECT count(*)::int FROM memory.knowledge_evidence_capsules WHERE capsule_id=$5) AS capsule,
   (SELECT count(*)::int FROM memory.knowledge_evidence WHERE evidence_id=$6) AS accepted_evidence`,[installation,episode,claim,version,acceptedCapsule,acceptedEvidence])).rows[0]
  expect(actual).toEqual({raw:0,episode:0,claim:1,version:1,capsule:1,accepted_evidence:1})
  expect(JSON.stringify((await sql('SELECT row_to_json(v) AS value FROM memory.knowledge_versions v WHERE version_id=$1',[version])).rows)).toBe(beforeVersion)
  expect(JSON.stringify((await sql('SELECT row_to_json(c) AS value FROM memory.knowledge_evidence_capsules c WHERE capsule_id=$1',[acceptedCapsule])).rows)).toBe(beforeCapsule)
  expect(JSON.stringify((await sql('SELECT row_to_json(e) AS value FROM memory.knowledge_evidence e WHERE evidence_id=$1',[acceptedEvidence])).rows)).toBe(beforeEvidence)
  const committed=JSON.stringify((await sql("SELECT row_to_json(s) AS value FROM memory.source_sessions s WHERE installation_id=$1 AND session_id='same-version-independent-accepted'",[installation])).rows);await applyForwardCleanup(cleanupConfig(),p,options);expect(JSON.stringify((await sql("SELECT row_to_json(s) AS value FROM memory.source_sessions s WHERE installation_id=$1 AND session_id='same-version-independent-accepted'",[installation])).rows)).toBe(committed)
  await assertUnknownBudget(budgetInput);expect(JSON.stringify((await sql('TABLE memory.memory_provider_budget_reservations')).rows)).toBe(budgetBefore)
 },30000)

 test('accepted-only replacement stays owned through raw cleanup and globally withdrawn Team v2 remains unavailable',async()=>{
  const session='accepted-only-replacement';await source(session)
  const episode=randomUUID(),claim=randomUUID(),oldVersion=randomUUID(),selectedVersion=randomUUID(),cap=randomUUID(),acceptedEvidence=randomUUID(),submissionId=randomUUID(),decisionId=randomUUID()
  await sql("INSERT INTO memory.work_episodes(installation_id,episode_id,session_id,turn_id,state,compiler_version) VALUES($1,$2,$3,$2::uuid::text,'ready','test')",[installation,episode,session]);await sql("INSERT INTO memory.knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state) VALUES($1,$2,'test_invariant','installation','',$1::uuid::text,'active')",[claim,installation])
  for(const [version,number,statement] of [[oldVersion,1,'independent accepted-only replacement'],[selectedVersion,2,'source-only current version']])await sql("INSERT INTO memory.knowledge_versions(version_id,installation_id,claim_id,version_number,statement,authority,confidence) VALUES($1,$2,$3,$4,$5,'user_accepted',1)",[version,installation,claim,number,statement])
  await sql('UPDATE memory.knowledge_claims SET current_version_id=$2 WHERE claim_id=$1',[claim,selectedVersion]);await sql("INSERT INTO memory.knowledge_evidence(evidence_id,installation_id,version_id,episode_id,evidence_kind,excerpt,excerpt_hash,occurred_at,ordinal) VALUES(gen_random_uuid(),$1,$2,$3,'episode','source-only current evidence',sha256('source-only current evidence'),now(),0)",[installation,selectedVersion,episode]);
  await sql("INSERT INTO memory.knowledge_evidence_capsules(capsule_id,installation_id,version_id,retention_basis,source_content_hash) VALUES($1,$2,$3,'user_accepted',sha256('accepted-only ownership'))",[cap,installation,oldVersion]);await sql("INSERT INTO memory.knowledge_evidence(evidence_id,installation_id,version_id,capsule_id,evidence_kind,excerpt,excerpt_hash,occurred_at,ordinal) VALUES($1,$2,$3,$4,'accepted_excerpt','accepted-only replacement evidence',sha256('accepted-only replacement evidence'),now(),0)",[acceptedEvidence,installation,oldVersion,cap])
  const capsuleBefore=JSON.stringify((await sql('SELECT row_to_json(c) AS value FROM memory.knowledge_evidence_capsules c WHERE capsule_id=$1',[cap])).rows),versionBefore=JSON.stringify((await sql('SELECT row_to_json(v) AS value FROM memory.knowledge_versions v WHERE version_id=$1',[oldVersion])).rows),budgetInput=await reserveUnknownBudget('accepted-only-replacement-budget'),budgetBefore=JSON.stringify((await sql('TABLE memory.memory_provider_budget_reservations')).rows)
  const p=await plan();expect(p.dependencies.linked!.removableCapsuleIds).toEqual([])
  await expect(applyForwardCleanup(cleanupConfig(),p,{...options,afterCommit:async ordinal=>{const step=p.steps[ordinal];if(step.kind==='session'&&step.sessionId===session)throw Error('accepted_replacement_lost_commit_response')}})).rejects.toThrow('accepted_replacement_lost_commit_response')
  await applyForwardCleanup(cleanupConfig(),p,options);expect((await sql('SELECT current_version_id::text AS id FROM memory.knowledge_claims WHERE claim_id=$1',[claim])).rows[0].id).toBe(oldVersion);expect((await sql('SELECT count(*)::int AS n FROM memory.knowledge_versions WHERE version_id=$1',[selectedVersion])).rows[0].n).toBe(0)
  expect(JSON.stringify((await sql('SELECT row_to_json(c) AS value FROM memory.knowledge_evidence_capsules c WHERE capsule_id=$1',[cap])).rows)).toBe(capsuleBefore);expect(JSON.stringify((await sql('SELECT row_to_json(v) AS value FROM memory.knowledge_versions v WHERE version_id=$1',[oldVersion])).rows)).toBe(versionBefore)
  const beforeRetry=JSON.stringify((await sql('SELECT row_to_json(s) AS value FROM memory.source_sessions s WHERE installation_id=$1 AND session_id=$2',[installation,session])).rows);await applyForwardCleanup(cleanupConfig(),p,options);expect(JSON.stringify((await sql('SELECT row_to_json(s) AS value FROM memory.source_sessions s WHERE installation_id=$1 AND session_id=$2',[installation,session])).rows)).toBe(beforeRetry)
  const read=async()=>{const runtime=createMemoryPool({databaseUrl:url!,databaseNamespace:'memory',dbPoolMax:1});try{return await retainedSourceRead(runtime,{installationId:installation,authorityGrant:{installationId:installation,configVersion:'1',userId:1}},async db=>{await guardRetainedVersions(db,installation,[oldVersion],{requireAvailable:true,requireCurrent:true});return true})}finally{await runtime.end()}}
  expect(await read()).toBe(true)
  await sql('UPDATE memory.knowledge_evidence SET locator=$2 WHERE evidence_id=$1',[acceptedEvidence,{source_provenance:{source_kind:'team_session',source_version:2,team_id:'accepted-only-team',team_session_id:'accepted-only-team-session',accepted_delivery:{submission_id:submissionId,decision_id:decisionId}}}]);await ensureDeliveryPrivacyCapture();expect(await read()).toBe(true)
  await sql("INSERT INTO public.team_delivery_memory_withdrawals VALUES('accepted-only-team','accepted-only-team-session',$1,$2)",[submissionId,decisionId]);expect(await read()).toBeUndefined()
  await applyForwardCleanup(cleanupConfig(),await plan(),options);expect(await read()).toBeUndefined();expect((await sql('SELECT count(*)::int AS n FROM memory.knowledge_evidence WHERE evidence_id=$1',[acceptedEvidence])).rows[0].n).toBe(1)
  await assertUnknownBudget(budgetInput);expect(JSON.stringify((await sql('TABLE memory.memory_provider_budget_reservations')).rows)).toBe(budgetBefore)
 },30000)
 test.each(['orphan','mismatched'] as const)('%s capsule does not independently authorize a source-only Version',async kind=>{
  const session='source-only-'+kind;await source(session);const episode=randomUUID(),claim=randomUUID(),version=randomUUID(),otherClaim=randomUUID(),otherVersion=randomUUID(),cap=randomUUID()
  await sql("INSERT INTO memory.work_episodes(installation_id,episode_id,session_id,turn_id,state,compiler_version) VALUES($1,$2,$3,$2::uuid::text,'ready','test')",[installation,episode,session]);await sql("INSERT INTO memory.knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state) VALUES($1,$2,'test_invariant','installation','',$1::uuid::text,'active')",[claim,installation]);await sql("INSERT INTO memory.knowledge_versions(version_id,installation_id,claim_id,version_number,statement,authority,confidence) VALUES($1,$2,$3,1,'genuinely source-only version','user_accepted',1)",[version,installation,claim]);await sql('UPDATE memory.knowledge_claims SET current_version_id=$2 WHERE claim_id=$1',[claim,version]);await sql("INSERT INTO memory.knowledge_evidence(evidence_id,installation_id,version_id,episode_id,evidence_kind,excerpt,excerpt_hash,occurred_at,ordinal) VALUES(gen_random_uuid(),$1,$2,$3,'episode','genuine source evidence',sha256('genuine source evidence'),now(),0)",[installation,version,episode])
  if(kind==='mismatched'){await sql("INSERT INTO memory.knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state) VALUES($1,$2,'test_invariant','installation','',$1::uuid::text,'active')",[otherClaim,installation]);await sql("INSERT INTO memory.knowledge_versions(version_id,installation_id,claim_id,version_number,statement,authority,confidence) VALUES($1,$2,$3,1,'other independent capsule Version','user_accepted',1)",[otherVersion,installation,otherClaim])}
  await sql("INSERT INTO memory.knowledge_evidence_capsules(capsule_id,installation_id,version_id,retention_basis,source_content_hash) VALUES($1,$2,$3,'user_accepted',sha256('orphan or mismatched capsule'))",[cap,installation,kind==='orphan'?version:otherVersion])
  if(kind==='mismatched')await sql("INSERT INTO memory.knowledge_evidence(evidence_id,installation_id,version_id,capsule_id,evidence_kind,excerpt,excerpt_hash,occurred_at,ordinal) VALUES(gen_random_uuid(),$1,$2,$3,'accepted_excerpt','mismatched accepted relation',sha256('mismatched accepted relation'),now(),1)",[installation,version,cap])
  {
   const before=JSON.stringify((await sql('SELECT row_to_json(v) AS value FROM memory.knowledge_versions v WHERE version_id=ANY($1::uuid[]) ORDER BY version_id',[[version,otherVersion]])).rows)
   const rawBefore=JSON.stringify((await sql('SELECT row_to_json(e) AS value FROM memory.source_events e WHERE session_id=$1',[session])).rows),capBefore=JSON.stringify((await sql('SELECT row_to_json(c) AS value FROM memory.knowledge_evidence_capsules c WHERE capsule_id=$1',[cap])).rows),evidenceBefore=JSON.stringify((await sql('SELECT row_to_json(e) AS value FROM memory.knowledge_evidence e WHERE version_id=$1 ORDER BY evidence_id',[version])).rows)
   await expect(plan().then(()=> 'planned')).rejects.toThrow('independent_accepted_evidence_unproven')
   const runtime=createMemoryPool({databaseUrl:url!,databaseNamespace:'memory',dbPoolMax:1});try{await expect(createPurgeRepository(runtime,{hmacKey:keys[0].key,tombstoneHmacKeys:keys}).purgeSession({installationId:installation,sessionId:session,reason:'user_deleted',sourceFeedId:null})).rejects.toThrow('independent_accepted_evidence_unproven')}finally{await runtime.end()}
   expect((await sql('SELECT count(*)::int AS n FROM memory.source_events WHERE session_id=$1',[session])).rows[0].n).toBe(1);expect(JSON.stringify((await sql('SELECT row_to_json(v) AS value FROM memory.knowledge_versions v WHERE version_id=ANY($1::uuid[]) ORDER BY version_id',[[version,otherVersion]])).rows)).toBe(before)
   expect(JSON.stringify((await sql('SELECT row_to_json(e) AS value FROM memory.source_events e WHERE session_id=$1',[session])).rows)).toBe(rawBefore);expect(JSON.stringify((await sql('SELECT row_to_json(c) AS value FROM memory.knowledge_evidence_capsules c WHERE capsule_id=$1',[cap])).rows)).toBe(capBefore);expect(JSON.stringify((await sql('SELECT row_to_json(e) AS value FROM memory.knowledge_evidence e WHERE version_id=$1 ORDER BY evidence_id',[version])).rows)).toBe(evidenceBefore)
   await sql('DELETE FROM memory.knowledge_claims WHERE claim_id=$1',[claim]);await sql('DELETE FROM memory.knowledge_claims WHERE claim_id=$1',[otherClaim]);await applyForwardCleanup(cleanupConfig(),await plan(),options)
  }
 },30000)

 test('bounded linked knowledge removes selected versions and retains independent evidence and accepted capsule',async()=>{
  await source('linked-knowledge-selected');await sql("INSERT INTO public.sessions VALUES('linked-knowledge-independent',1,'daemon','codex','hot','codex')");
  await sql("INSERT INTO memory.source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES($1,'linked-knowledge-independent',now(),now())",[installation])
  const claim=randomUUID(),removed=randomUUID(),kept=randomUUID(),selectedEpisode=randomUUID(),independentEpisode=randomUUID(),accepted=randomUUID(),orphan=randomUUID(),orphanVersion=randomUUID()
  for(const [episode,session] of [[selectedEpisode,'linked-knowledge-selected'],[independentEpisode,'linked-knowledge-independent']])await sql("INSERT INTO memory.work_episodes(installation_id,episode_id,session_id,turn_id,state,compiler_version) VALUES($1,$2,$3,$2::uuid::text,'ready','test')",[installation,episode,session])
  for(const id of [claim,orphan])await sql("INSERT INTO memory.knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state) VALUES($1,$2::uuid,'test_invariant','installation',$2::text,$1::uuid::text,'active')",[id,installation])
  for(const [version,id,number,episode] of [[kept,claim,1,independentEpisode],[removed,claim,2,selectedEpisode],[orphanVersion,orphan,1,selectedEpisode]]){
   await sql("INSERT INTO memory.knowledge_versions(version_id,installation_id,claim_id,version_number,statement,authority,confidence) VALUES($1,$2,$3,$4,$1::uuid::text,'user_accepted',1)",[version,installation,id,number]);
   await sql("INSERT INTO memory.knowledge_evidence(evidence_id,installation_id,version_id,episode_id,evidence_kind,excerpt,excerpt_hash,occurred_at,ordinal) VALUES(gen_random_uuid(),$1,$2,$3,'episode','linked private excerpt',sha256(convert_to('linked private excerpt','UTF8')),now(),0)",[installation,version,episode]);
   await sql("INSERT INTO memory.claim_search_documents(installation_id,version_id,document) VALUES($1,$2,'linked private index')",[installation,version])
  }
  await sql('UPDATE memory.knowledge_claims SET current_version_id=$2 WHERE claim_id=$1',[claim,removed]);await sql('UPDATE memory.knowledge_claims SET current_version_id=$2 WHERE claim_id=$1',[orphan,orphanVersion]);
  await sql("INSERT INTO memory.knowledge_evidence_capsules(capsule_id,installation_id,version_id,retention_basis,source_content_hash) VALUES($1,$2,$3,'user_accepted',decode(repeat('aa',32),'hex'))",[accepted,installation,kept]);await sql("INSERT INTO memory.knowledge_evidence(evidence_id,installation_id,version_id,capsule_id,evidence_kind,excerpt,excerpt_hash,occurred_at,ordinal) VALUES(gen_random_uuid(),$1,$2,$3,'accepted_excerpt','independently accepted other-Session support',sha256('independently accepted other-Session support'),now(),1)",[installation,kept,accepted]);
  const saved=JSON.stringify((await sql('SELECT row_to_json(v) AS value FROM memory.knowledge_versions v WHERE version_id=$1',[kept])).rows),acceptedSaved=JSON.stringify((await sql('SELECT row_to_json(c) AS value FROM memory.knowledge_evidence_capsules c WHERE capsule_id=$1',[accepted])).rows)
  await sql("INSERT INTO memory.memory_provider_budget_reservations(reservation_id,budget_key,provider_kind,reserved_input_tokens,reserved_output_tokens) VALUES(gen_random_uuid(),'linked-actual-reserved-uncertain','text',123,71)")
  const costs=JSON.stringify((await sql('TABLE memory.memory_provider_budget_reservations')).rows)
  await sql("INSERT INTO memory.source_events(source_event_id,installation_id,origin,origin_position,session_id,event_type,occurred_at,payload,payload_hash) SELECT gen_random_uuid(),$1,'feed','linked-unrelated-'||n,'session','test',now(),'{\"unrelated_body\":true}',sha256('unrelated') FROM generate_series(1,1100)n",[installation])
  const selectedEvidence=(await sql('SELECT evidence_id::text AS id FROM memory.knowledge_evidence WHERE version_id=$1',[removed])).rows[0].id,pack=randomUUID(),untouchedPack=randomUUID(),item=randomUUID()
  for(const id of [pack,untouchedPack])await sql("INSERT INTO memory.memory_context_packs(pack_id,installation_id,session_id,client_request_id,agent,mode,effective_policy_hash,input_digest,state,stable_text) VALUES($1::uuid,$2,'linked-knowledge-independent',$1::text,'codex','enabled',sha256('policy'),sha256('input'),'ready','private context prose')",[id,installation])
  await sql("INSERT INTO memory.memory_context_pack_items(pack_id,item_id,installation_id,claim_id,version_id,claim_type,layer,section,representation,rendered_text,reason_codes,ordinal) VALUES($1,$2,$3,$4,$5,'test_invariant','L2','stable','summary','private selected evidence','{}',0)",[pack,item,installation,claim,removed]);await sql('INSERT INTO memory.memory_context_pack_evidence(pack_id,item_id,installation_id,evidence_id) VALUES($1,$2,$3,$4)',[pack,item,installation,selectedEvidence])
  const p=await plan();expect(p.schemaVersion).toBe(2);expect(p.initialState.find(t=>t.table==='source_events')!.rows).toBe(1)
  await expect(applyForwardCleanup(cleanupConfig(),p,{...options,afterCommit:async step=>{const object=p.steps[step];if(object.kind==='session'&&object.sessionId==='linked-knowledge-selected')throw Error('linked_lost_response')}})).rejects.toThrow('linked_lost_response')
  expect((await sql('SELECT count(*)::int AS n FROM memory.knowledge_versions WHERE version_id=$1',[removed])).rows[0].n).toBe(0)
  await applyForwardCleanup(cleanupConfig(),p,options)
  expect((await sql('SELECT current_version_id::text AS id FROM memory.knowledge_claims WHERE claim_id=$1',[claim])).rows[0].id).toBe(kept)
  expect((await sql('SELECT count(*)::int AS n FROM memory.knowledge_versions WHERE version_id=ANY($1::uuid[])',[[removed,orphanVersion]])).rows[0].n).toBe(0)
  expect((await sql('SELECT count(*)::int AS n FROM memory.knowledge_claims WHERE claim_id=$1',[orphan])).rows[0].n).toBe(0)
  expect((await sql('SELECT count(*)::int AS n FROM memory.claim_search_documents WHERE version_id=ANY($1::uuid[])',[[removed,orphanVersion]])).rows[0].n).toBe(0)
  expect((await sql('SELECT count(*)::int AS n FROM memory.knowledge_tombstones WHERE installation_id=$1',[installation])).rows[0].n).toBeGreaterThan(0)
  expect(JSON.stringify((await sql('SELECT row_to_json(v) AS value FROM memory.knowledge_versions v WHERE version_id=$1',[kept])).rows)).toBe(saved)
  expect(JSON.stringify((await sql('SELECT row_to_json(c) AS value FROM memory.knowledge_evidence_capsules c WHERE capsule_id=$1',[accepted])).rows)).toBe(acceptedSaved)
  expect((await verifyForwardCleanup(cleanupConfig(),p,options)).completedObjects).toBe(p.steps.length)
  expect(JSON.stringify((await sql('TABLE memory.memory_provider_budget_reservations')).rows)).toBe(costs)
  expect((await sql('SELECT count(*)::int AS n FROM memory.memory_context_packs WHERE pack_id=$1',[pack])).rows[0].n).toBe(0);expect((await sql('SELECT count(*)::int AS n FROM memory.memory_context_packs WHERE pack_id=$1',[untouchedPack])).rows[0].n).toBe(1)
  expect((await sql("SELECT count(*)::int AS n FROM memory.source_events WHERE origin_position LIKE 'linked-unrelated-%'")).rows[0].n).toBe(1100)
 },30000)

 test('bounded Skill archive closure cascades sensitive sources and versions while unrelated published Skill survives',async()=>{
  await source('skill-closure-selected');const selectedEvent=(await sql("SELECT source_event_id::text AS id FROM memory.source_events WHERE session_id='skill-closure-selected'")).rows[0].id
  const repository=randomUUID(),snapshot=randomUUID()
  await sql('INSERT INTO memory.repositories(installation_id,repository_id,repository_key,first_observed_at,last_observed_at) VALUES($1,$2,$2::uuid::text,now(),now())',[installation,repository]);await sql("INSERT INTO memory.repo_snapshots(installation_id,repository_id,repo_snapshot_id,commit_sha,observed_at) VALUES($1,$2,$3,repeat('a',40),now())",[installation,repository,snapshot])
  // Restore a legacy archive after the already-applied source barrier, as the
  // cleanup stage must handle retained target rows rather than rerun admission.
  const barrier=await planPrivacyOverlay(config,options);await applyPrivacyOverlay(config,barrier,options)
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
  const kept=await archiveFixture('unaffected-skill',null),narrowBeforeReplay=await plan();expect(narrowBeforeReplay.schemaVersion).toBe(1)
  const keptBefore=JSON.stringify((await sql('SELECT row_to_json(v) AS value FROM memory.memory_skill_versions v WHERE version_id=$1',[kept.version])).rows),publishedBefore=JSON.stringify((await sql('SELECT row_to_json(p) AS value FROM memory.memory_skill_publication_heads p WHERE skill_id=$1',[kept.skill])).rows)
  const replay=randomUUID(),replayClient=new pg.Client({connectionString:url});await replayClient.connect()
  try{await replayClient.query('BEGIN');await replayClient.query('SET LOCAL search_path=memory,pg_catalog');await replayClient.query("INSERT INTO memory_skill_replay_runs(run_id,installation_id,skill_id,version_id,repository_id,repo_snapshot_id,head_revision,idempotency_key,document_hash,source_digest,policy_hash,input_hash,runner_version,actor_kind,actor_id,state,lease_token,lease_expires_at) VALUES($1,$2,$3,$4,$5,$6,1,'legacy-selected-replay',repeat('d',64),repeat('aa',32),repeat('e',64),repeat('f',64),'skill-recorded-replay.v1','personal',$2,'running',gen_random_uuid(),now()+interval '1 hour')",[replay,installation,kept.skill,kept.version,repository,snapshot]);await replayClient.query("INSERT INTO memory_skill_replay_cases(installation_id,run_id,case_id,kind,provenance,reference_id,session_id,input_hash) VALUES($1,$2,'selected-case','historical_session','recorded','skill-closure-selected','skill-closure-selected',repeat('f',64))",[installation,replay]);await replayClient.query("UPDATE memory_skill_replay_cases SET state='passed',assertion_results='[{\"private_replay_body\":\"selected source replay details\"}]' WHERE run_id=$1",[replay]);await replayClient.query('COMMIT')}catch(e){await replayClient.query('ROLLBACK');throw e}finally{await replayClient.end()}
  await expect(applyForwardCleanup(cleanupConfig(),narrowBeforeReplay,options)).rejects.toThrow('cleanup_session_skill_replay_dependency_requires_bounded_adapter')
  await expect(verifyForwardCleanup(cleanupConfig(),narrowBeforeReplay,options)).rejects.toThrow('cleanup_session_skill_replay_dependency_requires_bounded_adapter')
  expect(await checkpointCount(narrowBeforeReplay.manifestHash)).toBe(0)
  const affected=await archiveFixture('affected-skill',selectedEvent)
  const p=await plan();expect(p.schemaVersion).toBe(2);expect(p.dependencies.linked!.rows.memory_skill_versions.some(r=>r.version_id===affected.version)).toBe(true)
  await sql("INSERT INTO memory.memory_skill_rollouts(installation_id,skill_id,revision,state,basis_points) VALUES($1,$2,1,'disabled',0)",[installation,affected.skill])
  await expect(applyForwardCleanup(cleanupConfig(),p,options)).rejects.toThrow('cleanup_linked_dependency_drift:memory_skill_rollouts')
  await expect(verifyForwardCleanup(cleanupConfig(),p,options)).rejects.toThrow('cleanup_linked_dependency_drift:memory_skill_rollouts')
  expect((await sql('SELECT count(*)::int AS n FROM memory.source_events WHERE source_event_id=$1',[selectedEvent])).rows[0].n).toBe(1)
  expect(await checkpointCount(p.manifestHash)).toBe(0)
  await applyForwardCleanup(cleanupConfig(),await plan(),options)
  for(const [table,key,id] of [['memory_skill_archives','archive_id',affected.archive],['memory_skill_versions','version_id',affected.version],['memory_skill_heads','skill_id',affected.skill],['memory_skill_publication_heads','skill_id',affected.skill]])expect((await sql(`SELECT count(*)::int AS n FROM memory.${table} WHERE ${key}=$1`,[id])).rows[0].n).toBe(0)
  expect((await sql('SELECT state FROM memory.memory_skill_tasks WHERE task_id=$1',[affected.task])).rows[0].state).toBe('cancelled')
  expect((await sql('SELECT count(*)::int AS n FROM memory.memory_skill_replay_runs WHERE run_id=$1',[replay])).rows[0].n).toBe(0);expect((await sql('SELECT count(*)::int AS n FROM memory.memory_skill_replay_cases WHERE run_id=$1',[replay])).rows[0].n).toBe(0)
  expect(JSON.stringify((await sql('SELECT row_to_json(v) AS value FROM memory.memory_skill_versions v WHERE version_id=$1',[kept.version])).rows)).toBe(keptBefore)
  expect(JSON.stringify((await sql('SELECT row_to_json(p) AS value FROM memory.memory_skill_publication_heads p WHERE skill_id=$1',[kept.skill])).rows)).toBe(publishedBefore)
 },30000)

 test('new evidence on an existing linked Claim refuses apply and verify before any cleanup',async()=>{
  await source('linked-late-evidence');const episode=randomUUID(),support=randomUUID(),claim=randomUUID(),version=randomUUID()
  for(const [id,session] of [[episode,'linked-late-evidence'],[support,'session']])await sql("INSERT INTO memory.work_episodes(installation_id,episode_id,session_id,turn_id,state,compiler_version) VALUES($1,$2,$3,$2::uuid::text,'ready','test')",[installation,id,session])
  await sql("INSERT INTO memory.knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state) VALUES($1,$2::uuid,'test_invariant','installation',$2::text,$1::uuid::text,'active')",[claim,installation]);await sql("INSERT INTO memory.knowledge_versions(version_id,installation_id,claim_id,version_number,statement,authority,confidence) VALUES($1,$2,$3,1,'late bounded evidence','user_accepted',1)",[version,installation,claim]);await sql('UPDATE memory.knowledge_claims SET current_version_id=$2 WHERE claim_id=$1',[claim,version])
  async function evidence(id:string,ordinal:number){await sql("INSERT INTO memory.knowledge_evidence(evidence_id,installation_id,version_id,episode_id,evidence_kind,excerpt,excerpt_hash,occurred_at,ordinal) VALUES(gen_random_uuid(),$1,$2,$3,'episode','late evidence',sha256(convert_to('late evidence','UTF8')),now(),$4)",[installation,version,id,ordinal])}
  await evidence(episode,0);const p=await plan();await evidence(support,1)
  await expect(applyForwardCleanup(cleanupConfig(),p,options)).rejects.toThrow('cleanup_linked_dependency_drift:knowledge_evidence');await expect(verifyForwardCleanup(cleanupConfig(),p,options)).rejects.toThrow('cleanup_linked_dependency_drift:knowledge_evidence')
  expect((await sql("SELECT count(*)::int AS n FROM memory.source_events WHERE session_id='linked-late-evidence'")).rows[0].n).toBe(1)
  expect(await checkpointCount(p.manifestHash)).toBe(0)
  await applyForwardCleanup(cleanupConfig(),await plan(),options)
  expect((await sql('SELECT current_version_id::text AS id FROM memory.knowledge_claims WHERE claim_id=$1',[claim])).rows[0].id).toBe(version)
 },30000)
 test('oversized actual linked versions refuse planning before content or completion writes',async()=>{
  await source('oversized-linked-knowledge');const episode=randomUUID(),claim=randomUUID()
  await sql("INSERT INTO memory.work_episodes(installation_id,episode_id,session_id,turn_id,state,compiler_version) VALUES($1,$2,'oversized-linked-knowledge',$2::uuid::text,'ready','test')",[installation,episode]);await sql("INSERT INTO memory.knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state) VALUES($1,$2::uuid,'test_invariant','installation',$2::text,$1::uuid::text,'active')",[claim,installation]);
  await sql("INSERT INTO memory.knowledge_versions(version_id,installation_id,claim_id,version_number,statement,authority,confidence) SELECT gen_random_uuid(),$1,$2,n,'bounded version '||n,'user_accepted',1 FROM generate_series(1,1025)n",[installation,claim]);await sql("INSERT INTO memory.knowledge_evidence(evidence_id,installation_id,version_id,episode_id,evidence_kind,excerpt,excerpt_hash,occurred_at,ordinal) SELECT gen_random_uuid(),$1,version_id,$2,'episode','private bounded evidence',sha256('private bounded evidence'),now(),0 FROM memory.knowledge_versions WHERE claim_id=$3",[installation,episode,claim])
  await expect(plan()).rejects.toThrow('cleanup_linked_dependency_row_bound_exceeded:knowledge_evidence')
  expect((await sql('SELECT count(*)::int AS n FROM memory.knowledge_versions WHERE claim_id=$1',[claim])).rows[0].n).toBe(1025);expect((await sql("SELECT count(*)::int AS n FROM memory.source_events WHERE session_id='oversized-linked-knowledge'")).rows[0].n).toBe(1)
  await sql('DELETE FROM memory.knowledge_claims WHERE claim_id=$1',[claim]);await applyForwardCleanup(cleanupConfig(),await plan(),options)
 },30000)

 test('linked Claim cleanup removes its Git binding and writes native irreversible Git fences',async()=>{
  const id=randomUUID(),team=randomUUID(),organization=randomUUID(),repository=randomUUID(),connection=randomUUID(),episode=randomUUID(),claim=randomUUID(),version=randomUUID(),binding=randomUUID(),session='git-linked-'+randomUUID()
  await sql("INSERT INTO public.extension_organizations VALUES($1,'active',1)",[organization]);await sql("INSERT INTO public.extension_teams VALUES($1,$2,'active',1)",[team,organization]);await sql("INSERT INTO public.extension_installations VALUES($1,'pocketctl-memory',1,'team',$2,'active',1,1,'{}','{}','{}','{}')",[id,team]);await sql("INSERT INTO public.sessions VALUES($1,1,'daemon','codex','hot','codex')",[session]);await sql('INSERT INTO public.deleted_sessions VALUES($1)',[session])
  await sql("INSERT INTO memory.memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[id]);await sql("INSERT INTO memory.memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id,parent_organization_id) VALUES($1,'team',$2,$3)",[id,team,organization]);await sql("INSERT INTO shared.memory_source_modes(installation_id,mode) VALUES($1,'legacy-feed')",[id])
  await sql('INSERT INTO memory.source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES($1,$2,now(),now())',[id,session]);await sql("INSERT INTO memory.source_events(source_event_id,installation_id,origin,origin_position,session_id,event_type,occurred_at,payload,payload_hash) VALUES(gen_random_uuid(),$1,'feed',$2,$2,'test',now(),'{\"private\":true}',sha256('private'))",[id,session]);await sql("INSERT INTO memory.work_episodes(installation_id,episode_id,session_id,turn_id,state,compiler_version) VALUES($1,$2,$3,$2::uuid::text,'ready','test')",[id,episode,session])
  await sql('INSERT INTO memory.repositories(installation_id,repository_id,repository_key,first_observed_at,last_observed_at) VALUES($1,$2,$2::uuid::text,now(),now())',[id,repository]);await sql("INSERT INTO memory.knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state) VALUES($1,$2,'test_invariant','repository',$3,$1::uuid::text,'active')",[claim,id,repository]);await sql("INSERT INTO memory.knowledge_versions(version_id,installation_id,claim_id,version_number,statement,authority,confidence,repository_id) VALUES($1,$2,$3,1,'private linked Git invariant','user_accepted',1,$4)",[version,id,claim,repository]);await sql('UPDATE memory.knowledge_claims SET current_version_id=$2 WHERE claim_id=$1',[claim,version]);await sql("INSERT INTO memory.knowledge_evidence(evidence_id,installation_id,version_id,episode_id,evidence_kind,excerpt,excerpt_hash,occurred_at,ordinal) VALUES(gen_random_uuid(),$1,$2,$3,'episode','private Git evidence',sha256('private Git evidence'),now(),0)",[id,version,episode])
  await sql("INSERT INTO memory.memory_git_connections(connection_id,installation_id,repository_id,owner_scope_kind,owner_scope_id,provider,provider_repository_id,target_id,target_branch,credential_ref) VALUES($1,$2,$3,'team',$4,'github','fixture-repository','fixture-target','main','fixture-only-reference')",[connection,id,repository,team]);
  const c=new pg.Client({connectionString:url});await c.connect();try{await c.query('SET search_path=memory,pg_catalog');await c.query("INSERT INTO memory_git_asset_bindings(binding_id,installation_id,connection_id,repository_id,kind,claim_id,path) VALUES($1,$2,$3,$4,'rule',$5,'.pocketctl/knowledge/private-rule.md')",[binding,id,connection,repository,claim])}finally{await c.end()}
  const scoped={...cleanupConfig(),installationIds:[id]},overlay=await planPrivacyOverlay(scoped,options);await applyPrivacyOverlay(scoped,overlay,options);const p=await planForwardCleanup(scoped,overlay,options);expect(p.schemaVersion).toBe(2)
  await applyForwardCleanup(scoped,p,options)
  expect((await sql('SELECT count(*)::int AS n FROM memory.memory_git_asset_bindings WHERE binding_id=$1',[binding])).rows[0].n).toBe(0)
  expect((await sql("SELECT count(*)::int AS n FROM memory.memory_git_tombstones WHERE connection_id=$1 AND identity_id=$2 AND kind='rule'",[connection,claim])).rows[0].n).toBe(1)
  expect((await sql('SELECT generation::text AS generation,sync_mode,write_mode FROM memory.memory_git_connections WHERE connection_id=$1',[connection])).rows[0]).toEqual({generation:'2',sync_mode:'off',write_mode:'off'})
 },30000)

 test('column-only checkpoint grants to PUBLIC and LOGIN or NOLOGIN peers refuse before use or cleanup',async()=>{
  const bootstrap=await plan();await applyForwardCleanup(cleanupConfig(),bootstrap,options)
  await source('column-acl-body');const p=await plan(),login='w4_column_login_'+process.pid,noLogin='w4_column_nologin_'+process.pid
  await sql('CREATE ROLE '+login+' LOGIN');await sql('CREATE ROLE '+noLogin+' NOLOGIN')
  const relationAcl=(await sql("SELECT relacl::text FROM pg_class WHERE oid='shared.memory_forward_cleanup_steps'::regclass")).rows[0].relacl
  try{for(const grantee of ['PUBLIC',login,noLogin]){
   await sql('GRANT SELECT(plan_hash,step),UPDATE(before_hash,after_hash,object_hash) ON shared.memory_forward_cleanup_steps TO '+grantee)
   try{
    expect((await sql("SELECT relacl::text FROM pg_class WHERE oid='shared.memory_forward_cleanup_steps'::regclass")).rows[0].relacl).toBe(relationAcl)
    await expect(verifyForwardCleanup(cleanupConfig(),p,options)).rejects.toThrow('cleanup_checkpoint_structure_or_acl_mismatch')
    await expect(planForwardCleanup(cleanupConfig(),p.overlay,options)).rejects.toThrow('cleanup_checkpoint_structure_or_acl_mismatch')
    await expect(applyForwardCleanup(cleanupConfig(),p,options)).rejects.toThrow('cleanup_checkpoint_structure_or_acl_mismatch')
    expect((await sql("SELECT count(*)::int AS n FROM memory.source_events WHERE session_id='column-acl-body'")).rows[0].n).toBe(1)
    expect(await checkpointCount(p.manifestHash)).toBe(0)
   }finally{await sql('REVOKE SELECT(plan_hash,step),UPDATE(before_hash,after_hash,object_hash) ON shared.memory_forward_cleanup_steps FROM '+grantee)}
  }}finally{await sql('DROP ROLE '+login);await sql('DROP ROLE '+noLogin)}
  await applyForwardCleanup(cleanupConfig(),p,options)
 },30000)
 test('regressing trusted configuration cannot replace the latest target in plan or later apply batches',async()=>{
  const id=randomUUID(),scoped={...config,installationIds:[id]},cfg={...scoped,tombstoneHmacKeys:keys}
  await sql("INSERT INTO public.extension_installations VALUES($1,'pocketctl-memory',1,'personal',$1,'active',1,2,ARRAY['relay-old'],'{}','{}','{}')",[id])
  await sql("INSERT INTO memory.memory_installations(installation_id,provider_id,relay_status,local_status,config_version,granted_scopes) VALUES($1,'pocketctl-memory','active','ready',3,'[\"target-latest\"]')",[id]);await sql("INSERT INTO memory.memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id) VALUES($1,'personal',$1)",[id]);await sql("INSERT INTO shared.memory_source_modes(installation_id,mode) VALUES($1,'legacy-feed')",[id])
  await sql("INSERT INTO memory.memory_feature_settings(installation_id,extraction_mode,embedding_mode) VALUES($1,'off','off')",[id]);await sql("INSERT INTO memory.memory_provider_budget_reservations(reservation_id,budget_key,provider_kind,reserved_input_tokens,reserved_output_tokens) VALUES(gen_random_uuid(),'regression-uncertain','text',31,17)")
  const consent=JSON.stringify((await sql('TABLE memory.memory_feature_settings')).rows),budget=JSON.stringify((await sql('TABLE memory.memory_provider_budget_reservations')).rows)
  const overlay=await planPrivacyOverlay(scoped,options);await applyPrivacyOverlay(scoped,overlay,options)
  const before=(await sql('SELECT row_to_json(i) AS value FROM memory.memory_installations i WHERE installation_id=$1',[id])).rows[0].value
  await expect(planForwardCleanup(cfg,overlay,options)).rejects.toThrow('cleanup_configuration_version_regression')
  expect((await sql('SELECT row_to_json(i) AS value FROM memory.memory_installations i WHERE installation_id=$1',[id])).rows[0].value).toEqual(before)
  await sql('UPDATE public.extension_installations SET config_version=4 WHERE installation_id=$1',[id]);const forwardOverlay=await planPrivacyOverlay(scoped,options);await applyPrivacyOverlay(scoped,forwardOverlay,options);const p=await planForwardCleanup(cfg,forwardOverlay,options)
  await sql('UPDATE memory.memory_installations SET config_version=5 WHERE installation_id=$1',[id])
  const newer=(await sql('SELECT row_to_json(i) AS value FROM memory.memory_installations i WHERE installation_id=$1',[id])).rows[0].value
  await expect(applyForwardCleanup(cfg,p,options)).rejects.toThrow('cleanup_configuration_version_regression')
  expect((await sql('SELECT row_to_json(i) AS value FROM memory.memory_installations i WHERE installation_id=$1',[id])).rows[0].value).toEqual(newer)
  expect(JSON.stringify((await sql('TABLE memory.memory_feature_settings')).rows)).toBe(consent);expect(JSON.stringify((await sql('TABLE memory.memory_provider_budget_reservations')).rows)).toBe(budget)
  expect(await checkpointCount(p.manifestHash)).toBe(0)
  await sql('UPDATE public.extension_installations SET config_version=6 WHERE installation_id=$1',[id]);const current=await planPrivacyOverlay(scoped,options);await applyPrivacyOverlay(scoped,current,options);expect((await applyForwardCleanup(cfg,await planForwardCleanup(cfg,current,options),options)).privacyCatchupReadyForReopen).toBe(true)
  expect((await sql('SELECT config_version::text FROM memory.memory_installations WHERE installation_id=$1',[id])).rows[0].config_version).toBe('6');expect(JSON.stringify((await sql('TABLE memory.memory_feature_settings')).rows)).toBe(consent);expect(JSON.stringify((await sql('TABLE memory.memory_provider_budget_reservations')).rows)).toBe(budget)
 },30000)
 test('late legitimate Skill FK witness cannot widen a reviewed raw-only plan or resume',async()=>{
  const bootstrap=await plan();await applyForwardCleanup(cleanupConfig(),bootstrap,options)
  await source('late-skill-root');const event=(await sql("SELECT source_event_id::text AS id FROM memory.source_events WHERE session_id='late-skill-root'")).rows[0].id,repository=randomUUID(),snapshot=randomUUID(),episode=randomUUID(),archive=randomUUID()
  await sql('INSERT INTO memory.repositories(installation_id,repository_id,repository_key,first_observed_at,last_observed_at) VALUES($1,$2,$2::uuid::text,now(),now())',[installation,repository]);await sql("INSERT INTO memory.repo_snapshots(installation_id,repository_id,repo_snapshot_id,commit_sha,observed_at) VALUES($1,$2,$3,repeat('a',40),now())",[installation,repository,snapshot])
  await sql("INSERT INTO memory.work_episodes(installation_id,episode_id,session_id,turn_id,state,outcome,compiler_version,repository_id,repo_snapshot_id,source_digest,evidence_manifest) VALUES($1,$2,'session',$2::uuid::text,'ready','completed','test',$3,$4,decode(repeat('aa',32),'hex'),'{}'::jsonb)",[installation,episode,repository,snapshot])
  const p=await plan()
  await sql('UPDATE memory.work_episodes SET evidence_manifest=$2 WHERE episode_id=$1',[episode,{e1:{kind:'event',excerpt_hash:'b'.repeat(16),excerpt_length:20,source_event_id:event}}])
  const c=new pg.Client({connectionString:url});await c.connect()
  try{await c.query('BEGIN');await c.query('SET LOCAL search_path=memory,pg_catalog,shared');await c.query("INSERT INTO memory.memory_skill_archives(archive_id,installation_id,repository_id,repo_snapshot_id,episode_id,task_id,generation,candidate_key,policy_version,source_digest,input_digest,content_hash,document_hash,document) VALUES($1,$2,$3,$4,$5,$6,1,'late-skill','test',repeat('aa',32),repeat('b',64),repeat('c',64),repeat('d',64),$7)",[archive,installation,repository,snapshot,episode,randomUUID(),skillFixtureDocument()]);await c.query("INSERT INTO memory.memory_skill_archive_sources(installation_id,archive_id,source_token,evidence_handle,excerpt_hash,evidence_kind,source_event_id) VALUES($1,$2,'source-1','e1',repeat('b',16),'event',$3)",[installation,archive,event]);await c.query('COMMIT')}catch(e){await c.query('ROLLBACK');throw e}finally{await c.end()}
  const episodeBefore=JSON.stringify((await sql('SELECT row_to_json(e) AS value FROM memory.work_episodes e WHERE episode_id=$1',[episode])).rows),before=JSON.stringify((await sql('SELECT row_to_json(a) AS value FROM memory.memory_skill_archives a WHERE archive_id=$1',[archive])).rows),body=JSON.stringify((await sql('SELECT row_to_json(e) AS value FROM memory.source_events e WHERE source_event_id=$1',[event])).rows)
  await expect(applyForwardCleanup(cleanupConfig(),p,options)).rejects.toThrow('cleanup_session_skill_dependency_requires_paged_adapter')
  await expect(applyForwardCleanup(cleanupConfig(),p,options)).rejects.toThrow('cleanup_session_skill_dependency_requires_paged_adapter')
  await expect(verifyForwardCleanup(cleanupConfig(),p,options)).rejects.toThrow('cleanup_session_skill_dependency_requires_paged_adapter')
  expect(JSON.stringify((await sql('SELECT row_to_json(a) AS value FROM memory.memory_skill_archives a WHERE archive_id=$1',[archive])).rows)).toBe(before);expect(JSON.stringify((await sql('SELECT row_to_json(e) AS value FROM memory.source_events e WHERE source_event_id=$1',[event])).rows)).toBe(body)
  expect(await checkpointCount(p.manifestHash)).toBe(0)
  const fresh=await planPrivacyOverlay(config,options);await applyPrivacyOverlay(config,fresh,options);await expect(planForwardCleanup(cleanupConfig(),fresh,options)).rejects.toThrow('cleanup_exact_source_packet_version_unsupported');expect(JSON.stringify((await sql('SELECT row_to_json(e) AS value FROM memory.work_episodes e WHERE episode_id=$1',[episode])).rows)).toBe(episodeBefore);expect(JSON.stringify((await sql('SELECT row_to_json(a) AS value FROM memory.memory_skill_archives a WHERE archive_id=$1',[archive])).rows)).toBe(before);expect(JSON.stringify((await sql('SELECT row_to_json(e) AS value FROM memory.source_events e WHERE source_event_id=$1',[event])).rows)).toBe(body)
  await sql('DELETE FROM memory.memory_skill_archives WHERE archive_id=$1',[archive]);await sql('DELETE FROM memory.work_episodes WHERE episode_id=$1',[episode]);await sql('DELETE FROM memory.repo_snapshots WHERE repo_snapshot_id=$1',[snapshot]);await sql('DELETE FROM memory.repositories WHERE repository_id=$1',[repository])
  await applyForwardCleanup(cleanupConfig(),await plan(),options)
 },30000)
 test('late episode-owned evidence is rechecked before any raw cleanup or checkpoint use',async()=>{
  await source('late-knowledge-root');const episode=randomUUID(),claim=randomUUID(),version=randomUUID(),event=(await sql("SELECT source_event_id::text AS id FROM memory.source_events WHERE session_id='late-knowledge-root'")).rows[0].id
  await sql("INSERT INTO memory.work_episodes(installation_id,episode_id,session_id,turn_id,state,compiler_version) VALUES($1,$2,'late-knowledge-root',$2::uuid::text,'ready','test')",[installation,episode]);const p=await plan()
  await sql("INSERT INTO memory.knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state) VALUES($1,$2::uuid,'test_invariant','installation',$2::text,'late-knowledge','active')",[claim,installation]);await sql("INSERT INTO memory.knowledge_versions(version_id,installation_id,claim_id,version_number,statement,authority,confidence) VALUES($1,$2,$3,1,'late linked source','user_accepted',1)",[version,installation,claim]);await sql("INSERT INTO memory.knowledge_evidence(evidence_id,installation_id,version_id,episode_id,source_event_id,evidence_kind,excerpt,excerpt_hash,occurred_at,ordinal) VALUES(gen_random_uuid(),$1,$2,$3,$4,'event','late linked excerpt',sha256(convert_to('late linked excerpt','UTF8')),now(),0)",[installation,version,episode,event])
  const body=JSON.stringify((await sql('SELECT row_to_json(e) AS value FROM memory.source_events e WHERE source_event_id=$1',[event])).rows)
  await expect(applyForwardCleanup(cleanupConfig(),p,options)).rejects.toThrow('cleanup_session_knowledge_dependency_requires_paged_adapter');await expect(verifyForwardCleanup(cleanupConfig(),p,options)).rejects.toThrow('cleanup_session_knowledge_dependency_requires_paged_adapter')
  expect(JSON.stringify((await sql('SELECT row_to_json(e) AS value FROM memory.source_events e WHERE source_event_id=$1',[event])).rows)).toBe(body);expect((await sql('SELECT count(*)::int AS n FROM memory.knowledge_versions WHERE version_id=$1',[version])).rows[0].n).toBe(1);expect(await checkpointCount(p.manifestHash)).toBe(0)
  await sql('DELETE FROM memory.knowledge_claims WHERE claim_id=$1',[claim]);await applyForwardCleanup(cleanupConfig(),await plan(),options)
 },30000)
 test('tiny Session cleanup ignores thousands of unrelated rows in the same installation',async()=>{
  await sql("INSERT INTO public.sessions SELECT 'unrelated-'||n,1,'daemon','codex','hot','codex' FROM generate_series(1,1500) n")
  await sql("INSERT INTO memory.source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) SELECT $1,'unrelated-'||n,now(),now() FROM generate_series(1,1500) n",[installation])
  await sql("INSERT INTO memory.source_events(source_event_id,installation_id,origin,origin_position,session_id,event_type,occurred_at,payload,payload_hash) SELECT gen_random_uuid(),$1,'feed','unrelated-'||n,'unrelated-'||((n%1500)+1),'test',now(),'{\"unrelated_private_body\":true}',decode(repeat('ab',32),'hex') FROM generate_series(1,5000) n",[installation])
  await source('small-selected');const p=await plan();expect(p.initialState.find(t=>t.table==='source_events')!.rows).toBe(1)
  await applyForwardCleanup(cleanupConfig(),p,options)
  expect((await sql("SELECT count(*)::int AS n FROM memory.source_events WHERE origin_position LIKE 'unrelated-%'")).rows[0].n).toBe(5000)
  expect((await sql("SELECT count(*)::int AS n FROM memory.source_sessions WHERE session_id LIKE 'unrelated-%'")).rows[0].n).toBe(1500)
 },30000)
 test('lost COMMIT response resumes exact immutable plan from durable post-state',async()=>{
  await source('lost-response');await source('lost-response-tail');const p=await plan(),frozen=JSON.stringify(p)
  expect(p.steps.map(step=>step.kind==='session'?step.sessionId:step.kind)).toEqual(['lost-response','lost-response-tail'])
  await expect(applyForwardCleanup(cleanupConfig(),p,{...options,afterCommit:async index=>{const step=p.steps[index];if(step.kind==='session'&&step.sessionId==='lost-response')throw Error('lost_response')}})).rejects.toThrow('lost_response')
  expect((await sql("SELECT count(*)::int AS n FROM memory.source_events WHERE session_id='lost-response'")).rows[0].n).toBe(0)
  expect((await sql("SELECT count(*)::int AS n FROM memory.source_events WHERE session_id='lost-response-tail'")).rows[0].n).toBe(1)
  const intermediate=await verifyForwardCleanup(cleanupConfig(),p,options);expect(intermediate.completedObjects).toBe(p.steps.findIndex(step=>step.kind==='session'&&step.sessionId==='lost-response')+1);expect(intermediate.privacyCatchupReadyForReopen).toBe(false)
  const result=await applyForwardCleanup(cleanupConfig(),p,options);expect(result.privacyCatchupReadyForReopen).toBe(true);expect(result.activationAuthorized).toBe(false);expect(result.reopeningReady).toBe(false)
  expect((await sql("SELECT count(*)::int AS n FROM memory.source_events WHERE session_id=ANY($1::text[])",[['lost-response','lost-response-tail']])).rows[0].n).toBe(0)
  expect(JSON.stringify(p)).toBe(frozen);expect((await applyForwardCleanup(cleanupConfig(),p,options)).completedObjects).toBe(p.steps.length)
 },30000)
 test('new source facts and dependency changes after a checkpoint cannot widen resume',async()=>{
  await source('drift-a-prefix');await source('drift-body');const p=await plan()
  expect(p.steps.map(step=>step.kind==='session'?step.sessionId:step.kind)).toEqual(['drift-a-prefix','drift-body'])
  await expect(applyForwardCleanup(cleanupConfig(),p,{...options,afterCommit:async index=>{const step=p.steps[index];if(step.kind==='session'&&step.sessionId==='drift-a-prefix')throw Error('stop')}})).rejects.toThrow('stop')
  expect((await sql("SELECT count(*)::int AS n FROM memory.source_events WHERE session_id='drift-a-prefix'")).rows[0].n).toBe(0)
  expect((await sql("SELECT count(*)::int AS n FROM memory.source_events WHERE session_id='drift-body'")).rows[0].n).toBe(1)
  expect(await checkpointCount(p.manifestHash)).toBe(1)
  await sql("UPDATE public.sessions SET content_state='deleted' WHERE session_id='session'")
  await expect(applyForwardCleanup(cleanupConfig(),p,options)).rejects.toThrow('cleanup_authority_drift')
  await sql("UPDATE public.sessions SET content_state='hot' WHERE session_id='session'")
  const changed=await sql("UPDATE memory.source_events SET payload='{\"changed\":true}' WHERE session_id='drift-body'");expect(changed.rowCount).toBe(1)
  await expect(applyForwardCleanup(cleanupConfig(),p,options)).rejects.toThrow('cleanup_dependency_drift')
  const fresh=await plan();await applyForwardCleanup(cleanupConfig(),fresh,options)
 },30000)
 test('trusted config refresh preserves local policy, consent and incurred budget rows and terminal holds',async()=>{
  await sql("INSERT INTO memory.memory_provider_budget_reservations(reservation_id,budget_key,provider_kind,reserved_input_tokens,reserved_output_tokens) VALUES(gen_random_uuid(),'uncertain','text',120,80)")
  const budget=JSON.stringify((await sql('TABLE memory.memory_provider_budget_reservations')).rows)
  await sql("UPDATE public.extension_installations SET config_version=2,event_filter='{\"agent_types\":[\"codex\"]}' WHERE installation_id=$1",[installation])
  const p=await plan();expect(p.steps.some(s=>s.kind==='configuration')).toBe(true)
  await applyForwardCleanup(cleanupConfig(),p,options)
  expect((await sql('SELECT config_version::text,local_status,event_filter FROM memory.memory_installations WHERE installation_id=$1',[installation])).rows[0]).toEqual({config_version:'2',local_status:'integrity_error',event_filter:{agent_types:['codex']}})
  expect(JSON.stringify((await sql('TABLE memory.memory_provider_budget_reservations')).rows)).toBe(budget)
  await sql("UPDATE memory.memory_installations SET local_status='purged' WHERE installation_id=$1",[installation]);await sql('UPDATE public.extension_installations SET config_version=3 WHERE installation_id=$1',[installation])
  const overlay=await planPrivacyOverlay(config,options);await applyPrivacyOverlay(config,overlay,options)
  await expect(planForwardCleanup(cleanupConfig(),overlay,options)).rejects.toThrow('cleanup_installation_terminal_or_unknown')
  await sql("UPDATE memory.memory_installations SET local_status='integrity_error' WHERE installation_id=$1",[installation]);await applyForwardCleanup(cleanupConfig(),await plan(),options)
 },30000)
 test('dependency bound, cancellation, wrong target identity and old writer credentials refuse safely',async()=>{
  await source('overbound');await sql("INSERT INTO memory.source_events(source_event_id,installation_id,origin,origin_position,session_id,event_type,occurred_at,payload,payload_hash) SELECT gen_random_uuid(),$1,'feed','overbound-'||n,'overbound','test',now(),'{}',decode(repeat('ab',32),'hex') FROM generate_series(1,1025) n",[installation])
  await expect(plan()).rejects.toThrow('cleanup_single_page_dependency_bound_exceeded');await sql("DELETE FROM memory.source_events WHERE session_id='overbound'")
  const p=await plan(),controller=new AbortController();controller.abort()
  await expect(applyForwardCleanup(cleanupConfig(),p,{...options,signal:controller.signal})).rejects.toThrow('maintenance_interrupted')
  await expect(applyForwardCleanup({...cleanupConfig(),database:{...config.database,expected:{...config.database.expected,database:'wrong_test'}}},p,options)).rejects.toThrow('cleanup_scope_drift')
  const role='w4_cleanup_old_'+process.pid;await sql('CREATE ROLE '+role+' LOGIN');await sql('GRANT USAGE ON SCHEMA memory TO '+role);await sql('GRANT INSERT ON memory.source_events TO '+role)
  try{await expect(applyForwardCleanup(cleanupConfig(),p,options)).rejects.toThrow('target_writers_not_fenced')}finally{await sql('REVOKE ALL ON memory.source_events FROM '+role);await sql('REVOKE ALL ON SCHEMA memory FROM '+role);await sql('DROP ROLE '+role)}
 },30000)
 test('lock contention and hard deadline roll back a page without completion receipt',async()=>{
  await source('locked-body');const p=await plan(),blocker=new pg.Client({connectionString:url});await blocker.connect();await blocker.query('BEGIN');await blocker.query('LOCK TABLE memory.source_events IN ACCESS EXCLUSIVE MODE')
  try{await expect(applyForwardCleanup(cleanupConfig(),p,options)).rejects.toMatchObject({code:'55P03'})}finally{await blocker.query('ROLLBACK');await blocker.end()}
  const query=pg.Client.prototype.query;let delayed=false
  const wire=vi.spyOn(pg.Client.prototype,'query').mockImplementation(function(this:pg.Client,...args:any[]):any{const result=(query as any).apply(this,args);if(!delayed&&String(args[0]).startsWith('DELETE FROM memory_task_bundles'))return result.then(async(r:any)=>{delayed=true;await(query as any).call(this,'SELECT pg_sleep(3)');return r});return result} as any)
  try{await expect(applyForwardCleanup(cleanupConfig(),p,{...options,transactionTimeoutMs:1200})).rejects.toThrow('cleanup_transaction_window_expired')}finally{wire.mockRestore()}
  // Socket closure does not cancel the injected 3s server sleep. Await that
  // owned backend for at most 5s; an active peer still fails this check.
  expect(delayed).toBe(true);await fixtureDrained(250);expect((await verifyForwardCleanup(cleanupConfig(),p,options)).completedObjects).toBe(0)
  await applyForwardCleanup(cleanupConfig(),p,options)
 },30000)
 test('cancellation during policy mutation rolls back and checkpoint ACL drift refuses',async()=>{
  await source('cancelled-page');const p=await plan(),controller=new AbortController(),query=pg.Client.prototype.query;let interrupted=false
  const wire=vi.spyOn(pg.Client.prototype,'query').mockImplementation(function(this:pg.Client,...args:any[]):any{const result=(query as any).apply(this,args);if(!interrupted&&String(args[0]).startsWith('DELETE FROM memory_task_bundles'))return result.then((r:any)=>{interrupted=true;controller.abort();return r});return result} as any)
  try{await expect(applyForwardCleanup(cleanupConfig(),p,{...options,signal:controller.signal})).rejects.toThrow('maintenance_interrupted')}finally{wire.mockRestore()}
  await fixtureDrained();expect(interrupted).toBe(true);expect((await verifyForwardCleanup(cleanupConfig(),p,options)).completedObjects).toBe(0)
  await sql('GRANT SELECT ON shared.memory_forward_cleanup_steps TO PUBLIC')
  try{await expect(verifyForwardCleanup(cleanupConfig(),p,options)).rejects.toThrow('cleanup_checkpoint_structure_or_acl_mismatch')}finally{await sql('REVOKE SELECT ON shared.memory_forward_cleanup_steps FROM PUBLIC')}
  await applyForwardCleanup(cleanupConfig(),p,options)
 },30000)
 test('member and scope epoch repair retain accepted knowledge and reject stale grants through native policy',async()=>{
  const team='50000000-0000-0000-0000-000000000064',organization='60000000-0000-0000-0000-000000000064',sharedInstallation='70000000-0000-0000-0000-000000000064',member='80000000-0000-0000-0000-000000000064'
  await sql("INSERT INTO public.extension_organizations VALUES($1,'active',1)",[organization]);await sql("INSERT INTO public.extension_teams VALUES($1,$2,'active',1)",[team,organization])
  await sql("INSERT INTO public.extension_installations VALUES($1,'pocketctl-memory',1,'team',$2,'active',1,1,'{}','{}','{}','{}')",[sharedInstallation,team]);await sql("INSERT INTO public.extension_scope_memberships VALUES($1,'team',$2,1,ARRAY['reviewer'],'active',1)",[member,team])
  await sql("INSERT INTO memory.memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[sharedInstallation]);await sql("INSERT INTO memory.memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id,parent_organization_id) VALUES($1,'team',$2,$3)",[sharedInstallation,team,organization]);await sql("INSERT INTO memory.memory_scope_memberships(installation_id,membership_id,roles) VALUES($1,$2,ARRAY['reviewer'])",[sharedInstallation,member]);await sql("INSERT INTO shared.memory_source_modes(installation_id,mode) VALUES($1,'legacy-feed')",[sharedInstallation])
  config.installationIds.push(sharedInstallation)
  const ownedClaim=randomUUID(),ownedVersion=randomUUID(),ownedCapsule=randomUUID()
  await sql("INSERT INTO memory.knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state,owner_scope_kind,owner_scope_id) VALUES($1,$2::uuid,'test_invariant','installation',$2::text,'team-owned-acceptance','active','team',$3)",[ownedClaim,sharedInstallation,team])
  await sql("INSERT INTO memory.knowledge_versions(version_id,installation_id,claim_id,version_number,statement,authority,confidence) VALUES($1,$2,$3,1,'separately owned team acceptance','user_accepted',1)",[ownedVersion,sharedInstallation,ownedClaim])
  await sql("INSERT INTO memory.knowledge_evidence_capsules(capsule_id,installation_id,version_id,retention_basis,source_content_hash) VALUES($1,$2,$3,'user_accepted',decode(repeat('ab',32),'hex'))",[ownedCapsule,sharedInstallation,ownedVersion])

  const pool=createMemoryPool({databaseUrl:url!,dbPoolMax:1,databaseNamespace:'memory'})
  const facts={primaryInstallationId:sharedInstallation,configVersion:'1',userId:1,scopeBindings:[{installation_id:sharedInstallation,owner_scope_kind:'team' as const,owner_scope_id:team,membership_id:member,membership_revision:'1',authorization_epoch:'1',permissions:['read']}]}
  try{expect(await createScopeAuthorization(pool).validateV2Grant(facts)).not.toBeNull()}finally{await pool.end()}
  await sql("UPDATE public.extension_scope_memberships SET state='revoked',membership_revision=2 WHERE membership_id=$1",[member]);await sql('UPDATE public.extension_teams SET authorization_epoch=2 WHERE team_id=$1',[team])
  const beforeKnowledge=JSON.stringify((await sql('SELECT row_to_json(v) FROM memory.knowledge_versions v')).rows),p=await plan()
  expect(p.steps.some(s=>s.kind==='membership')).toBe(true);expect(p.steps.some(s=>s.kind==='scope')).toBe(true)
  const result=await applyForwardCleanup(cleanupConfig(),p,options);expect(result.privacyCatchupReadyForReopen).toBe(true)
  expect((await sql('SELECT state,membership_revision::text,valid_until IS NOT NULL AS closed FROM memory.memory_scope_memberships WHERE membership_id=$1',[member])).rows[0]).toEqual({state:'revoked',membership_revision:'2',closed:true})
  expect((await sql('SELECT authorization_epoch::text FROM memory.memory_owner_scopes WHERE installation_id=$1',[sharedInstallation])).rows[0].authorization_epoch).toBe('2')
  expect(JSON.stringify((await sql('SELECT row_to_json(v) FROM memory.knowledge_versions v')).rows)).toBe(beforeKnowledge)
  const currentPool=createMemoryPool({databaseUrl:url!,dbPoolMax:1,databaseNamespace:'memory'});try{expect(await createScopeAuthorization(currentPool).validateV2Grant(facts)).toBeNull()}finally{await currentPool.end()}
  await sql("UPDATE public.extension_scope_memberships SET state='active',membership_revision=3,roles=ARRAY['reader'] WHERE membership_id=$1",[member])
  const activeRepair=await plan();expect(activeRepair.steps.some(s=>s.kind==='membership')).toBe(true);expect((await applyForwardCleanup(cleanupConfig(),activeRepair,options)).privacyCatchupReadyForReopen).toBe(true)
  expect((await sql('SELECT state,membership_revision::text,roles,valid_until FROM memory.memory_scope_memberships WHERE membership_id=$1',[member])).rows[0]).toEqual({state:'active',membership_revision:'3',roles:['reader'],valid_until:null})

 },30000)
 test('retained source metadata without source_sessions still cleans; unprovable references refuse',async()=>{
  await source('severed-source');await sql("DELETE FROM memory.source_sessions WHERE session_id='severed-source'")
  const p=await plan();expect(p.steps.some(s=>s.kind==='session'&&s.sessionId==='severed-source')).toBe(true);await applyForwardCleanup(cleanupConfig(),p,options)
  await sql("UPDATE memory.memory_session_tombstones SET reason='access_revoked' WHERE session_id='severed-source'")
  await expect(verifyForwardCleanup(cleanupConfig(),p,options)).rejects.toThrow('cleanup_dependency_drift')
 },30000)
 test('actual cleanup retains readable independent acceptance and respects global withdrawal without receipt/source session',async()=>{
  const retainedInstallation=randomUUID(),claim=randomUUID(),version=randomUUID(),cap=randomUUID(),evidence=randomUUID(),sub=randomUUID(),choice=randomUUID()
  await sql("INSERT INTO public.extension_installations VALUES($1,'pocketctl-memory',1,'personal',$1,'active',1,1,'{}','{}','{}','{}')",[retainedInstallation])
  await sql("INSERT INTO memory.memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[retainedInstallation])
  await sql("INSERT INTO memory.memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id) VALUES($1,'personal',$1);",[retainedInstallation])
  await sql("INSERT INTO shared.memory_source_modes(installation_id,mode) VALUES($1,'legacy-feed')",[retainedInstallation])
  await sql("INSERT INTO memory.knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state) VALUES($1,$2::uuid,'test_invariant','installation',$2::text,'retained-linked','active')",[claim,retainedInstallation])
  await sql("INSERT INTO memory.knowledge_versions(version_id,installation_id,claim_id,version_number,statement,authority,confidence) VALUES($1,$2,$3,1,'linked accepted result','user_accepted',1)",[version,retainedInstallation,claim])
  await sql('UPDATE memory.knowledge_claims SET current_version_id=$2 WHERE claim_id=$1',[claim,version])
  await sql("INSERT INTO memory.knowledge_evidence_capsules(capsule_id,installation_id,version_id,retention_basis,source_content_hash) VALUES($1,$2,$3,'user_accepted',sha256(convert_to('linked accepted result','UTF8')))",[cap,retainedInstallation,version])
  await sql("INSERT INTO memory.knowledge_evidence(evidence_id,installation_id,version_id,capsule_id,ordinal,evidence_kind,excerpt,excerpt_hash,occurred_at,locator) VALUES($1,$2,$3,$4,0,'accepted_excerpt','retained independent excerpt',sha256(convert_to('retained independent excerpt','UTF8')),now(),$5)",[evidence,retainedInstallation,version,cap,{nested:{session_id:'retained-native'}}])
  await sql("INSERT INTO public.sessions VALUES('retained-native',1,'daemon','codex','hot','codex');INSERT INTO memory.source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES('"+retainedInstallation+"','retained-native',now(),now())")
  const scoped={...config,installationIds:[retainedInstallation]}
  const read=async()=>{const runtime=createMemoryPool({databaseUrl:url!,databaseNamespace:'memory',dbPoolMax:1});try{return await retainedSourceRead(runtime,{installationId:retainedInstallation,authorityGrant:{installationId:retainedInstallation,configVersion:'1',userId:1}},async db=>{await guardRetainedVersions(db,retainedInstallation,[version],{requireAvailable:true,requireCurrent:true});return true})}finally{await runtime.end()}}
  expect(await read()).toBe(true)
  const copyPlan=await planPrivacyOverlay(scoped,options)
  await sql('DELETE FROM memory.source_sessions WHERE installation_id=$1',[retainedInstallation]);await sql("INSERT INTO public.deleted_sessions VALUES('retained-native')")
  await expect(applyPrivacyOverlay(scoped,copyPlan,options)).rejects.toThrow('overlay_facts_drift')
  const afterDelete=await planPrivacyOverlay(scoped,options);expect(afterDelete.sessions).toContainEqual({installationId:retainedInstallation,sessionId:'retained-native',reason:'user_deleted'});await applyPrivacyOverlay(scoped,afterDelete,options)
  const repair=await planForwardCleanup({...scoped,tombstoneHmacKeys:keys},afterDelete,options);await applyForwardCleanup({...scoped,tombstoneHmacKeys:keys},repair,options)
  expect(await read()).toBe(true) // independent accepted evidence uses its own ownership
  const provenance={source_kind:'team_session',source_version:2,team_id:'retained-team',team_session_id:'retained-team-session',accepted_delivery:{submission_id:sub,decision_id:choice}}
  await sql('UPDATE memory.knowledge_evidence SET locator=$2 WHERE evidence_id=$1',[evidence,{source_provenance:provenance}])
  await sql("INSERT INTO public.team_delivery_memory_sources VALUES('removed-delivery','retained-team','retained-team-session',$1,$2,NULL,NULL)",[sub,choice])
  await sql("DELETE FROM public.team_delivery_memory_sources WHERE source_session_id='removed-delivery'")
  const beforeWithdrawal=await planPrivacyOverlay(scoped,options)
  expect(beforeWithdrawal.retainedClosure.deliveries).toContainEqual({installationId:retainedInstallation,teamId:'retained-team',teamSessionId:'retained-team-session',submissionId:sub,decisionId:choice,independent:true})
  await ensureDeliveryPrivacyCapture()
  expect(await read()).toBe(true)
  await sql("INSERT INTO public.team_delivery_memory_withdrawals VALUES('retained-team','retained-team-session',$1,$2)",[sub,choice])
  await expect(applyPrivacyOverlay(scoped,beforeWithdrawal,options)).rejects.toThrow('overlay_facts_drift')
  const fresh=await planPrivacyOverlay(scoped,options);expect(fresh.withdrawals).toContainEqual({teamId:'retained-team',teamSessionId:'retained-team-session',submissionId:sub,decisionId:choice})
  const result=await applyPrivacyOverlay(scoped,fresh,options);expect(result.privacyCatchupReadyForReopen).toBe(true);expect(result.reopeningReady).toBe(false)
  const withdrawn=await planForwardCleanup({...scoped,tombstoneHmacKeys:keys},fresh,options);expect((await applyForwardCleanup({...scoped,tombstoneHmacKeys:keys},withdrawn,options)).privacyCatchupReadyForReopen).toBe(true)
  expect(await read()).toBeUndefined()
  expect((await sql('SELECT count(*)::text AS n FROM memory.knowledge_evidence_capsules WHERE capsule_id=$1',[cap])).rows[0].n).toBe('1')
  expect((await sql('SELECT excerpt FROM memory.knowledge_evidence WHERE evidence_id=$1',[evidence])).rows[0].excerpt).toBe('retained independent excerpt')
 })
 test('actual cleanup CLI publishes private immutable plan/apply/resume reports without starting services',async()=>{
  await source('cli-owned-source')
  const dir=await mkdtemp(join(tmpdir(),'w4-cleanup-cli-')),path=join(dir,'config.json'),overlayPath=join(dir,'overlay.json')
  const overlay=await planPrivacyOverlay(config,options);await applyPrivacyOverlay(config,overlay,options)
  const {url:_,...database}=config.database;await writeFile(path,JSON.stringify({...config,database}),{mode:0o600});await writeFile(overlayPath,JSON.stringify(overlay),{mode:0o600})
  await writeFile(join(dir,'systemctl'),'#!'+process.execPath+'\nprocess.stdout.write("LoadState=loaded\\nActiveState=inactive\\nSubState=dead\\nMainPID=0\\n")\n',{mode:0o700})
  vi.stubEnv('PATH',dir+':'+process.env.PATH);vi.stubEnv('SHARED_MAINTENANCE_URL',url!);vi.stubEnv('SHARED_MAINTENANCE_TOMBSTONE_KEYS',JSON.stringify(keys))
  try{
   expect(await main(['cleanup','plan','--config',path,'--overlay',overlayPath,'--output',join(dir,'plan')])).toBe(0)
   const file=join(dir,'plan','maintenance-manifest.json'),before=await readFile(file,'utf8');expect((await stat(file)).mode&0o777).toBe(0o600);expect(before).not.toContain(keys[0].key);expect(before).not.toContain('private source body')
   expect(await main(['cleanup','apply','--config',path,'--manifest',file,'--output',join(dir,'apply')])).toBe(0)
   expect((await sql("SELECT count(*)::int AS n FROM memory.source_events WHERE session_id='cli-owned-source'")).rows[0].n).toBe(0)
   expect(await main(['cleanup','resume','--config',path,'--manifest',file,'--output',join(dir,'resume')])).toBe(0)
   expect(await main(['cleanup','verify','--config',path,'--manifest',file,'--output',join(dir,'verify')])).toBe(0)
   expect(await readFile(file,'utf8')).toBe(before);expect(JSON.parse(await readFile(join(dir,'verify','maintenance-receipt.json'),'utf8')).activationAuthorized).toBe(false)
   expect(await main(['cleanup','plan','--config',path,'--overlay',overlayPath,'--output',join(dir,'plan')])).toBe(2)
  }finally{vi.unstubAllEnvs();await rm(dir,{recursive:true,force:true})}
 },30000)
 test('unknown retained original authority refuses without creating cleanup checkpoints',async()=>{
  const bundle=randomUUID(),missing=randomUUID()
  await sql("INSERT INTO memory.memory_task_bundles(installation_id,bundle_id,task_key,session_id,source_digest,watermark,spans) VALUES($1,$2,'unproven-cleanup','session',decode(repeat('ab',32),'hex'),0,$3)",[installation,bundle,JSON.stringify([{nested:{source_event_ids:[missing]},quote:'private unknown body'}])])
  try{const overlay=await planPrivacyOverlay(config,options);expect(overlay.retainedClosure.unresolved.length).toBeGreaterThan(0);await expect(planForwardCleanup(cleanupConfig(),overlay,options)).rejects.toThrow('cleanup_original_authority_unproven');expect(JSON.stringify(overlay)).not.toContain('private unknown body')}finally{await sql('DELETE FROM memory.memory_task_bundles WHERE bundle_id=$1',[bundle])}
 },30000)
})
