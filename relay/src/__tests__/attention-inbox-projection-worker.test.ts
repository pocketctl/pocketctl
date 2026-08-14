import { describe, expect, test, vi } from 'vitest'

import { createAttentionProjectionWorker } from '../attention-inbox/projection-worker.js'

function eventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 6,
    event_type: 'approval_request',
    session_id: 'session-1',
    payload: {
      type: 'approval_request', session_id: 'session-1', request_id: 'request-1',
      available_decisions: ['accept', 'decline'],
    },
    created_at: new Date('2026-08-11T00:00:00.000Z'),
    user_id: 7,
    daemon_id: 'daemon-1',
    agent_type: 'codex',
    control_mode: 'managed',
    capabilities: ['terminal_coapproval'],
    session_title: 'Release',
    session_status: 'waiting_approval',
    daemon_alias: 'Studio',
    daemon_hostname: 'host.local',
    ...overrides,
  }
}

function fixture(options: { rows?: any[]; applyError?: Error } = {}) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 }
    if (sql.includes('FROM attention_projection_cursor') && sql.includes('FOR UPDATE')) {
      return { rows: [{ last_event_id: '5' }], rowCount: 1 }
    }
    if (sql.includes('FROM events event')) return { rows: options.rows ?? [eventRow()], rowCount: 1 }
    if (sql.includes('UPDATE attention_projection_cursor')) return { rows: [], rowCount: 1 }
    throw new Error(`unexpected query: ${sql} ${JSON.stringify(params)}`)
  })
  const client = { query, release: vi.fn() }
  const repository = {
    applyProjection: options.applyError
      ? vi.fn().mockRejectedValue(options.applyError)
      : vi.fn().mockResolvedValue(undefined),
  }
  const worker = createAttentionProjectionWorker({
    pool: { connect: vi.fn().mockResolvedValue(client) } as never,
    repository,
  })
  return { worker, repository, query, client }
}

describe('Attention Inbox projection worker', () => {
  test('projects supported events and advances the independent cursor in one transaction', async () => {
    const { worker, repository, query, client } = fixture()

    expect(await worker.runOnce()).toBe(1)

    expect(repository.applyProjection).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        operation: 'upsert',
        item: expect.objectContaining({ requestId: 'request-1', provider: 'codex' }),
      }),
    )
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE attention_projection_cursor'),
      [6],
    )
    expect(query.mock.calls.map((call) => call[0])).toContain('COMMIT')
    expect(client.release).toHaveBeenCalledOnce()
  })

  test('advances past unrelated events without creating an item', async () => {
    const { worker, repository, query } = fixture({
      rows: [eventRow({ id: 7, event_type: 'agent_text', payload: { type: 'agent_text' } })],
    })

    expect(await worker.runOnce()).toBe(1)

    expect(repository.applyProjection).not.toHaveBeenCalled()
    expect(query).toHaveBeenCalledWith(expect.stringContaining('UPDATE attention_projection_cursor'), [7])
  })

  test('rolls back projection failure without advancing the cursor or affecting the event pipeline', async () => {
    const { worker, query, client } = fixture({ applyError: new Error('projection failed') })

    await expect(worker.runOnce()).rejects.toThrow('projection failed')

    expect(query.mock.calls.some((call) => String(call[0]).includes('UPDATE attention_projection_cursor')))
      .toBe(false)
    expect(query.mock.calls.map((call) => call[0])).toContain('ROLLBACK')
    expect(client.release).toHaveBeenCalledOnce()
  })

  test('does no work when another Relay instance owns the cursor row lock', async () => {
    const { worker, repository, query } = fixture()
    query.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 }
      if (sql.includes('FROM attention_projection_cursor')) return { rows: [], rowCount: 0 }
      throw new Error(`unexpected query: ${sql}`)
    })

    expect(await worker.runOnce()).toBe(0)
    expect(repository.applyProjection).not.toHaveBeenCalled()
    expect(query.mock.calls.map((call) => call[0])).toContain('COMMIT')
  })
})
