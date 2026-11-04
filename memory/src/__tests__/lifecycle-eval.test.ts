import {describe,test,expect} from 'vitest'
import {evaluateLifecycleQuality,wilsonInterval} from '../eval/lifecycle.js'
describe('lifecycle quality gates',()=>{
 test('AC-52 empty_denominators_insufficient',()=>{expect(evaluateLifecycleQuality([]).status).toBe('insufficient')})
 test('AC-52 wilson_precision_not_point_only',()=>{const r=wilsonInterval(196,200);expect(r.lower).toBeLessThan(.95);expect(r.upper).toBeGreaterThan(.98)})
 test('AC-52 repeated_inputs_not_independent',()=>{const r=evaluateLifecycleQuality(Array.from({length:600},()=>({id:'same',cluster:'same',metric:'precision' as const,success:true,run:1})));expect(r.metrics.precision.denominator).toBe(1);expect(r.status).toBe('insufficient')})
 test('AC-52 boundary_failure_any_run',()=>{const r=evaluateLifecycleQuality([{id:'a',cluster:'a',metric:'permissions',success:false,run:3}]);expect(r.status).toBe('fail')})
 test('AC-52 zero_boundary_cases_insufficient',()=>{const r=evaluateLifecycleQuality(Array.from({length:200},(_,i)=>({id:String(i),cluster:String(i),metric:'precision' as const,success:true,run:1})));expect(r.metrics.permissions.status).toBe('insufficient')})
 test('AC-52 invalid_counts_rejected',()=>{expect(()=>wilsonInterval(2,1)).toThrow();expect(()=>wilsonInterval(-1,3)).toThrow()})
})
