import type pg from 'pg'
import {createHash} from 'node:crypto'
import type {CurationMode} from '../curation/contracts.js'
import type {SceneDestination} from './scene-resolver.js'
export interface LifecycleFrame {spaceId:string|null;spaceRevision:string|null;destination:SceneDestination;policyRevision:string;authorizationEpoch:string;sessionId:string;binding:string;consume:boolean}
export type LifecycleReadFrame=Pick<LifecycleFrame,'spaceId'|'spaceRevision'|'destination'|'policyRevision'|'authorizationEpoch'|'consume'>
export async function listLifecycleReadScenes(pool:Pick<pg.Pool,'query'>,installationId:string){
 const rows=(await pool.query(`SELECT s.space_id::text AS id,s.name,s.domain,s.destinations FROM memory_spaces s
  JOIN memory_owner_scopes o USING(installation_id) WHERE s.installation_id=$1 AND s.state='active' AND o.state='active' AND o.owner_scope_kind='personal'
  ORDER BY s.name,s.space_id LIMIT 101`,[installationId])).rows
 return{scenes:rows.slice(0,100),has_more:rows.length>100}
}
/** Authenticated stateless search/recall resolves scene metadata without
 * changing any active Session's binding or invalidating its Context packs. */
export async function resolveLifecycleReadFrame(pool:Pick<pg.Pool,'query'>,input:{installationId:string;repositoryId?:string|null;spaceId?:string|null;destination?:SceneDestination;mode:CurationMode}):Promise<LifecycleReadFrame|undefined>{
 if(input.mode!=='enabled')return undefined
 const destination=input.destination??'personal'
 const rows=(await pool.query(`SELECT s.space_id::text,s.revision::text AS space_revision,p.revision::text AS policy_revision,o.authorization_epoch::text
  FROM memory_spaces s JOIN memory_curation_policies p USING(installation_id) JOIN memory_owner_scopes o USING(installation_id)
  JOIN memory_installations i USING(installation_id)
  WHERE s.installation_id=$1 AND s.state='active' AND $4=ANY(s.destinations) AND p.consume_mode='enabled'
   AND o.owner_scope_kind='personal' AND o.state='active' AND i.relay_status='active' AND i.local_status='ready'
   AND($3::uuid IS NULL OR EXISTS(SELECT 1 FROM repositories r WHERE r.installation_id=s.installation_id AND r.repository_id=$3
    AND NOT EXISTS(SELECT 1 FROM memory_repository_tombstones t WHERE t.installation_id=r.installation_id AND t.repository_id=r.repository_id)))
   AND(($2::uuid IS NOT NULL AND s.space_id=$2) OR($2::uuid IS NULL AND EXISTS(SELECT 1 FROM memory_space_bindings b WHERE b.installation_id=s.installation_id AND b.space_id=s.space_id AND b.repository_id=$3)))
  ORDER BY s.space_id LIMIT 2`,[input.installationId,input.spaceId??null,input.repositoryId??null,destination])).rows
 if(rows.length!==1)return undefined
 const r=rows[0];return{spaceId:r.space_id,spaceRevision:r.space_revision,destination,policyRevision:r.policy_revision,authorizationEpoch:r.authorization_epoch,consume:true}
}
/** Called inside the already authenticated installation/session boundary. Only
 * registered repository bindings may resolve a missing scene hint. */
export async function resolveLifecycleFrame(pool:pg.Pool,input:{installationId:string;sessionId:string;repositoryId:string|null;spaceId?:string|null;destination?:SceneDestination;mode:CurationMode}):Promise<LifecycleFrame|undefined>{
 if(input.mode==='off')return undefined
 const c=await pool.connect()
 try{await c.query('BEGIN')
  const destination=input.destination??'personal'
  const p=(await c.query<{
   revision:string;consume_mode:string;authorization_epoch:string;stored_binding:string|null;scenes:Array<{space_id:string;revision:string}>
  }>(`WITH policy AS MATERIALIZED (
   SELECT p.installation_id,p.revision::text,p.consume_mode,o.authorization_epoch::text
   FROM memory_curation_policies p JOIN memory_owner_scopes o USING(installation_id)
   WHERE p.installation_id=$1 AND o.owner_scope_kind='personal' AND o.state='active' FOR SHARE OF p,o
  ), resolved AS MATERIALIZED (
  SELECT policy.*,COALESCE((
   SELECT jsonb_agg(scene ORDER BY scene.space_id) FROM (
    SELECT s.space_id::text,s.revision::text FROM memory_spaces s
    WHERE s.installation_id=policy.installation_id AND s.state='active' AND $4=ANY(s.destinations)
     AND (($2::uuid IS NOT NULL AND s.space_id=$2) OR ($2::uuid IS NULL AND EXISTS(
      SELECT 1 FROM memory_space_bindings b WHERE b.installation_id=s.installation_id
       AND b.space_id=s.space_id AND b.repository_id=$3)))
    ORDER BY s.space_id LIMIT 2 FOR SHARE OF s
   ) scene
  ),'[]'::jsonb) AS scenes FROM policy
  )
  SELECT resolved.*,(SELECT f.binding FROM memory_session_scene_frames f
   WHERE f.installation_id=resolved.installation_id AND f.session_id=$5 FOR NO KEY UPDATE) AS stored_binding
  FROM resolved`,[input.installationId,input.spaceId??null,input.repositoryId,destination,input.sessionId])).rows[0]
  if(!p){await c.query('COMMIT');return undefined}
  const scene=p.scenes.length===1?p.scenes[0]:null
  const value={spaceId:scene?.space_id??null,spaceRevision:scene?.revision??null,destination,policyRevision:p.revision,authorizationEpoch:p.authorization_epoch,sessionId:input.sessionId,consume:input.mode==='enabled'&&p.consume_mode==='enabled'}
  const binding=createHash('sha256').update(JSON.stringify(value)).digest('hex')
  if(p.stored_binding!==binding)await c.query(`INSERT INTO memory_session_scene_frames(installation_id,session_id,binding) VALUES($1,$2,$3) ON CONFLICT(installation_id,session_id) DO UPDATE SET binding=EXCLUDED.binding WHERE memory_session_scene_frames.binding<>EXCLUDED.binding`,[input.installationId,input.sessionId,binding])
  await c.query('COMMIT');return {...value,binding}
 }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
}
export async function lifecycleFrameCurrent(c:Pick<pg.Pool,'query'>,installationId:string,frame:LifecycleFrame|undefined,mode:CurationMode='enabled'):Promise<boolean>{
 if(!frame)return true
 if(frame.consume&&mode!=='enabled')return false
 const row=(await c.query(`SELECT EXISTS(SELECT 1 FROM memory_session_scene_frames f JOIN memory_curation_policies p USING(installation_id) JOIN memory_owner_scopes o USING(installation_id)
 WHERE f.installation_id=$1 AND f.session_id=$2 AND f.binding=$3 AND p.revision=$4 AND o.state='active' AND o.authorization_epoch=$5
 AND ($6::uuid IS NULL OR EXISTS(SELECT 1 FROM memory_spaces s WHERE s.installation_id=f.installation_id AND s.space_id=$6 AND s.revision=$7 AND s.state='active' AND $8=ANY(s.destinations)))) AS valid`,[installationId,frame.sessionId,frame.binding,frame.policyRevision,frame.authorizationEpoch,frame.spaceId,frame.spaceRevision,frame.destination])).rows[0]
 return row?.valid===true
}
/** SQL metadata gate precedes lexical/vector ranking and body hydration. */
export function lifecycleClaimSql(spaceParam:string,destinationParam:string,consumeParam:string,claim='c',version='v'):string{return `
 NOT EXISTS(SELECT 1 FROM memory_claim_lifecycle lc WHERE lc.installation_id=${claim}.installation_id AND lc.claim_id=${claim}.claim_id AND (lc.storage_tier<>'hot' OR lc.body_state<>'present' OR lc.assertion_mode='planned'))
 AND (NOT EXISTS(SELECT 1 FROM memory_logical_claims logical WHERE logical.installation_id=${claim}.installation_id AND logical.claim_id=${claim}.claim_id)
 OR (${consumeParam}::boolean AND EXISTS(SELECT 1 FROM memory_logical_claims logical JOIN memory_spaces space USING(installation_id,space_id)
 JOIN memory_curation_policies cp USING(installation_id) JOIN memory_owner_scopes owner USING(installation_id)
 WHERE logical.installation_id=${claim}.installation_id AND logical.claim_id=${claim}.claim_id AND logical.space_id=${spaceParam}::uuid AND space.state='active' AND ${destinationParam}::text=ANY(space.destinations)
 AND cp.consume_mode='enabled' AND owner.state='active' AND owner.owner_scope_kind='personal')))
 AND COALESCE(to_jsonb(${version})->>'body_state','present')='present'`}

/** A session switch invalidates only that session. Evaluated in the final
 * consume UPDATE snapshot rather than relying on an earlier async check. */
export function lifecycleFrameFenceSql(pack='p'):string{return `(
 ${pack}.query_context->'lifecycle' IS NULL OR ${pack}.query_context->'lifecycle'='null'::jsonb OR
 EXISTS(SELECT 1 FROM memory_session_scene_frames lifecycle_frame
 WHERE lifecycle_frame.installation_id=${pack}.installation_id AND lifecycle_frame.session_id=${pack}.session_id
 AND lifecycle_frame.binding=${pack}.query_context->'lifecycle'->>'binding'))`}
