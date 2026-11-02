import type pg from 'pg'
import {TargetBindingError} from '../governance/authorization.js'
import type { ClaimType, ScopeKind } from './types.js'
import { resolveClaimApplicability, projectClaimIdentity, assertCurrentIdentityProjection, assertClaimIdentityAvailable, assertIdentityNotTombstoned } from './identity-writer.js'
import type { TombstoneHmacKey } from '../config.js'
import { activateRevisionInterval } from './version-selection.js'

export interface ManualEntryInput {
  installationId: string
  statement: string
  claimType: ClaimType
  repositoryId: string | null
  claimId?: string
  expectedRevision?: number
}

/** Called only within the management receipt transaction. User text is an
 * explicit personal assertion, never a fabricated session or model candidate. */
export async function writeManualEntry(client: pg.PoolClient, input: ManualEntryInput, keys: readonly TombstoneHmacKey[]) {
  const scope = (await client.query(`SELECT owner_scope_id::text FROM memory_owner_scopes
    WHERE installation_id=$1 AND owner_scope_kind='personal' AND state='active' FOR SHARE`, [input.installationId])).rows[0]
  if (!scope) throw new TargetBindingError('personal scope required')
  let claimType=input.claimType, repositoryId=input.repositoryId
  let scopeKind: ScopeKind=repositoryId?'repository':'installation', scopeKey=repositoryId??input.installationId
  if(input.claimId){
    repositoryId=(await client.query(`SELECT v.repository_id::text FROM knowledge_claims c JOIN knowledge_versions v
      ON v.installation_id=c.installation_id AND v.version_id=c.current_version_id WHERE c.installation_id=$1 AND c.claim_id=$2`,[input.installationId,input.claimId])).rows[0]?.repository_id??null
  }
  if(repositoryId)await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('purge:repository:'||$1||':'||$2,0))",[input.installationId,repositoryId])
  let prior: Record<string,any>|undefined
  if(input.claimId){
    prior=(await client.query(`SELECT c.*,v.repository_id::text,v.structured_content,v.version_number,v.statement,v.applicability,v.valid_from,v.valid_until
      FROM knowledge_claims c JOIN knowledge_versions v ON v.installation_id=c.installation_id AND v.version_id=c.current_version_id
      WHERE c.installation_id=$1 AND c.claim_id=$2 FOR UPDATE OF c`,[input.installationId,input.claimId])).rows[0]
    if(!prior)return {ok:false as const,error:{code:'claim_not_found'}}
    if(prior.state!=='active')return {ok:false as const,error:{code:'claim_not_active'}}
    if(Number(prior.revision)!==input.expectedRevision)return {ok:false as const,error:{code:'revision_conflict',currentRevision:Number(prior.revision),state:prior.state}}
    if(prior.structured_content?.manual_entry?.source_kind!=='manual_entry')return {ok:false as const,error:{code:'invalid_input',detail:'manual source required'}}
    claimType=prior.claim_type;repositoryId=prior.repository_id;scopeKind=prior.scope_kind;scopeKey=prior.scope_key
  }
  const applicability=await resolveClaimApplicability(client,{installationId:input.installationId,scopeKind,scopeKey,repositoryId,snapshotId:null,branch:null,
    ...(prior?{applicability:prior.applicability,canonicalRepositoryKey:prior.canonical_repository_key,consumptionHoldReason:prior.consumption_hold_reason}:{})})
  if(applicability.status!=='verified')return {ok:false as const,error:{code:'invalid_input',detail:'verified repository required'}}
  if(prior){
    const current=await projectClaimIdentity(client,{installationId:input.installationId,claimType,statement:prior.statement,structuredContent:prior.structured_content,applicability,validFrom:prior.valid_from,validUntil:prior.valid_until})
    assertCurrentIdentityProjection({identity_generation:Number(prior.identity_generation),normalized_key_v2:prior.normalized_key_v2,topic_key_v2:prior.topic_key_v2,duplicate_digest_v2:prior.duplicate_digest_v2},current)
  }
  const statement=input.statement.trim()
  const structured={manual_entry:{source_kind:'manual_entry',actor_scope_id:scope.owner_scope_id}}
  const projection=await projectClaimIdentity(client,{installationId:input.installationId,claimType,statement,structuredContent:structured,applicability,validFrom:null,validUntil:null})
  await assertIdentityNotTombstoned(client,{installationId:input.installationId,projection,keys})
  await assertClaimIdentityAvailable(client,{installationId:input.installationId,claimType,scopeKey,projection,excludeClaimId:input.claimId})
  const claimId=prior?.claim_id??(await client.query(`INSERT INTO knowledge_claims
    (claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state,canonical_repository_key,identity_generation,normalized_key_v2,topic_key_v2,duplicate_digest_v2)
    VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,'active',$6,$7,$8,$9,$10) RETURNING claim_id::text`,
    [input.installationId,claimType,scopeKind,scopeKey,projection.legacyKey,applicability.canonicalRepositoryKey,projection.generation,projection.keyV2,projection.topicKeyV2,projection.duplicateDigestV2])).rows[0].claim_id
  const versionNumber=prior?Number(prior.version_number)+1:1
  const versionId=(await client.query(`INSERT INTO knowledge_versions
    (version_id,installation_id,claim_id,version_number,statement,structured_content,authority,confidence,repository_id,freshness_at,applicability,effective_from)
    VALUES(gen_random_uuid(),$1,$2,$3,$4,$5::jsonb,$6,1,$7,clock_timestamp(),$8::jsonb,CASE WHEN $9 THEN NULL ELSE clock_timestamp() END) RETURNING version_id::text`,
    [input.installationId,claimId,versionNumber,statement,JSON.stringify(structured),prior?'user_corrected':'user_accepted',repositoryId,JSON.stringify(applicability),Boolean(prior)])).rows[0].version_id
  const capsuleId=(await client.query(`INSERT INTO knowledge_evidence_capsules
    (capsule_id,installation_id,version_id,retention_basis,repository_id,source_content_hash)
    VALUES(gen_random_uuid(),$1,$2,'user_accepted',$3,sha256(convert_to($4,'utf8'))) RETURNING capsule_id::text`,[input.installationId,versionId,repositoryId,statement])).rows[0].capsule_id
  await client.query(`INSERT INTO knowledge_evidence
    (evidence_id,installation_id,version_id,capsule_id,evidence_kind,locator,excerpt,excerpt_hash,source_evidence_hash,occurred_at,ordinal)
    VALUES(gen_random_uuid(),$1,$2,$3,'accepted_excerpt',$4::jsonb,$5,sha256(convert_to($5,'utf8')),encode(sha256(convert_to($5,'utf8')),'hex'),clock_timestamp(),0)`,
    [input.installationId,versionId,capsuleId,JSON.stringify({source_kind:'manual_entry',actor_scope_id:scope.owner_scope_id,repository_id:repositoryId}),statement])
  if(prior)await activateRevisionInterval(client,{installationId:input.installationId,claimId,previousVersionId:prior.current_version_id,versionId})
  await client.query(`UPDATE knowledge_claims SET current_version_id=$2,normalized_key=$3,normalized_key_v2=$4,topic_key_v2=$5,duplicate_digest_v2=$6,
    revision=revision+$7,updated_at=clock_timestamp() WHERE installation_id=$1 AND claim_id=$8`,
    [input.installationId,versionId,projection.legacyKey,projection.keyV2,projection.topicKeyV2,projection.duplicateDigestV2,prior?1:0,claimId])
  await client.query(`INSERT INTO memory_jobs(job_id,installation_id,job_type,idempotency_key,priority,payload)
    VALUES(gen_random_uuid(),$1,'index_claim_version',$2,90,$3::jsonb) ON CONFLICT DO NOTHING`,[input.installationId,`index:${versionId}`,JSON.stringify({version_id:versionId})])
  return {ok:true as const,metadata:{claim_id:claimId,version_id:versionId,version_number:versionNumber,state:'active',source_kind:'manual_entry'}}
}
