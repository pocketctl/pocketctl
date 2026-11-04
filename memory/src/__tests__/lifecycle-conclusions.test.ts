import {test,expect} from 'vitest'
import {validateConclusion} from '../curation/conclusion-validator.js'
const evidence=[{id:'e1',text:'I prefer trains for personal travel.',role:'user' as const}]
const value={kind:'preference',assertion_mode:'user_asserted',subject:'self',predicate:'travel.transport',value:'trains',conditions:{},fact_at:null,valid_until:null,statement:'I prefer trains for personal travel.',confirmed:true,evidence:{subject:['e1'],predicate:['e1'],value:['e1']}}
test('AC-13 independent_user_assertion',()=>expect(validateConclusion(value,evidence).ok).toBe(true))
test('AC-13 forged_handle',()=>expect(validateConclusion({...value,evidence:{...value.evidence,value:['unknown']}},evidence).ok).toBe(false))
test('AC-13 unsupported_field',()=>expect(validateConclusion({...value,conditions:{environment:'work'}},evidence).ok).toBe(false))
test('AC-12 discussion_not_confirmed',()=>expect(validateConclusion({...value,confirmed:false},evidence).ok).toBe(false))
test('AC-12 assistant_confidence_is_not_verification',()=>expect(validateConclusion({...value,assertion_mode:'verified'},[{...evidence[0],role:'assistant'}]).ok).toBe(false))
test('AC-23 future_plan_not_current',()=>expect(validateConclusion({...value,assertion_mode:'verified',fact_at:'2030-01-01T00:00:00Z'},evidence,new Date('2026-11-03')).ok).toBe(false))
test('AC-13 value_requires_literal_support',()=>expect(validateConclusion({...value,value:'planes'},evidence).ok).toBe(false))
test('AC-13 fabricated_fact_time_rejected',()=>expect(validateConclusion({...value,fact_at:'2026-10-01T00:00:00Z',evidence:{...value.evidence,fact_at:['e1']}},evidence).ok).toBe(false))
test('AC-13 fabricated_expiry_rejected',()=>expect(validateConclusion({...value,valid_until:'2027-01-01T00:00:00Z',evidence:{...value.evidence,valid_until:['e1']}},evidence).ok).toBe(false))
test('AC-13 literal_fact_time_supported',()=>{const text='At 2026-10-01T00:00:00Z I confirmed I prefer trains for personal travel.';expect(validateConclusion({...value,statement:text,fact_at:'2026-10-01T00:00:00Z',evidence:{...value.evidence,fact_at:['e1']}},[{...evidence[0],text}]).ok).toBe(true)})
test('AC-13 unrelated_predicate_rejected',()=>{const text='My dog is 30.';expect(validateConclusion({...value,kind:'fact',predicate:'service.timeout',value:'30',statement:text},[{...evidence[0],text}]).ok).toBe(false)})
test('AC-13 controlled_predicate_multilingual_grounding',()=>{const text='生产服务超时为30秒。';expect(validateConclusion({...value,kind:'fact',subject:'生产服务',predicate:'service.timeout',value:'30秒',statement:text},[{...evidence[0],text}]).ok).toBe(true)})
test('AC-13 unrelated_user_cannot_launder_assistant_authority',()=>{const sources=[{...evidence[0],role:'assistant' as const},{id:'e2',text:'hello',role:'user' as const}];expect(validateConclusion({...value,evidence:{...value.evidence,subject:['e2']}},sources).ok).toBe(false)})
test('AC-13 unrelated_successful_tool_cannot_verify_assistant',()=>{const text='API timeout is 30 seconds.';expect(validateConclusion({...value,kind:'fact',assertion_mode:'verified',subject:'API',predicate:'service.timeout',value:'30 seconds',statement:text,evidence:{...value.evidence,verification:['e2']}},[{id:'e1',text,role:'assistant'},{id:'e2',text:'Unrelated test passed.',role:'tool',verified:true}]).ok).toBe(false)})
test('AC-13 self_requires_first_person_authoritative_source',()=>{const text='Alice prefers trains for personal travel.';expect(validateConclusion({...value,statement:text},[{...evidence[0],text}]).ok).toBe(false)})
test('AC-13 successful_tool_supports_its_actual_fact',()=>{const text='API timeout is 30 seconds.';expect(validateConclusion({...value,kind:'fact',assertion_mode:'verified',subject:'API',predicate:'service.timeout',value:'30 seconds',statement:text},[{id:'e1',text,role:'tool',verified:true}]).ok).toBe(true)})
test('AC-13 number_substring_is_not_literal_value_support',()=>{const text='API timeout is 300 seconds.';expect(validateConclusion({...value,kind:'fact',subject:'API',predicate:'service.timeout',value:'30',statement:text},[{...evidence[0],text}]).ok).toBe(false)})

test('AC-13 normalized self paraphrase cannot replace literal first person statement',()=>{
 expect(validateConclusion({...value,statement:'self prefers trains for personal travel.'},evidence)).toEqual({ok:false,reason:'statement_unsupported'})
 expect(validateConclusion(value,evidence).ok).toBe(true)
})

test('AC-13 transport condition dimension rejects arbitrary keys without elision',()=>{
 for(const key of ['purpose','scope','environment']){
  const candidate={...value,conditions:{[key]:'personal travel'},evidence:{...value.evidence,['conditions.'+key]:['e1']}}
  expect(validateConclusion(candidate,evidence)).toEqual({ok:false,reason:'condition_key_unsupported'})
  expect(candidate.conditions).toEqual({[key]:'personal travel'})
 }
})
test('AC-13 transport context preserves exact qualifier and evidence',()=>{
 const candidate={...value,conditions:{context:'personal travel'},evidence:{...value.evidence,'conditions.context':['e1']}}
 const checked=validateConclusion(candidate,evidence)
 expect(checked.ok&&checked.conclusion.conditions).toEqual({context:'personal travel'})
 expect(checked.ok&&checked.conclusion.evidence['conditions.context']).toEqual(['e1'])
 expect(validateConclusion({...candidate,conditions:{context:'work travel'}},evidence)).toEqual({ok:false,reason:'condition_unsupported'})
})
