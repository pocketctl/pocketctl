import pg from 'pg'
import {afterAll,beforeAll,describe,expect,test} from 'vitest'
import {initDB} from '../db.js'
import {applyRelayTeamSourceCapture} from '../shared-source/team-capture.js'
import {applyRelaySourceCapture} from '../shared-source/capture.js'
import {applyRelayControlCapture} from '../shared-source/control-capture.js'
import {assertExtensionSchema} from '../extensions/schema.js'
import {assertSessionLifecycleSchema} from '../session-lifecycle/schema.js'
import {assertDurableIngressSchema} from '../event-worker-main.js'
import {prepareRelaySchema,assertRelaySchemaContract} from '../schema-runtime.js'
import {assertSessionColdBodiesEnabled,enableSessionColdBodies} from '../session-lifecycle/cold-schema.js'
const url=process.env.RELAY_R1_TEST_DATABASE_URL,suite=url?describe:describe.skip
suite('R1 Relay runtime verifies while the migrator owns DDL',()=>{
 let pool:pg.Pool,runtime:pg.Pool
 beforeAll(async()=>{
  if(!url || !/(^|_)test$/.test(new URL(url).pathname.slice(1)))throw Error('isolated_test_required')
  pool=new pg.Pool({connectionString:url,max:4})
  await pool.query('DROP SCHEMA IF EXISTS memory CASCADE; DROP SCHEMA IF EXISTS shared CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await initDB(pool)
  const {applyMemorySchema}=await import(new URL('../../../memory/src/schema.ts',import.meta.url).href);await applyMemorySchema(pool,{namespace:'memory'})
  await pool.query(`CREATE SCHEMA IF NOT EXISTS shared;
   DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='relay_r1_runtime') THEN CREATE ROLE relay_r1_runtime LOGIN PASSWORD 'only-test'; END IF; END $$;
   CREATE TABLE memory.private_probe(id int);
   REVOKE TEMPORARY ON DATABASE relay_r1_test FROM PUBLIC;
   GRANT USAGE ON SCHEMA public,shared TO relay_r1_runtime; GRANT SELECT ON ALL TABLES IN SCHEMA public TO relay_r1_runtime; REVOKE ALL ON public.native_source_publications,public.native_installation_starts,public.native_team_semantic_publications FROM relay_r1_runtime; REVOKE CREATE ON SCHEMA public FROM PUBLIC;`)
  const {applySharedSourceContract}=await import(new URL('../../../memory/src/migrations/shared-db/contract.ts',import.meta.url).href)
  await applySharedSourceContract(pool)
  await pool.query('GRANT SELECT ON shared.memory_source_contract TO relay_r1_runtime')
  const runtimeUrl=new URL(url);runtimeUrl.username='relay_r1_runtime';runtimeUrl.password='only-test'
  runtime=new pg.Pool({connectionString:runtimeUrl.href,options:'-c search_path=pg_catalog,public,shared'})
 },60000)
 afterAll(async()=>{await runtime?.end();await pool?.end()})
 test('auto requires a read-only contract on shared targets, with no DDL fallback',async()=>{
  expect(await prepareRelaySchema(runtime,()=>initDB(runtime))).toBe('verify')
  await assertDurableIngressSchema(runtime)
  await assertExtensionSchema(runtime)
  await assertSessionLifecycleSchema(runtime)
  await expect(runtime.query('CREATE TABLE public.forbidden(id int)')).rejects.toMatchObject({code:'42501'})
  await expect(prepareRelaySchema(runtime,()=>initDB(runtime),'legacy-migrate')).rejects.toThrow('shared_source_requires_schema_migrator')
  await pool.query('UPDATE public.relay_schema_contract SET version=999')
  await expect(prepareRelaySchema(runtime,()=>initDB(runtime))).rejects.toThrow('relay_schema_contract_unsupported')
  expect((await pool.query('SELECT version FROM public.relay_schema_contract')).rows[0].version).toBe(999)
  await pool.query('UPDATE public.relay_schema_contract SET version=1')
 })
 test('unknown and interrupted shared contracts never fall back to legacy DDL',async()=>{
  await pool.query('UPDATE shared.memory_source_contract SET version=999')
  await expect(prepareRelaySchema(runtime,()=>initDB(runtime))).rejects.toThrow('relay_shared_contract_unsupported')
  await pool.query('UPDATE shared.memory_source_contract SET version=1; ALTER TABLE shared.memory_source_contract RENAME TO interrupted_contract')
  try{await expect(prepareRelaySchema(runtime,()=>initDB(runtime))).rejects.toThrow('relay_shared_contract_required')}
  finally{await pool.query('ALTER TABLE shared.interrupted_contract RENAME TO memory_source_contract')}
 })
 test('shared runtime refuses owner DSNs and effective cross-service or contract write grants',async()=>{
  await expect(prepareRelaySchema(pool,()=>initDB(pool))).rejects.toThrow('unsafe_shared_relay_runtime')
  await pool.query('GRANT SELECT ON memory.private_probe TO relay_r1_runtime')
  await expect(prepareRelaySchema(runtime,()=>initDB(runtime))).rejects.toThrow('unsafe_shared_relay_runtime')
  await pool.query('REVOKE SELECT ON memory.private_probe FROM relay_r1_runtime; GRANT UPDATE ON shared.memory_source_contract TO relay_r1_runtime')
  await expect(prepareRelaySchema(runtime,()=>initDB(runtime))).rejects.toThrow('unsafe_shared_relay_runtime')
  await pool.query('REVOKE UPDATE ON shared.memory_source_contract FROM relay_r1_runtime')
  expect(await prepareRelaySchema(runtime,()=>initDB(runtime))).toBe('verify')
 })
 test('cold schema DDL is explicit; runtime only checks installed column contracts',async()=>{
  await expect(assertSessionColdBodiesEnabled(runtime)).rejects.toThrow('session_cold_schema_migrator_required')
  await enableSessionColdBodies(pool)
  await assertSessionColdBodiesEnabled(runtime)
  await assertRelaySchemaContract(runtime)
 })
 test('shared header opt-in requires an installed known subcontract and all columns without runtime DDL',async()=>{
  const prior=process.env.RELAY_SHARED_SOURCE_HEADERS;process.env.RELAY_SHARED_SOURCE_HEADERS='enabled'
  try{
   await expect(prepareRelaySchema(runtime,()=>initDB(runtime))).rejects.toThrow('relay_shared_header_contract_required')
   await pool.query(`ALTER TABLE shared.memory_source_contract ADD COLUMN header_version int DEFAULT 1;
    ALTER TABLE public.events ADD COLUMN source_header_version smallint,ADD COLUMN source_sequence bigint,ADD COLUMN canonical_payload_hash text,ADD COLUMN source_classification jsonb`)
   await expect(prepareRelaySchema(runtime,()=>initDB(runtime))).rejects.toThrow('relay_shared_capture_contract_required')
   await applyRelaySourceCapture(pool)
   await expect(prepareRelaySchema(runtime,()=>initDB(runtime))).rejects.toThrow('relay_shared_team_capture_contract_required')
   await applyRelayTeamSourceCapture(pool)
   await expect(prepareRelaySchema(runtime,()=>initDB(runtime))).rejects.toThrow('relay_control_capture_required')
   await applyRelayControlCapture(pool)
   await pool.query('GRANT EXECUTE ON FUNCTION shared.lock_memory_feed_source_mode(uuid) TO relay_r1_runtime')
   await expect(prepareRelaySchema(runtime,()=>initDB(runtime))).rejects.toThrow('relay_processing_pin_contract_required')
   await pool.query('GRANT EXECUTE ON FUNCTION shared.memory_source_processing_blocks_purge(integer,text[]) TO relay_r1_runtime')
   expect(await prepareRelaySchema(runtime,()=>initDB(runtime))).toBe('verify')
   await pool.query('UPDATE shared.memory_source_contract SET mode_version=0')
   await expect(prepareRelaySchema(runtime,()=>initDB(runtime))).rejects.toThrow('relay_source_mode_contract_required')
   await pool.query('UPDATE shared.memory_source_contract SET mode_version=999')
   await expect(applyRelaySourceCapture(pool)).rejects.toThrow('unsupported_shared_mode_contract')
   expect((await pool.query('SELECT mode_version FROM shared.memory_source_contract')).rows[0].mode_version).toBe(999)
   await pool.query('UPDATE shared.memory_source_contract SET mode_version=1')
   await pool.query('UPDATE shared.memory_source_contract SET processing_pin_version=2')
   await expect(prepareRelaySchema(runtime,()=>initDB(runtime))).rejects.toThrow('relay_processing_pin_contract_required')
   await expect(applyRelaySourceCapture(pool)).rejects.toThrow('unsupported_shared_processing_pin_contract')
   await pool.query('UPDATE shared.memory_source_contract SET processing_pin_version=1')
   await pool.query('ALTER TABLE public.daemons DISABLE TRIGGER memory_control_daemons_update')
   await expect(prepareRelaySchema(runtime,()=>initDB(runtime))).rejects.toThrow('relay_control_capture_required')
   await pool.query('ALTER TABLE public.daemons ENABLE TRIGGER memory_control_daemons_update')
   await pool.query('REVOKE EXECUTE ON FUNCTION shared.lock_memory_feed_source_mode(uuid) FROM relay_r1_runtime')
   await expect(prepareRelaySchema(runtime,()=>initDB(runtime))).rejects.toThrow('relay_feed_input_fence_required')
   await pool.query('GRANT EXECUTE ON FUNCTION shared.lock_memory_feed_source_mode(uuid) TO relay_r1_runtime')
   await pool.query('ALTER TABLE public.team_delivery_memory_sources DISABLE TRIGGER memory_team_capture_receipts_update')
   await expect(prepareRelaySchema(runtime,()=>initDB(runtime))).rejects.toThrow('relay_shared_team_capture_contract_required')
   await pool.query('ALTER TABLE public.team_delivery_memory_sources ENABLE TRIGGER memory_team_capture_receipts_update')
   await pool.query('ALTER TABLE public.team_artifact_revocations DISABLE TRIGGER memory_delivery_privacy_fence')
   await expect(prepareRelaySchema(runtime,()=>initDB(runtime))).rejects.toThrow('relay_delivery_privacy_capture_required')
   await pool.query('ALTER TABLE public.team_artifact_revocations ENABLE TRIGGER memory_delivery_privacy_fence')
   await pool.query('ALTER TABLE public.deleted_sessions DISABLE TRIGGER memory_source_tombstone_fence')
   await expect(prepareRelaySchema(runtime,()=>initDB(runtime))).rejects.toThrow('relay_shared_session_capture_contract_required')
   await pool.query('ALTER TABLE public.deleted_sessions ENABLE TRIGGER memory_source_tombstone_fence')
   await pool.query('ALTER TABLE public.events DISABLE TRIGGER memory_source_capture_body_marker')
   await expect(prepareRelaySchema(runtime,()=>initDB(runtime))).rejects.toThrow('relay_shared_capture_contract_required')
   await pool.query('ALTER TABLE public.events ENABLE TRIGGER memory_source_capture_body_marker')
   await pool.query('UPDATE shared.memory_source_contract SET header_version=2')
   await expect(prepareRelaySchema(runtime,()=>initDB(runtime))).rejects.toThrow('relay_shared_header_contract_required')
   await pool.query('UPDATE shared.memory_source_contract SET header_version=1; ALTER TABLE public.events RENAME COLUMN source_classification TO missing_source_classification')
   await expect(prepareRelaySchema(runtime,()=>initDB(runtime))).rejects.toThrow('relay_shared_header_contract_required')
   await pool.query('ALTER TABLE public.events RENAME COLUMN missing_source_classification TO source_classification')
  }finally{if(prior===undefined)delete process.env.RELAY_SHARED_SOURCE_HEADERS;else process.env.RELAY_SHARED_SOURCE_HEADERS=prior}
 })

})
