import {describe,expect,test} from 'vitest'
import {assertForwardCapacity,beginForwardCapacityRun} from '../../migrations/shared-forward/capacity-admission.js'
const now=Date.parse('2026-11-07T00:00:00Z')
const plan={manifestHash:'a'.repeat(64),migrationId:'fixture',codeSha:'b'.repeat(40),sourceIdentity:'c'.repeat(64),targetIdentity:'d'.repeat(64)}
const measured={policy:'forward-only' as const,existingAllocatedBytes:'100',freeBytes:'9007199254740993',targetBytes:'200',stagingBytes:'100',temporaryIndexBytes:'40',walBytes:'300',mappingBytes:'20',growthBytes:'30',copySeconds:'60',indexSeconds:'10',evidenceId:'synthetic:measured-v1'}
const evidence=()=>({schemaVersion:1,kind:'memory-forward-capacity',...plan,measuredAt:'2026-11-06T23:55:00Z',validUntil:'2026-11-07T00:55:00Z',measurements:{...measured}})
describe('manifest-bound forward-only capacity admission',()=>{
 test('requires actual evidence before admitting any database writes',()=>{
  expect(()=>assertForwardCapacity(undefined,plan,now)).toThrow('forward_capacity_required')
  expect(assertForwardCapacity(evidence(),plan,now)).toMatchObject({ready:true,backupRequired:false,rollbackSupported:false})
 })
 test.each(['manifestHash','migrationId','codeSha','sourceIdentity','targetIdentity'] as const)('rejects different frozen %s',key=>{
  expect(()=>assertForwardCapacity({...evidence(),[key]:'other'},plan,now)).toThrow('forward_capacity_scope_mismatch')
 })
 test('recomputes sufficiency and refuses absent staging/WAL or hypothetical savings',()=>{
  for(const changes of [{stagingBytes:undefined},{walBytes:undefined},{freeBytes:'0',futureSavingsCreditedBytes:measured.freeBytes}]){
   expect(()=>assertForwardCapacity({...evidence(),ready:true,measurements:{...measured,...changes}},plan,now)).toThrow('forward_capacity_not_ready')
  }
 })
 test('rejects stale/future/overlong evidence and backup-based assumptions',()=>{
  for(const changes of [{measuredAt:'2026-11-07T00:01:00Z'},{measuredAt:'invalid'},{validUntil:'2026-11-07T00:00:00Z'},{validUntil:'2026-11-08T00:00:00Z'},{schemaVersion:2},{measurements:{...measured,policy:'recoverable'}}]){
   expect(()=>assertForwardCapacity({...evidence(),...changes},plan,now)).toThrow()
  }
 })
 test('does not accept parseable timestamps containing arbitrary report text',()=>{
  expect(()=>assertForwardCapacity({...evidence(),measuredAt:'Fri Nov 06 2026 23:55:00 GMT (credential-fixture-do-not-export)'},plan,now)).toThrow('forward_capacity_invalid')
 })
 test('reserves the full duration once, keeps the original deadline, and does not re-reserve completed execution',()=>{
  let clock=now
  const input={...evidence(),validUntil:new Date(now+120000).toISOString(),measurements:{...measured,copySeconds:'80',indexSeconds:'10'}}
  const run=beginForwardCapacityRun(input,plan,()=>clock)
  clock+=60000
  expect(()=>assertForwardCapacity(input,plan,clock)).toThrow('forward_capacity_window_insufficient')
  expect(run.check()).toMatchObject({ready:true})
  // Neither mutable operator inputs nor a later deadline renew this run.
  input.validUntil=new Date(now+180000).toISOString();input.measurements.freeBytes='0'
  clock=now+120000
  expect(()=>run.check()).toThrow('forward_capacity_expired')
  expect(()=>beginForwardCapacityRun({...evidence(),validUntil:new Date(now+30000).toISOString()},plan,()=>now)).toThrow('forward_capacity_window_insufficient')
 })
 test('bounds observed physical WAL growth by the admitted additional WAL budget',()=>{
  const run=beginForwardCapacityRun(evidence(),plan,()=>now)
  expect(()=>run.checkWal('9007199254740993','9007199254741293')).not.toThrow()
  expect(()=>run.checkWal('9007199254740993','9007199254741294')).toThrow('forward_wal_capacity_exceeded')
  expect(()=>run.checkWal('not-measured','1')).toThrow('forward_wal_measurement_invalid')
 })
 test('never converts large byte measurements to JavaScript numbers',()=>{
  expect(assertForwardCapacity({...evidence(),measurements:{...measured,targetBytes:'9007199254740993',freeBytes:'999999999999999999999'}},plan,now).requiredFreeBytes).toBe('11709359031163928')
 })
})
