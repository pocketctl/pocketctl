import {expect,test} from 'vitest'
import {canonicalPayloadHash,type ResolvedSourceBody} from '@pocketctl/session-source'
import {compareSourcePage,type LegacyComparisonSource} from '../../sources/shadow-comparison.js'
const payload={text:'private synthetic body',turn_id:'turn'}
const hash=canonicalPayloadHash(payload).toString('hex')
const body:ResolvedSourceBody={head:{kind:'relay_event',canonicalKey:'9007199254740993',rootKey:'1:session',sessionKey:'session',turnKey:'turn',eventType:'agent_text',occurredAt:'2026-11-07T00:00:00.123456Z',contentHash:hash,hashVersion:'canonical-json-sha256-v1',classification:{},provenance:{state:'unknown'},storage:'hot'},payload}
const source:LegacyComparisonSource={sourceEventId:'10000000-0000-0000-0000-000000000099',installationId:'installation',origin:'feed',originPosition:'42',sessionId:'session',turnId:'turn',eventType:'agent_text',occurredAt:'2026-11-07T00:00:00.123Z',payload,payloadHash:hash,classification:{},provenance:{},links:[{kind:'relay_event',key:body.head.canonicalKey,via:'inbox'}]}
test('explicit scoped identity permits shadow equality without promoting unknown provenance or exporting bodies',()=>{
 const result=compareSourcePage('installation',[body],[source])
 expect(result).toMatchObject({schemaVersion:1,matched:'1',unproven:'0',different:'0',unknownProvenance:'1',fullAcceptanceReady:false})
 expect(result.canonicalDigest).toBe(result.legacyDigest)
 expect(JSON.stringify(result)).not.toContain(payload.text)
})
test.each([
 ['missing_relation',{links:[]}],['cross_installation',{installationId:'other'}],['duplicate',null],
 ['body_hash',{payload:{...payload,text:'changed'}}],['classification',{classification:{actor_scope:'root'}}],
 ['event_type',{eventType:'user_goal'}],['session',{sessionId:'other'}],['turn',{turnId:'other'}],['time',{occurredAt:'2026-11-07T00:00:01.123Z'}],
 ['different_microsecond',{occurredAt:'2026-11-07T00:00:00.123001Z'}],
 ['stored_hash',{payloadHash:'0'.repeat(64)}],
] as const)('rejects a shadow match based on %s',(_name,change)=>{
 const rows=change===null?[source,{...source,sourceEventId:'20000000-0000-0000-0000-000000000099'}]:[{...source,...change}]
 const result=compareSourcePage('installation',[body],rows as LegacyComparisonSource[])
 expect(BigInt(result.unproven)+BigInt(result.different)).toBe(1n);expect(result.matched).toBe('0')
 expect(result.canonicalDigest).not.toBe(result.legacyDigest)
})
test('Team delivery and collaboration remain separate identities even with the same body',()=>{
 const delivery={...body,head:{...body.head,kind:'team_delivery' as const,storage:'team' as const}}
 expect(compareSourcePage('installation',[delivery],[source]).unproven).toBe('1')
})
test('a forged canonical body never passes a same stored hash',()=>{
 expect(compareSourcePage('installation',[{...body,payload:{text:'forged canonical'}}],[source]).different).toBe('1')
})
test('comparison pages and total body bytes are bounded',()=>{
 expect(()=>compareSourcePage('installation',Array(129).fill(body),[source])).toThrow('shadow_comparison_limit')
 expect(()=>compareSourcePage('installation',[body],[source],{maxBytes:1})).toThrow('shadow_comparison_limit')
})
test('one old UUID cannot establish two different canonical identities',()=>{
 const other={...body,head:{...body.head,canonicalKey:'9007199254740994'}}
 const candidate={...source,links:[...source.links,{...source.links[0],key:other.head.canonicalKey}]}
 expect(compareSourcePage('installation',[body,other],[candidate])).toMatchObject({matched:'0',unproven:'2'})
})
