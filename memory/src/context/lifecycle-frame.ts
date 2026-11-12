import type pg from 'pg'
import {createHash} from 'node:crypto'
import type {CurationMode} from '../curation/contracts.js'
import type {SceneDestination} from './scene-resolver.js'
import {lockCurrentRelayAuthority} from '../sources/current-grant.js'
import {isPhysicalSourcePool,sourcePoolContext,type SourcePoolContext} from '../sources/pool-context.js'
export interface LifecycleFrame {spaceId:string|null;spaceRevision:string|null;destination:SceneDestination;policyRevision:string;authorizationEpoch:string;sessionId:string;binding:string;consume:boolean}
export type LifecycleReadFrame=Pick<LifecycleFrame,'spaceId'|'spaceRevision'|'destination'|'policyRevision'|'authorizationEpoch'|'consume'>
type Namespace = SourcePoolContext['namespace']

function nativePersonalSceneOwner(installation: string): string {
 return `SELECT (current.state->>'authorization_epoch')::bigint AS authorization_epoch,
    current.state->>'config_version' AS config_version,current.state->>'owner_user_id' AS owner_user_id
  FROM shared.memory_current_grant_states(ARRAY[${installation}::uuid],ARRAY[]::uuid[]) current
  WHERE current.state->>'owner_scope_kind'='personal' AND current.state->>'status'='active'
   AND (current.state->>'owner_exists')::boolean AND (current.state->>'provider_enabled')::boolean`
}

function sceneOwnerJoin(installation: string, namespace: Namespace): string {
 if(namespace==='memory')return `JOIN LATERAL (${nativePersonalSceneOwner(installation)}) owner ON TRUE`
 return `JOIN memory_owner_scopes owner ON owner.installation_id=${installation}
   AND owner.state='active' AND owner.owner_scope_kind='personal'`
}

export async function listLifecycleReadScenes(pool:Pick<pg.Pool,'query'>,installationId:string){
 const namespace=sourcePoolContext(pool).namespace
 const rows=(await pool.query(`SELECT s.space_id::text AS id,s.name,s.domain,s.destinations FROM memory_spaces s
  ${sceneOwnerJoin('$1',namespace)}
  WHERE s.installation_id=$1 AND s.state='active'
   ${namespace==='memory'?`AND EXISTS(SELECT 1 FROM memory_installations i WHERE i.installation_id=$1
     AND i.local_status NOT IN('purging','purged','integrity_error'))`:''}
  ORDER BY s.name,s.space_id LIMIT 101`,[installationId])).rows
 return{scenes:rows.slice(0,100),has_more:rows.length>100}
}
/** Authenticated stateless search/recall resolves scene metadata without
 * changing any active Session's binding or invalidating its Context packs. */
export async function resolveLifecycleReadFrame(pool:Pick<pg.Pool,'query'>,input:{installationId:string;repositoryId?:string|null;spaceId?:string|null;destination?:SceneDestination;mode:CurationMode;lock?:true}):Promise<LifecycleReadFrame|undefined>{
 if(input.mode!=='enabled')return undefined
 const destination=input.destination??'personal'
 const namespace=sourcePoolContext(pool).namespace
 const rows=(await pool.query(`SELECT s.space_id::text,s.revision::text AS space_revision,p.revision::text AS policy_revision,owner.authorization_epoch::text
  FROM memory_spaces s JOIN memory_curation_policies p USING(installation_id)
  JOIN memory_installations i USING(installation_id)
  ${sceneOwnerJoin('$1',namespace)}
  WHERE s.installation_id=$1 AND s.state='active' AND $4=ANY(s.destinations) AND p.consume_mode='enabled'
   AND i.local_status='ready' ${namespace==='public'?"AND i.relay_status='active'":''}
   AND($3::uuid IS NULL OR EXISTS(SELECT 1 FROM repositories r WHERE r.installation_id=s.installation_id AND r.repository_id=$3
    AND NOT EXISTS(SELECT 1 FROM memory_repository_tombstones t WHERE t.installation_id=r.installation_id AND t.repository_id=r.repository_id)))
   AND(($2::uuid IS NOT NULL AND s.space_id=$2) OR($2::uuid IS NULL AND EXISTS(SELECT 1 FROM memory_space_bindings b WHERE b.installation_id=s.installation_id AND b.space_id=s.space_id AND b.repository_id=$3)))
  ORDER BY s.space_id LIMIT 2 ${input.lock?'FOR SHARE OF p,s NOWAIT':''}`,[input.installationId,input.spaceId??null,input.repositoryId??null,destination])).rows
 if(rows.length!==1)return undefined
 const r=rows[0];return{spaceId:r.space_id,spaceRevision:r.space_revision,destination,policyRevision:r.policy_revision,authorizationEpoch:r.authorization_epoch,consume:true}
}
/** Recheck an enabled stateless frame under the retained-read authority lock. */
export async function lifecycleReadFrameCurrent(db:Pick<pg.Pool,'query'>,input:{
 installationId:string;repositoryId?:string|null;lifecycle?:LifecycleReadFrame
}):Promise<boolean>{
 const frame=input.lifecycle
 if(sourcePoolContext(db).namespace!=='memory'||!frame?.consume||!frame.spaceId)return true
 const current=await resolveLifecycleReadFrame(db,{
  installationId:input.installationId,repositoryId:input.repositoryId,spaceId:frame.spaceId,
  destination:frame.destination,mode:'enabled',lock:true,
 })
 return !!current&&current.authorizationEpoch===frame.authorizationEpoch
  &&current.policyRevision===frame.policyRevision&&current.spaceRevision===frame.spaceRevision
}

/** Called inside the already authenticated installation/session boundary. Only
 * registered repository bindings may resolve a missing scene hint. */
export async function resolveLifecycleFrame(pool:pg.Pool,input:{installationId:string;sessionId:string;repositoryId:string|null;spaceId?:string|null;destination?:SceneDestination;mode:CurationMode;authorityGrant?:{configVersion:string;userId?:number;expiresAt?:number}}):Promise<LifecycleFrame|undefined>{
 if(input.mode==='off')return undefined
 const namespace=sourcePoolContext(pool).namespace
 const physical=isPhysicalSourcePool(pool)
 const expiresAt=namespace==='memory'?input.authorityGrant?.expiresAt??null:null
 const timeouts="SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='1s'"
 const c=await pool.connect()
 try{
  await c.query(physical?`BEGIN; ${timeouts}`:'BEGIN')
  if(namespace==='memory'){
   if(!physical)await c.query(timeouts)
   if(!await lockCurrentRelayAuthority(c,[input.installationId])){
    await c.query('ROLLBACK')
    return undefined
   }
  }
  const destination=input.destination??'personal'
  const p=(await c.query<{
   revision:string;consume_mode:string;authorization_epoch:string;stored_binding:string|null;scenes:Array<{space_id:string;revision:string}>
  }>(`WITH ${namespace==='memory'?`installation AS MATERIALIZED (
   SELECT installation_id FROM memory_installations WHERE installation_id=$1 AND local_status='ready' FOR SHARE
  ), `:''}policy AS MATERIALIZED (
   SELECT p.installation_id,p.revision::text,p.consume_mode,owner.authorization_epoch::text
   FROM ${namespace==='memory'?'installation i JOIN memory_curation_policies p USING(installation_id)':'memory_curation_policies p'}
   ${sceneOwnerJoin('$1',namespace)}
   WHERE p.installation_id=$1 ${namespace==='memory'?`AND ($6::text IS NULL OR owner.config_version=$6)
    AND ($7::text IS NULL OR owner.owner_user_id=$7)
    AND ($8::double precision IS NULL OR clock_timestamp()<to_timestamp($8::double precision))`:''}
   FOR SHARE OF ${namespace==='memory'?'p':'p,owner'}
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
  FROM resolved`,[input.installationId,input.spaceId??null,input.repositoryId,destination,input.sessionId,
   ...(namespace==='memory'?[input.authorityGrant?.configVersion??null,input.authorityGrant?.userId?.toString()??null,expiresAt]:[]),
  ])).rows[0]
  if(!p){await c.query('COMMIT');return undefined}
  const scene=p.scenes.length===1?p.scenes[0]:null
  const value={spaceId:scene?.space_id??null,spaceRevision:scene?.revision??null,destination,policyRevision:p.revision,authorizationEpoch:p.authorization_epoch,sessionId:input.sessionId,consume:input.mode==='enabled'&&p.consume_mode==='enabled'}
  const binding=createHash('sha256').update(JSON.stringify(value)).digest('hex')
  if(p.stored_binding!==binding){
   const validClock='($4::double precision IS NULL OR clock_timestamp()<to_timestamp($4::double precision))'
   const keys=[input.installationId,input.sessionId,binding]
   const written=await c.query<{alive:boolean}>(`INSERT INTO memory_session_scene_frames(installation_id,session_id,binding)
    ${namespace==='memory'?`SELECT $1,$2,$3 WHERE ${validClock}`:'VALUES($1,$2,$3)'}
    ON CONFLICT(installation_id,session_id) DO UPDATE SET binding=EXCLUDED.binding
    WHERE memory_session_scene_frames.binding<>EXCLUDED.binding
     ${namespace==='memory'?`AND ${validClock} RETURNING ${validClock} AS alive`:''}`,
   [...keys,...(namespace==='memory'?[expiresAt]:[])])
   if(namespace==='memory'){
    // The insert can wait on another transaction even when its first clock
    // check succeeded. A concurrent writer with the same binding is a no-op.
    const alive=written.rows[0]?.alive??(await c.query<{alive:boolean}>(`SELECT EXISTS(
     SELECT 1 FROM memory_session_scene_frames WHERE installation_id=$1 AND session_id=$2
       AND binding=$3 AND ${validClock}) AS alive`,[...keys,expiresAt])).rows[0]?.alive
    if(!alive){await c.query('ROLLBACK');return undefined}
   }
  }
  await c.query('COMMIT');return {...value,binding}
 }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
}
export async function lifecycleFrameCurrent(c:Pick<pg.Pool,'query'>,installationId:string,frame:LifecycleFrame|undefined,mode:CurationMode='enabled'):Promise<boolean>{
 if(!frame)return true
 if(frame.consume&&mode!=='enabled')return false
 const row=(await c.query(`SELECT EXISTS(SELECT 1 FROM memory_session_scene_frames f JOIN memory_curation_policies p USING(installation_id)
 ${sceneOwnerJoin('$1',sourcePoolContext(c).namespace)}
 WHERE f.installation_id=$1 AND f.session_id=$2 AND f.binding=$3 AND p.revision=$4 AND owner.authorization_epoch=$5
 AND ($6::uuid IS NULL OR EXISTS(SELECT 1 FROM memory_spaces s WHERE s.installation_id=f.installation_id AND s.space_id=$6 AND s.revision=$7 AND s.state='active' AND $8=ANY(s.destinations)))) AS valid`,[installationId,frame.sessionId,frame.binding,frame.policyRevision,frame.authorizationEpoch,frame.spaceId,frame.spaceRevision,frame.destination])).rows[0]
 return row?.valid===true
}
/** SQL metadata gate precedes lexical/vector ranking and body hydration. */
export function lifecycleClaimSql(spaceParam:string,destinationParam:string,consumeParam:string,claim='c',version='v',native?:{installation:string;epoch:string}):string{
 const owner=native?`EXISTS (SELECT 1 FROM (${nativePersonalSceneOwner(native.installation)}) owner
   WHERE owner.authorization_epoch::text=${native.epoch}::text)`
  :`EXISTS (SELECT 1 FROM memory_owner_scopes owner WHERE owner.installation_id=${claim}.installation_id
    AND owner.state='active' AND owner.owner_scope_kind='personal')`
 return `
 NOT EXISTS(SELECT 1 FROM memory_claim_lifecycle lc WHERE lc.installation_id=${claim}.installation_id AND lc.claim_id=${claim}.claim_id AND (lc.storage_tier<>'hot' OR lc.body_state<>'present' OR lc.assertion_mode='planned'))
 AND (NOT EXISTS(SELECT 1 FROM memory_logical_claims logical WHERE logical.installation_id=${claim}.installation_id AND logical.claim_id=${claim}.claim_id)
 OR (${consumeParam}::boolean AND ${owner} AND EXISTS(SELECT 1 FROM memory_logical_claims logical JOIN memory_spaces space USING(installation_id,space_id)
 JOIN memory_curation_policies cp USING(installation_id)
 WHERE logical.installation_id=${claim}.installation_id AND logical.claim_id=${claim}.claim_id AND logical.space_id=${spaceParam}::uuid AND space.state='active' AND ${destinationParam}::text=ANY(space.destinations)
 AND cp.consume_mode='enabled')))
 AND COALESCE(to_jsonb(${version})->>'body_state','present')='present'`}

/** A session switch invalidates only that session. Evaluated in the final
 * consume UPDATE snapshot rather than relying on an earlier async check. */
export function lifecycleFrameFenceSql(pack='p',mode:CurationMode='enabled',namespace:Namespace='public'):string{
 const frame=`(${pack}.query_context->'lifecycle')`
 return `(${frame} IS NULL OR ${frame}='null'::jsonb OR (
  (${mode==='enabled'?'TRUE':`${frame}->>'consume' IS DISTINCT FROM 'true'`})
  AND EXISTS(SELECT 1 FROM memory_session_scene_frames f
   JOIN memory_curation_policies cp USING(installation_id)
   ${sceneOwnerJoin('f.installation_id',namespace)}
   WHERE f.installation_id=${pack}.installation_id AND f.session_id=${pack}.session_id
    AND f.session_id=${frame}->>'sessionId' AND f.binding=${frame}->>'binding' AND cp.revision::text=${frame}->>'policyRevision'
    AND owner.authorization_epoch::text=${frame}->>'authorizationEpoch'
    AND (${frame}->>'spaceId' IS NULL OR EXISTS(
     SELECT 1 FROM memory_spaces s WHERE s.installation_id=f.installation_id
      AND s.space_id::text=${frame}->>'spaceId' AND s.revision::text=${frame}->>'spaceRevision'
      AND s.state='active' AND (${frame}->>'destination')=ANY(s.destinations))))))`
}
