import { createHmac, randomUUID } from 'crypto'
import type pg from 'pg'

/**
 * Retrieval Trajectory persistence (ADR-P2-08): structured, content-free
 * audit. The request identity is an HMAC under a versioned key ring — never
 * a plain digest of user text, and the query itself is never stored.
 */
export interface TrajectoryStageInput {
  stage: string
  outcome: string
  candidateCount: number
  durationMs: number
  degradedReason?: string | null
}

export interface TrajectoryCandidateInput {
  versionId: string
  metadataRank: number | null
  lexicalRank: number | null
  vectorRank: number | null
  fusedScore: number
  authorityScore: number
  freshnessScore: number
  scopeScore: number
  loadoutScore: number
  estimatedTokens: number
  decision: 'selected' | 'dropped' | 'pruned' | 'excluded' | 'shadowed'
  reasonCode: string
  finalOrdinal: number | null
}

export interface RecordTrajectoryInput {
  installationId: string
  requestKey: { keyId: string; hmacKey: Buffer }
  query: string
  repositoryId: string | null
  branch: string | null
  rankingPolicyVersionId: string | null
  backendPlan: Record<string, unknown>
  resultState: 'completed' | 'empty' | 'degraded' | 'retrieval_failed'
  degradedComponents: readonly string[]
  stages: readonly TrajectoryStageInput[]
  candidates: readonly TrajectoryCandidateInput[]
}

export function createTrajectoryRepository(pool: pg.Pool) {
  return {
    requestHmac(input: { keyId: string; hmacKey: Buffer; query: string }): {
      hmac: Buffer
      keyId: string
    } {
      const hmac = createHmac('sha256', input.hmacKey).update(input.query).digest()
      return { hmac, keyId: input.keyId }
    },

    async record(input: RecordTrajectoryInput): Promise<string> {
      const trajectoryId = randomUUID()
      const identity = this.requestHmac({ ...input.requestKey, query: input.query })
      // One statement gives the header, stages and candidates the same
      // transaction boundary without keeping a client across round trips.
      await pool.query(`
        WITH trajectory AS (
          INSERT INTO memory_retrieval_trajectories
            (trajectory_id, installation_id, request_hmac, request_key_id,
             repository_id, branch, ranking_policy_version_id, backend_plan,
             result_state, degraded_components, started_at, ended_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10,
                  NOW() - ($11 * INTERVAL '1 millisecond'), NOW())
          RETURNING trajectory_id, installation_id
        ), stages AS (
          INSERT INTO memory_retrieval_stages
            (trajectory_id, ordinal, stage, outcome, candidate_count, duration_ms, degraded_reason)
          SELECT trajectory.trajectory_id, s.ordinal, s.stage, s.outcome, s.count, s.duration, s.reason
          FROM trajectory CROSS JOIN jsonb_to_recordset($12::jsonb)
            AS s(ordinal integer, stage text, outcome text, count integer, duration integer, reason text)
        )
        INSERT INTO memory_retrieval_candidates
          (trajectory_id, installation_id, version_id, metadata_rank, lexical_rank,
           vector_rank, fused_score, authority_score, freshness_score, scope_score,
           loadout_score, estimated_tokens, decision, reason_code, final_ordinal)
        SELECT trajectory.trajectory_id, trajectory.installation_id, candidate.*
        FROM trajectory CROSS JOIN unnest($13::uuid[], $14::integer[], $15::integer[], $16::integer[],
          $17::real[], $18::real[], $19::real[], $20::real[], $21::real[],
          $22::integer[], $23::text[], $24::text[], $25::integer[]) AS candidate
      `, [
        trajectoryId, input.installationId, identity.hmac, identity.keyId,
        input.repositoryId, input.branch, input.rankingPolicyVersionId,
        JSON.stringify(input.backendPlan), input.resultState, input.degradedComponents,
        input.stages.reduce((sum, stage) => sum + stage.durationMs, 0),
        JSON.stringify(input.stages.map((stage, ordinal) => ({
          ordinal, stage: stage.stage, outcome: stage.outcome, count: stage.candidateCount,
          duration: stage.durationMs, reason: stage.degradedReason ?? null,
        }))),
        input.candidates.map(candidate => candidate.versionId),
        input.candidates.map(candidate => candidate.metadataRank),
        input.candidates.map(candidate => candidate.lexicalRank),
        input.candidates.map(candidate => candidate.vectorRank),
        input.candidates.map(candidate => candidate.fusedScore),
        input.candidates.map(candidate => candidate.authorityScore),
        input.candidates.map(candidate => candidate.freshnessScore),
        input.candidates.map(candidate => candidate.scopeScore),
        input.candidates.map(candidate => candidate.loadoutScore),
        input.candidates.map(candidate => candidate.estimatedTokens),
        input.candidates.map(candidate => candidate.decision),
        input.candidates.map(candidate => candidate.reasonCode),
        input.candidates.map(candidate => candidate.finalOrdinal),
      ])
      return trajectoryId
    },

    async get(trajectoryId: string): Promise<{
      result_state: string
      degraded_components: string[]
      stages: Array<{ stage: string; outcome: string; candidate_count: number }>
      candidates: Array<{ version_id: string; decision: string; reason_code: string }>
    } | null> {
      const trajectory = await pool.query<{
        result_state: string
        degraded_components: string[]
      }>(`
        SELECT result_state, degraded_components FROM memory_retrieval_trajectories
        WHERE trajectory_id = $1
      `, [trajectoryId])
      if (!trajectory.rows[0]) return null
      const stages = await pool.query(`
        SELECT stage, outcome, candidate_count FROM memory_retrieval_stages
        WHERE trajectory_id = $1 ORDER BY ordinal ASC
      `, [trajectoryId])
      const candidates = await pool.query(`
        SELECT version_id::text, decision, reason_code FROM memory_retrieval_candidates
        WHERE trajectory_id = $1
      `, [trajectoryId])
      return {
        result_state: trajectory.rows[0].result_state,
        degraded_components: trajectory.rows[0].degraded_components,
        stages: stages.rows,
        candidates: candidates.rows,
      }
    },
  }
}

export type TrajectoryRepository = ReturnType<typeof createTrajectoryRepository>
