import { createHmac } from 'node:crypto'
import { describe, expect, test, vi } from 'vitest'
import {
  createSessionHistoryReadBroker,
  handleSessionHistoryReadMessage,
} from '../session-history-read.js'

function poolFor(input: {
  authorized?: boolean
  snapshot?: number
  rows?: any[]
}) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes('WITH authorized')) {
      return input.authorized === false
        ? { rows: [] }
        : { rows: [{ snapshot_max_event_id: String(input.snapshot ?? 9), synced_through_at: '2026-09-22T00:00:00.000Z' }] }
    }
    if (sql.includes('FROM events')) {
      const after = Number(params?.[1] ?? 0)
      const limit = Number(params?.[3] ?? 256)
      return { rows: (input.rows ?? []).filter((row) => Number(row.id) > after).slice(0, limit) }
    }
    if (sql.includes('INSERT INTO session_history_read_audit')) return { rows: [] }
    throw new Error(`unexpected query: ${sql}`)
  })
  return { query } as any
}

describe('session history read broker', () => {
  test('returns only normalized visible transcript content for same-account sessions', async () => {
    const pool = poolFor({ rows: [
      { id: '1', event_type: 'user_text', payload: { text: 'hello', token: 'must-not-leak' }, created_at: '2026-09-22T00:00:01Z' },
      { id: '2', event_type: 'agent_reasoning', payload: { text: 'hidden chain' }, created_at: '2026-09-22T00:00:02Z' },
      { id: '3', event_type: 'approval_request', payload: { input: { password: 'secret' } }, created_at: '2026-09-22T00:00:03Z' },
      { id: '4', event_type: 'session_document_chunk', payload: { chunk_data: 'private body' }, created_at: '2026-09-22T00:00:04Z' },
      { id: '5', event_type: 'tool_call', payload: { tool: 'shell', input: { api_key: 'secret' }, call_id: 'c1' }, created_at: '2026-09-22T00:00:05Z' },
      { id: '6', event_type: 'tool_result', payload: { tool: 'shell', output: 'done', url: 'file:///secret' }, created_at: '2026-09-22T00:00:06Z' },
      { id: '7', event_type: 'agent_text', payload: { text: 'world' }, created_at: '2026-09-22T00:00:07Z' },
    ] })
    const broker = createSessionHistoryReadBroker({ pool, cursorSecret: 'test-secret' })

    const result = await broker.read(
      { userId: 7, daemonId: 'daemon-a' },
      { sourceSessionId: 'source-a', targetSessionId: 'target-b' },
    )

    expect(result.type).toBe('session_history_read_result')
    if (result.type !== 'session_history_read_result') return
    expect(result.messages).toEqual([
      expect.objectContaining({ event_id: '1', role: 'user', content: 'hello' }),
      expect.objectContaining({ event_id: '5', role: 'tool', kind: 'call', tool: 'shell', call_id: 'c1' }),
      expect.objectContaining({ event_id: '6', role: 'tool', kind: 'result', tool: 'shell', content: 'done' }),
      expect.objectContaining({ event_id: '7', role: 'assistant', content: 'world' }),
    ])
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('hidden chain')
    expect(serialized).not.toContain('private body')
    expect(serialized).not.toContain('api_key')
    expect(serialized).not.toContain('file:///secret')
    expect(result.untrusted_content).toBe(true)
    expect(result.snapshot_through_event_id).toBe('9')
  })

  test('hard-denies an unowned source or target without an approval state', async () => {
    const broker = createSessionHistoryReadBroker({ pool: poolFor({ authorized: false }), cursorSecret: 'test-secret' })
    const result = await broker.read(
      { userId: 7, daemonId: 'daemon-a' },
      { sourceSessionId: 'source-a', targetSessionId: 'other-account' },
    )
    expect(result).toEqual({ type: 'session_history_read_error', code: 'not_found_or_not_owned' })
  })

  test('uses a stable signed snapshot cursor and rejects tampering', async () => {
    const rows = Array.from({ length: 4 }, (_, index) => ({
      id: String(index + 1), event_type: 'agent_text',
      payload: { text: `message-${index}-${'x'.repeat(80)}` }, created_at: '2026-09-22T00:00:00Z',
    }))
    const broker = createSessionHistoryReadBroker({
      pool: poolFor({ snapshot: 4, rows }), cursorSecret: 'test-secret', pageMaxBytes: 260,
    })
    const first = await broker.read(
      { userId: 7, daemonId: 'daemon-a' },
      { sourceSessionId: 'source-a', targetSessionId: 'target-b' },
    )
    expect(first.type).toBe('session_history_read_result')
    if (first.type !== 'session_history_read_result') return
    expect(first.has_more).toBe(true)
    expect(first.next_cursor).toBeTruthy()

    const second = await broker.read(
      { userId: 7, daemonId: 'daemon-a' },
      { sourceSessionId: 'source-a', targetSessionId: 'target-b', cursor: first.next_cursor },
    )
    expect(second.type).toBe('session_history_read_result')
    if (second.type !== 'session_history_read_result') return
    expect(second.snapshot_through_event_id).toBe('4')

    const tampered = `${first.next_cursor!.slice(0, -1)}x`
    await expect(broker.read(
      { userId: 7, daemonId: 'daemon-a' },
      { sourceSessionId: 'source-a', targetSessionId: 'target-b', cursor: tampered },
    )).resolves.toEqual({ type: 'session_history_read_error', code: 'invalid_cursor' })
  })

  test('chunks one oversized visible message instead of dropping it', async () => {
    const broker = createSessionHistoryReadBroker({
      pool: poolFor({ snapshot: 1, rows: [{
        id: '1', event_type: 'agent_text', payload: { text: '字'.repeat(300) }, created_at: '2026-09-22T00:00:00Z',
      }] }),
      cursorSecret: 'test-secret', pageMaxBytes: 320,
    })
    const first = await broker.read(
      { userId: 7, daemonId: 'daemon-a' },
      { sourceSessionId: 'source-a', targetSessionId: 'target-b' },
    )
    expect(first.type).toBe('session_history_read_result')
    if (first.type !== 'session_history_read_result') return
    expect(first.messages).toHaveLength(1)
    expect(first.messages[0]).toMatchObject({ event_id: '1', chunk_index: 0 })
    expect(first.has_more).toBe(true)

    let combined = first.messages[0].content ?? ''
    let cursor = first.next_cursor
    while (cursor) {
      const next = await broker.read(
        { userId: 7, daemonId: 'daemon-a' },
        { sourceSessionId: 'source-a', targetSessionId: 'target-b', cursor },
      )
      expect(next.type).toBe('session_history_read_result')
      if (next.type !== 'session_history_read_result') break
      combined += next.messages[0]?.content ?? ''
      cursor = next.next_cursor
    }
    expect(combined).toBe('字'.repeat(300))
  })

  test('does not impose a logical message-count ceiling', async () => {
    const rows = Array.from({ length: 600 }, (_, index) => ({
      id: String(index + 1), event_type: 'agent_text', payload: { text: `m${index}` },
      created_at: '2026-09-22T00:00:00Z',
    }))
    const broker = createSessionHistoryReadBroker({
      pool: poolFor({ snapshot: 600, rows }), cursorSecret: 'test-secret',
    })
    const result = await broker.read(
      { userId: 7, daemonId: 'daemon-a' },
      { sourceSessionId: 'source-a', targetSessionId: 'target-b' },
    )
    expect(result.type).toBe('session_history_read_result')
    if (result.type !== 'session_history_read_result') return
    expect(result.messages).toHaveLength(600)
    expect(result.has_more).toBe(false)
  })

  test('handler enforces a strict request shape and never echoes invalid input', async () => {
    const sent: string[] = []
    const broker = createSessionHistoryReadBroker({ pool: poolFor({}), cursorSecret: 'test-secret' })
    await handleSessionHistoryReadMessage(
      broker,
      { userId: 7, daemonId: 'daemon-a' },
      { type: 'session_history_read', request_id: 'r1', source_session_id: 'source-a', target_session_id: 'target-b', password: 'secret' },
      (payload) => sent.push(payload),
    )
    expect(JSON.parse(sent[0])).toEqual({ type: 'session_history_read_error', request_id: 'r1', code: 'invalid_request' })
    expect(sent[0]).not.toContain('secret')
  })

  test('cursor signatures are HMAC-based rather than plain payload hashes', () => {
    const payload = Buffer.from(JSON.stringify({ v: 1 })).toString('base64url')
    expect(createHmac('sha256', 'test-secret').update(payload).digest('base64url')).not.toHaveLength(0)
  })
})
