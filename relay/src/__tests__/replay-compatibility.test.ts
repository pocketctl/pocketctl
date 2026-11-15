import {test,expect} from 'vitest'
import {assertReplayCompatible} from '../materialization/replay-compatibility.js'

test.each(['turn_status','session_meta','agent_reasoning'])('legacy %s unknown envelope follows the native decoder system role',type=>{
 const original={type,session_id:'s',event_id:'e',turn_id:'t'}
 const proof={version:1,producer:'codex',session_id:'s',event_id:'e',turn_id:'t',sequence:'1',invocation_id:'t',source_role:'system',skill_state:'unknown',lineage_complete:false,derived_from_event_ids:[]}
 expect(()=>assertReplayCompatible(original,{...original,memory_source:proof},'codex')).not.toThrow()
 expect(()=>assertReplayCompatible(original,{...original,memory_source:{...proof,source_role:'assistant'}},'codex')).toThrow('replay_provenance_conflict')
 expect(()=>assertReplayCompatible(original,{...original,memory_source:proof},'opencode')).toThrow('replay_provenance_conflict')
})
test('request identity allows transport changes but never content changes',()=>{
 const original={type:'agent_text',session_id:'s',request_id:'r',text:'canonical',seq:1}
 expect(()=>assertReplayCompatible(original,{...original,seq:2,resync:true})).not.toThrow()
 expect(()=>assertReplayCompatible(original,{...original,seq:2,text:'changed'})).toThrow('replay_payload_conflict')
})

const observed={version:1,producer:'codex',session_id:'s',event_id:'e',turn_id:'t',sequence:'1',invocation_id:'t',source_role:'tool',skill_state:'unknown',lineage_complete:false,derived_from_event_ids:[]}
const legacy={type:'tool_result',session_id:'s',event_id:'e',turn_id:'t',output:'original',memory_source:{...observed,producer:'unknown'}}
test('legacy unknown producer placeholder accepts identical bound observation without changing canonical proof',()=>{
 const before=JSON.stringify(legacy)
 expect(()=>assertReplayCompatible(legacy,{...legacy,seq:99,resync:true,memory_source:observed},'codex')).not.toThrow()
 expect(JSON.stringify(legacy)).toBe(before)
})
test.each([
 {producer:'opencode'},{skill_state:'non_skill',lineage_complete:true},{skill_state:'skill'},
 {sequence:'2'},{invocation_id:'different'},{source_role:'assistant'},{session_id:'other'},
 {event_id:'other'},{turn_id:'other'},{parent_invocation_id:'parent'},
 {skill_invocation_id:'skill'},{derived_from_event_ids:['derived']},{extra:true},
])('legacy unknown placeholder rejects altered provenance %j',change=>{
 expect(()=>assertReplayCompatible(legacy,{...legacy,memory_source:{...observed,...change}},'codex')).toThrow('replay_provenance_conflict')
})
test.each([{producer:'claude'},{lineage_complete:true},{sequence:'2'},{extra:true},null])('only exact historical unknown placeholder is compatible: %j',change=>{
 const canonical={...legacy,memory_source:change===null?null:{...legacy.memory_source,...change}}
 expect(()=>assertReplayCompatible(canonical,{...legacy,memory_source:observed},'codex')).toThrow('replay_provenance_conflict')
})
