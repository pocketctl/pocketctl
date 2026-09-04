import { createHash } from 'crypto'
import type pg from 'pg'
import type pgPool from 'pg'
import { renderPackText, hashPackText, stableDynamicSplit, type RenderItem } from './renderer.js'
import { estimateTokens } from './token-budget.js'

/**
 * Immutable Context Pack persistence (plan 8.2/9.4). Packs are write-once:
 * a recompile creates a new pack/run; invalidation marks state without ever
 * editing historical content.
 */

export interface PackItemInput {
  itemId: string
  claimId: string
  versionId: string
  claimType: string
  layer: 'L2' | 'L3'
  section: 'stable' | 'dynamic'
  representation: 'summary' | 'on_demand' | 'reference'
  statement: string
  scopeKind: string
  reasonCodes: string[]
  evidenceIds: readonly string[]
}

export interface PersistPackInput {
  installationId: string
  generationRunId: string | null
  trajectoryId: string | null
  sessionId: string
  clientRequestId: string
  agent: string
  repositoryId: string | null
  mode: 'shadow' | 'enabled'
  effectivePolicyHash: Buffer
  settingsFingerprint: Buffer
  loadoutFingerprint: Buffer
  inputDigest: Buffer
  policyRevision: number
  settingsRevision: number
  loadoutRevision: number
  items: readonly PackItemInput[]
  state: 'ready' | 'shadow' | 'empty'
  errorCode?: string | null
}

export function createPackRepository(pool: pg.Pool) {
  return {
    async persist(input: PersistPackInput): Promise<string> {
      const stableItems: RenderItem[] = input.items
        .filter(item => item.section === 'stable')
        .map(item => ({ ...item, evidenceIds: item.evidenceIds }))
      const dynamicItems: RenderItem[] = input.items
        .filter(item => item.section === 'dynamic')
        .map(item => ({ ...item, evidenceIds: item.evidenceIds }))
      const packDigest = createHash('sha256')
        .update([
          input.installationId, input.sessionId, input.clientRequestId,
          input.effectivePolicyHash.toString('hex'), input.inputDigest.toString('hex'),
        ].join('\n'))
        .digest().subarray(0, 16)
      // Preserve deterministic identity while setting RFC 4122 version and
      // variant bits. API UUID validation must never fail based on random hash
      // nibbles (the old raw 128-bit digest failed intermittently).
      packDigest[6] = (packDigest[6] & 0x0f) | 0x50
      packDigest[8] = (packDigest[8] & 0x3f) | 0x80
      const hex = packDigest.toString('hex')
      const packId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
      const fullText = renderPackText({ packId, stable: stableItems, dynamic: dynamicItems })
      const { stable, dynamic } = stableDynamicSplit(fullText)
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(`
          INSERT INTO memory_context_packs
            (pack_id, installation_id, generation_run_id, trajectory_id, session_id, client_request_id,
             agent, repository_id, mode, effective_policy_hash, settings_fingerprint,
             loadout_fingerprint, input_digest, policy_revision, settings_revision, loadout_revision, stable_text, dynamic_text,
             stable_hash, dynamic_hash, stable_tokens, dynamic_tokens,
             stable_cache_hit, state, error_code, generated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
                  $16, $17, $18, $19, $20, $21, $22, FALSE, $23, $24, NOW())
          ON CONFLICT DO NOTHING
        `, [packId, input.installationId, input.generationRunId, input.trajectoryId, input.sessionId,
          input.clientRequestId, input.agent, input.repositoryId, input.mode, input.effectivePolicyHash,
          input.settingsFingerprint, input.loadoutFingerprint, input.inputDigest, input.policyRevision, input.settingsRevision,
          input.loadoutRevision, stable, dynamic, hashPackText(stable),
          hashPackText(dynamic), estimateTokens(stable), estimateTokens(dynamic),
          input.state, input.errorCode ?? null])
        for (const [index, item] of input.items.entries()) {
          await client.query(`
            INSERT INTO memory_context_pack_items
              (pack_id, item_id, installation_id, claim_id, version_id, claim_type,
               layer, section, representation, rendered_text, reason_codes, token_count, ordinal)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            ON CONFLICT DO NOTHING
          `, [packId, item.itemId, input.installationId, item.claimId, item.versionId,
            item.claimType, item.layer, item.section, item.representation,
            item.statement, item.reasonCodes, estimateTokens(item.statement), index])
          for (const evidenceId of item.evidenceIds) {
            await client.query(`
              INSERT INTO memory_context_pack_evidence
                (pack_id, item_id, installation_id, evidence_id)
              VALUES ($1, $2, $3, $4)
              ON CONFLICT DO NOTHING
            `, [packId, item.itemId, input.installationId, evidenceId])
          }
        }
        if (input.generationRunId) {
          await client.query(`
            UPDATE memory_generation_runs
            SET state = 'succeeded', output_kind = 'context_pack', output_id = $2::uuid,
                completed_at = NOW()
            WHERE run_id = $1
          `, [input.generationRunId, packId])
        }
        // Return the database-canonical UUID text so callers never compare
        // against a differently-formatted literal of the same id.
        const canonical = await client.query<{ pack_id: string }>(
          `SELECT pack_id::text FROM memory_context_packs WHERE pack_id = $1`, [packId])
        await client.query('COMMIT')
        return canonical.rows[0]?.pack_id ?? packId
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    },

    async get(packId: string): Promise<{
      state: string
      mode: string
      stable_text: string
      dynamic_text: string
      stable_tokens: number
      dynamic_tokens: number
      item_count: number
      error_code: string | null
      degraded_components: string[] | null
    } | null> {
      const result = await pool.query(`
        SELECT p.state, p.mode, p.stable_text, p.dynamic_text,
               p.stable_tokens, p.dynamic_tokens, p.error_code,
               t.degraded_components,
               (SELECT COUNT(*)::int FROM memory_context_pack_items i
                WHERE i.pack_id = p.pack_id) AS item_count
        FROM memory_context_packs p
        LEFT JOIN memory_retrieval_trajectories t ON t.trajectory_id = p.trajectory_id
        WHERE p.pack_id = $1
      `, [packId])
      return result.rows[0] ?? null
    },

    async listForSession(input: {
      installationId: string
      sessionId: string
      limit?: number
      beforeCreatedAt?: Date | null
      beforePackId?: string | null
    }): Promise<Array<{
      pack_id: string
      state: string
      client_request_id: string
      created_at: Date
      mode: string
      agent: string
      stable_text: string
      dynamic_text: string
      stable_tokens: number
      dynamic_tokens: number
      error_code: string | null
      policy_revision: number
      settings_revision: number
      loadout_revision: number
      items: Array<{
        item_id: string
        claim_id: string
        version_id: string
        claim_type: string
        layer: string
        section: string
        representation: string
        reason_codes: string[]
        token_count: number
        ordinal: number
        evidence_ids: string[]
      }>
      trajectory: null | {
        result_state: string
        degraded_components: string[]
        candidates: Array<{
          version_id: string
          decision: string
          reason_code: string
          final_ordinal: number | null
        }>
      }
    }>> {
      const result = await pool.query<{
        pack_id: string; state: string; client_request_id: string; created_at: Date
        mode: string; agent: string; stable_text: string; dynamic_text: string
        stable_tokens: number; dynamic_tokens: number; error_code: string | null
        policy_revision: string; settings_revision: string; loadout_revision: string
        trajectory_id: string | null; result_state: string | null; degraded_components: string[] | null
      }>(`
        SELECT p.pack_id::text, p.state, p.client_request_id, p.created_at,
               p.mode, p.agent, p.stable_text, p.dynamic_text,
               p.stable_tokens, p.dynamic_tokens, p.error_code,
               p.policy_revision::text, p.settings_revision::text, p.loadout_revision::text,
               p.trajectory_id::text, t.result_state, t.degraded_components
        FROM memory_context_packs p
        LEFT JOIN memory_retrieval_trajectories t ON t.trajectory_id = p.trajectory_id
        WHERE p.installation_id = $1 AND p.session_id = $2
          AND ($3::timestamptz IS NULL OR (p.created_at, p.pack_id) < ($3, $4::uuid))
        ORDER BY p.created_at DESC, p.pack_id DESC
        LIMIT $5
      `, [input.installationId, input.sessionId,
        input.beforeCreatedAt ?? null, input.beforePackId ?? null,
        Math.min(Math.max(input.limit ?? 50, 1), 51)])
      const packIds = result.rows.map(row => row.pack_id)
      const items = packIds.length === 0 ? { rows: [] as Array<{
        pack_id: string; item_id: string; claim_id: string; version_id: string
        claim_type: string; layer: string; section: string; representation: string
        reason_codes: string[]; token_count: number; ordinal: number; evidence_ids: string[]
      }> } : await pool.query<{
        pack_id: string; item_id: string; claim_id: string; version_id: string
        claim_type: string; layer: string; section: string; representation: string
        reason_codes: string[]; token_count: number; ordinal: number; evidence_ids: string[]
      }>(`
        SELECT i.pack_id::text, i.item_id::text, i.claim_id::text, i.version_id::text,
               i.claim_type, i.layer, i.section, i.representation, i.reason_codes,
               i.token_count, i.ordinal,
               ARRAY(SELECT pe.evidence_id::text FROM memory_context_pack_evidence pe
                     WHERE pe.pack_id = i.pack_id AND pe.item_id = i.item_id
                     ORDER BY pe.evidence_id) AS evidence_ids
        FROM memory_context_pack_items i
        WHERE i.pack_id = ANY($1::uuid[])
        ORDER BY i.pack_id, i.ordinal
      `, [packIds])
      const trajectoryIds = result.rows
        .map(row => row.trajectory_id)
        .filter((value): value is string => Boolean(value))
      const candidates = trajectoryIds.length === 0 ? { rows: [] as Array<{
        trajectory_id: string; version_id: string; decision: string
        reason_code: string; final_ordinal: number | null
      }> } : await pool.query<{
        trajectory_id: string; version_id: string; decision: string
        reason_code: string; final_ordinal: number | null
      }>(`
        SELECT trajectory_id::text, version_id::text, decision, reason_code, final_ordinal
        FROM memory_retrieval_candidates
        WHERE trajectory_id = ANY($1::uuid[])
        ORDER BY trajectory_id, final_ordinal NULLS LAST, version_id
      `, [trajectoryIds])
      const itemsByPack = new Map<string, typeof items.rows>()
      for (const item of items.rows) {
        const group = itemsByPack.get(item.pack_id) ?? []
        group.push(item)
        itemsByPack.set(item.pack_id, group)
      }
      const candidatesByTrajectory = new Map<string, typeof candidates.rows>()
      for (const candidate of candidates.rows) {
        const group = candidatesByTrajectory.get(candidate.trajectory_id) ?? []
        group.push(candidate)
        candidatesByTrajectory.set(candidate.trajectory_id, group)
      }
      return result.rows.map(row => ({
        pack_id: row.pack_id,
        state: row.state,
        client_request_id: row.client_request_id,
        created_at: row.created_at,
        mode: row.mode,
        agent: row.agent,
        stable_text: row.stable_text,
        dynamic_text: row.dynamic_text,
        stable_tokens: Number(row.stable_tokens),
        dynamic_tokens: Number(row.dynamic_tokens),
        error_code: row.error_code,
        policy_revision: Number(row.policy_revision),
        settings_revision: Number(row.settings_revision),
        loadout_revision: Number(row.loadout_revision),
        items: (itemsByPack.get(row.pack_id) ?? []).map(({ pack_id: _packId, ...item }) => item),
        trajectory: row.trajectory_id && row.result_state ? {
          result_state: row.result_state,
          degraded_components: row.degraded_components ?? [],
          candidates: (candidatesByTrajectory.get(row.trajectory_id) ?? [])
            .map(({ trajectory_id: _trajectoryId, ...candidate }) => candidate),
        } : null,
      }))
    },

    /** Invalidate every not-yet-admitted dependent pack of a claim version. */
    async invalidateForVersions(input: {
      installationId: string
      versionIds: readonly string[]
    }): Promise<number> {
      const result = await pool.query(`
        UPDATE memory_context_packs p
        SET state = 'invalidated', invalidated_at = NOW(), error_code = 'source_invalidated'
        WHERE p.installation_id = $1
          AND p.state IN ('compiling','ready','shadow')
          AND EXISTS (
            SELECT 1 FROM memory_context_pack_items i
            WHERE i.pack_id = p.pack_id AND i.version_id = ANY($2::uuid[]))
          AND NOT EXISTS (
            SELECT 1 FROM memory_context_injections j
            WHERE j.pack_id = p.pack_id
              AND j.state IN ('admitted','prepared','delivered','delivery_failed'))
      `, [input.installationId, input.versionIds])
      return result.rowCount ?? 0
    },
  }
}

export type PackRepository = ReturnType<typeof createPackRepository>
