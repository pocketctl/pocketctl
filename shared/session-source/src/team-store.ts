import {teamReaderProjectionKey} from './team/projection-key.js'
import {canonicalJsonString,canonicalPayloadHash} from './canonical-json.js'
import {SourceUnavailableError,type SourceStore,type SourceScope,type SourceRoot,type SourceVersion,type SourceHead,type CurrentSourceState} from './reader.js'
import type {SourceSqlPool} from './work.js'
import {buildTeamMemorySourceRecords,teamSourceSessionId,legacyTeamSourceSessionId,type TeamMemorySourceRecord} from './team/collaboration.js'
import {buildAcceptedDeliveryMemorySourceRecords} from './team/delivery.js'
import {adaptTeamSource} from './team/adapter.js'
function fail(code:string):never{throw new SourceUnavailableError(code)}
function integer(value:unknown,minimum=1){if(typeof value!=='number'&&(typeof value!=='string'||! /^(0|[1-9][0-9]{0,18})$/.test(value)))fail('source_version_out_of_range');const n=Number(value);if(!Number.isSafeInteger(n)||n<minimum)fail('source_version_out_of_range');return n}
const date=(value:unknown)=>{const d=new Date(String(value));if(!Number.isFinite(d.getTime()))fail('source_timestamp_invalid');return d}
/** Builds exactly the existing normalized Team source format from current,
 * controlled Relay facts. No native transcript/Feed/outbox body is consulted. */
export class PostgresTeamSourceStore implements SourceStore {
 constructor(private readonly db:SourceSqlPool){}
 private context(scope:SourceScope,root:SourceRoot){
  if(!['team_collaboration','team_delivery'].includes(root.kind))fail('source_kind_unsupported')
  for(const key of ['modeGeneration','bindingRevision','participantRevision'] as const)if(!/^[1-9][0-9]{0,18}$/.test(scope[key]??'')||BigInt(scope[key]!)>9223372036854775807n)fail('source_scope_version_required')
 }
 private async query(sql:string,args:any[]){
  try{return await this.db.query(sql,args)}catch(error){
   for(const code of ['changed','deleted','revoked'])if((error as Error).message==='source_'+code)fail(code)
   return fail('source_store_unavailable')
  }
 }
 private async localAvailable(scope:SourceScope,sessionKey:string,turnId?:string,retained=false){
  const row=(await this.query(`SELECT NOT EXISTS(SELECT 1 FROM memory.memory_session_tombstones WHERE installation_id=$1 AND session_id=$2)
   AND ($4::boolean OR NOT EXISTS(SELECT 1 FROM memory.memory_source_retention_receipts WHERE installation_id=$1 AND session_id=$2 AND ($3::text IS NULL OR turn_id=$3))) AS allowed`,[scope.installationId,sessionKey,turnId??null,retained])).rows[0]
  if(row?.allowed!==true)fail('source_body_reclaimed')
 }
 async checkCurrent(scope:SourceScope,root:SourceRoot,expected?:SourceVersion){return this.currentState(scope,root,expected,false)}
 async checkAuthority(scope:SourceScope,root:SourceRoot,expected?:SourceVersion){return this.currentState(scope,root,expected,true)}
 private async currentState(scope:SourceScope,root:SourceRoot,expected:SourceVersion|undefined,retained:boolean){
  this.context(scope,root)
  const row=(await this.query('SELECT * FROM shared.memory_team_source_authority($1::jsonb,$2,$3)',[JSON.stringify(scope),root.kind,root.key])).rows[0]
  if(!row||!['current','changed','revoked','deleted'].includes(row.state))return fail('source_store_unavailable')
  const version={content:row.content_revision,authorization:row.authorization_revision,storage:row.storage_revision}
  let state:CurrentSourceState=row.state
  if(state==='current'){
   const ctx=row.context
   const sessionKey=root.kind==='team_delivery'?root.key:teamSourceSessionId({teamSessionId:ctx.teamSessionId,bindingId:ctx.bindingId,bindingRevision:integer(ctx.bindingRevision),participantRevision:integer(ctx.participantRevision)})
   const turnId=root.kind==='team_collaboration'?'team-call:'+ctx.callId:ctx.turnId
   if(typeof turnId!=='string'||!turnId)fail('source_identity_mismatch')
   await this.localAvailable(scope,sessionKey,turnId,retained)
   if(root.kind==='team_collaboration')await this.localAvailable(scope,legacyTeamSourceSessionId({teamSessionId:ctx.teamSessionId,bindingRevision:integer(ctx.bindingRevision),participantRevision:integer(ctx.participantRevision)}),turnId,retained)
   if(expected&&(version.content!==expected.content||version.authorization!==expected.authorization||!retained&&version.storage!==expected.storage))state='changed'
  }
  return {state,version}
 }
 private async records(scope:SourceScope,root:SourceRoot){
  this.context(scope,root)
  const value=(await this.query('SELECT shared.read_memory_team_source($1::jsonb,$2,$3) AS source',[JSON.stringify(scope),root.kind,root.key])).rows[0]?.source
  if(!value?.context)fail('source_body_unavailable')
  if(Buffer.byteLength(canonicalJsonString(value))>32*1024*1024)fail('body_byte_limit')
  const ctx=value.context
  if(ctx.bindingRevision!==scope.bindingRevision||ctx.participantRevision!==scope.participantRevision)fail('changed')
  const binding={id:ctx.bindingId,revision:integer(ctx.bindingRevision),installationId:ctx.targetInstallationId,ownerScopeKind:ctx.targetOwnerScopeKind,ownerScopeId:ctx.targetOwnerScopeId}
  const readers=[{userId:integer(scope.principalUserId),participantRevision:integer(ctx.participantRevision)}]
  let records:TeamMemorySourceRecord[];const sequences=new Map<string,string>()
  try{
   if(root.kind==='team_delivery'){
    records=buildAcceptedDeliveryMemorySourceRecords({teamId:ctx.teamId,teamSessionId:ctx.teamSessionId,callId:ctx.callId,taskId:value.taskId,contextVersion:integer(ctx.contextVersion,0),binding,readers,
     spec:{...value.spec,revision:integer(value.spec.revision),createdAt:date(value.spec.createdAt)},
     submission:{...value.submission,version:integer(value.submission.version),publishedAt:date(value.submission.publishedAt)},
     decision:{...value.decision,createdAt:date(value.decision.createdAt)}})
    if(records.some(r=>r.sessionId!==root.key))fail('source_identity_mismatch')
   }else{
    const g=value.goal,o=value.outcome
    if(!Array.isArray(value.replies))fail('source_lineage_unavailable')
    const replies:Record<string,any>[]=value.replies
    if(ctx.callId!==root.key||!g||!o||!Array.isArray(replies)||replies.length<1||replies.length>512)fail('source_lineage_unavailable')
    const all=[g,...replies,o]
    if(all.some(e=>typeof e.content!=='string')||replies.some(e=>e.author_offer_id!==ctx.offerId))fail('source_lineage_unavailable')
    const seqs=all.map(e=>integer(e.event_seq))
    if(new Set(all.map(e=>e.event_id)).size!==all.length||seqs.some((n,i)=>i>0&&n<=seqs[i-1]))fail('source_lineage_invalid')
    const last=replies.at(-1)!
    records=buildTeamMemorySourceRecords({teamId:ctx.teamId,teamSessionId:ctx.teamSessionId,callId:ctx.callId,contextVersion:integer(ctx.contextVersion,0),binding,readers,
     goal:{eventId:g.event_id,eventSeq:integer(g.event_seq),content:g.content,authorUserId:integer(g.author_user_id),occurredAt:date(g.created_at)},
     reply:{eventIds:replies.map(e=>e.event_id),eventSeqs:replies.map(e=>integer(e.event_seq)),content:replies.map(e=>e.content).join(''),authorOfferId:last.author_offer_id,occurredAt:date(last.created_at)},
     outcome:{eventId:o.event_id,eventSeq:integer(o.event_seq),status:o.content,occurredAt:date(o.created_at)}})
    for(const r of records)sequences.set(r.sourceId,String(r.payload.source_role==='goal'?g.event_seq:r.payload.source_role==='reply'?last.event_seq:o.event_seq))
   }
  }catch(error){if(error instanceof SourceUnavailableError)throw error;return fail('source_canonical_record_unavailable')}
  let bytes=0
  const output=[]
  for(const r of records){
   let adapted
   try{adapted=adaptTeamSource({source_kind:r.sourceKind,source_id:r.sourceId,session_id:r.sessionId,turn_id:String(r.payload.turn_id),event_type:r.eventType,recorded_at:r.occurredAt,classification:{},data:r.payload})}catch{return fail('source_canonical_record_unavailable')}
   if(!adapted)fail('source_canonical_record_unavailable')
   await this.localAvailable(scope,adapted.sessionId,adapted.turnId)
   bytes+=Buffer.byteLength(canonicalJsonString(adapted.payload));if(bytes>32*1024*1024)fail('body_byte_limit')
   const head:SourceHead={kind:root.kind,canonicalKey:r.sourceId,rootKey:root.key,sessionKey:adapted.sessionId,eventType:adapted.eventType,
    occurredAt:r.occurredAt.toISOString(),turnKey:adapted.turnId,
    contentHash:canonicalPayloadHash(adapted.payload).toString('hex'),hashVersion:'canonical-json-sha256-v1',classification:adapted.classification,
    provenance:{state:'known',team:adapted.provenance},storage:'team',locator:{teamWireKey:r.sourceId,teamProjectionKey:teamReaderProjectionKey(r.sourceId,adapted.provenance)},...(sequences.has(r.sourceId)?{sourceSequence:sequences.get(r.sourceId)!}:{})}
   output.push({head,payload:adapted.payload})
  }
  return output.sort((a,b)=>a.head.canonicalKey<b.head.canonicalKey?-1:a.head.canonicalKey>b.head.canonicalKey?1:0)
 }
 async listHeads(scope:SourceScope,root:SourceRoot,after:string|undefined,limit:number){
  const current=await this.checkCurrent(scope,root);if(current.state!=='current')fail(current.state)
  const all=(await this.records(scope,root)).filter(r=>after===undefined||r.head.canonicalKey>after)
  return {heads:all.slice(0,limit).map(r=>r.head),version:current.version,hasMore:all.length>limit}
 }
 async getHeads(scope:SourceScope,root:SourceRoot,keys:readonly string[]){
  const current=await this.checkCurrent(scope,root);if(current.state!=='current')fail(current.state)
  const all=await this.records(scope,root)
  return {heads:keys.flatMap(key=>{
   const body=all.find(r=>r.head.canonicalKey===key||r.head.locator?.teamProjectionKey===key)
   return body?[{...body.head,canonicalKey:key}]:[]
  }),version:current.version}
 }
 async resolveBodies(scope:SourceScope,root:SourceRoot,heads:SourceHead[],_expected:SourceVersion){
  const all=await this.records(scope,root)
  return heads.map(head=>{
   const body=all.find(r=>r.head.canonicalKey===head.canonicalKey||r.head.locator?.teamProjectionKey===head.canonicalKey)
   if(!body)return fail('body_set_mismatch')
   return {...body,head:{...body.head,canonicalKey:head.canonicalKey}}
  })
 }
}
