import { describe, expect, test, vi } from 'vitest'

import { AttentionInboxRepository, mapAttentionItemRow } from '../attention-inbox/repository.js'
import type { AttentionProjection } from '../attention-inbox/types.js'

const itemRow = {
  item_id: '8c60a71b-01d9-4d3e-896e-04686b587c4d',
  user_id: 7,
  revision: '3',
}

function clientReturning(rows: any[]) {
  const query = vi.fn()
    .mockResolvedValueOnce({ rows, rowCount: rows.length })
    .mockResolvedValueOnce({ rows: [], rowCount: 1 })
  return { query }
}

function upsertProjection(): AttentionProjection {
  return {
    operation: 'upsert',
    item: {
      userId: 7,
      daemonId: 'daemon-1',
      sessionId: 'session-1',
      requestId: 'request-1',
      provider: 'codex',
      kind: 'approval',
      riskLevel: 'high',
      classificationIncomplete: true,
      riskReasons: ['executes_command'],
      title: 'Approval required',
      summary: 'Release',
      context: { command: 'git status' },
      allowedActions: [{
        id: 'once', style: 'primary', destructive: false, labelKey: 'attention.action.once',
      }],
      sourceEventId: 10,
      sourceEventType: 'approval_request',
      sourceEventKey: null,
      expiresAt: null,
      createdAt: new Date('2026-08-11T00:00:00.000Z'),
    },
  }
}

describe('Attention Inbox repository projection writes', () => {
  test('upserts a request and emits only a compact change notification', async () => {
    const client = clientReturning([itemRow])
    const repository = new AttentionInboxRepository()

    await repository.applyProjection(client as never, upsertProjection())

    expect(client.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('INSERT INTO attention_items'),
      expect.arrayContaining([7, 'daemon-1', 'session-1', 'request-1', 'codex', 'approval']),
    )
    expect(client.query.mock.calls[0]?.[1]).toContain(JSON.stringify(['executes_command']))
    expect(client.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("pg_notify('pocketctl_attention'"),
      [7, itemRow.item_id, 3, 'changed'],
    )
    expect(JSON.stringify(client.query.mock.calls[1])).not.toContain('git status')
  })

  test('maps persisted risk reasons without synthesizing defaults', () => {
    expect(mapAttentionItemRow({
      item_id: itemRow.item_id, user_id: 7, daemon_id: 'daemon-1', session_id: 'session-1',
      request_id: 'request-1', provider: 'codex', kind: 'approval', state: 'open', revision: 1,
      risk_level: 'high', classification_incomplete: true,
      risk_reasons: ['executes_command', 'changes_files'],
      created_at: new Date('2026-08-11T00:00:00.000Z'), updated_at: new Date('2026-08-11T00:00:00.000Z'),
    }).riskReasons).toEqual(['executes_command', 'changes_files'])
    expect(mapAttentionItemRow({
      item_id: itemRow.item_id, user_id: 7, daemon_id: 'daemon-1', session_id: 'session-1',
      request_id: 'request-1', provider: 'codex', kind: 'approval', state: 'open', revision: 1,
      risk_level: 'high', classification_incomplete: true,
      created_at: new Date('2026-08-11T00:00:00.000Z'), updated_at: new Date('2026-08-11T00:00:00.000Z'),
    }).riskReasons).toEqual([])
  })

  test('does not notify when a replayed request leaves a resolved item unchanged', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) }
    const repository = new AttentionInboxRepository()

    await repository.applyProjection(client as never, upsertProjection())

    expect(client.query).toHaveBeenCalledOnce()
  })

  test('resolves an existing item and records the authoritative resolution event', async () => {
    const client = clientReturning([itemRow])
    const repository = new AttentionInboxRepository()

    await repository.applyProjection(client as never, {
      operation: 'resolve',
      identity: {
        userId: 7, daemonId: 'daemon-1', sessionId: 'session-1',
        requestId: 'request-1', kind: 'approval',
      },
      resolutionEventId: 11,
      resolution: { action: 'reject', approved: false, source: 'daemon' },
    })

    expect(client.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("SET state = 'resolved'"),
      expect.arrayContaining([7, 'daemon-1', 'session-1', 'request-1', 'approval', 11]),
    )
    expect(client.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("pg_notify('pocketctl_attention'"),
      [7, itemRow.item_id, 3, 'changed'],
    )
  })
})
