import {DeferredSourcePreparation,attachSourcePreparationCache,detachSourcePreparationCache,verifySourcePreparationCache,type SourcePreparationCache} from '../sources/deferred-preparation.js'
import {sourceConnectionKey} from '../sources/pool-context.js'
import {assertRetainedSourceGuards} from '../sources/retained-authority.js'
import { createHash } from 'crypto'
import type pg from 'pg'

/**
 * Bounded idempotency for management mutations (plan §7.2). Rows keep only
 * key/request hashes and non-content response metadata, and expire after 24
 * hours. A duplicate key replays the original result; a same-key/different-
 * request is a conflict.
 */

const RETENTION_MS = 24 * 60 * 60 * 1000

export function createIdempotencyStore(pool: pg.Pool) {
  return {
    hash(value: string): Buffer {
      return createHash('sha256').update(value, 'utf8').digest()
    },

    async execute<T>(input: {
      installationId: string
      operation: string
      /** Raw Idempotency-Key header value. */
      key: string
      /** Canonical serialization of the request used to detect key reuse. */
      requestCanonical: string
      /** Git source readers require READ COMMITTED even on a differently configured server. */
      isolation?: 'read_committed'
      /** Current authority before reservation and again after any reservation wait. */
      authorize?: (client: pg.PoolClient) => Promise<void>
      /** Time-only final fence: a legitimate mutation may change its own authority. */
      beforeCommit?: (client: pg.PoolClient) => Promise<void>
      /** Runs the mutation and returns bounded metadata. */
      /** Runs inside the same transaction that records the completed result. */
      run: (client: pg.PoolClient) => Promise<{ ok: true; metadata: Record<string, unknown> } | { ok: false; error: unknown }>
    }): Promise<
      | { kind: 'replayed'; metadata: Record<string, unknown> }
      | { kind: 'conflict' }
      | { kind: 'completed'; metadata: Record<string, unknown> }
      | { kind: 'failed'; error: unknown }
    > {
      const keyHash = this.hash(input.key)
      const requestHash = this.hash(input.requestCanonical)
      const preparations:SourcePreparationCache=new Map()
      const ownsPreparation=sourceConnectionKey(pool)===pool
      for(let attempt=0;attempt<5;attempt++){
        let deferred:DeferredSourcePreparation|undefined
        const client = await pool.connect()
        if(ownsPreparation)attachSourcePreparationCache(client,preparations)
        try {
          await client.query(input.isolation === 'read_committed' ? 'BEGIN ISOLATION LEVEL READ COMMITTED' : 'BEGIN')
          await input.authorize?.(client)
          await client.query(`
            DELETE FROM memory_idempotency_keys
            WHERE installation_id = $1 AND operation = $2 AND key_hash = $3
              AND expires_at <= NOW()
          `, [input.installationId, input.operation, keyHash])
          // The unique key serializes concurrent requests. An uncommitted insert
          // blocks the contender; if the owner rolls back, the contender becomes
          // the owner. This avoids both advisory-lock pool starvation and a
          // committed-business/missing-result crash window.
          const reserved = await client.query(`
            INSERT INTO memory_idempotency_keys
              (installation_id, operation, key_hash, request_hash, response_metadata, expires_at)
            VALUES ($1, $2, $3, $4, '{}'::jsonb, NOW() + ($5 * INTERVAL '1 millisecond'))
            ON CONFLICT (installation_id, operation, key_hash) DO NOTHING
            RETURNING 1
          `, [input.installationId, input.operation, keyHash, requestHash, RETENTION_MS])
          if (reserved.rowCount === 0) {
            const existing = await client.query<{ response_metadata: Record<string, unknown>; request_hash: Buffer }>(`
              SELECT response_metadata, request_hash FROM memory_idempotency_keys
              WHERE installation_id = $1 AND operation = $2 AND key_hash = $3
            `, [input.installationId, input.operation, keyHash])
            const row = existing.rows[0]
            await input.authorize?.(client)
            await client.query('ROLLBACK')
            if (!row || !row.request_hash.equals(requestHash)) return { kind: 'conflict' }
            return { kind: 'replayed', metadata: row.response_metadata ?? {} }
          }
          await input.authorize?.(client)
          const result = await input.run(client)
          if (!result.ok) {
            if(result.error instanceof DeferredSourcePreparation)throw result.error
            await client.query('ROLLBACK')
            return { kind: 'failed', error: result.error }
          }
          await client.query(`
            UPDATE memory_idempotency_keys
            SET response_metadata = $4::jsonb,
                expires_at = NOW() + ($5 * INTERVAL '1 millisecond')
            WHERE installation_id = $1 AND operation = $2 AND key_hash = $3
          `, [
            input.installationId, input.operation, keyHash,
            JSON.stringify(result.metadata ?? {}), RETENTION_MS,
          ])
          await input.beforeCommit?.(client)
          await verifySourcePreparationCache(client,preparations)
          await assertRetainedSourceGuards(client)
          await input.beforeCommit?.(client)
          await client.query('COMMIT')
          return { kind: 'completed', metadata: result.metadata ?? {} }
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined)
          if(error instanceof DeferredSourcePreparation&&ownsPreparation)deferred=error
          else throw error
        } finally {
          if(ownsPreparation)detachSourcePreparationCache(client)
          client.release()
        }
        if(!deferred||preparations.has(deferred.key)||preparations.size>=4||attempt===4)throw new Error('source_preparation_retry_limit')
        // The socket is released and ROLLBACK finished before any body/archive IO.
        const prepared=await deferred.prepare(pool)
        const bytes=[...preparations.values(),prepared].reduce((sum,value)=>sum+(value.bodyBytes??0),0)
        if(bytes>32*1024*1024)throw new Error('source_reference_byte_limit')
        preparations.set(deferred.key,prepared)
      }
      throw new Error('source_preparation_retry_limit')
    },

    /** Maintenance: drop expired rows (called from the expiry job). */
    async pruneExpired(): Promise<number> {
      const result = await pool.query(`DELETE FROM memory_idempotency_keys WHERE expires_at <= NOW()`)
      return result.rowCount ?? 0
    },
  }
}

export type IdempotencyStore = ReturnType<typeof createIdempotencyStore>
