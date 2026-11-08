import {canonicalJsonString,canonicalPayloadHash} from './canonical-json.js'
import {parseMemorySourceProvenance} from './provenance.js'
import {verifyOriginalSourceHash} from './reference-hash.js'
import {SourceUnavailableError,type SourceScope,type SourceRoot,type SourceVersion,type SourceHead,type SourceStore,type CurrentSourceState} from './reader.js'
import type {SourceSqlPool} from './work.js'
const uuid=(value:string)=>/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
const fail=(code:string):never=>{throw new SourceUnavailableError(code)}
/** Explicit personal historical authority, with the original UUID and the
 * single necessary body kept in place. Missing live sources never use it. */
export class PostgresLegacySourceStore implements SourceStore{
 constructor(private readonly db:SourceSqlPool){}
 private context(scope:SourceScope,root:SourceRoot){if(root.kind!=='legacy_archive'||scope.ownerScopeKind!=='personal')fail('source_kind_unsupported')}
 private async query(sql:string,args:any[]){
  try{return await this.db.query(sql,args)}catch(error){for(const state of ['revoked','deleted','changed'])if((error as Error).message==='source_'+state)fail(state);return fail('source_store_unavailable')}
 }
 async checkCurrent(scope:SourceScope,root:SourceRoot,expected?:SourceVersion){return this.current(scope,root,expected,false)}
 async checkAuthority(scope:SourceScope,root:SourceRoot,expected?:SourceVersion){return this.current(scope,root,expected,true)}
 private async current(scope:SourceScope,root:SourceRoot,expected:SourceVersion|undefined,retained:boolean){
  this.context(scope,root)
  const row=(await this.query(`SELECT * FROM shared.${retained?'memory_retained_relay_authority':'memory_relay_source_authority'}($1::jsonb,'legacy_archive',$2)`,[JSON.stringify(scope),root.key])).rows[0]
  if(!row||!['current','changed','revoked','deleted'].includes(row.state))return fail('source_store_unavailable')
  const version={content:row.content_revision,authorization:row.authorization_revision,storage:row.storage_revision}
  const changed=expected&&(version.content!==expected.content||version.authorization!==expected.authorization||!retained&&version.storage!==expected.storage)
  const state:CurrentSourceState=row.state==='current'&&changed?'changed':row.state
  return {state,version}
 }
 private async rows(scope:SourceScope,root:SourceRoot,after:string|undefined,limit:number,ids:string[]|undefined,body:boolean){
  this.context(scope,root)
  if(after!==undefined&&!uuid(after)||ids?.some(id=>!uuid(id)))fail('source_identity_invalid')
  return (await this.query('SELECT value FROM shared.read_memory_legacy_sources($1::jsonb,$2,$3::uuid,$4,$5::uuid[],$6::boolean) AS value',[JSON.stringify(scope),root.key,after??null,limit,ids??null,body])).rows.map(r=>r.value)
 }
 private head(root:SourceRoot,row:any):SourceHead{
  if(row.adapter_version!=='legacy-archive-v1'||!uuid(row.id)||!/^[a-f0-9]{64}$/.test(row.manifest_hash??''))fail('legacy_archive_binding_invalid')
  if(row.reclaimed)fail('source_body_reclaimed')
  if(row.body_limit)fail('body_byte_limit')
  if(!/^[a-f0-9]{64}$/.test(row.hash??'')||!/^[a-f0-9]{64}$/.test(row.stored_hash??''))fail('hash_mismatch')
  if(row.hash!==row.stored_hash&&(row.origin!=='snapshot'||!/^[1-9][0-9]{0,18}$/.test(row.origin_position??'')||!Number.isFinite(Date.parse(row.occurred_at))))fail('hash_mismatch')
  if(!row.classification||typeof row.classification!=='object'||Array.isArray(row.classification))fail('source_metadata_conflict')
  const proof=parseMemorySourceProvenance(row.provenance?.memory)
  if(proof&&(proof.session_id!==row.session_id||proof.turn_id!==row.turn_id))fail('source_provenance_mismatch')
  if(proof&&row.sequence&&proof.sequence!==row.sequence)fail('source_sequence_conflict')
  const sequence=row.sequence??proof?.sequence
  return {kind:'legacy_archive',canonicalKey:row.id,rootKey:root.key,sessionKey:row.session_id,eventType:row.event_type,
   occurredAt:row.occurred_at,...(row.turn_id?{turnKey:row.turn_id}:{}),
   ...(sequence?{sourceSequence:sequence}:{}),contentHash:row.hash,hashVersion:'canonical-json-sha256-v1',classification:row.classification,
   provenance:proof?{state:'known',memory:proof}:{state:'unknown'},storage:'legacy',locator:{manifestHash:row.manifest_hash,sourceEventId:row.id,adapterVersion:row.adapter_version}}
 }
 async listHeads(scope:SourceScope,root:SourceRoot,after:string|undefined,limit:number){
  const state=await this.checkCurrent(scope,root);if(state.state!=='current')return fail(state.state)
  const rows=await this.rows(scope,root,after,limit,undefined,false)
  return {heads:rows.map(r=>this.head(root,r)),version:state.version,hasMore:rows.length===limit}
 }
 async getHeads(scope:SourceScope,root:SourceRoot,keys:readonly string[]){
  const state=await this.checkCurrent(scope,root);if(state.state!=='current')return fail(state.state)
  const rows=await this.rows(scope,root,undefined,keys.length,[...keys],false)
  return {heads:rows.map(r=>this.head(root,r)),version:state.version}
 }
 async resolveBodies(scope:SourceScope,root:SourceRoot,heads:SourceHead[],_expected:SourceVersion){
  if(!heads.length)return []
  const rows=await this.rows(scope,root,undefined,heads.length,heads.map(h=>h.canonicalKey),true),byId=new Map(rows.map(r=>[r.id,r]))
  return heads.map(expected=>{
   const row=byId.get(expected.canonicalKey);if(!row)return fail('body_set_mismatch')
   const head=this.head(root,row)
   if(canonicalJsonString(head)!==canonicalJsonString(expected))return fail('changed')
   if(!row.payload||typeof row.payload!=='object'||Array.isArray(row.payload)||canonicalPayloadHash(row.payload).toString('hex')!==head.contentHash)return fail('hash_mismatch')
   if(!verifyOriginalSourceHash({origin:row.origin,originPosition:row.origin_position,eventType:row.event_type,occurredAt:row.occurred_at,payload:row.payload,payloadHash:row.stored_hash}))return fail('hash_mismatch')
   return {head,payload:row.payload}
  })
 }
}
