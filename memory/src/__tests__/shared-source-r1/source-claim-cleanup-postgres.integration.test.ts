import {randomUUID} from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
import {beforeAll,beforeEach,afterAll,describe,test,expect} from 'vitest'
import {directLaunchFixture,type DirectLaunchFixture} from './direct-launch-fixture.js'
import {claimSourceWork,failSourceWork} from '../../sources/shared-work.js'
import {releaseCachedSourceClaims} from '../../sources/source-claim-cleanup.js'
const url=process.env.CONTINUOUS_SOURCE_TEST_DATABASE_URL,suite=url?describe:describe.skip
suite('graceful shutdown releases only the current cached source owner',()=>{
 let f:DirectLaunchFixture
 beforeAll(async()=>{f=await directLaunchFixture(url!);await f.pool.query('UPDATE shared.memory_source_contract SET activation_ready=TRUE')},60000)
 beforeEach(async()=>{await f.pool.query('TRUNCATE shared.memory_source_work CASCADE')})
 afterAll(async()=>{await f?.close()})
 const state=async()=>(await f.pool.query('SELECT source_kind,root_key,revision::text,processed_revision::text,claimed_revision::text,lease_token::text,lease_owner,lease_until,attempt,last_error_code,dead_at,available_at,updated_at FROM shared.memory_source_work ORDER BY root_key')).rows
 async function one(){const s=await f.source();await f.event(s);const claims=await claimSourceWork(f.runtime,'graceful-owner',30,4);expect(claims).toHaveLength(1);return claims[0]}
 test('four actual native claims release without acknowledging revisions or resetting attempts',async()=>{
  for(let n=0;n<4;n++){const s=await f.source();await f.event(s)}
  const claims=await claimSourceWork(f.runtime,'graceful-owner',30,4);expect(claims).toHaveLength(4)
  const before=await state();await releaseCachedSourceClaims(f.runtime,'graceful-owner',claims,performance.now()+5000)
  const after=await state();expect(after).toHaveLength(4)
  for(const row of after){const old=before.find(r=>r.root_key===row.root_key)!;expect(row.revision).toBe(old.revision);expect(row.processed_revision).toBe(old.processed_revision);expect(row.attempt).toBe(old.attempt);expect(row.lease_token).toBeNull();expect(row.lease_owner).toBeNull();expect(row.claimed_revision).toBeNull();expect(row.last_error_code).toBe('temporary_unavailable');expect(row.dead_at).toBeNull()}
  // Ordinary existing five-second backoff remains, then a fresh owner uses
  // ordinary SQL claims and fresh tokens; no shutdown-specific takeover.
  expect(await claimSourceWork(f.runtime,'new-owner',30,4)).toEqual([])
  await delay(5100)
  const fresh=await claimSourceWork(f.runtime,'new-owner',30,4);expect(fresh).toHaveLength(4);expect(fresh.every(c=>!claims.some(old=>old.token===c.token))).toBe(true)
 },15000)
 test('a stolen token is not cleared even when the worker string is unchanged',async()=>{
  const old=await one();await f.pool.query('UPDATE shared.memory_source_work SET lease_token=$1 WHERE root_key=$2',[randomUUID(),old.rootKey])
  const before=await state();await releaseCachedSourceClaims(f.runtime,'graceful-owner',[old],performance.now()+5000);expect(await state()).toEqual(before)
 })
 test('an expired token cannot mutate a row; only ordinary fresh claim can acquire it',async()=>{
  const old=await one();await f.pool.query("UPDATE shared.memory_source_work SET lease_until=clock_timestamp()-interval '1 millisecond' WHERE root_key=$1",[old.rootKey])
  const before=await state();await releaseCachedSourceClaims(f.runtime,'graceful-owner',[old],performance.now()+5000);expect(await state()).toEqual(before)
  const fresh=await claimSourceWork(f.runtime,'new-owner',30,1);expect(fresh).toHaveLength(1);expect(fresh[0].token).not.toBe(old.token)
 })
 test.each(['provider_result_unknown','budget_hold'] as const)('protected %s work remains unchanged',async code=>{
  const old=await one();await failSourceWork(f.runtime,old,code)
  const before=await state();expect(before[0].dead_at).not.toBeNull();await releaseCachedSourceClaims(f.runtime,'graceful-owner',[old],performance.now()+5000);expect(await state()).toEqual(before)
 })
 test('cached revision drift is reconciled without inventing an ACK or stealing another token',async()=>{
  const old=await one(),before=await state()
  // The existing NULL recovery observes the row's real current claimed
  // revision, not a caller-supplied revision. Its actual advance semantics
  // are separately covered by continuous-claim-progress DB tests.
  await releaseCachedSourceClaims(f.runtime,'graceful-owner',[{...old,claimedRevision:'999999'}],performance.now()+5000)
  const after=await state();expect(after[0].processed_revision).toBe(before[0].processed_revision);expect(after[0].attempt).toBe(before[0].attempt);expect(after[0].lease_token).toBeNull()
 })
})
