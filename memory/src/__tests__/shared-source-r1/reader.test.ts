import {expect,test} from 'vitest'
import {SharedSourceReader,canonicalPayloadHash,type SourceHead,type SourceStore,type SourceVersion} from '@pocketctl/session-source'
const scope={installationId:'installation',principalUserId:'1',ownerScopeKind:'personal' as const,ownerScopeId:'owner',authorizationRevision:'1',configVersion:'1'}
const root={kind:'relay_event' as const,key:'owner:1/session:one'}
const version:SourceVersion={content:'9007199254740993',authorization:'1',storage:'7'}
const payload={text:'private source',turn_id:'turn'}
const head:SourceHead={kind:'relay_event',canonicalKey:'9007199254740994',rootKey:root.key,sessionKey:'session',eventType:'agent_text',sourceSequence:'9007199254740993',contentHash:canonicalPayloadHash(payload).toString('hex'),hashVersion:'canonical-json-sha256-v1',classification:{},provenance:{state:'unknown'},storage:'hot'}
function fixture(){
 let status:'current'|'revoked'|'deleted'|'changed'='current'
 const store:SourceStore={async checkCurrent(){return {state:status,version}},async listHeads(){return {heads:[head],version,hasMore:false}},async resolveBodies(_scope,_root,heads){return heads.map(h=>({head:h,payload}))}}
 return {reader:new SharedSourceReader(store),setStatus:(v:typeof status)=>{status=v},store}
}
test('scoped heads preserve large sequence and unknown provenance; bodies use frozen canonical hash',async()=>{
 const {reader}=fixture(),page=await reader.listHeads(scope,root)
 expect(page.heads[0].sourceSequence).toBe('9007199254740993');expect(page.heads[0].provenance).toEqual({state:'unknown'})
 expect(JSON.stringify(page)).not.toContain('private source')
 expect((await reader.resolveBodies(scope,root,page.heads,page.version))[0].payload).toEqual(payload)
})
test('current metadata can be inspected without a prior version, retaining strict optional-version checks',async()=>{
 const f=fixture()
 await expect(f.reader.checkCurrent(scope,root)).resolves.toEqual({state:'current',version})
 await expect(f.reader.checkCurrent(scope,root,{...version,storage:'6'})).resolves.toMatchObject({state:'changed'})
 await expect(f.reader.checkCurrent(scope,root,null as any)).rejects.toMatchObject({code:'source_version_invalid'})
 f.setStatus('revoked')
 await expect(f.reader.checkCurrent(scope,root)).resolves.toMatchObject({state:'revoked'})
})
test.each([undefined,null,{content:'1'}])('body resolution rejects missing or malformed expected version: %j',async expected=>{
 const f=fixture()
 f.store.checkCurrent=async()=>({state:'current',version:{...version,content:'9007199254740994'}})
 await expect(f.reader.resolveBodies(scope,root,[head],expected as any)).rejects.toMatchObject({code:'source_version_invalid'})
})
test.each(['revoked','deleted','changed'] as const)('rejects %s after body IO before exposing results',async(state)=>{
 const f=fixture();f.store.resolveBodies=async(_s,_r,heads)=>{f.setStatus(state);return heads.map(h=>({head:h,payload}))}
 await expect(f.reader.resolveBodies(scope,root,[head],version)).rejects.toMatchObject({code:state})
})
test('rejects hash mismatch, foreign root, invalid body count and oversized pages',async()=>{
 const f=fixture()
 await expect(f.reader.resolveBodies(scope,root,[{...head,contentHash:'a'.repeat(64)}],version)).rejects.toMatchObject({code:'body_hash_mismatch'})
 await expect(f.reader.resolveBodies(scope,root,[{...head,rootKey:'other'}],version)).rejects.toMatchObject({code:'source_scope_mismatch'})
 await expect(f.reader.listHeads(scope,root,{limit:257})).rejects.toMatchObject({code:'page_limit'})
 f.store.resolveBodies=async()=>[]
 await expect(f.reader.resolveBodies(scope,root,[head],version)).rejects.toMatchObject({code:'body_set_mismatch'})
})
test('page cursors bind scope, root and all version components',async()=>{
 const f=fixture();f.store.listHeads=async()=>({heads:[head],version,hasMore:true})
 const page=await f.reader.listHeads(scope,root,{limit:1})
 expect(page.nextCursor).toBeTruthy()
 await expect(f.reader.listHeads({...scope,installationId:'other'},root,{cursor:page.nextCursor!})).rejects.toMatchObject({code:'cursor_scope_mismatch'})
 await expect(f.reader.listHeads(scope,{...root,key:'other'},{cursor:page.nextCursor!})).rejects.toMatchObject({code:'cursor_scope_mismatch'})
})
test('typed reference lookup is bounded, scoped, exact and version-checked without scanning a whole session',async()=>{
 const f=fixture();let lookups=0
 f.store.getHeads=async(_scope,_root,keys)=>{lookups++;expect(keys).toEqual([head.canonicalKey]);return {heads:[head],version,hasMore:false}}
 f.store.listHeads=async()=>{throw Error('unexpected_full_session_scan')}
 const page=await f.reader.getHeads(scope,root,[head.canonicalKey])
 expect(page.heads).toEqual([head]);expect(lookups).toBe(1)
 await expect(f.reader.getHeads(scope,root,Array(257).fill('1'))).rejects.toMatchObject({code:'page_limit'})
 await expect(f.reader.getHeads(scope,root,[head.canonicalKey,head.canonicalKey])).rejects.toMatchObject({code:'duplicate_source_identity'})
 f.store.getHeads=async()=>({heads:[],version,hasMore:false})
 await expect(f.reader.getHeads(scope,root,[head.canonicalKey])).rejects.toMatchObject({code:'body_set_mismatch'})
 f.store.getHeads=async()=>{f.setStatus('revoked');return {heads:[head],version,hasMore:false}}
 await expect(f.reader.getHeads(scope,root,[head.canonicalKey])).rejects.toMatchObject({code:'revoked'})
})
test('retained evidence may check current authority separately while raw body policy stays enforced',async()=>{
 const f=fixture();f.store.checkCurrent=async()=>{throw new Error('body_right_reclaimed')};f.store.checkAuthority=async()=>({state:'current',version})
 expect((await f.reader.checkAuthority(scope,root,version)).state).toBe('current')
 await expect(f.reader.resolveBodies(scope,root,[head],version)).rejects.toThrow('body_right_reclaimed')
})
