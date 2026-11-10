import type pg from 'pg'
import {canonicalBundleJSON,verifyRevisionBundle,type SharedRevisionEvidence} from '../governance/revision-bundle.js'
import {readCurrentPolicyAuthority} from '../governance/current-policy-authority.js'
import {originPolicyDecisions,lockOriginPolicyFences,originPolicyFenceSql,type OriginPolicyFence} from '../governance/origin-policy.js'

type Db=Pick<pg.PoolClient,'query'>
export interface GovernedEvidenceBinding {evidence_id?:string;version_id?:string;episode_id?:string|null;evidence_kind?:string;source_event_id:string|null;artifact_id:string|null}

/** An exact target-side publication copy is retained on its reviewed bundle,
 * not on the synthetic episode's nonexistent raw-source manifest. Only bounded
 * already-sanitized snapshots are read; no raw source/body/archive permission
 * or provenance is inferred. The caller carries this check to its final read. */
export async function governedRetainedEvidence(client:Db,installationId:string,bindings:readonly GovernedEvidenceBinding[]):Promise<Set<string>>{
 const wanted=bindings.filter(row=>row.evidence_id&&row.episode_id&&row.evidence_kind==='episode'&&!row.source_event_id&&!row.artifact_id)
 if(!wanted.length)return new Set()
 const ids=[...new Set(wanted.map(row=>row.evidence_id!))].sort(),proved=new Set<string>()
 let remaining=8388608
 for(let start=0;start<ids.length;start+=64){
  const rows=(await client.query(`SELECT e.evidence_id::text,e.version_id::text,e.episode_id::text,e.ordinal,
   a.candidate_revision_id::text,c.owner_scope_kind,c.owner_scope_id::text,
   octet_length(pr.revision_bundle::text) AS bundle_bytes,octet_length(pr.structured_content::text)+octet_length(pr.statement) AS content_bytes,
   octet_length(e.excerpt)+octet_length(e.locator::text)+512 AS copy_bytes
   FROM knowledge_evidence e JOIN knowledge_versions v USING(installation_id,version_id)
   JOIN knowledge_claims c USING(installation_id,claim_id)
   JOIN work_episodes w ON w.installation_id=e.installation_id AND w.episode_id=e.episode_id
   JOIN memory_authority_records a ON a.installation_id=v.installation_id AND a.version_id=v.version_id
   JOIN memory_promotion_candidate_versions pr ON pr.candidate_revision_id=a.candidate_revision_id
   JOIN memory_promotion_candidates pc ON pc.candidate_id=pr.candidate_id AND pc.target_installation_id=v.installation_id
   WHERE e.installation_id=$1 AND e.evidence_id=ANY($2::uuid[])
    AND c.owner_scope_kind IN('team','organization') AND v.authority=c.owner_scope_kind||'_published'
    AND v.source_promotion_candidate_id=pc.candidate_id AND pc.state='published'
    AND v.statement=pr.statement AND v.structured_content IS NOT DISTINCT FROM pr.structured_content
    AND e.evidence_kind='episode' AND e.visibility='shared' AND e.source_event_id IS NULL AND e.artifact_id IS NULL AND e.capsule_id IS NULL
    AND w.session_id='shared-governance' AND w.turn_id='shared-'||c.claim_id::text AND w.compiler_version='phase3'
    AND pr.revision_bundle->>'schemaVersion'='2' AND pr.revision_bundle_hash IS NOT NULL
    AND a.source_scope_kind=pc.source_scope_kind AND a.source_content_hash=pc.source_content_hash
    AND a.source_content_hash=pr.revision_bundle->>'sourceContentHash'
    AND a.review_policy_version_id=pr.review_policy_version_id
    AND a.parent_review_policy_version_id IS NOT DISTINCT FROM pr.parent_review_policy_version_id
   ORDER BY e.evidence_id FOR SHARE OF e,v,c,w,a,pr,pc NOWAIT`,[installationId,ids.slice(start,start+64)])).rows
  if(!rows.length)continue
  const owner=await readCurrentPolicyAuthority(client,installationId)
  if(!owner||rows.some(row=>row.owner_scope_kind!==owner.scopeKind||row.owner_scope_id!==owner.ownerScopeId))throw Error('source_reference_unproven')
  for(const row of rows)if(wanted.some(binding=>binding.evidence_id===row.evidence_id&&(binding.episode_id!==row.episode_id||binding.version_id!==undefined&&binding.version_id!==row.version_id)))throw Error('source_reference_changed')
  const revisions=[...new Set(rows.map(row=>row.candidate_revision_id))].sort()
  const snapshots=(await client.query(`SELECT candidate_revision_id::text,ordinal,
   octet_length(excerpt)+octet_length(COALESCE(sanitized_locator::text,''))+512 AS evidence_bytes
   FROM memory_promotion_evidence WHERE candidate_revision_id=ANY($1::uuid[]) ORDER BY candidate_revision_id,ordinal FOR SHARE NOWAIT`,[revisions])).rows
  // Check the complete page budget before transferring JSON or excerpt bytes.
  const bundles=new Map(rows.map(row=>[row.candidate_revision_id,Number(row.bundle_bytes)+Number(row.content_bytes)]))
  remaining-=[...bundles.values()].reduce((sum,n)=>sum+n,0)+snapshots.reduce((sum,row)=>sum+Number(row.evidence_bytes),0)+rows.reduce((sum,row)=>sum+Number(row.copy_bytes),0)
  if(!Number.isFinite(remaining)||remaining<0)throw Error('source_reference_byte_limit')
  const versions=(await client.query(`SELECT candidate_revision_id::text,revision_bundle,revision_bundle_hash,statement,structured_content
   FROM memory_promotion_candidate_versions WHERE candidate_revision_id=ANY($1::uuid[]) ORDER BY candidate_revision_id FOR SHARE NOWAIT`,[revisions])).rows
  const evidence=(await client.query<SharedRevisionEvidence&{candidate_revision_id:string}>(`SELECT candidate_revision_id::text,ordinal,evidence_kind,excerpt,excerpt_hash,source_evidence_hash,occurred_at,sanitized_locator
   FROM memory_promotion_evidence WHERE candidate_revision_id=ANY($1::uuid[]) ORDER BY candidate_revision_id,ordinal FOR SHARE NOWAIT`,[revisions])).rows
  if(evidence.length!==snapshots.length||versions.length!==revisions.length||versions.some(version=>!verifyRevisionBundle(version,evidence.filter(row=>row.candidate_revision_id===version.candidate_revision_id))))throw Error('source_reference_unproven')
  const copies=(await client.query(`SELECT evidence_id::text,version_id::text,ordinal,excerpt,encode(excerpt_hash,'hex') AS excerpt_hash,source_evidence_hash,locator,occurred_at
   FROM knowledge_evidence WHERE installation_id=$1 AND evidence_id=ANY($2::uuid[]) ORDER BY evidence_id FOR SHARE NOWAIT`,[installationId,rows.map(row=>row.evidence_id)])).rows
  for(const row of rows){
   const copy=copies.find(copy=>copy.evidence_id===row.evidence_id),snapshot=evidence.find(item=>item.candidate_revision_id===row.candidate_revision_id&&item.ordinal===row.ordinal)
   if(!copy||!snapshot||copy.excerpt!==snapshot.excerpt||copy.excerpt_hash!==snapshot.excerpt_hash||copy.source_evidence_hash!==snapshot.source_evidence_hash
    ||canonicalBundleJSON(copy.locator)!==canonicalBundleJSON(snapshot.sanitized_locator??{})
    ||(copy.occurred_at?new Date(copy.occurred_at).toISOString():null)!==(snapshot.occurred_at?new Date(snapshot.occurred_at).toISOString():null))throw Error('source_reference_unproven')
  }
  const originVersions=rows.filter(row=>row.owner_scope_kind==='organization').map(row=>row.version_id)
  // Only Team-origin Organization copies need upstream policy authority.
  const required=(await client.query(`SELECT v.version_id::text FROM knowledge_versions v JOIN memory_authority_records a USING(installation_id,version_id)
   WHERE v.installation_id=$1 AND v.version_id=ANY($2::uuid[]) AND a.source_scope_kind='team'`,[installationId,originVersions])).rows.map(row=>row.version_id)
  const decisions=await originPolicyDecisions(client,installationId,required),fences:OriginPolicyFence[]=[]
  for(const id of required){const decision=decisions.get(id);if(!decision?.eligible)throw Error('source_reference_changed');fences.push(...decision.fences??[])}
  if(fences.length&&(!await lockOriginPolicyFences(client as pg.PoolClient,fences,'memory')||!(await client.query(`SELECT ${originPolicyFenceSql('$1','memory')} AS valid`,[JSON.stringify(fences)])).rows[0]?.valid))throw Error('source_reference_changed')
  const deliveries:unknown[]=[]
  for(const copy of copies){
   const provenance=copy.locator?.source_provenance
   if(provenance?.source_kind!=='team_session')continue
   const version=provenance.source_version
   if(version!==1&&version!=='1'&&version!==2&&version!=='2')throw Error('source_reference_unproven')
   if(version===2||version==='2')deliveries.push({team_id:provenance.team_id,team_session_id:provenance.team_session_id,submission_id:provenance.accepted_delivery?.submission_id,decision_id:provenance.accepted_delivery?.decision_id})
  }
  if(deliveries.length&&(await client.query('SELECT shared.lock_memory_delivery_commit($1::jsonb) AS locked',[JSON.stringify(deliveries)])).rows[0]?.locked!==true)throw Error('source_reference_changed')
  for(const row of rows)proved.add(row.evidence_id)
 }
 return proved
}
