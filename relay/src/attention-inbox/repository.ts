import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type pg from 'pg'

import type {
  AttentionActionClaim,
  AttentionActionRequest,
  AttentionItemDraft,
  AttentionItemRecord,
  AttentionProjection,
} from './types.js'

type Queryable = Pick<pg.PoolClient, 'query'>

interface ChangedRow {
  item_id: string
  user_id: number | string
  revision: number | string
}

type PoolLike = Pick<pg.Pool, 'connect' | 'query'>

interface ListCursor {
  stateRank: number
  riskRank: number
  updatedAt: string
  itemId: string
}

function signedCursor(value: ListCursor, secret: string): string {
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url')
  const signature = createHmac('sha256', secret).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

function parseCursor(raw: string, secret: string): ListCursor {
  const [payload, signature, extra] = raw.split('.')
  if (!payload || !signature || extra) throw new Error('invalid cursor')
  const expected = createHmac('sha256', secret).update(payload).digest()
  const actual = Buffer.from(signature, 'base64url')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('invalid cursor')
  const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as ListCursor
  if (!Number.isInteger(parsed.stateRank) || !Number.isInteger(parsed.riskRank)
    || !parsed.updatedAt || !parsed.itemId || Number.isNaN(Date.parse(parsed.updatedAt))) {
    throw new Error('invalid cursor')
  }
  return parsed
}

function dateValue(value: unknown): Date | null {
  if (value === null || value === undefined) return null
  return value instanceof Date ? value : new Date(String(value))
}

export function mapAttentionItemRow(row: Record<string, any>): AttentionItemRecord {
  return {
    itemId: row.item_id,
    userId: Number(row.user_id),
    daemonId: row.daemon_id,
    sessionId: row.session_id,
    requestId: row.request_id,
    provider: row.provider,
    kind: row.kind,
    state: row.state,
    revision: Number(row.revision),
    riskLevel: row.risk_level,
    classificationIncomplete: row.classification_incomplete === true,
    riskReasons: Array.isArray(row.risk_reasons) ? row.risk_reasons : [],
    title: row.title ?? '',
    summary: row.summary ?? '',
    context: row.context ?? {},
    allowedActions: row.allowed_actions ?? [],
    seenAt: dateValue(row.seen_at),
    snoozedUntil: dateValue(row.snoozed_until),
    submittedAt: dateValue(row.submitted_at),
    resolvedAt: dateValue(row.resolved_at),
    handledAt: dateValue(row.handled_at),
    expiresAt: dateValue(row.expires_at),
    resolution: row.resolution ?? null,
    lastErrorCode: row.last_error_code ?? null,
    createdAt: dateValue(row.created_at) ?? new Date(0),
    updatedAt: dateValue(row.updated_at) ?? new Date(0),
    daemonDisplayName: row.daemon_display_name ?? undefined,
    sessionTitle: row.session_title ?? undefined,
    sessionStatus: row.session_status ?? undefined,
  }
}

async function notifyChanged(client: Queryable, row: ChangedRow): Promise<void> {
  await client.query(
    `SELECT pg_notify('pocketctl_attention', json_build_object(
       'user_id', $1::int,
       'item_id', $2::text,
       'revision', $3::bigint,
       'operation', $4::text
     )::text)`,
    [Number(row.user_id), row.item_id, Number(row.revision), 'changed'],
  )
}

async function upsertRequest(client: Queryable, item: AttentionItemDraft): Promise<ChangedRow | null> {
  const result = await client.query<ChangedRow>(
    `INSERT INTO attention_items (
       item_id, user_id, daemon_id, session_id, request_id, provider, kind, state,
       risk_level, classification_incomplete, risk_reasons, title, summary, context, allowed_actions,
       source_event_id, source_event_type, source_event_key, expires_at, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, 'open',
       $8, $9, $10::jsonb, $11, $12, $13::jsonb, $14::jsonb,
       $15, $16, $17, $18, $19, NOW()
     )
     ON CONFLICT (user_id, daemon_id, session_id, request_id, kind) DO UPDATE SET
       provider = EXCLUDED.provider,
       risk_level = EXCLUDED.risk_level,
       classification_incomplete = EXCLUDED.classification_incomplete,
       risk_reasons = EXCLUDED.risk_reasons,
       title = EXCLUDED.title,
       summary = EXCLUDED.summary,
       context = EXCLUDED.context,
       allowed_actions = EXCLUDED.allowed_actions,
       source_event_id = EXCLUDED.source_event_id,
       source_event_type = EXCLUDED.source_event_type,
       source_event_key = EXCLUDED.source_event_key,
       expires_at = EXCLUDED.expires_at,
       revision = attention_items.revision + 1,
       updated_at = NOW()
     WHERE attention_items.state NOT IN ('resolved', 'expired')
       AND (
         attention_items.provider,
         attention_items.risk_level,
         attention_items.classification_incomplete,
         attention_items.risk_reasons,
         attention_items.title,
         attention_items.summary,
         attention_items.context,
         attention_items.allowed_actions,
         attention_items.source_event_type,
         attention_items.source_event_key,
         attention_items.expires_at
       ) IS DISTINCT FROM (
         EXCLUDED.provider,
         EXCLUDED.risk_level,
         EXCLUDED.classification_incomplete,
         EXCLUDED.risk_reasons,
         EXCLUDED.title,
         EXCLUDED.summary,
         EXCLUDED.context,
         EXCLUDED.allowed_actions,
         EXCLUDED.source_event_type,
         EXCLUDED.source_event_key,
         EXCLUDED.expires_at
       )
     RETURNING item_id, user_id, revision`,
    [
      randomUUID(),
      item.userId,
      item.daemonId,
      item.sessionId,
      item.requestId,
      item.provider,
      item.kind,
      item.riskLevel,
      item.classificationIncomplete,
      JSON.stringify(item.riskReasons),
      item.title,
      item.summary,
      JSON.stringify(item.context),
      JSON.stringify(item.allowedActions),
      item.sourceEventId,
      item.sourceEventType,
      item.sourceEventKey,
      item.expiresAt,
      item.createdAt,
    ],
  )
  return result.rows[0] ?? null
}

async function resolveRequest(
  client: Queryable,
  projection: Extract<AttentionProjection, { operation: 'resolve' }>,
): Promise<ChangedRow | null> {
  const { identity } = projection
  const result = await client.query<ChangedRow>(
    `UPDATE attention_items
     SET state = 'resolved',
         resolution_event_id = $6,
         resolution = $7::jsonb,
         resolved_at = NOW(),
         handled_at = NOW(),
         submitted_at = NULL,
         submission_deadline_at = NULL,
         submission_key = NULL,
         last_error_code = NULL,
         revision = revision + 1,
         updated_at = NOW()
     WHERE user_id = $1
       AND daemon_id = $2
       AND session_id = $3
       AND request_id = $4
       AND kind = $5
       AND state NOT IN ('resolved', 'expired')
     RETURNING item_id, user_id, revision`,
    [
      identity.userId,
      identity.daemonId,
      identity.sessionId,
      identity.requestId,
      identity.kind,
      projection.resolutionEventId,
      JSON.stringify(projection.resolution),
    ],
  )
  return result.rows[0] ?? null
}

export class AttentionInboxRepository {
  constructor(
    private readonly pool?: PoolLike,
    private readonly cursorSecret: string = 'attention-inbox-test-only',
  ) {}

  async applyProjection(client: Queryable, projection: AttentionProjection): Promise<void> {
    const changed = projection.operation === 'upsert'
      ? await upsertRequest(client, projection.item)
      : await resolveRequest(client, projection)
    if (changed) await notifyChanged(client, changed)
  }

  async claimAction(input: {
    userId: number
    itemId: string
    idempotencyKey: string
    requestHash: string
    request: AttentionActionRequest
  }): Promise<AttentionActionClaim> {
    if (!this.pool) throw new Error('AttentionInboxRepository pool is required for actions')
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const selected = await client.query(
        `SELECT * FROM attention_items
         WHERE item_id = $1 AND user_id = $2
         FOR UPDATE`,
        [input.itemId, input.userId],
      )
      if ((selected.rowCount ?? 0) === 0) {
        await client.query('ROLLBACK')
        return { outcome: 'not_found' }
      }
      let item = mapAttentionItemRow(selected.rows[0])
      const receipt = await client.query(
        `SELECT receipt_id, request_hash, status, response->>'error_code' AS error_code
         FROM attention_action_receipts
         WHERE user_id = $1 AND item_id = $2 AND idempotency_key = $3`,
        [input.userId, input.itemId, input.idempotencyKey],
      )
      if ((receipt.rowCount ?? 0) > 0) {
        await client.query('COMMIT')
        const existing = receipt.rows[0]
        if (existing.request_hash !== input.requestHash) {
          return { outcome: 'idempotency_key_reused', item }
        }
        if (item.state === 'resolved' || item.state === 'expired') {
          return { outcome: 'resolved_elsewhere', item }
        }
        return {
          outcome: 'idempotent', item,
          receiptId: String(existing.receipt_id), status: existing.status,
          errorCode: existing.error_code ?? undefined,
        }
      }
      if (item.provider !== 'codex' && item.provider !== 'opencode') {
        await client.query('COMMIT')
        return { outcome: 'provider_not_enabled', item }
      }
      if (item.state === 'resolved' || item.state === 'expired') {
        await client.query('COMMIT')
        return { outcome: 'resolved_elsewhere', item }
      }
      if (item.state === 'submitting') {
        await client.query('COMMIT')
        return { outcome: 'already_submitting', item }
      }
      if (item.state !== 'open' && item.state !== 'result_unknown') {
        await client.query('COMMIT')
        return { outcome: 'action_not_allowed', item }
      }
      if (item.revision !== input.request.expectedRevision) {
        await client.query('COMMIT')
        return { outcome: 'stale_revision', item }
      }
      if (!item.allowedActions.some((action) => action.id === input.request.actionId)) {
        await client.query('COMMIT')
        return { outcome: 'action_not_allowed', item }
      }

      const previousState = item.state
      const updated = await client.query(
        `UPDATE attention_items
         SET state = 'submitting', submitted_at = NOW(),
             submission_deadline_at = NOW() + INTERVAL '30 seconds',
             submission_key = $3, last_error_code = NULL,
             revision = revision + 1, updated_at = NOW()
         WHERE item_id = $1 AND user_id = $2
           AND revision = $4 AND state = $5
         RETURNING *`,
        [input.itemId, input.userId, input.idempotencyKey, input.request.expectedRevision, previousState],
      )
      if ((updated.rowCount ?? 0) === 0) {
        await client.query('ROLLBACK')
        return { outcome: 'stale_revision', item }
      }
      item = mapAttentionItemRow(updated.rows[0])
      const inserted = await client.query(
        `INSERT INTO attention_action_receipts (
           user_id, item_id, idempotency_key, action_id, request_hash, status, response
         ) VALUES ($1, $2, $3, $4, $5, 'accepted', $6::jsonb)
         RETURNING receipt_id`,
        [
          input.userId, input.itemId, input.idempotencyKey, input.request.actionId,
          input.requestHash, JSON.stringify({ previous_state: previousState }),
        ],
      )
      await notifyChanged(client, {
        item_id: item.itemId, user_id: item.userId, revision: item.revision,
      })
      await client.query('COMMIT')
      return { outcome: 'claimed', item, receiptId: String(inserted.rows[0].receipt_id) }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  async restoreSubmission(input: {
    userId: number
    itemId: string
    idempotencyKey: string
    errorCode: 'daemon_unreachable' | 'submission_failed' | 'answers_invalid' | 'observer_read_only'
  }): Promise<void> {
    if (!this.pool) throw new Error('AttentionInboxRepository pool is required for actions')
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const restored = await client.query<ChangedRow>(
        `UPDATE attention_items AS item
         SET state = CASE
               WHEN receipt.response->>'previous_state' = 'result_unknown' THEN 'result_unknown'
               ELSE 'open'
             END,
             submitted_at = NULL, submission_deadline_at = NULL, submission_key = NULL,
             last_error_code = $4, revision = item.revision + 1, updated_at = NOW()
         FROM attention_action_receipts AS receipt
         WHERE item.item_id = $1 AND item.user_id = $2
           AND item.state = 'submitting' AND item.submission_key = $3
           AND receipt.user_id = item.user_id AND receipt.item_id = item.item_id
           AND receipt.idempotency_key = $3
         RETURNING item.item_id, item.user_id, item.revision`,
        [input.itemId, input.userId, input.idempotencyKey, input.errorCode],
      )
      if (restored.rows[0]) {
        await client.query(
          `UPDATE attention_action_receipts
           SET status = 'rejected',
               response = COALESCE(response, '{}'::jsonb) || jsonb_build_object('error_code', $4::text),
               updated_at = NOW()
           WHERE user_id = $1 AND item_id = $2 AND idempotency_key = $3`,
          [input.userId, input.itemId, input.idempotencyKey, input.errorCode],
        )
        await notifyChanged(client, restored.rows[0])
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  async listItems(input: {
    userId: number
    daemonId: string | null
    states: string[]
    cursor: string | null
    limit: number
  }): Promise<{
    items: AttentionItemRecord[]
    counts: { actionable: number; open: number; snoozed: number; submitting: number; result_unknown: number }
    nextCursor: string | null
  }> {
    if (!this.pool) throw new Error('AttentionInboxRepository pool is required for reads')
    if (input.daemonId) {
      const owned = await this.pool.query(
        `SELECT 1 FROM daemons WHERE daemon_id = $1 AND user_id = $2`,
        [input.daemonId, input.userId],
      )
      if ((owned.rowCount ?? 0) === 0) throw new Error('daemon_not_found')
    }
    const cursor = input.cursor ? parseCursor(input.cursor, this.cursorSecret) : null
    const params: unknown[] = [input.userId, input.states, input.daemonId, input.limit + 1]
    let cursorClause = ''
    if (cursor) {
      params.push(cursor.stateRank, cursor.riskRank, cursor.updatedAt, cursor.itemId)
      cursorClause = `AND (
        state_rank > $5 OR
        (state_rank = $5 AND risk_rank > $6) OR
        (state_rank = $5 AND risk_rank = $6 AND updated_at < $7::timestamptz) OR
        (state_rank = $5 AND risk_rank = $6 AND updated_at = $7::timestamptz AND item_id < $8::uuid)
      )`
    }
    const rows = await this.pool.query(
      `WITH ranked AS (
         SELECT item.*,
           COALESCE(daemon.alias, daemon.hostname, item.daemon_id) AS daemon_display_name,
           COALESCE(session.title, item.summary) AS session_title,
           session.status AS session_status,
           CASE item.state
             WHEN 'open' THEN 0 WHEN 'result_unknown' THEN 0
             WHEN 'submitting' THEN 1 WHEN 'snoozed' THEN 2 ELSE 3 END AS state_rank,
           CASE item.risk_level
             WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END AS risk_rank
         FROM attention_items AS item
         LEFT JOIN daemons AS daemon ON daemon.daemon_id = item.daemon_id
         LEFT JOIN sessions AS session ON session.session_id = item.session_id
         WHERE item.user_id = $1 AND item.state = ANY($2::varchar[])
           AND ($3::varchar IS NULL OR item.daemon_id = $3)
       )
       SELECT * FROM ranked WHERE TRUE ${cursorClause}
       ORDER BY state_rank ASC, risk_rank ASC, updated_at DESC, item_id DESC
       LIMIT $4`,
      params,
    )
    const countResult = await this.pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE state IN ('open', 'result_unknown') AND jsonb_array_length(allowed_actions) > 0)::int AS actionable,
         COUNT(*) FILTER (WHERE state = 'open')::int AS open,
         COUNT(*) FILTER (WHERE state = 'snoozed')::int AS snoozed,
         COUNT(*) FILTER (WHERE state = 'submitting')::int AS submitting,
         COUNT(*) FILTER (WHERE state = 'result_unknown')::int AS result_unknown
       FROM attention_items
       WHERE user_id = $1 AND ($2::varchar IS NULL OR daemon_id = $2)`,
      [input.userId, input.daemonId],
    )
    const hasMore = rows.rows.length > input.limit
    const pageRows = rows.rows.slice(0, input.limit)
    const last = pageRows.at(-1)
    return {
      items: pageRows.map(mapAttentionItemRow),
      counts: {
        actionable: Number(countResult.rows[0]?.actionable ?? 0),
        open: Number(countResult.rows[0]?.open ?? 0),
        snoozed: Number(countResult.rows[0]?.snoozed ?? 0),
        submitting: Number(countResult.rows[0]?.submitting ?? 0),
        result_unknown: Number(countResult.rows[0]?.result_unknown ?? 0),
      },
      nextCursor: hasMore && last ? signedCursor({
        stateRank: Number(last.state_rank), riskRank: Number(last.risk_rank),
        updatedAt: (dateValue(last.updated_at) ?? new Date(0)).toISOString(), itemId: last.item_id,
      }, this.cursorSecret) : null,
    }
  }

  async getItem(userId: number, itemId: string, revision?: number): Promise<AttentionItemRecord | null> {
    if (!this.pool) throw new Error('AttentionInboxRepository pool is required for reads')
    const result = await this.pool.query(
      `SELECT item.*,
         COALESCE(daemon.alias, daemon.hostname, item.daemon_id) AS daemon_display_name,
         COALESCE(session.title, item.summary) AS session_title,
         session.status AS session_status
       FROM attention_items AS item
       LEFT JOIN daemons AS daemon ON daemon.daemon_id = item.daemon_id
       LEFT JOIN sessions AS session ON session.session_id = item.session_id
       WHERE item.user_id = $1 AND item.item_id = $2
         AND ($3::bigint IS NULL OR item.revision >= $3)`,
      [userId, itemId, revision ?? null],
    )
    return result.rows[0] ? mapAttentionItemRow(result.rows[0]) : null
  }

  async mutateMetadata(input: {
    userId: number
    itemId: string
    expectedRevision: number
    operation: 'mark_seen' | 'snooze' | 'restore'
    snoozedUntil: string | null
  }): Promise<{ outcome: 'updated'; item: AttentionItemRecord } | { outcome: 'not_found' } | { outcome: 'stale_revision'; item: AttentionItemRecord } | { outcome: 'invalid' }> {
    if (!this.pool) throw new Error('AttentionInboxRepository pool is required for metadata')
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const selected = await client.query(
        `SELECT * FROM attention_items WHERE item_id = $1 AND user_id = $2 FOR UPDATE`,
        [input.itemId, input.userId],
      )
      if ((selected.rowCount ?? 0) === 0) {
        await client.query('ROLLBACK')
        return { outcome: 'not_found' }
      }
      const current = mapAttentionItemRow(selected.rows[0])
      if (current.revision !== input.expectedRevision) {
        await client.query('COMMIT')
        return { outcome: 'stale_revision', item: current }
      }
      let sql: string
      let params: unknown[] = [input.itemId, input.userId]
      if (input.operation === 'mark_seen') {
        if (current.seenAt) {
          await client.query('COMMIT')
          return { outcome: 'updated', item: current }
        }
        sql = `UPDATE attention_items SET seen_at = NOW(), revision = revision + 1, updated_at = NOW()
               WHERE item_id = $1 AND user_id = $2 RETURNING *`
      } else if (input.operation === 'snooze') {
        const value = input.snoozedUntil ? new Date(input.snoozedUntil) : null
        const delay = value ? value.getTime() - Date.now() : 0
        if (current.state !== 'open' || !value || Number.isNaN(value.getTime())
          || delay < 5 * 60_000 || delay > 7 * 24 * 60 * 60_000) {
          await client.query('COMMIT')
          return { outcome: 'invalid' }
        }
        sql = `UPDATE attention_items SET state = 'snoozed', snoozed_until = $3,
                 revision = revision + 1, updated_at = NOW()
               WHERE item_id = $1 AND user_id = $2 RETURNING *`
        params = [input.itemId, input.userId, value]
      } else {
        if (current.state !== 'snoozed') {
          await client.query('COMMIT')
          return { outcome: 'invalid' }
        }
        sql = `UPDATE attention_items SET state = 'open', snoozed_until = NULL,
                 revision = revision + 1, updated_at = NOW()
               WHERE item_id = $1 AND user_id = $2 RETURNING *`
      }
      const changed = await client.query(sql, params)
      const item = mapAttentionItemRow(changed.rows[0])
      await notifyChanged(client, { item_id: item.itemId, user_id: item.userId, revision: item.revision })
      await client.query('COMMIT')
      return { outcome: 'updated', item }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  async runMaintenance(): Promise<number> {
    if (!this.pool) throw new Error('AttentionInboxRepository pool is required for maintenance')
    const result = await this.pool.query<ChangedRow>(
      `WITH candidates AS (
         SELECT item_id
         FROM attention_items
         WHERE (state = 'snoozed' AND snoozed_until <= NOW())
            OR (state = 'submitting' AND submission_deadline_at <= NOW())
            OR (state IN ('open', 'snoozed', 'result_unknown') AND expires_at <= NOW())
         ORDER BY COALESCE(submission_deadline_at, snoozed_until, expires_at), item_id
         LIMIT 100
         FOR UPDATE SKIP LOCKED
       ), changed AS (
         UPDATE attention_items AS item SET
           state = CASE
             WHEN item.state IN ('open', 'snoozed', 'result_unknown') AND item.expires_at <= NOW() THEN 'expired'
             WHEN item.state = 'submitting' AND item.submission_deadline_at <= NOW() THEN 'result_unknown'
             WHEN item.state = 'snoozed' AND item.snoozed_until <= NOW() THEN 'open'
             ELSE item.state END,
           snoozed_until = CASE WHEN item.state = 'snoozed' AND item.snoozed_until <= NOW() THEN NULL ELSE item.snoozed_until END,
           handled_at = CASE WHEN item.state IN ('open', 'snoozed', 'result_unknown') AND item.expires_at <= NOW() THEN NOW() ELSE item.handled_at END,
           last_error_code = CASE WHEN item.state = 'submitting' AND item.submission_deadline_at <= NOW() THEN 'result_unknown' ELSE item.last_error_code END,
           revision = item.revision + 1, updated_at = NOW()
         FROM candidates
         WHERE item.item_id = candidates.item_id
         RETURNING item.item_id, item.user_id, item.revision, item.submission_key, item.state
       ), receipts AS (
         UPDATE attention_action_receipts AS receipt
         SET status = 'result_unknown', updated_at = NOW()
         FROM changed
         WHERE changed.state = 'result_unknown'
           AND changed.submission_key IS NOT NULL
           AND receipt.user_id = changed.user_id
           AND receipt.item_id = changed.item_id
           AND receipt.idempotency_key = changed.submission_key
         RETURNING receipt.receipt_id
       )
       SELECT item_id, user_id, revision,
         pg_notify('pocketctl_attention', json_build_object(
           'user_id', user_id, 'item_id', item_id, 'revision', revision, 'operation', 'changed'
         )::text)
       FROM changed`,
    )
    const removed = await this.pool.query(
      `WITH candidates AS (
         SELECT item_id FROM attention_items
         WHERE state IN ('resolved', 'expired')
           AND handled_at < NOW() - INTERVAL '30 days'
         ORDER BY handled_at ASC, item_id ASC
         LIMIT 500
         FOR UPDATE SKIP LOCKED
       ), deleted AS (
         DELETE FROM attention_items AS item
         USING candidates
         WHERE item.item_id = candidates.item_id
         RETURNING item.item_id, item.user_id, item.revision
       )
       SELECT item_id, user_id, revision,
         pg_notify('pocketctl_attention', json_build_object(
           'user_id', user_id, 'item_id', item_id, 'revision', revision, 'operation', 'removed'
         )::text)
       FROM deleted`,
    )
    return result.rows.length + removed.rows.length
  }
}
