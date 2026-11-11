import {canonicalJsonString,canonicalPayloadHash} from './canonical-json.js'
export type SourceKind='relay_event'|'team_collaboration'|'team_delivery'|'legacy_archive'
export interface SourceRoot {kind:SourceKind;key:string}
export interface SourceScope {
 installationId:string;principalUserId:string;ownerScopeKind:'personal'|'team'|'organization';ownerScopeId:string
 authorizationRevision:string;configVersion:string;modeGeneration?:string;participantRevision?:string;bindingRevision?:string
}
export interface SourceVersion {content:string;authorization:string;storage:string}
export type CurrentSourceState='current'|'changed'|'revoked'|'deleted'
export interface SourceHead {
 kind:SourceKind;canonicalKey:string;rootKey:string;sessionKey:string;eventType:string;sourceSequence?:string
 /** Native authoritative timestamp; keep sub-millisecond precision verbatim.
  * Older adapters may omit it; a new reference producer must require it. */
 currentSessionKey?:string
 occurredAt?:string
 /** Canonical adapter turn identity, when available without inventing one. */
 turnKey?:string
 contentHash:string;hashVersion:'canonical-json-sha256-v1';classification:Record<string,unknown>;provenance:Record<string,unknown>
 storage:'hot'|'cold'|'team'|'legacy';locator?:Record<string,unknown>
}
export interface ResolvedSourceBody {head:SourceHead;payload:unknown}
export interface SourceStore {
 /** Each call owns only its short SQL observation. Body IO never borrows a
  * caller's transaction/lock. checkCurrent is always authoritative, not cached. */
 checkAuthority?(scope:SourceScope,root:SourceRoot,expected?:SourceVersion):Promise<{state:CurrentSourceState;version:SourceVersion}>
 checkCurrent(scope:SourceScope,root:SourceRoot,expected?:SourceVersion):Promise<{state:CurrentSourceState;version:SourceVersion}>
 getHeads?(scope:SourceScope,root:SourceRoot,keys:readonly string[]):Promise<{heads:SourceHead[];version:SourceVersion}>
 listHeads(scope:SourceScope,root:SourceRoot,after:string|undefined,limit:number):Promise<{heads:SourceHead[];version:SourceVersion;hasMore:boolean}>
 resolveBodies(scope:SourceScope,root:SourceRoot,heads:SourceHead[],expected:SourceVersion):Promise<ResolvedSourceBody[]>
}
export class SourceUnavailableError extends Error {
 constructor(readonly code:string){super('shared_source_unavailable:'+code);this.name='SourceUnavailableError'}
}
const unavailable=(code:string):never=>{throw new SourceUnavailableError(code)}
const decimal=(v:unknown):v is string=>typeof v==='string' && /^(0|[1-9][0-9]*)$/.test(v) && BigInt(v)<=9223372036854775807n
const validVersion=(v:SourceVersion)=>v && [v.content,v.authorization,v.storage].every(decimal)
const sameVersion=(a:SourceVersion,b:SourceVersion)=>a.content===b.content && a.authorization===b.authorization && a.storage===b.storage
const scopeKey=(scope:SourceScope,root:SourceRoot)=>canonicalPayloadHash({scope,root}).toString('hex')
function validateScope(scope:SourceScope,root:SourceRoot){
  if(!scope.installationId || !/^[1-9][0-9]*$/.test(scope.principalUserId) || !scope.ownerScopeId || !['personal','team','organization'].includes(scope.ownerScopeKind)
   || !decimal(scope.authorizationRevision) || !decimal(scope.configVersion) || !['relay_event','team_collaboration','team_delivery','legacy_archive'].includes(root.kind) || !root.key || root.key.length>1024)unavailable('source_scope_mismatch')
 }
function validateHeads(root:SourceRoot,heads:SourceHead[]){
  if(heads.length>256)unavailable('page_limit')
  const seen=new Set<string>()
  for(const head of heads){
   if(head.rootKey!==root.key || head.kind!==root.kind || !head.canonicalKey || !head.sessionKey || !head.eventType)unavailable('source_scope_mismatch')
   if(head.hashVersion!=='canonical-json-sha256-v1' || !/^[a-f0-9]{64}$/.test(head.contentHash))unavailable('body_hash_unavailable')
   if(head.sourceSequence!==undefined && !decimal(head.sourceSequence))unavailable('source_sequence_invalid')
   if(head.occurredAt!==undefined&&(typeof head.occurredAt!=='string'||!Number.isFinite(Date.parse(head.occurredAt))))unavailable('source_timestamp_invalid')
   if(head.turnKey!==undefined&&(typeof head.turnKey!=='string'||!head.turnKey||head.turnKey.length>1024))unavailable('source_turn_invalid')
   const identity=head.kind+':'+head.canonicalKey
   if(seen.has(identity))unavailable('duplicate_source_identity');seen.add(identity)
  }
 }
function validateBodies(heads:SourceHead[],bodies:ResolvedSourceBody[]):ResolvedSourceBody[]{
 if(bodies.length!==heads.length)unavailable('body_set_mismatch')
  let totalBytes=0
  for(let i=0;i<heads.length;i++){
   const body=bodies[i],head=heads[i]
   if(!body || canonicalJsonString(body.head)!==canonicalJsonString(head))unavailable('body_set_mismatch')
   if(body.payload===undefined || body.payload===null)unavailable('body_unavailable')
   const serialized=canonicalJsonString(body.payload)
   totalBytes+=Buffer.byteLength(serialized)
   if(totalBytes>32*1024*1024)unavailable('body_byte_limit')
   if(canonicalPayloadHash(body.payload).toString('hex')!==head.contentHash)unavailable('body_hash_mismatch')
  }
 return structuredClone(bodies)
}
/** Shared first-party source algorithm. Database adapters remain responsible
 * for trusted current membership/owner joins, never for trusting caller GUCs. */
export class SharedSourceReader {
 constructor(private readonly store:SourceStore){}
 private validate(scope:SourceScope,root:SourceRoot){validateScope(scope,root)}
 private async current(scope:SourceScope,root:SourceRoot,expected?:SourceVersion){
  const current=await this.store.checkCurrent(scope,root,expected)
  if(current.state!=='current')unavailable(current.state)
  if(!validVersion(current.version) || expected && (!validVersion(expected)||!sameVersion(current.version,expected)))unavailable('changed')
  return current.version
 }
 private heads(root:SourceRoot,heads:SourceHead[]){validateHeads(root,heads)}
 async checkCurrent(scope:SourceScope,root:SourceRoot,expected?:SourceVersion){
  this.validate(scope,root)
  if(expected!==undefined&&!validVersion(expected))unavailable('source_version_invalid')
  const result=await this.store.checkCurrent(scope,root,expected)
  if(!validVersion(result.version))unavailable('source_version_invalid')
  return result.state==='current' && expected!==undefined&&!sameVersion(result.version,expected)?{...result,state:'changed' as const}:result
 }
 /** For already-retained evidence only. Does not grant raw body access. */
 async checkAuthority(scope:SourceScope,root:SourceRoot,expected?:SourceVersion){
  this.validate(scope,root)
  const fn=this.store.checkAuthority??this.store.checkCurrent
  const result=await fn.call(this.store,scope,root,expected)
  if(!validVersion(result.version))unavailable('source_version_invalid')
  // Retained evidence has an independent body lifecycle. Storage-only
  // transitions (including raw retention receipts) do not revoke it.
  return result.state==='current'&&expected&&(result.version.content!==expected.content||result.version.authorization!==expected.authorization)?{...result,state:'changed' as const}:result
 }
 async listHeads(scope:SourceScope,root:SourceRoot,options:{cursor?:string;limit?:number}={}){
  this.validate(scope,root)
  const limit=options.limit??256
  if(!Number.isSafeInteger(limit)||limit<1||limit>256)unavailable('page_limit')
  let after:string|undefined,expected:SourceVersion|undefined
  if(options.cursor){
   if(options.cursor.length>8192)unavailable('cursor_scope_mismatch')
   let cursor:any
   try{cursor=JSON.parse(Buffer.from(options.cursor,'base64url').toString('utf8'))}catch{unavailable('cursor_scope_mismatch')}
   if(cursor.v!==1 || cursor.scope!==scopeKey(scope,root) || typeof cursor.after!=='string' || !validVersion(cursor.version))unavailable('cursor_scope_mismatch')
   after=cursor.after;expected=cursor.version
  }
  const before=await this.current(scope,root,expected)
  const page=await this.store.listHeads(scope,root,after,limit)
  if(!sameVersion(before,page.version) || page.heads.length>limit || page.hasMore && page.heads.length===0)unavailable('changed')
  this.heads(root,page.heads)
  await this.current(scope,root,page.version)
  return {heads:structuredClone(page.heads),version:{...page.version},nextCursor:page.hasMore?Buffer.from(canonicalJsonString({v:1,scope:scopeKey(scope,root),after:page.heads.at(-1)!.canonicalKey,version:page.version})).toString('base64url'):null}
 }
 async getHeads(scope:SourceScope,root:SourceRoot,keys:readonly string[]){
  this.validate(scope,root)
  if(!keys.length||keys.length>256)unavailable('page_limit')
  if(keys.some(k=>typeof k!=='string'||!k||k.length>1024))unavailable('source_identity_invalid')
  if(new Set(keys).size!==keys.length)unavailable('duplicate_source_identity')
  const getHeads=this.store.getHeads
  if(!getHeads)return unavailable('reference_lookup_unsupported')
  const before=await this.current(scope,root)
  const page=await getHeads.call(this.store,scope,root,[...keys])
  if(!validVersion(page.version)||!sameVersion(before,page.version))unavailable('changed')
  this.heads(root,page.heads)
  const indexed=new Map(page.heads.map(h=>[h.canonicalKey,h]))
  if(page.heads.length!==keys.length||keys.some(k=>!indexed.has(k)))unavailable('body_set_mismatch')
  await this.current(scope,root,page.version)
  return {heads:keys.map(k=>structuredClone(indexed.get(k)!)),version:{...page.version}}
 }
 async resolveBodies(scope:SourceScope,root:SourceRoot,heads:SourceHead[],expected:SourceVersion):Promise<ResolvedSourceBody[]>{
  this.validate(scope,root);this.heads(root,heads)
  if(!validVersion(expected))unavailable('source_version_invalid')
  await this.current(scope,root,expected)
  const bodies=await this.store.resolveBodies(scope,root,structuredClone(heads),expected)
  const verified=validateBodies(heads,bodies)
  await this.current(scope,root,expected)
  return verified
 }
}

/** A separate capability for internal personal metadata work. It never changes
 * the ordinary reader's exact whole-root vector contract. The store owns the
 * fixed native/ref/cold observations; neither a DTO nor an old vector is a view. */
export interface PersonalMetadataView {
 readonly token:object;readonly heads:readonly SourceHead[];readonly observedVersion:SourceVersion
 readonly upperId:string;readonly nextAfter?:string;readonly exhausted:boolean
}
export interface PersonalMetadataStore {
 select(scope:SourceScope,root:SourceRoot,request:{keys?:readonly string[];after?:string;through?:string;limit:number}):Promise<PersonalMetadataView>
 resolve(token:object):Promise<ResolvedSourceBody[]>
 assert(token:object):Promise<void>
 proof(token:object):unknown
}
export class PersonalMetadataSourceReader {
 private readonly views=new WeakMap<object,{inner:object;heads:SourceHead[]}>()
 constructor(private readonly store:PersonalMetadataStore){}
 private async select(scope:SourceScope,root:SourceRoot,request:{keys?:readonly string[];after?:string;through?:string;limit:number}):Promise<PersonalMetadataView>{
  validateScope(scope,root)
  if(root.kind!=='relay_event'||scope.ownerScopeKind!=='personal')unavailable('source_scope_mismatch')
  if(!Number.isSafeInteger(request.limit)||request.limit<1||request.limit>256)unavailable('page_limit')
  if(request.keys&&(!request.keys.length||request.keys.length>256||new Set(request.keys).size!==request.keys.length||request.keys.some(k=>!decimal(k)||k==='0')))unavailable('source_identity_invalid')
  if(request.after!==undefined&&!decimal(request.after)||request.through!==undefined&&!decimal(request.through))unavailable('cursor_scope_mismatch')
  const inner=await this.store.select(structuredClone(scope),structuredClone(root),structuredClone(request))
  if(!validVersion(inner.observedVersion)||!decimal(inner.upperId))unavailable('source_version_invalid')
  const heads=structuredClone([...inner.heads]);validateHeads(root,heads)
  if(heads.length>request.limit)unavailable('page_limit')
  if(request.keys&&(heads.length!==request.keys.length||request.keys.some(k=>!heads.some(h=>h.canonicalKey===k))))unavailable('body_set_mismatch')
  const token=Object.freeze({});this.views.set(token,{inner:inner.token,heads})
  return Object.freeze({token,heads:structuredClone(heads),observedVersion:{...inner.observedVersion},upperId:inner.upperId,
   ...(inner.nextAfter?{nextAfter:inner.nextAfter}:{}),exhausted:inner.exhausted})
 }
 selectPage(scope:SourceScope,root:SourceRoot,request:{after?:string;through?:string;limit?:number}={}){return this.select(scope,root,{...request,limit:request.limit??64})}
 selectKeys(scope:SourceScope,root:SourceRoot,keys:readonly string[]){return this.select(scope,root,{keys,limit:keys.length})}
 private state(view:PersonalMetadataView){const state=this.views.get(view.token);if(!state)throw new SourceUnavailableError('source_selection_invalid');return state}
 async resolve(view:PersonalMetadataView):Promise<ResolvedSourceBody[]>{
  const state=this.state(view);await this.store.assert(state.inner)
  const bodies=await this.store.resolve(state.inner)
  const verified=validateBodies(state.heads,bodies);await this.store.assert(state.inner);return verified
 }
 assertSelection(view:PersonalMetadataView){return this.store.assert(this.state(view).inner)}
 proof(view:PersonalMetadataView):unknown{return structuredClone(this.store.proof(this.state(view).inner))}
}
