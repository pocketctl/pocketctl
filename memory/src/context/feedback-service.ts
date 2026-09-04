import { randomUUID } from 'crypto'
import type pg from 'pg'

/**
 * Bounded, non-authoritative context feedback (plan 10.4/12.1): a narrowly
 * scoped telemetry write only. It can never modify settings, policies,
 * loadouts, claims, versions, candidates or evidence — and `harmful` only
 * opens a user-visible review signal.
 */
export function createFeedbackService(deps: { pool: pg.Pool }) {
  return {
    async submit(input: {
      installationId: string
      injectionId?: string | null
      packId?: string | null
      itemId?: string | null
      actor: 'user' | 'agent'
      action: 'used' | 'ignored' | 'incorrect' | 'harmful'
      reasonCode?: string | null
    }): Promise<{ ok: true; feedbackId: string } | {
      ok: false
      error: 'target_required' | 'target_not_visible'
    }> {
      if (!input.injectionId && !input.packId) return { ok: false, error: 'target_required' }

      // Validate the supplied identifiers as one relationship. Independently
      // visible injection/pack/item rows must never be cross-linked.
      const target = await deps.pool.query<{ visible: boolean }>(`
        SELECT EXISTS (
          SELECT 1 FROM memory_context_packs p
          WHERE p.installation_id = $1
            AND ($2::uuid IS NULL OR p.pack_id = $2)
            AND ($3::uuid IS NULL OR EXISTS (
              SELECT 1 FROM memory_context_injections j
              WHERE j.injection_id = $3 AND j.installation_id = p.installation_id
                AND j.pack_id = p.pack_id))
            AND ($4::uuid IS NULL OR EXISTS (
              SELECT 1 FROM memory_context_pack_items i
              WHERE i.item_id = $4 AND i.installation_id = p.installation_id
                AND i.pack_id = p.pack_id))
        ) AS visible
      `, [input.installationId, input.packId ?? null, input.injectionId ?? null, input.itemId ?? null])
      if (!target.rows[0]?.visible) return { ok: false, error: 'target_not_visible' }

      const feedbackId = randomUUID()
      await deps.pool.query(`
        INSERT INTO memory_context_feedback
          (feedback_id, installation_id, injection_id, pack_id, item_id, actor, action, reason_code)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [feedbackId, input.installationId, input.injectionId ?? null,
        input.packId ?? null, input.itemId ?? null, input.actor, input.action,
        input.reasonCode ? input.reasonCode.slice(0, 64) : null])
      return { ok: true, feedbackId }
    },

    async aggregate(input: { installationId: string }): Promise<Record<string, number>> {
      const result = await deps.pool.query<{ action: string; n: string }>(`
        SELECT action, COUNT(*)::text AS n FROM memory_context_feedback
        WHERE installation_id = $1 GROUP BY action
      `, [input.installationId])
      return Object.fromEntries(result.rows.map(row => [row.action, Number(row.n)]))
    },
  }
}

export type FeedbackService = ReturnType<typeof createFeedbackService>
