import { describe, expect, test } from 'vitest'
import { resolveSessionActivityAt } from '../materialization/session-activity-policy.js'

const receivedAt = new Date('2026-09-04T05:00:00.000Z')

function activity(eventType: string, payload: Record<string, unknown> = {}) {
  return resolveSessionActivityAt({
    inboxId: 1,
    userId: 1,
    daemonId: 'daemon-1',
    sessionId: 'session-1',
    eventType,
    payload,
    receivedAt,
  })
}

describe('session activity policy', () => {
  test.each(['session_meta', 'list_commands_result', 'session_title_update'])(
    'does not treat %s as activity',
    eventType => {
      expect(activity(eventType)).toBeNull()
    },
  )

  test('restores discovery activity from the source timestamp', () => {
    expect(activity('session_discovered', {
      resync: true,
      last_activity_at: '2026-09-01T01:02:03.000Z',
    })?.toISOString()).toBe('2026-09-01T01:02:03.000Z')
  })

  test('does not invent discovery activity without a source timestamp', () => {
    expect(activity('session_discovered', { resync: true })).toBeNull()
  })

  test('does not treat replayed content as current activity', () => {
    expect(activity('agent_text', { text: 'historical', resync: true })).toBeNull()
    expect(activity('tool_result', { output: 'historical', resync: true })).toBeNull()
  })

  test('does not treat turn-ledger reconciliation as user activity', () => {
    expect(activity('turn_status', {
      turn_status: 'abandoned',
      turn_reason: 'daemon_restart_reconcile',
      content_class: 'lifecycle',
    })).toBeNull()
  })

  test('uses relay receipt time for live conversational events', () => {
    expect(activity('user_text', { text: 'hello' })).toEqual(receivedAt)
    expect(activity('tool_result', { output: 'done' })).toEqual(receivedAt)
  })

  test('ignores usage-only agent text', () => {
    expect(activity('agent_text', { content_class: 'telemetry' })).toBeNull()
    expect(activity('agent_text')).toBeNull()
  })

  test('clamps source timestamps that are later than relay receipt', () => {
    expect(activity('session_status', {
      last_activity_at: '2026-09-05T00:00:00.000Z',
    })).toEqual(receivedAt)
  })
})
