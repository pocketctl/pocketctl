import { describe, expect, test, vi } from 'vitest'
import { EventMaterializer } from '../materialization/event-materializer.js'
import type { MaterializationInput } from '../materialization/types.js'

function input(payload: Record<string, unknown>): MaterializationInput {
  return {
    inboxId: 71, userId: 42, daemonId: 'daemon-claude', sessionId: 'claude-session',
    eventType: String(payload.type), payload,
    context: { agentType: 'claude-code', cwd: '/repo', requestId: String(payload.request_id ?? '') },
  }
}

function pool() {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('INSERT INTO events')) return { rows: [{ id: 501, inserted: true, effect_status: 'pending', effect_step: 0 }], rowCount: 1 }
      if (sql.includes('SELECT effect_status')) return { rows: [{ effect_status: 'pending', effect_step: 0 }], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    }),
  }
}

describe('Claude Channel approval delivery contract', () => {
  test('keeps submitted feedback origin-only and preserves neutral truth fields', async () => {
    const payload = {
      type: 'interaction_result', session_id: 'claude-session',
      request_id: 'f444466b-b260-4ba0-bb9d-d440bab4ea0f', operation: 'approval_response',
      status: 'submitted', reason: 'claude_result_unconfirmed',
    }
    const result = await new EventMaterializer({ pool: pool() as never }).materialize(input(payload))

    expect(result).toMatchObject({ eventId: null, inserted: false, completed: true })
    expect(result.deliveries).toEqual([expect.objectContaining({
      audience: 'interaction-origin', type: 'interaction_result', payload,
    })])
  })

  test('broadcasts a neutral closure without inventing approved or action', async () => {
    const payload = {
      type: 'approval_resolved', session_id: 'claude-session',
      request_id: 'f444466b-b260-4ba0-bb9d-d440bab4ea0f', reason: 'claude_result_unconfirmed',
    }
    const result = await new EventMaterializer({ pool: pool() as never }).materialize(input(payload))

    expect(result.deliveries).toEqual([expect.objectContaining({
      audience: 'session', type: 'approval_resolved', payload,
    })])
    expect(result.deliveries[0]?.payload).not.toHaveProperty('approved')
    expect(result.deliveries[0]?.payload).not.toHaveProperty('action')
  })
})
