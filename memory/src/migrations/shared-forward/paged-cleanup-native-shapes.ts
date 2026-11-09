import type pg from 'pg'
import {permissionsForMirrorRoles} from '../../governance/role-permissions.js'
import {pagedHash,type PagedCleanupRecord} from './paged-cleanup-manifest.js'
const permissions=new Set(permissionsForMirrorRoles(['scope_administrator']))
const keys=(value:unknown,names:readonly string[])=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===names.length&&Object.keys(value).every(key=>names.includes(key))
/** Classify the exact body-free safeGrant written by skills/repository.ts.
 * It is retained history, never a restored authorization or read grant. */
export async function bindPagedSkillGrants(c:pg.Client,records:PagedCleanupRecord[]){
 const selected=records.filter(r=>r.table==='memory_skill_task_runs');if(!selected.length)return
 const rows=(await c.query(`SELECT r.run_id::text,r.installation_id::text,r.owner_scope_kind,r.authorization_epoch::text,o.owner_scope_id::text,
  CASE WHEN octet_length(r.grant_snapshot::text)<=32768 THEN r.grant_snapshot ELSE NULL END AS grant
  FROM memory.memory_skill_task_runs r JOIN memory.memory_owner_scopes o USING(installation_id) WHERE r.run_id=ANY($1::uuid[])`,[selected.map(r=>r.key.run_id)])).rows
 if(rows.length!==selected.length)throw Error('paged_skeleton_grant_unclassified')
 for(const row of rows){const grant=row.grant
  if(row.owner_scope_kind!=='personal'||!grant||typeof grant!=='object'||Array.isArray(grant))throw Error('paged_skeleton_grant_unclassified')
  if(Object.keys(grant).length){
   if(!keys(grant,['primaryInstallationId','configVersion','scopeBindings'])||grant.primaryInstallationId!==row.installation_id||typeof grant.configVersion!=='string'||!/^[1-9][0-9]{0,18}$/.test(grant.configVersion)||!Array.isArray(grant.scopeBindings)||grant.scopeBindings.length!==1)throw Error('paged_skeleton_grant_unclassified')
   const b=grant.scopeBindings[0]
   if(!keys(b,['installation_id','owner_scope_kind','owner_scope_id','membership_id','membership_revision','authorization_epoch','permissions'])||b.installation_id!==row.installation_id||b.owner_scope_kind!=='personal'||b.owner_scope_id!==row.owner_scope_id||b.membership_id!==null||b.membership_revision!=='0'||b.authorization_epoch!==row.authorization_epoch||!Array.isArray(b.permissions)||new Set(b.permissions).size!==b.permissions.length||b.permissions.some((p:unknown)=>typeof p!=='string'||!permissions.has(p)))throw Error('paged_skeleton_grant_unclassified')
  }
  selected.find(r=>r.key.run_id===row.run_id)!.references.native_grant_policy_hash=pagedHash('native-personal-safe-grant-v1')
 }
}
/** Native jobs retain only their actual typed metadata. Unknown request/body
 * keys are refused rather than wiped or silently called historical audit. */
export async function assertPagedJobPayloads(c:pg.Client,records:readonly PagedCleanupRecord[]){
 const selected=records.filter(r=>r.table==='memory_jobs');if(!selected.length)return
 const runIds=records.filter(r=>r.table==='memory_skill_task_runs').map(r=>r.key.run_id),versionIds=records.filter(r=>r.table==='knowledge_versions').map(r=>r.key.version_id)
 if((await c.query(`SELECT 1 FROM memory.memory_jobs j JOIN jsonb_array_elements($1::jsonb) item ON(
  CASE WHEN item->'key'?'job_id' THEN j.job_id::text=item->'key'->>'job_id'
   ELSE j.installation_id::text=item->'key'->>'installation_id' AND j.job_type=item->'key'->>'job_type' AND j.idempotency_key=item->'key'->>'idempotency_key' END)
  WHERE NOT COALESCE(jsonb_typeof(j.payload)='object' AND(
   j.job_type='extract_skill_candidate' AND j.payload-ARRAY['task_id','generation']='{}'::jsonb AND EXISTS(SELECT 1 FROM memory.memory_skill_task_runs r WHERE r.run_id=ANY($2::uuid[]) AND r.installation_id=j.installation_id AND r.task_id::text=j.payload->>'task_id' AND r.generation::text=j.payload->>'generation')
   OR j.job_type='index_claim_version' AND j.payload-ARRAY['version_id']='{}'::jsonb AND j.payload->>'version_id'=ANY($3::text[])),false) LIMIT 1`,[JSON.stringify(selected),runIds,versionIds])).rowCount)throw Error('paged_native_job_payload_unclassified')
}
