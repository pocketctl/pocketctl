import {installNativeAliasFixture} from './native-alias-fixture.js'
import pg from 'pg'
import {randomUUID,createHash} from 'node:crypto'
import {createMemoryPool} from '../../db.js'
import {retainedSourceRead} from '../../sources/retained-read.js'
import {guardRetainedVersions} from '../../sources/retained-versions.js'
import {mkdtemp,writeFile,stat,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {main} from '../../migrations/shared-forward/source-maintenance-cli.js'
import {afterAll,beforeAll,describe,expect,test,vi} from 'vitest'
import {applyMemorySchema} from '../../schema.js'
import {applySharedSourceContract} from '../../migrations/shared-db/contract.js'
import {planPrivacyOverlay as rawPlanPrivacyOverlay,applyPrivacyOverlay as rawApplyPrivacyOverlay,verifyPrivacyOverlay as rawVerifyPrivacyOverlay,type PrivacyOverlayConfig} from '../../migrations/shared-forward/privacy-overlay.js'
const url=process.env.SHARED_W4_OVERLAY_TEST_DATABASE_URL,suite=url?describe:describe.skip
const installation='10000000-0000-0000-0000-000000000064',submission='20000000-0000-0000-0000-000000000064',decision='30000000-0000-0000-0000-000000000064'
suite('current target restrictive privacy overlay',()=>{
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
 beforeAll(async()=>{
  if(!url||!new URL(url).pathname.endsWith('_test'))throw Error('isolated_test_required')
  const pool=new pg.Pool({connectionString:url});await applyMemorySchema(pool,{namespace:'memory'});await applySharedSourceContract(pool)
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
 test('plan is read-only; a deletion and withdrawal after copy invalidate the old exact manifest',async()=>{
  const p=await planPrivacyOverlay(config,options);expect(p.sessions).toEqual([{installationId:installation,sessionId:'delivery',reason:'access_revoked'}]);expect(p.withdrawals).toEqual([])
  await sql("INSERT INTO public.deleted_sessions VALUES('session');INSERT INTO public.team_delivery_memory_withdrawals VALUES('team','team-session','"+submission+"','"+decision+"')")
  await expect(applyPrivacyOverlay(config,p,options)).rejects.toThrow('overlay_facts_drift')
  expect((await sql("SELECT count(*)::text AS n FROM memory.memory_session_tombstones WHERE session_id='session'")).rows[0].n).toBe('0')
 })
 test('applies exact tombstones/withdrawals, preserves accepted capsules and canonical bodies, and repeats safely',async()=>{
  const p=await planPrivacyOverlay(config,options);expect(p.sessions).toEqual([{installationId:installation,sessionId:'delivery',reason:'access_revoked'},{installationId:installation,sessionId:'session',reason:'user_deleted'}]);expect(p.withdrawals).toHaveLength(1)
  await expect(verifyPrivacyOverlay(config,p,options)).rejects.toThrow('overlay_session_barrier_missing')
  const applied=await applyPrivacyOverlay(config,p,options);expect(applied.barrierApplied).toBe(true);expect(applied.reopeningReady).toBe(false)
  expect((await verifyPrivacyOverlay(config,p,options)).barrierApplied).toBe(true);await applyPrivacyOverlay(config,p,options)
  expect(JSON.stringify((await sql('SELECT row_to_json(c)::text FROM memory.knowledge_evidence_capsules c')).rows)).toBe(capsule)
  expect(JSON.stringify((await sql('TABLE public.canonical_sentinel')).rows)).toBe(sentinel)
  expect((await sql('SELECT count(*)::text AS n FROM memory.memory_jobs')).rows[0].n).toBe('0')
  expect((await sql('SELECT count(*)::text AS n FROM memory.memory_team_delivery_withdrawals')).rows[0].n).toBe('1')
  await sql("DELETE FROM memory.memory_session_tombstones WHERE session_id='session'")
  await expect(verifyPrivacyOverlay(config,p,options)).rejects.toThrow('overlay_session_barrier_missing');await applyPrivacyOverlay(config,p,options)
 })
 test('interruption after a restrictive write rolls back the whole overlay and resumes the same plan',async()=>{
  const p=await planPrivacyOverlay(config,options)
  await sql("DELETE FROM memory.memory_session_tombstones WHERE session_id='session';DELETE FROM memory.memory_team_delivery_withdrawals")
  const controller=new AbortController(),query=pg.Client.prototype.query
  const wire=vi.spyOn(pg.Client.prototype,'query').mockImplementation(function(this:pg.Client,...args:any[]):any{
   const result=(query as any).apply(this,args)
   if(String(args[0]).startsWith('INSERT INTO memory.memory_session_tombstones'))return result.then((r:any)=>{controller.abort();return r})
   return result
  } as any)
  try{await expect(applyPrivacyOverlay(config,p,{...options,signal:controller.signal})).rejects.toThrow('maintenance_interrupted')}finally{wire.mockRestore()}
  expect((await sql("SELECT count(*)::text AS n FROM memory.memory_session_tombstones WHERE session_id='session'")).rows[0].n).toBe('0')
  expect((await sql('SELECT count(*)::text AS n FROM memory.memory_team_delivery_withdrawals')).rows[0].n).toBe('0')
  await applyPrivacyOverlay(config,p,options)
 })
 test('hard transaction deadline interrupts a delayed real statement and rolls restrictive writes back',async()=>{
  const p=await planPrivacyOverlay(config,options)
  await sql("DELETE FROM memory.memory_session_tombstones WHERE installation_id=$1 AND session_id IN('delivery','session')",[installation])
  const query=pg.Client.prototype.query;let delayed=false
  const wire=vi.spyOn(pg.Client.prototype,'query').mockImplementation(function(this:pg.Client,...args:any[]):any{
   const result=(query as any).apply(this,args)
   if(!delayed&&String(args[0]).startsWith('INSERT INTO memory.memory_session_tombstones'))return result.then(async(r:any)=>{delayed=true;await (query as any).call(this,'SELECT pg_sleep(4)');return r})
   return result
  } as any)
  try{await expect(applyPrivacyOverlay(config,p,{...options,transactionTimeoutMs:2000})).rejects.toThrow('overlay_transaction_window_expired')}finally{wire.mockRestore()}
  expect(delayed).toBe(true)
  expect((await sql('SELECT count(*)::text AS n FROM memory.memory_session_tombstones WHERE installation_id=$1',[installation])).rows[0].n).toBe('0')
  for(let attempt=0;attempt<50;attempt++){
   if(!(await sql("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND application_name='pocketctl-source-maintenance' AND pid<>pg_backend_pid()")).rowCount)break
   await new Promise(resolve=>setTimeout(resolve,100))
  }
  await applyPrivacyOverlay(config,p,options)
 },10000)
 test('fences actual target runtime writers and refuses wrong target identities',async()=>{
  await expect(planPrivacyOverlay({...config,database:{...config.database,expected:{...config.database.expected,database:'wrong_test'}}},options)).rejects.toThrow('database_identity_mismatch')
  const name='w4_overlay_writer_'+process.pid
  await sql('CREATE ROLE '+name+' LOGIN');await sql('GRANT USAGE ON SCHEMA memory TO '+name);await sql('GRANT INSERT ON memory.memory_session_tombstones TO '+name)
  try{await expect(planPrivacyOverlay(config,options)).rejects.toThrow('target_writers_not_fenced')}finally{await sql('REVOKE ALL ON memory.memory_session_tombstones FROM '+name);await sql('REVOKE ALL ON SCHEMA memory FROM '+name);await sql('DROP ROLE '+name)}
 })
 test('NOINHERIT peers can SET ROLE through multiple layers and must be fenced even while offline',async()=>{
  const writer='w4_set_writer_'+process.pid,bridge='w4_set_bridge_'+process.pid,peer='w4_set_peer_'+process.pid,p=await planPrivacyOverlay(config,options)
  await sql('CREATE TABLE memory.w4_writer_probe(id int)')
  await sql('CREATE ROLE '+writer+' NOLOGIN;CREATE ROLE '+bridge+' NOLOGIN NOINHERIT;CREATE ROLE '+peer+" LOGIN NOINHERIT PASSWORD 'synthetic-only'")
  await sql('GRANT USAGE ON SCHEMA memory TO '+writer+';GRANT INSERT ON memory.w4_writer_probe TO '+writer+';GRANT '+writer+' TO '+bridge+';GRANT '+bridge+' TO '+peer)
  try{
  const targetOid=(await sql("SELECT 'memory.w4_writer_probe'::regclass::oid::text AS oid")).rows[0].oid
  const peerUrl=new URL(url!);peerUrl.username=peer;peerUrl.password='synthetic-only';const runtime=new pg.Client({connectionString:peerUrl.toString()});await runtime.connect()
  try{
   expect((await runtime.query("SELECT has_table_privilege(current_user,$1::oid,'INSERT') AS write",[targetOid])).rows[0].write).toBe(false)
   await runtime.query('SET ROLE '+writer);await runtime.query('BEGIN');await runtime.query("INSERT INTO memory.w4_writer_probe VALUES(1)");await runtime.query('ROLLBACK');await runtime.query('RESET ROLE')
  }finally{await runtime.end()}
   await expect(planPrivacyOverlay(config,options)).rejects.toThrow('target_writers_not_fenced')
   await expect(applyPrivacyOverlay(config,p,options)).rejects.toThrow('target_writers_not_fenced')
   const version=Number((await sql("SELECT current_setting('server_version_num') AS version")).rows[0].version)
   if(version>=160000){await sql('GRANT '+writer+' TO '+bridge+' WITH SET FALSE');expect((await planPrivacyOverlay(config,options)).currentFactsHash).toBe(p.currentFactsHash);await sql('GRANT '+writer+' TO '+bridge+' WITH SET TRUE');await expect(planPrivacyOverlay(config,options)).rejects.toThrow('target_writers_not_fenced')}
   await sql('REVOKE '+writer+' FROM '+bridge)
   expect((await planPrivacyOverlay(config,options)).currentFactsHash).toBe(p.currentFactsHash)
  }finally{await sql('REVOKE ALL ON memory.w4_writer_probe FROM '+writer+';REVOKE ALL ON SCHEMA memory FROM '+writer+';DROP TABLE memory.w4_writer_probe;DROP ROLE '+peer+';DROP ROLE '+bridge+';DROP ROLE '+writer)}
 })
 test('retained linked capsule survives Session deletion and discovers withdrawal after source session and delivery receipt removal',async()=>{
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
  expect(await read()).toBe(true) // independent accepted evidence uses its own ownership
  const provenance={source_kind:'team_session',source_version:2,team_id:'retained-team',team_session_id:'retained-team-session',accepted_delivery:{submission_id:sub,decision_id:choice}}
  await sql('UPDATE memory.knowledge_evidence SET locator=$2 WHERE evidence_id=$1',[evidence,{source_provenance:provenance}])
  await sql("INSERT INTO public.team_delivery_memory_sources VALUES('removed-delivery','retained-team','retained-team-session',$1,$2,NULL,NULL)",[sub,choice])
  await sql("DELETE FROM public.team_delivery_memory_sources WHERE source_session_id='removed-delivery'")
  const beforeWithdrawal=await planPrivacyOverlay(scoped,options)
  expect(beforeWithdrawal.retainedClosure.deliveries).toContainEqual({installationId:retainedInstallation,teamId:'retained-team',teamSessionId:'retained-team-session',submissionId:sub,decisionId:choice,independent:true})
  await sql("ALTER TABLE shared.memory_source_contract ADD COLUMN IF NOT EXISTS delivery_privacy_capture_version int NOT NULL DEFAULT 1;UPDATE shared.memory_source_contract SET delivery_privacy_capture_version=1")
  for(const relation of ['public.team_delivery_memory_withdrawals','public.team_artifact_revocations'])await sql('CREATE TRIGGER memory_delivery_privacy_fence BEFORE INSERT OR UPDATE OR DELETE ON '+relation+' FOR EACH ROW EXECUTE FUNCTION shared.fence_memory_delivery_withdrawal()')
  expect(await read()).toBe(true)
  await sql("INSERT INTO public.team_delivery_memory_withdrawals VALUES('retained-team','retained-team-session',$1,$2)",[sub,choice])
  await expect(applyPrivacyOverlay(scoped,beforeWithdrawal,options)).rejects.toThrow('overlay_facts_drift')
  const fresh=await planPrivacyOverlay(scoped,options);expect(fresh.withdrawals).toContainEqual({teamId:'retained-team',teamSessionId:'retained-team-session',submissionId:sub,decisionId:choice})
  const result=await applyPrivacyOverlay(scoped,fresh,options);expect(result.privacyCatchupReadyForReopen).toBe(true);expect(result.reopeningReady).toBe(false)
  expect(await read()).toBeUndefined()
  expect((await sql('SELECT count(*)::text AS n FROM memory.knowledge_evidence_capsules WHERE capsule_id=$1',[cap])).rows[0].n).toBe('1')
  expect((await sql('SELECT excerpt FROM memory.knowledge_evidence WHERE evidence_id=$1',[evidence])).rows[0].excerpt).toBe('retained independent excerpt')
 })
 test('independent accepted capsules still fail closed on malformed Team v2 global withdrawal identities',async()=>{
  const inst=randomUUID(),claim=randomUUID(),version=randomUUID(),cap=randomUUID(),evidence=randomUUID(),sub=randomUUID(),choice=randomUUID()
  await sql("INSERT INTO public.extension_installations VALUES($1,'pocketctl-memory',1,'personal',$1,'active',1,1,'{}','{}','{}','{}')",[inst])
  await sql("INSERT INTO memory.memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[inst]);await sql("INSERT INTO memory.memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id) VALUES($1,'personal',$1)",[inst]);await sql("INSERT INTO shared.memory_source_modes(installation_id,mode) VALUES($1,'legacy-feed')",[inst])
  await sql("INSERT INTO memory.knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state) VALUES($1,$2::uuid,'test_invariant','installation',$2::text,'malformed-global-identity','active')",[claim,inst]);await sql("INSERT INTO memory.knowledge_versions(version_id,installation_id,claim_id,version_number,statement,authority,confidence) VALUES($1,$2,$3,1,'independent capsule','user_accepted',1)",[version,inst,claim]);await sql('UPDATE memory.knowledge_claims SET current_version_id=$2 WHERE claim_id=$1',[claim,version])
  await sql("INSERT INTO memory.knowledge_evidence_capsules(capsule_id,installation_id,version_id,retention_basis,source_content_hash) VALUES($1,$2,$3,'user_accepted',sha256(convert_to('capsule','UTF8')))",[cap,inst,version]);await sql("INSERT INTO memory.knowledge_evidence(evidence_id,installation_id,version_id,capsule_id,ordinal,evidence_kind,excerpt,excerpt_hash,occurred_at,locator) VALUES($1,$2,$3,$4,0,'accepted_excerpt','independent retained excerpt',sha256(convert_to('excerpt','UTF8')),now(),'{}')",[evidence,inst,version,cap])
  const scoped={...config,installationIds:[inst]}
  for(const accepted_delivery of [{submission_id:sub},{submission_id:sub,decision_id:'not-a-uuid'}, {submission_id:sub,decision_id:'30000000-0000-0000-0000-0000000000AA'}]){
   await sql('UPDATE memory.knowledge_evidence SET locator=$2 WHERE evidence_id=$1',[evidence,{source_provenance:{source_kind:'team_session',source_version:2,team_id:'team',team_session_id:'session',accepted_delivery}}])
   const p=await planPrivacyOverlay(scoped,options);expect(p.retainedClosure.unresolved).toContainEqual(expect.objectContaining({independent:true,table:'knowledge_evidence',rowKey:{evidence_id:evidence}}))
   await expect(applyPrivacyOverlay(scoped,p,options)).rejects.toThrow('retained_reference_forward_repair_required');await expect(verifyPrivacyOverlay(scoped,p,options)).rejects.toThrow('retained_reference_forward_repair_required')
  }
  // A severed native Session ref is a different policy: independent personal
  // acceptance does not require an invented original Session to remain live.
  await sql('UPDATE memory.knowledge_evidence SET locator=$2 WHERE evidence_id=$1',[evidence,{nested:{source_event_id:randomUUID()}}])
  const personal=await planPrivacyOverlay(scoped,options);expect(personal.retainedClosure.unresolved).toEqual([]);expect((await applyPrivacyOverlay(scoped,personal,options)).privacyCatchupReadyForReopen).toBe(true)
  expect((await sql('SELECT count(*)::text AS n FROM memory.knowledge_evidence_capsules WHERE capsule_id=$1',[cap])).rows[0].n).toBe('1')
 })
 test('unchanged personal filters still revoke a source when current daemon or agent applicability changes',async()=>{
  await sql("UPDATE public.extension_installations SET event_filter='{\"agent_types\":[\"codex\"]}' WHERE installation_id=$1;",[installation])
  await sql("UPDATE memory.memory_installations SET event_filter='{\"agent_types\":[\"codex\"]}' WHERE installation_id=$1",[installation])
  await sql("INSERT INTO public.sessions VALUES('filter-source',1,'daemon','codex','hot','opencode');INSERT INTO memory.source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES('"+installation+"','filter-source',now(),now())")
  const plan=await planPrivacyOverlay(config,options);expect(plan.sessions).toContainEqual({installationId:installation,sessionId:'filter-source',reason:'access_revoked'});await applyPrivacyOverlay(config,plan,options)
  expect((await sql("SELECT 1 FROM memory.memory_session_tombstones WHERE installation_id=$1 AND session_id='filter-source'",[installation])).rowCount).toBe(1)
 })
 test('copied Team binding/participant authority changes restrict only the exact source root',async()=>{
  const inst=randomUUID(),source=randomUUID(),team='scope-team',session='scope-team-session',call='scope-call',projection='team-projection'
  await sql(`ALTER TABLE public.users ADD COLUMN team_enabled boolean NOT NULL DEFAULT true;
   CREATE TABLE public.collaboration_teams(team_id text PRIMARY KEY,state text);
   CREATE TABLE public.collaboration_sessions(team_session_id text PRIMARY KEY,team_id text,state text);
   CREATE TABLE public.collaboration_calls(call_id text PRIMARY KEY,team_session_id text,state text,offer_id text,task_id text,context_version bigint);
   CREATE TABLE public.collaboration_session_participants(team_session_id text,user_id int,state text,revision bigint,PRIMARY KEY(team_session_id,user_id));
   CREATE TABLE public.collaboration_team_memberships(team_id text,user_id int,state text,PRIMARY KEY(team_id,user_id));
   CREATE TABLE public.team_memory_bindings(binding_id text PRIMARY KEY,team_id text,revision bigint,installation_id uuid,owner_scope_kind text,owner_scope_id uuid,state text);
   CREATE TABLE public.team_agent_offers(offer_id text PRIMARY KEY,daemon_id text);`)
  await sql("INSERT INTO public.extension_installations VALUES($1,'pocketctl-memory',1,'personal',$1,'active',1,1,ARRAY['session:events:read'],'{}',ARRAY['memory.manage'],'{}')",[inst])
  await sql("INSERT INTO memory.memory_installations(installation_id,provider_id,relay_status,local_status,config_version,granted_scopes,enabled_services) VALUES($1,'pocketctl-memory','active','ready',1,'[\"session:events:read\"]','[\"memory.manage\"]')",[inst])
  await sql("INSERT INTO memory.memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id) VALUES($1,'personal',$1)",[inst]);await sql("INSERT INTO shared.memory_source_modes(installation_id,mode) VALUES($1,'legacy-feed')",[inst])
  await sql("INSERT INTO public.collaboration_teams VALUES($1,'active');",[team]);await sql("INSERT INTO public.collaboration_sessions VALUES($1,$2,'active')",[session,team])
  await sql("INSERT INTO public.collaboration_calls VALUES($1,$2,'completed','scope-offer','scope-task',1)",[call,session]);await sql("INSERT INTO public.team_agent_offers VALUES('scope-offer','daemon')")
  await sql("INSERT INTO public.collaboration_session_participants VALUES($1,1,'active',1)",[session]);await sql("INSERT INTO public.collaboration_team_memberships VALUES($1,1,'active')",[team]);await sql("INSERT INTO public.team_memory_bindings VALUES('scope-binding',$1,1,$2,'personal',$2,'active')",[team,inst])
  for(const key of [projection,'unaffected-personal'])await sql('INSERT INTO memory.source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES($1,$2,now(),now())',[inst,key])
  await sql("INSERT INTO public.sessions VALUES('unaffected-personal',1,'daemon','codex','hot','codex')")
  const provenance={source_kind:'team_session',source_version:1,team_id:team,team_session_id:session,team_call_id:call,read_scope:{participant_user_id:1,participant_revision:1,team_memory_binding_id:'scope-binding',team_memory_binding_revision:1,target_installation_id:inst,target_owner_scope_kind:'personal',target_owner_scope_id:inst}}
  await sql("INSERT INTO memory.source_events(source_event_id,installation_id,origin,origin_position,session_id,event_type,occurred_at,payload,payload_hash,source_provenance) VALUES($1,$2,'feed','team-root',$3,'agent_text',now(),'{\"text\":\"private Team body\"}',decode(repeat('ab',32),'hex'),$4)",[source,inst,projection,provenance])
  const scoped={...config,installationIds:[inst]},copied=await planPrivacyOverlay(scoped,options)
  expect(copied.teamAuthority).toContainEqual(expect.objectContaining({root:projection,state:'current'}));expect(copied.sessions).toEqual([])
  await sql("UPDATE public.team_memory_bindings SET revision=2 WHERE binding_id='scope-binding'")
  await expect(applyPrivacyOverlay(scoped,copied,options)).rejects.toThrow('overlay_facts_drift')
  const changed=await planPrivacyOverlay(scoped,options);expect(changed.sessions).toEqual([{installationId:inst,sessionId:projection,reason:'access_revoked'}]);await applyPrivacyOverlay(scoped,changed,options)
  expect((await sql("SELECT count(*)::text AS n FROM memory.memory_session_tombstones WHERE installation_id=$1 AND session_id='unaffected-personal'",[inst])).rows[0].n).toBe('0')
  expect((await sql('SELECT local_status FROM memory.memory_installations WHERE installation_id=$1',[inst])).rows[0].local_status).toBe('ready')
  await sql("UPDATE public.team_memory_bindings SET revision=1 WHERE binding_id='scope-binding';UPDATE public.collaboration_calls SET state='running' WHERE call_id='scope-call'")
  const running=await planPrivacyOverlay(scoped,options);expect(running.teamAuthority).toContainEqual(expect.objectContaining({root:projection,state:'revoked'}));expect(running.sessions).toEqual([{installationId:inst,sessionId:projection,reason:'access_revoked'}]);await applyPrivacyOverlay(scoped,running,options)
  expect((await sql("SELECT count(*)::text AS n FROM memory.memory_session_tombstones WHERE installation_id=$1 AND session_id='unaffected-personal'",[inst])).rows[0].n).toBe('0')
  await sql("UPDATE public.collaboration_calls SET state='uncertain' WHERE call_id='scope-call'")
  const uncertain=await planPrivacyOverlay(scoped,options);expect(uncertain.teamAuthority).toContainEqual(expect.objectContaining({root:projection,state:'revoked'}))
  await sql("UPDATE public.collaboration_calls SET state='completed' WHERE call_id='scope-call';DELETE FROM public.collaboration_session_participants WHERE team_session_id='scope-team-session'")
  const removed=await planPrivacyOverlay(scoped,options);expect(removed.teamAuthority).toContainEqual(expect.objectContaining({root:projection,state:'revoked'}));expect(removed.sessions).toContainEqual({installationId:inst,sessionId:projection,reason:'access_revoked'})
 })
 test('late accepted submission and spec metadata writes cannot cross the overlay commit boundary',async()=>{
  const inst=randomUUID(),source=randomUUID(),sub=randomUUID(),decisionId=randomUUID(),team='late-team',teamSession='late-team-session',call='late-call',binding='late-binding'
  const projection='team_delivery_'+createHash('sha256').update(JSON.stringify(['team-accepted-delivery-v2',teamSession,sub,decisionId,binding,1,1,1])).digest('hex').slice(0,32)
  await sql(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS team_enabled boolean NOT NULL DEFAULT true;
   CREATE TABLE IF NOT EXISTS public.collaboration_teams(team_id text PRIMARY KEY,state text);
   CREATE TABLE IF NOT EXISTS public.collaboration_sessions(team_session_id text PRIMARY KEY,team_id text,state text);
   CREATE TABLE IF NOT EXISTS public.collaboration_calls(call_id text PRIMARY KEY,team_session_id text,state text,offer_id text,task_id text,context_version bigint);
   CREATE TABLE IF NOT EXISTS public.collaboration_session_participants(team_session_id text,user_id int,state text,revision bigint,PRIMARY KEY(team_session_id,user_id));
   CREATE TABLE IF NOT EXISTS public.collaboration_team_memberships(team_id text,user_id int,state text,PRIMARY KEY(team_id,user_id));
   CREATE TABLE IF NOT EXISTS public.team_memory_bindings(binding_id text PRIMARY KEY,team_id text,revision bigint,installation_id uuid,owner_scope_kind text,owner_scope_id uuid,state text);
   CREATE TABLE IF NOT EXISTS public.team_agent_offers(offer_id text PRIMARY KEY,daemon_id text);
   CREATE TABLE public.team_task_specs(task_id text,revision bigint,reviewer_user_id int,PRIMARY KEY(task_id,revision));
   CREATE TABLE public.team_task_submissions(submission_id uuid PRIMARY KEY,task_id text,spec_revision bigint,state text,source_call_id text,source_offer_id text,context_version bigint);
   CREATE TABLE public.team_acceptance_decisions(decision_id uuid PRIMARY KEY,submission_id uuid,decision text,task_id text,spec_revision bigint,reviewer_user_id int);
   ALTER TABLE public.team_delivery_memory_sources ADD COLUMN binding_id text,ADD COLUMN binding_revision bigint,ADD COLUMN participant_revision bigint,ADD COLUMN reader_user_id int;`)
  await sql("INSERT INTO public.extension_installations VALUES($1,'pocketctl-memory',1,'personal',$1,'active',1,1,ARRAY['session:events:read'],'{}',ARRAY['memory.manage'],'{}')",[inst]);await sql("INSERT INTO memory.memory_installations(installation_id,provider_id,relay_status,local_status,config_version,granted_scopes,enabled_services) VALUES($1,'pocketctl-memory','active','ready',1,'[\"session:events:read\"]','[\"memory.manage\"]')",[inst]);await sql("INSERT INTO memory.memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id) VALUES($1,'personal',$1)",[inst]);await sql("INSERT INTO shared.memory_source_modes(installation_id,mode) VALUES($1,'legacy-feed')",[inst])
  await sql("INSERT INTO public.collaboration_teams VALUES($1,'active')",[team]);await sql("INSERT INTO public.collaboration_sessions VALUES($1,$2,'active')",[teamSession,team]);await sql("INSERT INTO public.collaboration_calls VALUES($1,$2,'running','late-offer','late-task',1)",[call,teamSession]);await sql("INSERT INTO public.team_agent_offers VALUES('late-offer','daemon')");await sql("INSERT INTO public.collaboration_session_participants VALUES($1,1,'active',1)",[teamSession]);await sql("INSERT INTO public.collaboration_team_memberships VALUES($1,1,'active')",[team]);await sql("INSERT INTO public.team_memory_bindings VALUES($1,$2,1,$3,'personal',$3,'active')",[binding,team,inst])
  await sql("INSERT INTO public.team_task_specs VALUES('late-task',1,1)");await sql("INSERT INTO public.team_task_submissions VALUES($1,'late-task',1,'published',$2,'late-offer',1)",[sub,call]);await sql("INSERT INTO public.team_acceptance_decisions VALUES($1,$2,'accepted','late-task',1,1)",[decisionId,sub]);await sql('INSERT INTO public.team_delivery_memory_sources(source_session_id,team_id,team_session_id,submission_id,decision_id,binding_id,binding_revision,participant_revision,reader_user_id) VALUES($1,$2,$3,$4,$5,$6,1,1,1)',[projection,team,teamSession,sub,decisionId,binding])
  await sql('INSERT INTO memory.source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES($1,$2,now(),now())',[inst,projection])
  const provenance={source_kind:'team_session',source_version:2,team_id:team,team_session_id:teamSession,team_call_id:call,accepted_delivery:{submission_id:sub,decision_id:decisionId},read_scope:{participant_user_id:1,participant_revision:1,team_memory_binding_id:binding,team_memory_binding_revision:1,target_installation_id:inst,target_owner_scope_kind:'personal',target_owner_scope_id:inst}}
  await sql("INSERT INTO memory.source_events(source_event_id,installation_id,origin,origin_position,session_id,event_type,occurred_at,payload,payload_hash,source_provenance) VALUES($1,$2,'feed','accepted-root',$3,'agent_text',now(),'{\"text\":\"accepted source body\"}',decode(repeat('ab',32),'hex'),$4)",[source,inst,projection,provenance])
  const scoped={...config,installationIds:[inst]},plan=await planPrivacyOverlay(scoped,options)
  // v2 acceptance is independent of the original call being running; v1 is not.
  expect(plan.teamAuthority).toContainEqual(expect.objectContaining({root:projection,state:'current'}));expect(plan.sessions).toEqual([])
  const writerRole='w4_public_writer_'+process.pid;await sql('CREATE ROLE '+writerRole+" LOGIN PASSWORD 'synthetic-only'");await sql('GRANT USAGE ON SCHEMA public TO '+writerRole+';GRANT SELECT,UPDATE ON public.team_task_submissions,public.team_task_specs,public.team_acceptance_decisions TO '+writerRole)
  const writerUrl=new URL(url!);writerUrl.username=writerRole;writerUrl.password='synthetic-only';const writer=new pg.Client({connectionString:writerUrl.toString()});await writer.connect()
  let probed=false;const query=pg.Client.prototype.query
  const wire=vi.spyOn(pg.Client.prototype,'query').mockImplementation(function(this:pg.Client,...args:any[]):any{
   if(!probed&&String(args[0])==='COMMIT')return (async()=>{
    probed=true
    for(const [statement,params] of [["UPDATE public.team_task_submissions SET context_version=2 WHERE submission_id=$1",[sub]],["UPDATE public.team_task_specs SET reviewer_user_id=2 WHERE task_id='late-task' AND revision=1",[]],["UPDATE public.team_acceptance_decisions SET reviewer_user_id=2 WHERE decision_id=$1",[decisionId]]] as [string,unknown[]][]){await writer.query('BEGIN');await writer.query("SET LOCAL lock_timeout='100ms'");await expect(writer.query(statement,params)).rejects.toMatchObject({code:'55P03'});await writer.query('ROLLBACK')}
    return (query as any).apply(this,args)
   })()
   return (query as any).apply(this,args)
  } as any)
  try{
   expect((await rawApplyPrivacyOverlay(scoped,plan,options)).barrierApplied).toBe(true);expect(probed).toBe(true);expect((await rawVerifyPrivacyOverlay(scoped,plan,options)).barrierApplied).toBe(true)
  }finally{wire.mockRestore();await writer.end();await sql('REVOKE ALL ON public.team_task_submissions,public.team_task_specs,public.team_acceptance_decisions FROM '+writerRole+';REVOKE ALL ON SCHEMA public FROM '+writerRole+';DROP ROLE '+writerRole)}
  expect((await sql('SELECT context_version::text FROM public.team_task_submissions WHERE submission_id=$1',[sub])).rows[0].context_version).toBe('1');expect((await sql("SELECT reviewer_user_id FROM public.team_task_specs WHERE task_id='late-task'")).rows[0].reviewer_user_id).toBe(1)
 })
 test('only allowlisted nested references are traversed; unresolved exact bundle identity refuses apply without exposing text',async()=>{
  const bundle=randomUUID(),missing=randomUUID(),decoy=randomUUID()
  await sql("INSERT INTO memory.memory_task_bundles(installation_id,bundle_id,task_key,session_id,source_digest,watermark,spans) VALUES($1,$2,'retained-reference','session',decode(repeat('ab',32),'hex'),0,$3)",[installation,bundle,JSON.stringify([{quote:'private locator text '+decoy}])])
  try{
   const plain=await planPrivacyOverlay(config,options);expect(plain.retainedClosure.unresolved).toEqual([]);expect(JSON.stringify(plain)).not.toContain('private locator text');expect(JSON.stringify(plain)).not.toContain(decoy)
   await sql('UPDATE memory.memory_task_bundles SET spans=$3 WHERE installation_id=$1 AND bundle_id=$2',[installation,bundle,JSON.stringify([{nested:{source_event_ids:[missing]},quote:'private locator text '+decoy}])])
   await expect(applyPrivacyOverlay(config,plain,options)).rejects.toThrow('overlay_facts_drift')
   const current=await planPrivacyOverlay(config,options);expect(current.retainedClosure.unresolved).toContainEqual(expect.objectContaining({table:'memory_task_bundles',rowKey:{installation_id:installation,bundle_id:bundle},sourceEventId:missing,independent:false}))
   expect(JSON.stringify(current)).not.toContain('private locator text');await expect(applyPrivacyOverlay(config,current,options)).rejects.toThrow('retained_reference_forward_repair_required')
   expect((await sql('SELECT body_state FROM memory.memory_task_bundles WHERE installation_id=$1 AND bundle_id=$2',[installation,bundle])).rows[0].body_state).toBe('present')
  }finally{await sql('DELETE FROM memory.memory_task_bundles WHERE installation_id=$1 AND bundle_id=$2',[installation,bundle])}
 })
 test('revocation/config/scope changes block only reviewed installation and never reopen or reset costs',async()=>{
  const p=await planPrivacyOverlay(config,options)
  await sql('UPDATE public.extension_installations SET config_version=9007199254740993 WHERE installation_id=$1',[installation])
  await expect(verifyPrivacyOverlay(config,p,options)).rejects.toThrow('overlay_facts_drift')
  const fresh=await planPrivacyOverlay(config,options);expect(fresh.installations).toEqual([{installationId:installation,reason:'authority_changed'}])
  const applied=await applyPrivacyOverlay(config,fresh,options);expect(applied.privacyCatchupReadyForReopen).toBe(false)
  expect((await sql('SELECT local_status FROM memory.memory_installations WHERE installation_id=$1',[installation])).rows[0].local_status).toBe('integrity_error')
  await applyPrivacyOverlay(config,fresh,options)
  await expect(applyPrivacyOverlay({...config,installationIds:[...config.installationIds,'10000000-0000-0000-0000-000000000065']},fresh,options)).rejects.toThrow('overlay_scope_drift')
 })
 test('current member revocation and parent/scope changes fence only their exact team installation',async()=>{
  const teamInstallation='10000000-0000-0000-0000-000000000066',team='10000000-0000-0000-0000-000000000067',organization='10000000-0000-0000-0000-000000000068',member='10000000-0000-0000-0000-000000000069'
  await sql("INSERT INTO public.extension_organizations VALUES('"+organization+"','active',1);INSERT INTO public.extension_teams VALUES('"+team+"','"+organization+"','active',1)")
  await sql("INSERT INTO public.extension_installations VALUES('"+teamInstallation+"','pocketctl-memory',1,'team','"+team+"','active',1,1,'{}','{}','{}','{}')")
  await sql("INSERT INTO memory.memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES('"+teamInstallation+"','pocketctl-memory','active','ready',1)")
  await sql("INSERT INTO memory.memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id,parent_organization_id) VALUES('"+teamInstallation+"','team','"+team+"','"+organization+"')")
  await sql("INSERT INTO memory.memory_scope_memberships(installation_id,membership_id,roles) VALUES('"+teamInstallation+"','"+member+"',ARRAY['viewer']);INSERT INTO public.extension_scope_memberships VALUES('"+member+"','team','"+team+"',1,ARRAY['viewer'],'revoked',2)")
  const unaffectedMember=randomUUID();await sql('INSERT INTO public.users(id) VALUES(2)');await sql("INSERT INTO memory.memory_scope_memberships(installation_id,membership_id,roles) VALUES($1,$2,ARRAY['reader'])",[teamInstallation,unaffectedMember]);await sql("INSERT INTO public.extension_scope_memberships VALUES($1,'team',$2,2,ARRAY['reader'],'active',1)",[unaffectedMember,team]);
  const scoped={...config,installationIds:[teamInstallation]},p=await planPrivacyOverlay(scoped,options)
  expect(p.memberBarriers).toEqual([{installationId:teamInstallation,membershipId:member}]);expect(p.installations).toEqual([]);await applyPrivacyOverlay(scoped,p,options);expect((await sql('SELECT state FROM memory.memory_scope_memberships WHERE installation_id=$1 AND membership_id=$2',[teamInstallation,unaffectedMember])).rows[0].state).toBe('active');expect((await sql('SELECT local_status FROM memory.memory_installations WHERE installation_id=$1',[teamInstallation])).rows[0].local_status).toBe('ready')
  await sql("UPDATE public.extension_teams SET state='suspended' WHERE team_id='"+team+"'")
  await expect(verifyPrivacyOverlay(scoped,p,options)).rejects.toThrow('overlay_facts_drift')
  const scopePlan=await planPrivacyOverlay(scoped,options);expect(scopePlan.scopeBarriers).toEqual([{installationId:teamInstallation,kind:'team',scopeId:team,epoch:'1'}]);await applyPrivacyOverlay(scoped,scopePlan,options);await applyPrivacyOverlay(scoped,scopePlan,options);expect((await verifyPrivacyOverlay(scoped,scopePlan,options)).barrierApplied).toBe(true)
 })
 test('actual CLI plan publishes only private reports, refuses overwrite and starts no application',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'w4-maintenance-')),output=join(dir,'plan'),path=join(dir,'config.json')
  const {url:_,...database}=config.database
  await writeFile(path,JSON.stringify({...config,database}),{mode:0o600})
  await writeFile(join(dir,'systemctl'),'#!'+process.execPath+'\nprocess.stdout.write("LoadState=loaded\\nActiveState=inactive\\nSubState=dead\\nMainPID=0\\n")\n',{mode:0o700})
  vi.stubEnv('PATH',dir+':'+process.env.PATH);vi.stubEnv('SHARED_MAINTENANCE_URL',url!)
  try{
   expect(await main(['overlay','plan','--config',path,'--output',output])).toBe(0)
   const manifestFile=join(output,'maintenance-manifest.json')
   expect((await stat(manifestFile)).mode&0o777).toBe(0o600)
   const before=await readFile(manifestFile,'utf8');expect(before).not.toContain('accepted survives');expect(before).not.toContain('canonical body');expect(before).not.toContain('synthetic-only')
   expect(await main(['overlay','plan','--config',path,'--output',output])).toBe(2)
   expect(await readFile(manifestFile,'utf8')).toBe(before)
  }finally{vi.unstubAllEnvs();await rm(dir,{recursive:true,force:true})}
 })
 test('cancellation and open activation refuse before mutation; current unknown facts remain closed',async()=>{
  const p=await planPrivacyOverlay(config,options),controller=new AbortController();controller.abort()
  await expect(applyPrivacyOverlay(config,p,{...options,signal:controller.signal})).rejects.toThrow('maintenance_interrupted')
  await sql('UPDATE shared.memory_source_contract SET activation_ready=true')
  await expect(applyPrivacyOverlay(config,p,options)).rejects.toThrow('target_source_activation_open');await sql('UPDATE shared.memory_source_contract SET activation_ready=false')
  await sql("INSERT INTO memory.source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES('"+installation+"','unknown',now(),now())")
  await expect(planPrivacyOverlay(config,options)).rejects.toThrow('overlay_session_authority_unknown')
 })
})
