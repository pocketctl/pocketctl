import type pg from 'pg'

export interface UsageFact {
  installationId: string
  usageId: string
  operation: string
  model?: string
  inputTokens?: number
  outputTokens?: number
  embeddingTokens?: number
  cachedTokens?: number
  costMicros?: number
  occurredAt: Date
  attempts?: number
}

/**
 * Usage outbox: real records only. Phase 0 has no model calls, so the
 * production outbox stays empty by construction; the API exists so Phase 1
 * can append genuine facts and the reporter can drain them in order.
 */
export function createUsageOutbox(pool: pg.Pool) {
  return {
    async append(fact: UsageFact): Promise<void> {
      await pool.query(`
        INSERT INTO memory_usage_outbox
          (installation_id, usage_id, operation, model, input_tokens, output_tokens,
           embedding_tokens, cached_tokens, cost_micros, occurred_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (installation_id, usage_id) DO NOTHING
      `, [
        fact.installationId, fact.usageId, fact.operation, fact.model ?? null,
        fact.inputTokens ?? 0, fact.outputTokens ?? 0, fact.embeddingTokens ?? 0,
        fact.cachedTokens ?? 0, fact.costMicros ?? 0, fact.occurredAt,
      ])
    },

    /** Bounded batch of unreported facts (at most 100). */
    async nextBatch(): Promise<UsageFact[]> {
      const result = await pool.query<{
        installation_id: string
        usage_id: string
        operation: string
        model: string | null
        input_tokens: string
        output_tokens: string
        embedding_tokens: string
        cached_tokens: string
        cost_micros: string
        occurred_at: Date
        attempts: number
      }>(`
        SELECT installation_id, usage_id, operation, model, input_tokens::text,
               output_tokens::text, embedding_tokens::text, cached_tokens::text,
               cost_micros::text, occurred_at, attempts
        FROM memory_usage_outbox
        WHERE reported_at IS NULL AND dead_lettered_at IS NULL
        ORDER BY occurred_at ASC
        LIMIT 100
      `)
      return result.rows.map(row => ({
        installationId: row.installation_id,
        usageId: row.usage_id,
        operation: row.operation,
        model: row.model ?? undefined,
        inputTokens: Number(row.input_tokens),
        outputTokens: Number(row.output_tokens),
        embeddingTokens: Number(row.embedding_tokens),
        cachedTokens: Number(row.cached_tokens),
        costMicros: Number(row.cost_micros),
        occurredAt: row.occurred_at,
        attempts: row.attempts,
      }))
    },

    async markReported(installationId: string, usageId: string): Promise<void> {
      await pool.query(`
        UPDATE memory_usage_outbox
        SET reported_at = NOW(), attempts = attempts + 1
        WHERE installation_id = $1 AND usage_id = $2
      `, [installationId, usageId])
    },

    async markAttempt(installationId: string, usageId: string, errorCode: string): Promise<number> {
      const updated = await pool.query<{ attempts: number }>(`
        UPDATE memory_usage_outbox
        SET attempts = attempts + 1, last_error_code = $3
        WHERE installation_id = $1 AND usage_id = $2
        RETURNING attempts
      `, [installationId, usageId, errorCode.slice(0, 128) || 'usage_delivery_failed'])
      return updated.rows[0]?.attempts ?? 0
    },

    async markDeadLetter(installationId: string, usageId: string): Promise<void> {
      await pool.query(`
        UPDATE memory_usage_outbox SET dead_lettered_at = NOW()
        WHERE installation_id = $1 AND usage_id = $2 AND reported_at IS NULL
      `, [installationId, usageId])
    },
  }
}

export type UsageOutbox = ReturnType<typeof createUsageOutbox>
