import type pg from 'pg'
import type {PagedRoot} from './paged-cleanup-authority.js'
/** Metadata-loss authority uses native writer fences, never a positive body
 * reader grant. The current v4 adapter admits direct personal roots only. */
export async function pagedNativeFenceFacts(c:pg.Client,roots:readonly PagedRoot[]){
 const capture=(await c.query(`SELECT (to_jsonb(s)->>'capture_version')='2' AND (to_jsonb(s)->>'session_capture_version')='1' AS ready FROM shared.memory_source_contract s WHERE singleton`)).rows[0]
 const eventTriggers=(await c.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid='public.events'::regclass AND tgenabled IN('O','A') AND(
  tgname='memory_source_capture_insert' AND tgtype=4 AND tgfoid=to_regprocedure('shared.capture_memory_relay_events()') OR
  tgname='memory_source_capture_update' AND tgtype=16 AND tgfoid=to_regprocedure('shared.capture_memory_relay_events()') OR
  tgname='memory_source_capture_delete' AND tgtype=8 AND tgfoid=to_regprocedure('shared.capture_memory_relay_events()') OR
  tgname='memory_source_capture_body_marker' AND tgtype=19 AND tgfoid=to_regprocedure('shared.mark_memory_event_body_write()'))`)).rows[0].n
 if(!capture?.ready||eventTriggers!==4)throw Error('paged_native_capture_required')
 const facts=(await c.query(`SELECT r."installationId"::text AS installation_id,r."sessionId" AS session_id,i.owner_user_id::text AS owner_id,
  w.source_kind,w.root_key,w.revision::text,w.storage_revision::text
  FROM jsonb_to_recordset($1::jsonb) r("installationId" uuid,"sessionId" text)
  JOIN public.extension_installations i ON i.installation_id=r."installationId" AND i.owner_scope_kind='personal'
  JOIN public.sessions s ON s.session_id=r."sessionId" AND s.user_id=i.owner_user_id
  JOIN shared.memory_source_work w ON w.source_kind='relay_event' AND w.root_key=i.owner_user_id::text||':'||r."sessionId"
  WHERE i.owner_user_id>0 AND NOT EXISTS(SELECT 1 FROM public.session_aliases a WHERE a.old_session_id=r."sessionId" OR a.next_session_id=r."sessionId")
  ORDER BY i.owner_user_id,r."sessionId" COLLATE "C",r."installationId"`,[JSON.stringify(roots)])).rows as {installation_id:string;session_id:string;owner_id:string;source_kind:string;root_key:string;revision:string;storage_revision:string}[]
 if(facts.length!==roots.length)throw Error('paged_native_root_identity_unproved')
 return facts
}
export async function lockPagedNativeAuthority(c:pg.Client,roots:readonly PagedRoot[]){
 const facts=await pagedNativeFenceFacts(c,roots),owners=[...new Set(facts.map(r=>r.owner_id))].sort((a,b)=>Number(a)-Number(b)),installations=[...new Set(facts.map(r=>r.installation_id))].sort()
 for(const owner of owners)if(!(await c.query('SELECT pg_try_advisory_xact_lock_shared($1::bigint) AS held',[owner])).rows[0].held)throw Error('paged_native_owner_fence_busy')
 if(!(await c.query('SELECT shared.lock_memory_grant_authority($1::uuid[],ARRAY[]::uuid[]) AS held',[installations])).rows[0].held)throw Error('paged_native_grant_fence_busy')
 await c.query(`SELECT d.daemon_id FROM public.daemons d WHERE d.daemon_id IN(SELECT s.daemon_id FROM public.sessions s WHERE s.session_id=ANY($1::text[])) ORDER BY d.daemon_id FOR SHARE NOWAIT`,[facts.map(r=>r.session_id)])
 const sessions=(await c.query('SELECT DISTINCT session_id COLLATE "C" AS session_id FROM unnest($1::text[]) session_id ORDER BY session_id',[facts.map(r=>r.session_id)])).rows
 for(const row of sessions)if(!(await c.query('SELECT pg_try_advisory_xact_lock_shared(1885566061,hashtext($1)) AS held',[row.session_id])).rows[0].held)throw Error('paged_native_session_fence_busy')
 // Existing purge Session -> installation order. All acquisition is nonblocking.
 for(const fact of facts)if(!(await c.query("SELECT pg_try_advisory_xact_lock(hashtextextended('purge:session:'||$1||':'||$2,0)) AS held",[fact.installation_id,fact.session_id])).rows[0].held)throw Error('paged_native_purge_fence_busy')
 for(const installation of installations)if(!(await c.query("SELECT pg_try_advisory_xact_lock(hashtextextended('purge:installation:'||$1,0)) AS held",[installation])).rows[0].held)throw Error('paged_native_purge_fence_busy')
 for(const fact of facts)if(!(await c.query("SELECT pg_try_advisory_xact_lock_shared(hashtextextended('memory-source-dirty:relay_event:'||$1,0)) AS held",[fact.root_key])).rows[0].held)throw Error('paged_native_root_fence_busy')
 await c.query("SELECT root_key FROM shared.memory_source_work WHERE source_kind='relay_event' AND root_key=ANY($1::text[]) ORDER BY root_key COLLATE \"C\" FOR SHARE NOWAIT",[facts.map(r=>r.root_key)])
}
