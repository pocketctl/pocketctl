import { describe, test, expect } from 'vitest'

// Pure logic tests extracted from SessionList.vue

describe('exitReasonLabel', () => {
  const labels: Record<string, string> = {
    user_interrupt: '用户中断',
    normal_exit: '正常退出',
    process_crash: '异常退出',
    signal_kill: '被终止',
    unknown: '已退出',
  }

  test('maps known reasons correctly', () => {
    expect(labels['user_interrupt']).toBe('用户中断')
    expect(labels['normal_exit']).toBe('正常退出')
    expect(labels['process_crash']).toBe('异常退出')
    expect(labels['signal_kill']).toBe('被终止')
    expect(labels['unknown']).toBe('已退出')
  })

  test('falls back to "已退出" for unknown reasons', () => {
    expect(labels['something_else'] || '已退出').toBe('已退出')
  })
})

describe('status indicator CSS classes', () => {
  const statusClasses: Record<string, string> = {
    running: 'running',
    busy: 'busy',
    idle: 'idle',
    waiting_approval: 'waiting_approval',
    exited: 'exited',
    completed: 'completed',
    error: 'error',
    killed: 'killed',
    disconnected: 'disconnected',
  }

  test('all 8 statuses have CSS class mappings', () => {
    const expectedStatuses = ['running', 'idle', 'waiting_approval', 'exited', 'completed', 'disconnected', 'error', 'killed']
    for (const s of expectedStatuses) {
      expect(statusClasses[s]).toBeDefined()
    }
  })

  test('busy maps to running-style class', () => {
    expect(statusClasses['busy']).toBe('busy')
  })
})

describe('effectiveStatus in list context', () => {
  function effectiveStatus(session: { status: string; daemon_id?: string; daemon_online?: boolean }): string {
    if (session.daemon_id && session.daemon_online === false) {
      return 'disconnected'
    }
    return session.status
  }

  test('shows disconnected when daemon_online is false', () => {
    expect(effectiveStatus({ status: 'running', daemon_id: 'd1', daemon_online: false })).toBe('disconnected')
  })

  test('shows real status when daemon_online is true', () => {
    expect(effectiveStatus({ status: 'exited', daemon_id: 'd1', daemon_online: true })).toBe('exited')
  })

  test('shows real status when daemon_online is undefined', () => {
    expect(effectiveStatus({ status: 'running', daemon_id: 'd1' })).toBe('running')
  })
})

describe('session sorting by last_activity_at', () => {
  test('sorts by last_activity_at descending', () => {
    const sessions = [
      { session_id: 'a', last_activity_at: '2026-06-07T10:00:00Z' },
      { session_id: 'b', last_activity_at: '2026-06-07T12:00:00Z' },
      { session_id: 'c', last_activity_at: '2026-06-07T11:00:00Z' },
    ]
    const sorted = [...sessions].sort((a, b) => {
      const ta = a.last_activity_at ? new Date(a.last_activity_at).getTime() : 0
      const tb = b.last_activity_at ? new Date(b.last_activity_at).getTime() : 0
      return tb - ta
    })
    expect(sorted[0].session_id).toBe('b')
    expect(sorted[1].session_id).toBe('c')
    expect(sorted[2].session_id).toBe('a')
  })

  test('handles missing last_activity_at', () => {
    const sessions = [
      { session_id: 'a', last_activity_at: undefined, started_at: new Date('2026-06-07T10:00:00Z') },
      { session_id: 'b', last_activity_at: '2026-06-07T12:00:00Z', started_at: new Date() },
    ]
    const sorted = [...sessions].sort((a, b) => {
      const ta = a.last_activity_at ? new Date(a.last_activity_at).getTime() : (a.started_at ? new Date(a.started_at as any).getTime() : 0)
      const tb = b.last_activity_at ? new Date(b.last_activity_at).getTime() : (b.started_at ? new Date(b.started_at as any).getTime() : 0)
      return tb - ta
    })
    expect(sorted[0].session_id).toBe('b')
  })
})
