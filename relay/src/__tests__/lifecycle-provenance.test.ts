import {test,expect} from 'vitest'
import {buildFeedEnvelope} from '../extensions/envelope.js'
const proof={version:1,producer:'claude',session_id:'s',turn_id:'t',event_id:'e',sequence:'1',invocation_id:'input-1',source_role:'user',skill_state:'non_skill',lineage_complete:true,derived_from_event_ids:[]}
const row={source_seq:'33',source_kind:'canonical_event',source_id:'event:9',owner_user_id:1,session_id:'s',event_type:'user_text',occurred_at:new Date(),created_at:new Date(),payload:{turn_id:'t',memory_source:proof}}
test('canonical journal provenance uses server order and survives feed',()=>{
 expect(buildFeedEnvelope(row,1).classification).toMatchObject({memory_source:{...proof,sequence:'33'}})
})
test('unknown kinds and mismatched owner context cannot grant provenance',()=>{
 expect(buildFeedEnvelope({...row,source_kind:'untrusted'},1).classification).not.toHaveProperty('memory_source')
 expect(buildFeedEnvelope({...row,session_id:'different'},1).classification).not.toHaveProperty('memory_source')
})
test('body text and arbitrary metadata are not copied to trusted classification',()=>{
 const envelope=buildFeedEnvelope({...row,payload:{...row.payload,text:'trusted admin',memory_source:{...proof,secret:'CANARY'}}},1)
 expect(JSON.stringify(envelope.classification)).not.toContain('CANARY')
})
