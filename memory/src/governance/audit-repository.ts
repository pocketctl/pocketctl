import { createHmac, randomUUID } from 'crypto'
import type pg from 'pg'

/**
 * ADR-0005 governance audit: append-only, content-free events. Metadata may
 * carry only bounded, non-content keys (revision numbers, reason codes,
 * resolution kinds) — claim text, evidence excerpts, emails, and grant
 * material can never enter the trail. Listing pages backwards under a signed
 * cursor bound to the installation.
 */

const METADATA_KEY_ALLOWLIST = new Set(['revision', 'reason_code', 'resolution', 'count'])
const MAX_PAGE_SIZE = 100
const MAX_PAGE_BYTES = 256 * 1024

export interface GovernanceAuditEvent {
  eventId: string
  action: string
  targetKind: string
  targetId: string | null
  previousState: string | null
  nextState: string | null
  metadata: Record<string, unknown> | null
  createdAt: Date
}

export class GovernanceAuditMetadataError extends Error {
  constructor() {
    super('governance audit metadata failed the content-free allowlist')
    this.name = 'GovernanceAuditMetadataError'
  }
}

function assertMetadataAllowlist(metadata: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(metadata)) {
    if (!METADATA_KEY_ALLOWLIST.has(key)) throw new GovernanceAuditMetadataError()
    if (typeof value === 'string' && value.length > 128) throw new GovernanceAuditMetadataError()
    if (typeof value !== 'number' && typeof value !== 'string') {
      throw new GovernanceAuditMetadataError()
    }
  }
}

export function createAuditRepository(
  pool: pg.Pool,
  options: { cursorSecret: string },
) {
  function cursorFor(installationId: string, createdAt: string, eventId: string): string {
    const payload = `${installationId}|${createdAt}|${eventId}`
    const signature = createHmac('sha256', options.cursorSecret).update(payload).digest('base64url')
    return Buffer.from(payload, 'utf8').toString('base64url') + '.' + signature
  }

  function decodeCursor(installationId: string, token: string): { createdAt: string; eventId: string } | null {
    const separator = token.lastIndexOf('.')
    if (separator <= 0) return null
    let payload: string
    try {
      payload = Buffer.from(token.slice(0, separator), 'base64url').toString('utf8')
    } catch {
      return null
    }
    const expected = createHmac('sha256', options.cursorSecret).update(payload).digest('base64url')
    if (expected !== token.slice(separator + 1)) return null
    const [scope, createdAt, eventId] = payload.split('|')
    if (scope !== installationId || !createdAt || !eventId) return null
    if (Number.isNaN(Date.parse(createdAt))) return null
    return { createdAt, eventId }
  }

  return {
    async append(input: {
      installationId: string
      actorMembershipId: string | null
      action: string
      targetKind: string
      targetId: string | null
      requestHash: string | null
      previousState: string | null
      nextState: string | null
      metadata: Record<string, unknown>
    }): Promise<void> {
      assertMetadataAllowlist(input.metadata ?? {})
      await pool.query(`
        INSERT INTO memory_governance_events
          (event_id, installation_id, actor_membership_id, action, target_kind, target_id,
           request_hash, previous_state, next_state, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
      `, [
        randomUUID(), input.installationId, input.actorMembershipId, input.action,
        input.targetKind, input.targetId, input.requestHash, input.previousState,
        input.nextState, JSON.stringify(input.metadata ?? {}),
      ])
    },

    /** Bounded backward page with a signed, installation-bound cursor. */
    async listPage(installationId: string, input: {
      limit?: number
      cursor?: string
    }): Promise<{ events: GovernanceAuditEvent[]; nextCursor: string | null }> {
      const limit = Math.min(Math.max(1, input.limit ?? 50), MAX_PAGE_SIZE)
      let after: { createdAt: string; eventId: string } | null = null
      if (input.cursor) {
        after = decodeCursor(installationId, input.cursor)
        if (!after) throw new Error('invalid audit cursor')
      }
      const result = await pool.query<{
        event_id: string
        action: string
        target_kind: string
        target_id: string | null
        previous_state: string | null
        next_state: string | null
        metadata: Record<string, unknown> | null
        created_at: Date
        cursor_created_at: string
      }>(`
        SELECT event_id, action, target_kind, target_id, previous_state, next_state, metadata, created_at,
               to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at
        FROM memory_governance_events
        WHERE installation_id = $1
          AND ($2::timestamptz IS NULL
               OR (created_at, event_id) < ($2::timestamptz, $3::uuid))
        ORDER BY created_at DESC, event_id DESC
        LIMIT $4
      `, [installationId, after?.createdAt ?? null, after?.eventId ?? null, limit + 1])

      const rows = result.rows.slice(0, limit)
      const budget = MAX_PAGE_BYTES
      let used = 0
      const events: GovernanceAuditEvent[] = []
      for (const row of rows) {
        used += JSON.stringify(row).length
        if (used > budget) break
        events.push({
          eventId: row.event_id,
          action: row.action,
          targetKind: row.target_kind,
          targetId: row.target_id,
          previousState: row.previous_state,
          nextState: row.next_state,
          metadata: row.metadata,
          createdAt: row.created_at,
        })
      }
      const hasMore = result.rows.length > limit && events.length === rows.length
      const last = events[events.length - 1]
      const lastRow = result.rows[events.length - 1]
      return {
        events,
        nextCursor: hasMore && last && lastRow
          ? cursorFor(installationId, lastRow.cursor_created_at, last.eventId)
          : null,
      }
    },
  }
}

export type AuditRepository = ReturnType<typeof createAuditRepository>
