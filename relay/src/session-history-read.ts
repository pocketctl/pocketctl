import { createHmac, timingSafeEqual } from 'node:crypto'
import type pg from 'pg'

const DEFAULT_PAGE_MAX_BYTES = 256 * 1024
const FETCH_BATCH_SIZE = 256
const MAX_CURSOR_BYTES = 4096
const MAX_REQUEST_ID_BYTES = 128
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/
const REQUEST_KEYS = new Set([
  'type', 'request_id', 'source_session_id', 'target_session_id', 'cursor',
])

export interface SessionHistoryReadIdentity {
  userId: number | null
  daemonId: string
}

export interface SessionHistoryReadInput {
  sourceSessionId: string
  targetSessionId: string
  cursor?: string
}

export interface SessionHistoryMessage {
  event_id: string
  created_at: string
  role: 'user' | 'assistant' | 'tool'
  kind?: 'call' | 'result'
  content?: string
  tool?: string
  call_id?: string
  chunk_index?: number
  chunk_count?: number
}

export interface SessionHistoryReadResult {
  type: 'session_history_read_result'
  source_session_id: string
  target_session_id: string
  messages: SessionHistoryMessage[]
  has_more: boolean
  next_cursor?: string
  large_session: boolean
  snapshot_through_event_id: string
  synced_through_at: string | null
  possibly_incomplete: boolean
  untrusted_content: true
}

export type SessionHistoryReadErrorCode =
  | 'unauthenticated'
  | 'invalid_request'
  | 'invalid_cursor'
  | 'not_found_or_not_owned'
  | 'internal_error'

export interface SessionHistoryReadError {
  type: 'session_history_read_error'
  code: SessionHistoryReadErrorCode
}

export type SessionHistoryReadResponse = SessionHistoryReadResult | SessionHistoryReadError

interface CursorPayload {
  v: 1
  source: string
  target: string
  after: string
  snapshot: string
  chunkEvent?: string
  chunkOffset?: number
  chunkIndex?: number
}

interface AuthorizedSnapshotRow {
  snapshot_max_event_id: string | number | null
  synced_through_at: Date | string | null
  target_status?: string | null
}

interface EventRow {
  id: string | number
  event_type: string
  payload: Record<string, unknown>
  created_at: Date | string
}

export interface SessionHistoryReadBrokerOptions {
  pool: pg.Pool
  cursorSecret: string
  pageMaxBytes?: number
}

function boundedText(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, '[REDACTED_CREDENTIAL]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_CREDENTIAL]')
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, '[REDACTED_CREDENTIAL]')
    .replace(/\b(api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED_CREDENTIAL]')
}

function normalizedEvent(row: EventRow): SessionHistoryMessage | null {
  const payload = row.payload && typeof row.payload === 'object' ? row.payload : {}
  const eventID = String(row.id)
  const createdAt = row.created_at instanceof Date
    ? row.created_at.toISOString()
    : String(row.created_at)
  if (row.event_type === 'user_text' || row.event_type === 'user_message') {
    const content = boundedText(payload.snapshot ?? payload.text ?? payload.content)
    return content ? { event_id: eventID, created_at: createdAt, role: 'user', content } : null
  }
  if (row.event_type === 'agent_text') {
    const content = boundedText(payload.snapshot ?? payload.text)
    return content ? { event_id: eventID, created_at: createdAt, role: 'assistant', content } : null
  }
  if (row.event_type === 'tool_call') {
    const tool = typeof payload.tool === 'string' ? payload.tool.slice(0, 256) : 'tool'
    const callID = typeof payload.call_id === 'string' ? payload.call_id.slice(0, 256) : undefined
    return {
      event_id: eventID, created_at: createdAt, role: 'tool', kind: 'call', tool,
      ...(callID ? { call_id: callID } : {}),
    }
  }
  if (row.event_type === 'tool_result') {
    const content = boundedText(payload.output ?? payload.error)
    const tool = typeof payload.tool === 'string' ? payload.tool.slice(0, 256) : 'tool'
    const callID = typeof payload.call_id === 'string' ? payload.call_id.slice(0, 256) : undefined
    return {
      event_id: eventID, created_at: createdAt, role: 'tool', kind: 'result', tool,
      ...(content ? { content } : {}),
      ...(callID ? { call_id: callID } : {}),
    }
  }
  return null
}

function encodedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function sliceUTF8(input: string, start: number, maxBytes: number): { text: string; next: number } {
  let used = 0
  let offset = start
  let text = ''
  for (const char of input.slice(start)) {
    const bytes = Buffer.byteLength(char, 'utf8')
    if (text && used + bytes > maxBytes) break
    if (!text && bytes > maxBytes) break
    text += char
    used += bytes
    offset += char.length
  }
  return { text, next: offset }
}

function cursorSignature(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

function encodeCursor(secret: string, cursor: CursorPayload): string {
  const payload = Buffer.from(JSON.stringify(cursor)).toString('base64url')
  return `${payload}.${cursorSignature(secret, payload)}`
}

function decodeCursor(secret: string, raw: string): CursorPayload | null {
  if (!raw || Buffer.byteLength(raw, 'utf8') > MAX_CURSOR_BYTES) return null
  const separator = raw.lastIndexOf('.')
  if (separator <= 0) return null
  const payload = raw.slice(0, separator)
  const signature = raw.slice(separator + 1)
  const expected = cursorSignature(secret, payload)
  const actualBytes = Buffer.from(signature)
  const expectedBytes = Buffer.from(expected)
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) return null
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as CursorPayload
    if (parsed.v !== 1
      || !SESSION_ID_PATTERN.test(parsed.source)
      || !SESSION_ID_PATTERN.test(parsed.target)
      || !/^\d+$/.test(parsed.after)
      || !/^\d+$/.test(parsed.snapshot)
      || (parsed.chunkEvent !== undefined && !/^\d+$/.test(parsed.chunkEvent))
      || (parsed.chunkOffset !== undefined && (!Number.isSafeInteger(parsed.chunkOffset) || parsed.chunkOffset < 0))
      || (parsed.chunkIndex !== undefined && (!Number.isSafeInteger(parsed.chunkIndex) || parsed.chunkIndex < 0))) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

function isTerminalStatus(status: string | null | undefined): boolean {
  return status === 'exited' || status === 'completed' || status === 'failed' || status === 'stopped'
}

export function createSessionHistoryReadBroker(options: SessionHistoryReadBrokerOptions) {
  const pageMaxBytes = Math.max(256, Math.min(options.pageMaxBytes ?? DEFAULT_PAGE_MAX_BYTES, DEFAULT_PAGE_MAX_BYTES))
  if (!options.cursorSecret) throw new Error('session history cursor secret is required')

  async function audit(input: {
    identity: SessionHistoryReadIdentity
    request: SessionHistoryReadInput
    outcome: string
    snapshot?: string
    messageCount?: number
    responseBytes?: number
  }): Promise<void> {
    try {
      await options.pool.query(`
        INSERT INTO session_history_read_audit
          (user_id, daemon_id, source_session_id, target_session_id, outcome,
           snapshot_max_event_id, message_count, response_bytes)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [
        input.identity.userId, input.identity.daemonId,
        input.request.sourceSessionId, input.request.targetSessionId, input.outcome,
        input.snapshot ?? null, input.messageCount ?? 0, input.responseBytes ?? 0,
      ])
    } catch {
      // Audit is best effort and deliberately contains no transcript content.
    }
  }

  return {
    async read(identity: SessionHistoryReadIdentity, request: SessionHistoryReadInput): Promise<SessionHistoryReadResponse> {
      if (!Number.isInteger(identity.userId) || Number(identity.userId) <= 0 || !identity.daemonId) {
        return { type: 'session_history_read_error', code: 'unauthenticated' }
      }
      if (!SESSION_ID_PATTERN.test(request.sourceSessionId)
        || !SESSION_ID_PATTERN.test(request.targetSessionId)) {
        return { type: 'session_history_read_error', code: 'invalid_request' }
      }

      let cursor: CursorPayload | undefined
      if (request.cursor) {
        cursor = decodeCursor(options.cursorSecret, request.cursor) ?? undefined
        if (!cursor || cursor.source !== request.sourceSessionId || cursor.target !== request.targetSessionId) {
          return { type: 'session_history_read_error', code: 'invalid_cursor' }
        }
      }

      const authorized = await options.pool.query<AuthorizedSnapshotRow>(`
        WITH authorized AS (
          SELECT target.session_id, target.status
          FROM sessions AS source
          JOIN sessions AS target ON target.session_id = $3
          WHERE source.session_id = $2
            AND source.user_id = $1
            AND source.daemon_id = $4
            AND target.user_id = $1
        )
        SELECT
          COALESCE((SELECT MAX(event.id) FROM events AS event
                    JOIN authorized ON authorized.session_id = event.session_id), 0)::text
            AS snapshot_max_event_id,
          (SELECT MAX(event.created_at) FROM events AS event
           JOIN authorized ON authorized.session_id = event.session_id) AS synced_through_at,
          authorized.status AS target_status
        FROM authorized
      `, [identity.userId, request.sourceSessionId, request.targetSessionId, identity.daemonId])
      if (authorized.rows.length !== 1) {
        await audit({ identity, request, outcome: 'denied' })
        return { type: 'session_history_read_error', code: 'not_found_or_not_owned' }
      }

      const authorization = authorized.rows[0]
      const currentSnapshot = String(authorization.snapshot_max_event_id ?? '0')
      const snapshot = cursor?.snapshot ?? currentSnapshot
      if (BigInt(snapshot) > BigInt(currentSnapshot)) {
        return { type: 'session_history_read_error', code: 'invalid_cursor' }
      }
      let after = cursor?.after ?? '0'
      let chunkEvent = cursor?.chunkEvent
      let chunkOffset = cursor?.chunkOffset ?? 0
      let chunkIndex = cursor?.chunkIndex ?? 0
      const messages: SessionHistoryMessage[] = []
      let messageBytes = 2
      let exhausted = false
      let nextCursor: CursorPayload | undefined

      while (!exhausted && !nextCursor) {
        const rows = await options.pool.query<EventRow>(`
          SELECT id::text, event_type, payload, created_at
          FROM events
          WHERE session_id = $1 AND id > $2::bigint AND id <= $3::bigint
          ORDER BY id ASC
          LIMIT $4
        `, [request.targetSessionId, after, snapshot, FETCH_BATCH_SIZE])
        if (rows.rows.length === 0) {
          exhausted = true
          break
        }

        for (const row of rows.rows) {
          const eventID = String(row.id)
          if (chunkEvent && eventID !== chunkEvent) {
            return { type: 'session_history_read_error', code: 'invalid_cursor' }
          }
          const normalized = normalizedEvent(row)
          if (!normalized) {
            after = eventID
            continue
          }

          const candidate = chunkEvent && normalized.content
            ? { ...normalized, content: normalized.content.slice(chunkOffset), chunk_index: chunkIndex }
            : normalized
          const candidateBytes = encodedBytes(candidate) + (messages.length > 0 ? 1 : 0)
          if (messageBytes + candidateBytes <= pageMaxBytes) {
            messages.push(candidate)
            messageBytes += candidateBytes
            after = eventID
            chunkEvent = undefined
            chunkOffset = 0
            chunkIndex = 0
            continue
          }

          if (messages.length > 0) {
            nextCursor = { v: 1, source: request.sourceSessionId, target: request.targetSessionId, after, snapshot }
            break
          }

          if (!normalized.content) {
            // Metadata-only tool entries are bounded at construction time. This
            // is defensive for unusually small test/operator page settings.
            messages.push(normalized)
            after = eventID
            continue
          }
          const fixed = { ...normalized, content: '', chunk_index: chunkIndex, chunk_count: undefined }
          const available = Math.max(1, pageMaxBytes - encodedBytes(fixed) - 16)
          const sliced = sliceUTF8(normalized.content, chunkOffset, available)
          const chunkMessage: SessionHistoryMessage = {
            ...normalized, content: sliced.text,
            chunk_index: chunkIndex,
          }
          messages.push(chunkMessage)
          messageBytes += encodedBytes(chunkMessage)
          if (sliced.next < normalized.content.length) {
            nextCursor = {
              v: 1, source: request.sourceSessionId, target: request.targetSessionId,
              after, snapshot, chunkEvent: eventID, chunkOffset: sliced.next,
              chunkIndex: chunkIndex + 1,
            }
          } else {
            after = eventID
            chunkEvent = undefined
            chunkOffset = 0
            chunkIndex = 0
          }
          break
        }

        if (!nextCursor && rows.rows.length < FETCH_BATCH_SIZE) exhausted = true
      }

      if (!nextCursor && BigInt(after) < BigInt(snapshot)) {
        // Remaining rows may all be hidden event types. Probe through them on
        // this request so has_more describes visible transcript content only.
        const probe = await options.pool.query<EventRow>(`
          SELECT id::text, event_type, payload, created_at
          FROM events
          WHERE session_id = $1 AND id > $2::bigint AND id <= $3::bigint
          ORDER BY id ASC
          LIMIT $4
        `, [request.targetSessionId, after, snapshot, FETCH_BATCH_SIZE])
        const visible = probe.rows.find((row) => normalizedEvent(row) !== null)
        if (visible) {
          nextCursor = { v: 1, source: request.sourceSessionId, target: request.targetSessionId, after, snapshot }
        }
      }

      const syncedThroughAt = authorization.synced_through_at instanceof Date
        ? authorization.synced_through_at.toISOString()
        : authorization.synced_through_at ? String(authorization.synced_through_at) : null
      const result: SessionHistoryReadResult = {
        type: 'session_history_read_result',
        source_session_id: request.sourceSessionId,
        target_session_id: request.targetSessionId,
        messages,
        has_more: Boolean(nextCursor),
        ...(nextCursor ? { next_cursor: encodeCursor(options.cursorSecret, nextCursor) } : {}),
        large_session: Boolean(request.cursor || nextCursor),
        snapshot_through_event_id: snapshot,
        synced_through_at: syncedThroughAt,
        possibly_incomplete: authorization.target_status !== undefined
          && !isTerminalStatus(authorization.target_status),
        untrusted_content: true,
      }
      await audit({
        identity, request, outcome: 'allowed', snapshot,
        messageCount: messages.length, responseBytes: encodedBytes(result),
      })
      return result
    },
  }
}

export type SessionHistoryReadBroker = ReturnType<typeof createSessionHistoryReadBroker>

export async function handleSessionHistoryReadMessage(
  broker: SessionHistoryReadBroker,
  identity: SessionHistoryReadIdentity,
  raw: unknown,
  send: (payload: string) => void,
): Promise<void> {
  const object = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : null
  const requestID = object && typeof object.request_id === 'string'
    ? object.request_id.slice(0, MAX_REQUEST_ID_BYTES)
    : undefined
  const respond = (response: SessionHistoryReadResponse) => send(JSON.stringify({
    ...response,
    ...(requestID ? { request_id: requestID } : {}),
  }))
  if (!object || object.type !== 'session_history_read'
    || Object.keys(object).some((key) => !REQUEST_KEYS.has(key))
    || typeof object.source_session_id !== 'string'
    || typeof object.target_session_id !== 'string'
    || (object.cursor !== undefined && typeof object.cursor !== 'string')) {
    respond({ type: 'session_history_read_error', code: 'invalid_request' })
    return
  }
  try {
    respond(await broker.read(identity, {
      sourceSessionId: object.source_session_id,
      targetSessionId: object.target_session_id,
      ...(typeof object.cursor === 'string' ? { cursor: object.cursor } : {}),
    }))
  } catch {
    respond({ type: 'session_history_read_error', code: 'internal_error' })
  }
}
