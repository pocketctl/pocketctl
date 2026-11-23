import {createHash} from 'node:crypto'
import type pg from 'pg'
import {canonicalJsonString,canonicalPayloadHash,type SourceRoot,type SourceScope,type SourceVersion} from '@pocketctl/session-source'
import {relaySourceUsageDeniedSql} from '../migrations/shared-db/reader-contract.js'

export interface HistoricalProjectionRoot {
 installationId:string
 rootKey:string
 scanId:string
 workRevision:string
}

export interface HistoricalProjectionSeal {
 scope:SourceScope
 version:SourceVersion
 controlRevision:string
 jobState:string
 attempts:number
 errorCode:string|null
 completedAt:Date|null
 payload:Record<string,unknown>
 deadHash:Buffer|null
 processedRevision:string
}

export async function readHistoricalProjectionSeal(db:Pick<pg.Pool,'query'>,root:HistoricalProjectionRoot,lock=false){
 const row=(await db.query<HistoricalProjectionSeal>(`
  SELECT t.source_scope AS scope,t.source_version AS version,d.control_revision::text AS "controlRevision",
   j.state AS "jobState",j.attempts,j.last_error_code AS "errorCode",j.completed_at AS "completedAt",j.payload,
   (SELECT l.payload_hash FROM memory.memory_dead_letters l WHERE l.job_id=j.job_id AND l.installation_id=j.installation_id
    AND l.job_type=j.job_type AND l.attempts=j.attempts AND l.error_code=j.last_error_code) AS "deadHash",
   p.processed_revision::text AS "processedRevision"
  FROM shared.memory_source_progress p
  JOIN shared.memory_source_work w USING(source_kind,root_key)
  JOIN shared.memory_source_distributions d USING(source_kind,root_key)
  JOIN shared.memory_source_modes m ON m.installation_id=p.installation_id
  JOIN shared.memory_source_distribution_targets t ON t.scan_id=d.scan_id AND t.installation_id=p.installation_id
  JOIN memory.memory_jobs j ON j.installation_id=p.installation_id AND j.job_type='project_shared_source'
   AND j.idempotency_key='shared-source:'||d.scan_id::text||':'||encode(sha256(convert_to(t.cursor_key,'UTF8')),'hex')
  WHERE p.installation_id=$1 AND p.source_kind='relay_event' AND p.root_key=$2 AND d.scan_id=$3 AND d.work_revision=$4
   AND m.mode='shared-active' AND p.mode_generation=m.generation AND p.dispatched_revision=d.work_revision
   AND w.revision=d.work_revision AND w.processed_revision=w.revision AND d.state='sealed' AND d.dispatch_complete
   AND d.control_revision=shared.memory_source_control_snapshot()::bigint AND t.state='current' AND t.target_mode=m.mode
   AND t.source_scope->>'ownerScopeKind'='personal' AND t.source_scope->>'installationId'=p.installation_id::text
   AND t.source_scope->>'modeGeneration'=m.generation::text
   AND (NOT (j.payload?'source_wait_count') OR (jsonb_typeof(j.payload->'source_wait_count')='number'
    AND j.payload->>'source_wait_count' ~ '^[1-9][0-9]{0,8}$'))
   AND (NOT (j.payload?'projection_budget_step') OR (jsonb_typeof(j.payload->'projection_budget_step')='number' AND j.payload->>'projection_budget_step' ~ '^[1-8]$'))
   AND (j.payload-'source_wait_count'-'projection_budget_step')=jsonb_build_object('scope',t.source_scope,'root',jsonb_build_object('kind',p.source_kind,'key',p.root_key),
    'distribution_scan',d.scan_id::text,'target_cursor',t.cursor_key)
   AND (SELECT count(*) FROM shared.memory_source_distribution_targets x WHERE x.scan_id=d.scan_id AND x.installation_id=p.installation_id)=1
   ${lock?'FOR SHARE OF w,d,m,t,j NOWAIT':''}`,[root.installationId,root.rootKey,root.scanId,root.workRevision])).rows[0]
 if(!row)throw Error('historical_projection_seal_changed')
 if(row.jobState==='dead'){
  const hash=createHash('sha256').update(JSON.stringify(row.payload)).digest()
  if(!row.completedAt||!row.deadHash?.equals(hash))throw Error('historical_projection_dead_receipt_changed')
 }else if(row.jobState!=='pending'&&!(row.jobState==='completed'&&row.processedRevision===root.workRevision)){
  throw Error('historical_projection_job_busy')
 }
 return row
}

// Bound the physical key range before body IO. Eligibility is the same
// native, start and retention policy used by the ordinary unkeyed reader.
export async function readHistoricalIds(client:pg.PoolClient,scope:SourceScope,root:SourceRoot,version:SourceVersion,cursor:string|undefined,limit:number){
 const decoded=cursor?JSON.parse(Buffer.from(cursor,'base64url').toString('utf8')):null
 const after=decoded?.after??null
 if(decoded&&(decoded.v!==1||decoded.scope!==canonicalPayloadHash({scope,root}).toString('hex')
  ||canonicalJsonString(decoded.version)!==canonicalJsonString(version)
  ||typeof after!=='string'||!(/^[1-9][0-9]{0,18}$/).test(after)))throw Error('canonical_reference_cursor_changed')
 const ids=await client.query<{id:string;eligible:boolean}>(`
  WITH authority AS MATERIALIZED(SELECT public.native_session_authority(
    substr($2,strpos($2,':')+1),($1::jsonb->>'principalUserId')::int,NULL) AS value),
  page AS MATERIALIZED(SELECT e.* FROM authority a CROSS JOIN LATERAL(
   SELECT id,user_id,session_id,logical_source_session_id,owner_retired,effect_status,payload,source_header_version,source_classification FROM public.events WHERE session_id=a.value->>'sessionId' AND id>COALESCE($3::bigint,0)
   ORDER BY id LIMIT $5
  ) e WHERE a.value->>'state'='current')
 , admitted AS MATERIALIZED(SELECT e.id FROM page e
  LEFT JOIN memory.source_events r ON r.installation_id=($1::jsonb->>'installationId')::uuid
   AND r.source_kind='relay_event' AND r.canonical_key=e.id::text AND r.mapping_state='verified'
  WHERE CASE WHEN NOT e.owner_retired AND e.user_id=($1::jsonb->>'principalUserId')::int
   AND e.effect_status IN('none','completed')
   THEN shared.memory_relay_input_admitted($1::jsonb,e.id,FALSE) AND NOT(${relaySourceUsageDeniedSql('e','r','$1::jsonb')})
   ELSE FALSE END ORDER BY e.id LIMIT $4)
  SELECT id::text,TRUE AS eligible FROM admitted
  UNION ALL
  SELECT id::text,FALSE FROM (
   SELECT max(id) AS id FROM page HAVING count(*)=$5 AND (SELECT count(*) FROM admitted)<$4
  ) boundary
  ORDER BY eligible DESC,id`,[scope,root.key,after,limit,Math.min(limit*2,128)])
 return ids.rows
}
