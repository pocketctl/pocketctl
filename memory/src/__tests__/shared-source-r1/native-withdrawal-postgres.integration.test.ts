import {randomUUID} from 'node:crypto'
import {beforeAll,afterAll,describe,test,expect} from 'vitest'
import {directLaunchFixture,type DirectLaunchFixture} from './direct-launch-fixture.js'
import {createDeliveryWithdrawalConsumer} from '../../inbox/delivery-withdrawal-consumer.js'
const url=process.env.DIRECT_LAUNCH_MEMORY_TEST_DATABASE_URL,suite=url?describe:describe.skip
suite('native content-free delivery withdrawal replay',()=>{
 let f:DirectLaunchFixture
 beforeAll(async()=>{f=await directLaunchFixture(url!)},60000)
 afterAll(async()=>{await f?.close()})
 const append=async()=>{const values=['native-withdrawal-team','native-withdrawal-session',randomUUID(),randomUUID()];return(await f.pool.query('INSERT INTO public.team_delivery_memory_withdrawals(team_id,team_session_id,submission_id,decision_id) VALUES($1,$2,$3,$4) RETURNING sequence::text',values)).rows[0].sequence as string}
 const page=async(after:string,limit=100)=>(await f.runtime.query('SELECT shared.memory_delivery_withdrawal_page($1::uuid,$2::bigint,$3) AS page',[randomUUID(),after,limit])).rows[0].page
 test('runtime can read only a finite content-free page, without raw Relay access',async()=>{
  const sequence=await append(),p=await page('0',1)
  expect(p.version).toBe(1);expect(p.items).toHaveLength(1);expect(p.through_sequence).toBe(sequence)
  expect(Object.keys(p).sort()).toEqual(['consumer_id','items','through_sequence','version'])
  expect(Object.keys(p.items[0]).sort()).toEqual(['decision_id','recorded_at','sequence','submission_id','team_id','team_session_id'])
  await expect(f.runtime.query('SELECT * FROM public.team_delivery_memory_withdrawals')).rejects.toMatchObject({code:'42501'})
  await expect(page('0',101)).rejects.toThrow('invalid_native_withdrawal_page')
  await expect(page('-1')).rejects.toThrow('invalid_native_withdrawal_page')
 })
 test('native consumer replays from its durable checkpoint and acknowledges only local persistence',async()=>{
  await append();const consumer=createDeliveryWithdrawalConsumer({pool:f.runtime,signal:new AbortController().signal,transport:'native'})
  expect(await consumer.runOnce()).toEqual({applied:2,skipped:false})
  expect(await consumer.runOnce()).toEqual({applied:0,skipped:false})
  const next=await append(),restarted=createDeliveryWithdrawalConsumer({pool:f.runtime,signal:new AbortController().signal,transport:'native'})
  expect(await restarted.runOnce()).toEqual({applied:1,skipped:false})
  expect((await f.runtime.query('SELECT last_sequence::text,last_ack_sequence::text FROM memory_delivery_withdrawal_checkpoint WHERE singleton')).rows[0]).toEqual({last_sequence:next,last_ack_sequence:next})
  expect((await f.runtime.query('SELECT count(*)::int AS n FROM memory_delivery_withdrawal_receipts')).rows[0].n).toBe(3)
  expect((await f.pool.query('SELECT count(*)::int AS n FROM public.team_delivery_memory_consumers')).rows[0].n).toBe(0)
 })
 test('failed local persistence rolls back receipt and checkpoint, then the same native page replays',async()=>{
  const next=await append(),before=(await f.runtime.query('SELECT last_sequence::text FROM memory_delivery_withdrawal_checkpoint')).rows[0].last_sequence
  await f.pool.query("CREATE FUNCTION memory.fail_native_withdrawal_test() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic local write failure';END $$; CREATE TRIGGER fail_native_withdrawal_test BEFORE INSERT ON memory.memory_team_delivery_withdrawals FOR EACH ROW EXECUTE FUNCTION memory.fail_native_withdrawal_test()")
  const consumer=createDeliveryWithdrawalConsumer({pool:f.runtime,signal:new AbortController().signal,transport:'native'})
  try{await expect(consumer.runOnce()).rejects.toThrow('synthetic local write failure');expect((await f.runtime.query('SELECT last_sequence::text FROM memory_delivery_withdrawal_checkpoint')).rows[0].last_sequence).toBe(before);expect((await f.runtime.query('SELECT 1 FROM memory_delivery_withdrawal_receipts WHERE sequence=$1',[next])).rowCount).toBe(0)}finally{await f.pool.query('DROP TRIGGER fail_native_withdrawal_test ON memory.memory_team_delivery_withdrawals;DROP FUNCTION memory.fail_native_withdrawal_test()')}
  expect(await consumer.runOnce()).toEqual({applied:1,skipped:false})
 })
 test('one pass remains bounded and restart finishes the next native page without a transport lease',async()=>{
  for(let n=0;n<101;n++)await append()
  const consumer=createDeliveryWithdrawalConsumer({pool:f.runtime,signal:new AbortController().signal,transport:'native'})
  expect((await consumer.runOnce()).applied).toBe(100)
  const restarted=createDeliveryWithdrawalConsumer({pool:f.runtime,signal:new AbortController().signal,transport:'native'})
  expect((await restarted.runOnce()).applied).toBe(1)
 })
 test('HTTP retries and native replay retain the same durable receipt identity',async()=>{
  await f.runtime.query('UPDATE memory_delivery_withdrawal_checkpoint SET last_sequence=0,last_ack_sequence=0 WHERE singleton')
  const legacy=createDeliveryWithdrawalConsumer({pool:f.runtime,signal:new AbortController().signal,pull:async(id,after)=>{
   const p=(await f.runtime.query('SELECT shared.memory_delivery_withdrawal_page($1,$2,100) AS page',[id,after])).rows[0].page
   return {...p,next_cursor:'synthetic-signed-cursor',lease_token:'synthetic-lease',lease_expires_at:'2099-01-01T00:00:00.000Z'}
  },ack:async batch=>batch.through_sequence})
  expect((await legacy.runOnce()).applied).toBe(0)
  const native=createDeliveryWithdrawalConsumer({pool:f.runtime,signal:new AbortController().signal,transport:'native'})
  expect((await native.runOnce()).applied).toBe(0)
  expect((await f.runtime.query('SELECT count(*)::int AS n FROM memory_delivery_withdrawal_receipts')).rows[0].n).toBe(105)
 })
 test('shared scheduling consumes new native invalidations with durable continuation and no HTTP dependency',async()=>{
  const {createSharedSourceScheduler}=await import('../../sources/shared-scheduler.js')
  await f.pool.query('UPDATE shared.memory_source_contract SET activation_ready=TRUE WHERE singleton')
  const next=await append(),consumer=createDeliveryWithdrawalConsumer({pool:f.runtime,signal:new AbortController().signal,transport:'native'}),errors:unknown[]=[]
  const scheduler=createSharedSourceScheduler({pool:f.runtime,workerId:'native-withdrawal-test',signal:new AbortController().signal,refreshWithdrawals:()=>consumer.runOnce(),onError:error=>errors.push(error)})
  try{await scheduler.runOnce();expect(errors).toEqual([]);expect((await f.runtime.query('SELECT last_sequence::text FROM memory_delivery_withdrawal_checkpoint')).rows[0].last_sequence).toBe(next)}finally{await scheduler.stop()}
 })

})
