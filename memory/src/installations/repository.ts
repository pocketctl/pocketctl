import type pg from 'pg'
import type { ProviderInstallationItem, ProviderInstallationItemV2 } from '../relay/contracts.js'

export interface DiscoveryApplyResult {
  applied: number
}

/**
 * Local installation registry. `applyDiscovery` runs in one transaction and is
 * only called with a COMPLETE generation (the worker aggregates every page
 * first): rows missing from the inventory are marked degraded — never
 * deleted — so one truncated page cannot erase state, and revoked
 * installations enqueue exactly one purge job.
 */
export function createInstallationRegistry(pool: pg.Pool) {
  return {
    async currentGeneration(): Promise<number> {
      const result = await pool.query<{ generation: string | null }>(
        `SELECT MAX(discovery_generation)::text AS generation FROM memory_installations`,
      )
      return Number(result.rows[0]?.generation ?? 0)
    },

    async applyDiscovery(input: {
      generation: number
      items: Array<Omit<ProviderInstallationItem, 'subscriptions'> & {
        subscriptions: string[]
      } & Partial<Pick<ProviderInstallationItemV2,
        'owner_scope_kind' | 'owner_scope_id' | 'parent_organization_id' | 'authorization_epoch' | 'scope_snapshot'>>>
      installationCursor?: string
    }): Promise<DiscoveryApplyResult> {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        try {
          const seen: string[] = []
          for (const item of input.items) {
            seen.push(item.installation_id)
            await client.query(`
              INSERT INTO memory_installations
                (installation_id, provider_id, relay_status, local_status, config_version,
                 granted_scopes, subscriptions, enabled_services, event_filter,
                 snapshot_required, discovery_generation)
              VALUES ($1, 'pocketctl-memory', $2,
                      CASE WHEN $2 IN ('revoking','revoked') THEN 'purging'
                           WHEN $2 = 'pending' THEN 'discovering'
                           ELSE 'syncing' END,
                      $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9)
              ON CONFLICT (installation_id) DO UPDATE SET
                relay_status = EXCLUDED.relay_status,
                config_version = EXCLUDED.config_version,
                granted_scopes = EXCLUDED.granted_scopes,
                subscriptions = EXCLUDED.subscriptions,
                enabled_services = EXCLUDED.enabled_services,
                event_filter = EXCLUDED.event_filter,
                snapshot_required = EXCLUDED.snapshot_required,
                discovery_generation = EXCLUDED.discovery_generation,
                local_status = CASE
                  WHEN memory_installations.local_status = 'purged'
                    THEN 'purged'
                  WHEN EXCLUDED.relay_status IN ('revoking','revoked') THEN 'purging'
                  WHEN memory_installations.local_status IN ('purging','integrity_error')
                    THEN memory_installations.local_status
                  WHEN memory_installations.local_status = 'discovering'
                    AND EXCLUDED.relay_status <> 'pending'
                    THEN 'syncing'
                  ELSE memory_installations.local_status
                END,
                last_error_code = CASE
                  WHEN memory_installations.local_status = 'integrity_error'
                    THEN memory_installations.last_error_code
                  ELSE NULL
                END,
                updated_at = NOW()
            `, [
              item.installation_id,
              item.status,
              Number(item.config_version),
              JSON.stringify(item.granted_scopes),
              JSON.stringify(item.subscriptions),
              JSON.stringify(item.enabled_services),
              JSON.stringify(item.event_filter),
              item.snapshot_required,
              input.generation,
            ])
          }

          // Rows absent from a complete generation are degraded, not deleted:
          // the purge queue (or their return in a later generation) decides.
          await client.query(`
            UPDATE memory_installations
            SET local_status = 'degraded', last_error_code = 'missing_from_relay', updated_at = NOW()
            WHERE discovery_generation < $1
              AND installation_id <> ALL($2::uuid[])
              AND local_status IN ('discovering','syncing','ready','degraded')
          `, [input.generation, seen])

          // Phase 1 feature modes default to off; a settings row appears on
          // first discovery and existing operator choices are never rewritten.
          await client.query(`
            INSERT INTO memory_feature_settings (installation_id)
            SELECT installation_id FROM memory_installations
            WHERE installation_id = ANY($1::uuid[])
            ON CONFLICT (installation_id) DO NOTHING
          `, [seen])

          // ADR-0005: mirror the v2 owner-scope facts for every installation;
          // v1-only items default to the personal backfill shape.
          for (const item of input.items) {
            const scopeResult = await client.query<{ authorization_epoch: string }>(`
              INSERT INTO memory_owner_scopes
                (installation_id, owner_scope_kind, owner_scope_id, parent_organization_id,
                 state, authorization_epoch)
              VALUES ($1, $2, $3, $4, $6, $5)
              ON CONFLICT (installation_id) DO UPDATE SET
                owner_scope_kind = EXCLUDED.owner_scope_kind,
                owner_scope_id = EXCLUDED.owner_scope_id,
                parent_organization_id = EXCLUDED.parent_organization_id,
                state = CASE WHEN $7::boolean AND memory_owner_scopes.state <> 'dissolved'
                                  AND (EXCLUDED.authorization_epoch > memory_owner_scopes.authorization_epoch
                                    OR (EXCLUDED.authorization_epoch = memory_owner_scopes.authorization_epoch
                                        AND EXCLUDED.state <> 'active'))
                             THEN EXCLUDED.state ELSE memory_owner_scopes.state END,
                authorization_epoch = GREATEST(memory_owner_scopes.authorization_epoch, EXCLUDED.authorization_epoch),
                updated_at = NOW()
              RETURNING authorization_epoch::text
            `, [
              item.installation_id,
              item.owner_scope_kind ?? 'personal',
              item.owner_scope_id ?? item.installation_id,
              item.parent_organization_id ?? null,
              item.authorization_epoch ?? '1',
              item.scope_snapshot?.state ?? 'active',
              item.scope_snapshot != null,
            ])
            // The scope UPSERT holds its row lock until COMMIT. Feed writes
            // acquire the same lock so the epoch and complete member set are
            // published atomically, including repair of earlier discoveries.
            const snapshot = item.scope_snapshot
            if (!snapshot || item.owner_scope_kind === 'personal'
              || scopeResult.rows[0]?.authorization_epoch !== item.authorization_epoch) continue
            const tombstone = await client.query(`
              SELECT 1 FROM memory_scope_tombstones
              WHERE owner_scope_kind = $1 AND owner_scope_id = $2 AND authorization_epoch >= $3
            `, [item.owner_scope_kind, item.owner_scope_id, item.authorization_epoch])
            if (tombstone.rows.length > 0) continue
            for (const member of snapshot.memberships) {
              await client.query(`
                INSERT INTO memory_scope_memberships
                  (installation_id, membership_id, roles, state, membership_revision, valid_from, valid_until)
                VALUES ($1, $2, $3::text[], $4, $5, NOW(), CASE WHEN $4 = 'revoked' THEN NOW() ELSE NULL END)
                ON CONFLICT (installation_id, membership_id) DO UPDATE SET
                  roles = EXCLUDED.roles, state = EXCLUDED.state,
                  membership_revision = EXCLUDED.membership_revision,
                  valid_until = EXCLUDED.valid_until, updated_at = NOW()
                WHERE memory_scope_memberships.membership_revision < EXCLUDED.membership_revision
              `, [item.installation_id, member.membership_id, member.roles, member.state, member.membership_revision])
            }
            await client.query(`
              UPDATE memory_scope_memberships SET state = 'revoked', valid_until = NOW(), updated_at = NOW()
              WHERE installation_id = $1 AND membership_id <> ALL($2::uuid[]) AND state <> 'revoked'
            `, [item.installation_id, snapshot.memberships.map(member => member.membership_id)])
            if (snapshot.state === 'dissolved') {
              await client.query(`
                INSERT INTO memory_scope_tombstones (owner_scope_kind, owner_scope_id, authorization_epoch, reason)
                VALUES ($1, $2, $3, 'dissolved')
                ON CONFLICT (owner_scope_kind, owner_scope_id) DO UPDATE SET
                  authorization_epoch = GREATEST(memory_scope_tombstones.authorization_epoch, EXCLUDED.authorization_epoch)
              `, [item.owner_scope_kind, item.owner_scope_id, item.authorization_epoch])
            }
          }

          await client.query(`
            INSERT INTO memory_provider_state (provider_id, installation_cursor, last_discovery_at, updated_at)
            VALUES ('pocketctl-memory', $1, NOW(), NOW())
            ON CONFLICT (provider_id) DO UPDATE SET
              installation_cursor = COALESCE(EXCLUDED.installation_cursor, memory_provider_state.installation_cursor),
              last_discovery_at = NOW(),
              updated_at = NOW()
          `, [input.installationCursor ?? null])

          await client.query('COMMIT')
          return { applied: input.items.length }
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        }
      } finally {
        client.release()
      }
    },

    /** Installations the feed consumer may pull (local state permitting). */
    async listPulledInstallations(): Promise<Array<{
      installation_id: string
      relay_status: string
      local_status: string
      snapshot_required: boolean
    }>> {
      const result = await pool.query(`
        SELECT installation_id, relay_status, local_status, snapshot_required
        FROM memory_installations
        WHERE relay_status IN ('pending','active')
          AND local_status IN ('discovering','syncing','ready','degraded')
        ORDER BY created_at ASC
      `)
      return result.rows
    },
  }
}

export type InstallationRegistry = ReturnType<typeof createInstallationRegistry>
