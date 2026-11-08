import {claimIdentityV2} from '../../claims/identity.js'
import {normalizedClaimKey} from '../../retrieval/query-normalizer.js'
import {pagedTables} from '../../migrations/shared-forward/paged-cleanup-receipts.js'
import {EPISODE_PACKET_COMPILER_VERSION} from '../../episodes/packet.js'
import pg from 'pg'
import {assertPagedExactEpisodes} from '../../migrations/shared-forward/paged-cleanup-exact-source.js'
import {pagedWindow} from '../../migrations/shared-forward/paged-cleanup-authority.js'
import {beforeAll,afterAll,describe,test,expect,vi} from 'vitest'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createPagedFixture,pagedRoot,pagedInstallation,pagedProbe} from './paged-cleanup-fixture.js'
import {pagedMaintenanceTestLifecycle} from './paged-cleanup-fixture.js'
const {planPagedCleanup,applyPagedCleanup,verifyPagedCleanup}=pagedMaintenanceTestLifecycle()
import {openPagedCleanupManifest,readPagedCleanupParts} from '../../migrations/shared-forward/paged-cleanup-manifest.js'
const url=process.env.SHARED_W4_PAGED_TEST_DATABASE_URL,suite=url?describe:describe.skip
suite('v4 actual bounded personal privacy cleanup',()=>{
 let fixture:Awaited<ReturnType<typeof createPagedFixture>>,directory:string
 beforeAll(async()=>{fixture=await createPagedFixture(url!);directory=await mkdtemp(join(tmpdir(),'pocketctl-paged-pg-'))},120000)
 afterAll(async()=>{if(directory)await rm(directory,{recursive:true,force:true})})
 const options={probe:pagedProbe}
 test('R4 cold checkpoint metadata is maintained before business writes and readonly commands never analyze',async()=>{
  const name='paged-metadata-policy';await fixture.source(name,2)
  const target=join(directory,'metadata-policy-plan'),analyzed:string[]=[]
  let nativeWindows=0
  const original=pg.Client.prototype.query,spy=vi.spyOn(pg.Client.prototype,'query').mockImplementation(function(this:pg.Client,...args:unknown[]){
   const sql=typeof args[0]==='string'?args[0]:''
   if(/^ANALYZE /.test(sql))analyzed.push(sql)
   if(sql.startsWith('SELECT COALESCE(sum(n_tup_ins+n_tup_upd+n_tup_del)')){
    expect(new Set(analyzed)).toEqual(new Set(Object.values(pagedTables).map(table=>'ANALYZE shared."'+table+'"')))
    nativeWindows++
   }
   return Reflect.apply(original,this,args)
  } as pg.Client['query'])
  try{
   await planPagedCleanup(fixture.config,[{installationId:pagedInstallation,sessionId:name}],target,options);expect(analyzed).toEqual([])
   await expect(applyPagedCleanup(fixture.config,target,{...options,afterCommit:async n=>{if(n==='0')throw Error('metadata_policy_ack_lost')}})).rejects.toThrow('metadata_policy_ack_lost')
   expect(nativeWindows).toBeGreaterThan(0);expect(analyzed.length).toBe(4)
   const metadata=(await fixture.sql("SELECT relname,reloptions,reltuples>=0 AS analyzed FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='shared' AND c.relname=ANY($1::text[]) ORDER BY relname",[Object.values(pagedTables)])).rows
   expect(metadata).toHaveLength(4);expect(metadata.every(row=>JSON.stringify(row.reloptions)==='["autovacuum_enabled=false"]'&&row.analyzed)).toBe(true)
   await verifyPagedCleanup(fixture.config,target,options);expect(analyzed.length).toBe(4)
   expect((await applyPagedCleanup(fixture.config,target,options)).privacyCatchupReadyForReopen).toBe(true);expect(analyzed.length).toBe(8)
   await fixture.sql('ALTER TABLE shared.memory_forward_cleanup_v4_items RESET(autovacuum_enabled)')
   try{await expect(verifyPagedCleanup(fixture.config,target,options)).rejects.toThrow('paged_checkpoint_structure_or_acl_drift')}
   finally{await fixture.sql('ALTER TABLE shared.memory_forward_cleanup_v4_items SET(autovacuum_enabled=false)')}
  }finally{spy.mockRestore()}
 },120000)
 test('R4 independent Claim seeds carry genuine distinct accepted and current identities',async()=>{
  const name='paged-identity-fixture';await fixture.source(name,1)
  await fixture.sql("INSERT INTO memory.work_episodes(installation_id,episode_id,session_id,turn_id,state,compiler_version) SELECT $1,gen_random_uuid(),$2,'identity-'||n,'ready','test' FROM generate_series(1,2)n",[pagedInstallation,name])
  const ids=(await fixture.sql('SELECT episode_id::text FROM memory.work_episodes WHERE session_id=$1 ORDER BY episode_id',[name])).rows.map(row=>row.episode_id)
  const accepted=await fixture.acceptedClaims(ids),rows=(await fixture.sql('SELECT c.claim_id::text,c.normalized_key,c.normalized_key_v2,c.scope_key,c.scope_kind,c.canonical_repository_key,v.statement FROM memory.knowledge_claims c JOIN memory.knowledge_versions v ON v.version_id=c.current_version_id WHERE c.claim_id=ANY($1::uuid[])',[accepted.map(row=>row.claim)])).rows
  for(const row of rows){expect(row.normalized_key).toBe(normalizedClaimKey({claimType:'test_invariant',scopeKey:row.scope_key,statement:row.statement}));expect(row.normalized_key_v2).toBe(claimIdentityV2({claimType:'test_invariant',scopeKind:row.scope_kind,scopeKey:row.scope_key,canonicalRepositoryKey:row.canonical_repository_key,snapshotId:null,branch:null,statement:row.statement,status:'verified'}).key)}
  const seeds=(await fixture.sql('SELECT statement FROM memory.knowledge_versions WHERE version_id=ANY($1::uuid[])',[accepted.map(row=>row.kept)])).rows
  expect(new Set(seeds.map(row=>row.statement)).size).toBe(2)
 },120000)
 test('the single native NOT VALID exception is exact and unknown metadata prefix objects refuse',async()=>{
  const name='paged-catalog-negative';await fixture.source(name,2);const root={installationId:pagedInstallation,sessionId:name}
  const original=(await fixture.sql("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='memory.source_events'::regclass AND conname='source_events_verified_legacy_archive'")).rows[0].definition
  await fixture.sql('ALTER TABLE memory.source_events DROP CONSTRAINT source_events_verified_legacy_archive;ALTER TABLE memory.source_events ADD CONSTRAINT source_events_verified_legacy_archive CHECK(true) NOT VALID')
  try{await expect(planPagedCleanup(fixture.config,[root],join(directory,'changed-native-check'),options)).rejects.toThrow('paged_native_legacy_constraint_drift')}
  finally{await fixture.sql('ALTER TABLE memory.source_events DROP CONSTRAINT source_events_verified_legacy_archive;ALTER TABLE memory.source_events ADD CONSTRAINT source_events_verified_legacy_archive '+original)}
  await fixture.sql('ALTER TABLE memory.source_events ADD CONSTRAINT paged_fixture_unknown_invalid CHECK(true) NOT VALID')
  try{await expect(planPagedCleanup(fixture.config,[root],join(directory,'another-invalid-check'),options)).rejects.toThrow('paged_catalog_invalid_object')}
  finally{await fixture.sql('ALTER TABLE memory.source_events DROP CONSTRAINT paged_fixture_unknown_invalid')}
  await expect(fixture.sql('CREATE UNIQUE INDEX CONCURRENTLY paged_fixture_invalid_index ON memory.source_events(installation_id)')).rejects.toMatchObject({code:'23505'})
  try{await expect(planPagedCleanup(fixture.config,[root],join(directory,'invalid-index'),options)).rejects.toThrow('paged_catalog_invalid_object')}
  finally{await fixture.sql('DROP INDEX CONCURRENTLY memory.paged_fixture_invalid_index')}
  await fixture.sql('CREATE FUNCTION shared.memory_forward_cleanup_v4_intruder() RETURNS integer LANGUAGE sql AS $$SELECT 1$$')
  try{await expect(planPagedCleanup(fixture.config,[root],join(directory,'unknown-prefixed-function'),options)).rejects.toThrow('paged_checkpoint_unknown_object')}
  finally{await fixture.sql('DROP FUNCTION shared.memory_forward_cleanup_v4_intruder()')}
  expect((await fixture.sql('SELECT count(*)::int AS n FROM memory.source_events WHERE session_id=$1',[name])).rows[0].n).toBe(2)
 },120000)
 test('known unvalidated schema does not authorize a violating legacy row or alter unrelated legacy history',async()=>{
  const legacy='paged-violating-legacy',selected='paged-beside-legacy';await fixture.source(legacy,1);await fixture.source(selected,1)
  const original=(await fixture.sql("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='memory.source_events'::regclass AND conname='source_events_verified_legacy_archive'")).rows[0].definition
  await fixture.sql('ALTER TABLE memory.source_events DROP CONSTRAINT source_events_verified_legacy_archive')
  try{await fixture.sql("UPDATE memory.source_events SET source_kind='legacy_archive' WHERE session_id=$1",[legacy])}
  finally{await fixture.sql('ALTER TABLE memory.source_events ADD CONSTRAINT source_events_verified_legacy_archive '+original)}
  const saved=(await fixture.sql("SELECT source_event_id::text,xmin::text,encode(sha256(convert_to(to_jsonb(s)::text,'UTF8')),'hex') AS digest FROM memory.source_events s WHERE session_id=$1",[legacy])).rows
  expect((await fixture.sql("SELECT mapping_state='verified' AND source_kind='legacy_archive' AND canonical_key<>source_event_id::text AND legacy_owner_user_id IS NULL AS violates FROM memory.source_events WHERE session_id=$1",[legacy])).rows[0].violates).toBe(true)
  await expect(planPagedCleanup(fixture.config,[{installationId:pagedInstallation,sessionId:legacy}],join(directory,'invalid-legacy-plan'),options)).rejects.toThrow('paged_original_source_adapter_required')
  const target=join(directory,'beside-legacy-plan');await planPagedCleanup(fixture.config,[{installationId:pagedInstallation,sessionId:selected}],target,options);await applyPagedCleanup(fixture.config,target,options)
  expect((await fixture.sql("SELECT source_event_id::text,xmin::text,encode(sha256(convert_to(to_jsonb(s)::text,'UTF8')),'hex') AS digest FROM memory.source_events s WHERE session_id=$1",[legacy])).rows).toEqual(saved)
 },120000)
 test('R1 pending native capture state refuses before any Memory mutation',async()=>{
  const name='paged-native-pending';await fixture.source(name,1)
  await fixture.sql("UPDATE public.events SET effect_status='pending' WHERE session_id=$1",[name])
  const root={installationId:pagedInstallation,sessionId:name},target=join(directory,'pending-native-plan')
  expect((await fixture.sql("SELECT shared.memory_event_capture_eligible(jsonb_build_object('effect_status',effect_status,'user_id',user_id,'session_id',session_id)) AS eligible FROM public.events WHERE session_id=$1",[name])).rows[0].eligible).toBe(false)
  await expect(planPagedCleanup(fixture.config,[root],target,options)).rejects.toThrow('paged_original_source_unproved')
  expect((await fixture.sql('SELECT count(*)::int AS n FROM memory.source_events WHERE session_id=$1',[name])).rows[0].n).toBe(1)
 })
 test.each(['source','episode','artifact'] as const)('R1 divisible raw %s byte batches paginate within the same limits',async kind=>{
  const name='paged-byte-'+kind;await fixture.source(name,kind==='source'?128:1,false,kind==='source'?70*1024:0)
  if(kind==='episode')await fixture.sql("INSERT INTO memory.work_episodes(installation_id,episode_id,session_id,turn_id,state,compiler_version,document) SELECT $1,gen_random_uuid(),$2,'byte-'||n,'ready','fixture',jsonb_build_object('text',repeat('x',70*1024)) FROM generate_series(1,128)n",[pagedInstallation,name])
  if(kind==='artifact')await fixture.sql("INSERT INTO memory.source_artifacts(artifact_id,installation_id,session_id,source_event_id,artifact_type,identity_key,details,occurred_at) SELECT gen_random_uuid(),$1,$2,s.source_event_id,'other','byte-'||n,jsonb_build_object('text',repeat('x',70*1024)),now() FROM memory.source_events s CROSS JOIN generate_series(1,128)n WHERE s.session_id=$2",[pagedInstallation,name])
  const target=join(directory,'byte-'+kind+'-plan');await planPagedCleanup(fixture.config,[{installationId:pagedInstallation,sessionId:name}],target,options)
  let relevant=0;for await(const page of readPagedCleanupParts(await openPagedCleanupManifest(target))){expect(page.records.reduce((n,r)=>n+BigInt(r.bytes),0n)).toBeLessThanOrEqual(8388608n);if(page.records.some(r=>r.table===({source:'source_events',episode:'work_episodes',artifact:'source_artifacts'}[kind])))relevant++}
  expect(relevant).toBeGreaterThan(1);expect((await applyPagedCleanup(fixture.config,target,options)).privacyCatchupReadyForReopen).toBe(true)
 },120000)
 test('R1 a genuinely oversized source row refuses without body transfer or deletion',async()=>{
  const name='paged-oversized-source';await fixture.source(name,1,false,8388609)
  await expect(planPagedCleanup(fixture.config,[{installationId:pagedInstallation,sessionId:name}],join(directory,'oversized-source-plan'),options)).rejects.toThrow(/capacity/)
  expect((await fixture.sql('SELECT count(*)::int AS n FROM memory.source_events WHERE session_id=$1',[name])).rows[0].n).toBe(1)
 },120000)
 test('R1 oversized mismatched native classification never reaches the client',async()=>{
  const name='paged-native-classification-limit';await fixture.source(name,1)
  await fixture.sql("UPDATE public.events SET source_classification=jsonb_build_object('body',repeat('x',8388609)) WHERE session_id=$1",[name])
  const original=pg.Client.prototype.query;let transferred=false
  const spy=vi.spyOn(pg.Client.prototype,'query').mockImplementation(function(this:pg.Client,...args:unknown[]){
   const result=Reflect.apply(original,this,args)
   return result?.then?(result as Promise<pg.QueryResult>).then(r=>{if(r.rows.some(row=>row.native_classification&&Buffer.byteLength(JSON.stringify(row.native_classification))>8388608))transferred=true;return r}):result
  } as pg.Client['query'])
  try{await expect(planPagedCleanup(fixture.config,[{installationId:pagedInstallation,sessionId:name}],join(directory,'native-classification-limit'),options)).rejects.toThrow(/paged_(original_source_unproved|source_capacity)/);expect(transferred).toBe(false)}finally{spy.mockRestore()}
  expect((await fixture.sql('SELECT count(*)::int AS n FROM memory.source_events WHERE session_id=$1',[name])).rows[0].n).toBe(1)
 },120000)
 test('R1 compressed oversized identity JSON never reaches the client',async()=>{
  const name='paged-identity-projection-limit';await fixture.source(name,1)
  await fixture.sql("INSERT INTO memory.source_turns(installation_id,turn_id,session_id,state) SELECT $1,'oversized-'||n||repeat('x',70*1024),$2,'completed' FROM generate_series(1,128)n",[pagedInstallation,name])
  const original=pg.Client.prototype.query;let transferred=false
  const spy=vi.spyOn(pg.Client.prototype,'query').mockImplementation(function(this:pg.Client,...args:unknown[]){
   const result=Reflect.apply(original,this,args)
   return result?.then?(result as Promise<pg.QueryResult>).then(r=>{if(r.rows.some(row=>Object.values(row.key??{}).some(value=>typeof value==='string'&&value.length>1024)))transferred=true;return r}):result
  } as pg.Client['query'])
  try{await expect(planPagedCleanup(fixture.config,[{installationId:pagedInstallation,sessionId:name}],join(directory,'identity-projection-limit'),options)).rejects.toThrow(/paged_(manifest_identity|component_capacity)/);expect(transferred).toBe(false)}finally{spy.mockRestore()}
  expect((await fixture.sql('SELECT count(*)::int AS n FROM memory.source_turns WHERE session_id=$1',[name])).rows[0].n).toBe(128)
 },120000)
 test('R1 identity guard preserves the exact1024 UTF16 boundary',async()=>{
  const name='paged-identity-utf16';await fixture.source(name,1)
  const ids=['a'.repeat(1024),'界'.repeat(1024),'💡'.repeat(512)]
  await fixture.sql("INSERT INTO memory.source_turns(installation_id,turn_id,session_id,state) SELECT $1,id,$2,'completed' FROM unnest($3::text[]) id",[pagedInstallation,name,ids])
  const target=join(directory,'valid-utf16-plan');await planPagedCleanup(fixture.config,[{installationId:pagedInstallation,sessionId:name}],target,options)
  const actual:string[]=[];for await(const page of readPagedCleanupParts(await openPagedCleanupManifest(target)))for(const row of page.records)if(row.table==='source_turns')actual.push(row.key.turn_id!)
  expect(actual.sort()).toEqual(ids.sort())
  await fixture.sql("INSERT INTO memory.source_turns(installation_id,turn_id,session_id,state) VALUES($1,$2,$3,'completed')",[pagedInstallation,'💡'.repeat(513),name])
  await expect(planPagedCleanup(fixture.config,[{installationId:pagedInstallation,sessionId:name}],join(directory,'invalid-utf16-plan'),options)).rejects.toThrow('paged_manifest_identity')
 },120000)
 test.each([{compilerBytes:8388609,evidenceBytes:0},{compilerBytes:32,evidenceBytes:0},{compilerBytes:4500000,evidenceBytes:4500000}])('R2 unknown exact-source compiler $compilerBytes and evidence $evidenceBytes refuse without oversized transfer or omitted dependent',async({compilerBytes,evidenceBytes})=>{
  const name='paged-big-exact-compiler-'+compilerBytes;await fixture.source(name,1)
  const source=(await fixture.sql('SELECT source_event_id::text FROM memory.source_events WHERE session_id=$1',[name])).rows[0].source_event_id
  const episode=(await fixture.sql("INSERT INTO memory.work_episodes(installation_id,episode_id,session_id,turn_id,state,compiler_version,evidence_manifest,document_compiler_version) VALUES($1,gen_random_uuid(),$2,$2,'ready','fixture',jsonb_build_object('source',jsonb_build_object('source_event_id',$3::text))||CASE WHEN $5::int>0 THEN jsonb_build_object('padding',repeat('x',$5::int)) ELSE '{}'::jsonb END,repeat('x',$4::int)) RETURNING episode_id::text",[pagedInstallation,name,source,compilerBytes,evidenceBytes])).rows[0].episode_id
  const before=(await fixture.sql('SELECT xmin::text AS row_version,state FROM memory.work_episodes WHERE episode_id=$1',[episode])).rows
  const c=new pg.Client({connectionString:url});await c.connect();const original=c.query.bind(c);let transferred=false
  c.query=((...args:unknown[])=>{const result=Reflect.apply(original,c,args);return result?.then?(result as Promise<pg.QueryResult>).then(r=>{if(Buffer.byteLength(JSON.stringify(r.rows))>8388608)transferred=true;return r}):result}) as pg.Client['query']
  try{
   await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
   await expect(assertPagedExactEpisodes(c,[{installationId:pagedInstallation,sessionId:name}],[pagedInstallation],[episode])).rejects.toThrow(compilerBytes+evidenceBytes>8388608?'paged_component_capacity':'cleanup_exact_source_packet_version_unsupported')
   expect(transferred).toBe(false)
  }finally{await c.query('ROLLBACK');await c.end()}
  expect((await fixture.sql('SELECT xmin::text AS row_version,state FROM memory.work_episodes WHERE episode_id=$1',[episode])).rows).toEqual(before)
  expect((await fixture.sql('SELECT count(*)::int AS n FROM memory.source_events WHERE source_event_id=$1',[source])).rows[0].n).toBe(1)
 },120000)
 test('R1 oversized exact-source manifests never return their JSON to the client',async()=>{
  const name='paged-big-exact-manifest';await fixture.source(name,1)
  const episode=(await fixture.sql("INSERT INTO memory.work_episodes(installation_id,episode_id,session_id,turn_id,state,compiler_version,evidence_manifest) VALUES($1,gen_random_uuid(),$2,$2,'ready','fixture',jsonb_build_object('body',repeat('x',8388609))) RETURNING episode_id::text",[pagedInstallation,name])).rows[0].episode_id
  const c=new pg.Client({connectionString:url});await c.connect();const original=c.query.bind(c);let transferred=false
  c.query=((...args:unknown[])=>{const result=Reflect.apply(original,c,args);return result?.then?(result as Promise<pg.QueryResult>).then(r=>{if(r.rows.some(row=>row.evidence_manifest&&Buffer.byteLength(JSON.stringify(row.evidence_manifest))>8388608))transferred=true;return r}):result}) as pg.Client['query']
  try{await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await expect(assertPagedExactEpisodes(c,[{installationId:pagedInstallation,sessionId:name}],[pagedInstallation],[episode])).rejects.toThrow('paged_component_capacity');expect(transferred).toBe(false)}finally{await c.query('ROLLBACK');await c.end()}
  expect((await fixture.sql('SELECT state FROM memory.work_episodes WHERE episode_id=$1',[episode])).rows[0].state).toBe('ready')
 },120000)
 test.each(['running-extraction','running-generation','late-running'] as const)('R1 unsupported active extraction graph %s refuses before business writes',async kind=>{
  const name='paged-active-'+kind;await fixture.source(name,1)
  const episode=(await fixture.sql("INSERT INTO memory.work_episodes(installation_id,episode_id,session_id,turn_id,state,compiler_version) VALUES($1,gen_random_uuid(),$2,$2,'ready','fixture') RETURNING episode_id::text",[pagedInstallation,name])).rows[0].episode_id
  const generation=(await fixture.sql("INSERT INTO memory.memory_generation_runs(run_id,installation_id,operation,subject_kind,subject_key_hash,input_digest,effective_policy_hash,state,error_code) VALUES(gen_random_uuid(),$1,'extract_candidates','episode',sha256(convert_to($2::text,'UTF8')),sha256('input'),sha256('policy'),$3,'provider_result_unknown') RETURNING run_id::text",[pagedInstallation,episode,kind==='running-generation'?'running':'failed'])).rows[0].run_id
  await fixture.sql("INSERT INTO memory.memory_extraction_runs(run_id,installation_id,episode_id,episode_source_digest,extractor_version,prompt_version,model_config_hash,input_digest,mode,state,provider,model,error_code,generation_run_id) VALUES(gen_random_uuid(),$1,$2,sha256('source'),'fixture','fixture',sha256('model'),sha256('input'),'enabled',$3,'text','synthetic','provider_result_unknown',$4)",[pagedInstallation,episode,kind==='running-extraction'?'running':'failed',generation])
  const target=join(directory,name+'-plan'),root={installationId:pagedInstallation,sessionId:name}
  if(kind==='late-running'){await planPagedCleanup(fixture.config,[root],target,options);await fixture.sql("UPDATE memory.memory_extraction_runs SET state='running' WHERE episode_id=$1",[episode]);await expect(applyPagedCleanup(fixture.config,target,options)).rejects.toThrow(/paged_(active_extraction_adapter_required|original_row_drift)/)}
  else await expect(planPagedCleanup(fixture.config,[root],target,options)).rejects.toThrow('paged_active_extraction_adapter_required')
  expect((await fixture.sql('SELECT count(*)::int AS n FROM memory.source_events WHERE session_id=$1',[name])).rows[0].n).toBe(1)
 },120000)
 test('unknown original mapping refuses before publication or deletion',async()=>{
  const name='paged-original-unknown';await fixture.source(name,1,true)
  const saved=(await fixture.sql('SELECT to_jsonb(t)::text AS value FROM memory.source_events t WHERE session_id=$1',[name])).rows
  await expect(planPagedCleanup(fixture.config,[{installationId:pagedInstallation,sessionId:name}],join(directory,'unknown-original-plan'),options)).rejects.toThrow('paged_original_source_unproved')
  expect((await fixture.sql('SELECT to_jsonb(t)::text AS value FROM memory.source_events t WHERE session_id=$1',[name])).rows).toEqual(saved)
 },120000)
 test('recognized plural Session reference refuses before the first Memory write',async()=>{
  const name='paged-session-negative';await fixture.source(name,1);await fixture.source('outside-session-negative',1)
  await fixture.sql("UPDATE memory.source_events SET source_provenance=jsonb_build_object('sessionIds',jsonb_build_array($1::text)) WHERE session_id='outside-session-negative'",[name])
  const target=join(directory,'session-negative-plan');await planPagedCleanup(fixture.config,[{installationId:pagedInstallation,sessionId:name}],target,options)
  await expect(applyPagedCleanup(fixture.config,target,options)).rejects.toThrow('paged_original_json_reference_drift')
  expect((await fixture.sql('SELECT count(*)::int AS n FROM memory.source_events WHERE session_id=$1',[name])).rows[0].n).toBe(1)
 },120000)
 test('metadata primary index option drift cannot hide behind its expected name',async()=>{
  const name='paged-metadata-negative';await fixture.source(name,1);const target=join(directory,'metadata-negative-plan')
  await planPagedCleanup(fixture.config,[{installationId:pagedInstallation,sessionId:name}],target,options)
  await applyPagedCleanup(fixture.config,target,options)
  await fixture.sql('ALTER INDEX shared.memory_forward_cleanup_v4_items_pkey SET(fillfactor=70)')
  try{await expect(verifyPagedCleanup(fixture.config,target,options)).rejects.toThrow(/checkpoint.*drift/)}finally{await fixture.sql('ALTER INDEX shared.memory_forward_cleanup_v4_items_pkey RESET(fillfactor)')}
 },120000)
 test('read-only verification authenticates stored parts against the sealed file manifest',async()=>{
  const name='paged-stored-part-negative';await fixture.source(name,1);const target=join(directory,'stored-part-plan')
  const header=await planPagedCleanup(fixture.config,[{installationId:pagedInstallation,sessionId:name}],target,options)
  await applyPagedCleanup(fixture.config,target,options)
  const saved=(await fixture.sql('SELECT page FROM shared.memory_forward_cleanup_v4_pages WHERE plan_hash=$1 AND ordinal=0',[header.manifestHash])).rows[0].page
  await fixture.sql("UPDATE shared.memory_forward_cleanup_v4_pages SET page=jsonb_set(page,'{componentHash}',to_jsonb(repeat('a',64))) WHERE plan_hash=$1 AND ordinal=0",[header.manifestHash])
  try{await expect(verifyPagedCleanup(fixture.config,target,options)).rejects.toThrow('paged_stored_page_state_drift')}finally{await fixture.sql('UPDATE shared.memory_forward_cleanup_v4_pages SET page=$2::jsonb WHERE plan_hash=$1 AND ordinal=0',[header.manifestHash,JSON.stringify(saved)])}
 },120000)
 test('an extra body-free checkpoint identity is outside the immutable original roster',async()=>{
  const name='paged-extra-original';await fixture.source(name,1);const target=join(directory,'extra-original-plan'),header=await planPagedCleanup(fixture.config,[{installationId:pagedInstallation,sessionId:name}],target,options)
  await applyPagedCleanup(fixture.config,target,options)
  await fixture.sql(`WITH copy AS(SELECT original||jsonb_build_object('key',original->'key'||jsonb_build_object('source_event_id',gen_random_uuid()::text),'references',(original->'references')-'row_version','fingerprint',repeat('0',64)) AS original FROM shared.memory_forward_cleanup_v4_items WHERE plan_hash=$1 AND table_name='source_events' LIMIT 1)
   INSERT INTO shared.memory_forward_cleanup_v4_items(plan_hash,table_name,key_hash,original,expected_version,expected_fingerprint,absent,last_page,first_page,first_index)
   SELECT $1,'source_events',encode(sha256(convert_to((original->'key')::text,'UTF8')),'hex'),original,'',repeat('0',64),true,-1,0,0 FROM copy`,[header.manifestHash])
  await expect(verifyPagedCleanup(fixture.config,target,options)).rejects.toThrow('paged_manifest_roster_drift')
 },120000)
 test('access-revoked final barrier preserves the current native reason',async()=>{
  const name='paged-access-revoked';await fixture.source(name,1);await fixture.sql('DELETE FROM public.deleted_sessions WHERE session_id=$1',[name])
  await fixture.sql("UPDATE public.extension_installations SET event_filter='{\"daemon_ids\":[\"not-this-daemon\"]}' WHERE installation_id=$1",[pagedInstallation])
  await fixture.sql("UPDATE memory.memory_installations SET event_filter='{\"daemon_ids\":[\"not-this-daemon\"]}' WHERE installation_id=$1",[pagedInstallation])
  try{const target=join(directory,'access-revoked-plan');await planPagedCleanup(fixture.config,[{installationId:pagedInstallation,sessionId:name}],target,options);const result=await applyPagedCleanup(fixture.config,target,options)
   expect(result).toMatchObject({verificationScope:'fixed_original_personal_roots',globalRetainedAuthorityVerified:false,privacyCatchupReadyForReopen:true,reopeningReady:false,activationAuthorized:false})
   expect((await fixture.sql('SELECT reason FROM memory.memory_session_tombstones WHERE installation_id=$1 AND session_id=$2',[pagedInstallation,name])).rows[0].reason).toBe('access_revoked')
  }finally{await fixture.sql("UPDATE public.extension_installations SET event_filter='{}' WHERE installation_id=$1",[pagedInstallation]);await fixture.sql("UPDATE memory.memory_installations SET event_filter='{}' WHERE installation_id=$1",[pagedInstallation])}
 },120000)
 test('physical deadline cancels the actual backend before reporting interruption',async()=>{
  let pid:number|undefined;const start=Date.now()
  await expect(pagedWindow(fixture.config,{...options,transactionTimeoutMs:200},true,async c=>{pid=(await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;await c.query('SELECT pg_sleep(3)')})).rejects.toThrow(/expired|interrupted/)
  expect(pid).toBeTypeOf('number');expect(Date.now()-start).toBeLessThan(1800)
  const stillRunning=(await fixture.sql("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND state='active'",[pid])).rowCount
  expect(stillRunning).toBe(0)
 },10000)
 test('interrupted delayed DML cannot commit or issue late SQL and leaves a peer untouched',async()=>{
  const peer=new pg.Client({connectionString:url});await peer.connect();let lateRefused=false
  try{await peer.query('BEGIN READ ONLY')
   await expect(pagedWindow(fixture.config,{...options,transactionTimeoutMs:200},false,async c=>{
    try{await c.query('WITH wait AS MATERIALIZED(SELECT pg_sleep(3)) INSERT INTO public.paged_cancel_probe SELECT 1 FROM wait')}
    catch(error){try{await c.query('INSERT INTO public.paged_cancel_probe VALUES(2)')}catch{lateRefused=true}throw error}
   })).rejects.toThrow(/expired|interrupted/)
   expect(lateRefused).toBe(true);expect((await fixture.sql('SELECT count(*)::int AS n FROM public.paged_cancel_probe')).rows[0].n).toBe(0)
   expect((await peer.query('SELECT 42 AS n')).rows[0].n).toBe(42)
  }finally{await peer.query('ROLLBACK');await peer.end()}
 },10000)
 let rawWorkflow:{target:string;partCount:string;before:string;started:number;receipt?:Awaited<ReturnType<typeof applyPagedCleanup>>;audit?:unknown[];fees:unknown[]}|undefined
 test('plans selected2050 raw rows and commits the first exact lost ACK prefix',async()=>{
  const started=Date.now()
  await fixture.source(pagedRoot.sessionId,2050)
  const original=(await fixture.sql(`SELECT count(*)::int AS n,bool_and(s.mapping_state='verified' AND s.source_kind='relay_event' AND s.canonical_session_key=s.session_id AND s.source_provenance->>'state'='known' AND s.source_provenance->'memory'->>'skill_state'='unknown' AND e.user_id=i.owner_user_id AND e.logical_source_session_id=s.session_id AND d.session_id IS NOT NULL AND e.canonical_payload_hash=encode(s.content_hash,'hex')) AS proven FROM memory.source_events s JOIN public.events e ON e.id::text=s.canonical_key JOIN public.extension_installations i USING(installation_id) JOIN public.deleted_sessions d ON d.session_id=s.session_id WHERE s.session_id=$1`,[pagedRoot.sessionId])).rows[0]
  expect(original).toEqual({n:2050,proven:true})
  await fixture.sql("INSERT INTO public.sessions(session_id,user_id,daemon_id,source,content_state,agent_type) SELECT 'unrelated-'||n,1,'paged-daemon','codex','hot','codex' FROM generate_series(1,1500)n")
  await fixture.sql("INSERT INTO memory.source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) SELECT $1,'unrelated-'||n,now(),now() FROM generate_series(1,1500)n",[pagedInstallation])
  await fixture.sql("INSERT INTO memory.source_events(source_event_id,installation_id,origin,origin_position,session_id,event_type,occurred_at,payload,payload_hash,source_provenance) SELECT gen_random_uuid(),$1,'feed','outside-'||n,'unrelated-'||(1+n%1500),'test',now(),jsonb_build_object('text',repeat('outside prose',100)),decode(repeat('cd',32),'hex'),jsonb_build_object('note',repeat('unrelated prose',1000)) FROM generate_series(1,5000)n",[pagedInstallation])
  const before=(await fixture.sql("SELECT md5(string_agg(md5(to_jsonb(t)::text),'' ORDER BY source_event_id)) AS digest FROM memory.source_events t WHERE session_id<>$1",[pagedRoot.sessionId])).rows[0].digest
  const target=join(directory,'source-plan'),header=await planPagedCleanup(fixture.config,[pagedRoot],target,options)
  expect(header.schemaVersion).toBe(4);expect(BigInt(header.partCount)).toBeGreaterThan(12n)
  let rawPages=0;for await(const p of readPagedCleanupParts(await openPagedCleanupManifest(target))){expect(p.records.length).toBeLessThanOrEqual(1024);expect(p.records.reduce((n,r)=>n+BigInt(r.bytes),0n)).toBeLessThanOrEqual(8388608n);if(p.phase==='raw')rawPages++}
  expect(rawPages).toBeGreaterThan(12)
  const fees=(await fixture.sql('SELECT run_id::text,xmin::text AS row_version,to_jsonb(g)::text AS value FROM memory.memory_generation_runs g ORDER BY g.run_id')).rows
  rawWorkflow={target,partCount:header.partCount,before,started,fees}
  let committed=0;await expect(applyPagedCleanup(fixture.config,target,{...options,afterCommit:async()=>{if(++committed===2)throw Error('lost_commit_ack')}})).rejects.toThrow('lost_commit_ack')
  const prefix=(await fixture.sql('SELECT r.ordinal::text FROM shared.memory_forward_cleanup_v4_receipts r WHERE r.plan_hash=$1 ORDER BY r.ordinal',[header.manifestHash])).rows
  expect(prefix.map(row=>row.ordinal)).toEqual(['0','1'])
 },120000)
 test('resumes the same2050 raw manifest with complete source and unrelated-body invariants',async()=>{
  expect(rawWorkflow).toBeDefined();const work=rawWorkflow!
  const receipt=await applyPagedCleanup(fixture.config,work.target,options);work.receipt=receipt
  expect(receipt.privacyCatchupReadyForReopen).toBe(true);expect(receipt.activationAuthorized).toBe(false);expect(receipt.completedPages).toBe(work.partCount)
  expect((await fixture.sql('SELECT count(*)::int AS n FROM memory.source_events WHERE session_id=$1',[pagedRoot.sessionId])).rows[0].n).toBe(0)
  expect((await fixture.sql("SELECT md5(string_agg(md5(to_jsonb(t)::text),'' ORDER BY source_event_id)) AS digest FROM memory.source_events t WHERE session_id<>$1",[pagedRoot.sessionId])).rows[0].digest).toBe(work.before)
  expect((await fixture.sql('SELECT body FROM public.paged_canonical_sentinel')).rows[0].body).toBe('canonical must survive')
  expect((await fixture.sql('SELECT run_id::text,xmin::text AS row_version,to_jsonb(g)::text AS value FROM memory.memory_generation_runs g ORDER BY g.run_id')).rows).toEqual(work.fees)
  work.audit=(await fixture.sql('SELECT g.sequence::text,g.xmin::text AS row_version FROM memory.memory_governance_migration_changes g ORDER BY g.sequence')).rows
 },120000)
 test('verifies that same2050 raw manifest read-only without repeated native effects',async()=>{
  expect(rawWorkflow?.receipt).toBeDefined();const work=rawWorkflow!
  expect(await verifyPagedCleanup(fixture.config,work.target,options)).toMatchObject({privacyCatchupReadyForReopen:true,completedPages:work.receipt!.completedPages})
  expect((await fixture.sql('SELECT g.sequence::text,g.xmin::text AS row_version FROM memory.memory_governance_migration_changes g ORDER BY g.sequence')).rows).toEqual(work.audit)
  expect((await fixture.sql('SELECT run_id::text,xmin::text AS row_version,to_jsonb(g)::text AS value FROM memory.memory_generation_runs g ORDER BY g.run_id')).rows).toEqual(work.fees)
  process.stdout.write(JSON.stringify({task7RawComplete:{sources:2050,unrelatedSources:5000,unrelatedSessions:1500,pages:work.partCount,cumulativeWallMs:Date.now()-work.started}})+'\n')
 },120000)
 test.each(['part','part-and-hash','load-part-and-hash','receipt','item','late-edge'] as const)('R1 resumed prefix detects post-seal %s tampering before the next write',async kind=>{
  const name='paged-post-seal-'+kind,outside='outside-post-seal-'+kind;await fixture.source(name,260);await fixture.source(outside,1)
  const target=join(directory,name+'-plan'),header=await planPagedCleanup(fixture.config,[{installationId:pagedInstallation,sessionId:name}],target,options)
  let deleted:string|undefined;for await(const page of readPagedCleanupParts(await openPagedCleanupManifest(target))){deleted=page.records.find(r=>r.table==='source_events')?.key.source_event_id??deleted;if(deleted)break}
  if(kind!=='load-part-and-hash')await expect(applyPagedCleanup(fixture.config,target,{...options,afterCommit:async ordinal=>{if(ordinal==='0')throw Error('initial_ack_lost')}})).rejects.toThrow('initial_ack_lost')
  const before=(await fixture.sql('SELECT count(*)::int AS n FROM memory.source_events WHERE session_id=$1',[name])).rows[0].n
  const original=pg.Client.prototype.query;let sealed:pg.Client|undefined,mutated=false
  const spy=vi.spyOn(pg.Client.prototype,'query').mockImplementation(function(this:pg.Client,...args:unknown[]){
   const sql=typeof args[0]==='string'?args[0]:''
   if(kind==='load-part-and-hash'?sql.startsWith('INSERT INTO shared."memory_forward_cleanup_v4_pages"'):sql.startsWith('UPDATE shared."memory_forward_cleanup_v4_plans" SET sealed=true'))sealed=this
   const result=Reflect.apply(original,this,args)
   return result?.then?(result as Promise<pg.QueryResult>).then(async row=>{
    if(sql==='COMMIT'&&sealed===this&&!mutated){mutated=true
     if(kind==='part')await fixture.sql("UPDATE shared.memory_forward_cleanup_v4_pages SET page=jsonb_set(page,'{componentHash}',to_jsonb(repeat('f',64))) WHERE plan_hash=$1 AND ordinal=0",[header.manifestHash])
     if(kind==='part-and-hash'||kind==='load-part-and-hash')await fixture.sql("UPDATE shared.memory_forward_cleanup_v4_pages SET page=jsonb_set(page,'{componentHash}',to_jsonb(repeat('f',64))),page_state_hash=encode(sha256(convert_to(jsonb_set(page,'{componentHash}',to_jsonb(repeat('f',64)))::text,'UTF8')),'hex') WHERE plan_hash=$1 AND ordinal=0",[header.manifestHash])
     if(kind==='receipt')await fixture.sql("UPDATE shared.memory_forward_cleanup_v4_receipts SET before_hash=repeat('f',64) WHERE plan_hash=$1 AND ordinal=0",[header.manifestHash])
     if(kind==='item')await fixture.sql("UPDATE shared.memory_forward_cleanup_v4_items SET expected_version='tampered' WHERE plan_hash=$1 AND last_page=0",[header.manifestHash])
     if(kind==='late-edge')await fixture.sql("UPDATE memory.source_events SET source_provenance=jsonb_build_object('sourceEventIds',jsonb_build_array(upper($1))) WHERE session_id=$2",[deleted,outside])
    }return row
   }):result
  } as pg.Client['query'])
  try{await expect(applyPagedCleanup(fixture.config,target,options)).rejects.toThrow(/paged_/);expect(mutated).toBe(true);expect((await fixture.sql('SELECT count(*)::int AS n FROM memory.source_events WHERE session_id=$1',[name])).rows[0].n).toBe(before)}finally{spy.mockRestore()}
 },120000)
 test('actual first middle and final lost COMMIT acknowledgements resume without repeated native effects',async()=>{
  const name='paged-all-commit-positions';await fixture.source(name,390)
  const target=join(directory,'all-commit-positions-plan'),header=await planPagedCleanup(fixture.config,[{installationId:pagedInstallation,sessionId:name}],target,options)
  const boundary=(await fixture.sql('SELECT COALESCE(max(sequence),0)::text AS n FROM memory.memory_governance_migration_changes')).rows[0].n
  const protectedBefore=(await fixture.sql("SELECT (SELECT count(*)::int FROM memory.memory_jobs) AS jobs,(SELECT count(*)::int FROM memory.memory_git_outbox) AS git")).rows
  let prior:unknown[]=[]
  for(const ordinal of ['0',String(Math.floor(Number(header.partCount)/2)),String(BigInt(header.partCount)-1n)]){
   await expect(applyPagedCleanup(fixture.config,target,{...options,afterCommit:async n=>{if(n===ordinal)throw Error('lost_commit_ack_'+ordinal)}})).rejects.toThrow('lost_commit_ack_'+ordinal)
   const receipts=(await fixture.sql('SELECT r.ordinal::text,r.receipt_hash,r.completed_at::text FROM shared.memory_forward_cleanup_v4_receipts r WHERE r.plan_hash=$1 ORDER BY r.ordinal',[header.manifestHash])).rows
   expect(receipts.slice(0,prior.length)).toEqual(prior);expect(receipts.at(-1)?.ordinal).toBe(ordinal);prior=receipts
  }
  const completed=(await fixture.sql('SELECT source_event_id::text FROM memory.source_events WHERE session_id=$1',[name])).rowCount;expect(completed).toBe(0)
  const noRepeat=(await fixture.sql('SELECT sequence::text,xmin::text FROM memory.memory_governance_migration_changes WHERE sequence>$1::bigint ORDER BY sequence',[boundary])).rows
  expect((await applyPagedCleanup(fixture.config,target,options)).privacyCatchupReadyForReopen).toBe(true)
  expect((await fixture.sql('SELECT sequence::text,xmin::text FROM memory.memory_governance_migration_changes WHERE sequence>$1::bigint ORDER BY sequence',[boundary])).rows).toEqual(noRepeat)
  expect((await fixture.sql("SELECT (SELECT count(*)::int FROM memory.memory_jobs) AS jobs,(SELECT count(*)::int FROM memory.memory_git_outbox) AS git")).rows).toEqual(protectedBefore)
 },120000)
 let claimWorkflow:{target:string;header:{manifestHash:string;partCount:string};accepted:Awaited<ReturnType<typeof fixture.acceptedClaims>>;saved:unknown[];identities:unknown[];fee:unknown[];started:number;prefix:unknown[];audit?:unknown[]}|undefined
 test('plans one immutable1030 Claim workflow with515 same-version and515 accepted-only forms',async()=>{
  const started=Date.now(),name='paged-episodes';await fixture.source(name,1)
  await fixture.sql("INSERT INTO memory.work_episodes(installation_id,episode_id,session_id,turn_id,state,compiler_version) SELECT $1,gen_random_uuid(),$2,'independent-'||n,'ready','test' FROM generate_series(1,1030)n",[pagedInstallation,name])
  const ids=(await fixture.sql('SELECT episode_id::text FROM memory.work_episodes WHERE session_id=$1 ORDER BY episode_id',[name])).rows.map(r=>r.episode_id)
  const accepted=await fixture.acceptedClaims(ids);expect(accepted.length).toBe(1030);expect(accepted.filter(row=>row.replacement).length).toBe(515)
  await fixture.sql("INSERT INTO memory.memory_generation_runs(run_id,installation_id,operation,subject_kind,subject_key_hash,input_digest,effective_policy_hash,state,provider,model,input_tokens,output_tokens,cost_micros,error_code) VALUES(gen_random_uuid(),$1,'compile_context','session',decode(md5($2),'hex'),sha256('claim-fee-input'),sha256('policy'),'cancelled','text','synthetic',37,19,23,'provider_result_unknown')",[pagedInstallation,name])
  const fee=(await fixture.sql("SELECT run_id::text,xmin::text,to_jsonb(g)::text AS value FROM memory.memory_generation_runs g WHERE subject_key_hash=decode(md5($1),'hex')",[name])).rows
  const saved=(await fixture.sql('SELECT to_jsonb(c)::text AS row FROM memory.knowledge_evidence_capsules c ORDER BY capsule_id')).rows
  const identities=(await fixture.sql('SELECT claim_id::text,normalized_key,normalized_key_v2,topic_key_v2,duplicate_digest_v2,canonical_repository_key,scope_kind,scope_key FROM memory.knowledge_claims WHERE claim_id=ANY($1::uuid[]) ORDER BY claim_id',[accepted.map(a=>a.claim)])).rows.map(row=>{
   const seed=accepted.find(item=>item.claim===row.claim_id)!
   expect({normalized_key:row.normalized_key,normalized_key_v2:row.normalized_key_v2,topic_key_v2:row.topic_key_v2,duplicate_digest_v2:row.duplicate_digest_v2}).toEqual(seed.currentIdentity)
   // Freeze the independently accepted seed's mature identity before cleanup.
   // Same-version facts must retain the original current identity verbatim.
   return seed.replacement?{...row,...seed.acceptedIdentity}:row
  })
  const target=join(directory,'episodes-plan'),header=await planPagedCleanup(fixture.config,[{installationId:pagedInstallation,sessionId:name}],target,options)
  claimWorkflow={target,header,accepted,saved,identities,fee,started,prefix:[]}
  expect(BigInt(header.partCount)).toBeGreaterThan(10n)
  process.stdout.write(JSON.stringify({task7ClaimPlan:{claims:1030,pages:header.partCount,planAndFixtureMs:Date.now()-started}})+'\n')
 },120000)
 for(let segment=1;segment<=6;segment++)test('advances the same1030 Claim receipt prefix segment '+segment,async()=>{
  expect(claimWorkflow).toBeDefined();const work=claimWorkflow!,ordinal=String(Math.floor(Number(work.header.partCount)*segment/7)-1)
  await expect(applyPagedCleanup(fixture.config,work.target,{...options,afterCommit:async n=>{if(n===ordinal)throw Error('claim_segment_ack_lost')}})).rejects.toThrow('claim_segment_ack_lost')
  const prefix=(await fixture.sql('SELECT r.ordinal::text,r.receipt_hash,r.completed_at::text FROM shared.memory_forward_cleanup_v4_receipts r WHERE r.plan_hash=$1 ORDER BY r.ordinal',[work.header.manifestHash])).rows
  expect(prefix.slice(0,work.prefix.length)).toEqual(work.prefix);expect(prefix.at(-1)?.ordinal).toBe(ordinal);work.prefix=prefix
 },120000)
 test('commits that1030 Claim workflow final page with the same exact lost ACK prefix',async()=>{
  expect(claimWorkflow).toBeDefined();const work=claimWorkflow!,last=String(BigInt(work.header.partCount)-1n)
  await expect(applyPagedCleanup(fixture.config,work.target,{...options,afterCommit:async n=>{if(n===last)throw Error('claim_final_ack_lost')}})).rejects.toThrow('claim_final_ack_lost')
  const prefix=(await fixture.sql('SELECT r.ordinal::text,r.receipt_hash,r.completed_at::text FROM shared.memory_forward_cleanup_v4_receipts r WHERE r.plan_hash=$1 ORDER BY r.ordinal',[work.header.manifestHash])).rows
  expect(prefix.slice(0,work.prefix.length)).toEqual(work.prefix);expect(prefix.length).toBe(Number(work.header.partCount));expect(prefix.at(-1)?.ordinal).toBe(last);work.prefix=prefix
  work.audit=(await fixture.sql('SELECT sequence::text,xmin::text FROM memory.memory_governance_migration_changes ORDER BY sequence')).rows
 },120000)
 test('verifies that1030 Claim workflow exact identities pointers HMACs fees and no final replay',async()=>{
  expect(claimWorkflow?.audit).toBeDefined();const work=claimWorkflow!
  expect((await applyPagedCleanup(fixture.config,work.target,options)).privacyCatchupReadyForReopen).toBe(true)
  expect((await verifyPagedCleanup(fixture.config,work.target,options)).privacyCatchupReadyForReopen).toBe(true)
  expect((await fixture.sql('SELECT sequence::text,xmin::text FROM memory.memory_governance_migration_changes ORDER BY sequence')).rows).toEqual(work.audit)
  expect((await fixture.sql('SELECT r.ordinal::text,r.receipt_hash,r.completed_at::text FROM shared.memory_forward_cleanup_v4_receipts r WHERE r.plan_hash=$1 ORDER BY r.ordinal',[work.header.manifestHash])).rows).toEqual(work.prefix)
  expect((await fixture.sql('SELECT to_jsonb(c)::text AS row FROM memory.knowledge_evidence_capsules c ORDER BY capsule_id')).rows).toEqual(work.saved)
  expect((await fixture.sql('SELECT claim_id::text,normalized_key,normalized_key_v2,topic_key_v2,duplicate_digest_v2,canonical_repository_key,scope_kind,scope_key FROM memory.knowledge_claims WHERE claim_id=ANY($1::uuid[]) ORDER BY claim_id',[work.accepted.map(a=>a.claim)])).rows).toEqual(work.identities)
  expect((await fixture.sql("SELECT run_id::text,xmin::text,to_jsonb(g)::text AS value FROM memory.memory_generation_runs g WHERE subject_key_hash=decode(md5('paged-episodes'),'hex')")).rows).toEqual(work.fee)
  const pointers=(await fixture.sql('SELECT claim_id::text,current_version_id::text FROM memory.knowledge_claims WHERE claim_id=ANY($1::uuid[])',[work.accepted.map(a=>a.claim)])).rows
  expect(pointers.length).toBe(1030);for(const row of pointers)expect(row.current_version_id).toBe(work.accepted.find(a=>a.claim===row.claim_id)!.kept)
  expect((await fixture.sql('SELECT count(*)::int AS n FROM memory.knowledge_versions WHERE version_id=ANY($1::uuid[])',[work.accepted.filter(a=>a.replacement).map(a=>a.current)])).rows[0].n).toBe(0)
  const expectedHmacs=new Set<string>();for await(const page of readPagedCleanupParts(await openPagedCleanupManifest(work.target)))for(const row of page.records)if(row.table==='knowledge_tombstones')expectedHmacs.add(row.key.identity_hmac!)
  const hmacs=(await fixture.sql('SELECT identity_hmac::text FROM memory.knowledge_tombstones WHERE installation_id=$1',[pagedInstallation])).rows.map(r=>r.identity_hmac)
  for(const hmac of expectedHmacs)expect(hmacs).toContain(hmac)
  process.stdout.write(JSON.stringify({task7ClaimComplete:{claims:1030,sameVersion:515,acceptedOnlyReplacement:515,pages:work.header.partCount,cumulativeWallMs:Date.now()-work.started}})+'\n')
 },120000)
 test('minimal invalidated episode preserves original unknown extraction and generation linkage',async()=>{
  const name='paged-unknown-skeleton';await fixture.source(name,1)
  const episode=(await fixture.sql("INSERT INTO memory.work_episodes(installation_id,episode_id,session_id,turn_id,state,compiler_version,document,evidence_manifest,summary) VALUES($1,gen_random_uuid(),$2,$2,'ready','test','{\"text\":\"private compiled body\"}','{}','{\"text\":\"private summary\"}') RETURNING episode_id::text",[pagedInstallation,name])).rows[0].episode_id
  const generation=(await fixture.sql("INSERT INTO memory.memory_generation_runs(run_id,installation_id,operation,subject_kind,subject_key_hash,input_digest,effective_policy_hash,state,provider,model,input_tokens,output_tokens,cost_micros,error_code) VALUES(gen_random_uuid(),$1,'extract_candidates','episode',sha256(convert_to($2::text,'UTF8')),decode(repeat('aa',32),'hex'),decode(repeat('bb',32),'hex'),'failed','text','synthetic',37,19,23,'provider_result_unknown') RETURNING run_id::text",[pagedInstallation,episode])).rows[0].run_id
  const run=(await fixture.sql("INSERT INTO memory.memory_extraction_runs(run_id,installation_id,episode_id,episode_source_digest,extractor_version,prompt_version,model_config_hash,input_digest,mode,state,provider,model,input_tokens,output_tokens,cost_micros,error_code,generation_run_id) VALUES(gen_random_uuid(),$1,$2,decode(repeat('aa',32),'hex'),'test','test',decode(repeat('bb',32),'hex'),decode(repeat('cc',32),'hex'),'enabled','failed','text','synthetic',37,19,23,'provider_result_unknown',$3) RETURNING run_id::text",[pagedInstallation,episode,generation])).rows[0].run_id
  const saved=(await fixture.sql('SELECT to_jsonb(r)::text AS value FROM memory.memory_extraction_runs r WHERE run_id=$1',[run])).rows
  const target=join(directory,'unknown-plan');await planPagedCleanup(fixture.config,[{installationId:pagedInstallation,sessionId:name}],target,options)
  const frozen=[];for await(const page of readPagedCleanupParts(await openPagedCleanupManifest(target)))frozen.push(...page.records)
  expect(frozen.some(row=>row.table==='memory_generation_runs'&&row.key.run_id===generation)).toBe(true)
  expect(frozen.some(row=>row.table==='work_episodes'&&row.key.episode_id===episode&&row.retainReason==='incurred_effect')).toBe(true)
  expect((await applyPagedCleanup(fixture.config,target,options)).privacyCatchupReadyForReopen).toBe(true)
  expect((await fixture.sql('SELECT to_jsonb(r)::text AS value FROM memory.memory_extraction_runs r WHERE run_id=$1',[run])).rows).toEqual(saved)
  expect((await fixture.sql('SELECT state,document,evidence_manifest,summary FROM memory.work_episodes WHERE episode_id=$1',[episode])).rows).toEqual([{state:'invalidated',document:{},evidence_manifest:{},summary:{}}])
  expect((await fixture.sql('SELECT input_tokens::text,output_tokens::text,cost_micros::text,error_code FROM memory.memory_generation_runs WHERE run_id=$1',[generation])).rows[0]).toEqual({input_tokens:'37',output_tokens:'19',cost_micros:'23',error_code:'provider_result_unknown'})
  expect((await fixture.sql("SELECT 1 FROM memory.memory_jobs WHERE installation_id=$1 AND job_type='extract_candidates' AND state IN('pending','running')",[pagedInstallation])).rowCount).toBe(0)
 },120000)
 test('proved typed cross-Session source loss clears only its dependent episode',async()=>{
  const selected='paged-typed-source',outside='paged-typed-dependent';await fixture.source(selected,1);await fixture.source(outside,1)
  await fixture.sql('DELETE FROM public.deleted_sessions WHERE session_id=$1',[outside])
  const source=(await fixture.sql('SELECT source_event_id::text FROM memory.source_events WHERE session_id=$1',[selected])).rows[0].source_event_id
  const episode=(await fixture.sql("INSERT INTO memory.work_episodes(installation_id,episode_id,session_id,turn_id,state,compiler_version,document_compiler_version,document,evidence_manifest,summary) VALUES($1,gen_random_uuid(),$2,'typed-dependent','ready','fixture',$3,'{\"text\":\"derived private text\"}',jsonb_build_object('E1',jsonb_build_object('kind','event','evidence_role','substantive','source_event_id',$4::text,'occurred_at','2026-11-07T00:00:00.000Z','excerpt_hash',repeat('a',64),'excerpt_length',1,'truncated',false,'source_provenance','{}'::jsonb)),'{\"text\":\"private summary\"}') RETURNING episode_id::text",[pagedInstallation,outside,EPISODE_PACKET_COMPILER_VERSION,source])).rows[0].episode_id
  const outsideBefore=(await fixture.sql('SELECT to_jsonb(t)::text AS row FROM memory.source_events t WHERE session_id=$1',[outside])).rows
  const target=join(directory,'typed-cross-source-plan');await planPagedCleanup(fixture.config,[{installationId:pagedInstallation,sessionId:selected}],target,options)
  expect((await applyPagedCleanup(fixture.config,target,options)).privacyCatchupReadyForReopen).toBe(true)
  expect((await fixture.sql('SELECT state,document,evidence_manifest,summary FROM memory.work_episodes WHERE episode_id=$1',[episode])).rows[0]).toEqual({state:'invalidated',document:{},evidence_manifest:{},summary:{}})
  expect((await fixture.sql('SELECT to_jsonb(t)::text AS row FROM memory.source_events t WHERE session_id=$1',[outside])).rows).toEqual(outsideBefore)
  expect((await fixture.sql('SELECT 1 FROM memory.memory_session_tombstones WHERE session_id=$1',[outside])).rowCount).toBe(0)
 },120000)
 test('independent Session context generations paginate while uncertain fees remain exact',async()=>{
  const session='paged-context-generations';await fixture.source(session,1)
  await fixture.sql("INSERT INTO memory.memory_generation_runs(run_id,installation_id,operation,subject_kind,subject_key_hash,input_digest,effective_policy_hash,state,provider,model,input_tokens,output_tokens,cost_micros,error_code) SELECT gen_random_uuid(),$1,'compile_context','session',decode(md5($2),'hex'),sha256(convert_to(n::text,'UTF8')),decode(repeat('b',64),'hex'),CASE WHEN n%3=0 THEN 'cancelled' ELSE 'running' END,'text','synthetic',37,19,23,CASE WHEN n%2=0 THEN 'provider_result_unknown' END FROM generate_series(1,1030)n",[pagedInstallation,session])
  const noops=(await fixture.sql("SELECT run_id::text,xmin::text FROM memory.memory_generation_runs WHERE subject_key_hash=decode(md5($1),'hex') AND state='cancelled' ORDER BY run_id",[session])).rows
  const target=join(directory,'context-generations-plan');await planPagedCleanup(fixture.config,[{installationId:pagedInstallation,sessionId:session}],target,options)
  expect((await applyPagedCleanup(fixture.config,target,options)).privacyCatchupReadyForReopen).toBe(true)
  expect((await fixture.sql("SELECT count(*)::int AS n,bool_and(state='cancelled' AND input_tokens=37 AND output_tokens=19 AND cost_micros=23 AND(error_code IN('provider_result_unknown','source_purged') OR error_code IS NULL) AND job_id IS NULL AND output_id IS NULL) AS exact FROM memory.memory_generation_runs WHERE installation_id=$1 AND subject_kind='session' AND subject_key_hash=decode(md5($2),'hex')",[pagedInstallation,session])).rows[0]).toEqual({n:1030,exact:true})
  expect((await fixture.sql('SELECT run_id::text,xmin::text FROM memory.memory_generation_runs WHERE run_id=ANY($1::uuid[]) ORDER BY run_id',[noops.map(r=>r.run_id)])).rows).toEqual(noops)
 },120000)
 test.each(['late-job','late-generation','original-output'] as const)('context operational %s refuses before the first business mutation',async kind=>{
  const session='paged-context-'+kind;await fixture.source(session,1)
  const generation=(await fixture.sql("INSERT INTO memory.memory_generation_runs(run_id,installation_id,operation,subject_kind,subject_key_hash,input_digest,effective_policy_hash,state,error_code,output_kind,output_id) VALUES(gen_random_uuid(),$1,'compile_context','session',decode(md5($2),'hex'),decode(repeat('a',64),'hex'),decode(repeat('b',64),'hex'),'running','provider_result_unknown',CASE WHEN $3 THEN 'unknown_output' END,CASE WHEN $3 THEN gen_random_uuid() END) RETURNING run_id::text",[pagedInstallation,session,kind==='original-output'])).rows[0].run_id
  const target=join(directory,'context-'+kind+'-plan'),root={installationId:pagedInstallation,sessionId:session}
  if(kind==='original-output'){await expect(planPagedCleanup(fixture.config,[root],target,options)).rejects.toThrow('paged_context_job_output_adapter_required');return}
  await planPagedCleanup(fixture.config,[root],target,options)
  if(kind==='late-job')await fixture.sql("INSERT INTO memory.memory_jobs(job_id,installation_id,job_type,idempotency_key,payload) VALUES(gen_random_uuid(),$1,'compile_context_shadow',$2,jsonb_build_object('generationRunIds',jsonb_build_array(upper($3))))",[pagedInstallation,session,generation])
  else await fixture.sql("INSERT INTO memory.memory_generation_runs SELECT (jsonb_populate_record(NULL::memory.memory_generation_runs,to_jsonb(g)||jsonb_build_object('run_id',gen_random_uuid()::text,'input_digest','\\x'||repeat('c',64)))).* FROM memory.memory_generation_runs g WHERE run_id=$1",[generation])
  await expect(applyPagedCleanup(fixture.config,target,options)).rejects.toThrow(kind==='late-job'?'paged_context_job_output_adapter_required':'paged_original_generation_row_drift')
  expect((await fixture.sql('SELECT count(*)::int AS n FROM memory.source_events WHERE session_id=$1',[session])).rows[0].n).toBe(1)
  expect((await fixture.sql('SELECT state,error_code FROM memory.memory_generation_runs WHERE run_id=$1',[generation])).rows[0]).toEqual({state:'running',error_code:'provider_result_unknown'})
 },120000)
 test('one truly connected oversized Claim component refuses before any business mutation',async()=>{
  const name='paged-indivisible';await fixture.source(name,1)
  await fixture.sql("INSERT INTO memory.work_episodes(installation_id,episode_id,session_id,turn_id,state,compiler_version) SELECT $1,gen_random_uuid(),$2,'oversized-'||n,'ready','test' FROM generate_series(1,1030)n",[pagedInstallation,name])
  const first=(await fixture.sql('SELECT episode_id::text FROM memory.work_episodes WHERE session_id=$1 LIMIT 1',[name])).rows[0].episode_id,a=await fixture.acceptedClaim(first)
  await fixture.sql("WITH episodes AS(SELECT episode_id,row_number()OVER(ORDER BY episode_id)+1 AS n FROM memory.work_episodes WHERE session_id=$3 AND episode_id<>$4), versions AS(INSERT INTO memory.knowledge_versions(version_id,installation_id,claim_id,version_number,statement,authority,confidence) SELECT gen_random_uuid(),$1,$2,n,'same connected claim history','user_accepted',1 FROM episodes RETURNING version_id,version_number) INSERT INTO memory.knowledge_evidence(evidence_id,installation_id,version_id,episode_id,evidence_kind,excerpt,excerpt_hash,occurred_at,ordinal) SELECT gen_random_uuid(),$1,v.version_id,e.episode_id,'episode','same-component',sha256('same-component'),now(),0 FROM versions v JOIN episodes e ON e.n=v.version_number",[pagedInstallation,a.claim,name,first])
  const before=(await fixture.sql('SELECT count(*)::text AS n FROM memory.work_episodes WHERE session_id=$1',[name])).rows[0].n
  await expect(planPagedCleanup(fixture.config,[{installationId:pagedInstallation,sessionId:name}],join(directory,'oversized-plan'),options)).rejects.toThrow(/component.*(bound|capacity)|bound.*component/)
  expect((await fixture.sql('SELECT count(*)::text AS n FROM memory.work_episodes WHERE session_id=$1',[name])).rows[0].n).toBe(before)
  expect((await fixture.sql('SELECT 1 FROM memory.memory_session_tombstones WHERE session_id=$1',[name])).rowCount).toBe(0)
 },120000)
 test('late edge to already deleted original source refuses next write and readiness',async()=>{
  const name='paged-late-edge';await fixture.source(name,1100);const target=join(directory,'late-plan');await planPagedCleanup(fixture.config,[{installationId:pagedInstallation,sessionId:name}],target,options)
  let original:string|undefined
  for await(const p of readPagedCleanupParts(await openPagedCleanupManifest(target)))if(p.phase==='raw'){original=p.records.find(r=>r.table==='source_events')?.key.source_event_id??undefined;if(original)break}
  expect(original).toBeTruthy();let stopped=false
  await expect(applyPagedCleanup(fixture.config,target,{...options,afterCommit:async()=>{if(stopped)return;const left=(await fixture.sql('SELECT 1 FROM memory.source_events WHERE source_event_id=$1',[original])).rowCount;if(left)return;stopped=true;await fixture.sql("UPDATE memory.source_events SET source_provenance=jsonb_build_object('source_event_id',$1::text) WHERE source_event_id=(SELECT source_event_id FROM memory.source_events WHERE session_id<>$2 LIMIT 1)",[original,name])}})).rejects.toThrow(/reference|drift/)
  expect(stopped).toBe(true);await expect(verifyPagedCleanup(fixture.config,target,options)).rejects.toThrow(/reference|drift/)
 },120000)
})
