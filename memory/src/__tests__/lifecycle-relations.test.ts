import {test,expect} from 'vitest'
import {evaluateRelation} from '../curation/relation-evaluator.js'
import type {Conclusion} from '../curation/conclusion-validator.js'
const c:Conclusion={kind:'fact',assertion_mode:'verified',subject:'service',predicate:'service.timeout',value:'30 seconds',conditions:{environment:'production'},fact_at:'2026-11-01T00:00:00Z',valid_until:null,statement:'Timeout is 30 seconds.',confirmed:true,evidence:{subject:['e1'],predicate:['e1'],value:['e1']}}
const old={conclusion:c,protection:'none',bodyState:'present',storageTier:'hot',state:'active'}
test('AC-17 exact_value_links_without_new_version',()=>expect(evaluateRelation(c,old).action).toBe('link_evidence'))
test('AC-17 richer_equivalent_merges_evidence_only',()=>expect(evaluateRelation({...c,statement:'Production Timeout is 30 seconds.'},old).action).toBe('merge'))
test('AC-19 same_problem_verified_change_replaces',()=>expect(evaluateRelation({...c,value:'60 seconds',fact_at:'2026-11-02T00:00:00Z'},old).action).toBe('replace'))
test('AC-20 different_condition_variant',()=>expect(evaluateRelation({...c,conditions:{environment:'staging'}},old).action).toBe('create_variant'))
test('AC-23 future_plan_variant_not_current',()=>expect(evaluateRelation({...c,value:'60 seconds',assertion_mode:'planned',fact_at:'2027-01-01T00:00:00Z'},old).action).toBe('create_variant'))
test('AC-23 late_old_fact_does_not_replace',()=>expect(evaluateRelation({...c,value:'10 seconds',fact_at:'2026-10-01T00:00:00Z'},old).action).toBe('defer'))
test('AC-21 pinned_never_inferred_overwrite',()=>expect(evaluateRelation({...c,value:'60 seconds'},{...old,protection:'pinned'}).action).toBe('defer'))
test('AC-20 unresolved_same_time_conflict_defers',()=>expect(evaluateRelation({...c,value:'60 seconds'},old).action).toBe('defer'))
test('AC-24 reclaimed_cannot_rehydrate',()=>expect(evaluateRelation(c,{...old,bodyState:'reclaimed'}).action).toBe('skip'))
test('AC-18 independent_event_not_merge',()=>expect(evaluateRelation({...c,kind:'event',predicate:'incident.occurred'},old).action).toBe('create_variant'))

test('AC-21 subject_case_cannot_bypass_protection',()=>expect(evaluateRelation({...c,subject:'SERVICE',value:'60 seconds'},{...old,protection:'pinned'}).action).toBe('defer'))
test('AC-21 matched_alias_identity_cannot_create_variant',()=>expect(evaluateRelation({...c,subject:'api',value:'60 seconds'},{...old,protection:'pinned'},true).action).toBe('defer'))

test('AC-19 canonical transport context permits update and preserves legacy identity',()=>{
 const first:Conclusion={...c,kind:'preference',predicate:'travel.transport',subject:'self',assertion_mode:'user_asserted',value:'trains',conditions:{context:'personal travel'},fact_at:null,statement:'I prefer trains for personal travel.'}
 const next={...first,value:'planes',statement:'I prefer planes for personal travel.'}
 expect(evaluateRelation(next,{...old,conclusion:first}).action).toBe('replace')
 expect(evaluateRelation(next,{...old,conclusion:{...first,conditions:{purpose:'personal travel'}}}).action).toBe('create_variant')
 expect(evaluateRelation({...next,conditions:{context:'work travel'}},{...old,conclusion:first}).action).toBe('create_variant')
})
