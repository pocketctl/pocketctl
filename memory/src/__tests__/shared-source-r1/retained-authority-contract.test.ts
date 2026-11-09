import {describe,expect,it} from 'vitest'
import {validateRetainedAuthorityBinding,createRetainedAuthorityPage,validateRetainedAuthorityPage,startRetainedAuthorityStream,advanceRetainedAuthorityStream} from '../../migrations/shared-forward/retained-authority-contract.js'

const id='11111111-1111-4111-8111-111111111111'
const hash='a'.repeat(64)
const binding=()=>({schemaVersion:1,kind:'memory-retained-current-authority',installationIds:[id],databaseIdentityHash:hash,configHash:hash,catalogHash:hash,keyringHash:hash,sourcePolicyHash:hash,roleIdentityHash:hash,unitsHash:hash,referenceContractHash:hash})
const stream=()=>({installationId:id,family:'root',schema:'memory',table:'source_sessions',column:null,keyColumns:[{name:'session_id',type:'decimal'}]})
const item=(n:string)=>({installationId:id,schema:'memory',table:'source_sessions',column:null,key:[n],occurrence:'0',rowVersion:'9007199254740993',metadataFingerprint:hash})
const positive=(n:string)=>({kind:'positive',item:item(n),policy:'personal-raw-v1',currentFactsHash:hash,dependencySetHash:hash})
const input=(records:unknown[],state=startRetainedAuthorityStream(binding(),stream()),terminal=false)=>({ordinal:state.nextOrdinal,previousHash:state.tailHash,from:state.cursor,records,terminal})
const negative=()=>({kind:'settled-negative-v4',item:item('1'),original:{manifestHash:hash,table:'source_sessions',fullPrimaryKey:['1'],firstPage:'0',firstIndex:'0',originalFingerprint:hash},settlement:{manifestHash:hash,immutableManifestChainHash:hash,receiptTailHash:hash,completedPages:'9007199254740993',totalPages:'9007199254740993',originalMembershipHash:hash,currentExpectedStateHash:hash,nativeOutputHash:hash,accountingInvariantHash:hash,exactNegativeCheckHash:hash,currentNativeRestrictionHash:hash,skeletonPolicy:'native-personal-minimal-v4'}})

describe('retained authority untrusted metadata contract',()=>{
 it('accepts a fixed binding but rejects empty, duplicate or oversized installation rosters',()=>{
  expect(()=>validateRetainedAuthorityBinding(binding())).not.toThrow()
  for(const installationIds of [[],[id,id],Array.from({length:17},(_,i)=>`${i.toString(16).padStart(8,'0')}-1111-4111-8111-111111111111`)]){
   expect(()=>validateRetainedAuthorityBinding({...binding(),installationIds})).toThrow('retained_authority_contract')
  }
 })
 it('never accepts caller-supplied proof booleans or secret-bearing unknown binding fields',()=>{
  for(const extra of [{globalRetainedAuthorityVerified:true},{reopeningReady:true},{activationAuthorized:true},{databaseUrl:'postgres://secret'},{keyring:{key:'secret'}}]){
   expect(()=>validateRetainedAuthorityBinding({...binding(),...extra})).toThrow('retained_authority_contract')
  }
 })
 it('rejects altered binding identity hashes, unsafe numbers and non-data object shapes',()=>{
  for(const change of [{databaseIdentityHash:'a'.repeat(63)},{keyringHash:'A'.repeat(64)},{schemaVersion:'1'},{sourcePolicyHash:1}]){
   expect(()=>validateRetainedAuthorityBinding({...binding(),...change})).toThrow('retained_authority_contract')
  }
  expect(()=>validateRetainedAuthorityBinding({...binding(),installationIds:['AAAAAAAA-1111-4111-8111-111111111111']})).toThrow()
  const accessor={...binding()};Object.defineProperty(accessor,'configHash',{get(){throw Error('getter must not run')},enumerable:true})
  expect(()=>validateRetainedAuthorityBinding(accessor)).toThrow('retained_authority_contract')
  expect(()=>validateRetainedAuthorityBinding({...binding(),[Symbol('secret')]:'hidden'})).toThrow()
 })
 it('streams 4097 members without keeping a whole-inventory array and requires an empty terminal tail',()=>{
  let state=startRetainedAuthorityStream(binding(),stream())
  for(let offset=0;offset<4097;offset+=1024){
   const rows=Array.from({length:Math.min(1024,4097-offset)},(_,i)=>positive(String(offset+i+1)))
   const page=createRetainedAuthorityPage(binding(),stream(),input(rows,state))
   expect(page.globalRetainedAuthorityVerified).toBe(false)
   expect(page.reopeningReady).toBe(false);expect(page.activationAuthorized).toBe(false)
   state=advanceRetainedAuthorityStream(binding(),stream(),state,page)
  }
  expect(state.records).toBe('4097');expect(state.nextOrdinal).toBe('5');expect(state.terminal).toBe(false)
  const tail=createRetainedAuthorityPage(binding(),stream(),input([],state,true))
  state=advanceRetainedAuthorityStream(binding(),stream(),state,tail)
  expect(state.records).toBe('4097');expect(state.nextOrdinal).toBe('6');expect(state.terminal).toBe(true)
  expect(()=>advanceRetainedAuthorityStream(binding(),stream(),state,tail)).toThrow()
 })
 it('rejects gaps, reused prefixes, changed binding and tampered membership/content hashes',()=>{
  const state=startRetainedAuthorityStream(binding(),stream())
  const page=createRetainedAuthorityPage(binding(),stream(),input([positive('1')],state))
  for(const change of [{ordinal:'1'},{previousHash:'b'.repeat(64)},{membershipHash:'b'.repeat(64)},{pageHash:'b'.repeat(64)},{bindingHash:'b'.repeat(64)},{records:[positive('2')]},{globalRetainedAuthorityVerified:true},{reopeningReady:true},{activationAuthorized:true}]){
   expect(()=>advanceRetainedAuthorityStream(binding(),stream(),state,{...page,...change})).toThrow()
  }
  expect(()=>validateRetainedAuthorityPage(page,{...binding(),configHash:'b'.repeat(64)},stream())).toThrow()
  const next=advanceRetainedAuthorityStream(binding(),stream(),state,page)
  const wrong=createRetainedAuthorityPage(binding(),stream(),{...input([positive('2')],next),from:null})
  expect(()=>advanceRetainedAuthorityStream(binding(),stream(),next,wrong)).toThrow()
 })
 it('requires bounded unique exact member identities, genuine empty tails and canonical decimal cursors',()=>{
  for(const rows of [Array.from({length:1025},(_,i)=>positive(String(i+1))),[positive('1'),positive('1')]])expect(()=>createRetainedAuthorityPage(binding(),stream(),input(rows))).toThrow()
  expect(()=>createRetainedAuthorityPage(binding(),stream(),input([]))).toThrow()
  expect(()=>createRetainedAuthorityPage(binding(),stream(),input([positive('1')],undefined,true))).toThrow()
  for(const key of ['01','1e6','-0',9007199254740992,1n]){
   const record=positive('1');Object.assign(record.item,{key:[key]})
   expect(()=>createRetainedAuthorityPage(binding(),stream(),input([record]))).toThrow()
  }
  const large=positive('9007199254740993')
  expect(createRetainedAuthorityPage(binding(),stream(),input([large])).to?.key).toEqual(['9007199254740993'])
  const same=positive('1'),later=positive('1');later.item.occurrence='1'
  expect(()=>createRetainedAuthorityPage(binding(),stream(),input([same,later]))).not.toThrow()
  expect(()=>createRetainedAuthorityPage(binding(),stream(),input([later,same]))).toThrow()
 })
 it('binds each item and every native key to the reviewed stream descriptor',()=>{
  for(const change of [{installationId:'22222222-2222-4222-8222-222222222222'},{table:'work_episodes'},{key:['1','2']},{rowVersion:1},{occurrence:'00'},{metadataFingerprint:'unknown'}]){
   const record={...positive('1'),item:{...item('1'),...change}}
   expect(()=>createRetainedAuthorityPage(binding(),stream(),input([record]))).toThrow()
  }
  expect(()=>startRetainedAuthorityStream(binding(),{...stream(),keyColumns:[{name:'password',type:'text'}]})).toThrow()
  expect(()=>startRetainedAuthorityStream(binding(),{...stream(),family:'anything'})).toThrow()
  expect(()=>startRetainedAuthorityStream(binding(),{...stream(),keyColumns:[{name:'id',type:'decimal'},{name:'id',type:'decimal'}]})).toThrow()
 })
 it('validates settled-negative evidence shape without turning it into a trusted runtime proof',()=>{
  const record=negative(),page=createRetainedAuthorityPage(binding(),stream(),input([record]))
  expect(page.records[0].kind).toBe('settled-negative-v4');expect(page.globalRetainedAuthorityVerified).toBe(false)
  for(const change of [{completedPages:'1'},{totalPages:'0'},{nativeOutputHash:null},{skeletonPolicy:'body-empty'},{manifestHash:'b'.repeat(64)},{trusted:true}]){
   expect(()=>createRetainedAuthorityPage(binding(),stream(),input([{...record,settlement:{...record.settlement,...change}}]))).toThrow()
  }
  for(const change of [{fullPrimaryKey:['2']},{firstIndex:'1024'},{firstPage:record.settlement.totalPages},{table:'work_episodes'}]){
   expect(()=>createRetainedAuthorityPage(binding(),stream(),input([{...record,original:{...record.original,...change}}]))).toThrow()
  }
 })
 it('keeps blockers typed and rejects arbitrary prose, credentials and unknown nested fields',()=>{
  const blocked={kind:'blocked',item:item('1'),code:'owner_lifecycle_adapter_required',relatedIdentityHashes:[hash]}
  expect(createRetainedAuthorityPage(binding(),stream(),input([blocked])).records[0].kind).toBe('blocked')
  for(const change of [{code:'ignore_and_reopen'},{reason:'body'},{relatedIdentityHashes:[hash,hash]},{relatedIdentityHashes:[1]}])expect(()=>createRetainedAuthorityPage(binding(),stream(),input([{...blocked,...change}]))).toThrow()
  for(const record of [{...positive('1'),payload:'body'},{...positive('1'),item:{...item('1'),credentials:'secret'}},{...positive('1'),policy:'raw_a_or_b'},{...negative(),settlement:{...negative().settlement,providerReceipt:{body:'secret'}}}])expect(()=>createRetainedAuthorityPage(binding(),stream(),input([record]))).toThrow()
 })
 it('bounds complete encoded page bytes including composite keys and envelopes',()=>{
  const wide={...stream(),keyColumns:Array.from({length:16},(_,i)=>({name:'key_'+i,type:'text'}))}
  const rows=Array.from({length:1024},(_,i)=>({...positive(String(i+1)),item:{...item('1'),key:Array.from({length:16},()=>String(i).padStart(512,'x'))}}))
  expect(()=>createRetainedAuthorityPage(binding(),wide,input(rows))).toThrow('retained_authority_contract')
 })
 it('rejects array subclasses and sparse arrays instead of invoking their inherited behavior',()=>{
  class Ids extends Array<string>{}
  expect(()=>validateRetainedAuthorityBinding({...binding(),installationIds:new Ids(id)})).toThrow('retained_authority_contract')
  const sparse=new Array(1)
  expect(()=>validateRetainedAuthorityBinding({...binding(),installationIds:sparse})).toThrow('retained_authority_contract')
 })
 it('preserves opaque native text keys and rejects malformed or oversize identifiers without normalization',()=>{
  const descriptor={...stream(),keyColumns:[{name:'session_id',type:'text'}]}
  const opaque='Original:Session/大小写'
  expect(createRetainedAuthorityPage(binding(),descriptor,input([{...positive('1'),item:{...item('1'),key:[opaque]}}])).to?.key).toEqual([opaque])
  for(const key of ['', 'a\u0000b', '\ud800', '界'.repeat(171)]){
   expect(()=>createRetainedAuthorityPage(binding(),descriptor,input([{...positive('1'),item:{...item('1'),key:[key]}}]))).toThrow()
  }
 })
 it('rejects backward native decimal keys and preserves counters above Number precision',()=>{
  expect(()=>createRetainedAuthorityPage(binding(),stream(),input([positive('10'),positive('9')]))).toThrow()
  const start=startRetainedAuthorityStream(binding(),stream())
  const state={...start,nextOrdinal:'9007199254740993',records:'9007199254740993',cursor:{key:['9007199254740993'],occurrence:'0'}}
  const page=createRetainedAuthorityPage(binding(),stream(),input([positive('9007199254740994')],state))
  const next=advanceRetainedAuthorityStream(binding(),stream(),state,page)
  expect(next.nextOrdinal).toBe('9007199254740994');expect(next.records).toBe('9007199254740994')
  for(const key of ['nextOrdinal','records'])expect(()=>advanceRetainedAuthorityStream(binding(),stream(),{...state,[key]:9007199254740992},page)).toThrow()
 })
})
