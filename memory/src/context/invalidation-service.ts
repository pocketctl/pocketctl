import type pg from 'pg'

/**
 * Dependency-driven invalidation (plan 12.2): every not-yet-admitted pack
 * that depends on a changed source flips to `invalidated` through JOINs from
 * pack items to versions/evidence — rendered text is never scanned or
 * parsed. Already-delivered history stays untouched.
 */
export function createInvalidationService(deps: { pool: pg.Pool }) {
  return {
    /** Claim corrected/superseded/expired/revoked/privacy-deleted. */
    async onClaimStateChange(input: {
      installationId: string
      claimIds: readonly string[]
    }): Promise<number> {
      if (input.claimIds.length === 0) return 0
      const result = await deps.pool.query(`
        UPDATE memory_context_packs p
        SET state = 'invalidated', invalidated_at = NOW(), error_code = 'claim_state_changed'
        WHERE p.installation_id = $1
          AND p.state IN ('compiling','ready','shadow')
          AND EXISTS (
            SELECT 1 FROM memory_context_pack_items i
            WHERE i.pack_id = p.pack_id
              AND i.installation_id = p.installation_id
              AND i.claim_id = ANY($2::uuid[]))
          AND NOT EXISTS (
            SELECT 1 FROM memory_context_injections j
            WHERE j.pack_id = p.pack_id
              AND j.state IN ('admitted','prepared','delivered','delivery_failed'))
      `, [input.installationId, input.claimIds])
      return result.rowCount ?? 0
    },

    /** Evidence or source session purged. */
    async onEvidencePurge(input: {
      installationId: string
      versionIds: readonly string[]
    }): Promise<number> {
      if (input.versionIds.length === 0) return 0
      const result = await deps.pool.query(`
        UPDATE memory_context_packs p
        SET state = 'invalidated', invalidated_at = NOW(), error_code = 'evidence_purged'
        WHERE p.installation_id = $1
          AND p.state IN ('compiling','ready','shadow')
          AND EXISTS (
            SELECT 1 FROM memory_context_pack_items i
            WHERE i.pack_id = p.pack_id
              AND i.installation_id = p.installation_id
              AND i.version_id = ANY($2::uuid[]))
          AND NOT EXISTS (
            SELECT 1 FROM memory_context_injections j
            WHERE j.pack_id = p.pack_id
              AND j.state IN ('admitted','prepared','delivered','delivery_failed'))
      `, [input.installationId, input.versionIds])
      return result.rowCount ?? 0
    },

    /**
     * Settings/policy/loadout/Relay-service change: invalidate every
     * not-yet-admitted pack of the installation. Already admitted turns are
     * not retracted — the change applies from the next turn (ADR-P2-05).
     */
    async onConfigurationChange(input: {
      installationId: string
      reason: 'settings_changed' | 'policy_changed' | 'loadout_changed' | 'service_disabled'
    }): Promise<number> {
      const result = await deps.pool.query(`
        UPDATE memory_context_packs p
        SET state = 'invalidated', invalidated_at = NOW(), error_code = $2
        WHERE p.installation_id = $1
          AND p.state IN ('compiling','ready','shadow')
          AND NOT EXISTS (
            SELECT 1 FROM memory_context_injections j
            WHERE j.pack_id = p.pack_id
              AND j.state IN ('admitted','prepared','delivered','delivery_failed'))
      `, [input.installationId, input.reason])
      return result.rowCount ?? 0
    },
  }
}

export type InvalidationService = ReturnType<typeof createInvalidationService>
