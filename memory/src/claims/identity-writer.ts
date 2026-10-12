import type pg from 'pg'
import type {TombstoneHmacKey} from '../config.js'
import {repositoryKeyFromRecordedRemote} from '../retrieval/federated-context.js'
import {captureSourceApplicability} from '../governance/applicability.js'
import type {ClaimApplicability} from '../governance/revision-bundle.js'
import {claimIdentityV2,claimDuplicateDigestV2,ClaimIdentityUnavailableError} from './identity.js'
import {normalizedClaimKey} from '../retrieval/query-normalizer.js'
import {findTombstonedNormalizedKeys} from './tombstones.js'
type Queryable=Pick<pg.Pool|pg.PoolClient,'query'>
export interface IdentityFrameInput {installationId:string;scopeKind:ClaimApplicability['scopeKind'];scopeKey:string;repositoryId:string|null;
 snapshotId:string|null;branch:string|null;applicability?:unknown;canonicalRepositoryKey?:string|null;consumptionHoldReason?:string|null}
/** Recorded registry facts, never a cwd/basename or a client assertion. Callers
 * own the source lifecycle fences when this snapshot admits a write. */
export async function resolveClaimApplicability(client:Queryable,input:IdentityFrameInput):Promise<ClaimApplicability>{
 let canonical:string|null=null,owned=true
 if(input.repositoryId){
  const row=(await client.query<{canonical_remote:string|null}>(`SELECT r.canonical_remote FROM repositories r WHERE r.installation_id=$1 AND r.repository_id=$2
   AND NOT EXISTS(SELECT 1 FROM memory_repository_tombstones t WHERE t.installation_id=r.installation_id AND t.repository_id=r.repository_id)`,[input.installationId,input.repositoryId])).rows[0]
  owned=Boolean(row);canonical=repositoryKeyFromRecordedRemote(row?.canonical_remote??null)
 }
 if(input.snapshotId){
  const snapshot=(await client.query(`SELECT 1 FROM repo_snapshots s WHERE s.installation_id=$1 AND s.repository_id=$2 AND s.repo_snapshot_id=$3
   AND NOT EXISTS(SELECT 1 FROM memory_source_snapshot_tombstones t WHERE t.installation_id=s.installation_id AND t.repository_id=s.repository_id AND t.commit_sha=s.commit_sha)`,[input.installationId,input.repositoryId,input.snapshotId])).rows[0]
  owned=owned&&Boolean(snapshot)
 }
 const mismatch=input.canonicalRepositoryKey!==undefined&&input.canonicalRepositoryKey!==null&&input.canonicalRepositoryKey!==canonical
 const scoped=['repository','snapshot','branch'].includes(input.scopeKind)
 const proven=owned&&!mismatch&&(!scoped||canonical!==null)
 const initial=input.applicability??{scopeKind:input.scopeKind,scopeKey:input.scopeKey,canonicalRepositoryKey:canonical,
  repositoryId:input.repositoryId,snapshotId:input.snapshotId,branch:input.branch,status:proven?'verified':'legacy_unknown'}
 return captureSourceApplicability({scopeKind:input.scopeKind,scopeKey:input.scopeKey,canonicalRepositoryKey:canonical,
  repositoryId:input.repositoryId,snapshotId:input.snapshotId,branch:input.branch,applicability:initial,
  consumptionHoldReason:input.consumptionHoldReason??(!owned||mismatch?'identity_source_requires_review':null)})
}
export class ClaimIdentityWriteError extends Error {
 constructor(readonly code:'identity_requires_review'|'identity_conflict'|'identity_migration_required'|'tombstoned_identity'|'tombstone_hmac_keyring_incomplete'){super(code)}
}
export interface ClaimIdentityProjection {generation:1|2;legacyKey:string;keyV2:string|null;topicKeyV2:string|null;duplicateDigestV2:string|null;applicability?:ClaimApplicability}
export async function projectClaimIdentity(client:Queryable,input:{installationId:string;claimType:string;statement:string;structuredContent:Record<string,unknown>;
 applicability:ClaimApplicability;validFrom:Date|string|null;validUntil:Date|string|null}):Promise<ClaimIdentityProjection>{
 const state=(await client.query<{identity_generation:number}>('SELECT identity_generation FROM memory_governance_v2_states WHERE installation_id=$1 FOR SHARE',[input.installationId])).rows[0]
 const generation=(state?.identity_generation??1) as 1|2
 const legacyKey=normalizedClaimKey({claimType:input.claimType,scopeKey:input.applicability.scopeKey,statement:input.statement})
 let keyV2:string|null=null,topicKeyV2:string|null=null,duplicateDigestV2:string|null=null
 try{
  const frame={...input.applicability,claimType:input.claimType,statement:input.statement,structuredContent:input.structuredContent,validFrom:input.validFrom,validUntil:input.validUntil}
  const identity=claimIdentityV2(frame);keyV2=identity.key;topicKeyV2=identity.topicKey;duplicateDigestV2=claimDuplicateDigestV2(frame)
 }catch(error){if(!(error instanceof ClaimIdentityUnavailableError))throw error;if(generation===2)throw new ClaimIdentityWriteError('identity_requires_review')}
 return{generation,legacyKey,keyV2,topicKeyV2,duplicateDigestV2,applicability:input.applicability}
}
export function assertCurrentIdentityProjection(stored:{identity_generation:number;normalized_key_v2:string|null;topic_key_v2?:string|null;duplicate_digest_v2?:string|null},projection:ClaimIdentityProjection):void{
 if((stored.identity_generation===2||stored.normalized_key_v2)&&(!projection.keyV2||stored.normalized_key_v2!==projection.keyV2))throw new ClaimIdentityWriteError('identity_requires_review')
 if((stored.topic_key_v2&&stored.topic_key_v2!==projection.topicKeyV2)||(stored.duplicate_digest_v2&&stored.duplicate_digest_v2!==projection.duplicateDigestV2))throw new ClaimIdentityWriteError('identity_requires_review')
 if(projection.generation===2&&(!stored.topic_key_v2||!stored.duplicate_digest_v2))throw new ClaimIdentityWriteError('identity_requires_review')
}
export async function assertIdentityNotTombstoned(client:Queryable,input:{installationId:string;projection:ClaimIdentityProjection;keys:readonly TombstoneHmacKey[]}):Promise<void>{
 const versions=(await client.query<{key_id:string}>('SELECT DISTINCT key_id FROM knowledge_tombstones WHERE installation_id=$1',[input.installationId])).rows
 if(versions.some(v=>!input.keys.some(k=>k.version===v.key_id)))throw new ClaimIdentityWriteError('tombstone_hmac_keyring_incomplete')
 const deleted=await findTombstonedNormalizedKeys(client,{installationId:input.installationId,normalizedKeys:[input.projection.legacyKey],
  identityV2ByNormalizedKey:input.projection.keyV2?{[input.projection.legacyKey]:[input.projection.keyV2]}:undefined,keys:input.keys})
 if(deleted.has(input.projection.legacyKey))throw new ClaimIdentityWriteError('tombstoned_identity')
}
/** V1 fences remain necessary until Task26 removes the old global index. A
 * proven v2 difference under its old alias is a migration limit, never a merge. */
export async function assertClaimIdentityAvailable(client:Queryable,input:{installationId:string;claimType:string;scopeKey:string;projection:ClaimIdentityProjection;
 excludeClaimId?:string;variant?:number;allowConflicts?:boolean;lockIdentity?:boolean}):Promise<void>{
 const p=input.projection,variant=input.variant??0
 if(input.lockIdentity!==false){
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('claim-identity:'||$1||':'||$2||':'||$3||':'||$4,0))",[input.installationId,input.claimType,input.scopeKey,p.legacyKey])
  if(p.keyV2)await client.query("SELECT pg_advisory_xact_lock(hashtextextended('claim-identity-v2:'||$1||':'||$2,0))",[input.installationId,p.keyV2])
 }
 const rows=(await client.query<Record<string,any>>(`SELECT c.*,to_jsonb(v) AS current_version_metadata FROM knowledge_claims c
  JOIN knowledge_versions v ON v.installation_id=c.installation_id AND v.claim_id=c.claim_id AND v.version_id=c.current_version_id
  WHERE c.installation_id=$1 AND c.state='active' AND ($5::uuid IS NULL OR c.claim_id<>$5)
   AND ((c.claim_type=$2 AND c.scope_key=$3 AND c.normalized_key=$4) OR ($6::text IS NOT NULL AND c.duplicate_digest_v2=$6)
    OR (c.claim_type=$2 AND c.scope_key=$3)) ORDER BY c.claim_id`,
 [input.installationId,input.claimType,input.scopeKey,p.legacyKey,input.excludeClaimId??null,p.duplicateDigestV2])).rows
 for(const r of rows){
  const v=r.current_version_metadata
  const app=await resolveClaimApplicability(client,{installationId:input.installationId,scopeKind:r.scope_kind,scopeKey:r.scope_key,
   canonicalRepositoryKey:r.canonical_repository_key,repositoryId:v.repository_id,snapshotId:v.repo_snapshot_id,branch:v.branch,applicability:v.applicability,consumptionHoldReason:r.consumption_hold_reason})
  if(app.status!=='verified')continue
  const current=await projectClaimIdentity(client,{installationId:input.installationId,claimType:r.claim_type,statement:v.statement,
   structuredContent:v.structured_content??{},applicability:app,validFrom:v.valid_from,validUntil:v.valid_until})
  if(r.normalized_key!==p.legacyKey&&current.keyV2!==p.keyV2&&current.duplicateDigestV2!==p.duplicateDigestV2)continue
  assertCurrentIdentityProjection({identity_generation:Number(r.identity_generation),normalized_key_v2:r.normalized_key_v2,topic_key_v2:r.topic_key_v2,duplicate_digest_v2:r.duplicate_digest_v2},{...current,generation:r.identity_generation===2?2:1})
  r.duplicate_digest_v2=current.duplicateDigestV2
 }
 const legacyIndex=Boolean((await client.query("SELECT to_regclass('knowledge_claims_active_identity_variant_idx') IS NOT NULL AS present")).rows[0]?.present)
 if(rows.some(r=>legacyIndex&&r.normalized_key===p.legacyKey&&r.conflict_variant===variant&&p.duplicateDigestV2&&r.duplicate_digest_v2&&r.duplicate_digest_v2!==p.duplicateDigestV2))throw new ClaimIdentityWriteError('identity_migration_required')
 if(!input.allowConflicts&&rows.some(r=>r.conflict_variant===variant&&((p.generation===1&&r.normalized_key===p.legacyKey)||(p.duplicateDigestV2&&r.duplicate_digest_v2===p.duplicateDigestV2))))throw new ClaimIdentityWriteError('identity_conflict')
}
