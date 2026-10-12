import {createHash} from 'node:crypto'
import type pg from 'pg'
import {canonicalPayloadHash} from '../inbox/canonical-json.js'
import {canonicalReviewPolicyHash,parseReviewPolicyDocument,resolveEffectivePolicy,DEFAULT_TEAM_REVIEW_POLICY,DEFAULT_ORGANIZATION_REVIEW_POLICY} from './review-policy.js'
import {revisionBundleHash,type RevisionBundle} from './revision-bundle.js'
type Queryable=Pick<pg.Pool|pg.PoolClient,'query'>
export type OriginPolicyReason='origin_policy_requires_review'|'origin_policy_unavailable'|'origin_policy_changed'
export interface OriginPolicyFence {
 installation_id:string;policy_id:string|null;revision:string|null;document:unknown;authorization_epoch:string;
 parent_owner_scope_id:string|null;parent_installation_id:string|null;transfer_id?:string;transfer_event_id?:string;transfer_candidate_id?:string;transfer_document?:unknown;transfer_bundle_hash?:string;origin_revision_id?:string;origin_document?:unknown;origin_bundle_hash?:string;origin_source_installation_id?:string;origin_target_installation_id?:string
}
export interface OriginPolicyDecision {eligible:boolean;reason:OriginPolicyReason|null;stamp:string|null;fences?:OriginPolicyFence[]}
/** Only explicit shared-origin lineage adds this gate; retained personal capsules
 * and unmigrated null-metadata local Claims keep their existing semantics. */
export const ORIGIN_POLICY_REQUIRED_SQL=`(c.owner_scope_kind='organization' AND (EXISTS(SELECT 1 FROM memory_authority_records origin_authority WHERE origin_authority.installation_id=v.installation_id
 AND origin_authority.version_id=v.version_id AND origin_authority.source_scope_kind='team') OR EXISTS(SELECT 1 FROM knowledge_versions origin_ancestor
 JOIN memory_authority_records origin_history ON origin_history.installation_id=origin_ancestor.installation_id AND origin_history.version_id=origin_ancestor.version_id AND origin_history.source_scope_kind='team'
 WHERE origin_ancestor.installation_id=v.installation_id AND origin_ancestor.claim_id=v.claim_id AND origin_ancestor.version_number<=v.version_number
  AND origin_ancestor.source_promotion_candidate_id IS NOT DISTINCT FROM v.source_promotion_candidate_id) OR EXISTS(SELECT 1 FROM memory_promotion_candidates origin_candidate
 WHERE origin_candidate.candidate_id=v.source_promotion_candidate_id AND origin_candidate.target_installation_id=v.installation_id AND origin_candidate.source_scope_kind='team')))`
const deny=(reason:OriginPolicyReason):OriginPolicyDecision=>({eligible:false,reason,stamp:null})
/** Read existing policy only: no bootstrap, authority mutation or foreign body
 * permission. Policy revisions/epochs form the stamp, including rollback CAS.
 * Callers freeze/recheck it when handing bytes to a downstream consumer. */
export async function currentOriginPolicy(client:Queryable,installationId:string):Promise<{hash:string;snapshotHash:string;stamp:string;fences:OriginPolicyFence[]}|null>{
 const row=(await client.query(`SELECT s.owner_scope_kind,s.state,s.authorization_epoch::text,s.parent_organization_id::text,
  i.relay_status,i.local_status,h.policy_id::text,h.active_version_id::text,h.revision::text,p.document,
  EXISTS(SELECT 1 FROM memory_scope_tombstones t WHERE t.owner_scope_kind=s.owner_scope_kind AND t.owner_scope_id=s.owner_scope_id AND t.authorization_epoch>=s.authorization_epoch) AS tombstoned,
  parent.installation_id::text AS parent_installation_id,parent.state AS parent_state,parent.authorization_epoch::text AS parent_epoch,
  pi.relay_status AS parent_relay_status,pi.local_status AS parent_local_status,ph.policy_id::text AS parent_policy_id,ph.active_version_id::text AS parent_version,ph.revision::text AS parent_revision,pv.document AS parent_document,
  EXISTS(SELECT 1 FROM memory_scope_tombstones t WHERE t.owner_scope_kind='organization' AND t.owner_scope_id=s.parent_organization_id
    AND (parent.authorization_epoch IS NULL OR t.authorization_epoch>=parent.authorization_epoch)) AS parent_tombstoned
 FROM memory_owner_scopes s JOIN memory_installations i USING(installation_id)
 JOIN memory_review_policy_sets ps USING(installation_id) JOIN memory_review_policy_heads h USING(policy_id)
 JOIN memory_review_policy_versions p ON p.policy_version_id=h.active_version_id AND p.policy_id=h.policy_id
 LEFT JOIN memory_owner_scopes parent ON parent.owner_scope_kind='organization' AND parent.owner_scope_id=s.parent_organization_id
 LEFT JOIN memory_installations pi ON pi.installation_id=parent.installation_id
 LEFT JOIN memory_review_policy_sets pp ON pp.installation_id=parent.installation_id
 LEFT JOIN memory_review_policy_heads ph ON ph.policy_id=pp.policy_id
 LEFT JOIN memory_review_policy_versions pv ON pv.policy_version_id=ph.active_version_id AND pv.policy_id=ph.policy_id
 WHERE s.installation_id=$1`,[installationId])).rows[0]
 if(!row||!['team','organization'].includes(row.owner_scope_kind)||row.state!=='active'||row.relay_status!=='active'
  ||['purging','purged','integrity_error'].includes(row.local_status)||row.tombstoned)return null
 const document=parseReviewPolicyDocument(row.document)
 if(!document)return null
 let policy=resolveEffectivePolicy(row.owner_scope_kind==='team'?DEFAULT_TEAM_REVIEW_POLICY:DEFAULT_ORGANIZATION_REVIEW_POLICY,document)
 if(row.owner_scope_kind==='team'&&row.parent_organization_id){
  if(row.parent_tombstoned||(row.parent_installation_id&&(row.parent_state!=='active'||row.parent_relay_status!=='active'
   ||['purging','purged','integrity_error'].includes(row.parent_local_status))))return null
  const parent=row.parent_document?parseReviewPolicyDocument(row.parent_document):null
  if(row.parent_document&&!parent)return null
  policy=resolveEffectivePolicy(parent?resolveEffectivePolicy(DEFAULT_ORGANIZATION_REVIEW_POLICY,parent):DEFAULT_ORGANIZATION_REVIEW_POLICY,policy)
 }
 const hash=canonicalReviewPolicyHash(policy)
 const stamp=createHash('sha256').update(JSON.stringify([installationId,hash,row.active_version_id,row.revision,row.authorization_epoch,
  row.parent_organization_id,row.parent_installation_id,row.parent_version,row.parent_revision,row.parent_epoch])).digest('hex')
 const fences:OriginPolicyFence[]=[{installation_id:installationId,policy_id:row.policy_id,revision:row.revision,document:row.document,
  authorization_epoch:row.authorization_epoch,parent_owner_scope_id:row.parent_organization_id,parent_installation_id:row.parent_installation_id}]
 if(row.owner_scope_kind==='team'&&row.parent_installation_id)fences.push({installation_id:row.parent_installation_id,policy_id:row.parent_policy_id,
  revision:row.parent_revision,document:row.parent_document,authorization_epoch:row.parent_epoch,parent_owner_scope_id:null,parent_installation_id:null})
 // Git producers bind the complete immutable policy snapshot; promotion
 // producers bind its effective document. Preserve both existing contracts.
 const snapshotHash=canonicalPayloadHash({scopeKind:row.owner_scope_kind,activeVersionId:row.active_version_id,parentActiveVersionId:row.parent_version??null,policy}).toString('hex')
 return{hash,snapshotHash,stamp,fences}
}
/** Validate a frozen upstream proof at review/publication boundaries. This
 * reads policy metadata only; retained evidence does not regain source read. */
export async function originPolicyProofDecision(client:Queryable,installationId:string|null,hash:string|null):Promise<OriginPolicyDecision>{
 if(!installationId||!/^[a-f0-9]{64}$/.test(hash??''))return deny('origin_policy_requires_review')
 const policy=await currentOriginPolicy(client,installationId)
 return !policy?deny('origin_policy_unavailable'):policy.hash!==hash&&policy.snapshotHash!==hash?deny('origin_policy_changed'):
  {eligible:true,reason:null,stamp:policy.stamp,fences:policy.fences}
}
/** An explicit dissolution transfer is a retained copy governed by fresh
 * Organization review. Its exact run/event/initial immutable bundle is the
 * retained basis; ordinary Team copies cannot borrow a completed run. */
export async function transferredOriginDecision(client:Queryable,candidateId:string,bundle:RevisionBundle|null):Promise<OriginPolicyDecision|null>{
 if(!bundle||!/^[a-f0-9]{64}$/.test(bundle.originPolicyHash??''))return null
 const row=(await client.query(`SELECT tr.transfer_id::text,e.event_id::text,pc.target_installation_id::text,
  initial.revision_bundle,initial.revision_bundle_hash FROM memory_promotion_candidates pc
  JOIN memory_governance_events e ON e.installation_id=pc.target_installation_id AND e.target_id=pc.candidate_id
   AND e.target_kind='promotion_candidate' AND e.action='transfer_candidate_created'
  JOIN memory_transfer_runs tr ON tr.transfer_id::text=e.metadata->>'transfer_id' AND tr.source_installation_id=pc.source_installation_id
   AND tr.target_installation_id=pc.target_installation_id AND tr.state='completed'
  JOIN memory_promotion_candidate_versions initial ON initial.candidate_id=pc.candidate_id AND initial.revision_number=1
   AND initial.revision_bundle_hash=e.metadata->>'bundle_hash'
  WHERE pc.candidate_id=$1 AND pc.source_scope_kind='team'`,[candidateId])).rows[0]
 if(!row)return null
 const initial=row.revision_bundle as RevisionBundle
 try{if(revisionBundleHash(initial)!==row.revision_bundle_hash||initial.originPolicyHash!==bundle.originPolicyHash||initial.sourceContentHash!==bundle.sourceContentHash)return null}catch{return null}
 const target=await currentOriginPolicy(client,row.target_installation_id)
 if(!target)return deny('origin_policy_unavailable')
 const stamp=canonicalPayloadHash({transferId:row.transfer_id,eventId:row.event_id,bundleHash:row.revision_bundle_hash,targetStamp:target.stamp}).toString('hex')
 return {eligible:true,reason:null,stamp,fences:target.fences.map(f=>({...f,transfer_id:row.transfer_id,transfer_event_id:row.event_id,transfer_candidate_id:candidateId,transfer_document:initial,transfer_bundle_hash:row.revision_bundle_hash}))}
}
export async function originPolicyDecisions(client:Queryable,installationId:string,versionIds:readonly string[]):Promise<Map<string,OriginPolicyDecision>>{
 if(!versionIds.length)return new Map()
 const rows=(await client.query(`SELECT v.version_id::text,pc.candidate_id::text,pc.source_installation_id::text,pc.source_scope_kind,
  proof.candidate_revision_id::text,proof.revision_bundle,proof.revision_bundle_hash,
  EXISTS(SELECT 1 FROM memory_governance_events e WHERE e.installation_id=pc.target_installation_id AND e.target_id=pc.candidate_id AND e.action='transfer_candidate_created' AND e.target_kind='promotion_candidate') AS transferred
 FROM knowledge_versions v JOIN knowledge_claims c USING(installation_id,claim_id)
 LEFT JOIN memory_promotion_candidates pc ON pc.candidate_id=v.source_promotion_candidate_id AND pc.target_installation_id=v.installation_id
 LEFT JOIN LATERAL(SELECT pr.candidate_revision_id,pr.revision_bundle,pr.revision_bundle_hash FROM knowledge_versions ancestor
   JOIN memory_authority_records a ON a.installation_id=ancestor.installation_id AND a.version_id=ancestor.version_id
   JOIN memory_promotion_candidate_versions pr ON pr.candidate_revision_id=a.candidate_revision_id AND pr.candidate_id=pc.candidate_id
   WHERE ancestor.installation_id=v.installation_id AND ancestor.claim_id=v.claim_id
    AND ancestor.source_promotion_candidate_id=v.source_promotion_candidate_id AND ancestor.version_number<=v.version_number
   ORDER BY ancestor.version_number DESC LIMIT 1) proof ON true
 WHERE v.installation_id=$1 AND v.version_id=ANY($2::uuid[])`,[installationId,versionIds])).rows
 const policies=new Map<string,Awaited<ReturnType<typeof currentOriginPolicy>>>()
 const result=new Map<string,OriginPolicyDecision>()
 for(const row of rows){
  const bundle=row.revision_bundle as RevisionBundle|null
  let valid=false
  try{valid=Boolean(bundle&&row.revision_bundle_hash&&revisionBundleHash(bundle)===row.revision_bundle_hash&&/^[a-f0-9]{64}$/.test(bundle.originPolicyHash??''))}catch{}
  if(row.source_scope_kind!=='team'||!row.source_installation_id||!valid){result.set(row.version_id,deny('origin_policy_requires_review'));continue}
  const bindProof=(decision:OriginPolicyDecision):OriginPolicyDecision=>({...decision,fences:decision.fences?.map((f,i)=>i?f:{...f,origin_revision_id:row.candidate_revision_id,origin_document:bundle,origin_bundle_hash:row.revision_bundle_hash,origin_source_installation_id:row.source_installation_id,origin_target_installation_id:installationId})})
  const transfer=row.transferred?await transferredOriginDecision(client,row.candidate_id,bundle):null
  if(transfer){result.set(row.version_id,bindProof(transfer));continue}
  if(!policies.has(row.source_installation_id))policies.set(row.source_installation_id,await currentOriginPolicy(client,row.source_installation_id))
  const policy=policies.get(row.source_installation_id)
  result.set(row.version_id,!policy?deny('origin_policy_unavailable'):policy.hash!==bundle!.originPolicyHash&&policy.snapshotHash!==bundle!.originPolicyHash?deny('origin_policy_changed'):
   bindProof({eligible:true,reason:null,stamp:policy.stamp,fences:policy.fences}))
 }
 return result
}

/** A coarse policy-only corpus stamp prevents pre-lookup cache reuse and binds
 * immutable packs without changing the installation's data generation. */
export async function originPolicyCorpusSnapshot(client:Queryable,installationId:string):Promise<{stamp:string|null;fences:OriginPolicyFence[]}>{
 const rows=(await client.query(`SELECT v.version_id::text,${ORIGIN_POLICY_REQUIRED_SQL} AS origin_policy_required
  FROM knowledge_versions v JOIN knowledge_claims c USING(installation_id,claim_id)
  WHERE v.installation_id=$1 AND c.current_version_id=v.version_id AND c.state='active' ORDER BY v.version_id`,[installationId])).rows
 const ids=rows.filter(r=>r.origin_policy_required===true).map(r=>String(r.version_id))
 if(!ids.length)return{stamp:null,fences:[]}
 const decisions=await originPolicyDecisions(client,installationId,ids),fences=new Map<string,OriginPolicyFence>()
 const values=ids.map(id=>{const d=decisions.get(id);for(const fence of d?.fences??[])fences.set(fence.installation_id+':'+(fence.transfer_event_id??'')+':'+(fence.origin_revision_id??''),fence)
  return[id,d?.eligible?d.stamp:`denied:${d?.reason??'origin_policy_requires_review'}`]})
 return{stamp:createHash('sha256').update(JSON.stringify(values)).digest('hex'),fences:[...fences.values()].sort((a,b)=>a.installation_id.localeCompare(b.installation_id))}
}
/** Recheck the observed heads, raw policy documents and lifecycle tuples in the
 * atomic nonce transition. No foreign row locks or cross-installation epoch
 * updates are added, so origin policy writers never wait on Context packs. */
export function originPolicyFenceSql(parameter:string):string{
 return `NOT EXISTS(SELECT 1 FROM jsonb_to_recordset(${parameter}::jsonb) f(installation_id uuid,policy_id uuid,revision bigint,document jsonb,
   authorization_epoch bigint,parent_owner_scope_id uuid,parent_installation_id uuid,transfer_id uuid,transfer_event_id uuid,transfer_candidate_id uuid,transfer_document jsonb,transfer_bundle_hash text,origin_revision_id uuid,origin_document jsonb,origin_bundle_hash text,origin_source_installation_id uuid,origin_target_installation_id uuid)
  LEFT JOIN memory_owner_scopes s ON s.installation_id=f.installation_id
  LEFT JOIN memory_installations i ON i.installation_id=s.installation_id
  LEFT JOIN memory_review_policy_sets ps ON ps.installation_id=s.installation_id
  LEFT JOIN memory_review_policy_heads h ON h.policy_id=ps.policy_id
  LEFT JOIN memory_review_policy_versions p ON p.policy_version_id=h.active_version_id AND p.policy_id=h.policy_id
  LEFT JOIN memory_owner_scopes parent ON parent.owner_scope_kind='organization' AND parent.owner_scope_id=s.parent_organization_id
  WHERE (f.origin_revision_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM memory_promotion_candidate_versions origin_proof
      JOIN memory_promotion_candidates origin_candidate ON origin_candidate.candidate_id=origin_proof.candidate_id
      WHERE origin_proof.candidate_revision_id=f.origin_revision_id AND origin_proof.revision_bundle=f.origin_document
       AND origin_proof.revision_bundle_hash=f.origin_bundle_hash AND origin_candidate.source_installation_id=f.origin_source_installation_id
       AND origin_candidate.target_installation_id=f.origin_target_installation_id AND origin_candidate.source_scope_kind='team'))
    OR (f.transfer_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM memory_transfer_runs tr JOIN memory_governance_events e
      ON e.event_id=f.transfer_event_id AND e.installation_id=tr.target_installation_id AND e.target_id=f.transfer_candidate_id
       AND e.action='transfer_candidate_created' AND e.target_kind='promotion_candidate' AND e.metadata->>'transfer_id'=tr.transfer_id::text
      JOIN memory_promotion_candidates pc ON pc.candidate_id=e.target_id AND pc.source_installation_id=tr.source_installation_id AND pc.target_installation_id=tr.target_installation_id
      JOIN memory_promotion_candidate_versions initial ON initial.candidate_id=pc.candidate_id AND initial.revision_number=1
      WHERE tr.transfer_id=f.transfer_id AND tr.target_installation_id=f.installation_id AND tr.state='completed'
       AND initial.revision_bundle=f.transfer_document AND initial.revision_bundle_hash=f.transfer_bundle_hash AND e.metadata->>'bundle_hash'=f.transfer_bundle_hash))
    OR s.installation_id IS NULL OR s.state<>'active' OR s.authorization_epoch IS DISTINCT FROM f.authorization_epoch
    OR i.relay_status IS DISTINCT FROM 'active' OR i.local_status IN('purging','purged','integrity_error')
    OR h.policy_id IS DISTINCT FROM f.policy_id OR h.revision IS DISTINCT FROM f.revision OR p.document IS DISTINCT FROM f.document
    OR s.parent_organization_id IS DISTINCT FROM f.parent_owner_scope_id OR parent.installation_id IS DISTINCT FROM f.parent_installation_id
    OR EXISTS(SELECT 1 FROM memory_scope_tombstones t WHERE t.owner_scope_kind=s.owner_scope_kind AND t.owner_scope_id=s.owner_scope_id AND t.authorization_epoch>=s.authorization_epoch)
    OR EXISTS(SELECT 1 FROM memory_scope_tombstones t WHERE t.owner_scope_kind='organization' AND t.owner_scope_id=f.parent_owner_scope_id
      AND (parent.authorization_epoch IS NULL OR t.authorization_epoch>=parent.authorization_epoch)))`
}
