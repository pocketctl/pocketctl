import type pg from 'pg'
import type { JobFence } from '../jobs/types.js'
import { assertJobFence } from '../generation/fence.js'
import { createHash } from 'crypto'

/** Pre-policy default hash, identical to the v13/v14 migration constant. */
const DEFAULT_POLICY_HASH = createHash('md5').update('phase1:no-policy').digest()

/**
 * Persistence for candidate extraction runs. The run uniqueness key is
 * reserved BEFORE the model call so a redelivered or concurrent job can never
 * double-bill the provider; failed runs are retired so bounded job retries
 * may start a fresh attempt.
 */

export type ExtractionRunState = 'running' | 'succeeded' | 'failed' | 'quarantined'

export interface ReservedRun {
  runId: string
  /** True when this caller created the run and owns the model call. */
  owner: boolean
  existingState: ExtractionRunState | null
  limitReached?: boolean
}

export interface EpisodeForExtraction {
  episodeId: string
  turnId: string
  sourceDigest: Buffer
  document: Record<string, unknown>
  manifest: Record<string, unknown>
  extractionMode: 'off' | 'shadow' | 'enabled'
  repositoryId: string | null
  repoSnapshotId: string | null
  branch: string | null
  sessionFirstRecordedAt: Date
  hasPriorRunOnOldDigest: boolean
  terminalAt: Date | null
  outcome: string | null
}

export interface CandidateRow {
  ordinal: number
  claimType: string
  statement: string
  structuredContent: Record<string, unknown>
  normalizedKey: string
  scopeKind: string
  scopeKey: string
  repositoryId: string | null
  repoSnapshotId: string | null
  branch: string | null
  evidenceHandles: readonly string[]
  confidence: string
  freshnessAt: Date
  validFrom: Date | null
  validUntil: Date | null
  status: 'shadow' | 'validated' | 'duplicate' | 'conflict' | 'rejected_by_validator'
  validation: Record<string, unknown>
  duplicateOfClaimId: string | null
}

export function createExtractionRepository(pool: pg.Pool) {
  return {
    async loadEpisodeForExtraction(
      installationId: string,
      turnId: string,
    ): Promise<EpisodeForExtraction | null> {
      const result = await pool.query<{
        episode_id: string
        turn_id: string
        source_digest: Buffer
        document: Record<string, unknown>
        evidence_manifest: Record<string, unknown>
        extraction_mode: string | null
        repository_id: string | null
        repo_snapshot_id: string | null
        branch: string | null
        first_recorded_at: Date
        has_prior_run_on_old_digest: boolean
        terminal_at: Date | null
        outcome: string | null
      }>(`
        SELECT e.episode_id::text, e.turn_id, e.source_digest, e.document,
               e.evidence_manifest, COALESCE(f.extraction_mode, 'off') AS extraction_mode,
               e.repository_id::text, e.repo_snapshot_id::text, e.branch,
               s.first_recorded_at, e.terminal_at, e.outcome,
               EXISTS (
                 SELECT 1 FROM memory_extraction_runs previous
                 WHERE previous.installation_id = e.installation_id
                   AND previous.episode_id = e.episode_id
                   AND previous.episode_source_digest <> e.source_digest
                   AND previous.state = 'succeeded'
               ) AS has_prior_run_on_old_digest
        FROM work_episodes e
        JOIN source_sessions s
          ON s.installation_id = e.installation_id AND s.session_id = e.session_id
        LEFT JOIN memory_feature_settings f ON f.installation_id = e.installation_id
        WHERE e.installation_id = $1 AND e.turn_id = $2 AND e.compiled_at IS NOT NULL
      `, [installationId, turnId])
      const row = result.rows[0]
      if (!row) return null
      return {
        episodeId: row.episode_id,
        turnId: row.turn_id,
        sourceDigest: row.source_digest,
        document: row.document ?? {},
        manifest: row.evidence_manifest ?? {},
        extractionMode: (row.extraction_mode === 'shadow' || row.extraction_mode === 'enabled')
          ? row.extraction_mode
          : 'off',
        repositoryId: row.repository_id,
        repoSnapshotId: row.repo_snapshot_id,
        branch: row.branch,
        sessionFirstRecordedAt: row.first_recorded_at,
        hasPriorRunOnOldDigest: row.has_prior_run_on_old_digest,
        terminalAt: row.terminal_at,
        outcome: row.outcome,
      }
    },

    /**
     * Reserve the run uniqueness key. A leftover 'failed' run from a previous
     * bounded retry is retired first; an existing running/succeeded/
     * quarantined run is returned so the caller can skip the model call.
     */
    async reserveRun(input: {
      installationId: string
      episodeId: string
      sourceDigest: Buffer
      extractorVersion: string
      promptVersion: string
      modelConfigHash: Buffer
      mode: 'shadow' | 'enabled'
      provider: string
      model: string
      staleAfterMs: number
      /** Effective extraction policy hash (v14 uniqueness key member). */
      effectivePolicyHash?: Buffer
      maxRunsPerEpisode?: number
    }): Promise<ReservedRun> {
      const effectivePolicyHashValue = input.effectivePolicyHash ?? DEFAULT_POLICY_HASH
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        try {
          await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
            `extraction-run:${input.installationId}:${input.episodeId}`,
          ])
          await client.query(`
            DELETE FROM memory_extraction_runs
            WHERE installation_id = $1 AND episode_id = $2
              AND episode_source_digest = $3
              AND extractor_version = $4 AND model_config_hash = $5
              AND effective_policy_hash = $6
              AND (state = 'failed'
                OR (state = 'running'
                  AND started_at < NOW() - ($7 * INTERVAL '1 millisecond')))
          `, [input.installationId, input.episodeId, input.sourceDigest,
            input.extractorVersion, input.modelConfigHash, effectivePolicyHashValue,
            Math.max(60_000, input.staleAfterMs)])
          const existing = await client.query<{ run_id: string; state: ExtractionRunState }>(`
            SELECT run_id::text, state FROM memory_extraction_runs
            WHERE installation_id = $1 AND episode_id = $2
              AND episode_source_digest = $3
              AND extractor_version = $4 AND model_config_hash = $5
              AND effective_policy_hash = $6
          `, [input.installationId, input.episodeId, input.sourceDigest,
            input.extractorVersion, input.modelConfigHash, effectivePolicyHashValue])
          if (existing.rows[0]) {
            await client.query('COMMIT')
            return { runId: existing.rows[0].run_id, owner: false,
              existingState: existing.rows[0].state }
          }
          if (input.maxRunsPerEpisode !== undefined) {
            // Bound provider calls for this packet revision. A compiler or
            // source revision gets a fresh allowance without erasing history.
            const count = await client.query<{ count: string }>(`
              SELECT COUNT(*)::text AS count FROM memory_extraction_runs
              WHERE installation_id = $1 AND episode_id = $2
                AND episode_source_digest = $3
            `, [input.installationId, input.episodeId, input.sourceDigest])
            if (Number(count.rows[0]?.count ?? 0) >= input.maxRunsPerEpisode) {
              await client.query('COMMIT')
              return { runId: '', owner: false, existingState: null, limitReached: true }
            }
          }
          const inserted = await client.query<{ run_id: string }>(`
            INSERT INTO memory_extraction_runs
              (run_id, installation_id, episode_id, episode_source_digest, extractor_version,
               prompt_version, model_config_hash, input_digest, mode, state, provider, model,
               effective_policy_hash)
            VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, 'running', $9, $10, $11)
            ON CONFLICT DO NOTHING
            RETURNING run_id::text
          `, [
            input.installationId, input.episodeId, input.sourceDigest,
            input.extractorVersion, input.promptVersion, input.modelConfigHash,
            input.sourceDigest, input.mode, input.provider, input.model,
            effectivePolicyHashValue,
          ])
          if (inserted.rows[0]) {
            await client.query('COMMIT')
            return { runId: inserted.rows[0].run_id, owner: true, existingState: null }
          }
          const conflicted = await client.query<{ run_id: string; state: ExtractionRunState }>(`
            SELECT run_id::text, state FROM memory_extraction_runs
            WHERE installation_id = $1 AND episode_id = $2
              AND episode_source_digest = $3
              AND extractor_version = $4 AND model_config_hash = $5
              AND effective_policy_hash = $6
          `, [input.installationId, input.episodeId, input.sourceDigest, input.extractorVersion, input.modelConfigHash, effectivePolicyHashValue])
          await client.query('COMMIT')
          const row = conflicted.rows[0]
          return {
            runId: row?.run_id ?? '',
            owner: false,
            existingState: row?.state ?? null,
          }
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        }
      } finally {
        client.release()
      }
    },

    async markRun(input: {
      runId: string
      state: ExtractionRunState
      errorCode?: string
      inputTokens?: number
      outputTokens?: number
      costMicros?: number
      candidateCount?: number
      /** When present, the write must pass the owning job's fence first. */
      fence?: JobFence
    }): Promise<void> {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        if (input.fence) await assertJobFence(client, input.fence)
        const updated = await client.query<{
          installation_id: string
          model: string
          input_tokens: string
          output_tokens: string
          cost_micros: string
        }>(`
          UPDATE memory_extraction_runs SET
            state = $2,
            error_code = $3,
            input_tokens = COALESCE($4, input_tokens),
            output_tokens = COALESCE($5, output_tokens),
            cost_micros = COALESCE($6, cost_micros),
            candidate_count = COALESCE($7, candidate_count),
            completed_at = NOW()
          WHERE run_id = $1
          RETURNING installation_id::text, model, input_tokens::text,
                    output_tokens::text, cost_micros::text
        `, [
          input.runId, input.state, input.errorCode ?? null,
          input.inputTokens ?? null, input.outputTokens ?? null,
          input.costMicros ?? null, input.candidateCount ?? null,
        ])
        const row = updated.rows[0]
        if (row) {
          await client.query(`
            INSERT INTO memory_usage_outbox
              (installation_id, usage_id, operation, model, input_tokens, output_tokens,
               embedding_tokens, cached_tokens, cost_micros, occurred_at)
            VALUES ($1, $2, 'candidate_extract', $3, $4, $5, 0, 0, $6, NOW())
            ON CONFLICT (installation_id, usage_id) DO NOTHING
          `, [
            row.installation_id, `extraction:${input.runId}`, row.model,
            row.input_tokens, row.output_tokens, row.cost_micros,
          ])
        }
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    },

    /** Remove an owned placeholder only when no Provider request was sent. */
    async discardRun(input: { runId: string; fence?: JobFence }): Promise<void> {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        if (input.fence) await assertJobFence(client, input.fence)
        await client.query(`
          DELETE FROM memory_extraction_runs WHERE run_id = $1 AND state = 'running'
        `, [input.runId])
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    },

    /** Persist run outcome and candidates in one transaction. */
    async persistCandidates(input: {
      runId: string
      installationId: string
      episodeId: string
      candidateStatus: 'shadow' | 'validated'
      candidates: readonly CandidateRow[]
      usage: { inputTokens: number; outputTokens: number; costMicros: number }
      /** When present, the write must pass the owning job's fence first. */
      fence?: JobFence
    }): Promise<void> {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        try {
          // Same advisory-before-rows ordering as compile, acceptance and
          // purge. No provider result may publish against a replaced packet.
          const source = await client.query<{ session_id: string }>(`
            SELECT session_id FROM work_episodes WHERE installation_id = $1 AND episode_id = $2
          `, [input.installationId, input.episodeId])
          if (source.rows[0]) {
            await client.query(`
              SELECT pg_advisory_xact_lock(hashtextextended('purge:session:' || $1 || ':' || $2, 0)),
                     pg_advisory_xact_lock(hashtextextended('purge:installation:' || $1, 0))
            `, [input.installationId, source.rows[0].session_id])
          }
          if (input.fence) await assertJobFence(client, input.fence)
          const revision = await client.query<{ current: boolean }>(`
            SELECT e.source_digest = r.episode_source_digest AS current
            FROM work_episodes e
            JOIN memory_extraction_runs r ON r.installation_id = e.installation_id AND r.episode_id = e.episode_id
            WHERE e.installation_id = $1 AND e.episode_id = $2 AND r.run_id = $3
            FOR SHARE OF e
          `, [input.installationId, input.episodeId, input.runId])
          // A source purge has already removed the run; do not resurrect it.
          if (!revision.rows[0]) {
            await client.query('COMMIT')
            return
          }
          for (const candidate of input.candidates) {
            let status = candidate.status
            let validation = candidate.validation
            if (!revision.rows[0].current) {
              status = 'rejected_by_validator'
              validation = { ...validation, codes: ['obsolete_source_digest'] }
            } else if (status === 'validated' || status === 'conflict') {
              const pending = await client.query<{ candidate_id: string }>(`
                SELECT c.candidate_id::text FROM memory_candidates c
                JOIN memory_extraction_runs r ON r.run_id = c.run_id AND r.installation_id = c.installation_id
                JOIN work_episodes e ON e.episode_id = c.episode_id AND e.installation_id = c.installation_id
                WHERE c.installation_id = $1 AND c.normalized_key = $2 AND c.scope_kind = $3
                  AND c.structured_content = $4::jsonb
                  AND c.repository_id IS NOT DISTINCT FROM $5::uuid
                  AND c.repo_snapshot_id IS NOT DISTINCT FROM $6::uuid
                  AND c.branch IS NOT DISTINCT FROM $7::text
                  AND c.valid_from IS NOT DISTINCT FROM $8::timestamptz
                  AND c.valid_until IS NOT DISTINCT FROM $9::timestamptz
                  AND c.status IN ('validated', 'conflict')
                  AND r.episode_source_digest = e.source_digest
                  AND NOT (c.run_id = $10 AND c.ordinal = $11)
                ORDER BY c.created_at, c.candidate_id LIMIT 1
              `, [input.installationId, candidate.normalizedKey, candidate.scopeKind,
                JSON.stringify(candidate.structuredContent), candidate.repositoryId, candidate.repoSnapshotId,
                candidate.branch, candidate.validFrom, candidate.validUntil, input.runId, candidate.ordinal])
              if (pending.rows[0]) {
                status = 'duplicate'
                validation = { ...validation, codes: ['duplicate_pending_candidate'], duplicate_of_candidate_id: pending.rows[0].candidate_id }
              }
            }
            await client.query(`
              INSERT INTO memory_candidates
                (candidate_id, installation_id, run_id, episode_id, ordinal, claim_type,
                 statement, structured_content, normalized_key, scope_kind, scope_key,
                 repository_id, repo_snapshot_id, branch, evidence_handles,
                 confidence, freshness_at, valid_from, valid_until,
                 status, validation, duplicate_of_claim_id)
              VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10,
                      $11, $12, $13, $14::jsonb, $15, $16, $17, $18, $19, $20::jsonb, $21)
              ON CONFLICT (run_id, ordinal) DO NOTHING
            `, [
              input.installationId, input.runId, input.episodeId, candidate.ordinal,
              candidate.claimType, candidate.statement,
              JSON.stringify(candidate.structuredContent ?? {}),
              candidate.normalizedKey, candidate.scopeKind, candidate.scopeKey,
              candidate.repositoryId, candidate.repoSnapshotId, candidate.branch,
              JSON.stringify(candidate.evidenceHandles), candidate.confidence,
              candidate.freshnessAt, candidate.validFrom, candidate.validUntil,
              status, JSON.stringify(validation ?? {}),
              candidate.duplicateOfClaimId,
            ])
          }
          await client.query(`
            UPDATE memory_extraction_runs SET
              state = 'succeeded', completed_at = NOW(),
              input_tokens = $2, output_tokens = $3, cost_micros = $4,
              candidate_count = $5
            WHERE run_id = $1
          `, [
            input.runId, input.usage.inputTokens, input.usage.outputTokens,
            input.usage.costMicros, input.candidates.length,
          ])
          // Usage facts are content-free: model name and token totals only.
          await client.query(`
            INSERT INTO memory_usage_outbox
              (installation_id, usage_id, operation, model, input_tokens, output_tokens,
               embedding_tokens, cached_tokens, cost_micros, occurred_at)
            SELECT $1, $2, 'candidate_extract', r.model, $3, $4, 0, 0, $5, NOW()
            FROM memory_extraction_runs r WHERE r.run_id = $6
            ON CONFLICT (installation_id, usage_id) DO NOTHING
          `, [
            input.installationId, `extraction:${input.runId}`,
            input.usage.inputTokens, input.usage.outputTokens,
            input.usage.costMicros, input.runId,
          ])
          await client.query('COMMIT')
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

export type ExtractionRepository = ReturnType<typeof createExtractionRepository>
