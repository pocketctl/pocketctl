import { describe, expect, test } from 'vitest'
import {
  SESSION_REMOTE_PAGE_SIZE,
  nextVisibleSessionCount,
  mergeSessionPage,
} from '../sessionListPagination'

describe('session list pagination', () => {
  test('reveals iOS-sized render batches without exceeding the loaded sessions', () => {
    expect(nextVisibleSessionCount(15, 40)).toBe(30)
    expect(nextVisibleSessionCount(30, 37)).toBe(37)
  })

  test('merges a cursor page without duplicating sessions already received live', () => {
    const existing = [
      { session_id: 'new-live', title: '实时会话' },
      { session_id: 'page-1', title: '第一页旧标题' },
    ]
    const incoming = [
      { session_id: 'page-1', title: '权威标题' },
      { session_id: 'page-2', title: '第二页' },
    ]

    expect(mergeSessionPage(existing, incoming).map(session => session.session_id)).toEqual([
      'new-live',
      'page-1',
      'page-2',
    ])
    expect(mergeSessionPage(existing, incoming)[1].title).toBe('权威标题')
  })

  test('uses the same 20-session remote page size as iOS', () => {
    expect(SESSION_REMOTE_PAGE_SIZE).toBe(20)
  })
})
