import {currentClaimVersionSql} from './version-selection.js'
import type pg from 'pg'
import type { ClaimRepository } from './repository.js'

/**
 * Claim lifecycle: correct (immutable Version N+1), expire, revoke, supersede
 * — plus the idempotent `expire_claims` maintenance pass driven by the
 * database clock and registered in the worker.
 */
export function createLifecycleService(pool: pg.Pool, claims: ClaimRepository) {
  return {
    correctClaim: claims.correctClaim.bind(claims) as typeof claims.correctClaim,
    expireClaim: (input: Omit<Parameters<ClaimRepository['transitionClaim']>[0], 'target'>) =>
      claims.transitionClaim({ ...input, target: 'expired' }),
    revokeClaim: (input: Omit<Parameters<ClaimRepository['transitionClaim']>[0], 'target'>) =>
      claims.transitionClaim({ ...input, target: 'revoked' }),
    supersedeClaim: claims.supersedeClaim.bind(claims) as typeof claims.supersedeClaim,

    /**
     * Database-clock expiry sweep: any active claim whose current version's
     * valid_until passed NOW() expires. Idempotent, removes the search
     * projection, records feedback, never mutates the immutable version.
     */
    async expireDueClaims(): Promise<number> {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        try {
          // Discover without holding Claims; a purge owns generation/outbox
          // rows first. Lock the complete installation set before domain rows,
          // then recheck eligibility on this bounded batch after every wait.
          const observed = await client.query<{ claim_id: string; installation_id: string }>(`
            SELECT c.claim_id::text, c.installation_id::text
            FROM knowledge_claims c
            JOIN knowledge_versions v ON v.installation_id=c.installation_id AND v.version_id = c.current_version_id
            WHERE c.state = 'active' AND ${currentClaimVersionSql()}
              AND v.valid_until IS NOT NULL
              AND v.valid_until <= NOW()
            ORDER BY c.claim_id
            LIMIT 500
          `)
          const installationIds=[...new Set(observed.rows.map(row=>row.installation_id))].sort()
          for(const id of installationIds)await client.query(`SELECT pg_advisory_xact_lock_shared(hashtextextended('purge:installation:' || $1,0))`,[id])
          const due=await client.query<{claim_id:string}>(`
            SELECT c.claim_id::text FROM knowledge_claims c
            JOIN knowledge_versions v ON v.installation_id=c.installation_id AND v.version_id=c.current_version_id
            WHERE c.claim_id=ANY($1::uuid[]) AND c.state='active' AND ${currentClaimVersionSql()}
              AND v.valid_until IS NOT NULL AND v.valid_until<=clock_timestamp()
            ORDER BY c.installation_id,c.claim_id FOR UPDATE OF c
          `,[observed.rows.map(row=>row.claim_id)])
          let expired = 0
          for (const row of due.rows) {
            await client.query(`
              UPDATE knowledge_claims SET state = 'expired', revision = revision + 1, updated_at = NOW()
              WHERE claim_id = $1 AND state = 'active'
            `, [row.claim_id])
            await client.query(`
              DELETE FROM claim_search_documents
              WHERE version_id IN (
                SELECT version_id FROM knowledge_versions
                WHERE claim_id = $1
              )
            `, [row.claim_id])
            await client.query(`
              INSERT INTO memory_feedback (feedback_id, installation_id, claim_id, version_id, action)
              SELECT gen_random_uuid(), c.installation_id, c.claim_id, c.current_version_id, 'claim_expired'
              FROM knowledge_claims c WHERE c.claim_id = $1
            `, [row.claim_id])
            expired++
          }
          await client.query('COMMIT')
          return expired
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

export type LifecycleService = ReturnType<typeof createLifecycleService>
