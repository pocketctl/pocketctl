import pg from 'pg'
import {afterAll,beforeAll,describe,expect,test} from 'vitest'
import {applyMemorySchema} from '../../schema.js'
import {applySharedSourceContract} from '../../migrations/shared-db/contract.js'
const url=process.env.SHARED_R1_CONTRACT_TEST_DATABASE_URL
const suite=url?describe:describe.skip
suite('additive shared-source contract',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{
  if(!url || !/(^|_)test$/.test(new URL(url).pathname.slice(1)))throw Error('isolated_test_required')
  pool=new pg.Pool({connectionString:url});await pool.query('DROP SCHEMA IF EXISTS memory CASCADE; DROP SCHEMA IF EXISTS shared CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await applyMemorySchema(pool,{namespace:'memory'})
 },60000)
 afterAll(async()=>{await pool?.end()})
 test('contract applies twice, rejects impossible revision/lease states, and stores no event body',async()=>{
  await applySharedSourceContract(pool);await applySharedSourceContract(pool)
  expect((await pool.query('SELECT version FROM shared.memory_source_contract')).rows).toEqual([{version:1}])
  await pool.query("INSERT INTO shared.memory_source_work(source_kind,root_key,revision) VALUES('relay_event','owner:1/session:one',2)")
  await expect(pool.query("UPDATE shared.memory_source_work SET processed_revision=3")).rejects.toMatchObject({code:'23514'})
  await expect(pool.query("UPDATE shared.memory_source_work SET lease_owner='partial'" )).rejects.toMatchObject({code:'23514'})
  const columns=(await pool.query("SELECT attname FROM pg_attribute WHERE attrelid='shared.memory_source_work'::regclass AND attnum>0")).rows.map(r=>r.attname)
  expect(columns).not.toContain('payload');expect(columns).not.toContain('body')
 })
 test('preserves old source UUID/body/hash and allows typed identities without event FK or cascade',async()=>{
  const inst='10000000-0000-0000-0000-000000000002',id='20000000-0000-0000-0000-000000000002'
  await pool.query("INSERT INTO memory.memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[inst])
  await pool.query(`INSERT INTO memory.source_events(source_event_id,installation_id,origin,origin_position,session_id,event_type,occurred_at,payload,payload_hash)
    VALUES($1,$2,'feed','9007199254740993','session','agent_text',NOW(),'{"text":"retained compatibility body"}',decode(repeat('ab',32),'hex'))`,[id,inst])
  await pool.query(`UPDATE memory.source_events SET source_kind='relay_event',canonical_key='9007199254740994',canonical_session_key='session',
   source_version='{"content":"1","authorization":"1","storage":"0"}',content_hash=payload_hash,hash_version='canonical-json-sha256-v1',mapping_state='verified',adapter_version='r1' WHERE source_event_id=$1`,[id])
  expect((await pool.query('SELECT source_event_id::text,payload->>\'text\' AS "text",encode(content_hash,\'hex\') hash FROM memory.source_events WHERE source_event_id=$1',[id])).rows[0]).toEqual({source_event_id:id,text:'retained compatibility body',hash:'ab'.repeat(32)})
  expect((await pool.query("SELECT count(*)::int n FROM pg_constraint WHERE conrelid='memory.source_events'::regclass AND confrelid=to_regclass('public.events') AND contype='f'")).rows[0].n).toBe(0)
  await expect(pool.query("UPDATE memory.source_events SET content_hash=decode('ab','hex') WHERE source_event_id=$1",[id])).rejects.toMatchObject({code:'23514'})
  for(const key of ['content','authorization','storage']){
   await pool.query('UPDATE memory.source_events SET source_version=jsonb_set(source_version,$1,$2::jsonb) WHERE source_event_id=$3',[[key],JSON.stringify('9223372036854775807'),id])
   await expect(pool.query('UPDATE memory.source_events SET source_version=jsonb_set(source_version,$1,$2::jsonb) WHERE source_event_id=$3',[[key],JSON.stringify('9223372036854775808'),id])).rejects.toMatchObject({code:'23514'})
  }
 })
})
