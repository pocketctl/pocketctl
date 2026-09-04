import type pg from 'pg'
import { normalizedClaimKey } from '../retrieval/query-normalizer.js'
import type { ActiveClaimIdentity } from './validator.js'
import type { TombstoneHmacKey } from '../config.js'
import { findTombstonedNormalizedKeys } from '../claims/tombstones.js'

/**
 * Loads the active-claim family for duplicate/conflict classification. Every
 * query is installation-scoped: another installation's claims are invisible
 * by construction (cross-installation exclusion is a SQL boundary, not a
 * post-filter).
 */
export function createCandidateDeduper(
  pool: pg.Pool,
  options: { tombstoneHmacKeys?: readonly TombstoneHmacKey[] } = {},
) {
  return {
    async activeFamilyFor(input: {
      installationId: string
      claimType: string
      scopeKey: string
      statement: string
    }): Promise<{ exactClaimId: string | null; family: readonly ActiveClaimIdentity[] }> {
      const exactKey = normalizedClaimKey({
        claimType: input.claimType,
        scopeKey: input.scopeKey,
        statement: input.statement,
      })
      const result = await pool.query<{ claim_id: string; normalized_key: string; statement: string }>(`
        SELECT c.claim_id::text, c.normalized_key, v.statement
        FROM knowledge_claims c
        JOIN knowledge_versions v ON v.version_id = c.current_version_id
        WHERE c.installation_id = $1
          AND c.claim_type = $2
          AND c.scope_key = $3
          AND c.state = 'active'
        ORDER BY c.claim_id
        LIMIT 10000
      `, [input.installationId, input.claimType, input.scopeKey])
      const family: ActiveClaimIdentity[] = result.rows.map(row => ({
        claimId: row.claim_id,
        statement: row.statement,
      }))
      const exact = result.rows.find(row => row.normalized_key === exactKey)
      return {
        exactClaimId: exact?.claim_id ?? null,
        family,
      }
    },

    async tombstonedKeys(input: {
      installationId: string
      candidateKeys: readonly string[]
    }): Promise<ReadonlySet<string>> {
      if (input.candidateKeys.length === 0) return new Set()
      return findTombstonedNormalizedKeys(pool, {
        installationId: input.installationId,
        normalizedKeys: input.candidateKeys,
        keys: options.tombstoneHmacKeys ?? [],
      })
    },
  }
}

export type CandidateDeduper = ReturnType<typeof createCandidateDeduper>
