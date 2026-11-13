import pg from 'pg'
import {randomUUID} from 'node:crypto'
import {beforeAll,afterAll,describe,test,expect} from 'vitest'
import {directLaunchFixture,type DirectLaunchFixture} from './direct-launch-fixture.js'
import {collectPersonalDirectClosure} from '../../migrations/shared-forward/personal-direct-closure.js'
import {collectRetainedClosure} from '../../migrations/shared-forward/source-maintenance-retained.js'
import {planPersonalDirectPrivacy,applyPersonalDirectPrivacy,verifyPersonalDirectPrivacy,type PersonalDirectPrivacyConfig} from '../../migrations/shared-forward/personal-direct-privacy.js'
import {memoryForwardTableRoster} from '../../migrations/shared-forward/copy-schema-roster.js'
const url=process.env.PERSONAL_CLOSURE_TEST_DATABASE_URL,sourceUrl=process.env.PERSONAL_CLOSURE_SOURCE_TEST_DATABASE_URL,suite=url||sourceUrl?describe:describe.skip
suite('finite personal direct-launch metadata closure',()=>{
 let f:DirectLaunchFixture,c:pg.PoolClient,personal:string,organization:string,session:string,event:string,artifact:string,closed=false
 const scope=()=>({personalInstallationId:personal,organizationInstallationId:organization})
 beforeAll(async()=>{
  if(!url||!sourceUrl)throw Error('dedicated_personal_closure_fixture_required')
  const sourceAddress=new URL(sourceUrl),targetAddress=new URL(url)
  if(sourceAddress.host!==targetAddress.host||sourceAddress.username!=='postgres'||sourceAddress.pathname!=='/shared_personal_closure_source_test'||sourceAddress.search||sourceAddress.hash)throw Error('dedicated_personal_closure_fixture_required')
  const admin=new URL(url!);admin.username='postgres';admin.password='synthetic-only'
  const saved=process.env.DIRECT_LAUNCH_FIXTURE_ADMIN_DATABASE_URL;process.env.DIRECT_LAUNCH_FIXTURE_ADMIN_DATABASE_URL=admin.href
  try{f=await directLaunchFixture(url!,{personalClosure:true})}finally{if(saved===undefined)delete process.env.DIRECT_LAUNCH_FIXTURE_ADMIN_DATABASE_URL;else process.env.DIRECT_LAUNCH_FIXTURE_ADMIN_DATABASE_URL=saved}
  c=await f.pool.connect()
  const s=await f.source();session=s.session;personal=(await f.install(s,'retained_history')).inst.installation_id;organization=randomUUID()
  await c.query("INSERT INTO memory.memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[organization])
  await c.query("INSERT INTO memory.memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id,state) VALUES($1,'personal',$1,'active'),($2,'organization',$2,'active')",[personal,organization])
  await c.query("INSERT INTO memory.source_events(source_event_id,installation_id,origin,origin_position,session_id,event_type,occurred_at,payload,payload_hash,source_provenance) SELECT md5('finite-source-'||n)::uuid,$1,'feed',n::text,$2,'agent_text',now(),jsonb_build_object('text','private original content'),decode(repeat('ab',32),'hex'),jsonb_build_object('memory',jsonb_build_object('session_id',$2::text)) FROM generate_series(1,4097) n",[personal,session])
  event=(await c.query('SELECT source_event_id::text FROM memory.source_events ORDER BY source_event_id LIMIT 1')).rows[0].source_event_id
  artifact=randomUUID();await c.query("INSERT INTO memory.source_artifacts(artifact_id,installation_id,session_id,source_event_id,artifact_type,identity_key,occurred_at,details) VALUES($1,$2,$3,$4,'file_change','synthetic-file',now(),'{\"tool\":\"edit\",\"lines_added\":1}')",[artifact,personal,session,event])
  const bundle=randomUUID(),run=randomUUID()
  await c.query("INSERT INTO memory.memory_task_bundles(installation_id,bundle_id,session_id,task_key,source_digest,watermark,state) VALUES($1,$2,$3,'finite-curation',decode(repeat('ab',32),'hex'),1,'completed')",[personal,bundle,session])
  await c.query("INSERT INTO memory.memory_curation_runs(installation_id,run_id,bundle_id,bundle_revision,source_digest,policy_revision,policy_hash,model_config_hash,mode,state,result) VALUES($1,$2,$3,1,decode(repeat('ab',32),'hex'),1,repeat('a',64),repeat('b',64),'enabled','completed',NULL)",[personal,run,bundle])
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
 },60000)
 afterAll(async()=>{if(!closed){if(c){await c.query('ROLLBACK');c.release()}await f?.close()}})
 test('keeps the general 4096 guard while verifying a larger finite channel without exporting bodies',async()=>{
  await expect(collectRetainedClosure(c,[personal,organization])).rejects.toThrow('retained_closure_limit')
  const result=await collectPersonalDirectClosure(c,scope());expect(result.roots).toEqual([{installationId:personal,sessionId:session}]);expect(result.unresolved).toEqual([]);expect(result.deliveries).toEqual([]);expect(JSON.stringify(result)).not.toContain('private original content')
  expect((await collectPersonalDirectClosure(c,scope())).fingerprint).toBe(result.fingerprint)
 })
 test('checks each scalar and array alias independently and rejects malformed named references',async()=>{
  for(const details of [{source_event_id:event,sourceEventId:randomUUID()},{source_event_ids:[event],sourceEventIds:[randomUUID()]},{source_event_id:{nested:event}},{session_ids:[session]},{source_event_id:33}]){
   await c.query('UPDATE memory.source_artifacts SET details=$2 WHERE artifact_id=$1',[artifact,details]);await expect(collectPersonalDirectClosure(c,scope())).rejects.toThrow('personal_direct_reference_unproven')
  }
  await c.query("UPDATE memory.source_artifacts SET details='{\"tool\":\"edit\"}' WHERE artifact_id=$1",[artifact])
 })
 test('does not accept cross-installation FK handles, arbitrary session roots, or Team provenance',async()=>{
  for(const details of [{session_id:'not-a-retained-root'},{source_kind:'team_session',source_version:2},{team:{team_id:'unknown'}}]){
   await c.query('UPDATE memory.source_artifacts SET details=$2 WHERE artifact_id=$1',[artifact,details]);await expect(collectPersonalDirectClosure(c,scope())).rejects.toThrow('personal_direct_reference_unproven')
  }
  await c.query("UPDATE memory.source_artifacts SET details='{}',installation_id=$2 WHERE artifact_id=$1",[artifact,organization]);await expect(collectPersonalDirectClosure(c,scope())).rejects.toThrow('personal_direct_organization_history_not_empty')
  await c.query('UPDATE memory.source_artifacts SET installation_id=$2 WHERE artifact_id=$1',[artifact,personal])
  const other=randomUUID(),foreign=randomUUID();await c.query("INSERT INTO memory.memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[other])
  await c.query("INSERT INTO memory.source_events(source_event_id,installation_id,origin,origin_position,session_id,event_type,occurred_at,payload,payload_hash) VALUES($1,$2,'feed','99999',$3,'agent_text',now(),'{}',decode(repeat('ab',32),'hex'))",[foreign,other,session])
  await c.query('UPDATE memory.source_artifacts SET details=$2 WHERE artifact_id=$1',[artifact,{source_event_id:foreign}]);await expect(collectPersonalDirectClosure(c,scope())).rejects.toThrow('personal_direct_reference_unproven')
  await c.query("UPDATE memory.source_artifacts SET details='{}' WHERE artifact_id=$1",[artifact])
 })
 test('fingerprints original metadata changes without manufacturing lineage and bounds scope/cancellation',async()=>{
  const before=await collectPersonalDirectClosure(c,scope());await c.query("UPDATE memory.source_artifacts SET details='{\"tool\":\"read\"}' WHERE artifact_id=$1",[artifact]);expect((await collectPersonalDirectClosure(c,scope())).fingerprint).not.toBe(before.fingerprint)
  await expect(collectPersonalDirectClosure(c,{personalInstallationId:personal,organizationInstallationId:personal})).rejects.toThrow('personal_direct_scope_invalid')
  const ac=new AbortController();ac.abort();await expect(collectPersonalDirectClosure(c,scope(),{signal:ac.signal})).rejects.toThrow('personal_direct_interrupted')
 })
 test('applies a bounded restrictive overlay while retaining missing original cells and rechecks current revocation',async()=>{
  await c.query('COMMIT');await c.query('BEGIN')
  await c.query("INSERT INTO public.extension_organizations(organization_id,name) VALUES($1,'preserved finite organization')",[organization])
  await c.query("INSERT INTO public.extension_installations(installation_id,provider_id,owner_scope_kind,owner_scope_id,status,granted_scopes,subscriptions,enabled_services,start_policy) VALUES($1,'pocketctl-memory','organization',$1,'active',ARRAY[]::text[],ARRAY['scope.lifecycle.v2','scope.membership.v2','scope.installation.v2'],ARRAY['memory.search','memory.manage'],'from_now')",[organization])
  await c.query("UPDATE memory.memory_installations m SET granted_scopes=to_jsonb(i.granted_scopes),subscriptions=to_jsonb(i.subscriptions),enabled_services=to_jsonb(i.enabled_services),event_filter=i.event_filter,config_version=i.config_version FROM public.extension_installations i WHERE m.installation_id=i.installation_id")
  await c.query("UPDATE shared.memory_source_modes SET mode='legacy-feed';UPDATE shared.memory_source_contract SET activation_ready=false")
  await c.query("INSERT INTO shared.memory_source_modes(installation_id,mode) VALUES($1,'legacy-feed')",[organization])
  await c.query("INSERT INTO memory.source_events(source_event_id,installation_id,origin,origin_position,session_id,event_type,occurred_at,payload,payload_hash) SELECT md5('missing-finite-'||n)::uuid,$1,'feed',(100000+n)::text,'missing-session','agent_text',now(),'{\"text\":\"private retained missing bytes\"}',decode(repeat('ab',32),'hex') FROM generate_series(1,3) n",[personal])
  await c.query("INSERT INTO memory.source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES($1,'deleted-session',now(),now())",[personal])
  await c.query("INSERT INTO public.deleted_sessions(session_id) VALUES('deleted-session')")
  await c.query('ALTER ROLE personal_closure_memory NOLOGIN;ALTER ROLE personal_closure_relay NOLOGIN;ALTER ROLE shared_personal_closure_test NOLOGIN')
  const expected=(await c.query(`SELECT current_database() AS database,current_user AS role,d.oid::text AS "databaseOid",inet_server_addr()::text AS "serverAddress",inet_server_port()::text AS "serverPort" FROM pg_database d WHERE datname=current_database()`)).rows[0]
  const admin=new URL(url!);admin.username='postgres';admin.password='synthetic-only'
  const config:PersonalDirectPrivacyConfig={database:{url:admin.href,expected},installationIds:[personal,organization],scope:scope(),units:{api:'synthetic-api.service',worker:'synthetic-worker.service',freshInstall:false}}
  let probes=0
  const options={probe:async()=>{probes++;return {api:{LoadState:'loaded',ActiveState:'inactive',SubState:'dead',MainPID:'0'},worker:{LoadState:'loaded',ActiveState:'inactive',SubState:'dead',MainPID:'0'},observedAt:new Date().toISOString()}}}
  const before=(await c.query("SELECT encode(sha256(convert_to(jsonb_agg(to_jsonb(s) ORDER BY source_event_id)::text,'UTF8')),'hex') AS hash FROM memory.source_events s")).rows[0].hash
  await c.query('COMMIT');c.release();await f.close();closed=true
  const sql=async(text:string,params?:unknown[])=>{const db=new pg.Client({connectionString:admin.href});await db.connect();try{return await db.query(text,params)}finally{await db.end()}}
  const plan=await planPersonalDirectPrivacy(config,options);expect(plan.sessions).toEqual([{installationId:personal,sessionId:'deleted-session',reason:'user_deleted'},{installationId:personal,sessionId:'missing-session',reason:'access_revoked'}])
  expect(JSON.stringify(plan)).not.toContain('private retained missing bytes');await expect(verifyPersonalDirectPrivacy(config,plan,options)).rejects.toThrow('personal_direct_barrier_missing')
  await expect(applyPersonalDirectPrivacy(config,plan,{...options,beforeCommit:async()=>{await sql("UPDATE public.extension_providers SET status='disabled' WHERE provider_id='pocketctl-memory'")}})).rejects.toThrow('personal_direct_current_control_repair_required')
  expect((await sql('SELECT count(*)::int AS n FROM memory.memory_session_tombstones')).rows[0].n).toBe(0)
  await sql("UPDATE public.extension_providers SET status='enabled' WHERE provider_id='pocketctl-memory'")
  const beforeApplyProbes=probes
  expect(await applyPersonalDirectPrivacy(config,plan,options)).toMatchObject({restrictedRoots:2,retainedOriginalSourceRows:'3',currentRestrictionsVerified:true,sourceBodiesChanged:false,deletionAuthorized:false,canonicalAbsenceProven:false})
  expect(probes-beforeApplyProbes).toBe(2)
  expect(await verifyPersonalDirectPrivacy(config,plan,options)).toMatchObject({restrictedRoots:2,currentRestrictionsVerified:true,reopeningReady:false})
  expect(await applyPersonalDirectPrivacy(config,plan,options)).toMatchObject({retainedOriginalSourceRows:'3'})
  expect((await sql("SELECT encode(sha256(convert_to(jsonb_agg(to_jsonb(s) ORDER BY source_event_id)::text,'UTF8')),'hex') AS hash FROM memory.source_events s")).rows[0].hash).toBe(before)
  // A separate disposable DB reproduces the original namespace and exact
  // additive schema84 table roster. Copy SQL JSON opaquely, not JS numbers.
  const original=new pg.Client({connectionString:sourceUrl}),read=new pg.Client({connectionString:admin.href})
  await original.connect();await read.connect()
  try{
   const identity=(await original.query("SELECT current_database() AS database_name,current_user AS role_name,to_regclass('public.memory_schema_migrations') IS NULL AS fresh")).rows[0]
   if(identity.database_name!=='shared_personal_closure_source_test'||identity.role_name!=='postgres'||!identity.fresh)throw Error('dedicated_personal_closure_fixture_required')
   for(const table of memoryForwardTableRoster(84)){
    const columns=(await read.query("SELECT attname,format_type(atttypid,atttypmod) AS type FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum",['memory.'+table])).rows
    const pk=(await read.query("SELECT a.attname FROM pg_index i CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,n) JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum WHERE i.indrelid=$1::regclass AND i.indisprimary ORDER BY k.n",['memory.'+table])).rows
    const q=(v:string)=>'"'+v.replaceAll('"','""')+'"'
    await original.query('CREATE TABLE public.'+q(table)+'('+columns.map(col=>q(col.attname)+' '+col.type).join(',')+(pk.length?',PRIMARY KEY('+pk.map(k=>q(k.attname)).join(',')+')':'')+')')
    const rows=(await read.query('SELECT row_to_json(t)::text AS json FROM memory.'+q(table)+' t')).rows
    for(let n=0;n<rows.length;n+=128)await original.query('INSERT INTO public.'+q(table)+' SELECT * FROM json_populate_recordset(NULL::public.'+q(table)+',$1::json)',['['+rows.slice(n,n+128).map(r=>r.json).join(',')+']'])
   }
   await original.query('TRUNCATE public.memory_schema_migrations;INSERT INTO public.memory_schema_migrations(version) VALUES(84)')
   await expect(collectPersonalDirectClosure(original,scope(),{databaseLayout:'original-schema84'})).rejects.toThrow('personal_direct_original_schema_invalid')
   await original.query('CREATE TABLE public.unreviewed_extra_table(id int PRIMARY KEY)');await original.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
   await expect(collectPersonalDirectClosure(original,scope(),{databaseLayout:'original-schema84'})).rejects.toThrow('personal_direct_original_schema_invalid')
   await original.query('ROLLBACK');await original.query('DROP TABLE public.unreviewed_extra_table')
   await original.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
   const old=await collectPersonalDirectClosure(original,scope(),{databaseLayout:'original-schema84'}),copied=plan
   expect(old).toMatchObject({databaseLayout:'original-schema84',roots:copied.closure.roots,channels:copied.closure.channels,capsules:copied.closure.capsules})
   await original.query('ROLLBACK')
  }finally{await original.end();await read.end()}
 },45000)
})
