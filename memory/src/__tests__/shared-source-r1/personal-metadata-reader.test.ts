import {expect,test} from 'vitest'
import {PersonalMetadataSourceReader,SharedSourceReader,canonicalPayloadHash,type PersonalMetadataStore,type SourceHead} from '@pocketctl/session-source'
const scope={installationId:'installation',principalUserId:'1',ownerScopeKind:'personal' as const,ownerScopeId:'installation',authorizationRevision:'1',configVersion:'1',modeGeneration:'3'}
const root={kind:'relay_event' as const,key:'1:session'},version={content:'3',authorization:'1',storage:'0'},payload={text:'fixed selected body'}
const head:SourceHead={kind:'relay_event',canonicalKey:'1',rootKey:root.key,sessionKey:'session',eventType:'agent_text',contentHash:canonicalPayloadHash(payload).toString('hex'),hashVersion:'canonical-json-sha256-v1',classification:{actor_scope:'assistant'},provenance:{state:'unknown'},storage:'hot'}
function fixture(){
 let result={head:structuredClone(head),payload:structuredClone(payload)}
 const inner=Object.freeze({}),store:PersonalMetadataStore={async select(){return {token:inner,heads:[head],observedVersion:version,upperId:'1',exhausted:true}},async assert(){},async resolve(){return [result]},proof(){return {observedVersion:version,rows:[{id:'1'}]}}}
 const reader=new PersonalMetadataSourceReader(store)
 return {reader,store,change(value:typeof result){result=value}}
}
test('selected view is opaque, reader-bound and retains its original full head/body proof',async()=>{
 const f=fixture(),view=await f.reader.selectPage(scope,root)
 await expect(f.reader.resolve({...view,token:{}})).rejects.toMatchObject({code:'source_selection_invalid'})
 await expect(new PersonalMetadataSourceReader(f.store).resolve(view)).rejects.toMatchObject({code:'source_selection_invalid'})
 ;(view.heads[0].classification as any).actor_scope='forged'
 expect((await f.reader.resolve(view))[0].head.classification).toEqual({actor_scope:'assistant'})
 f.change({head:{...head,classification:{actor_scope:'user'}},payload})
 await expect(f.reader.resolve(view)).rejects.toMatchObject({code:'body_set_mismatch'})
})
test('selected bodies retain the ordinary canonical hash check and unknown provenance',async()=>{
 const f=fixture(),view=await f.reader.selectKeys(scope,root,['1'])
 expect((await f.reader.resolve(view))[0].head.provenance).toEqual({state:'unknown'})
 f.change({head,payload:{text:'changed bytes'}})
 await expect(f.reader.resolve(view)).rejects.toMatchObject({code:'body_hash_mismatch'})
})
test('metadata selection cannot broaden personal scope or accept duplicate/malformed source IDs',async()=>{
 const f=fixture()
 await expect(f.reader.selectPage(scope,{kind:'team_collaboration',key:'team'})).rejects.toMatchObject({code:'source_scope_mismatch'})
 await expect(f.reader.selectKeys(scope,root,['1','1'])).rejects.toMatchObject({code:'source_identity_invalid'})
 await expect(f.reader.selectKeys(scope,root,['-1'])).rejects.toMatchObject({code:'source_identity_invalid'})
 await expect(f.reader.selectKeys(scope,root,[])).rejects.toMatchObject({code:'page_limit'})
})
test('ordinary reader still rejects a moving complete root vector',async()=>{
 let n=0
 const ordinary=new SharedSourceReader({async checkCurrent(){return {state:'current',version:{...version,content:String(++n)}}},async listHeads(){return {heads:[head],version,hasMore:false}},async resolveBodies(){return [{head,payload}]}})
 await expect(ordinary.listHeads(scope,root)).rejects.toMatchObject({code:'changed'})
})
