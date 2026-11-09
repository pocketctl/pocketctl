import {expect,test} from 'vitest'
import {canonicalPayloadHash} from '@pocketctl/session-source'
import {prepareSourceReferences} from '../../sources/prepared-sources.js'
const payload={text:'immutable body',turn_id:'turn'},id='10000000-0000-0000-0000-000000000001'
const original={source_event_id:id,installation_id:'installation',session_id:'session',turn_id:'turn',origin:'feed',event_type:'agent_text',occurred_at:new Date('2026-11-06T00:00:00Z'),payload_hash:canonicalPayloadHash(payload),classification:{},source_provenance:{},body_reclaimed_at:null,row_version:'1',payload}
test('legacy preparation reads before the caller transaction and final validation needs metadata only',async()=>{
 let changed=false;const calls:string[]=[]
 const pool={async query(sql:string){calls.push(sql);return {rows:[{...original,row_version:changed?'2':'1'}],rowCount:1}}}
 const prepared=await prepareSourceReferences(pool as never,'installation',[id])
 expect(prepared.events[0].payload).toEqual(payload)
 expect(prepared.events[0].source_event_id).toBe(id)
 const client={async query(sql:string){expect(sql).not.toMatch(/\bpayload\s*[,\n]/);return pool.query(sql)}}
 await prepared.assertCurrent(client as never)
 changed=true;await expect(prepared.assertCurrent(client as never)).rejects.toThrow('source_reference_changed')
 expect(calls[0]).not.toContain('FOR SHARE')
})
test('bad legacy hashes, reclaimed bodies, missing refs and oversized sets cannot produce prepared input',async()=>{
 const pool=(row:unknown)=>({async query(){return {rows:row?[row]:[],rowCount:row?1:0}}})
 await expect(prepareSourceReferences(pool({...original,payload:{text:'changed'}}) as never,'installation',[id])).rejects.toThrow('source_reference_hash_mismatch')
 await expect(prepareSourceReferences(pool({...original,body_reclaimed_at:new Date()}) as never,'installation',[id])).rejects.toThrow('source_reference_reclaimed')
 await expect(prepareSourceReferences(pool(null) as never,'installation',[id])).rejects.toThrow('source_reference_missing')
 await expect(prepareSourceReferences(pool(original) as never,'installation',Array(4097).fill(id))).rejects.toThrow('source_reference_limit')
})
