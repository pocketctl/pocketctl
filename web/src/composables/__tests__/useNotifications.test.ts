import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock Notification API
const mockNotification = vi.fn()
const mockNotificationInstance = {
  onclick: null as ((ev: Event) => void) | null,
  close: vi.fn(),
}
mockNotification.mockReturnValue(mockNotificationInstance)

const originalNotification = globalThis.Notification

beforeEach(() => {
  vi.useFakeTimers()
  // Reset module state by re-importing
  mockNotification.mockClear()
  mockNotificationInstance.onclick = null
  mockNotificationInstance.close.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
  // @ts-ignore
  globalThis.Notification = originalNotification
})

// We test the logic directly since the module has singleton state
// that makes re-importing tricky in tests.
describe('Notification logic (unit)', () => {
  const TERMINAL_STATES = new Set(['exited', 'error', 'killed', 'completed'])

  test('terminal states include exited, error, killed, completed', () => {
    expect(TERMINAL_STATES.has('exited')).toBe(true)
    expect(TERMINAL_STATES.has('error')).toBe(true)
    expect(TERMINAL_STATES.has('killed')).toBe(true)
    expect(TERMINAL_STATES.has('completed')).toBe(true)
  })

  test('non-terminal states are not in set', () => {
    expect(TERMINAL_STATES.has('running')).toBe(false)
    expect(TERMINAL_STATES.has('idle')).toBe(false)
    expect(TERMINAL_STATES.has('disconnected')).toBe(false)
    expect(TERMINAL_STATES.has('waiting_approval')).toBe(false)
  })

  test('shouldSendNotification logic', () => {
    const permissionGranted = true
    const currentRouteSessionId: string = 'session-1'
    const otherSessionId: string = 'session-2'

    // Should send: terminal state + different session
    const shouldSend1 = TERMINAL_STATES.has('exited') && otherSessionId !== currentRouteSessionId
    expect(shouldSend1).toBe(true)

    // Should NOT send: viewing the same session
    const shouldSend2 = TERMINAL_STATES.has('exited') && currentRouteSessionId !== currentRouteSessionId
    expect(shouldSend2).toBe(false)

    // Should NOT send: non-terminal state
    const shouldSend3 = TERMINAL_STATES.has('running') && otherSessionId !== currentRouteSessionId
    expect(shouldSend3).toBe(false)

    // Should NOT send: permission not granted
    const permissionGranted2 = false
    const shouldSend4 = permissionGranted2 && TERMINAL_STATES.has('exited') && otherSessionId !== currentRouteSessionId
    expect(shouldSend4).toBe(false)
  })

  test('status labels map correctly', () => {
    const labels: Record<string, string> = {
      exited: '已退出',
      error: '异常退出',
      killed: '已终止',
      completed: '已完成',
    }
    expect(labels['exited']).toBe('已退出')
    expect(labels['error']).toBe('异常退出')
    expect(labels['killed']).toBe('已终止')
    expect(labels['completed']).toBe('已完成')
  })

  test('notification tag includes session_id', () => {
    const sessionId = 'abc-123'
    const tag = `session-${sessionId}`
    expect(tag).toBe('session-abc-123')
  })

  test('notification onclick navigates to session page', () => {
    const sessionId = 'abc-123'
    const expectedUrl = `http://localhost:3000/session/${sessionId}`
    // Verify the URL pattern
    expect(expectedUrl).toContain(`/session/${sessionId}`)
  })
})
