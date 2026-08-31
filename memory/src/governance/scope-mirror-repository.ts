import type pg from 'pg'

/**
 * ADR-0005 Memory-side mirror of Relay-owned owner-scope facts. The mirror
 * holds only the opaque identifiers and authorization fences (scope kind/id,
 * lifecycle state, authorization epoch, watermark) required to reject stale
 * v2 grants; it never stores user identity or membership display data.
 */

export interface OwnerScopeRow {
  installation_id: string
  owner_scope_kind: 'personal' | 'team' | 'organization'
  owner_scope_id: string
  parent_organization_id: string | null
  state: 'active' | 'suspended' | 'dissolving' | 'dissolved'
  authorization_epoch: string
  last_feed_id: string
}

export function createScopeMirrorRepository(pool: pg.Pool) {
  return {
    async upsertFromDiscovery(input: {
      installationId: string
      ownerScopeKind: 'personal' | 'team' | 'organization'
      ownerScopeId: string
      parentOrganizationId?: string | null
      authorizationEpoch: string | number
    }): Promise<void> {
      await pool.query(`
        INSERT INTO memory_owner_scopes
          (installation_id, owner_scope_kind, owner_scope_id, parent_organization_id,
           state, authorization_epoch)
        VALUES ($1, $2, $3, $4, 'active', $5)
        ON CONFLICT (installation_id) DO UPDATE SET
          owner_scope_kind = EXCLUDED.owner_scope_kind,
          owner_scope_id = EXCLUDED.owner_scope_id,
          parent_organization_id = EXCLUDED.parent_organization_id,
          authorization_epoch = GREATEST(memory_owner_scopes.authorization_epoch, EXCLUDED.authorization_epoch),
          updated_at = NOW()
      `, [input.installationId, input.ownerScopeKind, input.ownerScopeId,
        input.parentOrganizationId ?? null, input.authorizationEpoch])
    },

    async get(installationId: string): Promise<OwnerScopeRow | null> {
      const result = await pool.query<{
        installation_id: string
        owner_scope_kind: OwnerScopeRow['owner_scope_kind']
        owner_scope_id: string
        parent_organization_id: string | null
        state: OwnerScopeRow['state']
        authorization_epoch: string
        last_feed_id: string
      }>(`
        SELECT installation_id, owner_scope_kind, owner_scope_id::text, parent_organization_id::text,
               state, authorization_epoch::text, last_feed_id::text
        FROM memory_owner_scopes WHERE installation_id = $1
      `, [installationId])
      const row = result.rows[0]
      if (!row) return null
      return {
        installation_id: row.installation_id,
        owner_scope_kind: row.owner_scope_kind,
        owner_scope_id: row.owner_scope_id,
        parent_organization_id: row.parent_organization_id,
        state: row.state,
        authorization_epoch: row.authorization_epoch,
        last_feed_id: row.last_feed_id,
      }
    },

    async listSharedInstallations(): Promise<Array<{ installation_id: string; owner_scope_kind: 'team' | 'organization'; owner_scope_id: string }>> {
      const result = await pool.query(`
        SELECT installation_id, owner_scope_kind, owner_scope_id::text
        FROM memory_owner_scopes
        WHERE owner_scope_kind IN ('team', 'organization')
          AND state IN ('active', 'suspended', 'dissolving')
        ORDER BY installation_id
      `)
      return result.rows
    },

    /** Advance the authorization fence; only a newer epoch ever wins. */
    async advanceEpoch(input: {
      installationId: string
      authorizationEpoch: string
      lastFeedId: string
    }): Promise<void> {
      await pool.query(`
        UPDATE memory_owner_scopes
        SET authorization_epoch = GREATEST(authorization_epoch, $2),
            last_feed_id = GREATEST(last_feed_id, $3),
            updated_at = NOW()
        WHERE installation_id = $1
      `, [input.installationId, input.authorizationEpoch, input.lastFeedId])
    },

    /** Record a dissolution tombstone; the highest epoch always wins. */
    async recordTombstone(input: {
      ownerScopeKind: 'team' | 'organization'
      ownerScopeId: string
      authorizationEpoch: string
      reason: string
    }): Promise<void> {
      await pool.query(`
        INSERT INTO memory_scope_tombstones (owner_scope_kind, owner_scope_id, authorization_epoch, reason)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (owner_scope_kind, owner_scope_id) DO UPDATE SET
          authorization_epoch = GREATEST(memory_scope_tombstones.authorization_epoch, EXCLUDED.authorization_epoch),
          reason = EXCLUDED.reason,
          tombstoned_at = NOW()
      `, [input.ownerScopeKind, input.ownerScopeId, input.authorizationEpoch, input.reason])
    },

    /** True when a tombstone at or above the given epoch blocks the event. */
    async tombstoneEpochAtLeast(input: {
      ownerScopeKind: 'team' | 'organization'
      ownerScopeId: string
      authorizationEpoch: string
    }): Promise<boolean> {
      const result = await pool.query<{ authorization_epoch: string }>(`
        SELECT authorization_epoch::text FROM memory_scope_tombstones
        WHERE owner_scope_kind = $1 AND owner_scope_id = $2
      `, [input.ownerScopeKind, input.ownerScopeId])
      const row = result.rows[0]
      return row !== undefined
        && BigInt(row.authorization_epoch) >= BigInt(input.authorizationEpoch)
    },
  }
}

export type ScopeMirrorRepository = ReturnType<typeof createScopeMirrorRepository>
