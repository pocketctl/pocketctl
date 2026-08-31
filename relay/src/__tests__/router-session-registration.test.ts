import { describe, expect, test, vi } from 'vitest'
import { handleSessionRegistrationMessage } from '../extensions/grant-service.js'

/**
 * Two-phase managed-session registration (plan 10.1): the durable session
 * write happens BEFORE the ack; the ack is bounded and carries no grant.
 */
describe('session registration ack', () => {
  test('durable-writes the owned session then acks ready with the correlation id', async () => {
    const writes: Array<{ sql: string; params: unknown[] }> = []
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        writes.push({ sql, params: params ?? [] })
        return { rows: [{ session_id: 'ses-new' }] }
      }),
    }
    const sent: string[] = []
    await handleSessionRegistrationMessage(
      { pool } as never,
      { userId: 7, daemonId: 'daemon-1' },
      { type: 'session_registration', request_id: 'req-9', session_id: 'ses-new' },
      payload => sent.push(payload),
    )
    expect(writes).toHaveLength(1)
    expect(writes[0].sql).toContain('INSERT INTO sessions')
		expect(writes[0].sql).toContain('sessions.user_id = EXCLUDED.user_id')
    expect(writes[0].params).toEqual(['ses-new', 7, 'daemon-1'])
    expect(JSON.parse(sent[0])).toEqual({
      type: 'session_registration_ack',
      request_id: 'req-9',
      session_id: 'ses-new',
      status: 'ready',
    })
  })

  test('a conflicting foreign session owner is rejected without an ack', async () => {
    const pool = { query: vi.fn(async () => ({ rows: [] })) }
    const sent: string[] = []
    await handleSessionRegistrationMessage(
      { pool } as never,
      { userId: 7, daemonId: 'daemon-1' },
      { type: 'session_registration', request_id: 'req-foreign', session_id: 'ses-foreign' },
      payload => sent.push(payload),
    )
    expect(JSON.parse(sent[0])).toEqual({
      type: 'session_registration_error', request_id: 'req-foreign', code: 'forbidden',
    })
  })

  test('an invalid session id answers a bounded error without writing', async () => {
    const writes: unknown[] = []
    const pool = {
      query: vi.fn(async () => {
        writes.push(1)
        return { rows: [] }
      }),
    }
    const sent: string[] = []
    await handleSessionRegistrationMessage(
      { pool } as never,
      { userId: 7 },
      { type: 'session_registration', session_id: '' },
      payload => sent.push(payload),
    )
    expect(writes).toHaveLength(0)
    expect(JSON.parse(sent[0])).toMatchObject({
      type: 'session_registration_error',
      code: 'invalid_request',
    })
  })
})
