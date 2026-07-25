import { describe, expect, test } from 'vitest'
import { sortMobileSessions } from '../sessionPriority'

describe('sortMobileSessions', () => {
  test('puts sessions needing attention before active and finished sessions', () => {
    const sessions = [
      { session_id: 'finished-pinned', status: 'completed', pinned: true, last_activity_at: '2026-07-25T12:00:00Z' },
      { session_id: 'active', status: 'running', last_activity_at: '2026-07-25T11:00:00Z' },
      { session_id: 'approval', status: 'waiting_approval', last_activity_at: '2026-07-25T10:00:00Z' },
      { session_id: 'question', status: 'waiting_question', last_activity_at: '2026-07-25T09:00:00Z' },
    ]

    expect(sortMobileSessions(sessions).map(session => session.session_id)).toEqual([
      'approval',
      'question',
      'active',
      'finished-pinned',
    ])
  })

  test('uses pinning and recent activity inside the same priority group', () => {
    const sessions = [
      { session_id: 'older', status: 'busy', last_activity_at: '2026-07-25T09:00:00Z' },
      { session_id: 'newer', status: 'running', last_activity_at: '2026-07-25T11:00:00Z' },
      { session_id: 'pinned', status: 'idle', pinned: true, last_activity_at: '2026-07-25T08:00:00Z' },
    ]

    expect(sortMobileSessions(sessions).map(session => session.session_id)).toEqual([
      'pinned',
      'newer',
      'older',
    ])
  })

  test('falls back to start time and keeps equal items stable without mutating input', () => {
    const sessions = [
      { session_id: 'first', status: 'completed', started_at: '2026-07-25T10:00:00Z' },
      { session_id: 'second', status: 'completed', started_at: '2026-07-25T10:00:00Z' },
      { session_id: 'newest', status: 'completed', started_at: '2026-07-25T12:00:00Z' },
    ]
    const original = [...sessions]

    expect(sortMobileSessions(sessions).map(session => session.session_id)).toEqual([
      'newest',
      'first',
      'second',
    ])
    expect(sessions).toEqual(original)
  })
})
