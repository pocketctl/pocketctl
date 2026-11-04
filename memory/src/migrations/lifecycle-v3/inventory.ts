import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import type pg from 'pg'
export const LIFECYCLE_POLICY_VERSION='memory-lifecycle-v1'
export type LifecycleMode='off'|'shadow'|'enabled'
export interface InventoryItem {installationId:string;claimId:string;revision:string;currentVersionId:string|null;state:string;authority:string|null;claimType:string;fingerprint:string;sourceState:'reclaimed'|'unproven';collision:boolean}
export interface LifecycleManifest {format:1;toolHash:string;policyVersion:string;schema:number;createdAt:string;installationIds:string[];targetMode:LifecycleMode;policies:Array<{installationId:string;revision:string;mode:LifecycleMode;authorizationEpoch:string}>;sourceWatermark:string;deletionWatermark:string;items:InventoryItem[];candidateStates:Record<string,number>;limitations:string[]}
export const sha256=(value:string)=>createHash('sha256').update(value).digest('hex')
export function canonical(value:unknown):string {if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';return JSON.stringify(value)}
export const migrationToolHash=()=>sha256(['inventory','backfill','verification','migration'].map(name=>readFileSync(new URL('./'+name+(import.meta.url.endsWith('.ts')?'.ts':'.js'),import.meta.url),'utf8')).join('\n'))
export const manifestDigest=(manifest:LifecycleManifest)=>sha256(canonical(manifest))
export async function deletionWatermark(c:Pick<pg.PoolClient,'query'>,ids:string[]):Promise<string>{
 const rows=(await c.query(`SELECT 'claim' kind,to_jsonb(t)::text body FROM knowledge_tombstones t WHERE installation_id=ANY($1::uuid[])
 UNION ALL SELECT 'session',to_jsonb(t)::text FROM memory_session_tombstones t WHERE installation_id=ANY($1::uuid[])
 UNION ALL SELECT 'logical',to_jsonb(t)::text FROM memory_logical_tombstones t WHERE installation_id=ANY($1::uuid[])
 UNION ALL SELECT 'reclaimed_version',jsonb_build_object('installation_id',installation_id,'version_id',version_id,'body_hash',body_hash,'body_reclaimed_at',body_reclaimed_at)::text FROM knowledge_versions WHERE installation_id=ANY($1::uuid[]) AND body_state='reclaimed' ORDER BY kind,body`,[ids])).rows
 return sha256(canonical(rows))
}
export async function readItem(c:Pick<pg.PoolClient,'query'>,installationId:string,claimId:string,lock=false):Promise<InventoryItem|null>{
 const r=(await c.query(`SELECT c.*,to_jsonb(c)::text AS claim_snapshot, v.authority,
 (SELECT to_jsonb(vv)::text FROM knowledge_versions vv WHERE vv.installation_id=c.installation_id AND vv.version_id=c.current_version_id) AS version_snapshot,
 EXISTS(SELECT 1 FROM knowledge_evidence e JOIN work_episodes w USING(installation_id,episode_id) WHERE e.installation_id=c.installation_id AND e.version_id=c.current_version_id AND w.body_reclaimed_at IS NOT NULL) AS reclaimed,
 EXISTS(SELECT 1 FROM knowledge_claims other WHERE other.installation_id=c.installation_id AND other.claim_id<>c.claim_id AND other.state='active' AND other.normalized_key=c.normalized_key AND other.scope_kind=c.scope_kind AND other.scope_key=c.scope_key) AS collision
 FROM knowledge_claims c LEFT JOIN knowledge_versions v ON v.installation_id=c.installation_id AND v.version_id=c.current_version_id
 WHERE c.installation_id=$1 AND c.claim_id=$2 ${lock?'FOR UPDATE OF c':''}`,[installationId,claimId])).rows[0]
 if(!r)return null
 return {installationId,claimId,revision:String(r.revision),currentVersionId:r.current_version_id,state:r.state,authority:r.authority,claimType:r.claim_type,fingerprint:sha256(canonical([r.claim_snapshot,r.version_snapshot])),sourceState:r.reclaimed?'reclaimed':'unproven',collision:r.collision}
}
/** A repeatable-read, read-only snapshot. No policy rows, jobs, models or sources are written. */
export async function inventoryLifecycle(pool:pg.Pool,ids:string[],options:{targetMode?:LifecycleMode}={}):Promise<LifecycleManifest>{
 if(!ids.length||new Set(ids).size!==ids.length||ids.some(id=>! /^[0-9a-f-]{36}$/i.test(id)))throw new Error('fixed_owner_list_required')
 const targetMode=options.targetMode??'shadow';if(!['off','shadow','enabled'].includes(targetMode))throw new Error('invalid_target_mode')
 const c=await pool.connect()
 try{await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await c.query("SET LOCAL statement_timeout='30s'")
  const policies=(await c.query(`SELECT p.installation_id AS "installationId",p.revision::text,p.mode,s.authorization_epoch::text AS "authorizationEpoch" FROM memory_curation_policies p JOIN memory_owner_scopes s USING(installation_id) WHERE p.installation_id=ANY($1::uuid[]) AND p.policy_version=$2 AND s.state='active' AND s.owner_scope_kind='personal' ORDER BY p.installation_id`,[ids,LIFECYCLE_POLICY_VERSION])).rows
  if(policies.length!==ids.length)throw new Error('existing_personal_policy_required')
  const items:InventoryItem[]=[]
  const keys=(await c.query('SELECT installation_id,claim_id FROM knowledge_claims WHERE installation_id=ANY($1::uuid[]) ORDER BY installation_id,claim_id',[ids])).rows
  for(const k of keys)items.push((await readItem(c,k.installation_id,k.claim_id))!)
  const candidateStates=Object.fromEntries((await c.query('SELECT status,count(*)::int n FROM memory_candidates WHERE installation_id=ANY($1::uuid[]) GROUP BY status',[ids])).rows.map(r=>[r.status,r.n]))
  const m:LifecycleManifest={format:1,toolHash:migrationToolHash(),policyVersion:LIFECYCLE_POLICY_VERSION,schema:Number((await c.query('SELECT max(version) version FROM memory_schema_migrations')).rows[0].version),createdAt:(await c.query('SELECT CURRENT_TIMESTAMP::text ts')).rows[0].ts,installationIds:[...ids].sort(),targetMode,policies,items,candidateStates,sourceWatermark:(await c.query('SELECT coalesce(max(feed_id),0)::text n FROM memory_feed_inbox WHERE installation_id=ANY($1::uuid[])',[ids])).rows[0].n,deletionWatermark:await deletionWatermark(c,ids),limitations:['Metadata-only migration; source recoverability without complete trusted provenance is unproven and never schedules re-extraction.','Claims, candidate decisions, bodies, versions and user scope remain unchanged.','Rollback changes processing ownership only; reclaimed source bodies cannot be restored by this manifest.']}
  await c.query('COMMIT');return m
 }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
}
