import { createHash, randomUUID } from 'crypto'
import type pg from 'pg'
import type {
  LoadoutItemInput,
  LoadoutRepresentation,
  ResolvedLoadoutItem,
} from './types.js'

const INERT_ASSET_KINDS = new Set(['wiki', 'skill'])
const REQUIRED_CLAIM_TYPE: Partial<Record<string, string>> = {
  persona: 'work_method',
  runbook: 'operational_runbook',
}

export function resolvedLoadoutFingerprint(loadout: {
  revision: number
  items: readonly ResolvedLoadoutItem[]
}): Buffer {
  return createHash('sha256').update(JSON.stringify({
    revision: loadout.revision,
    items: loadout.items.map(item => ({
      itemId: item.itemId,
      assetKind: item.assetKind,
      representation: item.representation,
      priority: item.priority,
      claimId: item.claimId,
      status: item.status,
      claimType: item.claimType,
      versionId: item.versionId,
    })),
  })).digest()
}

/**
 * Context loadouts scoped by Installation/Repository/Agent (plan 9.3).
 * A pinned item improves ELIGIBILITY only: resolution still requires an
 * active claim with a current version; wiki/skill stay inert
 * (`asset_unavailable`) until Phase 4/5 resolvers exist.
 */
export function createLoadoutRepository(pool: pg.Pool) {
  return {
    async replace(input: {
      installationId: string
      repositoryId: string | null
      agent: string | null
      items: readonly LoadoutItemInput[]
      expectedRevision: number
    }): Promise<{ ok: true; revision: number } | { ok: false; error: 'cas_conflict' }> {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const existing = await client.query<{ loadout_id: string; revision: string }>(`
          SELECT loadout_id::text, revision::text FROM memory_context_loadouts
          WHERE installation_id = $1 AND repository_id IS NOT DISTINCT FROM $2
            AND agent IS NOT DISTINCT FROM $3
          FOR UPDATE
        `, [input.installationId, input.repositoryId, input.agent])
        const row = existing.rows[0]
        let loadoutId: string
        let revision: number
        if (row) {
          if (Number(row.revision) !== input.expectedRevision) {
            await client.query('COMMIT')
            return { ok: false, error: 'cas_conflict' }
          }
          const updated = await client.query<{ revision: string }>(`
            UPDATE memory_context_loadouts
            SET revision = revision + 1, updated_at = NOW()
            WHERE loadout_id = $1
            RETURNING revision::text
          `, [row.loadout_id])
          revision = Number(updated.rows[0].revision)
          loadoutId = row.loadout_id
          await client.query(`DELETE FROM memory_context_loadout_items WHERE loadout_id = $1`, [loadoutId])
        } else {
          if (input.expectedRevision !== 1) {
            await client.query('COMMIT')
            return { ok: false, error: 'cas_conflict' }
          }
          loadoutId = randomUUID()
          revision = 1
          await client.query(`
            INSERT INTO memory_context_loadouts
              (loadout_id, installation_id, repository_id, agent, revision)
            VALUES ($1, $2, $3, $4, 1)
          `, [loadoutId, input.installationId, input.repositoryId, input.agent])
        }
        for (const item of input.items) {
          await client.query(`
            INSERT INTO memory_context_loadout_items
              (loadout_id, item_id, asset_kind, installation_id, claim_id,
               external_asset_ref, representation, priority)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          `, [loadoutId, item.itemId, item.assetKind, input.installationId,
            item.claimId, item.externalAssetRef, item.representation, item.priority])
        }
        await client.query('COMMIT')
        return { ok: true, revision }
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    },

    async resolve(input: {
      installationId: string
      repositoryId: string | null
      agent: string | null
    }): Promise<{ revision: number; items: ResolvedLoadoutItem[] }> {
      const loadout = await pool.query<{ loadout_id: string; revision: string }>(`
        SELECT loadout_id::text, revision::text FROM memory_context_loadouts
        WHERE installation_id = $1 AND repository_id IS NOT DISTINCT FROM $2
          AND agent IS NOT DISTINCT FROM $3
      `, [input.installationId, input.repositoryId, input.agent])
      const row = loadout.rows[0]
      if (!row) return { revision: 1, items: [] }
      const items = await pool.query<{
        item_id: string
        asset_kind: string
        claim_id: string | null
        representation: string
        priority: number
        claim_type: string | null
        state: string | null
        current_version_id: string | null
      }>(`
        SELECT i.item_id::text, i.asset_kind, i.claim_id::text, i.representation,
               i.priority, c.claim_type, c.state, c.current_version_id::text
        FROM memory_context_loadout_items i
        LEFT JOIN knowledge_claims c
          ON c.claim_id = i.claim_id AND c.installation_id = i.installation_id
        WHERE i.loadout_id = $1
        ORDER BY i.priority DESC, i.item_id ASC
      `, [row.loadout_id])
      return {
        revision: Number(row.revision),
        items: items.rows.map(item => {
          const resolved: ResolvedLoadoutItem = {
            itemId: item.item_id,
            assetKind: item.asset_kind as ResolvedLoadoutItem['assetKind'],
            representation: item.representation as LoadoutRepresentation,
            priority: Number(item.priority),
            claimId: item.claim_id,
            status: 'asset_unavailable',
            claimType: item.claim_type,
            versionId: item.current_version_id,
          }
          if (INERT_ASSET_KINDS.has(item.asset_kind)) return resolved
          if (!item.claim_id || item.state !== 'active' || !item.current_version_id) {
            resolved.status = 'claim_inactive'
            return resolved
          }
          const requiredType = REQUIRED_CLAIM_TYPE[item.asset_kind]
          if (requiredType && item.claim_type !== requiredType) {
            resolved.status = 'claim_inactive'
            return resolved
          }
          resolved.status = 'resolved'
          return resolved
        }),
      }
    },
  }
}

export type LoadoutRepository = ReturnType<typeof createLoadoutRepository>
