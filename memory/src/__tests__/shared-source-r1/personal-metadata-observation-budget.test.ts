import {expect,test} from 'vitest'
import {createPostgresPersonalMetadataReader,canonicalPayloadHash} from '@pocketctl/session-source'
const scope={installationId:'installation',principalUserId:'1',ownerScopeKind:'personal' as const,ownerScopeId:'installation',authorizationRevision:'1',configVersion:'1',modeGeneration:'3'},root={kind:'relay_event' as const,key:'1:session'}
function fixture(){
 const payload={text:'literal body'},hash=canonicalPayloadHash(payload).toString('hex')
 const locator={id:'1',rowVersion:'1',bodyChangeRevision:'0',contentHash:hash,nativeFingerprint:'a'.repeat(64),ref:null}
 const row={id:'1',session_id:'session',current_session_id:'session',event_type:'agent_text',occurred_at:'2026-11-11T00:00:00Z',payload,canonical_hash:hash,classification:{actor_scope:'assistant'},body_storage:'hot',metadata:locator}
 const version={content:'3',authorization:'1',storage:'0'},calls:string[]=[],state={input:'b'.repeat(64),native:'c'.repeat(64),locator,version,payload,afterMetadata:()=>{},beforeRead:(_mode:string)=>{}}
 const db={async connect(){throw Error('metadata_reader_must_not_open_transaction')},async query(_sql:string,args?:any[]){
  const ids=args?.[4],mode=ids[0]==='-2'?'metadata':ids.length===1?'enumerate':'body';calls.push(mode);state.beforeRead(mode)
  const value={contract:'personal-metadata-observation-v1',version:{...state.version},inputFingerprint:state.input,nativeSessionFingerprint:state.native,upperId:'1',rows:[mode==='metadata'?structuredClone(state.locator):{...structuredClone(row),payload:structuredClone(state.payload),metadata:structuredClone(state.locator)}]}
  if(mode==='metadata')state.afterMetadata()
  return{rows:[{value}],rowCount:1}
 }}
 return {reader:createPostgresPersonalMetadataReader(db),calls,state}
}
test('one private selected hot body is resolved between fresh original-proof assertions without another body query',async()=>{
 const f=fixture(),view=await f.reader.selectKeys(scope,root,['1']);expect(f.calls).toEqual(['body']);f.calls.length=0
 expect((await f.reader.resolve(view))[0].payload).toEqual({text:'literal body'})
 expect(f.calls).toEqual(['metadata','metadata'])
})
test('pre-read denial prevents any body fetch',async()=>{
 const f=fixture(),view=await f.reader.selectKeys(scope,root,['1']);f.calls.length=0
 f.state.beforeRead=()=>{throw Error('source_revoked')}
 await expect(f.reader.resolve(view)).rejects.toMatchObject({code:'revoked'});expect(f.calls).toEqual(['metadata'])
})
test.each(['authorization','storage','input','native','row'] as const)('post-read %s mutation rejects the unchanged original proof',async kind=>{
 const f=fixture(),view=await f.reader.selectKeys(scope,root,['1']);f.calls.length=0
 f.state.afterMetadata=()=>{if(kind==='authorization'||kind==='storage')f.state.version[kind]='9';else if(kind==='row')f.state.locator.rowVersion='9';else f.state[kind]='d'.repeat(64)}
 await expect(f.reader.resolve(view)).rejects.toMatchObject({code:'changed'})
 expect(f.reader.proof(view)).toMatchObject({observedVersion:{content:'3',authorization:'1',storage:'0'},rows:[{rowVersion:'1'}]})
})
test('captured body corruption still fails the original canonical digest',async()=>{
 const f=fixture();f.state.payload={text:'corrupted body'};const view=await f.reader.selectKeys(scope,root,['1'])
 await expect(f.reader.resolve(view)).rejects.toMatchObject({code:'body_hash_mismatch'})
})
test('selected body bytes are private copies rather than caller-owned SQL DTOs',async()=>{
 const f=fixture(),view=await f.reader.selectKeys(scope,root,['1'])
 f.state.payload.text='mutated caller DTO';(view.heads[0].classification as any).actor_scope='forged'
 expect((await f.reader.resolve(view))[0]).toMatchObject({payload:{text:'literal body'},head:{classification:{actor_scope:'assistant'}}})
})
test('a changed selected native row rejects its private body before resolution',async()=>{
 const f=fixture(),view=await f.reader.selectKeys(scope,root,['1']);f.calls.length=0;f.state.locator.rowVersion='2'
 await expect(f.reader.resolve(view)).rejects.toMatchObject({code:'changed'});expect(f.calls).toEqual(['metadata'])
})
