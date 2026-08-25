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
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
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
          await client.query('ROLLBACK')
          if (!row || !row.request_hash.equals(requestHash)) return { kind: 'conflict' }
          return { kind: 'replayed', metadata: row.response_metadata ?? {} }
        }
        const result = await input.run(client)
        if (!result.ok) {
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
        await client.query('COMMIT')
        return { kind: 'completed', metadata: result.metadata ?? {} }
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    },

    /** Maintenance: drop expired rows (called from the expiry job). */
    async pruneExpired(): Promise<number> {
      const result = await pool.query(`DELETE FROM memory_idempotency_keys WHERE expires_at <= NOW()`)
      return result.rowCount ?? 0
    },
  }
}

export type IdempotencyStore = ReturnType<typeof createIdempotencyStore>
