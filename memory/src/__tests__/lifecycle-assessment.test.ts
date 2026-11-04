import {describe,test,expect} from 'vitest'
import {validateValueAssessment} from '../claims/lifecycle-assessment.js'
describe('semantic value assessment boundary',()=>{
 const statement='Temporary debug prints for this one migration.'
 test('AC-35 low requires literal semantic support and a bounded reason',()=>{
  expect(validateValueAssessment({assessment:'low',reason:'transient_procedure',support:'Temporary debug prints'},statement)).toEqual({assessment:'low',reason:'transient_procedure'})
  for(const raw of [{assessment:'low',reason:'uncertain',support:statement},{assessment:'low',reason:'transient_procedure',support:'Never used before'},{assessment:'low',reason:'unused_90_days',support:statement}])expect(validateValueAssessment(raw,statement).assessment).toBe('unknown')
 })
 test('AC-35 unknown and retain do not invent low value',()=>{
  expect(validateValueAssessment({assessment:'retain',reason:'durable_value',support:''},statement).assessment).toBe('retain')
  expect(validateValueAssessment({},statement).assessment).toBe('unknown')
 })
})
