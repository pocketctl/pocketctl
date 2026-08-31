import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import type { EmbeddingProvider } from '../ports/embedding-provider.js'
import type { ModelJsonResult, TextGenerator } from '../ports/text-generator.js'

export type ProviderBudgetDimension =
  | 'text_requests'
  | 'text_input_tokens'
  | 'text_output_tokens'
  | 'embedding_requests'
  | 'embedding_tokens'

export type ProviderBudgetReservation =
  | { ok: true; reservationId: string }
  | { ok: false; dimension: ProviderBudgetDimension }

export interface ProviderBudgetStore {
  reserve(input: {
    key: string
    kind: 'text' | 'embedding'
    inputTokens: number
    outputTokens: number
    maxRequests: number
    maxInputTokens: number
    maxOutputTokens: number
  }): Promise<ProviderBudgetReservation>
  settle(reservationId: string, usage: { inputTokens: number; outputTokens: number }): Promise<void>
}

/**
 * A reservation is committed before the network call. If the process dies or
 * the provider returns no trustworthy usage, it deliberately remains
 * reserved: releasing it could permit a restart to spend the same budget
 * twice even though the provider may already have billed the request.
 */
export function createProviderBudgetStore(pool: pg.Pool): ProviderBudgetStore {
  return {
    async reserve(input) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [input.key])
        const totals = await client.query<{
          requests: string
          input_tokens: string
          output_tokens: string
        }>(`
          SELECT COUNT(*)::text AS requests,
                 COALESCE(SUM(CASE WHEN state = 'settled' THEN actual_input_tokens ELSE reserved_input_tokens END), 0)::text AS input_tokens,
                 COALESCE(SUM(CASE WHEN state = 'settled' THEN actual_output_tokens ELSE reserved_output_tokens END), 0)::text AS output_tokens
          FROM memory_provider_budget_reservations
          WHERE budget_key = $1 AND provider_kind = $2
        `, [input.key, input.kind])
        const row = totals.rows[0] ?? { requests: '0', input_tokens: '0', output_tokens: '0' }
        const dimensions: Array<[boolean, ProviderBudgetDimension]> = input.kind === 'text'
          ? [
              [Number(row.requests) + 1 > input.maxRequests, 'text_requests'],
              [Number(row.input_tokens) + input.inputTokens > input.maxInputTokens, 'text_input_tokens'],
              [Number(row.output_tokens) + input.outputTokens > input.maxOutputTokens, 'text_output_tokens'],
            ]
          : [
              [Number(row.requests) + 1 > input.maxRequests, 'embedding_requests'],
              [Number(row.input_tokens) + input.inputTokens > input.maxInputTokens, 'embedding_tokens'],
            ]
        const exceeded = dimensions.find(([condition]) => condition)?.[1]
        if (exceeded) {
          await client.query('COMMIT')
          return { ok: false, dimension: exceeded }
        }
        const reservationId = randomUUID()
        await client.query(`
          INSERT INTO memory_provider_budget_reservations
            (reservation_id, budget_key, provider_kind, reserved_input_tokens, reserved_output_tokens)
          VALUES ($1, $2, $3, $4, $5)
        `, [reservationId, input.key, input.kind, input.inputTokens, input.outputTokens])
        await client.query('COMMIT')
        return { ok: true, reservationId }
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    },

    async settle(reservationId, usage) {
      await pool.query(`
        UPDATE memory_provider_budget_reservations
        SET state = 'settled', actual_input_tokens = $2, actual_output_tokens = $3,
            settled_at = NOW()
        WHERE reservation_id = $1 AND state = 'reserved'
      `, [reservationId, usage.inputTokens, usage.outputTokens])
    },
  }
}

export function withTextProviderBudget(
  provider: TextGenerator,
  store: ProviderBudgetStore,
  limits: {
    key: string
    maxRequests: number
    maxInputTokens: number
    maxOutputTokens: number
    maxOutputTokensPerRequest: number
  },
): TextGenerator {
  return {
    async generateJson<T>(input: Parameters<TextGenerator['generateJson']>[0]): Promise<ModelJsonResult<T>> {
      // UTF-8 bytes are a conservative upper bound for tokenizer input units.
      const inputTokens = Buffer.byteLength(input.system, 'utf8')
        + Buffer.byteLength(JSON.stringify(input.document), 'utf8')
        + 1_024 // fixed conservative allowance for message framing/tokenizer overhead
      let reservation: ProviderBudgetReservation
      try {
        reservation = await store.reserve({
          key: limits.key,
          kind: 'text',
          inputTokens,
          outputTokens: limits.maxOutputTokensPerRequest,
          maxRequests: limits.maxRequests,
          maxInputTokens: limits.maxInputTokens,
          maxOutputTokens: limits.maxOutputTokens,
        })
      } catch {
        return { ok: false, code: 'budget_unavailable', retryable: true, detail: 'reservation_failed' }
      }
      if (!reservation.ok) {
        return { ok: false, code: 'budget_exceeded', retryable: false, detail: reservation.dimension }
      }
      const result = await provider.generateJson<T>(input)
      const usage = result.ok ? result.usage : result.usage
      if (usage) {
        await store.settle(reservation.reservationId, {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        })
      }
      return result
    },
  }
}

export function withEmbeddingProviderBudget(
  provider: EmbeddingProvider,
  store: ProviderBudgetStore,
  limits: { key: string; maxRequests: number; maxTokens: number },
): EmbeddingProvider {
  return {
    dimensions: provider.dimensions,
    async embed(input) {
      const inputTokens = input.texts.reduce((sum, text) => sum + Buffer.byteLength(text, 'utf8'), 0)
      const reservation = await store.reserve({
        key: limits.key,
        kind: 'embedding',
        inputTokens,
        outputTokens: 0,
        maxRequests: limits.maxRequests,
        maxInputTokens: limits.maxTokens,
        maxOutputTokens: 0,
      })
      if (!reservation.ok) throw new ProviderBudgetExceededError(reservation.dimension)
      const result = await provider.embed(input)
      await store.settle(reservation.reservationId, { inputTokens: result.tokens, outputTokens: 0 })
      return result
    },
  }
}

export class ProviderBudgetExceededError extends Error {
  readonly code = 'budget_exceeded'
  constructor(readonly dimension: ProviderBudgetDimension) {
    super(`provider budget exceeded: ${dimension}`)
    this.name = 'ProviderBudgetExceededError'
  }
}
