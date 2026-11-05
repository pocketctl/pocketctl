import {expect,test} from 'vitest'
import {evaluateLifecycleHealth,summarizeLifecycleHealth,type LifecycleHealthRow} from '../reporting/lifecycle-health.js'
const row:LifecycleHealthRow={installation_id:'private-id',relay_status:'active',local_status:'ready',owner_scope_kind:'personal',owner_state:'active',policy_mode:'shadow',consume_mode:'off',cold_mode:'off',reclaim_mode:'off',turns:226,receipt_turns:226,complete_turns:0,provenance_unknown_turns:226,missing_receipt_turns:0,consolidation_completed:3,consolidation_failed:0,consolidation_stalled:0,committed_decisions:0,proposed_decisions:0,context_delivered:0,context_modes:['off'],counts_capped:false}
test('shadow unknown-source coverage is limited without asserting formal writes or delivery',()=>{
 expect(evaluateLifecycleHealth(row,'shadow')).toMatchObject({mode:'shadow',execution:'healthy',coverage:'limited',formal_writes_enabled:false,reasons:['source_provenance_unknown'],consume_mode:'off'})
 const report=summarizeLifecycleHealth([row],'shadow')
 expect(report).toMatchObject({configured_mode:'shadow',execution:{status:'healthy'},coverage:{status:'limited',turns:226,complete_turns:0,provenance_unknown_turns:226},consolidation:{completed:3},decisions:{committed:0},context:{delivered:0}})
 expect(JSON.stringify(report)).not.toContain('private-id')
})
test('disabled, paused and nonpersonal owners do not alert on retained failures or gaps',()=>{
 for(const disabled of [row,{...row,policy_mode:'off'},{...row,relay_status:'paused'},{...row,owner_scope_kind:'team'},{...row,owner_state:'revoked'},{...row,local_status:'purging'}]){
  const global=disabled===row?'off':'enabled'
  expect(evaluateLifecycleHealth({...disabled,consolidation_failed:4,consolidation_stalled:5},global)).toMatchObject({mode:'off',execution:'disabled',coverage:'disabled',reasons:[]})
 }
})
test('enabled idle lifecycle does not infer a failure from zero decisions or deliveries',()=>{
 expect(evaluateLifecycleHealth({...row,policy_mode:'enabled',turns:0,receipt_turns:0,provenance_unknown_turns:0,consolidation_completed:0},'enabled')).toMatchObject({execution:'idle',coverage:'idle',reasons:[],formal_writes_enabled:true})
})
test('current consolidation failures and due stale work degrade execution separately from coverage',()=>{
 expect(evaluateLifecycleHealth({...row,policy_mode:'enabled',consolidation_failed:1,consolidation_stalled:2,provenance_unknown_turns:0,complete_turns:225,missing_receipt_turns:1},'enabled')).toMatchObject({execution:'degraded',coverage:'limited',reasons:['consolidation_failed','consolidation_stalled','coverage_incomplete']})
})
test('global shadow bounds every lifecycle capability and caps prevent full coverage claims',()=>{
 const value={...row,policy_mode:'enabled',consume_mode:'enabled',cold_mode:'enabled',reclaim_mode:'shadow',complete_turns:226,provenance_unknown_turns:0,counts_capped:true}
 expect(evaluateLifecycleHealth(value,'shadow')).toMatchObject({mode:'shadow',consume_mode:'shadow',cold_mode:'shadow',reclaim_mode:'shadow',formal_writes_enabled:false,coverage:'limited',reasons:['counts_capped']})
 expect(summarizeLifecycleHealth([value],'enabled')).toMatchObject({coverage:{status:'limited',counts_capped:true}})
})
