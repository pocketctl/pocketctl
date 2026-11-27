import type pg from 'pg'
import type {MemoryUsageOperation} from './memory-usage-contract.js'

export interface UsageFact {
  installationId: string
  usageId: string
  operation: MemoryUsageOperation
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

    /** One statement rotates due installations, leases a bounded page, and
     * reserves turns for both new facts and retries within that installation. */
    async nextBatch(claim: string): Promise<UsageFact[]> {
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
        WITH tenants AS MATERIALIZED (
          SELECT installation_id FROM memory_usage_delivery_schedule s WHERE EXISTS(
            SELECT 1 FROM memory_usage_outbox q WHERE q.installation_id=s.installation_id AND q.reported_at IS NULL
             AND (q.dead_lettered_at IS NULL OR q.delivery_state='probe') AND q.delivery_state IN('pending','cooldown','probe') AND q.available_at<=statement_timestamp())
          ORDER BY s.last_selected_at NULLS FIRST,s.installation_id LIMIT 8 FOR UPDATE OF s SKIP LOCKED
        ), rotated AS (
          UPDATE memory_usage_delivery_schedule s SET last_selected_at=clock_timestamp()
           FROM tenants t WHERE t.installation_id=s.installation_id RETURNING s.installation_id
        ), selected AS MATERIALIZED (
          SELECT t.installation_id,work.usage_id FROM rotated t CROSS JOIN LATERAL (
            SELECT q.usage_id FROM (
              SELECT lane.*,row_number() OVER(PARTITION BY lane.retry ORDER BY lane.available_at,lane.occurred_at,lane.usage_id) AS turn
              FROM (VALUES(false),(true)) lanes(retry) CROSS JOIN LATERAL (
                SELECT u.usage_id,u.available_at,u.occurred_at,retry FROM memory_usage_outbox u
                WHERE u.installation_id=t.installation_id AND u.reported_at IS NULL
                  AND (u.dead_lettered_at IS NULL OR u.delivery_state='probe') AND u.delivery_state IN('pending','cooldown','probe') AND u.available_at<=statement_timestamp()
                  AND (u.attempts>0)=retry
                ORDER BY u.available_at,u.occurred_at,u.usage_id LIMIT 100
              ) lane
            ) q ORDER BY q.turn,q.retry,q.usage_id LIMIT (100/NULLIF((SELECT count(*) FROM tenants),0))
          ) work
        ), locked AS (
          SELECT u.installation_id,u.usage_id FROM memory_usage_outbox u JOIN selected s USING(installation_id,usage_id)
          WHERE u.reported_at IS NULL AND u.available_at<=statement_timestamp() AND u.delivery_state IN('pending','cooldown','probe')
          ORDER BY u.installation_id,u.usage_id FOR UPDATE OF u SKIP LOCKED
        ) UPDATE memory_usage_outbox u SET delivery_claim=$1,available_at=clock_timestamp()+interval '2 minutes'
          FROM locked l WHERE u.installation_id=l.installation_id AND u.usage_id=l.usage_id
          RETURNING u.installation_id,u.usage_id,u.operation,u.model,u.input_tokens::text,u.output_tokens::text,
            u.embedding_tokens::text,u.cached_tokens::text,u.cost_micros::text,u.occurred_at,u.attempts
      `,[claim])
      return result.rows.map(row => ({
        installationId: row.installation_id,
        usageId: row.usage_id,
        operation: row.operation as MemoryUsageOperation,
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

    async markReported(installationId: string, usageId: string, claim: string): Promise<boolean> {
      const result=await pool.query(`
        UPDATE memory_usage_outbox SET reported_at = NOW(), attempts=attempts+1, delivery_claim=NULL,
          dead_lettered_at=NULL, last_error_code=NULL, delivery_state='pending'
        WHERE installation_id=$1 AND usage_id=$2 AND reported_at IS NULL AND delivery_claim=$3
      `,[installationId,usageId,claim])
      return result.rowCount===1
    },

    async markAttempt(installationId:string,usageId:string,claim:string,errorCode:string,rejected:boolean,retryAfterMs=0):Promise<void>{
      const delay=Number.isFinite(retryAfterMs)?Math.min(3_600_000,Math.max(0,retryAfterMs)):0
      await pool.query(`UPDATE memory_usage_outbox SET attempts=attempts+1,last_error_code=$4,delivery_claim=NULL,
        delivery_state=CASE WHEN $5 THEN 'rejected' WHEN attempts>=9 THEN 'probe' ELSE 'cooldown' END,
        dead_lettered_at=CASE WHEN $5 THEN COALESCE(dead_lettered_at,clock_timestamp()) ELSE dead_lettered_at END,
        available_at=clock_timestamp()+GREATEST($6::int,CASE WHEN attempts>=9 THEN 3600000
          ELSE LEAST(900000,30000*(1<<LEAST(attempts,5))) END)*interval '1 millisecond'
        WHERE installation_id=$1 AND usage_id=$2 AND delivery_claim=$3 AND reported_at IS NULL`,
        [installationId,usageId,claim,errorCode.slice(0,128)||'usage_delivery_failed',rejected,delay])
    },
  }
}

export type UsageOutbox = ReturnType<typeof createUsageOutbox>
