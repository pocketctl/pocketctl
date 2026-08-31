import { randomUUID } from 'crypto'
import type pg from 'pg'

/**
 * Shared Generation Run provenance (plan 8.1/9.2). A run is reserved before
 * any external work; the output reference and terminal state commit together
 * with the run in one transaction. The active-state uniqueness
 * (`uq_generation_runs_active`) dedupes identical subject/input/policy
 * combinations; failed rows are free to retry.
 */
export function createGenerationRunRepository(pool: pg.Pool) {
  return {
    async reserve(input: {
      installationId: string
      operation: 'extract_candidates' | 'compile_context' | 'compress_context_shadow'
      subjectKind: string
      subjectKeyHash: Buffer
      inputDigest: Buffer
      effectivePolicyHash: Buffer
      state?: 'queued' | 'running'
    }): Promise<{
		runId: string
		owner: boolean
		state: string
		outputKind: string | null
		outputId: string | null
	}> {
      const runId = randomUUID()
      const inserted = await pool.query<{ run_id: string }>(`
        INSERT INTO memory_generation_runs
          (run_id, installation_id, operation, subject_kind, subject_key_hash,
           input_digest, effective_policy_hash, state)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT DO NOTHING
        RETURNING run_id::text
      `, [runId, input.installationId, input.operation, input.subjectKind,
        input.subjectKeyHash, input.inputDigest, input.effectivePolicyHash,
        input.state ?? 'running'])
      if (inserted.rows[0]) return {
		runId: inserted.rows[0].run_id, owner: true,
		state: input.state ?? 'running', outputKind: null, outputId: null,
	  }
      const existing = await pool.query<{
		run_id: string; state: string; output_kind: string | null; output_id: string | null
	  }>(`
        SELECT run_id::text, state, output_kind, output_id::text FROM memory_generation_runs
        WHERE installation_id = $1 AND operation = $2 AND subject_kind = $3
          AND subject_key_hash = $4 AND input_digest = $5 AND effective_policy_hash = $6
          AND state IN ('queued','running','succeeded','quarantined')
      `, [input.installationId, input.operation, input.subjectKind,
        input.subjectKeyHash, input.inputDigest, input.effectivePolicyHash])
	  const row = existing.rows[0]
      return {
		runId: row?.run_id ?? runId, owner: false,
		state: row?.state ?? 'running', outputKind: row?.output_kind ?? null,
		outputId: row?.output_id ?? null,
	  }
    },

    async complete(input: {
      runId: string
      state: 'succeeded' | 'failed' | 'cancelled' | 'superseded' | 'quarantined'
      outputKind?: string | null
      outputId?: string | null
      durationMs?: number
      errorCode?: string | null
    }): Promise<void> {
      await pool.query(`
        UPDATE memory_generation_runs
        SET state = $2, output_kind = COALESCE($3, output_kind),
            output_id = COALESCE($4, output_id),
            duration_ms = COALESCE($5, duration_ms),
            error_code = $6, completed_at = NOW()
        WHERE run_id = $1
      `, [input.runId, input.state, input.outputKind ?? null,
        input.outputId ?? null, input.durationMs ?? null, input.errorCode ?? null])
    },

    async attachPolicies(input: {
      runId: string
      policyVersionIds: readonly string[]
    }): Promise<void> {
      for (const [index, policyVersionId] of input.policyVersionIds.entries()) {
        await pool.query(`
          INSERT INTO memory_generation_run_policies (run_id, ordinal, policy_version_id)
          VALUES ($1, $2, $3)
          ON CONFLICT DO NOTHING
        `, [input.runId, index, policyVersionId])
      }
    },
  }
}

export type GenerationRunRepository = ReturnType<typeof createGenerationRunRepository>
