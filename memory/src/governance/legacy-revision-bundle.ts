import {createHash} from 'node:crypto'
import type pg from 'pg'
import {sanitizeText} from '../episodes/content-policy.js'
import {requireCurrentScopePermission,TargetBindingError,type ValidatedV2Grant} from './authorization.js'
import {canonicalRepositoryRemotes} from './publication-applicability.js'
import {captureSourceApplicability} from './applicability.js'
import {bundleEvidence,type RevisionBundle,type SharedRevisionEvidence,canonicalBundleJSON} from './revision-bundle.js'
interface SourceRow {
 statement:string;structured_content:Record<string,unknown>;state:string;current_version_id:string;version_id:string
 scope_kind:RevisionBundle['applicability']['scopeKind'];scope_key:string;canonical_repository_key:string|null
 repository_id:string|null;repo_snapshot_id:string|null;branch:string|null
 applicability:unknown;consumption_hold_reason:string|null
 source_snapshot_commit_sha:string|null;source_repository_key:string|null;source_canonical_remote:string|null;source_metadata_owned:boolean;source_origin_policy_hash:string|null
 valid_from:Date|null;valid_until:Date|null;freshness_at:Date|null
}
/** Explicit new-revision repair, never an in-place backfill or a guess about missing sources. */
export async function restoreLegacyRevisionBundle(input:{client:pg.PoolClient;grant?:ValidatedV2Grant;sourceInstallationId:string;sourceClaimId:string;
 sourceVersionId:string;sourceContentHash:string;retainedEvidence:SharedRevisionEvidence[];reviewPolicyHash:string}):Promise<RevisionBundle>{
 if(!input.grant)throw new Error('legacy source authorization required')
 try {await requireCurrentScopePermission({client:input.client,grant:input.grant,targetInstallationId:input.sourceInstallationId,permission:'read'})}
 catch(error){if(error instanceof TargetBindingError)throw new Error('legacy source authorization required');throw error}
 const source=(await input.client.query<SourceRow>(`SELECT c.state,c.current_version_id,c.scope_kind,c.scope_key,c.canonical_repository_key,
   v.version_id,v.statement,v.structured_content,v.repository_id,v.repo_snapshot_id,v.branch,v.valid_from,v.valid_until,v.freshness_at,v.applicability,c.consumption_hold_reason,r.repository_key AS source_repository_key,r.canonical_remote AS source_canonical_remote,s.commit_sha AS source_snapshot_commit_sha,
   ((v.repository_id IS NULL OR r.repository_id IS NOT NULL) AND (v.repo_snapshot_id IS NULL OR s.repo_snapshot_id IS NOT NULL)) AS source_metadata_owned,
   COALESCE(pr.revision_bundle->>'originPolicyHash',pr.revision_bundle->>'reviewPolicyHash',gr.policy_hash) AS source_origin_policy_hash
   FROM knowledge_claims c JOIN knowledge_versions v USING(installation_id,claim_id)
   LEFT JOIN repositories r ON r.installation_id=v.installation_id AND r.repository_id=v.repository_id
   LEFT JOIN repo_snapshots s ON s.installation_id=v.installation_id AND s.repository_id=v.repository_id AND s.repo_snapshot_id=v.repo_snapshot_id
   LEFT JOIN memory_authority_records ar ON ar.installation_id=v.installation_id AND ar.version_id=v.version_id
   LEFT JOIN memory_promotion_candidate_versions pr ON pr.candidate_revision_id=ar.candidate_revision_id
   LEFT JOIN memory_git_claim_authority ga ON ga.installation_id=v.installation_id AND ga.version_id=v.version_id
     AND ga.claim_id=c.claim_id AND ga.revision_id=ar.candidate_revision_id
   LEFT JOIN memory_git_governed_revisions gr ON gr.installation_id=ga.installation_id AND gr.revision_id=ga.revision_id
     AND gr.claim_id=c.claim_id AND gr.review_policy_version_id=ar.review_policy_version_id
   WHERE c.installation_id=$1 AND c.claim_id=$2 AND v.version_id=$3 FOR SHARE OF c,v`,[input.sourceInstallationId,input.sourceClaimId,input.sourceVersionId])).rows[0]
 if(!source || source.state!=='active'||source.current_version_id!==source.version_id
   ||createHash('sha256').update(source.statement).digest('hex')!==input.sourceContentHash)throw new Error('legacy source integrity unavailable')
 const originals=(await input.client.query<{excerpt:string;excerpt_hash:Buffer;evidence_kind:string;occurred_at:Date;locator:Record<string,unknown>}>(
   'SELECT excerpt,excerpt_hash,evidence_kind,occurred_at,locator FROM knowledge_evidence WHERE installation_id=$1 AND version_id=$2 ORDER BY ordinal FOR SHARE',
   [input.sourceInstallationId,input.sourceVersionId])).rows
 for(const copy of input.retainedEvidence){
   const matches=originals.filter(row=>row.excerpt_hash.toString('hex')===copy.source_evidence_hash)
   const proven=matches.some(row=>{
     const text=sanitizeText(row.excerpt,4000).text
     const provenance=row.locator?.source_provenance as Record<string,unknown>|undefined
     const locator=provenance?.source_kind==='team_session'?{source_provenance:provenance}:null
     return row.excerpt_hash.toString('hex')===createHash('sha256').update(row.excerpt).digest('hex')
       &&text===copy.excerpt&&createHash('sha256').update(text).digest('hex')===copy.excerpt_hash
       &&row.evidence_kind===copy.evidence_kind&&row.occurred_at.toISOString()===new Date(copy.occurred_at!).toISOString()
       &&canonicalBundleJSON(locator)===canonicalBundleJSON(copy.sanitized_locator)
   })
   if(!proven)throw new Error('legacy retained evidence integrity unavailable')
 }
 return{schemaVersion:2,statement:source.statement,structuredContent:source.structured_content,
  applicability:captureSourceApplicability({scopeKind:source.scope_kind,scopeKey:source.scope_key,canonicalRepositoryKey:source.canonical_repository_key,
    repositoryId:source.repository_id,snapshotId:source.repo_snapshot_id,branch:source.branch,applicability:source.applicability,consumptionHoldReason:source.consumption_hold_reason??(!source.source_metadata_owned||(source.canonical_repository_key&&!canonicalRepositoryRemotes(source.canonical_repository_key).includes(source.source_canonical_remote??''))?'source_metadata_requires_review':null)}),
  sourceSnapshotCommitSha:source.source_snapshot_commit_sha,sourceRepositoryKey:source.source_repository_key,
  sourceContentHash:input.sourceContentHash,sourceValidFrom:source.valid_from?.toISOString()??null,sourceValidUntil:source.valid_until?.toISOString()??null,
  sourceFreshnessAt:source.freshness_at?.toISOString()??null,evidence:bundleEvidence(input.retainedEvidence),originPolicyHash:source.source_origin_policy_hash,reviewPolicyHash:input.reviewPolicyHash}
}
