import pg from 'pg'
import {mkdtemp,writeFile,rm,stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawn,spawnSync} from 'node:child_process'
import {afterAll,beforeAll,describe,expect,test,vi} from 'vitest'
import {MEMORY_MIGRATIONS,applyMemorySchema} from '../../schema.js'
import {applySharedSourceContract} from '../../migrations/shared-db/contract.js'
import {createMemoryPool} from '../../db.js'
import {provisionSharedDatabase} from '../../migrations/shared-db/namespace.js'
import {prepareMemoryStartup,verifyMemoryStartup} from '../../startup-schema.js'
import {planForwardMigration,applyForwardMigration,verifyForwardMigration,type ForwardConfig} from '../../migrations/shared-forward/engine.js'
const sourceUrl=process.env.SHARED_FORWARD_SOURCE_TEST_DATABASE_URL,targetUrl=process.env.SHARED_FORWARD_TARGET_TEST_DATABASE_URL
const suite=sourceUrl&&targetUrl?describe:describe.skip
suite('forward-only original-identity namespace migration',()=>{
 let source:pg.Pool,target:pg.Pool,config:ForwardConfig
 // A driver socket-close promise can resolve before the server has removed
 // its backend. Wait for actual fixture drain; production refusal stays strict.
 async function fixtureDrained(){
  // Observe from a third, synthetic administration DB. The target must have
  // no second superuser socket while the real writer fence/copy executes.
  const observerUrl=new URL(targetUrl!);observerUrl.pathname='/postgres'
  const observer=new pg.Client({connectionString:observerUrl.href})
  await observer.connect()
  try{
   await target.end();target=new pg.Pool({connectionString:config.target.url})
   for(let attempt=0;attempt<100;attempt++){
    if(!(await observer.query('SELECT 1 FROM pg_stat_activity WHERE datname=$1 OR(datname=$2 AND usename=$3) LIMIT 1',[new URL(sourceUrl!).pathname.slice(1),new URL(config.target.url).pathname.slice(1),new URL(config.target.url).username])).rowCount)return
    await new Promise(resolve=>setTimeout(resolve,20))
   }
   throw Error('isolated_source_backend_did_not_close')
  }finally{await observer.end()}
 }
 const planned=async(c:ForwardConfig)=>{await fixtureDrained();return planForwardMigration(c)}
 const capacity=(p:Parameters<typeof applyForwardMigration>[1])=>({schemaVersion:1 as const,kind:'memory-forward-capacity' as const,manifestHash:p.manifestHash,migrationId:p.migrationId,codeSha:p.codeSha,sourceIdentity:p.sourceIdentity,targetIdentity:p.targetIdentity,
  measuredAt:new Date(Date.now()-1000).toISOString(),validUntil:new Date(Date.now()+3500000).toISOString(),measurements:{policy:'forward-only' as const,existingAllocatedBytes:'100',freeBytes:'999999999999',targetBytes:'100',stagingBytes:'100',temporaryIndexBytes:'100',walBytes:'67108864',mappingBytes:'100',growthBytes:'100',copySeconds:'60',indexSeconds:'10',evidenceId:'synthetic:fixture-only'}})
 const applied=async(c:ForwardConfig,p:Parameters<typeof applyForwardMigration>[1],options?:Parameters<typeof applyForwardMigration>[2])=>{await fixtureDrained();return applyForwardMigration(c,p,{capacity:capacity(p),...options})}
 const verified=async(c:ForwardConfig,p:Parameters<typeof verifyForwardMigration>[1])=>{await fixtureDrained();return verifyForwardMigration(c,p)}
 const installation='10000000-0000-0000-0000-000000000090',id='20000000-0000-0000-0000-000000000090'
 beforeAll(async()=>{
  for(const raw of [sourceUrl,targetUrl])if(!raw||!/(^|_)test$/.test(new URL(raw).pathname.slice(1)))throw Error('isolated_test_required')
  source=new pg.Pool({connectionString:sourceUrl});target=new pg.Pool({connectionString:targetUrl})
  await source.query('DROP SCHEMA public CASCADE;CREATE SCHEMA public')
  await target.query('DROP SCHEMA IF EXISTS memory CASCADE;DROP SCHEMA IF EXISTS shared CASCADE;DROP SCHEMA public CASCADE;CREATE SCHEMA public')
  const nativeSource=new URL('../../../../relay/src/db.ts',import.meta.url),nativeBuild=new URL('../../../../relay/dist/db.js',import.meta.url)
  if((await stat(nativeSource)).mtimeMs>(await stat(nativeBuild)).mtimeMs)throw Error('forward_fixture_native_build_stale')
  const {initDB}=await import(nativeBuild.href);await initDB(target)
  await applyMemorySchema(source);await applyMemorySchema(target,{namespace:'memory'});await applySharedSourceContract(target)
  await target.query("CREATE TABLE public.forward_relay_sentinel(id bigint PRIMARY KEY,body text);INSERT INTO public.forward_relay_sentinel VALUES(9007199254740993,'canonical untouched')")
  const identity=async(p:pg.Pool)=>(await p.query(`SELECT current_database() AS database,current_user AS role,inet_server_addr()::text AS "serverAddress",inet_server_port()::text AS "serverPort"`)).rows[0]
  config={source:{url:sourceUrl!,expected:await identity(source)},target:{url:targetUrl!,expected:await identity(target)},migrationId:'30000000-0000-0000-0000-000000000090',codeSha:'a'.repeat(40),maxRowBytes:1024*1024,walCheckpointBytes:65536}
  const name=new URL(sourceUrl!).pathname.slice(1)
  await source.query('REVOKE CONNECT ON DATABASE '+name+' FROM PUBLIC')
  await source.query(`INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)`,[installation])
  await source.query("INSERT INTO source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES($1,'stable-session',now(),now())",[installation])
  await source.query(`INSERT INTO source_events(source_event_id,installation_id,origin,origin_position,session_id,event_type,occurred_at,payload,payload_hash,source_sequence,source_provenance)
   VALUES($1,$2,'feed','9007199254740993','stable-session','agent_text',now(),'{"integer":9007199254740993,"text":"private-original"}',decode(repeat('ab',32),'hex'),9007199254740994,'{"state":"unknown","opaque_ref":"original"}')`,[id,installation])
  // Cross the row-batch boundary while keeping SQL JSON numeric precision.
  await source.query(`INSERT INTO source_events(source_event_id,installation_id,origin,origin_position,session_id,event_type,occurred_at,payload,payload_hash)
   SELECT gen_random_uuid(),$1,'feed','batch-'||n,'stable-session','agent_text',now(),
    jsonb_build_object('integer',9007199254740993::bigint,'text','private-batch-'||n),decode(repeat('ab',32),'hex') FROM generate_series(1,129) n`,[installation])
  await source.query("UPDATE source_events SET payload=payload||jsonb_build_object('large',repeat('private-large-字\\n',8192)) WHERE source_event_id=$1",[id])
  const claim=(await source.query(`INSERT INTO knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state)
   VALUES(gen_random_uuid(),$1::uuid,'repository_convention','installation',$1::text,'generated-vector','active') RETURNING claim_id::text`,[installation])).rows[0].claim_id
  const version=(await source.query(`INSERT INTO knowledge_versions(version_id,installation_id,claim_id,version_number,statement,authority,confidence,freshness_at)
   VALUES(gen_random_uuid(),$1,$2,1,'private vector token','user_accepted',0.9,now()) RETURNING version_id::text`,[installation,claim])).rows[0].version_id
  await source.query('UPDATE knowledge_claims SET current_version_id=$2 WHERE claim_id=$1',[claim,version])
  await source.query("INSERT INTO claim_search_documents(installation_id,version_id,document) VALUES($1,$2,'private vector token')",[installation,version])
  await source.query("SELECT setval('memory_skill_replay_runs_sequence_seq',9007199254740995,false)")
  // Real governance cutover removed this global v1 index. A v2 claim can
  // legitimately share the old v1 identity with a different digest/generation.
  await source.query('DROP INDEX public.knowledge_claims_active_identity_variant_idx')
  await source.query(`INSERT INTO knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state,identity_generation,normalized_key_v2,topic_key_v2,duplicate_digest_v2)
   VALUES(gen_random_uuid(),$1::uuid,'repository_convention','installation',$1::text,'generated-vector','active',2,repeat('c',64),repeat('a',64),repeat('b',64))`,[installation])

  // Historical costs and uncertain effects are data, never authorization to
  // resume the provider or reset a reservation during namespace transfer.
  await source.query("INSERT INTO memory_feature_settings(installation_id,extraction_mode,embedding_mode) VALUES($1,'off','off')",[installation])
  await source.query(`INSERT INTO work_episodes(installation_id,episode_id,session_id,turn_id,state,compiler_version,source_digest)
   VALUES($1,'40000000-0000-0000-0000-000000000090','stable-session','uncertain-turn','ready','preserved',decode(repeat('c',64),'hex'))`,[installation])
  await source.query(`INSERT INTO memory_extraction_runs(run_id,installation_id,episode_id,episode_source_digest,extractor_version,prompt_version,model_config_hash,input_digest,mode,state,provider,model,error_code,input_tokens,output_tokens,cost_micros,started_at,completed_at)
   VALUES('50000000-0000-0000-0000-000000000090',$1,'40000000-0000-0000-0000-000000000090',decode(repeat('c',64),'hex'),'preserved','preserved',decode(repeat('d',64),'hex'),decode(repeat('e',64),'hex'),'enabled','failed','synthetic','synthetic','provider_result_unknown',9007199254740993,17,9007199254740994,'2026-11-01T01:02:03.123456Z','2026-11-01T01:02:04.654321Z')`,[installation])
  await source.query(`INSERT INTO memory_provider_budget_reservations(reservation_id,budget_key,provider_kind,state,reserved_input_tokens,reserved_output_tokens,actual_input_tokens,actual_output_tokens,created_at,settled_at)
   VALUES('60000000-0000-0000-0000-000000000090','forward-preserved','text','reserved',9007199254740993,23,0,0,'2026-11-01T01:02:03.123456Z',NULL),
    ('60000000-0000-0000-0000-000000000091','forward-preserved','text','settled',101,29,97,19,'2026-11-01T01:02:03.123456Z','2026-11-01T01:02:04.654321Z')`)
  await source.query(`INSERT INTO memory_usage_outbox(installation_id,usage_id,operation,model,input_tokens,output_tokens,cost_micros,occurred_at,attempts)
   VALUES($1,'forward-preserved','extraction','synthetic',9007199254740993,17,9007199254740994,'2026-11-01T01:02:04.654321Z',3)`,[installation])
  await source.query(`INSERT INTO memory_jobs(job_id,installation_id,job_type,idempotency_key,priority,payload,state,claim_epoch,last_error_code)
   VALUES('70000000-0000-0000-0000-000000000090',$1,'extract_candidates','forward-preserved',85,
    '{"episode_id":"40000000-0000-0000-0000-000000000090","run_id":"50000000-0000-0000-0000-000000000090","opaque_number":9007199254740993}','dead',9007199254740995,'provider_result_unknown')`,[installation])
  await source.query(`INSERT INTO memory_governance_events(event_id,installation_id,action,target_kind,target_id,previous_state,next_state,metadata,created_at)
   VALUES('80000000-0000-0000-0000-000000000090',$1,'migration-fixture','claim',$2,'pending','reviewed','{"preserve_epoch":9007199254740993,"source_provenance":"unknown"}','2026-11-01T01:02:03.123456Z')`,[installation,claim])
  // Pools must release their idle connections before the source drain check.
  await source.end();source=new pg.Pool({connectionString:sourceUrl})
 },60000)
 afterAll(async()=>{await source?.end();await target?.end()})
 test('plan refuses an undrained source and target work with the wrong database identity',async()=>{
  const other=await source.connect()
  try{await expect(planForwardMigration(config)).rejects.toThrow('source_not_drained')}finally{other.release();await source.end();source=new pg.Pool({connectionString:sourceUrl})}
  await expect(planned({...config,target:{...config.target,expected:{...config.target.expected,database:'wrong'}}})).rejects.toThrow('database_identity_mismatch')
  const received:(string|null)[]=[],query=pg.Client.prototype.query
  const wire=vi.spyOn(pg.Client.prototype,'query').mockImplementation(function(this:pg.Client,...args:any[]):any{
   const result=(query as any).apply(this,args)
   if(String(args[0]).startsWith('FETCH FORWARD'))return result.then((r:any)=>{for(const row of r.rows)received.push(row.json);return r})
   return result
  } as any)
  try{
   await expect(planned({...config,maxRowBytes:16})).rejects.toThrow('migration_row_byte_limit')
   expect(received.every(text=>text===null||Buffer.byteLength(text)<=16)).toBe(true)
  }finally{wire.mockRestore()}
  expect((await target.query("SELECT to_regclass('shared.memory_forward_runs') AS run")).rows[0].run).toBeNull()
  const rows=(await source.query('SELECT row_to_json(c)::text AS json FROM public.knowledge_claims c ORDER BY identity_generation')).rows
  const c=await target.connect()
  try{
   await c.query("BEGIN;SET LOCAL session_replication_role='replica'")
   await c.query('INSERT INTO memory.knowledge_claims SELECT * FROM json_populate_record(NULL::memory.knowledge_claims,$1::json)',[rows[0].json])
   await expect(c.query('INSERT INTO memory.knowledge_claims SELECT * FROM json_populate_record(NULL::memory.knowledge_claims,$1::json)',[rows[1].json])).rejects.toMatchObject({code:'23505',constraint:'knowledge_claims_active_identity_variant_idx'})
  }finally{await c.query('ROLLBACK');c.release();await source.end();source=new pg.Pool({connectionString:sourceUrl})}

 })
 test('bounds cursor pages while preserving a large original row without one round trip per small row',async()=>{
  const query=pg.Client.prototype.query,events=new WeakSet<pg.Client>();let calls=0,rows=0,large=0
  const wire=vi.spyOn(pg.Client.prototype,'query').mockImplementation(function(this:pg.Client,...args:any[]):any{
   const sql=String(args[0]);if(sql.startsWith('DECLARE forward_rows')){events.delete(this);if(sql.includes('FROM "public"."source_events"'))events.add(this)}
   const result=(query as any).apply(this,args)
   if(events.has(this)&&sql.startsWith('FETCH FORWARD'))return result.then((r:any)=>{calls++;rows+=r.rowCount;expect(Buffer.byteLength(JSON.stringify(r.rows))).toBeLessThan(5*1024*1024);for(const row of r.rows)if(row.json!==null)expect(Buffer.byteLength(row.json)).toBeLessThanOrEqual(32768);return r})
   if(sql.includes('json_populate_record(NULL::"public"."source_events"'))return result.then((r:any)=>{if(r.rows[0]?.json&&Buffer.byteLength(r.rows[0].json)>32768)large++;return r})
   return result
  } as any)
  try{const plan=await planned(config);expect(plan.tables.find(t=>t.name==='source_events')!.sourceDigest.rows).toBe('130');expect(rows).toBe(130);expect(calls).toBeLessThanOrEqual(3);expect(large).toBe(1)}finally{wire.mockRestore()}
 })
 test('forward planning refuses an offline NOINHERIT login that can SET ROLE to a Memory writer',async()=>{
  await target.query(`CREATE ROLE shared_forward_set_writer NOLOGIN;CREATE ROLE shared_forward_set_peer LOGIN NOINHERIT PASSWORD 'synthetic-only';
   GRANT shared_forward_set_writer TO shared_forward_set_peer;
   GRANT USAGE ON SCHEMA memory TO shared_forward_set_writer;
   GRANT INSERT ON memory.memory_installations TO shared_forward_set_writer`)
  try{await expect(planned(config)).rejects.toThrow('target_writers_not_fenced')}
  finally{
   await target.query(`REVOKE INSERT ON memory.memory_installations FROM shared_forward_set_writer;
    REVOKE USAGE ON SCHEMA memory FROM shared_forward_set_writer;
    REVOKE shared_forward_set_writer FROM shared_forward_set_peer;DROP ROLE shared_forward_set_peer;DROP ROLE shared_forward_set_writer`)
  }
 })
 test('a changed legacy index is never dropped by name alone and planning is read-only',async()=>{
  const original=(await target.query("SELECT pg_get_indexdef('memory.knowledge_claims_active_identity_variant_idx'::regclass) AS definition")).rows[0].definition
  await target.query('DROP INDEX memory.knowledge_claims_active_identity_variant_idx;CREATE UNIQUE INDEX knowledge_claims_active_identity_variant_idx ON memory.knowledge_claims(installation_id,claim_id)')
  try{await expect(planned(config)).rejects.toThrow('unreviewed_governance_index_definition')}
  finally{await target.query('DROP INDEX memory.knowledge_claims_active_identity_variant_idx');await target.query(original)}
  const plan=await planned(config)
  await expect(verified(config,plan)).rejects.toThrow('target_preparation_required')
  expect((await target.query("SELECT pg_get_indexdef('memory.knowledge_claims_active_identity_variant_idx'::regclass) AS definition")).rows[0].definition).toBe(original)
 })
 test('plan fingerprints schema literals instead of exporting secrets from defaults and checks',async()=>{
  await source.query("ALTER TABLE public.memory_installations ALTER COLUMN provider_id SET DEFAULT 'credential-fixture-do-not-export';ALTER TABLE public.memory_installations ADD CONSTRAINT private_literal_probe CHECK(provider_id<>'credential-fixture-do-not-export')")
  await source.end();source=new pg.Pool({connectionString:sourceUrl})
  try{
   const plan=await planned(config)
   expect(JSON.stringify(plan).includes('credential-fixture-do-not-export')).toBe(false)
  }finally{
   await source.query('ALTER TABLE public.memory_installations ALTER COLUMN provider_id DROP DEFAULT;ALTER TABLE public.memory_installations DROP CONSTRAINT private_literal_probe')
   await source.end();source=new pg.Pool({connectionString:sourceUrl})
  }
 })
 test('a read-only migration role cannot silently copy an RLS-filtered subset',async()=>{
  const database='"'+config.source.expected.database.replaceAll('"','""')+'"'
  await source.query(`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='shared_forward_reader') THEN CREATE ROLE shared_forward_reader LOGIN PASSWORD 'only-test';ELSE ALTER ROLE shared_forward_reader LOGIN;END IF;END $$;
   GRANT CONNECT ON DATABASE ${database} TO shared_forward_reader;
   GRANT USAGE ON SCHEMA public TO shared_forward_reader;
   GRANT SELECT ON ALL TABLES IN SCHEMA public TO shared_forward_reader;
   GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO shared_forward_reader;
   ALTER TABLE source_events ENABLE ROW LEVEL SECURITY;
   CREATE POLICY migration_test_hidden ON source_events FOR SELECT USING(false)`)
  await source.end();source=new pg.Pool({connectionString:sourceUrl})
  const raw=new URL(sourceUrl!);raw.username='shared_forward_reader';raw.password='only-test'
  const probe=new pg.Client({connectionString:raw.href});await probe.connect()
  try{expect((await probe.query('SELECT count(*)::int n FROM source_events')).rows[0].n).toBe(0)}finally{await probe.end()}
  try{await expect(planned({...config,source:{url:raw.href,expected:{...config.source.expected,role:'shared_forward_reader'}}})).rejects.toMatchObject({code:'42501'})}
  finally{await source.query('DROP POLICY migration_test_hidden ON source_events;ALTER TABLE source_events DISABLE ROW LEVEL SECURITY;ALTER ROLE shared_forward_reader NOLOGIN');await source.end();source=new pg.Pool({connectionString:sourceUrl})}
 },30000)
 test('capacity expires during source scanning without changing the target index or creating receipts',async()=>{
  const plan=await planned(config),proof=capacity(plan),query=pg.Client.prototype.query,clock=vi.spyOn(Date,'now')
  let expired=false
  const scan=vi.spyOn(pg.Client.prototype,'query').mockImplementation(function(this:pg.Client,...args:any[]):any{
   const result=(query as any).apply(this,args)
   if(String(args[0])==='CLOSE forward_rows'&&(this as any).connectionParameters.database===config.source.expected.database)return result.then((r:any)=>{expired=true;clock.mockReturnValue(Date.parse(proof.validUntil)+1);return r})
   return result
  } as any)
  try{await expect(applied(config,plan,{capacity:proof})).rejects.toThrow('forward_capacity_expired')}
  finally{scan.mockRestore();clock.mockRestore()}
  expect(expired).toBe(true)
  expect((await target.query("SELECT to_regclass('memory.knowledge_claims_active_identity_variant_idx') IS NOT NULL AS present")).rows[0].present).toBe(true)
  expect((await target.query("SELECT to_regclass('shared.memory_forward_runs') AS run")).rows[0].run).toBeNull()
 },60000)
 test('copies all 191 current tables, resumes committed tables and preserves bigint/JSON/hash/UUID without a backup',async()=>{
  const plan=await planned(config)
  expect(plan.tables).toHaveLength(191)
  expect(plan.walCheckpointBytes).toBe(65536)
  await expect(applyForwardMigration({...config,walCheckpointBytes:131072},plan,{capacity:capacity(plan)})).rejects.toThrow('forward_manifest_mismatch')
  await expect(planForwardMigration({...config,walCheckpointBytes:0})).rejects.toThrow('invalid_forward_wal_checkpoint_limit')
  await expect(applyForwardMigration(config,plan)).rejects.toThrow('forward_capacity_required')
  expect(plan.targetPreparation).toEqual([{kind:'drop-obsolete-governance-index',name:'knowledge_claims_active_identity_variant_idx'}])
  expect(JSON.stringify(plan)).not.toContain('private-original')
  expect(JSON.stringify(plan)).not.toContain('postgres://')
  // A direct bounded insert must remain in the table transaction. A driver
  // failure after PostgreSQL accepted a row leaves neither data nor receipt.
  const originalQuery=pg.Client.prototype.query
  let interruptedInsert=false
  const midRow=vi.spyOn(pg.Client.prototype,'query').mockImplementation(function(this:pg.Client,...args:any[]):any{
   const result=(originalQuery as any).apply(this,args)
   if(String(args[0]).startsWith('INSERT INTO "memory"."claim_search_documents"(')&&String(args[0]).includes('json_populate_recordset(NULL::"memory"."claim_search_documents"'))return result.then(()=>{interruptedInsert=true;throw Error('injected_direct_row_stop')})
   return result
  } as any)
  try{await expect(applied(config,plan)).rejects.toThrow('injected_direct_row_stop')}
  finally{midRow.mockRestore()}
  expect(interruptedInsert).toBe(true)
  expect((await target.query('SELECT count(*)::int n FROM memory.claim_search_documents')).rows[0].n).toBe(0)
  expect((await target.query("SELECT count(*)::int n FROM shared.memory_forward_tables WHERE table_name='claim_search_documents'")).rows[0].n).toBe(0)
  expect((await target.query("SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname LIKE 'memory_stage_%'")).rows[0].n).toBe(0)
  let committed=0
  await expect(applied(config,plan,{afterTable:()=>{if(++committed===20)throw Error('injected_stop')}})).rejects.toThrow('injected_stop')
  const before=(await target.query('SELECT count(*)::int n FROM shared.memory_forward_tables')).rows[0].n
  expect(before).toBe(20)
  const directory=await mkdtemp(join(tmpdir(),'memory-forward-interrupt-')),output=join(directory,'interrupted-report')
  // The interruption probe can touch only the shared checkpoint registry,
  // never Memory tables, and cannot SET ROLE to a writer. The real fence
  // must keep rejecting a second superuser, even in test orchestration.
  await target.query(`CREATE ROLE shared_forward_checkpoint_probe LOGIN NOINHERIT PASSWORD 'synthetic-only';
   GRANT USAGE ON SCHEMA shared TO shared_forward_checkpoint_probe;
   GRANT SELECT,INSERT ON shared.memory_forward_tables TO shared_forward_checkpoint_probe`)
  const blockerUrl=new URL(targetUrl!);blockerUrl.username='shared_forward_checkpoint_probe';blockerUrl.password='synthetic-only'
  const blocker=new pg.Client({connectionString:blockerUrl.href});await blocker.connect()
  let child:ReturnType<typeof spawn>|undefined
  try{
   await writeFile(join(directory,'identity.json'),JSON.stringify({source:config.source.expected,target:config.target.expected}),{mode:0o600})
   await writeFile(join(directory,'manifest.json'),JSON.stringify(plan),{mode:0o600})
   await writeFile(join(directory,'capacity.json'),JSON.stringify(capacity(plan)),{mode:0o600})
   // An uncommitted future checkpoint prevents a fast local run finishing
   // before SIGINT. It is invisible to the child and is always rolled back.
   await blocker.query('BEGIN')
   await blocker.query("INSERT INTO shared.memory_forward_tables(migration_id,table_name,row_count,row_hash) VALUES($1,'source_events','0','test-blocker')",[config.migrationId])
   await fixtureDrained()
   child=spawn(process.execPath,['--import','tsx','src/migrations/shared-forward/cli.ts','resume','--identity',join(directory,'identity.json'),'--manifest',join(directory,'manifest.json'),'--capacity',join(directory,'capacity.json'),'--output',output,'--migration-id',config.migrationId,'--code-sha',config.codeSha,'--max-row-bytes',String(config.maxRowBytes),'--wal-checkpoint-bytes',String(config.walCheckpointBytes)],{env:{...process.env,SHARED_FORWARD_SOURCE_URL:sourceUrl!,SHARED_FORWARD_TARGET_URL:targetUrl!},stdio:['ignore','pipe','pipe']})
   let logs='',exited=false
   child.stdout!.on('data',chunk=>{logs+=chunk.toString()});child.stderr!.on('data',chunk=>{logs+=chunk.toString()})
   const ended=new Promise<number|null>((resolve,reject)=>{child!.once('error',reject);child!.once('exit',code=>{exited=true;resolve(code)})})
   const deadline=Date.now()+10000
   while(Date.now()<deadline&&!exited){
    const count=(await blocker.query("SELECT count(*)::int n FROM shared.memory_forward_tables WHERE table_name<>'source_events'")).rows[0].n
    if(count>20)break
    await new Promise(resolve=>setTimeout(resolve,20))
   }
   expect(exited,logs).toBe(false)
   expect((await blocker.query("SELECT count(*)::int n FROM shared.memory_forward_tables WHERE table_name<>'source_events'")).rows[0].n).toBeGreaterThan(20)
   child.kill('SIGINT')
   expect(await ended,logs).toBe(130)
   expect(logs).toContain('interrupted');expect(logs).not.toContain('private-original');expect(logs).not.toContain('postgres://')
   await expect(stat(output)).rejects.toMatchObject({code:'ENOENT'})
   await expect(stat(output+'.lock')).rejects.toMatchObject({code:'ENOENT'})
  }finally{
   child?.kill('SIGKILL');await blocker.query('ROLLBACK');await blocker.end()
   await target.query(`REVOKE SELECT,INSERT ON shared.memory_forward_tables FROM shared_forward_checkpoint_probe;
    REVOKE USAGE ON SCHEMA shared FROM shared_forward_checkpoint_probe;DROP ROLE shared_forward_checkpoint_probe`)
   await rm(directory,{recursive:true,force:true})
  }
  let insertedSource=false,checkpointFailed=false
  const checkpointQuery=pg.Client.prototype.query
  const checkpointWire=vi.spyOn(pg.Client.prototype,'query').mockImplementation(function(this:pg.Client,...args:any[]):any{
   const sql=String(args[0]),result=(checkpointQuery as any).apply(this,args)
   if(sql.startsWith('INSERT INTO "memory"."source_events"('))insertedSource=true
   if(insertedSource&&sql==='CHECKPOINT')return result.then(()=>{checkpointFailed=true;throw Error('injected_checkpoint_stop')})
   return result
  } as any)
  try{await expect(applied(config,plan)).rejects.toThrow('injected_checkpoint_stop')}finally{checkpointWire.mockRestore()}
  expect(checkpointFailed).toBe(true)
  expect((await target.query('SELECT count(*)::int AS n FROM memory.source_events')).rows[0].n).toBe(0)
  expect((await target.query("SELECT count(*)::int AS n FROM shared.memory_forward_tables WHERE table_name='source_events'")).rows[0].n).toBe(0)
  let walOverrunInjected=false,insertedForWalProbe=false
  const walQuery=pg.Client.prototype.query
  const walWire=vi.spyOn(pg.Client.prototype,'query').mockImplementation(function(this:pg.Client,...args:any[]):any{
   const sql=String(args[0]),result=(walQuery as any).apply(this,args)
   if(sql.startsWith('INSERT INTO "memory"."source_events"('))insertedForWalProbe=true
   if(insertedForWalProbe&&sql.includes('FROM pg_ls_waldir()'))return result.then((r:any)=>{walOverrunInjected=true;r.rows[0].physical=(BigInt(r.rows[0].physical)+67108865n).toString();return r})
   return result
  } as any)
  try{await expect(applied(config,plan)).rejects.toThrow('forward_wal_capacity_exceeded')}finally{walWire.mockRestore()}
  expect(walOverrunInjected).toBe(true)
  expect((await target.query('SELECT count(*)::int AS n FROM memory.source_events')).rows[0].n).toBe(0)
  expect((await target.query("SELECT count(*)::int AS n FROM shared.memory_forward_tables WHERE table_name='source_events'")).rows[0].n).toBe(0)
  const sourceBatches:number[]=[],copyQuery=pg.Client.prototype.query
  const copyWire=vi.spyOn(pg.Client.prototype,'query').mockImplementation(function(this:pg.Client,...args:any[]):any{
   if(String(args[0]).startsWith('INSERT INTO "memory"."source_events"(')){
    expect(String(args[0])).toContain('json_populate_recordset(')
    sourceBatches.push(JSON.parse(args[1][0]).length)
    expect(Buffer.byteLength(args[1][0])).toBeLessThanOrEqual(8*1024*1024)
   }
   return (copyQuery as any).apply(this,args)
  } as any)
  try{const observation=await applied(config,plan);expect(observation.walCheckpointBytes).toBe(65536);expect(observation.wal!.checkpoints).toBeGreaterThanOrEqual(3);expect(BigInt(observation.wal!.generatedBytes)).toBeGreaterThan(0n);expect(BigInt(observation.wal!.peakPhysicalBytes)).toBeGreaterThanOrEqual(BigInt(observation.wal!.initialPhysicalBytes))}finally{copyWire.mockRestore()}
  expect(sourceBatches).toEqual([128,2])
  expect((await target.query("SELECT count(*)::int n FROM memory.source_events WHERE payload->>'integer'='9007199254740993'")).rows[0].n).toBe(130)
  const receipt=await verified(config,plan)
  expect((await target.query("SELECT to_regclass('memory.knowledge_claims_active_identity_variant_idx') AS obsolete")).rows[0].obsolete).toBeNull()
  expect((await target.query('SELECT count(*)::int n FROM memory.knowledge_claims WHERE installation_id=$1',[installation])).rows[0].n).toBe(2)
  expect(receipt).toMatchObject({verified:true,backupCreated:false,rollbackSupported:false,tables:'191'})
  const reportRoot=await mkdtemp(join(tmpdir(),'memory-forward-verified-'))
  try{
   await writeFile(join(reportRoot,'identity.json'),JSON.stringify({source:config.source.expected,target:config.target.expected}),{mode:0o600})
   await writeFile(join(reportRoot,'manifest.json'),JSON.stringify(plan),{mode:0o600})
   const args=['--import','tsx','src/migrations/shared-forward/cli.ts','verify','--identity',join(reportRoot,'identity.json'),'--manifest',join(reportRoot,'manifest.json'),'--output',join(reportRoot,'receipt'),'--migration-id',config.migrationId,'--code-sha',config.codeSha,'--max-row-bytes',String(config.maxRowBytes),'--wal-checkpoint-bytes',String(config.walCheckpointBytes)]
   const env={...process.env,SHARED_FORWARD_SOURCE_URL:sourceUrl!,SHARED_FORWARD_TARGET_URL:targetUrl!}
   await fixtureDrained()
   const cli=spawnSync(process.execPath,args,{env,encoding:'utf8',timeout:30000})
   expect(cli.status,cli.stderr).toBe(0)
   expect(cli.stdout+cli.stderr).not.toMatch(/private-original|postgres:\/\//)
   expect((await stat(join(reportRoot,'receipt','forward-verification.json'))).mode&0o777).toBe(0o600)
   const repeated=spawnSync(process.execPath,args,{env,encoding:'utf8',timeout:30000})
   expect(repeated.status).toBe(2);expect(repeated.stderr).toContain('report_exists')
  }finally{await rm(reportRoot,{recursive:true,force:true})}
  const row=(await target.query("SELECT source_event_id::text,origin_position,source_sequence::text,payload::text,encode(payload_hash,'hex') AS hash,source_provenance FROM memory.source_events WHERE source_event_id=$1",[id])).rows[0]
  expect(row.source_event_id).toBe(id);expect(row.origin_position).toBe('9007199254740993');expect(row.source_sequence).toBe('9007199254740994')
  expect(row.payload).toContain('9007199254740993');expect(row.hash).toBe('ab'.repeat(32));expect(row.source_provenance).toEqual({state:'unknown',opaque_ref:'original'})
  expect((await target.query('SELECT last_value::text,is_called FROM memory.memory_skill_replay_runs_sequence_seq')).rows[0]).toEqual({last_value:'9007199254740995',is_called:false})
  expect((await target.query("SELECT search_vector::text FROM memory.claim_search_documents WHERE installation_id=$1",[installation])).rows[0].search_vector).toContain('private')
  expect((await target.query('SELECT id::text,body FROM public.forward_relay_sentinel')).rows).toEqual([{id:'9007199254740993',body:'canonical untouched'}])
  try{
   for(const table of ['memory_feature_settings','memory_extraction_runs','memory_provider_budget_reservations','memory_usage_outbox','memory_jobs','memory_governance_events']){
    const digest=(namespace:'public'|'memory')=>`SELECT encode(sha256(convert_to(COALESCE(jsonb_agg(row_value ORDER BY row_value::text)::text,'[]'),'UTF8')),'hex') AS hash FROM(SELECT to_jsonb(r) AS row_value FROM ${namespace}.${table} r) dataset_rows`
    expect((await target.query(digest('memory'))).rows).toEqual((await source.query(digest('public'))).rows)
   }
  }finally{await source.end();source=new pg.Pool({connectionString:sourceUrl})}
  expect((await target.query('SELECT extraction_mode,embedding_mode FROM memory.memory_feature_settings WHERE installation_id=$1',[installation])).rows[0]).toEqual({extraction_mode:'off',embedding_mode:'off'})
  expect((await target.query("SELECT state,error_code,input_tokens::text,cost_micros::text,to_char(completed_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') AS completed FROM memory.memory_extraction_runs WHERE installation_id=$1",[installation])).rows[0]).toEqual({state:'failed',error_code:'provider_result_unknown',input_tokens:'9007199254740993',cost_micros:'9007199254740994',completed:'2026-11-01 01:02:04.654321'})
  expect((await target.query("SELECT state,claim_epoch::text,payload->>'opaque_number' AS number,last_error_code FROM memory.memory_jobs WHERE installation_id=$1",[installation])).rows[0]).toEqual({state:'dead',claim_epoch:'9007199254740995',number:'9007199254740993',last_error_code:'provider_result_unknown'})
  expect((await target.query("SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname LIKE 'memory_stage_%'")).rows[0].n).toBe(0)
 },60000)
 test('resume and verification refuse changed target state instead of overwriting newer knowledge',async()=>{
  const plan=(await target.query('SELECT manifest FROM shared.memory_forward_runs WHERE migration_id=$1',[config.migrationId])).rows[0].manifest
  await target.query("UPDATE memory.source_events SET source_provenance=source_provenance||'{\"new_state\":true}' WHERE source_event_id=$1",[id])
  await expect(applied(config,plan)).rejects.toThrow('target_table_changed')
  await expect(verified(config,plan)).rejects.toThrow('target_table_changed')
  expect((await target.query("SELECT source_provenance->>'new_state' AS state FROM memory.source_events WHERE source_event_id=$1",[id])).rows[0].state).toBe('true')
 })
 test('post-copy namespace startup failure repairs forward on current authority while retaining new knowledge, usage and uncertainty',async()=>{
  await target.query(`DO $$ BEGIN
   IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='shared_forward_runtime') THEN CREATE ROLE shared_forward_runtime LOGIN PASSWORD 'only-test';ELSE ALTER ROLE shared_forward_runtime LOGIN;END IF;
   IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='shared_forward_relay_runtime') THEN CREATE ROLE shared_forward_relay_runtime NOLOGIN;END IF;
   IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='shared_forward_migrator') THEN CREATE ROLE shared_forward_migrator NOLOGIN;END IF;
   END $$`)
  await provisionSharedDatabase(target,{memoryRole:'shared_forward_runtime',relayRole:'shared_forward_relay_runtime',migratorRole:'shared_forward_migrator'})
  await target.query("UPDATE memory.knowledge_versions SET statement='new authoritative knowledge after cutover' WHERE installation_id=$1",[installation])
  await target.query("INSERT INTO memory.memory_usage_outbox(installation_id,usage_id,operation,model,cost_micros,occurred_at) VALUES($1,'new-target-cost','extraction','synthetic',11,now())",[installation])
  const state=async()=>(await target.query(`SELECT
   (SELECT jsonb_agg(to_jsonb(r) ORDER BY version_id) FROM memory.knowledge_versions r WHERE installation_id=$1)::text AS knowledge,
   (SELECT jsonb_agg(to_jsonb(r) ORDER BY usage_id) FROM memory.memory_usage_outbox r WHERE installation_id=$1)::text AS usage,
   (SELECT jsonb_agg(to_jsonb(r) ORDER BY run_id) FROM memory.memory_extraction_runs r WHERE installation_id=$1)::text AS runs,
   (SELECT jsonb_agg(to_jsonb(r) ORDER BY reservation_id) FROM memory.memory_provider_budget_reservations r)::text AS reservations`,[installation])).rows[0]
  const current=await state(),runtimeUrl=new URL(targetUrl!);runtimeUrl.username='shared_forward_runtime';runtimeUrl.password='only-test'
  const bad=createMemoryPool({databaseUrl:runtimeUrl.href,databaseNamespace:'public',dbPoolMax:1})
  try{await expect(prepareMemoryStartup(bad,{databaseNamespace:'public',schemaStartup:'verify'})).rejects.toThrow('shared_source_requires_memory_namespace')}
  finally{await bad.end()}
  // Correct only the current target namespace. No old DSN/data is restored.
  const fixed=createMemoryPool({databaseUrl:runtimeUrl.href,databaseNamespace:'memory',dbPoolMax:1})
  try{
   await prepareMemoryStartup(fixed,{databaseNamespace:'memory',schemaStartup:'verify'});await verifyMemoryStartup(fixed,'memory')
   expect((await fixed.query("SELECT statement FROM knowledge_versions WHERE installation_id=$1",[installation])).rows[0].statement).toBe('new authoritative knowledge after cutover')
   expect((await fixed.query("SELECT error_code FROM memory_extraction_runs WHERE installation_id=$1",[installation])).rows[0].error_code).toBe('provider_result_unknown')
  }finally{await fixed.end();await target.query('ALTER ROLE shared_forward_runtime NOLOGIN')}
  expect(await state()).toEqual(current)
  const old=(await target.query('SELECT manifest FROM shared.memory_forward_runs WHERE migration_id=$1',[config.migrationId])).rows[0].manifest
  await expect(applied(config,old)).rejects.toThrow('forward_schema_changed')
  expect(await state()).toEqual(current)
 })

 test('an actual v84 public source transfers to current memory without inventing typed bindings or changing Relay',async()=>{
  await source.query('DROP SCHEMA public CASCADE;CREATE SCHEMA public;CREATE TABLE public.memory_schema_migrations(version int PRIMARY KEY,applied_at timestamptz DEFAULT NOW())')
  const migration=await source.connect()
  try{
   for(const step of MEMORY_MIGRATIONS.filter(m=>m.version<=84)){
    await migration.query('BEGIN');for(const sql of step.statements)await migration.query(sql)
    await migration.query('INSERT INTO public.memory_schema_migrations(version) VALUES($1)',[step.version]);await migration.query('COMMIT')
   }
  }finally{migration.release()}
  await source.query("INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[installation])
  await source.query("INSERT INTO source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES($1,'v84-session',now(),now())",[installation])
  await source.query(`INSERT INTO source_events(source_event_id,installation_id,origin,origin_position,session_id,turn_id,event_type,occurred_at,payload,payload_hash)
   VALUES($1,$2,'snapshot','9007199254740993','v84-session','v84-turn','agent_text','2026-11-01T00:00:00.123456Z','{"large":9007199254740993}',decode(repeat('ab',32),'hex'))`,[id,installation])
  await source.query("INSERT INTO source_turns(installation_id,turn_id,session_id,state,first_source_event_id,last_source_event_id) VALUES($1,'v84-turn','v84-session','completed',$2,$2)",[installation,id])
  await source.end();source=new pg.Pool({connectionString:sourceUrl})
  // Keep the mature native/shared promise intact. A v84-to-current rehearsal
  // gets its own fresh database rather than erasing promised history.
  const freshUrl=new URL(targetUrl!);freshUrl.pathname='/shared_forward_v84_target_test'
  const adminUrl=new URL(targetUrl!);adminUrl.pathname='/postgres'
  const admin=new pg.Pool({connectionString:adminUrl.href})
  try{await admin.query('CREATE DATABASE shared_forward_v84_target_test')}finally{await admin.end()}
  await target.end();target=new pg.Pool({connectionString:freshUrl.href})
  const {initDB}=await import(new URL('../../../../relay/dist/db.js',import.meta.url).href);await initDB(target)
  await applyMemorySchema(target,{namespace:'memory'});await applySharedSourceContract(target)
  await target.query("CREATE TABLE public.forward_relay_sentinel(id bigint PRIMARY KEY,body text);INSERT INTO public.forward_relay_sentinel VALUES(9007199254740993,'canonical untouched')")
  config={...config,target:{url:freshUrl.href,expected:(await target.query(`SELECT current_database() AS database,current_user AS role,inet_server_addr()::text AS "serverAddress",inet_server_port()::text AS "serverPort"`)).rows[0]}}
  const v84Config={...config,migrationId:'30000000-0000-0000-0000-000000000084'}
  const plan=await planned(v84Config)
  expect(plan.tables).toHaveLength(187)
  await applied(v84Config,plan)
  expect(await verified(v84Config,plan)).toMatchObject({verified:true,tables:'187',backupCreated:false,rollbackSupported:false})
  await target.query(`INSERT INTO memory.memory_canonical_projection_progress(installation_id,source_kind,root_key,context_key,source_version,state)
   VALUES($1,'relay_event','1:v84-session',repeat('a',64),'{"content":"1","authorization":"1","storage":"0"}','ready')`,[installation])
  try{await expect(verified(v84Config,plan)).rejects.toThrow('target_not_pristine')}
  finally{await target.query('DELETE FROM memory.memory_canonical_projection_progress WHERE installation_id=$1',[installation])}
  expect((await target.query("SELECT max(version)::int AS schema_version FROM memory.memory_schema_migrations")).rows[0].schema_version).toBe(96)
  const row=(await target.query("SELECT source_event_id::text,origin_position,payload->>'large' AS number,encode(payload_hash,'hex') AS hash,mapping_state,canonical_key,source_sequence::text FROM memory.source_events WHERE source_event_id=$1",[id])).rows[0]
  expect(row).toEqual({source_event_id:id,origin_position:'9007199254740993',number:'9007199254740993',hash:'ab'.repeat(32),mapping_state:'unproven',canonical_key:null,source_sequence:null})
  expect((await target.query('SELECT first_source_event_id::text,last_source_event_id::text FROM memory.source_turns WHERE installation_id=$1',[installation])).rows[0]).toEqual({first_source_event_id:id,last_source_event_id:id})
  expect((await target.query('SELECT id::text,body FROM public.forward_relay_sentinel')).rows).toEqual([{id:'9007199254740993',body:'canonical untouched'}])
  // These columns do not exist in v84. A source-column digest alone cannot
  // attest their post-copy state, even though it still matches every old byte.
  const repair=await target.connect()
  try{
   // Isolate a column-only maintenance change from audit-trigger side effects;
   // the full-row proof itself must reject it, not an unrelated audit digest.
   await repair.query("BEGIN;SET LOCAL session_replication_role='replica'")
   await repair.query("UPDATE memory.source_events SET mapping_state='deleted' WHERE source_event_id=$1",[id])
   await repair.query('COMMIT')
  }finally{await repair.query('ROLLBACK');repair.release()}
  await expect(verified(v84Config,plan)).rejects.toThrow('target_table_changed')
  await expect(applied(v84Config,plan)).rejects.toThrow('target_table_changed')
  expect((await target.query('SELECT mapping_state FROM memory.source_events WHERE source_event_id=$1',[id])).rows[0].mapping_state).toBe('deleted')
 },60000)

})
