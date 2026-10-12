import type pg from 'pg'
import { evaluateLifecycle } from './policy.js'
import { timestampMicros } from './time.js'
import type { LifecycleBlocker, LifecycleEvaluation, LifecycleInput, SessionLifecycleConfig } from './types.js'

type Database=Pick<pg.Pool,'query'>
export interface LifecycleEligibility {
  root:Record<string,any>|null
  members:Record<string,any>[]
  sessionIds:string[]
  evaluatedAt:string
  prediction:LifecycleEvaluation
  eventCount:string
  hotEventBytes:string
  hotDocumentBytes:string
}
const inactive=new Set(['idle','exited','completed','failed','stopped','terminated','abandoned','error','killed'])
const active=new Set(['running','busy','retry','waiting','waiting_approval','waiting_question'])
const buckets=new Set(['claude_subagent','codex_subagent','zcode_subagent'])

/** Final factual eligibility, usable on the fenced executor connection. No
 * upload or mutation occurs here. BFS queries stop after 1001 identifiers. */
export async function inspectLifecycleEligibility(db:Database,sessionId:string,config:SessionLifecycleConfig,options:{now?:string;ownCoolingEpochs?:ReadonlyMap<string,string>}={}):Promise<LifecycleEligibility> {
  const clock=(await db.query(`SELECT to_char(COALESCE($1::timestamptz,NOW()) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS time`,[options.now??null])).rows[0].time
  const members=new Map<string,Record<string,any>>(),seen=new Set<string>(),bucketRows=new Map<string,Record<string,any>>()
  const blocked=new Set<LifecycleBlocker>()
  let frontier=[sessionId],overflow=false
  while(frontier.length && !overflow) {
    for(const id of frontier) seen.add(id)
    if(seen.size>1000){overflow=true;break}
    const result=await db.query(`SELECT s.*,s.activity_epoch::text AS epoch,
      to_char(s.last_activity_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS activity_time,d.user_id AS daemon_owner,
      COALESCE(d.alias,d.hostname,s.daemon_id) AS daemon_name,
      EXISTS(SELECT 1 FROM collaboration_session_agent_bindings b WHERE b.native_session_id=s.session_id)
        OR EXISTS(SELECT 1 FROM collaboration_calls c WHERE c.native_session_id=s.session_id) AS team_bound
      FROM sessions s LEFT JOIN daemons d USING(daemon_id)
      WHERE s.session_id=ANY($1::varchar[]) OR s.parent_session_id=ANY($1::varchar[]) OR s.root_session_id=ANY($1::varchar[]) LIMIT 1001`,[frontier])
    if(result.rows.length>1000){overflow=true;break}
    const neighbors=new Set<string>()
    for(const row of result.rows){members.set(row.session_id,row);neighbors.add(row.session_id);if(row.parent_session_id)neighbors.add(row.parent_session_id);if(row.root_session_id)neighbors.add(row.root_session_id)}
    const subagents=await db.query(`SELECT b.*,s.session_id AS independent_session FROM subagents b LEFT JOIN sessions s ON s.session_id=b.agent_id
      WHERE b.parent_session_id=ANY($1::varchar[]) OR b.agent_id=ANY($1::varchar[]) LIMIT 1001`,[frontier])
    if(subagents.rows.length>1000){overflow=true;break}
    for(const subagent of subagents.rows){
      neighbors.add(subagent.parent_session_id)
      if(subagent.independent_session)neighbors.add(subagent.independent_session)
      else bucketRows.set(`${subagent.parent_session_id}:${subagent.agent_id}`,subagent)
    }
    frontier=[...neighbors].filter(id=>!seen.has(id))
    if(members.size+frontier.length>1000)overflow=true
  }
  const root=members.get(sessionId)??null,rows=[...members.values()].sort((a,b)=>a.session_id.localeCompare(b.session_id)),ids=rows.map(row=>row.session_id)
  if(overflow||!root||[...seen].some(id=>!members.has(id)))blocked.add('dependency_unknown')
  const ancestry=new Map(rows.map(row=>[row.session_id,[row.parent_session_id,row.root_session_id].filter(id=>id&&id!==row.session_id)]))
  const visited=new Set<string>(),visiting=new Set<string>()
  const cyclic=(id:string):boolean=>{if(visiting.has(id))return true;if(visited.has(id))return false;visiting.add(id);for(const parent of ancestry.get(id)??[])if(cyclic(parent))return true;visiting.delete(id);visited.add(id);return false}
  if(rows.some(row=>row.parent_session_id===row.session_id||cyclic(row.session_id)))blocked.add('dependency_unknown')
  for(const row of rows){
    if(!root?.user_id||row.user_id!==root.user_id||row.daemon_owner!==root.user_id)blocked.add('owner_unknown')
    if(!row.activity_verified)blocked.add('activity_unverified')
    if(row.turn_started_at||active.has(row.status))blocked.add('session_active')
    else if(!inactive.has(row.status))blocked.add('status_unknown')
    if(row.content_state==='deleting')blocked.add('session_deleting')
    if(row.content_state==='deleted')blocked.add('session_deleted')
    if(row.content_state==='cooling'&&options.ownCoolingEpochs?.get(row.session_id)!==row.epoch)blocked.add('cooling_pending')
  }
  for(const bucket of bucketRows.values()){
    if(!buckets.has(bucket.kind))blocked.add('dependency_unknown')
    if(active.has(bucket.status))blocked.add('session_active')
    else if(!inactive.has(bucket.status))blocked.add('status_unknown')
  }
  const p=(await db.query(`SELECT
    EXISTS(SELECT 1 FROM session_message_admissions WHERE state IN ('issued','uncertain') AND (session_id=ANY($1::varchar[]) OR canonical_session_id=ANY($1::varchar[]) OR session_aliases ?| $1::text[]))
      OR EXISTS(SELECT 1 FROM quota_reservations WHERE session_id=ANY($1::varchar[]) AND state IN ('pending','uncertain')) AS admission,
    EXISTS(SELECT 1 FROM event_inbox WHERE session_id=ANY($1::varchar[]) AND status IN (0,1)) AS inbox,
    EXISTS(SELECT 1 FROM realtime_outbox WHERE session_id=ANY($1::varchar[]) AND delivered_at IS NULL) AS outbox,
    EXISTS(SELECT 1 FROM events WHERE session_id=ANY($1::varchar[]) AND effect_status='pending') AS effect,
    EXISTS(SELECT 1 FROM attention_items WHERE session_id=ANY($1::varchar[]) AND state IN ('open','snoozed','submitting','result_unknown')) AS attention,
    EXISTS(SELECT 1 FROM session_document_uploads WHERE session_id=ANY($1::varchar[])) AS uploads,
    EXISTS(SELECT 1 FROM collaboration_calls WHERE native_session_id=ANY($1::varchar[]) AND state IN ('pending','dispatched','accepted','blocked','uncertain')) AS collaboration,
    EXISTS(SELECT 1 FROM deleted_sessions WHERE session_id=ANY($1::varchar[])) AS tombstone,
    EXISTS(SELECT 1 FROM extension_source_outbox o WHERE o.session_id=ANY($1::varchar[])) AS extension,
    EXISTS(SELECT 1 FROM events e WHERE e.session_id=ANY($1::varchar[]) AND e.id>COALESCE((SELECT last_event_id FROM attention_projection_cursor WHERE projector_name='attention-inbox-v1'),0)) AS projection,
    (SELECT count(*)::text FROM events WHERE session_id=ANY($1::varchar[])) AS event_count,
    (SELECT COALESCE(sum(pg_column_size(payload)),0)::text FROM events WHERE session_id=ANY($1::varchar[]) AND body_storage='hot') AS event_bytes,
    (SELECT COALESCE(sum(byte_size),0)::text FROM session_document_versions WHERE session_id=ANY($1::varchar[]) AND body_storage='hot') AS document_bytes`,[ids])).rows[0]
  const protections:Record<string,LifecycleBlocker>={admission:'admission_pending',inbox:'inbox_pending',outbox:'outbox_pending',effect:'effect_pending',attention:'attention_pending',uploads:'document_upload_pending',collaboration:'collaboration_pending',tombstone:'session_deleted',extension:'extension_pending',projection:'attention_pending'}
  for(const [flag,reason] of Object.entries(protections))if(p[flag])blocked.add(reason)
  const coolingOwned=root?.content_state==='cooling'&&options.ownCoolingEpochs?.get(sessionId)===root?.epoch
  const input:LifecycleInput={ownerUserId:root?.user_id??null,scope:rows.some(row=>row.team_bound)?'team':'personal',activityAt:root?.activity_time??null,
    activityVerified:root?.activity_verified??false,status:root?.status??null,turnActive:!!root?.turn_started_at,archiveReason:root?.archive_reason??null,
    contentState:coolingOwned?'hot':root?.content_state??'hot',dependencyActivityAt:rows.map(row=>row.activity_time??null),
    historical:!!config.effectiveAt&&rows.some(row=>row.activity_time&&timestampMicros(row.activity_time)<timestampMicros(config.effectiveAt!)),blockers:[...blocked]}
  return {root,members:rows,sessionIds:ids,evaluatedAt:clock,prediction:evaluateLifecycle(input,clock,config),eventCount:p.event_count,hotEventBytes:p.event_bytes,hotDocumentBytes:p.document_bytes}
}
