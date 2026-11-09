import pg from 'pg'
import {afterAll,beforeAll,describe,expect,test} from 'vitest'
import {applyMemorySchema} from '../../schema.js'
import {gitDbFixture,insertGitConnection} from '../../testing/phase6-db-fixture.js'
const url=process.env.SHARED_R1_TEST_DATABASE_URL
const suite=url?describe:describe.skip
suite('Git scope changes distinguish authority from ACK bookkeeping',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{
  if(!url || !/(^|_)test$/.test(new URL(url).pathname.slice(1)))throw Error('isolated_test_required')
  pool=new pg.Pool({connectionString:url})
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await applyMemorySchema(pool)
 },60000)
 afterAll(async()=>{await pool?.end()})
 test('timestamp-only discovery/ACK updates do not invalidate connections; real policy changes do',async()=>{
  const fixture=await gitDbFixture(pool),id=await insertGitConnection(pool,fixture)
  const generation=async()=>String((await pool.query('SELECT generation FROM memory_git_connections WHERE connection_id=$1',[id])).rows[0].generation)
  expect(await generation()).toBe('1')
  await pool.query(`UPDATE memory_installations SET relay_status=relay_status,local_status=local_status,config_version=config_version,
   last_ack_at=clock_timestamp(),last_pull_at=clock_timestamp(),updated_at=clock_timestamp() WHERE installation_id=$1`,[fixture.installationId])
  await pool.query(`UPDATE memory_owner_scopes SET state=state,authorization_epoch=authorization_epoch,last_feed_id=last_feed_id+1,updated_at=clock_timestamp() WHERE installation_id=$1`,[fixture.installationId])
  expect(await generation()).toBe('1')
  expect((await pool.query('SELECT count(*)::text n FROM memory_git_lifecycle_epochs WHERE connection_id=$1',[id])).rows[0].n).toBe('0')
  await pool.query('UPDATE memory_owner_scopes SET authorization_epoch=authorization_epoch+1 WHERE installation_id=$1',[fixture.installationId])
  expect(await generation()).toBe('2')
  await pool.query('UPDATE memory_installations SET config_version=config_version+1 WHERE installation_id=$1',[fixture.installationId])
  expect(await generation()).toBe('3')
  await pool.query("UPDATE memory_installations SET subscriptions='[\"session.event.v1\"]'::jsonb WHERE installation_id=$1",[fixture.installationId])
  expect(await generation()).toBe('4')
  await pool.query("UPDATE memory_installations SET relay_status='revoked' WHERE installation_id=$1",[fixture.installationId])
  expect(await generation()).toBe('5')
 })
})
