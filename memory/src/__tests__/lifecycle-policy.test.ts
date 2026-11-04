import {describe,test,expect} from 'vitest'
import {evaluateClaimLifecycle} from '../claims/lifecycle-evaluator.js'
import {type LifecycleFacts,LIFECYCLE_DAY_MS as day} from '../claims/lifecycle-policy.js'
import {selectHistoryReclamation} from '../retention/claim-history.js'
const base=Date.UTC(2026,0,1)
const facts=(days=90,patch:Partial<LifecycleFacts>={}):LifecycleFacts=>({now:new Date(base+days*day),createdAt:new Date(base),validUntil:null,state:'active',sourceAvailable:true,authority:'automation_accepted',kind:'method',protection:'none',storageTier:'hot',bodyState:'present',coldSince:null,lastConfirmedAt:null,lastDeliveredAt:null,lastConfirmedUseAt:null,observationState:'observed',observationStartedAt:new Date(base),valueAssessment:'low',coldMode:'enabled',reclaimMode:'enabled',...patch})
describe('typed lifecycle policy',()=>{
 test('AC-33 validity before at after and pin cannot override revocation',()=>{
  const validUntil=new Date(base+90*day)
  expect(evaluateClaimLifecycle(facts(89,{validUntil,protection:'pinned'})).action).toBe('retain')
  for(const days of [90,91])expect(evaluateClaimLifecycle(facts(days,{validUntil,protection:'pinned'})).action).toBe('expire')
  expect(evaluateClaimLifecycle(facts(1,{sourceAvailable:false,protection:'pinned'})).action).toBe('revoke')
 })
 test('AC-34 90 plus 90 only grants eligibility',()=>{
  expect(evaluateClaimLifecycle(facts(89)).action).toBe('retain')
  expect(evaluateClaimLifecycle(facts()).action).toBe('cool')
  expect(evaluateClaimLifecycle(facts(179,{storageTier:'cold',coldSince:new Date(base+90*day)})).action).toBe('retain')
  expect(evaluateClaimLifecycle(facts(180,{storageTier:'cold',coldSince:new Date(base+90*day)})).action).toBe('reclaim_eligible')
  expect(evaluateClaimLifecycle(facts(900,{valueAssessment:'unknown'})).action).toBe('retain')
 })
 test.each(['preference','constraint','decision','event'] as const)('AC-35 stable %s retained regardless of low frequency',kind=>{
  expect(evaluateClaimLifecycle(facts(900,{kind})).action).toBe('retain')
 })
 test.each(['pinned','critical','user_corrected'] as const)('AC-35 protected %s retained',protection=>{
  expect(evaluateClaimLifecycle(facts(900,{protection})).action).toBe('retain')
 })
 test('AC-35 missing telemetry and human authority retained',()=>{
  for(const patch of [{observationState:'unknown' as const},{observationStartedAt:null},{authority:'user_corrected'},{authority:'user_accepted'}])
   expect(evaluateClaimLifecycle(facts(900,patch)).action).toBe('retain')
 })
 test('AC-32 delivery and confirmed use renew observation; no search signal is accepted',()=>{
  for(const field of ['lastDeliveredAt','lastConfirmedUseAt','lastConfirmedAt'] as const)
   expect(evaluateClaimLifecycle(facts(100,{[field]:new Date(base+50*day)})).action).toBe('retain')
 })
 test('AC-34 off and shadow never mutate',()=>{
  for(const coldMode of ['off','shadow'] as const)expect(evaluateClaimLifecycle(facts(900,{coldMode})).action).toBe('retain')
 })
 test('AC-37 history is union of three newest, ninety days, dependencies and protection',()=>{
  const versions=Array.from({length:9},(_,i)=>({versionId:String(i+1),versionNumber:i+1,createdAt:new Date(base),current:i===8,protected:i===1,dependent:i===2,bodyState:'present'}))
  versions[3].createdAt=new Date(base+150*day)
  expect(selectHistoryReclamation(versions,new Date(base+180*day))).toEqual(['1','5','6'])
 })
})
