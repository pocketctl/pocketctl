import pg from 'pg'
import {afterAll,beforeAll,describe,expect,test} from 'vitest'
import {MEMORY_MIGRATIONS,applyMemorySchema} from '../../schema.js'
import {createMemoryPool} from '../../db.js'
import {verifyMemoryStartup} from '../../startup-schema.js'
const url=process.env.SHARED_R1_UPGRADE_TEST_DATABASE_URL,suite=url?describe:describe.skip
suite('R1 compatibility with the v84 legacy public schema',()=>{
 let pool:pg.Pool,runtime:pg.Pool
 const inst='10000000-0000-0000-0000-000000000004',id='20000000-0000-0000-0000-000000000004'
 beforeAll(async()=>{
  if(!url || !/(^|_)test$/.test(new URL(url).pathname.slice(1)))throw Error('isolated_test_required')
  pool=new pg.Pool({connectionString:url})
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; CREATE TABLE public.memory_schema_migrations(version int PRIMARY KEY,applied_at timestamptz DEFAULT NOW())')
  for(const migration of MEMORY_MIGRATIONS.filter(m=>m.version<=84)){
   await pool.query('BEGIN')
   for(const sql of migration.statements)await pool.query(sql)
   await pool.query('INSERT INTO public.memory_schema_migrations(version) VALUES($1)',[migration.version]);await pool.query('COMMIT')
  }
  await pool.query("INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[inst])
  await pool.query(`INSERT INTO source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES($1,'session',NOW(),NOW())`,[inst])
  await pool.query(`INSERT INTO source_events(source_event_id,installation_id,origin,origin_position,session_id,turn_id,event_type,occurred_at,payload,payload_hash)
   VALUES($1,$2,'feed','9007199254740993','session','turn','agent_text',NOW(),'{"text":"legacy compatibility body"}',decode(repeat('ab',32),'hex'))`,[id,inst])
  await pool.query(`INSERT INTO source_turns(installation_id,turn_id,session_id,state,first_source_event_id,last_source_event_id) VALUES($1,'turn','session','completed',$2,$2)`,[inst,id])
  runtime=createMemoryPool({databaseUrl:url,dbPoolMax:2})
 },60000)
 afterAll(async()=>{await runtime?.end();await pool?.end()})
 test('runtime rejects old/unknown schema without silently running DDL',async()=>{
  await expect(verifyMemoryStartup(runtime)).rejects.toMatchObject({code:'memory_runtime_incompatible:schema'})
  expect((await pool.query('SELECT max(version)::int AS "version" FROM memory_schema_migrations')).rows[0].version).toBe(84)
  expect((await pool.query("SELECT count(*)::int n FROM pg_attribute WHERE attrelid='source_events'::regclass AND attname='mapping_state'")).rows[0].n).toBe(0)
 })
 test('explicit migrator upgrades twice while preserving IDs, FK boundaries, payloads and unknown mapping state',async()=>{
  await applyMemorySchema(pool);await applyMemorySchema(pool)
  await verifyMemoryStartup(runtime)
  expect((await pool.query(`SELECT source_event_id::text,payload->>'text' AS body,encode(payload_hash,'hex') AS hash,mapping_state,canonical_key FROM source_events WHERE source_event_id=$1`,[id])).rows[0]).toEqual({source_event_id:id,body:'legacy compatibility body',hash:'ab'.repeat(32),mapping_state:'unproven',canonical_key:null})
  expect((await pool.query('SELECT first_source_event_id::text,last_source_event_id::text FROM source_turns WHERE installation_id=$1',[inst])).rows[0]).toEqual({first_source_event_id:id,last_source_event_id:id})
  await pool.query('INSERT INTO memory_schema_migrations(version) VALUES(999)')
  await expect(verifyMemoryStartup(runtime)).rejects.toMatchObject({code:'memory_runtime_incompatible:schema'})
  await expect(applyMemorySchema(pool)).rejects.toThrow('memory_schema_incompatible')
  await pool.query('DELETE FROM memory_schema_migrations WHERE version=999')
 })
})
