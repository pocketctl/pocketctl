import {createHash} from 'node:crypto'
import type {SourceRoot,SourceScope} from '@pocketctl/session-source'
import {JOB_PRIORITIES} from '../jobs/types.js'
import type pg from 'pg'
import {canonicalPayloadHash} from '../inbox/canonical-json.js'
import {loadSourceContextSet,requireSourceContext} from '../sources/source-context-set.js'

type DB=Pick<pg.PoolClient,'query'>
const digest=(value:unknown)=>canonicalPayloadHash(value).toString('hex')
const eligibleErrors=new Set(['processing_pin_expired_or_unavailable','source_store_timeout','source_store_unavailable'])
interface Entry {jobId:string;installationId:string;payloadHash:string;claimEpoch:string;attempts:number;error:string;sourceHash:string}
export interface SourceProjectionRepair {version:1;kind:'memory-source-projection-repair';database:Record<string,unknown>;entries:Entry[]}
const identity=async(db:DB)=>(await db.query('SELECT current_database() AS database,current_user AS role,inet_server_addr()::text AS address,inet_server_port() AS port')).rows[0]
function exactIds(ids:string[]){if(!Array.isArray(ids)||ids.length<1||ids.length>32||new Set(ids).size!==ids.length||ids.some(id=>! /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id)))throw Error('source_repair_exact_jobs_required')}
// A legacy generic error is ambiguous. Only resume the canonical job for the
// current seal when its *first* page still requires this exact cold-read fix.
async function coldFirstPageProof(db:DB,scope:SourceScope,root:SourceRoot,scan:string,cursor:string,jobKey:string){
 const expectedKey='shared-source:'+scan+':'+createHash('sha256').update(cursor).digest('hex')
 if(jobKey!==expectedKey)throw Error('source_repair_not_eligible')
 const checkpoint=await db.query(`SELECT 1 FROM memory_canonical_projection_progress
  WHERE installation_id=$1 AND source_kind=$2 AND root_key=$3 AND context_key=$4`,
  [scope.installationId,root.kind,root.key,digest(scope)])
 if(checkpoint.rowCount)throw Error('source_repair_not_eligible')
 // The metadata selector uses [-1] for its bounded, body-free first page.
 // Return only the failing header coordinates, never the event body.
 const rows=(await db.query(`SELECT item->>'id' AS id,item->>'body_storage' AS storage,item->>'manifest_id' AS manifest,
   item->>'ordinal' AS ordinal,item->>'activity_epoch' AS epoch
  FROM shared.read_memory_relay_sources($1::jsonb,$2,NULL,64,ARRAY[-1::bigint]) page(value)
  CROSS JOIN LATERAL jsonb_array_elements(page.value->'rows') WITH ORDINALITY row_data(item,seq)
  WHERE (item->>'canonical_hash') IS NULL AND (item->>'payload') IS NULL ORDER BY seq`,[scope,root.key])).rows
 if(!rows.length||rows.some(r=>r.storage!=='cold'||!r.id||!r.manifest||r.ordinal==null||r.epoch==null))throw Error('source_repair_not_eligible')
 return digest(rows)
}
async function currentSource(db:DB,row:any){
 const {scope,root,distribution_scan:scan,target_cursor:cursor}=row.payload??{}
 // Only ordinary personal projection is deterministic and supported here.
 // Reference repair, shadow, compilation and every model job stay out of scope.
 if(row.job_type!=='project_shared_source'||root?.kind!=='relay_event'||scope?.ownerScopeKind!=='personal'||scope.installationId!==row.installation_id
  ||typeof root.key!=='string'||typeof scan!=='string'||typeof cursor!=='string'
  ||Object.keys(row.payload).some(k=>!['scope','root','distribution_scan','target_cursor','source_wait_count'].includes(k)))throw Error('source_repair_unsupported_job')
 const contexts=await loadSourceContextSet(db,row.installation_id,root,scan,'personal-projection')
 requireSourceContext(contexts,scope,cursor)
 if(!contexts.contexts.some(c=>c.cursorKey===cursor&&c.mode==='shared-active'))throw Error('source_repair_mode_changed')
 const source=(await db.query("SELECT * FROM shared.memory_relay_source_authority($1::jsonb,'relay_event',$2)",[scope,root.key])).rows[0]
 if(source?.state!=='current')throw Error('source_repair_authority_unavailable')
 const coldProof=row.last_error_code==='handler_failed_Error'?await coldFirstPageProof(db,scope,root,scan,cursor,row.idempotency_key):undefined
 if(coldProof===undefined&&!eligibleErrors.has(row.last_error_code))throw Error('source_repair_not_eligible')
 return digest({scope,root,scan,...(coldProof&&{coldProof}),control:contexts.controlRevision,work:contexts.workRevision,
  content:source.content_revision,authorization:source.authorization_revision,storage:source.storage_revision})
}
/** Read-only plan over exact reviewed IDs, never a global retry reset. */
export async function planSourceProjectionRepair(db:DB,ids:string[]):Promise<SourceProjectionRepair>{
 exactIds(ids);const entries:Entry[]=[]
 for(const id of ids){
  const row=(await db.query('SELECT * FROM memory_jobs WHERE job_id=$1',[id])).rows[0]
  if(!row||row.state!=='dead'||(!eligibleErrors.has(row.last_error_code)&&row.last_error_code!=='handler_failed_Error'))throw Error('source_repair_not_eligible')
  entries.push({jobId:id,installationId:row.installation_id,payloadHash:digest(row.payload),claimEpoch:String(row.claim_epoch),attempts:row.attempts,error:row.last_error_code,sourceHash:await currentSource(db,row)})
 }
 return {version:1,kind:'memory-source-projection-repair',database:await identity(db),entries}
}
/** Caller owns a short transaction. This schedules the SAME deterministic job;
 * execution still acquires a fresh claim and checks all source/commit fences.
 * Checkpoints, provenance, dead-letter audit and uncertain paid work survive. */
export async function applySourceProjectionRepair(db:DB,manifest:SourceProjectionRepair){
 if(manifest?.version!==1||manifest.kind!=='memory-source-projection-repair')throw Error('source_repair_manifest_invalid')
 exactIds(manifest.entries.map(e=>e.jobId))
 if(digest(await identity(db))!==digest(manifest.database))throw Error('source_repair_database_changed')
 const results:Array<{jobId:string;state:string}>=[]
 for(const entry of [...manifest.entries].sort((a,b)=>a.jobId.localeCompare(b.jobId))){
  const row=(await db.query('SELECT * FROM memory_jobs WHERE job_id=$1 FOR UPDATE NOWAIT',[entry.jobId])).rows[0]
  if(!row||row.installation_id!==entry.installationId||digest(row.payload)!==entry.payloadHash)throw Error('source_repair_job_changed')
  if(row.state!=='dead'){results.push({jobId:entry.jobId,state:'already_resumed'});continue}
  if(String(row.claim_epoch)!==entry.claimEpoch||row.attempts!==entry.attempts||row.last_error_code!==entry.error)throw Error('source_repair_job_changed')
  if(await currentSource(db,row)!==entry.sourceHash)throw Error('source_repair_source_changed')
  await db.query(`UPDATE memory_jobs SET state='pending',priority=$2,attempts=0,last_error_code=NULL,completed_at=NULL,
   claimed_by=NULL,claim_expires_at=NULL,available_at=clock_timestamp() WHERE job_id=$1`,[entry.jobId,JOB_PRIORITIES.project_shared_source])
  results.push({jobId:entry.jobId,state:'requeued'})
 }
 return results
}
