import {PostgresLegacySourceStore} from './legacy-store.js'
import {SharedSourceReader,SourceUnavailableError,type SourceStore,type SourceScope,type SourceRoot,type SourceVersion,type SourceHead,type CurrentSourceState} from './reader.js'
import type {SourceSqlPool} from './work.js'
import {canonicalPayloadHash} from './canonical-json.js'
import {parseMemorySourceProvenance} from './provenance.js'
import {SessionHistoryBodyReader} from './history-body-reader.js'
import type {ArchiveReadStorage} from './archive/storage.js'
import type {ArchiveLimits,ArchiveChunkManifest} from './archive/manifest.js'
import {PostgresTeamSourceStore} from './team-store.js'
const identifier=(v:unknown)=>typeof v==='string' && /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v)<=9223372036854775807n
/** Uses only reviewed controlled functions. It does not acquire a transaction
 * client; every SQL statement completes before archive IO starts. */
export class PostgresRelaySourceStore implements SourceStore {
 private history?:{key:string;reader:SessionHistoryBodyReader}
 constructor(private db:SourceSqlPool,private archive?:{storage:ArchiveReadStorage;limits:ArchiveLimits}){}
 private context(scope:SourceScope,root:SourceRoot){
  if(root.kind!=='relay_event')throw new SourceUnavailableError('source_kind_unsupported')
  if(!identifier(scope.modeGeneration))throw new SourceUnavailableError('source_mode_generation_required')
 }
 private async query(sql:string,args:any[]){
  try{return await this.db.query(sql,args)}catch(error){
   const message=(error as Error).message
   for(const state of ['revoked','deleted','changed'])if(message==='source_'+state)throw new SourceUnavailableError(state)
   throw new SourceUnavailableError('source_store_unavailable')
  }
 }
 async checkAuthority(scope:SourceScope,root:SourceRoot,expected?:SourceVersion){return this.currentState(scope,root,expected,true)}
 async checkCurrent(scope:SourceScope,root:SourceRoot,expected?:SourceVersion){return this.currentState(scope,root,expected,false)}
 private async currentState(scope:SourceScope,root:SourceRoot,expected:SourceVersion|undefined,retained:boolean){
  this.context(scope,root)
  const rows=(await this.query(`SELECT * FROM shared.${retained?'memory_retained_relay_authority':'memory_relay_source_authority'}($1::jsonb,$2,$3)`,[JSON.stringify(scope),root.kind,root.key])).rows
  if(rows.length!==1)throw new SourceUnavailableError('source_store_unavailable')
  const row=rows[0],version={content:row.content_revision,authorization:row.authorization_revision,storage:row.storage_revision}
  const changed=expected&&(version.content!==expected.content||version.authorization!==expected.authorization||!retained&&version.storage!==expected.storage)
  const state:CurrentSourceState=row.state==='current' && changed?'changed':row.state
  if(!['current','changed','revoked','deleted'].includes(state))throw new SourceUnavailableError('source_store_unavailable')
  return {state,version}
 }
 private async rows(scope:SourceScope,root:SourceRoot,after:string|undefined,limit:number,ids?:string[]){
  this.context(scope,root)
  if(after!==undefined && !identifier(after) || ids?.some(id=>!identifier(id)))throw new SourceUnavailableError('source_identity_invalid')
  return (await this.query('SELECT value FROM shared.read_memory_relay_sources($1::jsonb,$2,$3::bigint,$4,$5::bigint[]) AS value',[JSON.stringify(scope),root.key,after??null,limit,ids??null])).rows.map(r=>r.value)
 }
 private head(root:SourceRoot,row:any):SourceHead {
  if(row.body_storage==='cold'&&(!row.body_session_id||!row.manifest_id||!identifier(String(row.id))
    ||!Number.isSafeInteger(Number(row.ordinal))||Number(row.ordinal)<0||typeof row.activity_epoch!=='string'||!/^[0-9]+$/.test(row.activity_epoch)))throw new SourceUnavailableError('archive_binding_invalid')
  if(row.source_header_version!=null&&String(row.source_header_version)!=='1')throw new SourceUnavailableError('source_header_version_unsupported')
  if(row.header_ref_conflict)throw new SourceUnavailableError('source_metadata_conflict')
  if(row.body_limit)throw new SourceUnavailableError('body_byte_limit')
  if(row.retention_denied)throw new SourceUnavailableError('source_body_reclaimed')
  const proof=parseMemorySourceProvenance(row.provenance?.memory)
  const sequences=[row.canonical_sequence,row.ref_sequence,...(row.journal_sequences??[]),...(proof?[proof.sequence]:[])].filter(v=>v!==null && v!==undefined)
  if(sequences.some(v=>!identifier(v)) || new Set(sequences).size>1)throw new SourceUnavailableError('source_sequence_conflict')
  const contentHash=row.canonical_hash??(row.payload===null?undefined:canonicalPayloadHash(row.payload).toString('hex'))
  if(typeof contentHash!=='string' || !/^[a-f0-9]{64}$/.test(contentHash))throw new SourceUnavailableError('body_hash_unavailable')
  const classification:Record<string,unknown>=row.classification??{}
  if(!row.classification && row.payload)for(const key of ['actor_scope','flow_scope','content_class','classifier_version'])if(typeof row.payload[key]==='string')classification[key]=row.payload[key]
  const known=proof && proof.session_id===row.session_id && proof.turn_id===(row.ref_turn_id??row.payload?.turn_id??row.payload?.source_turn_id)
  return {kind:'relay_event',canonicalKey:row.id,rootKey:root.key,sessionKey:row.session_id,currentSessionKey:row.current_session_id??row.session_id,eventType:row.event_type,
   ...(row.occurred_at!=null?{occurredAt:row.occurred_at}:{}),
   ...(sequences[0]?{sourceSequence:sequences[0]}:{}),contentHash,hashVersion:'canonical-json-sha256-v1',classification,
   provenance:known?{state:'known',memory:proof}:{state:'unknown'},storage:row.body_storage==='cold'?'cold':'hot',
   ...(row.body_storage==='cold'?{locator:{manifestId:row.manifest_id,ordinal:row.ordinal,activityEpoch:row.activity_epoch,bodySessionId:row.body_session_id}}:{})}
 }
 private historyReader(scope:SourceScope,root:SourceRoot,expected:SourceVersion){
  if(!this.archive?.storage.namespace)throw new SourceUnavailableError('archive_unconfigured')
  const key=canonicalPayloadHash({scope,root,expected}).toString('hex')
  if(this.history?.key===key)return this.history.reader
  // Each retained cache belongs to one immutable scope/version, capped at16MiB.
  const boundScope=structuredClone(scope),boundRoot=structuredClone(root),boundVersion={...expected},storage=this.archive.storage
  const reader=new SessionHistoryBodyReader({storage,limits:this.archive.limits,cacheBytes:16*1024*1024,cacheTtlMs:30000,
   pageLimits:{maxChunks:32,maxRawBytes:64*1024*1024,maxCompressedBytes:32*1024*1024},
   authorize:async()=>{const current=await this.checkCurrent(boundScope,boundRoot,boundVersion);return current.state==='current'},
   loadManifest:async(_userId,_sessionId,manifestId,ordinal)=>{
    const row=(await this.query('SELECT shared.read_memory_relay_archive($1::jsonb,$2,$3::uuid,$4) AS manifest',[JSON.stringify(boundScope),boundRoot.key,manifestId,ordinal])).rows[0]?.manifest
    if(!row)return null
    if(row.storage_namespace!==storage.namespace)throw new SourceUnavailableError('archive_namespace_mismatch')
    const manifest:ArchiveChunkManifest={userId:row.user_id,sessionId:row.session_id,activityEpoch:row.activity_epoch,manifestId:row.manifest_id,
     ordinal:row.ordinal,schemaVersion:row.schema_version,codec:row.codec,firstEventId:row.first_event_id,lastEventId:row.last_event_id,
     eventCount:row.event_count,rawBytes:Number(row.raw_bytes),compressedBytes:Number(row.compressed_bytes),rawSha256:row.raw_sha256,compressedSha256:row.compressed_sha256}
    return {manifest,key:row.object_key,state:row.state}
   }})
  this.history={key,reader};return reader
 }
 private async hydrateCold(scope:SourceScope,root:SourceRoot,rows:any[],expected:SourceVersion){
  const cold=rows.filter(r=>r.body_storage==='cold')
  if(!cold.length)return
  if(cold.some(r=>String(r.body_owner_user_id)!==scope.principalUserId))throw new SourceUnavailableError('archive_binding_invalid')
  try{
   const result=await this.historyReader(scope,root,expected).hydrate({userId:Number(scope.principalUserId),sessionId:cold[0].current_session_id??cold[0].session_id,
    rows:cold.map(row=>({id:row.id,sessionId:row.current_session_id??row.session_id,eventType:row.event_type,bodyStorage:'cold' as const,payload:null as unknown,
     manifestId:row.manifest_id,chunkOrdinal:Number(row.ordinal),activityEpoch:row.activity_epoch,bodySessionId:row.body_session_id}))})
   for(let i=0;i<cold.length;i++)cold[i].payload=result[i].payload
  }catch(error){
   const current=await this.checkCurrent(scope,root,expected)
   if(current.state!=='current')throw new SourceUnavailableError(current.state)
   if(error instanceof SourceUnavailableError)throw error
   if((error as Error).message==='history page archive limit exceeded')throw new SourceUnavailableError('archive_io_limit')
   throw new SourceUnavailableError('archive_unavailable')
  }
 }
 async listHeads(scope:SourceScope,root:SourceRoot,after:string|undefined,limit:number){
  const current=await this.checkCurrent(scope,root)
  if(current.state!=='current')throw new SourceUnavailableError(current.state)
  const rows=await this.rows(scope,root,after,limit)
  // Existing cold events may have neither a canonical hash nor a ref's frozen
  // classification. Resolve only those headers from verified archive bytes.
  if(rows.some(row=>row.retention_denied))throw new SourceUnavailableError('source_body_reclaimed')
  await this.hydrateCold(scope,root,rows.filter(r=>r.body_storage==='cold'&&(r.canonical_hash==null||r.classification==null)),current.version)
  return {heads:rows.map(row=>this.head(root,row)),version:current.version,hasMore:rows.length===limit}
 }
 async getHeads(scope:SourceScope,root:SourceRoot,keys:readonly string[]){
  const current=await this.checkCurrent(scope,root)
  if(current.state!=='current')throw new SourceUnavailableError(current.state)
  const rows=await this.rows(scope,root,undefined,keys.length,[...keys])
  if(rows.some(row=>row.retention_denied))throw new SourceUnavailableError('source_body_reclaimed')
  await this.hydrateCold(scope,root,rows.filter(r=>r.body_storage==='cold'&&(r.canonical_hash==null||r.classification==null)),current.version)
  return {heads:rows.map(row=>this.head(root,row)),version:current.version}
 }
 async resolveBodies(scope:SourceScope,root:SourceRoot,heads:SourceHead[],expected:SourceVersion){
  const rows=await this.rows(scope,root,undefined,Math.max(1,heads.length),heads.map(h=>h.canonicalKey))
  if(rows.length!==heads.length)throw new SourceUnavailableError('body_set_mismatch')
  if(rows.some(row=>row.retention_denied))throw new SourceUnavailableError('source_body_reclaimed')
  await this.hydrateCold(scope,root,rows,expected)
  const byId=new Map<string,any>(rows.map(r=>[r.id,r]))
  return heads.map(h=>{const row=byId.get(h.canonicalKey),head=this.head(root,row)
   const proof=head.provenance.memory as {turn_id?:string}|undefined
   if(proof&&proof.turn_id!==(row.payload?.turn_id??row.payload?.source_turn_id))throw new SourceUnavailableError('source_provenance_mismatch')
   return {head,payload:row.payload}
  })
 }
}
export const createPostgresSharedSourceReader=(db:SourceSqlPool,archive?:{storage:ArchiveReadStorage;limits:ArchiveLimits})=>{
 const personal=new PostgresRelaySourceStore(db,archive),team=new PostgresTeamSourceStore(db),legacy=new PostgresLegacySourceStore(db)
 const store=(root:SourceRoot)=>root.kind==='relay_event'?personal:root.kind==='legacy_archive'?legacy:team
 return new SharedSourceReader({checkCurrent:(s,r,v)=>store(r).checkCurrent(s,r,v),checkAuthority:(s,r,v)=>r.kind==='relay_event'?personal.checkAuthority(s,r,v):r.kind==='legacy_archive'?legacy.checkAuthority(s,r,v):team.checkAuthority(s,r,v),getHeads:(s,r,k)=>store(r).getHeads(s,r,k),listHeads:(s,r,a,l)=>store(r).listHeads(s,r,a,l),resolveBodies:(s,r,h,v)=>store(r).resolveBodies(s,r,h,v)})
}
