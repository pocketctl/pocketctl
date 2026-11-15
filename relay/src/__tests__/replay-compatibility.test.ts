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
