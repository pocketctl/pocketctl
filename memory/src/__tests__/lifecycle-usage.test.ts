import {describe,it,expect} from 'vitest'
import {usageEffect} from '../context/usage-aggregation.js'
import {eligibleContextFacts,type ContextClaimFacts} from '../context/consumption.js'
const facts:ContextClaimFacts={claimId:'c',versionId:'v',ownerScopeKind:'personal',current:true,timeEligible:true,sourceMetadataOwned:true,canonicalRemote:null,scopeKind:'installation',scopeKey:'i',repositoryId:null,snapshotId:null,branch:null,applicability:null,lifecycle:{hot:true,spaceId:'work',destinations:['work'],spaceActive:true,consume:true}}
const frame={repositoryId:null,repoSnapshotId:null,branch:null,taskScopeKey:null}
describe('lifecycle usage and scene consumption',()=>{
 it('AC-31 delivery and reported use never confirm usefulness',()=>{for(const signal of ['retrieved','delivered','agent_reported_used'] as const)expect(usageEffect(signal).confirmed).toBe(false);expect(usageEffect('user_confirmed')).toEqual({delivered:false,confirmed:true,refreshAuthority:false})})
 it('AC-25 unresolved or mismatched scenes cannot consume logical claims',()=>{expect(eligibleContextFacts(facts,frame)).toBe(false);expect(eligibleContextFacts(facts,{...frame,lifecycle:{spaceId:'life',destination:'personal',consume:true} as any})).toBe(false)})
 it('AC-26 correct scene still rejects cold and unavailable content',()=>{const f={...frame,lifecycle:{spaceId:'work',destination:'work',consume:true} as any};expect(eligibleContextFacts(facts,f)).toBe(true);expect(eligibleContextFacts({...facts,lifecycle:{...facts.lifecycle!,hot:false}},f)).toBe(false)})
})
