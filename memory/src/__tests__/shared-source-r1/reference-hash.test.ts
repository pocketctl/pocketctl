import {expect,test} from 'vitest'
import {canonicalPayloadHash,verifyOriginalSourceHash} from '@pocketctl/session-source'
const payload={text:'original',turn_id:'turn'}
const at='2026-11-06T00:00:00Z'
const envelope={event_id:123,event_type:'agent_text',payload,created_at:at}
const input={origin:'snapshot',originPosition:'123',eventType:'agent_text',occurredAt:at,payload,payloadHash:canonicalPayloadHash(envelope)}
test('distinguishes canonical payload hashes from the exact original four-field snapshot envelope',()=>{
 expect(verifyOriginalSourceHash(input)).toBe('snapshot-envelope-sha256-v1')
 expect(verifyOriginalSourceHash({...input,payloadHash:canonicalPayloadHash(payload)})).toBe('canonical-json-sha256-v1')
 for(const change of [{origin:'feed'},{originPosition:'124'},{eventType:'user_text'},{occurredAt:'2026-11-07T00:00:00Z'},{payload:{...payload,text:'changed'}}])expect(verifyOriginalSourceHash({...input,...change})).toBeNull()
 expect(verifyOriginalSourceHash({...input,payloadHash:canonicalPayloadHash({...envelope,unknown_field:true})})).toBeNull()
})
test('does not round bigint snapshot identities or infer provenance from a matching body',()=>{
 const id='9007199254740993',large={...envelope,event_id:id}
 expect(verifyOriginalSourceHash({...input,originPosition:id,payloadHash:canonicalPayloadHash(large)})).toBe('snapshot-envelope-sha256-v1')
 expect(verifyOriginalSourceHash({...input,originPosition:id,payloadHash:canonicalPayloadHash({...large,event_id:Number(id)})})).toBeNull()
})
