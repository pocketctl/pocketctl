import type pg from 'pg'
import type {
  ClaimState,
  ClaimType,
  EvidenceInput,
  ScopeKind,
} from './types.js'
import { resolvePacketEvidence } from './evidence-resolver.js'
import { normalizedClaimKey } from '../retrieval/query-normalizer.js'

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
  | { code: 'revision_conflict'; currentRevision: number; state: string }
  | { code: 'claim_not_found' }
  | { code: 'claim_not_active' }
  | { code: 'identity_conflict' }
  | { code: 'evidence_required' }
  | { code: 'invalid_input'; detail: string }

export interface AcceptInput {
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

export function createClaimRepository(pool: pg.Pool) {
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
          const source = await client.query<{ session_id: string }>(`
            SELECT e.session_id
            FROM memory_candidates c
            JOIN work_episodes e
              ON e.installation_id = c.installation_id AND e.episode_id = c.episode_id
            WHERE c.installation_id = $1 AND c.candidate_id = $2
          `, [input.installationId, input.candidateId])
          if (source.rows[0]) {
            await client.query(`
              SELECT pg_advisory_xact_lock(hashtextextended('purge:session:' || $1 || ':' || $2, 0)),
                     pg_advisory_xact_lock(hashtextextended('purge:installation:' || $1, 0))
            `, [input.installationId, source.rows[0].session_id])
          }
          const candidate = await client.query<{
            candidate_id: string
            episode_id: string
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
            status: string
            revision: string
          }>(`
            SELECT candidate_id::text, episode_id::text, claim_type, statement, structured_content,
                   normalized_key, scope_kind, scope_key, repository_id::text, repo_snapshot_id::text,
                   branch, confidence::text, freshness_at, valid_from, valid_until,
                   evidence_handles, status, revision::text
            FROM memory_candidates
            WHERE installation_id = $1 AND candidate_id = $2
            FOR UPDATE
          `, [input.installationId, input.candidateId])
          const row = candidate.rows[0]
          if (!row) {
            await client.query('ROLLBACK')
            return { ok: false, error: { code: 'candidate_not_found' } }
          }
          if (row.status !== 'validated' && row.status !== 'conflict') {
            await client.query('ROLLBACK')
            return { ok: false, error: { code: 'candidate_not_reviewable' } }
          }
          if (Number(row.revision) !== input.expectedRevision) {
            await client.query('ROLLBACK')
            return { ok: false, error: { code: 'revision_conflict', currentRevision: Number(row.revision), state: row.status } }
          }

          // Exact identity maps to one claim; an existing active claim under
          // the same identity means this acceptance corrects it instead.
          const statement = input.editedStatement?.trim() || row.statement
          if (statement.length === 0 || statement.length > 4000) {
            await client.query('ROLLBACK')
            return { ok: false, error: { code: 'invalid_input', detail: 'statement length' } }
          }

          const finalNormalizedKey = normalizedClaimKey({
            claimType: row.claim_type,
            scopeKey: row.scope_key,
            statement,
          })
          await client.query(`
            SELECT pg_advisory_xact_lock(hashtextextended('claim-identity:' || $1 || ':' || $2 || ':' || $3 || ':' || $4, 0))
          `, [input.installationId, row.claim_type, row.scope_key, finalNormalizedKey])
          const existingClaim = await client.query<{ claim_id: string }>(`
            SELECT claim_id::text, revision::text FROM knowledge_claims
            WHERE installation_id = $1 AND claim_type = $2 AND scope_key = $3 AND normalized_key = $4
            FOR UPDATE
          `, [input.installationId, row.claim_type, row.scope_key, finalNormalizedKey])

          if (existingClaim.rows[0]) {
            await client.query('ROLLBACK')
            return { ok: false, error: { code: 'identity_conflict' } }
          }
          const created = await client.query<{ claim_id: string }>(`
            INSERT INTO knowledge_claims
              (claim_id, installation_id, claim_type, scope_kind, scope_key, normalized_key, state)
            VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'active')
            RETURNING claim_id::text
          `, [input.installationId, row.claim_type, row.scope_kind, row.scope_key, finalNormalizedKey])
          const claimId = created.rows[0].claim_id
          const versionNumber = 1

          const version = await client.query<{ version_id: string }>(`
            INSERT INTO knowledge_versions
              (version_id, installation_id, claim_id, version_number, statement,
               structured_content, authority, confidence, repository_id, repo_snapshot_id, branch,
               freshness_at, valid_from, valid_until, source_candidate_id)
            VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14)
            RETURNING version_id::text
          `, [
            input.installationId, claimId, versionNumber, statement,
            JSON.stringify(row.structured_content ?? {}),
            input.editedStatement ? 'user_corrected' : 'user_accepted',
            row.confidence, row.repository_id, row.repo_snapshot_id, row.branch,
            row.freshness_at, row.valid_from, row.valid_until, row.candidate_id,
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
            INSERT INTO memory_feedback (feedback_id, installation_id, candidate_id, claim_id, version_id, action)
            VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
          `, [input.installationId, input.candidateId, claimId, versionId,
            input.editedStatement ? 'candidate_corrected' : 'candidate_accepted'])
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
    }): Promise<{ ok: true } | { ok: false; error: LedgerError }> {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        try {
          const candidate = await client.query<{ status: string; revision: string }>(`
            SELECT status, revision::text FROM memory_candidates
            WHERE installation_id = $1 AND candidate_id = $2
            FOR UPDATE
          `, [input.installationId, input.candidateId])
          const row = candidate.rows[0]
          if (!row) {
            await client.query('ROLLBACK')
            return { ok: false, error: { code: 'candidate_not_found' } }
          }
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
            INSERT INTO memory_feedback (feedback_id, installation_id, candidate_id, action, reason_code)
            VALUES (gen_random_uuid(), $1, $2, 'candidate_rejected', $3)
          `, [input.installationId, input.candidateId, input.reasonCode?.slice(0, 128) ?? null])
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
          const episodesAfterLock = await client.query<{ episode_id: string }>(`
            SELECT episode_id::text FROM work_episodes
            WHERE installation_id = $1 AND episode_id = ANY($2::uuid[])
          `, [input.installationId, episodeIds])
          if (episodesAfterLock.rows.length !== episodeIds.length) {
            await client.query('ROLLBACK')
            return { ok: false, error: { code: 'invalid_input', detail: 'evidence provenance' } }
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
          }>(`
            SELECT c.claim_id::text, c.state, c.revision::text, c.claim_type, c.scope_kind,
                   c.current_version_id::text,
                   c.scope_key, v.repository_id::text, v.repo_snapshot_id::text, v.branch
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
          const finalNormalizedKey = normalizedClaimKey({
            claimType: row.claim_type,
            scopeKey: row.scope_key,
            statement: finalStatement,
          })
          await client.query(`
            SELECT pg_advisory_xact_lock(hashtextextended('claim-identity:' || $1 || ':' || $2 || ':' || $3 || ':' || $4, 0))
          `, [input.installationId, row.claim_type, row.scope_key, finalNormalizedKey])
          const collision = await client.query(`
            SELECT 1 FROM knowledge_claims
            WHERE installation_id = $1 AND claim_type = $2 AND scope_key = $3
              AND normalized_key = $4 AND claim_id <> $5
            LIMIT 1
          `, [input.installationId, row.claim_type, row.scope_key, finalNormalizedKey, input.claimId])
          if (collision.rows[0]) {
            await client.query('ROLLBACK')
            return { ok: false, error: { code: 'identity_conflict' } }
          }
          const next = await client.query<{ max_version: number | null }>(`
            SELECT MAX(version_number) AS max_version FROM knowledge_versions
            WHERE installation_id = $1 AND claim_id = $2
          `, [input.installationId, input.claimId])
          const versionNumber = (next.rows[0].max_version ?? 0) + 1
          const effectiveAt = await client.query<{ effective_at: Date }>(`
            SELECT clock_timestamp() AS effective_at
          `)
          const correctionAt = effectiveAt.rows[0].effective_at
          await client.query(`
            UPDATE knowledge_versions
            SET valid_until = $3
            WHERE installation_id = $1 AND version_id = $2
              AND (valid_until IS NULL OR valid_until > $3)
          `, [input.installationId, row.current_version_id, correctionAt])
          const version = await client.query<{ version_id: string }>(`
            INSERT INTO knowledge_versions
              (version_id, installation_id, claim_id, version_number, statement,
               structured_content, authority, confidence, repository_id, repo_snapshot_id, branch,
               freshness_at, valid_from)
            VALUES (gen_random_uuid(), $1, $2, $3, $4, '{}'::jsonb, 'user_corrected', 0.9, $5, $6, $7, $8, $8)
            RETURNING version_id::text
          `, [input.installationId, input.claimId, versionNumber, finalStatement,
            row.repository_id, row.repo_snapshot_id, row.branch, correctionAt])
          const versionId = version.rows[0].version_id

          let inserted = 0
          for (const [index, evidence] of input.evidence.slice(0, 13).entries()) {
            if (index >= 64) break
            const episodeId = evidence.episodeId ?? null
            await insertExplicitEvidence(client, {
              installationId: input.installationId,
              versionId,
              episodeId,
              evidence,
              ordinal: index,
            })
            inserted++
          }
          if (inserted === 0) {
            await client.query('ROLLBACK')
            return { ok: false, error: { code: 'evidence_required' } }
          }

          await client.query(`
            UPDATE knowledge_claims
            SET current_version_id = $2, normalized_key = $4,
                revision = revision + 1, updated_at = NOW()
            WHERE installation_id = $1 AND claim_id = $3
          `, [input.installationId, versionId, input.claimId, finalNormalizedKey])
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
 * Derive evidence from the episode packet: one 'episode' evidence row bound
 * to the episode that produced the candidate.
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

  let insertedCount = 0
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
    const inserted = await client.query(`
      INSERT INTO knowledge_evidence
        (evidence_id, installation_id, version_id, episode_id, source_event_id, artifact_id,
         evidence_kind, locator, excerpt, excerpt_hash, occurred_at, ordinal)
      VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7::jsonb, $8,
              sha256(convert_to($8, 'utf8')), $9, $10)
      ON CONFLICT (version_id, ordinal) DO NOTHING
    `, [
      input.installationId,
      input.versionId,
      input.episodeId,
      evidence.manifest.kind === 'event' ? evidence.manifest.source_event_id ?? null : null,
      evidence.manifest.kind === 'artifact' ? evidence.manifest.artifact_id ?? null : null,
      evidence.manifest.kind,
      JSON.stringify({
        key: input.locatorKey,
        evidence_handle: evidence.handle,
        excerpt_hash: evidence.manifest.excerpt_hash ?? null,
        truncated: evidence.manifest.truncated ?? false,
        repository_id: input.repositoryId,
        repo_snapshot_id: input.repoSnapshotId,
        branch: input.branch,
      }),
      evidence.excerpt,
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
    episodeId: string | null
    evidence: EvidenceInput
    ordinal: number
  },
): Promise<void> {
  await client.query(`
    INSERT INTO knowledge_evidence
      (evidence_id, installation_id, version_id, episode_id, source_event_id, artifact_id,
       evidence_kind, locator, excerpt, excerpt_hash, occurred_at, ordinal)
    VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7::jsonb, $8,
            sha256(convert_to($8, 'utf8')), $9, $10)
    ON CONFLICT (version_id, ordinal) DO NOTHING
  `, [
    input.installationId, input.versionId, input.episodeId,
    input.evidence.evidenceKind === 'event' ? input.evidence.sourceEventId ?? null : null,
    input.evidence.evidenceKind === 'artifact' ? input.evidence.artifactId ?? null : null,
    input.evidence.evidenceKind,
    JSON.stringify(input.evidence.locator ?? {}),
    input.evidence.excerpt,
    input.evidence.occurredAt,
    input.ordinal,
  ])
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
