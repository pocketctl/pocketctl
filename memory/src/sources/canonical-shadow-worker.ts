import type pg from 'pg'
import {canonicalJsonString,canonicalPayloadHash,SourceUnavailableError,type SourceScope,type SourceRoot,type SourceVersion} from '@pocketctl/session-source'
import {JobDeferredError,JobTerminalError} from '../jobs/types.js'
import type {JobHandler} from '../jobs/worker.js'
import {createObservedSourceReader} from './observed-reader.js'
import {loadSourceContextSet,checkSourceContextSet,requireSourceContext} from './source-context-set.js'
import {sourceConnectionKey,sourcePoolContext} from './pool-context.js'
import {sourceExecutionBranchFor,writeSourceComparisonProgress} from './source-execution.js'
import {compareSourcePage,type LegacyComparisonSource} from './shadow-comparison.js'

interface PreparedComparison {pool:pg.Pool;scope:SourceScope;root:SourceRoot;scan:string;context:string;meta:Record<string,unknown>}
const preparedPages=new WeakMap<object,PreparedComparison>()
const compareBytes=(a:string,b:string)=>Buffer.compare(Buffer.from(a),Buffer.from(b))
const pending=(deferMs:number)=>new JobDeferredError('source_not_ready',new Date(Date.now()+deferMs))

/** Candidate relations are metadata only. Bodies are fetched one at a time
 * against their observed xmin, with one combined 32 MiB page budget. */
async function preparePage(pool:pg.Pool,scope:SourceScope,root:SourceRoot,scan:string,context:string,cursor:string|undefined,limit:number):Promise<object>{
 const reader=createObservedSourceReader(pool,sourcePoolContext(pool).archive)
 const page=await reader.listHeads(scope,root,{limit,cursor})
 const bodies=await reader.resolveBodies(scope,root,page.heads,page.version)
 let bytes=0
 for(const body of bodies){
  bytes+=Buffer.byteLength(canonicalJsonString(body.payload));if(bytes>32*1024*1024)throw Error('shadow_comparison_limit')
  const payload=body.payload as Record<string,unknown>|null,turn=payload&&typeof payload==='object'?(payload.turn_id??payload.source_turn_id):undefined
  if(root.kind==='relay_event'&&typeof turn==='string'&&turn&&turn.length<=1024)body.head.turnKey=turn
 }
 const keys=bodies.map(b=>b.head.canonicalKey),sessions=[...new Set(bodies.map(b=>b.head.sessionKey))].sort(compareBytes)
 const headers=(await pool.query('SELECT * FROM shared.memory_shadow_candidate_headers($1,$2,$3,$4)',[scope.installationId,root.kind,keys,sessions])).rows
 if(headers.length>256)throw Error('shadow_comparison_limit')
 const observations=headers.map(h=>[h.source_event_id,h.row_version,h.canonical_key,h.link_via])
  .sort((a,b)=>compareBytes(a[0],b[0])||compareBytes(a[2],b[2])||compareBytes(a[3],b[3]))
 const grouped=new Map<string,LegacyComparisonSource>()
 for(const h of headers){
  let row=grouped.get(h.source_event_id)
  if(!row){
   row={sourceEventId:h.source_event_id,installationId:scope.installationId,origin:h.origin,originPosition:h.origin_position,
    sessionId:h.session_id,turnId:h.turn_id,eventType:h.event_type,occurredAt:h.occurred_at,payload:null,payloadHash:h.payload_hash,
    classification:h.classification??{},provenance:h.source_provenance??{},unavailable:h.body_reclaimed||h.metadata_limited,links:[]}
   if(!row.unavailable&&bytes<32*1024*1024){
    const body=(await pool.query(`SELECT xmin::text AS row_version,CASE WHEN octet_length(payload::text)<=$3 THEN payload END AS payload
     FROM source_events WHERE installation_id=$1 AND source_event_id=$2 AND body_reclaimed_at IS NULL`,[scope.installationId,h.source_event_id,32*1024*1024-bytes])).rows[0]
    if(!body||body.row_version!==h.row_version)throw new SourceUnavailableError('changed')
    row.payload=body.payload;row.unavailable=body.payload===null
    if(body.payload!==null)bytes+=Buffer.byteLength(canonicalJsonString(body.payload))
   }else row.unavailable=true
   grouped.set(h.source_event_id,row)
  }
  row.links.push({kind:root.kind,key:h.canonical_key,via:h.link_via})
 }
 const comparison=compareSourcePage(scope.installationId,bodies,[...grouped.values()])
 if((await reader.checkCurrent(scope,root,page.version)).state!=='current')throw new SourceUnavailableError('changed')
 requireSourceContext(await loadSourceContextSet(pool,scope.installationId,root,scan),scope)
 const meta={version:page.version,fromCursor:cursor??null,nextCursor:page.nextCursor??null,canonicalKeys:keys,sessionKeys:sessions,observations,comparison}
 const pageHash=canonicalPayloadHash(meta).toString('hex'),token=Object.freeze({})
 preparedPages.set(token,{pool,scope,root,scan,context,meta:{...meta,pageHash}})
 return token
}

async function persistPage(pool:pg.Pool,token:object){
 const prepared=preparedPages.get(token)
 if(!prepared||prepared.pool!==pool)throw Error('shadow_comparison_token_invalid')
 const c=await pool.connect()
 try{
  await c.query('BEGIN');await c.query("SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='1s'")
  const result=await writeSourceComparisonProgress(c,prepared.scope.installationId,{scope:prepared.scope,kind:prepared.root.kind,root:prepared.root.key,
   scan:prepared.scan,context:prepared.context,meta:prepared.meta})
  await c.query('COMMIT');return result
 }catch(error){await c.query('ROLLBACK');throw error}finally{c.release()}
}

/** Shadow reads canonical and existing legacy facts, writing only comparison
 * receipts. No new source UUID, body copy, active cursor, episode or model. */
export function createCanonicalShadowHandler(pool:pg.Pool,options:{pageSize?:number;deferMs?:number;legacyWaitMs?:number}={}):JobHandler{
 const limit=options.pageSize??64,deferMs=options.deferMs??1000,waitMs=options.legacyWaitMs??600000
 if(sourceConnectionKey(pool)!==pool||sourcePoolContext(pool).namespace!=='memory')throw Error('shadow_requires_physical_pool')
 if(!Number.isInteger(limit)||limit<1||limit>128||!Number.isInteger(deferMs)||deferMs<0||deferMs>60000||!Number.isInteger(waitMs)||waitMs<1000||waitMs>3600000)throw Error('invalid_shadow_options')
 return async(job,signal)=>{
  const scope=structuredClone(job.payload.scope) as SourceScope|undefined,root=structuredClone(job.payload.root) as SourceRoot|undefined
  const scan=job.payload.distribution_scan,cursor=job.payload.target_cursor
  if(job.job_type!=='project_shared_source'||!scope||scope.installationId!==job.installation_id||!root||!['relay_event','team_collaboration','team_delivery'].includes(root.kind)
   ||typeof scan!=='string'||!/^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(scan)||typeof cursor!=='string'||cursor.length<1||cursor.length>2048)throw new JobTerminalError('invalid_source_context_set')
  if(sourceExecutionBranchFor(pool,scope.installationId)!=='canonical-shadow')throw Error('source_shadow_execution_required')
  if(signal.aborted)throw Error('source_shadow_aborted')
  const contexts=await loadSourceContextSet(pool,scope.installationId,root,scan)
  requireSourceContext(contexts,scope,cursor);await checkSourceContextSet(pool,root,contexts)
  const context=canonicalPayloadHash(scope).toString('hex')
  const progress=(await pool.query('SELECT shared.read_memory_source_shadow_progress($1,$2,$3,$4,$5) AS progress',[scope.installationId,root.kind,root.key,scan,context])).rows[0].progress
  let from=progress?.nextCursor??undefined
  if(progress&&['body_identity_ready','different'].includes(progress.state)){
   const current=await createObservedSourceReader(pool).checkCurrent(scope,root,progress.version as SourceVersion)
   // A new claim rechecks legacy bodies too. Their content is not part of
   // Relay's revision, so a canonical-version-only cache would hide drift.
   if(current.state!=='current'&&current.state!=='changed')throw new SourceUnavailableError(current.state)
   from=undefined
  }
  let token:object
  try{token=await preparePage(pool,scope,root,scan,context,from,limit)}
  catch(error){if(!from||!(error instanceof SourceUnavailableError)||error.code!=='changed')throw error;token=await preparePage(pool,scope,root,scan,context,undefined,limit)}
  if(signal.aborted)throw Error('source_shadow_aborted')
  const result=await persistPage(pool,token)
  if(result.state==='waiting'){
   const expired=(await pool.query("SELECT created_at<clock_timestamp()-($2::bigint*interval '1 millisecond') AS expired FROM memory_jobs WHERE job_id=$1",[job.job_id,waitMs])).rows[0]?.expired
   if(expired)throw new JobTerminalError('source_identity_unproven')
   throw pending(deferMs)
  }
  if(result.nextCursor)throw pending(deferMs)
 }
}
