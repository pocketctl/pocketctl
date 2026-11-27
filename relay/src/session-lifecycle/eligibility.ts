import type pg from 'pg'
import { isAppReviewDemoDaemon, isAppReviewDemoSession } from '../config/app-review-demo.js'
import { evaluateLifecycle } from './policy.js'
import { timestampMicros, microsTimestamp } from './time.js'
import type { LifecycleBlocker, LifecycleEvaluation, LifecycleInput, SessionLifecycleConfig } from './types.js'

type Database=Pick<pg.Pool,'query'>
export interface LifecycleEligibility {
  root:Record<string,any>|null
  members:Record<string,any>[]
  sessionIds:string[]
  evaluatedAt:string
  prediction:LifecycleEvaluation
  /** Exact diagnostic totals are opt-in; execution never scans all payloads. */
  eventCount:string|null
  hotEventBytes:string|null
  hotDocumentBytes:string|null
  staleEvidence?:{activityAt:string;pendingEffects:number;pendingInbox:number;states:Record<string,string>}
}
const inactive=new Set(['idle','exited','completed','failed','stopped','terminated','abandoned','error','killed'])
const active=new Set(['running','busy','retry','waiting','waiting_approval','waiting_question'])
const buckets=new Set(['claude_subagent','codex_subagent','zcode_subagent'])

/** Final factual eligibility, usable on the fenced executor connection. No
 * upload or mutation occurs here. BFS queries stop after 1001 identifiers. */
export async function inspectLifecycleEligibility(db:Database,sessionId:string,config:SessionLifecycleConfig,options:{now?:string;ownCoolingEpochs?:ReadonlyMap<string,string>;includeStatistics?:boolean}={}):Promise<LifecycleEligibility> {
  const clock=(await db.query(`SELECT to_char(COALESCE($1::timestamptz,NOW()) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS time`,[options.now??null])).rows[0].time
  const members=new Map<string,Record<string,any>>(),seen=new Set<string>(),bucketRows=new Map<string,Record<string,any>>()
  const currentNames = new Map<string,string>()
  const blocked=new Set<LifecycleBlocker>()
  let frontier=[sessionId],overflow=false
  while(frontier.length && !overflow) {
    // A child can still point at a parent name retired before this pass.
    const unknownNames = members.size ? frontier.filter(id => !members.has(id) && !currentNames.has(id)) : []
    if (unknownNames.length) {
      const aliases = await db.query(`SELECT public.native_session_authority(old_session_id,owner_user_id,original_daemon_id)->>'sessionId' AS id
        FROM session_aliases WHERE old_session_id=ANY($1::varchar[])`, [unknownNames])
      frontier = [...new Set([...frontier, ...aliases.rows.map(row => row.id).filter(id => id && !seen.has(id))])]
    }
    for(const id of frontier) seen.add(id)
    if(seen.size>1000){overflow=true;break}
    const result=await db.query(`SELECT s.*,s.activity_epoch::text AS epoch,
      to_char(s.last_activity_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS activity_time,d.user_id AS daemon_owner,
      COALESCE(d.alias,d.hostname,s.daemon_id) AS daemon_name,
      CASE WHEN EXISTS(SELECT 1 FROM session_aliases a WHERE a.next_session_id=s.session_id)
        THEN public.native_session_authority(s.session_id,s.user_id,s.daemon_id)->'sessionIds' END AS owned_names,
      EXISTS(SELECT 1 FROM collaboration_session_agent_bindings b WHERE b.native_session_id=s.session_id)
        OR EXISTS(SELECT 1 FROM collaboration_calls c WHERE c.native_session_id=s.session_id) AS team_bound
      FROM sessions s LEFT JOIN daemons d USING(daemon_id)
      WHERE s.session_id=ANY($1::varchar[]) OR s.parent_session_id=ANY($1::varchar[]) OR s.root_session_id=ANY($1::varchar[]) LIMIT 1001`,[frontier])
    if(result.rows.length>1000){overflow=true;break}
    const neighbors=new Set<string>()
    for (const row of result.rows) {
      members.set(row.session_id,row)
      neighbors.add(row.session_id)
      for (const name of row.owned_names ?? []) {
        currentNames.set(name,row.session_id)
        neighbors.add(name)
      }
      if (row.parent_session_id) neighbors.add(row.parent_session_id)
      if (row.root_session_id) neighbors.add(row.root_session_id)
    }
    const subagents=await db.query(`SELECT b.*,COALESCE(s.session_id,
        CASE WHEN a.old_session_id IS NOT NULL THEN public.native_session_authority(a.old_session_id,a.owner_user_id,a.original_daemon_id)->>'sessionId' END
      ) AS independent_session FROM subagents b LEFT JOIN sessions s ON s.session_id=b.agent_id
      LEFT JOIN session_aliases a ON a.old_session_id=b.agent_id
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
  if(overflow||!root||[...seen].some(id=>!members.has(currentNames.get(id)??id)))blocked.add('dependency_unknown')
  const ancestry=new Map(rows.map(row=>[row.session_id,[row.parent_session_id,row.root_session_id].map(id=>currentNames.get(id)??id).filter(id=>id&&id!==row.session_id)]))
  const visited=new Set<string>(),visiting=new Set<string>()
  const cyclic=(id:string):boolean=>{if(visiting.has(id))return true;if(visited.has(id))return false;visiting.add(id);for(const parent of ancestry.get(id)??[])if(cyclic(parent))return true;visiting.delete(id);visited.add(id);return false}
  if(rows.some(row=>(currentNames.get(row.parent_session_id)??row.parent_session_id)===row.session_id||cyclic(row.session_id)))blocked.add('dependency_unknown')
  const historicalIds = rows.flatMap(row => (row.owned_names ?? []).filter((id:string) => id !== row.session_id))
  const routeIds = [...ids, ...historicalIds]
  // Anonymous ingress is attributable through the daemon that owned that historical name.
  const inboxOwner = `(i.user_id=$3 OR (i.user_id IS NULL AND EXISTS(
    SELECT 1 FROM session_aliases a WHERE a.old_session_id=i.session_id AND a.original_daemon_id=i.daemon_id)))`
  const p=(await db.query(`SELECT
    EXISTS(SELECT 1 FROM session_message_admissions WHERE state IN ('issued','uncertain') AND (session_id=ANY($1::varchar[]) OR canonical_session_id=ANY($1::varchar[]) OR session_aliases ?| $1::text[]))
      OR EXISTS(SELECT 1 FROM quota_reservations WHERE (session_id=ANY($1::varchar[]) OR (session_id=ANY($4::varchar[]) AND user_id=$3)) AND state IN ('pending','uncertain')) AS admission,
    EXISTS(SELECT 1 FROM realtime_outbox o
      JOIN event_inbox i USING(inbox_id)
      WHERE o.delivered_at IS NULL AND (
        o.session_id=ANY($1::varchar[]) OR (o.session_id=ANY($4::varchar[]) AND (o.user_id=$3 OR
          (o.user_id IS NULL AND (i.user_id=$3 OR (i.user_id IS NULL AND EXISTS (
            SELECT 1 FROM session_aliases a WHERE a.old_session_id=o.session_id AND a.original_daemon_id=i.daemon_id
          ))))))
        OR i.session_id=ANY($1::varchar[]) OR (i.session_id=ANY($2::varchar[]) AND ${inboxOwner})
        OR EXISTS(SELECT 1 FROM events e WHERE e.session_id=ANY($1::varchar[])
          AND (e.id=o.event_id OR (i.session_id IS NULL AND e.id=i.materialized_event_id)))
      )) AS outbox,
    EXISTS(SELECT 1 FROM event_inbox i WHERE i.status IN (0,1) AND
      ((i.session_id=ANY($4::varchar[]) AND ${inboxOwner})
       OR (i.session_id IS NULL AND EXISTS(SELECT 1 FROM events e
         WHERE e.id=i.materialized_event_id AND e.session_id=ANY($1::varchar[]))))) AS indirect_inbox,
    EXISTS(SELECT 1 FROM collaboration_session_agent_bindings WHERE native_session_id=ANY($4::varchar[]))
      OR EXISTS(SELECT 1 FROM collaboration_calls WHERE native_session_id=ANY($4::varchar[])) AS historical_team,
    EXISTS(SELECT 1 FROM attention_items WHERE (session_id=ANY($1::varchar[]) OR (session_id=ANY($4::varchar[]) AND user_id=$3)) AND state IN ('open','snoozed','submitting','result_unknown')) AS attention,
    EXISTS(SELECT 1 FROM session_document_uploads WHERE session_id=ANY($1::varchar[])) AS uploads,
    EXISTS(SELECT 1 FROM collaboration_calls WHERE native_session_id=ANY($1::varchar[]) AND state IN ('pending','dispatched','accepted','blocked','uncertain')) AS collaboration,
    EXISTS(SELECT 1 FROM deleted_sessions WHERE session_id=ANY($1::varchar[])) AS tombstone,
    EXISTS(SELECT 1 FROM extension_source_outbox o WHERE o.session_id=ANY($1::varchar[]) OR (o.session_id=ANY($4::varchar[]) AND o.owner_user_id=$3)) AS extension,
    EXISTS(SELECT 1 FROM events e WHERE e.session_id=ANY($1::varchar[]) AND e.id>COALESCE((SELECT last_event_id FROM attention_projection_cursor WHERE projector_name='attention-inbox-v1'),0)) AS projection,
    (SELECT count(*)::int FROM events WHERE session_id=ANY($1::varchar[]) AND effect_status='pending') AS pending_effects,
    (SELECT count(*)::int FROM event_inbox WHERE session_id=ANY($1::varchar[]) AND status IN (0,1)) AS pending_inbox,
    to_char(GREATEST(
      (SELECT max(latest.created_at) FROM unnest($1::varchar[]) member(session_id)
        CROSS JOIN LATERAL (SELECT created_at FROM events WHERE session_id=member.session_id AND created_at IS NOT NULL AND event_type NOT IN
          ('session_discovered','session_status','session_meta','command_list','subagent_discovered')
          ORDER BY created_at DESC LIMIT 1) latest),
      (SELECT max(latest.received_at) FROM unnest($2::varchar[]) member(session_id)
        CROSS JOIN LATERAL (SELECT received_at FROM event_inbox i WHERE i.session_id=member.session_id
          AND (member.session_id=ANY($1::varchar[]) OR ${inboxOwner})
          AND event_type NOT IN ('session_discovered','session_status','session_meta','command_list','subagent_discovered')
          AND payload->>'resync' IS DISTINCT FROM 'true' ORDER BY received_at DESC LIMIT 1) latest),
      (SELECT max(claimed_at) FROM event_inbox WHERE session_id=ANY($1::varchar[]) AND status=1),
      (SELECT max(committed_at) FROM session_document_versions WHERE session_id=ANY($1::varchar[]))
    ) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS latest_data_at`,[ids,routeIds,root?.user_id??null,historicalIds])).rows[0]
  p.effect=p.pending_effects>0;p.inbox=p.pending_inbox>0
  // Observe callers can request exact totals. Keep those scans out of the
  // eligibility/fenced execution path, especially for large hot histories.
  const statistics=options.includeStatistics?(await db.query(`SELECT count(*)::text AS event_count,
    COALESCE(sum(pg_column_size(payload)) FILTER(WHERE body_storage='hot'),0)::text AS event_bytes,
    (SELECT COALESCE(sum(byte_size),0)::text FROM session_document_versions
      WHERE session_id=ANY($1::varchar[]) AND body_storage='hot') AS document_bytes
    FROM events WHERE session_id=ANY($1::varchar[])`,[ids])).rows[0]:null
  const activitySources=[...rows.flatMap(row=>[row.activity_time,row.last_business_activity_at,row.turn_started_at]),
    ...[...bucketRows.values()].map(row=>row.created_at),p.latest_data_at]
  // Creation is only a fallback for source-less historical rows. It never
  // overwrites verified business activity or makes reconnect time activity.
  for(const row of rows)if(!row.activity_time||!row.activity_verified)activitySources.push(row.created_at)
  const times=activitySources.filter(Boolean).map(value=>timestampMicros(value))
  const latestMicros=times.length?times.reduce((a,b)=>a>b?a:b):null
  const latest=latestMicros===null?NaN:Number(latestMicros/1000n)
  const latestAt=latestMicros===null?null:microsTimestamp(latestMicros)
  const stale=Number.isFinite(latest)&&new Date(clock).getTime()-latest>config.archiveDays*86400000
    && !overflow && !!root && rows.every(row=>row.user_id===root.user_id&&row.daemon_owner===root.user_id)
    && rows.every(row=>inactive.has(row.status)||active.has(row.status)||['unknown','disconnected','shell'].includes(row.status))
    && [...bucketRows.values()].every(row=>buckets.has(row.kind)&&(inactive.has(row.status)||active.has(row.status)))
  for(const row of rows){
    if(!root?.user_id||row.user_id!==root.user_id||row.daemon_owner!==root.user_id)blocked.add('owner_unknown')
    if(!stale&&!row.activity_verified)blocked.add('activity_unverified')
    if(!stale&&(row.turn_started_at||active.has(row.status)))blocked.add('session_active')
    else if(!stale&&!inactive.has(row.status))blocked.add('status_unknown')
    if(row.content_state==='deleting')blocked.add('session_deleting')
    if(row.content_state==='deleted')blocked.add('session_deleted')
    if(row.content_state==='cooling'&&options.ownCoolingEpochs?.get(row.session_id)!==row.epoch)blocked.add('cooling_pending')
  }
  for(const bucket of bucketRows.values()){
    if(!buckets.has(bucket.kind))blocked.add('dependency_unknown')
    if(!stale&&active.has(bucket.status))blocked.add('session_active')
    else if(!stale&&!inactive.has(bucket.status))blocked.add('status_unknown')
  }
  const protections:Record<string,LifecycleBlocker>={admission:'admission_pending',inbox:'inbox_pending',indirect_inbox:'inbox_pending',outbox:'outbox_pending',effect:'effect_pending',attention:'attention_pending',uploads:'document_upload_pending',collaboration:'collaboration_pending',tombstone:'session_deleted',extension:'extension_pending',projection:'attention_pending'}
  for(const [flag,reason] of Object.entries(protections))if(p[flag]&&!(stale&&['effect','inbox'].includes(flag)))blocked.add(reason)
  const coolingOwned=root?.content_state==='cooling'&&options.ownCoolingEpochs?.get(sessionId)===root?.epoch
  // Exclude the whole dependency component so a real root cannot indirectly
  // archive or purge a demo member. Legacy fixtures may lack their source tag.
  const demo=rows.some(row=>row.source==='app_review_demo'||isAppReviewDemoSession(row.session_id)||isAppReviewDemoDaemon(row.daemon_id))
  const input:LifecycleInput={ownerUserId:root?.user_id??null,scope:demo?'demo':(p.historical_team||rows.some(row=>row.team_bound))?'team':'personal',activityAt:latestAt??root?.activity_time??null,
    activityVerified:stale||(root?.activity_verified??false),staleSnapshot:stale,status:root?.status??null,turnActive:!!root?.turn_started_at,archiveReason:root?.archive_reason??null,
    contentState:coolingOwned?'hot':root?.content_state??'hot',dependencyActivityAt:stale?[]:rows.map(row=>row.activity_time??null),
    historical:!!config.effectiveAt&&rows.some(row=>row.activity_time&&timestampMicros(row.activity_time)<timestampMicros(config.effectiveAt!)),blockers:[...blocked]}
  return {root,members:rows,sessionIds:ids,evaluatedAt:clock,prediction:evaluateLifecycle(input,clock,config),eventCount:statistics?.event_count??null,hotEventBytes:statistics?.event_bytes??null,hotDocumentBytes:statistics?.document_bytes??null,staleEvidence:stale?{activityAt:latestAt!,pendingEffects:p.pending_effects,pendingInbox:p.pending_inbox,states:Object.fromEntries([...rows.map(row=>[row.session_id,row.status]),...[...bucketRows.values()].map(row=>[`${row.parent_session_id}:${row.agent_id}`,row.status])])}:undefined}
}
