import pg from 'pg'
import {afterAll,beforeAll,describe,expect,test} from 'vitest'
import {applyMemorySchema} from '../../schema.js'
import {applySharedSourceContract} from '../../migrations/shared-db/contract.js'
const url=process.env.SHARED_R1_CONTROL_TEST_DATABASE_URL,suite=url?describe:describe.skip
suite('body-free current control revision and work',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{
  if(!url||!/(^|_)test$/.test(new URL(url).pathname.slice(1)))throw Error('isolated_test_required')
  pool=new pg.Pool({connectionString:url,max:4})
  await pool.query('DROP SCHEMA IF EXISTS memory CASCADE;DROP SCHEMA IF EXISTS shared CASCADE;DROP SCHEMA public CASCADE;CREATE SCHEMA public')
  await applyMemorySchema(pool,{namespace:'memory'});await applySharedSourceContract(pool)
 },60000)
 afterAll(async()=>{await pool?.end()})
 const clock=async()=>(await pool.query('SELECT shared.memory_source_control_snapshot() AS revision')).rows[0].revision
 test('control changes and rollback atomically retain only metadata',async()=>{
  const before=await clock(),c=await pool.connect()
  try{
   await c.query('BEGIN')
   await c.query("SELECT shared.mark_memory_control_dirty('installation','scope-test')")
   expect(await clock()).toBe(before)
   expect((await pool.query('SELECT 1 FROM shared.memory_source_control_work')).rowCount).toBe(0)
   await c.query('ROLLBACK')
   expect(await clock()).toBe(before)
   await pool.query("SELECT shared.mark_memory_control_dirty('installation','scope-test')")
   expect(BigInt(await clock())).toBe(BigInt(before)+1n)
   expect((await pool.query('SELECT control_kind,control_key,revision::text,processed_revision::text FROM shared.memory_source_control_work')).rows).toEqual([{control_kind:'installation',control_key:'scope-test',revision:await clock(),processed_revision:'0'}])
   await expect(pool.query("SELECT shared.mark_memory_control_dirty('unknown','bad')")).rejects.toThrow('invalid_source_control')
  }finally{await c.query('ROLLBACK');c.release()}
 })
 test('the final metadata barrier refuses changed/uncommitted control without waiting',async()=>{
  const version=await clock(),consumer=await pool.connect(),writer=await pool.connect()
  try{
   await writer.query('BEGIN');await writer.query("SELECT shared.mark_memory_control_dirty('provider','pocketctl-memory')")
   expect((await consumer.query('SELECT shared.guard_memory_control_commit($1::bigint) AS valid',[version])).rows[0].valid).toBe(false)
   await writer.query('ROLLBACK')
   await consumer.query('BEGIN')
   expect((await consumer.query('SELECT shared.guard_memory_control_commit($1::bigint) AS valid',[version])).rows[0].valid).toBe(true)
   await writer.query('BEGIN');await writer.query("SET LOCAL lock_timeout='50ms'")
   await expect(writer.query("SELECT shared.mark_memory_control_dirty('provider','pocketctl-memory')")).rejects.toMatchObject({code:'55P03'})
   await writer.query('ROLLBACK');await consumer.query('COMMIT')
   await pool.query("SELECT shared.mark_memory_control_dirty('provider','pocketctl-memory')")
   expect((await pool.query('SELECT shared.guard_memory_control_commit($1::bigint) AS valid',[version])).rows[0].valid).toBe(false)
  }finally{await consumer.query('ROLLBACK');await writer.query('ROLLBACK');consumer.release();writer.release()}
 })
 test('partial leases cannot bypass the metadata invariant through SQL NULL',async()=>{
  await expect(pool.query(`INSERT INTO shared.memory_source_control_work(control_kind,control_key,revision,lease_token,lease_until,claimed_revision)
   VALUES('provider','incomplete-lease',1,gen_random_uuid(),clock_timestamp()+interval '1 minute',1)`)).rejects.toMatchObject({code:'23514'})
 })
 test('control writers never wait in reverse order for a clock held by another mutation',async()=>{
  const first=await pool.connect(),second=await pool.connect()
  try{
   await first.query('BEGIN');await first.query("SELECT shared.mark_memory_control_dirty('user','1')")
   await second.query('BEGIN');await second.query("SET LOCAL statement_timeout='200ms'")
   await expect(second.query("SELECT shared.mark_memory_control_dirty('user','2')")).rejects.toMatchObject({code:'55P03'})
  }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');first.release();second.release()}
 })
 test('control revisions and claimed acknowledgements preserve bigint and a newer dirty update',async()=>{
  await pool.query('TRUNCATE shared.memory_source_control_progress,shared.memory_source_control_work;UPDATE shared.memory_source_control_clock SET revision=9007199254740992')
  expect((await pool.query("SELECT shared.mark_memory_control_dirty('user','1')::text AS revision")).rows[0].revision).toBe('9007199254740993')
  const claim=(await pool.query("SELECT control_kind,control_key,lease_token::text,claimed_revision::text FROM shared.claim_memory_control_work('worker-a',30,1)")).rows[0]
  expect(claim.claimed_revision).toBe('9007199254740993')
  await pool.query("SELECT shared.mark_memory_control_dirty('user','1')")
  expect((await pool.query('SELECT shared.ack_memory_control_work($1,$2,$3::uuid,$4,$5::bigint) AS valid',[claim.control_kind,claim.control_key,claim.lease_token,'worker-a',claim.claimed_revision])).rows[0].valid).toBe(true)
  expect((await pool.query('SELECT revision::text,processed_revision::text FROM shared.memory_source_control_work')).rows).toEqual([{revision:'9007199254740994',processed_revision:'9007199254740993'}])
  expect((await pool.query("SELECT 1 FROM shared.claim_memory_control_work('worker-b',30,1)")).rowCount).toBe(1)
  expect((await pool.query('SELECT shared.ack_memory_control_work($1,$2,$3::uuid,$4,$5::bigint) AS valid',[claim.control_kind,claim.control_key,claim.lease_token,'worker-a',claim.claimed_revision])).rows[0].valid).toBe(false)
 })
 test('consent changes advance control while implicit off defaults and timestamps do not',async()=>{
  const installation='10000000-0000-0000-0000-000000000093'
  await pool.query("INSERT INTO memory.memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[installation])
  const before=await clock()
  await pool.query('INSERT INTO memory.memory_feature_settings(installation_id) VALUES($1)',[installation])
  expect(await clock()).toBe(before)
  await pool.query('UPDATE memory.memory_feature_settings SET updated_at=clock_timestamp(),revision=revision+1 WHERE installation_id=$1',[installation])
  expect(await clock()).toBe(before)
  await pool.query("UPDATE memory.memory_feature_settings SET extraction_mode='enabled',extraction_consent_fingerprint='authorized-route' WHERE installation_id=$1",[installation])
  expect(BigInt(await clock())).toBe(BigInt(before)+1n)
  await pool.query("UPDATE memory.memory_feature_settings SET extraction_mode='off',extraction_consent_fingerprint=NULL WHERE installation_id=$1",[installation])
  expect(BigInt(await clock())).toBe(BigInt(before)+2n)
  expect((await pool.query("SELECT control_key FROM shared.memory_source_control_work WHERE control_kind='local'")).rows).toEqual([{control_key:installation}])
 })
 test('an unknown future control contract is rejected before installing functions',async()=>{
  await pool.query('UPDATE shared.memory_source_contract SET control_version=999')
  try{
   await expect(applySharedSourceContract(pool)).rejects.toThrow('unsupported_shared_control_contract')
   await expect(applyMemorySchema(pool,{namespace:'memory'})).rejects.toThrow('unsupported_shared_control_contract')
  }
  finally{await pool.query('UPDATE shared.memory_source_contract SET control_version=1')}
 })
})
