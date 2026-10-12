import {candidateReviewHash} from './review-hash.js'
import {normalizeFeedbackReason} from './feedback-policy.js'
export {normalizeFeedbackReason} from './feedback-policy.js'
import {activateRevisionInterval,ClaimVersionIntervalError} from './version-selection.js'
import type pg from 'pg'
import type {
  ClaimState,
  ClaimType,
  EvidenceInput,
  ScopeKind,
} from './types.js'
import { resolvePacketEvidence } from './evidence-resolver.js'
import {claimIdentityV2, ClaimIdentityUnavailableError} from './identity.js'
import {resolveClaimApplicability,projectClaimIdentity,assertIdentityNotTombstoned,assertClaimIdentityAvailable,assertCurrentIdentityProjection,ClaimIdentityWriteError} from './identity-writer.js'
import { normalizedClaimKey } from '../retrieval/query-normalizer.js'
import type { TombstoneHmacKey } from '../config.js'
import { findTombstonedNormalizedKeys } from './tombstones.js'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Immutable Claim/Version/Evidence ledger transactions. Every mutation locks
 * its rows with FOR UPDATE in a stable order (candidate → claim), runs the
 * exact installation filter inside each SQL statement, and commits Claim +
 * Version + Evidence + current-version pointer + feedback + index job in ONE
 * transaction — a failed evidence insert rolls the whole acceptance back and
 * leaves the candidate reviewable.
 */

export type LedgerError =
  | { code: 'candidate_not_found' }
  | { code: 'candidate_not_reviewable' }
  | { code: 'candidate_evidence_stale' }
  | { code: 'source_discovery_changed' }
  | { code: 'tombstoned_identity' }
  | { code: 'identity_requires_review' }
  | { code: 'identity_migration_required' }
  | { code: 'tombstone_hmac_keyring_incomplete' }
  | { code: 'revision_conflict'; currentRevision: number; state: string }
  | { code: 'revision_interval_requires_review' }
  | { code: 'claim_not_found' }
  | { code: 'claim_not_active' }
  | { code: 'identity_conflict' }
  | { code: 'evidence_required' }
  | { code: 'invalid_input'; detail: string }

export interface AcceptInput {
  /** Internal executor only; strict human REST schemas cannot supply this. */
  automationAuthority?:boolean
  expectedHash?:string
  reviewDurationMs?:number
  installationId: string
  candidateId: string
  expectedRevision: number
  /** Optional edited statement (accept-with-correction). */
  editedStatement?: string
}

export interface CorrectInput {
  installationId: string
  claimId: string
  expectedRevision: number
  statement: string
  evidence: readonly EvidenceInput[]
}

export function createClaimRepository(pool: pg.Pool, options: { tombstoneHmacKeys?: readonly TombstoneHmacKey[] } = {}) {
  return {
    /**
     * Explicitly accept a validated or conflict candidate. Locks the candidate
     * row, re-checks reviewability and revision, then creates claim + version +
     * evidence + pointer + feedback + index job atomically.
     */
    async acceptCandidate(input: AcceptInput): Promise<
      { ok: true; claimId: string; versionId: string; reviewDecision: 'accepted_as_is' | 'light_edit' | 'major_edit' }
      | { ok: false; error: LedgerError }
    > {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        try {
          const source = await client.query<{ session_id: string; episode_id: string }>(`
            SELECT e.session_id, e.episode_id::text
            FROM memory_candidates c
            JOIN work_episodes e
              ON e.installation_id = c.installation_id AND e.episode_id = c.episode_id
            WHERE c.installation_id = $1 AND c.candidate_id = $2
          `, [input.installationId, input.candidateId])
          const discoveredSource = source.rows[0]
          if (!discoveredSource) {
            await client.query('ROLLBACK')
            return { ok: false, error: { code: 'candidate_not_found' } }
          }
          await client.query(`
            SELECT pg_advisory_xact_lock(hashtextextended('purge:session:' || $1 || ':' || $2, 0)),
                   pg_advisory_xact_lock(hashtextextended('purge:installation:' || $1, 0))
          `, [input.installationId, discoveredSource.session_id])
          const candidate = await client.query<{
            candidate_id: string
            episode_id: string
            run_id: string
            claim_type: ClaimType
            statement: string
            structured_content: Record<string, unknown>
            normalized_key: string
            scope_kind: ScopeKind
            scope_key: string
            repository_id: string | null
            repo_snapshot_id: string | null
            branch: string | null
            confidence: string
            freshness_at: Date
            valid_from: Date | null
            valid_until: Date | null
            evidence_handles: unknown
            validation:{applicability?:unknown}
            status: string
            revision: string
          }>(`
            SELECT candidate_id::text, episode_id::text, run_id::text, claim_type, statement, structured_content,
                   normalized_key, scope_kind, scope_key, repository_id::text, repo_snapshot_id::text,
                   branch, confidence::text, freshness_at, valid_from, valid_until,
                   evidence_handles,validation, status, revision::text
            FROM memory_candidates
            WHERE installation_id = $1 AND candidate_id = $2
            FOR UPDATE
          `, [input.installationId, input.candidateId])
          const row = candidate.rows[0]
          if (!row) {
            await client.query('ROLLBACK')
            return { ok: false, error: { code: 'candidate_not_found' } }
          }
          // Prove the actual locked candidate still belongs to the source
          // tuple whose Session key was discovered before installation ownership.
          const currentSource = await client.query<{session_id:string}>(`
            SELECT session_id FROM work_episodes
            WHERE installation_id=$1 AND episode_id=$2
          `,[input.installationId,row.episode_id])
          if (row.episode_id !== discoveredSource.episode_id || currentSource.rows[0]?.session_id !== discoveredSource.session_id) {
            await client.query('ROLLBACK')
            return {ok:false,error:{code:'source_discovery_changed'}}
          }
          if(input.expectedHash!==undefined&&candidateReviewHash(row as unknown as Record<string,unknown>)!==input.expectedHash){await client.query('ROLLBACK');return {ok:false,error:{code:'revision_conflict',currentRevision:Number(row.revision),state:row.status}}}
          if (row.status !== 'validated' && row.status !== 'conflict') {
            await client.query('ROLLBACK')
            return { ok: false, error: { code: 'candidate_not_reviewable' } }
          }
          if (Number(row.revision) !== input.expectedRevision) {
            await client.query('ROLLBACK')
            return { ok: false, error: { code: 'revision_conflict', currentRevision: Number(row.revision), state: row.status } }
          }

          const evidenceRevision = await client.query<{ current: boolean }>(`
            SELECT e.source_digest = r.episode_source_digest AS current
            FROM work_episodes e
            JOIN memory_extraction_runs r ON r.installation_id = e.installation_id AND r.episode_id = e.episode_id
            WHERE e.installation_id = $1 AND e.episode_id = $2 AND r.run_id = $3
            FOR SHARE OF e
          `, [input.installationId, row.episode_id, row.run_id])
          if (!evidenceRevision.rows[0]?.current) {
            await client.query('ROLLBACK')
            return { ok: false, error: { code: 'candidate_evidence_stale' } }
          }
          if (row.valid_until && row.valid_until.getTime() <= Date.now()) {
            await client.query('ROLLBACK')
            return { ok: false, error: { code: 'invalid_input', detail: 'validity window expired' } }
          }

          // Exact identity maps to one claim. Acceptance never silently
          // corrects an existing claim; that needs its own revision token.
          const statement = input.editedStatement?.trim() || row.statement
          if (statement.length === 0 || statement.length > 4000) {
            await client.query('ROLLBACK')
            return { ok: false, error: { code: 'invalid_input', detail: 'statement length' } }
          }

          const applicability=await resolveClaimApplicability(client,{installationId:input.installationId,scopeKind:row.scope_kind,scopeKey:row.scope_key,
            repositoryId:row.repository_id,snapshotId:row.repo_snapshot_id,branch:row.branch,applicability:row.validation?.applicability})
          const projection=await projectClaimIdentity(client,{installationId:input.installationId,claimType:row.claim_type,statement,
            structuredContent:row.structured_content??{},applicability,validFrom:row.valid_from,validUntil:row.valid_until})
          const finalNormalizedKey=projection.legacyKey
          await assertIdentityNotTombstoned(client,{installationId:input.installationId,projection,keys:options.tombstoneHmacKeys??[]})
          await assertClaimIdentityAvailable(client,{installationId:input.installationId,claimType:row.claim_type,scopeKey:row.scope_key,projection})
          const created = await client.query<{ claim_id: string }>(`
            INSERT INTO knowledge_claims
              (claim_id, installation_id, claim_type, scope_kind, scope_key, normalized_key, state,canonical_repository_key,identity_generation,normalized_key_v2,topic_key_v2,duplicate_digest_v2,consumption_hold_reason)
            VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'active',$6,$7,$8,$9,$10,$11)
            RETURNING claim_id::text
          `, [input.installationId,row.claim_type,row.scope_kind,row.scope_key,finalNormalizedKey,applicability.canonicalRepositoryKey,projection.generation,projection.keyV2,projection.topicKeyV2,projection.duplicateDigestV2,applicability.status==='verified'?null:'identity_requires_review'])
          const claimId = created.rows[0].claim_id
          const versionNumber = 1

          const version = await client.query<{ version_id: string }>(`
            INSERT INTO knowledge_versions
              (version_id, installation_id, claim_id, version_number, statement,
               structured_content, authority, confidence, repository_id, repo_snapshot_id, branch,
               freshness_at, valid_from, valid_until, source_candidate_id,applicability,effective_from)
            VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14,$15::jsonb,clock_timestamp())
            RETURNING version_id::text
          `, [
            input.installationId, claimId, versionNumber, statement,
            JSON.stringify(row.structured_content ?? {}),
            input.automationAuthority?'automation_accepted':input.editedStatement ? 'user_corrected' : 'user_accepted',
            row.confidence, row.repository_id, row.repo_snapshot_id, row.branch,
            row.freshness_at, row.valid_from, row.valid_until, row.candidate_id,JSON.stringify(applicability),
          ])
          const versionId = version.rows[0].version_id

          // Evidence derives from the run's episode via the evidence service;
          // at least one row is mandatory before the pointer moves.
          const evidenceRows = await insertEvidenceForVersion(client, {
            installationId: input.installationId,
            versionId,
            claimId,
            episodeId: row.episode_id,
            evidenceHandles: Array.isArray(row.evidence_handles)
              ? row.evidence_handles.filter((handle): handle is string => typeof handle === 'string').slice(0, 12)
              : [],
            repositoryId: row.repository_id,
            repoSnapshotId: row.repo_snapshot_id,
            branch: row.branch,
            locatorKey: 'candidate_acceptance',
          })
          if (evidenceRows === 0) {
            await client.query('ROLLBACK')
            return { ok: false, error: { code: 'evidence_required' } }
          }

          await client.query(`
            UPDATE knowledge_claims SET current_version_id = $2, updated_at = NOW()
            WHERE installation_id = $1 AND claim_id = $3
          `, [input.installationId, versionId, claimId])
          await client.query(`
            UPDATE memory_candidates SET status = 'accepted', reviewed_at = NOW(), revision = revision + 1
            WHERE installation_id = $1 AND candidate_id = $2
          `, [input.installationId, input.candidateId])
          await client.query(`
            INSERT INTO memory_feedback (feedback_id, installation_id, candidate_id, claim_id, version_id, action,details)
            VALUES (gen_random_uuid(), $1, $2, $3, $4, $5,$6)
          `, [input.installationId, input.candidateId, claimId, versionId,
            input.editedStatement ? 'candidate_corrected' : 'candidate_accepted',JSON.stringify(input.automationAuthority?{actor_kind:'automation_executor',decision:'auto_accepted'}:input.reviewDurationMs===undefined?{}:{review_duration_ms:input.reviewDurationMs})])
          await client.query(`
            INSERT INTO memory_jobs (job_id, installation_id, job_type, idempotency_key, priority, payload)
            VALUES (gen_random_uuid(), $1, 'index_claim_version', $2, 90, $3::jsonb)
            ON CONFLICT DO NOTHING
          `, [input.installationId, `index:${versionId}`, JSON.stringify({ version_id: versionId })])

          await client.query('COMMIT')
          return {
            ok: true,
            claimId,
            versionId,
            reviewDecision: reviewDecision(row.statement, input.editedStatement),
          }
        } catch (error) {
          await client.query('ROLLBACK')
          if(error instanceof ClaimVersionIntervalError)return{ok:false,error:{code:'revision_interval_requires_review'}}
          if(error instanceof ClaimIdentityWriteError)return{ok:false,error:{code:error.code}}
          throw error
        }
      } finally {
        client.release()
      }
    },

    /** Reject a validated candidate with a bounded reason. */
    async rejectCandidate(input: {
      installationId: string
      candidateId: string
      expectedRevision: number
      reasonCode?: string
      expectedHash?:string
      reviewDurationMs?:number
    }): Promise<{ ok: true } | { ok: false; error: LedgerError }> {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('purge:installation:'||$1,0))",[input.installationId])
        try {
          const candidate = await client.query<{ status: string; revision: string;candidate:Record<string,unknown> }>(`
            SELECT status, revision::text,to_jsonb(memory_candidates) candidate FROM memory_candidates
            WHERE installation_id = $1 AND candidate_id = $2
            FOR UPDATE
          `, [input.installationId, input.candidateId])
          const row = candidate.rows[0]
          if (!row) {
            await client.query('ROLLBACK')
            return { ok: false, error: { code: 'candidate_not_found' } }
          }
          if(input.expectedHash!==undefined&&candidateReviewHash(row.candidate)!==input.expectedHash){await client.query('ROLLBACK');return {ok:false,error:{code:'revision_conflict',currentRevision:Number(row.revision),state:row.status}}}
          if (row.status !== 'validated' && row.status !== 'conflict') {
            await client.query('ROLLBACK')
            return { ok: false, error: { code: 'candidate_not_reviewable' } }
          }
          if (Number(row.revision) !== input.expectedRevision) {
            await client.query('ROLLBACK')
            return { ok: false, error: { code: 'revision_conflict', currentRevision: Number(row.revision), state: row.status } }
          }
          await client.query(`
            UPDATE memory_candidates SET status = 'rejected', reviewed_at = NOW(), revision = revision + 1
            WHERE installation_id = $1 AND candidate_id = $2
          `, [input.installationId, input.candidateId])
          await client.query(`
            INSERT INTO memory_feedback (feedback_id, installation_id, candidate_id, action, reason_code,details)
            VALUES (gen_random_uuid(), $1, $2, 'candidate_rejected', $3,$4)
          `, [input.installationId, input.candidateId, normalizeFeedbackReason(input.reasonCode),JSON.stringify(input.reviewDurationMs===undefined?{}:{review_duration_ms:input.reviewDurationMs})])
          await client.query('COMMIT')
          return { ok: true }
        } catch (error) {
          await client.query('ROLLBACK')
          if(error instanceof ClaimVersionIntervalError)return{ok:false,error:{code:'revision_interval_requires_review'}}
          if(error instanceof ClaimIdentityWriteError)return{ok:false,error:{code:error.code}}
          throw error
        }
      } finally {
        client.release()
      }
    },

    /**
     * Correct an active claim: never overwrite — insert Version N+1 and move
     * the current pointer atomically under the claim's CAS revision.
     */
    async correctClaim(input: CorrectInput): Promise<
      { ok: true; claimId: string; versionId: string; versionNumber: number } | { ok: false; error: LedgerError }
    > {
      if (input.evidence.length === 0) {
        return { ok: false, error: { code: 'evidence_required' } }
      }
      if (input.statement.trim().length === 0 || input.statement.trim().length > 4000) {
        return { ok: false, error: { code: 'invalid_input', detail: 'statement length' } }
      }
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        try {
          if (input.evidence.some(evidence =>
            typeof evidence.episodeId !== 'string' || !UUID_PATTERN.test(evidence.episodeId)
            || (evidence.evidenceKind === 'event'
              && (typeof evidence.sourceEventId !== 'string' || !UUID_PATTERN.test(evidence.sourceEventId)))
            || (evidence.evidenceKind === 'artifact'
              && (typeof evidence.artifactId !== 'string' || !UUID_PATTERN.test(evidence.artifactId))))) {
            await client.query('ROLLBACK')
            return { ok: false, error: { code: 'invalid_input', detail: 'evidence provenance' } }
          }
          const episodeIds = [...new Set(input.evidence.map(evidence => evidence.episodeId as string))]
          const episodes = await client.query<{ episode_id: string; session_id: string }>(`
            SELECT episode_id::text, session_id FROM work_episodes
            WHERE installation_id = $1 AND episode_id = ANY($2::uuid[])
          `, [input.installationId, episodeIds])
          if (episodes.rows.length !== episodeIds.length) {
            await client.query('ROLLBACK')
            return { ok: false, error: { code: 'invalid_input', detail: 'evidence provenance' } }
          }
          const sessionIds = [...new Set(episodes.rows.map(row => row.session_id))].sort()
          for (const sessionId of sessionIds) {
            await client.query(`
              SELECT pg_advisory_xact_lock(hashtextextended('purge:session:' || $1 || ':' || $2, 0))
            `, [input.installationId, sessionId])
          }
          await client.query(`
            SELECT pg_advisory_xact_lock(hashtextextended('purge:installation:' || $1, 0))
          `, [input.installationId])
          const episodesAfterLock = await client.query<{ episode_id: string; session_id: string }>(`
            SELECT episode_id::text, session_id FROM work_episodes
            WHERE installation_id = $1 AND episode_id = ANY($2::uuid[])
          `, [input.installationId, episodeIds])
          if (episodesAfterLock.rows.length !== episodeIds.length) {
            await client.query('ROLLBACK')
            return { ok: false, error: { code: 'invalid_input', detail: 'evidence provenance' } }
          }
          const discoveredEpisodes = new Map(episodes.rows.map(row=>[row.episode_id,row.session_id]))
          if (episodesAfterLock.rows.some(row=>discoveredEpisodes.get(row.episode_id)!==row.session_id)) {
            await client.query('ROLLBACK')
            return {ok:false,error:{code:'source_discovery_changed'}}
          }

          const claim = await client.query<{
            claim_id: string
            state: ClaimState
            revision: string
            claim_type: ClaimType
            scope_kind: ScopeKind
            scope_key: string
            current_version_id: string
            repository_id: string | null
            repo_snapshot_id: string | null
            branch: string | null
            canonical_repository_key:string|null
            normalized_key_v2:string|null
            identity_generation:number
            statement:string
            topic_key_v2:string|null;duplicate_digest_v2:string|null
            applicability:unknown;consumption_hold_reason:string|null;structured_content:Record<string,unknown>;valid_from:Date|null;valid_until:Date|null
          }>(`
            SELECT c.claim_id::text, c.state, c.revision::text, c.claim_type, c.scope_kind,
                   c.current_version_id::text,
                   c.scope_key,c.canonical_repository_key,c.normalized_key_v2,c.identity_generation,c.topic_key_v2,c.duplicate_digest_v2,v.statement, v.repository_id::text, v.repo_snapshot_id::text, v.branch,v.applicability,c.consumption_hold_reason,v.structured_content,v.valid_from,v.valid_until
            FROM knowledge_claims c
            LEFT JOIN knowledge_versions v ON v.version_id = c.current_version_id
            WHERE c.installation_id = $1 AND c.claim_id = $2
            FOR UPDATE OF c
          `, [input.installationId, input.claimId])
          const row = claim.rows[0]
          if (!row) {
            await client.query('ROLLBACK')
            return { ok: false, error: { code: 'claim_not_found' } }
          }
          if (row.state !== 'active') {
            await client.query('ROLLBACK')
            return { ok: false, error: { code: 'claim_not_active' } }
          }
          if (Number(row.revision) !== input.expectedRevision) {
            await client.query('ROLLBACK')
            return { ok: false, error: { code: 'revision_conflict', currentRevision: Number(row.revision), state: row.state } }
          }
          for (const evidence of input.evidence) {
            const provenance = evidence.evidenceKind === 'event'
              ? await client.query(`
                  SELECT 1 FROM work_episodes e
                  JOIN source_events s
                    ON s.installation_id = e.installation_id
                   AND s.source_event_id = $3
                   AND s.session_id = e.session_id
                   AND s.turn_id = e.turn_id
                  WHERE e.installation_id = $1 AND e.episode_id = $2
                `, [input.installationId, evidence.episodeId, evidence.sourceEventId])
              : evidence.evidenceKind === 'artifact'
                ? await client.query(`
                    SELECT 1 FROM work_episodes e
                    JOIN source_artifacts a
                      ON a.installation_id = e.installation_id
                     AND a.artifact_id = $3
                     AND a.session_id = e.session_id
                     AND a.turn_id = e.turn_id
                    WHERE e.installation_id = $1 AND e.episode_id = $2
                  `, [input.installationId, evidence.episodeId, evidence.artifactId])
                : { rows: [{}] }
            if (!provenance.rows[0]) {
              await client.query('ROLLBACK')
              return { ok: false, error: { code: 'invalid_input', detail: 'evidence provenance' } }
            }
          }
          const finalStatement = input.statement.trim()
          const applicability=await resolveClaimApplicability(client,{installationId:input.installationId,scopeKind:row.scope_kind,scopeKey:row.scope_key,
            canonicalRepositoryKey:row.canonical_repository_key,repositoryId:row.repository_id,snapshotId:row.repo_snapshot_id,branch:row.branch,
            applicability:row.applicability,consumptionHoldReason:row.consumption_hold_reason})
          const priorProjection=await projectClaimIdentity(client,{installationId:input.installationId,claimType:row.claim_type,statement:row.statement,
            structuredContent:row.structured_content??{},applicability,validFrom:row.valid_from,validUntil:row.valid_until})
          assertCurrentIdentityProjection(row,priorProjection)
          const finalNormalizedKey=normalizedClaimKey({claimType:row.claim_type,scopeKey:row.scope_key,statement:finalStatement})
          const next = await client.query<{ max_version: number | null }>(`
            SELECT MAX(version_number) AS max_version FROM knowledge_versions
            WHERE installation_id = $1 AND claim_id = $2
          `, [input.installationId, input.claimId])
          const versionNumber = (next.rows[0].max_version ?? 0) + 1
          const effectiveAt = await client.query<{ effective_at: Date }>(`
            SELECT clock_timestamp() AS effective_at
          `)
          const correctionAt = effectiveAt.rows[0].effective_at
          const projection=await projectClaimIdentity(client,{installationId:input.installationId,claimType:row.claim_type,statement:finalStatement,
            structuredContent:row.structured_content??{},applicability,validFrom:row.valid_from,validUntil:row.valid_until})
          await assertIdentityNotTombstoned(client,{installationId:input.installationId,projection,keys:options.tombstoneHmacKeys??[]})
          await assertClaimIdentityAvailable(client,{installationId:input.installationId,claimType:row.claim_type,scopeKey:row.scope_key,projection,excludeClaimId:input.claimId})
          const version = await client.query<{ version_id: string }>(`
            INSERT INTO knowledge_versions
              (version_id, installation_id, claim_id, version_number, statement,
               structured_content, authority, confidence, repository_id, repo_snapshot_id, branch,
               freshness_at, valid_from, valid_until,applicability)
            SELECT gen_random_uuid(), $1, $2, $3, $4, source.structured_content, 'user_corrected', 0.9, $5, $6, $7, $8, source.valid_from,source.valid_until,$9::jsonb
            FROM knowledge_versions source WHERE source.installation_id=$1 AND source.version_id=$10
            RETURNING version_id::text
          `, [input.installationId, input.claimId, versionNumber, finalStatement,
            row.repository_id, row.repo_snapshot_id, row.branch, correctionAt,JSON.stringify(applicability),row.current_version_id])
          const versionId = version.rows[0].version_id

          const capsuleId = await insertEvidenceCapsule(client, {
            installationId: input.installationId,
            versionId,
            repositoryId: row.repository_id,
            repoSnapshotId: row.repo_snapshot_id,
            branch: row.branch,
            acceptedAt: correctionAt,
            sourceContent: JSON.stringify(input.evidence.slice(0, 13).map(evidence => ({
              kind: evidence.evidenceKind,
              excerpt: evidence.excerpt,
              occurredAt: evidence.occurredAt,
            }))),
          })

          let inserted = 0
          for (const [index, evidence] of input.evidence.slice(0, 13).entries()) {
            if (index >= 64) break
            await insertExplicitEvidence(client, {
              installationId: input.installationId,
              versionId,
              capsuleId,
              evidence,
              ordinal: index,
            })
            inserted++
          }
          if (inserted === 0) {
            await client.query('ROLLBACK')
            return { ok: false, error: { code: 'evidence_required' } }
          }

          await activateRevisionInterval(client,{installationId:input.installationId,claimId:input.claimId,previousVersionId:row.current_version_id,versionId})
          await client.query(`
            UPDATE knowledge_claims
            SET current_version_id = $2, normalized_key = $4, normalized_key_v2=$5,topic_key_v2=$6,duplicate_digest_v2=$7,identity_generation=GREATEST(identity_generation,$8),canonical_repository_key=$9,consumption_hold_reason=CASE WHEN $10 THEN COALESCE(consumption_hold_reason,'identity_requires_review') ELSE consumption_hold_reason END,
                revision = revision + 1, updated_at = NOW()
            WHERE installation_id = $1 AND claim_id = $3
          `, [input.installationId, versionId, input.claimId, finalNormalizedKey,projection.keyV2,projection.topicKeyV2,projection.duplicateDigestV2,projection.generation,applicability.canonicalRepositoryKey,applicability.status!=='verified'])
          await client.query(`
            INSERT INTO memory_feedback (feedback_id, installation_id, claim_id, version_id, action)
            VALUES (gen_random_uuid(), $1, $2, $3, 'claim_corrected')
          `, [input.installationId, input.claimId, versionId])
          await client.query(`
            INSERT INTO memory_jobs (job_id, installation_id, job_type, idempotency_key, priority, payload)
            VALUES (gen_random_uuid(), $1, 'index_claim_version', $2, 90, $3::jsonb)
            ON CONFLICT DO NOTHING
          `, [input.installationId, `index:${versionId}`, JSON.stringify({ version_id: versionId })])
          await client.query('COMMIT')
          return { ok: true, claimId: input.claimId, versionId, versionNumber }
        } catch (error) {
          await client.query('ROLLBACK')
          if(error instanceof ClaimVersionIntervalError)return{ok:false,error:{code:'revision_interval_requires_review'}}
          if(error instanceof ClaimIdentityWriteError)return{ok:false,error:{code:error.code}}
          throw error
        }
      } finally {
        client.release()
      }
    },

    /** Terminal state transitions: expire / revoke; idempotent and bounded. */
    async transitionClaim(input: {
      installationId: string
      claimId: string
      target: 'expired' | 'revoked'
      expectedRevision?: number
    }): Promise<{ ok: true } | { ok: false; error: LedgerError }> {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        try {
          // Installation deletion owns derived generations/outbox before Claims.
          // Join its lifecycle fence before taking any domain row lock.
          await client.query(`SELECT pg_advisory_xact_lock_shared(hashtextextended('purge:installation:' || $1,0))`, [input.installationId])
          const claim = await client.query<{ claim_id: string; state: string; revision: string; current_version_id: string | null }>(`
            SELECT claim_id::text, state, revision::text, current_version_id::text
            FROM knowledge_claims
            WHERE installation_id = $1 AND claim_id = $2
            FOR UPDATE
          `, [input.installationId, input.claimId])
          const row = claim.rows[0]
          if (!row) {
            await client.query('ROLLBACK')
            return { ok: false, error: { code: 'claim_not_found' } }
          }
          if (row.state !== 'active') {
            // Already terminal — idempotent success, nothing to mutate.
            await client.query('ROLLBACK')
            return row.state === input.target ? { ok: true } : { ok: false, error: { code: 'claim_not_active' } }
          }
          if (input.expectedRevision !== undefined && Number(row.revision) !== input.expectedRevision) {
            await client.query('ROLLBACK')
            return { ok: false, error: { code: 'revision_conflict', currentRevision: Number(row.revision), state: row.state } }
          }
          await client.query(`
            UPDATE knowledge_claims SET state = $3, revision = revision + 1, updated_at = NOW()
            WHERE installation_id = $1 AND claim_id = $2
          `, [input.installationId, input.claimId, input.target])
          if (row.current_version_id) {
            await client.query(`
              DELETE FROM claim_search_documents
              WHERE installation_id = $1 AND version_id = $2
            `, [input.installationId, row.current_version_id])
          }
          await client.query(`
            INSERT INTO memory_feedback (feedback_id, installation_id, claim_id, version_id, action)
            VALUES (gen_random_uuid(), $1, $2, $3, $4)
          `, [input.installationId, input.claimId, row.current_version_id,
            input.target === 'expired' ? 'claim_expired' : 'claim_revoked'])
          await client.query('COMMIT')
          return { ok: true }
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        }
      } finally {
        client.release()
      }
    },

    /** Replace identity: mark superseded pointing at the successor. */
    async supersedeClaim(input: {
      installationId: string
      claimId: string
      supersededByClaimId: string
      expectedRevision: number
    }): Promise<{ ok: true } | { ok: false; error: LedgerError }> {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        try {
          await client.query(`SELECT pg_advisory_xact_lock_shared(hashtextextended('purge:installation:' || $1,0))`, [input.installationId])
          // Stable lock order: sort by claim id.
          const [first, second] = [input.claimId, input.supersededByClaimId].sort()
          for (const id of [first, second]) {
            await client.query(`
              SELECT claim_id FROM knowledge_claims
              WHERE installation_id = $1 AND claim_id = $2 FOR UPDATE
            `, [input.installationId, id])
          }
          const claim = await client.query<{ state: string; revision: string }>(`
            SELECT state, revision::text FROM knowledge_claims
            WHERE installation_id = $1 AND claim_id = $2
          `, [input.installationId, input.claimId])
          const row = claim.rows[0]
          if (!row) {
            await client.query('ROLLBACK')
            return { ok: false, error: { code: 'claim_not_found' } }
          }
          if (Number(row.revision) !== input.expectedRevision) {
            await client.query('ROLLBACK')
            return { ok: false, error: { code: 'revision_conflict', currentRevision: Number(row.revision), state: row.state } }
          }
          await client.query(`
            UPDATE knowledge_claims
            SET state = 'superseded', superseded_by_claim_id = $3,
                revision = revision + 1, updated_at = NOW()
            WHERE installation_id = $1 AND claim_id = $2
          `, [input.installationId, input.claimId, input.supersededByClaimId])
          await client.query('COMMIT')
          return { ok: true }
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        }
      } finally {
        client.release()
      }
    },
  }
}

type QueryClient = Pick<pg.PoolClient, 'query'>

/**
 * Resolve source evidence, then persist only the bounded accepted capsule.
 */
async function insertEvidenceForVersion(
  client: QueryClient,
  input: {
    installationId: string
    versionId: string
    claimId: string
    episodeId: string
    evidenceHandles: readonly string[]
    repositoryId: string | null
    repoSnapshotId: string | null
    branch: string | null
    locatorKey: string
  },
): Promise<number> {
  const packet = await client.query<{
    document: unknown
    evidence_manifest: unknown
    terminal_at: Date | null
    updated_at: Date
  }>(`
    SELECT document, evidence_manifest, terminal_at, updated_at
    FROM work_episodes
    WHERE installation_id = $1 AND episode_id = $2
  `, [input.installationId, input.episodeId])
  const episode = packet.rows[0]
  if (!episode) return 0
  const resolved = resolvePacketEvidence(
    episode.document,
    episode.evidence_manifest,
    input.evidenceHandles,
  )
  if (resolved.length !== input.evidenceHandles.length) return 0

  const prepared: Array<{
    evidence: (typeof resolved)[number]
    occurredAt: Date
  }> = []
  for (const [ordinal, evidence] of resolved.entries()) {
    let occurredAt = episode.terminal_at ?? episode.updated_at
    if (evidence.manifest.kind === 'event' && evidence.manifest.source_event_id) {
      const source = await client.query<{ occurred_at: Date }>(`
        SELECT occurred_at FROM source_events
        WHERE installation_id = $1 AND source_event_id = $2
      `, [input.installationId, evidence.manifest.source_event_id])
      if (!source.rows[0]) return 0
      occurredAt = source.rows[0].occurred_at
    }
    if (evidence.manifest.kind === 'artifact' && evidence.manifest.artifact_id) {
      const artifact = await client.query<{ occurred_at: Date }>(`
        SELECT occurred_at FROM source_artifacts
        WHERE installation_id = $1 AND artifact_id = $2
      `, [input.installationId, evidence.manifest.artifact_id])
      if (!artifact.rows[0]) return 0
      occurredAt = artifact.rows[0].occurred_at
    }
    prepared.push({ evidence, occurredAt })
  }
  const capsuleId = await insertEvidenceCapsule(client, {
    installationId: input.installationId,
    versionId: input.versionId,
    repositoryId: input.repositoryId,
    repoSnapshotId: input.repoSnapshotId,
    branch: input.branch,
    acceptedAt: null,
    sourceContent: JSON.stringify(prepared.map(({ evidence }) => ({
      handle: evidence.handle,
      kind: evidence.manifest.kind,
      excerptHash: evidence.manifest.excerpt_hash ?? null,
      excerpt: evidence.excerpt,
    }))),
  })

  let insertedCount = 0
  for (const [ordinal, { evidence, occurredAt }] of prepared.entries()) {
    const inserted = await client.query(`
      INSERT INTO knowledge_evidence
        (evidence_id, installation_id, version_id, capsule_id, episode_id,
         source_event_id, artifact_id, evidence_kind, locator, excerpt, excerpt_hash,
         source_evidence_hash, occurred_at, ordinal)
      VALUES (gen_random_uuid(), $1, $2, $3, NULL, NULL, NULL, 'accepted_excerpt',
              $4::jsonb, $5, sha256(convert_to($5, 'utf8')), $6, $7, $8)
      ON CONFLICT (version_id, ordinal) DO NOTHING
    `, [
      input.installationId,
      input.versionId,
      capsuleId,
      JSON.stringify({
        key: input.locatorKey,
        evidence_handle: evidence.handle,
        source_kind: evidence.manifest.kind,
        excerpt_hash: evidence.manifest.excerpt_hash ?? null,
        truncated: evidence.manifest.truncated ?? false,
        ...(evidence.manifest.source_provenance
          ? { source_provenance: evidence.manifest.source_provenance }
          : {}),
        repository_id: input.repositoryId,
        repo_snapshot_id: input.repoSnapshotId,
        branch: input.branch,
      }),
      evidence.excerpt,
      evidence.manifest.excerpt_hash ?? null,
      occurredAt,
      ordinal,
    ])
    insertedCount += inserted.rowCount ?? 0
  }
  return insertedCount
}

async function insertExplicitEvidence(
  client: QueryClient,
  input: {
    installationId: string
    versionId: string
    capsuleId: string
    evidence: EvidenceInput
    ordinal: number
  },
): Promise<void> {
  await client.query(`
    INSERT INTO knowledge_evidence
      (evidence_id, installation_id, version_id, capsule_id, episode_id,
       source_event_id, artifact_id, evidence_kind, locator, excerpt, excerpt_hash,
       source_evidence_hash, occurred_at, ordinal)
    VALUES (gen_random_uuid(), $1, $2, $3, NULL, NULL, NULL, 'accepted_excerpt',
            $4::jsonb, $5, sha256(convert_to($5, 'utf8')),
            encode(sha256(convert_to($5, 'utf8')), 'hex'), $6, $7)
    ON CONFLICT (version_id, ordinal) DO NOTHING
  `, [
    input.installationId, input.versionId, input.capsuleId,
    JSON.stringify(sanitizeAcceptedLocator(input.evidence.locator ?? {}, input.evidence.evidenceKind)),
    input.evidence.excerpt,
    input.evidence.occurredAt,
    input.ordinal,
  ])
}

async function insertEvidenceCapsule(
  client: QueryClient,
  input: {
    installationId: string
    versionId: string
    repositoryId: string | null
    repoSnapshotId: string | null
    branch: string | null
    acceptedAt: Date | null
    sourceContent: string
  },
): Promise<string> {
  const inserted = await client.query<{ capsule_id: string }>(`
    INSERT INTO knowledge_evidence_capsules
      (capsule_id, installation_id, version_id, retention_basis, accepted_at,
       repository_id, repo_snapshot_id, branch, source_content_hash)
    VALUES (gen_random_uuid(), $1, $2, 'user_accepted', COALESCE($3, NOW()),
            $4, $5, $6, sha256(convert_to($7, 'utf8')))
    RETURNING capsule_id::text
  `, [
    input.installationId, input.versionId, input.acceptedAt,
    input.repositoryId, input.repoSnapshotId, input.branch, input.sourceContent,
  ])
  return inserted.rows[0].capsule_id
}

function sanitizeAcceptedLocator(
  locator: Record<string, unknown>,
  sourceKind: EvidenceInput['evidenceKind'],
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = { ...locator, source_kind: sourceKind }
  for (const key of [
    'session_id', 'sessionId', 'episode_id', 'episodeId',
    'source_event_id', 'sourceEventId', 'artifact_id', 'artifactId',
  ]) delete sanitized[key]
  return sanitized
}

export type ClaimRepository = ReturnType<typeof createClaimRepository>

function reviewDecision(
  original: string,
  edited: string | undefined,
): 'accepted_as_is' | 'light_edit' | 'major_edit' {
  if (!edited || edited.trim() === original.trim()) return 'accepted_as_is'
  const left = Array.from(original.replace(/\s+/g, ' ').trim())
  const right = Array.from(edited.replace(/\s+/g, ' ').trim())
  const distance = levenshtein(left, right)
  return distance / Math.max(1, left.length) <= 0.2 ? 'light_edit' : 'major_edit'
}

function levenshtein(left: string[], right: string[]): number {
  let previous = [0, ...right.map((_, index) => index + 1)]
  for (let row = 1; row <= left.length; row++) {
    const current = [row]
    for (let column = 1; column <= right.length; column++) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1),
      )
    }
    previous = current
  }
  return previous[right.length]
}
