import {beginFreshInputFixture,installRetainedInputStartFixture} from './input-start-fixture.js'
import pg from 'pg'
import {afterAll,beforeAll,describe,expect,test} from 'vitest'
import {inventoryMemory} from '../../migrations/governance-v2/inventory.js'
import {applySharedSourceContract} from '../../migrations/shared-db/contract.js'
import {verifyMemoryStartup,prepareMemoryStartup} from '../../startup-schema.js'
import {applyMemorySchema} from '../../schema.js'
import {createMemoryPool} from '../../db.js'
import {assertMemoryRuntimeCompatibility} from '../../migrations/governance-v2/compatibility.js'
import {provisionSharedDatabase,assertSharedRuntimeContract} from '../../migrations/shared-db/namespace.js'
import {JSON_COLUMN_POLICY} from '../../migrations/shared-source/json-reference-policy.js'
const url=process.env.SHARED_R1_NAMESPACE_TEST_DATABASE_URL
const suite=url?describe:describe.skip
suite('shared DB namespace, migrator and least-privilege runtimes',()=>{
 let pool:pg.Pool,inputFoundation:object
 const roles={memoryRole:'shared_r1_memory',relayRole:'shared_r1_relay',migratorRole:'shared_r1_migrator'}
 beforeAll(async()=>{
  if(!url || !/(^|_)test$/.test(new URL(url).pathname.slice(1)))throw Error('isolated_test_required')
  pool=new pg.Pool({connectionString:url})
  await pool.query(`DROP SCHEMA IF EXISTS memory CASCADE; DROP SCHEMA IF EXISTS shared CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;
   CREATE EXTENSION pg_trgm WITH SCHEMA public; CREATE TABLE public.events(id bigint PRIMARY KEY,payload jsonb); CREATE TABLE public.knowledge_claims(fake text);
   DO $$ BEGIN
   IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='shared_r1_memory') THEN CREATE ROLE shared_r1_memory LOGIN PASSWORD 'only-test'; END IF;
   IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='shared_r1_relay') THEN CREATE ROLE shared_r1_relay LOGIN PASSWORD 'only-test'; END IF;
   IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='shared_r1_migrator') THEN CREATE ROLE shared_r1_migrator NOLOGIN; END IF;
   END $$;`)
  inputFoundation=await beginFreshInputFixture(pool)
 },60000)
 afterAll(async()=>{await pool?.end()})
 test('fresh target and repeat apply stay inside memory; functions and FK targets do not fall back to public',async()=>{
  await Promise.all([applyMemorySchema(pool,{namespace:'memory'}),applyMemorySchema(pool,{namespace:'memory'})])
  expect((await pool.query("SELECT count(*)::int n FROM pg_class WHERE relnamespace='memory'::regnamespace AND relkind='r'")).rows[0].n).toBe(191)
  const jsonColumns=(await pool.query(`SELECT c.relname||'.'||a.attname AS column_key FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
   WHERE c.relnamespace='memory'::regnamespace AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped AND a.atttypid IN('json'::regtype,'jsonb'::regtype) ORDER BY 1`)).rows.map(r=>r.column_key)
  expect(jsonColumns).toEqual(Object.keys(JSON_COLUMN_POLICY).sort())
  expect((await pool.query("SELECT count(*)::int n FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r'")).rows[0].n).toBe(2)
  expect((await pool.query("SELECT count(*)::int n FROM pg_proc WHERE pronamespace='memory'::regnamespace AND NOT COALESCE(proconfig @> ARRAY['search_path=pg_catalog, memory, shared']::text[],false)")).rows[0].n).toBe(0)
  expect((await pool.query("SELECT count(*)::int n FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_class f ON f.oid=c.confrelid WHERE r.relnamespace='memory'::regnamespace AND f.relnamespace='public'::regnamespace")).rows[0].n).toBe(0)
 },60000)
 test('shared target refuses default public runtime/migrator namespace before creating a public ledger',async()=>{
  await applySharedSourceContract(pool)
  await expect(prepareMemoryStartup(pool,{})).rejects.toThrow('shared_source_requires_memory_namespace')
  await expect(applyMemorySchema(pool)).rejects.toThrow('shared_source_requires_memory_namespace')
  expect((await pool.query("SELECT to_regclass('public.memory_schema_migrations') AS ledger")).rows[0].ledger).toBeNull()
 })
 test('unsupported shared contract rejects Memory DDL before a pending migration',async()=>{
  await pool.query('UPDATE shared.memory_source_contract SET version=999; DELETE FROM memory.memory_schema_migrations WHERE version=86')
  try{await expect(applyMemorySchema(pool,{namespace:'memory'})).rejects.toThrow('unsupported_shared_source_contract')}
  finally{await pool.query('UPDATE shared.memory_source_contract SET version=1; INSERT INTO memory.memory_schema_migrations(version) VALUES(86)')}
 })
 test('legacy governance inventory explicitly reads the target namespace',async()=>{
  const inventory=await inventoryMemory(pool,{namespace:'memory'})
  expect(inventory).toMatchObject({namespace:'memory',schemaVersion:96,compatible:true})
 })
 test('provision isolates runtime roles, locks default privileges and rejects inherited owner escalation',async()=>{
  await installRetainedInputStartFixture(pool,'retained_history',inputFoundation)
  await applySharedSourceContract(pool)
  await pool.query('GRANT shared_r1_memory TO shared_r1_relay')
  await expect(provisionSharedDatabase(pool,roles)).rejects.toThrow('runtime_role_escalation')
  await pool.query('REVOKE shared_r1_memory FROM shared_r1_relay')
  await provisionSharedDatabase(pool,roles)
  await pool.query('CREATE SEQUENCE public.canonical_probe; GRANT USAGE ON SEQUENCE public.canonical_probe TO shared_r1_memory')
  await pool.query('GRANT UPDATE ON shared.memory_source_contract,shared.memory_source_work TO shared_r1_memory; GRANT UPDATE ON shared.memory_source_modes TO PUBLIC')
  await provisionSharedDatabase(pool,roles)
  for(const name of ['shared_r1_memory','shared_r1_relay'])expect((await pool.query("SELECT bool_or(has_table_privilege($1,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')) AS unsafe FROM pg_class c WHERE relnamespace='shared'::regnamespace AND relkind='r'",[name])).rows[0].unsafe).toBe(false)
  const runtimeUrl=new URL(url!);runtimeUrl.username=roles.memoryRole;runtimeUrl.password='only-test'
  const runtime=createMemoryPool({databaseUrl:runtimeUrl.href,dbPoolMax:2,databaseNamespace:'memory'})
  try{
   await assertSharedRuntimeContract(runtime)
   await pool.query('ALTER TABLE memory.memory_team_delivery_withdrawals DISABLE TRIGGER memory_delivery_privacy_fence')
   await expect(assertSharedRuntimeContract(runtime)).rejects.toThrow('shared_delivery_privacy_fence_missing')
   await pool.query('ALTER TABLE memory.memory_team_delivery_withdrawals ENABLE TRIGGER memory_delivery_privacy_fence')
   await prepareMemoryStartup(runtime,{databaseNamespace:'memory'})
   await expect(prepareMemoryStartup(runtime,{databaseNamespace:'memory',schemaStartup:'legacy-migrate'})).rejects.toThrow('shared_source_requires_schema_migrator')
   await verifyMemoryStartup(runtime,'memory')
   expect(Number((await runtime.query("SELECT word_similarity('hello','hello world') AS score")).rows[0].score)).toBeGreaterThan(0)
   expect((await runtime.query('SHOW search_path')).rows[0].search_path).toBe('pg_catalog,memory,shared')
   await runtime.query("INSERT INTO memory.memory_provider_state(provider_id) VALUES('pocketctl-memory') ON CONFLICT DO NOTHING")
   for(const sql of ['CREATE TEMP TABLE temporary_shadow(id int)','CREATE TABLE memory.bad(id int)','CREATE TABLE public.bad(id int)','UPDATE public.events SET payload=payload','DELETE FROM public.events','SELECT * FROM public.events',"SELECT nextval('public.canonical_probe')",'UPDATE memory.memory_schema_migrations SET applied_at=applied_at'])await expect(runtime.query(sql)).rejects.toMatchObject({code:'42501'})
   await expect(applyMemorySchema(runtime,{namespace:'memory'})).rejects.toThrow()
  }finally{await runtime.end()}
  await pool.query('SET ROLE shared_r1_migrator; CREATE FUNCTION shared.future_probe() RETURNS INT LANGUAGE SQL AS $$ SELECT 1 $$; RESET ROLE')
  expect((await pool.query("SELECT has_function_privilege('shared_r1_memory','shared.future_probe()','EXECUTE') AS granted")).rows[0].granted).toBe(false)
  await pool.query(`GRANT shared_r1_migrator TO shared_r1_memory`)
  try{
   // The executable semantic definition audit may reject inherited ownership
   // before the general role audit. Either gate must reject this escalation.
   await expect(provisionSharedDatabase(pool,roles)).rejects.toThrow(/runtime_role_escalation|team_semantic_legacy_function_incompatible/)
  }finally{await pool.query('REVOKE shared_r1_migrator FROM shared_r1_memory')}
 })
 test('consumer contract future versions and missing capabilities fail before runtime work',async()=>{
  const runtimeUrl=new URL(url!);runtimeUrl.username=roles.memoryRole;runtimeUrl.password='only-test'
  const runtime=createMemoryPool({databaseUrl:runtimeUrl.href,databaseNamespace:'memory',dbPoolMax:1})
  try{
   await pool.query('UPDATE shared.memory_source_contract SET consumer_version=2')
   await expect(assertSharedRuntimeContract(runtime)).rejects.toThrow('unsupported_shared_consumer_contract')
   await expect(applySharedSourceContract(pool)).rejects.toThrow('unsupported_shared_consumer_contract')
   expect((await pool.query('SELECT consumer_version FROM shared.memory_source_contract')).rows[0].consumer_version).toBe(2)
   await pool.query('UPDATE shared.memory_source_contract SET consumer_version=1')
   await pool.query(`REVOKE EXECUTE ON FUNCTION shared.memory_source_health() FROM ${roles.memoryRole}`)
   await expect(assertSharedRuntimeContract(runtime)).rejects.toThrow('shared_consumer_functions_missing')
  }finally{
   await pool.query('UPDATE shared.memory_source_contract SET consumer_version=1')
   await pool.query(`GRANT EXECUTE ON FUNCTION shared.memory_source_health() TO ${roles.memoryRole}`)
   await runtime.end()
  }
 })

 test('commit fence capabilities have an independent version and cannot be downgraded',async()=>{
  const runtimeUrl=new URL(url!);runtimeUrl.username=roles.memoryRole;runtimeUrl.password='only-test'
  const runtime=createMemoryPool({databaseUrl:runtimeUrl.href,databaseNamespace:'memory',dbPoolMax:1})
  try{
   await pool.query('UPDATE shared.memory_source_contract SET commit_fence_version=2')
   await expect(assertSharedRuntimeContract(runtime)).rejects.toThrow('unsupported_shared_commit_fence_contract')
   await expect(applySharedSourceContract(pool)).rejects.toThrow('unsupported_shared_commit_fence_contract')
   expect((await pool.query('SELECT commit_fence_version FROM shared.memory_source_contract')).rows[0].commit_fence_version).toBe(2)
   await pool.query('UPDATE shared.memory_source_contract SET commit_fence_version=1')
   await pool.query(`REVOKE EXECUTE ON FUNCTION shared.lock_memory_team_source_commit(JSONB,TEXT,TEXT,JSONB,BOOLEAN) FROM ${roles.memoryRole}`)
   await expect(assertSharedRuntimeContract(runtime)).rejects.toThrow('shared_consumer_functions_missing')
  }finally{
   await pool.query('UPDATE shared.memory_source_contract SET commit_fence_version=1')
   await pool.query(`GRANT EXECUTE ON FUNCTION shared.lock_memory_team_source_commit(JSONB,TEXT,TEXT,JSONB,BOOLEAN) TO ${roles.memoryRole}`)
   await runtime.end()
  }
 })

 test('runtime refuses a disabled durable execution commit trigger',async()=>{
  const runtimeUrl=new URL(url!);runtimeUrl.username=roles.memoryRole;runtimeUrl.password='only-test'
  const runtime=createMemoryPool({databaseUrl:runtimeUrl.href,databaseNamespace:'memory',dbPoolMax:1})
  try{
   await pool.query('ALTER TABLE shared.memory_source_provider_attempts DISABLE TRIGGER memory_source_provider_commit')
   await expect(assertSharedRuntimeContract(runtime)).rejects.toThrow('shared_source_execution_fence_missing')
  }finally{await pool.query('ALTER TABLE shared.memory_source_provider_attempts ENABLE TRIGGER memory_source_provider_commit');await runtime.end()}
 })
 test('runtime refuses missing semantic local-policy capture',async()=>{
  const runtimeUrl=new URL(url!);runtimeUrl.username=roles.memoryRole;runtimeUrl.password='only-test'
  const runtime=createMemoryPool({databaseUrl:runtimeUrl.href,databaseNamespace:'memory',dbPoolMax:1})
  try{
   await pool.query('ALTER TABLE memory.memory_feature_settings DISABLE TRIGGER memory_feature_control_update')
   await expect(assertSharedRuntimeContract(runtime)).rejects.toThrow('shared_local_control_capture_missing')
  }finally{await pool.query('ALTER TABLE memory.memory_feature_settings ENABLE TRIGGER memory_feature_control_update');await runtime.end()}
 })
 test('distribution schema versions and the physical commit fence are mandatory',async()=>{
  const runtimeUrl=new URL(url!);runtimeUrl.username=roles.memoryRole;runtimeUrl.password='only-test'
  const runtime=createMemoryPool({databaseUrl:runtimeUrl.href,databaseNamespace:'memory',dbPoolMax:1})
  try{
   await pool.query('ALTER TABLE shared.memory_source_distributions DISABLE TRIGGER memory_source_distribution_commit')
   await expect(assertSharedRuntimeContract(runtime)).rejects.toThrow('shared_source_distribution_fence_missing')
   await pool.query('ALTER TABLE shared.memory_source_distributions ENABLE TRIGGER memory_source_distribution_commit;ALTER TABLE shared.memory_source_control_progress DISABLE TRIGGER memory_control_bootstrap_commit')
   await expect(assertSharedRuntimeContract(runtime)).rejects.toThrow('shared_control_bootstrap_fence_missing')
   await pool.query('ALTER TABLE shared.memory_source_control_progress ENABLE TRIGGER memory_control_bootstrap_commit;UPDATE shared.memory_source_contract SET distribution_version=999')
   await expect(assertSharedRuntimeContract(runtime)).rejects.toThrow('unsupported_shared_distribution_contract')
   await expect(applySharedSourceContract(pool)).rejects.toThrow('unsupported_shared_distribution_contract')
  }finally{
   await pool.query('ALTER TABLE shared.memory_source_distributions ENABLE TRIGGER memory_source_distribution_commit;ALTER TABLE shared.memory_source_control_progress ENABLE TRIGGER memory_control_bootstrap_commit;UPDATE shared.memory_source_contract SET distribution_version=1');await runtime.end()
  }
 })
 test('durable mode contract and its input fence are mandatory at runtime and future versions reject DDL',async()=>{
  const runtimeUrl=new URL(url!);runtimeUrl.username=roles.memoryRole;runtimeUrl.password='only-test'
  const runtime=createMemoryPool({databaseUrl:runtimeUrl.href,databaseNamespace:'memory',dbPoolMax:1})
  try{
   await pool.query('UPDATE shared.memory_source_contract SET mode_version=0')
   await expect(assertSharedRuntimeContract(runtime)).rejects.toThrow('unsupported_shared_mode_contract')
   await applySharedSourceContract(pool)
   expect((await pool.query('SELECT mode_version FROM shared.memory_source_contract')).rows[0].mode_version).toBe(1)
   await pool.query('UPDATE shared.memory_source_contract SET mode_version=999')
   await expect(applySharedSourceContract(pool)).rejects.toThrow('unsupported_shared_mode_contract')
   await expect(applyMemorySchema(pool,{namespace:'memory'})).rejects.toThrow('unsupported_shared_mode_contract')
   expect((await pool.query('SELECT mode_version FROM shared.memory_source_contract')).rows[0].mode_version).toBe(999)
   await pool.query('UPDATE shared.memory_source_contract SET mode_version=1;ALTER TABLE shared.memory_source_modes DISABLE TRIGGER memory_source_mode_input_fence')
   await expect(assertSharedRuntimeContract(runtime)).rejects.toThrow('shared_mode_input_fence_missing')
  }finally{await pool.query('UPDATE shared.memory_source_contract SET mode_version=1;ALTER TABLE shared.memory_source_modes ENABLE TRIGGER memory_source_mode_input_fence');await runtime.end()}
 })

})
