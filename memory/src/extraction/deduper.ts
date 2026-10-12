import {ORIGIN_POLICY_REQUIRED_SQL,originPolicyDecisions} from '../governance/origin-policy.js'
import {currentClaimVersionSql} from '../claims/version-selection.js'
import {classifyClaimConflict} from '../claims/conflict-classifier.js'
import type pg from 'pg'
import {claimIdentityV2,claimDuplicateDigestV2,type ClaimDuplicateInput} from '../claims/identity.js'
import { normalizedClaimKey } from '../retrieval/query-normalizer.js'
import type { ActiveClaimIdentity } from './validator.js'
import type { TombstoneHmacKey } from '../config.js'
import { findTombstonedNormalizedKeys } from '../claims/tombstones.js'
import {resolveClaimApplicability,assertCurrentIdentityProjection} from '../claims/identity-writer.js'
import type {ClaimApplicability} from '../governance/revision-bundle.js'

/**
 * Loads the active-claim family for duplicate/conflict classification. Every
 * query is installation-scoped: another installation's claims are invisible
 * by construction (cross-installation exclusion is a SQL boundary, not a
 * post-filter).
 */
export function createCandidateDeduper(
  pool: pg.Pool,
  options: { tombstoneHmacKeys?: readonly TombstoneHmacKey[] } = {},
) {
  return {
    async identityFor(input:Parameters<typeof resolveClaimApplicability>[1]):Promise<ClaimApplicability> {
      return resolveClaimApplicability(pool,input)
    },
    async activeFamilyFor(input: {
      installationId: string
      claimType: string
      scopeKey: string
      statement: string
      identity?:Omit<ClaimDuplicateInput,'claimType'|'statement'>
    }): Promise<{ exactClaimId: string | null; family: readonly ActiveClaimIdentity[] }> {
      const exactKey = normalizedClaimKey({
        claimType: input.claimType,
        scopeKey: input.scopeKey,
        statement: input.statement,
      })
      const identity=input.identity?{...input.identity,statement:input.statement,claimType:input.claimType}:null
      if(identity){
        if(identity.scopeKey!==input.scopeKey)throw new Error('identity scope mismatch')
        if(identity.status!=='verified')return{exactClaimId:null,family:[]}
        claimIdentityV2(identity)
      }
      const result = await pool.query<{ origin_policy_required:boolean;version_id:string;claim_id: string; normalized_key: string; statement: string;scope_kind:ClaimDuplicateInput['scopeKind'];scope_key:string;canonical_repository_key:string|null;
        identity_generation:number;normalized_key_v2:string|null;topic_key_v2:string|null;duplicate_digest_v2:string|null;
        branch:string|null;repository_id:string|null;repo_snapshot_id:string|null;
        applicability:unknown;consumption_hold_reason:string|null;structured_content:Record<string,unknown>;valid_from:Date|string|null;valid_until:Date|string|null }>(`
        SELECT ${ORIGIN_POLICY_REQUIRED_SQL} AS origin_policy_required,v.version_id::text,c.claim_id::text,c.normalized_key,c.normalized_key_v2,c.scope_kind,c.scope_key,c.canonical_repository_key,
          c.identity_generation,to_jsonb(c)->>'topic_key_v2' AS topic_key_v2,to_jsonb(c)->>'duplicate_digest_v2' AS duplicate_digest_v2,
          c.consumption_hold_reason,v.statement,v.structured_content,v.branch,
          v.repository_id::text,v.repo_snapshot_id::text,v.applicability,v.valid_from::text AS valid_from,v.valid_until::text AS valid_until
        FROM knowledge_claims c
        JOIN knowledge_versions v ON v.installation_id=c.installation_id AND v.claim_id=c.claim_id AND v.version_id = c.current_version_id
        WHERE c.installation_id = $1
          AND c.claim_type = $2
          AND c.scope_key = $3
          AND c.state = 'active' AND ${currentClaimVersionSql()}
          AND (NOT $4::boolean OR (c.scope_kind=$5 AND c.consumption_hold_reason IS NULL))
        ORDER BY c.claim_id
        LIMIT 10000
      `, [input.installationId,input.claimType,input.scopeKey,Boolean(identity),identity?.scopeKind??null])
      const origin=await originPolicyDecisions(pool,input.installationId,result.rows.filter(row=>row.origin_policy_required).map(row=>row.version_id))
      const family:ActiveClaimIdentity[]=[]
      let exactClaimId:string|null=null
      const inputTopic=identity?claimIdentityV2(identity).topicKey:null
      const inputDigest=identity?claimDuplicateDigestV2(identity):null
      const frames=new Map<string,ClaimApplicability>()
      for(const row of result.rows){
        if(row.consumption_hold_reason!==null||(row.origin_policy_required&&!origin.get(row.version_id)?.eligible))continue
        const facts={installationId:input.installationId,scopeKind:row.scope_kind,
          scopeKey:row.scope_key,repositoryId:row.repository_id,snapshotId:row.repo_snapshot_id,branch:row.branch,
          canonicalRepositoryKey:row.canonical_repository_key,applicability:row.applicability}
        const frameKey=JSON.stringify(facts)
        let applicability=frames.get(frameKey)
        if(!applicability){applicability=await resolveClaimApplicability(pool,facts);frames.set(frameKey,applicability)}
        if(applicability.status!=='verified')continue
        const current:ClaimDuplicateInput={...applicability,claimType:input.claimType,statement:row.statement,
          structuredContent:row.structured_content,validFrom:row.valid_from,validUntil:row.valid_until}
        try{
          const persisted=claimIdentityV2(current)
          const duplicateDigest=claimDuplicateDigestV2(current)
          assertCurrentIdentityProjection(row,{generation:row.identity_generation as 1|2,legacyKey:row.normalized_key,
            keyV2:persisted.key,topicKeyV2:persisted.topicKey,duplicateDigestV2:duplicateDigest})
          if(inputTopic!==null&&persisted.topicKey!==inputTopic)continue
          const comparison=identity?classifyClaimConflict(identity,current):undefined
          family.push({claimId:row.claim_id,statement:row.statement,versionId:row.version_id,...(comparison?{comparison}:{})})
          if(exactClaimId===null && (identity?comparison?.relation==='duplicate':row.normalized_key===exactKey))exactClaimId=row.claim_id
        }catch{continue}
      }
      return {
        exactClaimId,
        family,
      }
    },

    async tombstonedKeys(input: {
      installationId: string
      candidateKeys: readonly string[]
      identityV2ByNormalizedKey?:Readonly<Record<string,readonly string[]>>
    }): Promise<ReadonlySet<string>> {
      if (input.candidateKeys.length === 0) return new Set()
      const configured=options.tombstoneHmacKeys??[]
      const used=(await pool.query<{key_id:string}>(
        'SELECT DISTINCT key_id FROM knowledge_tombstones WHERE installation_id=$1',[input.installationId])).rows
      if(used.some(row=>!configured.some(key=>key.version===row.key_id)))throw new Error('tombstone_hmac_keyring_incomplete')
      return findTombstonedNormalizedKeys(pool, {
        installationId: input.installationId,
        normalizedKeys: input.candidateKeys,
        identityV2ByNormalizedKey:input.identityV2ByNormalizedKey,
        keys: configured,
      })
    },
  }
}

/** Older injected unit fixtures can omit the registry resolver. The production factory always provides it. */
export type CandidateDeduper = Omit<ReturnType<typeof createCandidateDeduper>,'identityFor'>
  & Partial<Pick<ReturnType<typeof createCandidateDeduper>,'identityFor'>>
