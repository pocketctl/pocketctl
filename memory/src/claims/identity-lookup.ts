import {currentClaimVersionSql} from './version-selection.js'
import {ORIGIN_POLICY_REQUIRED_SQL,originPolicyDecisions} from '../governance/origin-policy.js'
import type {ClaimDuplicateInput} from './identity.js'
import type pg from 'pg'
import type {ClaimApplicability} from '../governance/revision-bundle.js'
import {claimIdentityV2,claimDuplicateDigestV2} from './identity.js'
import {resolveClaimApplicability,assertCurrentIdentityProjection,ClaimIdentityWriteError} from './identity-writer.js'

/** Compare actual current facts, never the source-side alias saved on a proposal.
 * Publication locks Claim heads first; read-side callers use a short transaction.
 */
async function loadClaimFamily(client:Pick<pg.Pool|pg.PoolClient,'query'>,input:{installationId:string;claimType:string;
 applicability:ClaimApplicability;statement:string;lockClaims?:boolean;topic?:boolean}):Promise<Array<{claim_id:string;statement:string;
 conflict_group_id:string|null;conflict_variant:number;duplicate_digest_v2:string;version_id:string;facts:ClaimDuplicateInput}>>{
 const key=claimIdentityV2({...input.applicability,claimType:input.claimType,statement:input.statement}).key
 if(input.lockClaims)await client.query(`SELECT c.claim_id FROM knowledge_claims c WHERE c.installation_id=$1 AND c.claim_type=$2 AND c.scope_kind=$3 AND c.scope_key=$4
  AND c.state='active' AND c.canonical_repository_key IS NOT DISTINCT FROM $5 ORDER BY c.claim_id FOR UPDATE OF c`,
  [input.installationId,input.claimType,input.applicability.scopeKind,input.applicability.scopeKey,input.applicability.canonicalRepositoryKey])
 const rows=(await client.query(`SELECT c.*,to_jsonb(v) AS version_metadata,${ORIGIN_POLICY_REQUIRED_SQL} AS origin_policy_required FROM knowledge_claims c
  JOIN knowledge_versions v ON v.installation_id=c.installation_id AND v.claim_id=c.claim_id AND v.version_id=c.current_version_id
  WHERE c.installation_id=$1 AND c.claim_type=$2 AND c.scope_kind=$3 AND c.scope_key=$4 AND c.state='active' AND ${currentClaimVersionSql()}
   AND c.consumption_hold_reason IS NULL AND c.canonical_repository_key IS NOT DISTINCT FROM $5
  ORDER BY c.claim_id LIMIT 10001`,
  [input.installationId,input.claimType,input.applicability.scopeKind,input.applicability.scopeKey,input.applicability.canonicalRepositoryKey])).rows
 if(rows.length>10000)throw new Error('claim_comparison_limit')
 const origin=await originPolicyDecisions(client,input.installationId,rows.filter(r=>r.origin_policy_required).map(r=>String(r.version_metadata.version_id)))
 const result=[]
 for(const row of rows){
  const v=row.version_metadata
  if(row.origin_policy_required&&!origin.get(String(v.version_id))?.eligible)continue
  const app=await resolveClaimApplicability(client,{installationId:input.installationId,scopeKind:row.scope_kind,scopeKey:row.scope_key,
   canonicalRepositoryKey:row.canonical_repository_key,repositoryId:v.repository_id,snapshotId:v.repo_snapshot_id,branch:v.branch,applicability:v.applicability})
  if(app.status!=='verified')continue
  const facts={...app,claimType:row.claim_type,statement:v.statement,structuredContent:v.structured_content??{},validFrom:v.valid_from,validUntil:v.valid_until}
  const identity=claimIdentityV2(facts),digest=claimDuplicateDigestV2(facts)
  try{assertCurrentIdentityProjection(row,{generation:row.identity_generation===2?2:1,legacyKey:row.normalized_key,
   keyV2:identity.key,topicKeyV2:identity.topicKey,duplicateDigestV2:digest})}
  catch(error){if(error instanceof ClaimIdentityWriteError)continue;throw error}
  if(input.topic?identity.topicKey===claimIdentityV2({...input.applicability,claimType:input.claimType,statement:input.statement}).topicKey:identity.key===key)result.push({claim_id:String(row.claim_id),statement:String(v.statement),conflict_group_id:row.conflict_group_id as string|null,
   conflict_variant:Number(row.conflict_variant),duplicate_digest_v2:digest,version_id:String(v.version_id),facts})
 }
 return result
}

export const findExactClaimFamily=(client:Parameters<typeof loadClaimFamily>[0],input:Parameters<typeof loadClaimFamily>[1])=>loadClaimFamily(client,input)
export const findClaimTopicFamily=(client:Parameters<typeof loadClaimFamily>[0],input:Parameters<typeof loadClaimFamily>[1])=>loadClaimFamily(client,{...input,topic:true})
