import {admitProviderReceipt,trackProviderReceipt,assertProviderReceiptBudgetInput} from './provider-receipt.js'
import { createHash, randomUUID } from 'node:crypto'
import type pg from 'pg'
import type { EmbeddingProvider } from '../ports/embedding-provider.js'
import type { ModelJsonResult, TextGenerator } from '../ports/text-generator.js'
import {sourcePoolContext} from '../sources/pool-context.js'
import {assertSourceProviderExecution,startSourceProviderAttempt,finishSourceProviderAttempt,sourceProviderRequestKey,blockUnrecordedSourceEffect} from '../sources/source-execution.js'

export type ProviderBudgetDimension =
  | 'text_requests'
  | 'text_input_tokens'
  | 'text_output_tokens'
  | 'embedding_requests'
  | 'embedding_tokens'

export type ProviderBudgetReservation =
  | { ok: true; reservationId: string }
  | { ok: false; dimension: ProviderBudgetDimension; retryAt?: Date | null; reason?: 'provider_result_unknown';reservationId?:string }

export interface ProviderBudgetStore {
  /** Shared background text execution must carry its captured generation. */
  sourceExecutionRequired?:boolean
  reserve(input: {
    key: string
    /** Stable local call identity, not a promise of provider idempotency. */
    requestKey?: string
    kind: 'text' | 'embedding'
    inputTokens: number
    outputTokens: number
    maxRequests: number
    window?: 'lifetime' | 'daily-asia-shanghai'
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
    sourceExecutionRequired:sourcePoolContext(pool).namespace==='memory',
    async reserve(input) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [input.key])
        const digest = input.requestKey ? createHash('sha256').update(JSON.stringify([input.key,input.kind,input.requestKey])).digest('hex').slice(0,32) : null
        const reservationId = digest ? `${digest.slice(0,8)}-${digest.slice(8,12)}-${digest.slice(12,16)}-${digest.slice(16,20)}-${digest.slice(20)}` : randomUUID()
        if (digest && (await client.query('SELECT 1 FROM memory_provider_budget_reservations WHERE reservation_id=$1',[reservationId])).rowCount) {
          await client.query('COMMIT')
          return {ok:false,dimension:input.kind==='text'?'text_requests':'embedding_requests',reason:'provider_result_unknown',reservationId}
        }
        const reservationTime = (await client.query<{ reserved_at: Date }>(
          'SELECT clock_timestamp() AS reserved_at',
        )).rows[0].reserved_at
        const dayOffsetMs = 8 * 60 * 60 * 1000
        const dayStart = input.window === 'daily-asia-shanghai'
          ? new Date(Math.floor((reservationTime.getTime() + dayOffsetMs) / 86_400_000) * 86_400_000 - dayOffsetMs)
          : null
        const dayEnd = dayStart ? new Date(dayStart.getTime() + 86_400_000) : null
        const windowClause = dayStart ? 'AND created_at >= $3 AND created_at < $4' : ''
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
            ${windowClause}
        `, dayStart ? [input.key, input.kind, dayStart, dayEnd] : [input.key, input.kind])
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
          return { ok: false, dimension: exceeded, retryAt: dayEnd }
        }
        await client.query(`
          INSERT INTO memory_provider_budget_reservations
            (reservation_id, budget_key, provider_kind, reserved_input_tokens, reserved_output_tokens, created_at)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [reservationId, input.key, input.kind, input.inputTokens, input.outputTokens, reservationTime])
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

const receiptBudgetedProviders=new WeakSet<object>()
export const isReceiptBudgetedTextProvider=(provider:TextGenerator)=>receiptBudgetedProviders.has(provider)

export function withTextProviderBudget(
  provider: TextGenerator,
  store: ProviderBudgetStore,
  limits: {
    key: string
    maxRequests: number
    window?: 'lifetime' | 'daily-asia-shanghai'
    maxInputTokens: number
    maxOutputTokens: number
    maxOutputTokensPerRequest: number
  },
): TextGenerator {
  const wrapped:TextGenerator={
    async generateJson<T>(input: Parameters<TextGenerator['generateJson']>[0]): Promise<ModelJsonResult<T>> {
      if(input.receipt)assertProviderReceiptBudgetInput(input.receipt,input.operation,input.requestKey)
      await assertSourceProviderExecution(store.sourceExecutionRequired===true)
      // UTF-8 bytes are a conservative upper bound for tokenizer input units.
      const inputTokens = Buffer.byteLength(input.system, 'utf8')
        + Buffer.byteLength(JSON.stringify(input.document), 'utf8')
        + Buffer.byteLength(JSON.stringify(input.schema), 'utf8')
        + Buffer.byteLength('\n\nOutput JSON Schema:\n', 'utf8')
        + 1_024 // fixed conservative allowance for message framing/tokenizer overhead
      let reservation: ProviderBudgetReservation
      try {
        reservation = await store.reserve({
          key: limits.key,
          requestKey: input.requestKey,
          kind: 'text',
          inputTokens,
          outputTokens: limits.maxOutputTokensPerRequest,
          maxRequests: limits.maxRequests,
          window: limits.window,
          maxInputTokens: limits.maxInputTokens,
          maxOutputTokens: limits.maxOutputTokens,
        })
      } catch {
        return { ok: false, code: 'budget_unavailable', retryable: true, detail: 'reservation_failed' }
      }
      if (!reservation.ok) {
        if (reservation.reason==='provider_result_unknown')return {ok:false,code:'provider_result_unknown',retryable:false,detail:'request_already_reserved',budgetReservationId:reservation.reservationId}
        return { ok: false, code: 'budget_exceeded', retryable: false, detail: reservation.dimension,
          ...(reservation.retryAt ? {retryAt:reservation.retryAt.toISOString()}: {}) }
      }
      const attempt=await startSourceProviderAttempt(reservation.reservationId,input.requestKey)
      if(input.authorizeDispatch&&!await input.authorizeDispatch().catch(()=>false)){
        try{await finishSourceProviderAttempt(attempt,'not-sent')}
        catch{
          blockUnrecordedSourceEffect()
          return {ok:false,code:'provider_result_unknown',retryable:false,billingUncertain:true,budgetReservationId:reservation.reservationId}
        }
        return {ok:false,code:'source_not_sent',retryable:true,budgetReservationId:reservation.reservationId}
      }
      const receipt=input.receipt?await admitProviderReceipt(input.receipt,reservation.reservationId):undefined
      const complete=async():Promise<ModelJsonResult<T>>=>{
      let effect:'accounted'|'uncertain'='uncertain'
      let result:ModelJsonResult<T>
      try{
        result = await provider.generateJson<T>(input)
      }catch(error){
        try{await finishSourceProviderAttempt(attempt,'uncertain')}catch{blockUnrecordedSourceEffect()}
        throw error
      }
      let receiptFailed=false
      if (result.usage) {
        try{
          await store.settle(reservation.reservationId, {
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
          })
          effect='accounted'
        }catch{receiptFailed=true}
      }
      try{await finishSourceProviderAttempt(attempt,effect)}catch{receiptFailed=true}
      if(receiptFailed){
        blockUnrecordedSourceEffect()
        return {ok:false,code:'provider_result_unknown',retryable:false,billingUncertain:true,
          ...(result.usage?{usage:result.usage}:{}),budgetReservationId:reservation.reservationId}
      }
      return { ...result, budgetReservationId: reservation.reservationId,
        ...(!result.usage ? {billingUncertain:true}: {}) }
      }
      return receipt?trackProviderReceipt(receipt,complete):complete()
    },
  }
  receiptBudgetedProviders.add(wrapped)
  return wrapped
}

export function withEmbeddingProviderBudget(
  provider: EmbeddingProvider,
  store: ProviderBudgetStore,
  limits: { key: string; maxRequests: number; maxTokens: number },
): EmbeddingProvider {
  return {
    dimensions: provider.dimensions,
    async embed(input) {
      await assertSourceProviderExecution(store.sourceExecutionRequired===true&&input.operation==='claim_index')
      const requestKey=sourceProviderRequestKey(input.operation,input.texts)
      const inputTokens = input.texts.reduce((sum, text) => sum + Buffer.byteLength(text, 'utf8'), 0)
      const reservation = await store.reserve({
        key: limits.key,
        requestKey,
        kind: 'embedding',
        inputTokens,
        outputTokens: 0,
        maxRequests: limits.maxRequests,
        maxInputTokens: limits.maxTokens,
        maxOutputTokens: 0,
      })
      if (!reservation.ok) {
        if(reservation.reason==='provider_result_unknown')throw new Error('provider_result_unknown')
        throw new ProviderBudgetExceededError(reservation.dimension)
      }
      const attempt=await startSourceProviderAttempt(reservation.reservationId,requestKey)
      let effect:'accounted'|'uncertain'='uncertain'
      let result:Awaited<ReturnType<EmbeddingProvider['embed']>>
      try{
        result = await provider.embed(input)
      }catch(error){
        try{await finishSourceProviderAttempt(attempt,'uncertain')}catch{blockUnrecordedSourceEffect()}
        throw error
      }
      let receiptFailed=false
      try{
        await store.settle(reservation.reservationId, { inputTokens: result.tokens, outputTokens: 0 })
        effect='accounted'
      }catch{receiptFailed=true;blockUnrecordedSourceEffect()}
      try{await finishSourceProviderAttempt(attempt,effect)}catch{receiptFailed=true;blockUnrecordedSourceEffect()}
      // Return known usage for independent accounting. The execution barrier
      // rejects its vector publication if recording its effect failed.
      return {...result,budgetReservationId:reservation.reservationId,...(receiptFailed?{billingUncertain:true}:{})}
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
