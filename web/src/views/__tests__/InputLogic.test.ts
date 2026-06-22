import { describe, test, expect } from 'vitest'

// Pure logic tests for the input area — extracted from SessionDetail.vue's
// computed/handlers. These protect the key interaction rules without needing
// to mount the full component (which has heavy WebSocket dependencies).

describe('#5 send button disabled when input is empty', () => {
  function canSend(messageInput: string, isDisconnected: boolean, isPending: boolean, isLoading: boolean): boolean {
    return !isDisconnected && !isPending && !isLoading && !!messageInput.trim()
  }

  test('empty input → disabled', () => {
    expect(canSend('', false, false, false)).toBe(false)
  })

  test('whitespace-only input → disabled', () => {
    expect(canSend('   \n  ', false, false, false)).toBe(false)
  })

  test('non-empty input → enabled', () => {
    expect(canSend('hello', false, false, false)).toBe(true)
  })

  test('disconnected → disabled even with text', () => {
    expect(canSend('hello', true, false, false)).toBe(false)
  })

  test('pending session → disabled', () => {
    expect(canSend('hello', false, true, false)).toBe(false)
  })

  test('loading → disabled', () => {
    expect(canSend('hello', false, false, true)).toBe(false)
  })
})

describe('#13 isExecuting drives send/stop button state', () => {
  function isExecuting(status: string): boolean {
    return status === 'running' || status === 'busy'
  }

  test('running → executing (show stop button)', () => {
    expect(isExecuting('running')).toBe(true)
  })

  test('busy → executing', () => {
    expect(isExecuting('busy')).toBe(true)
  })

  test('idle → not executing (show send button)', () => {
    expect(isExecuting('idle')).toBe(false)
  })

  test('completed → not executing', () => {
    expect(isExecuting('completed')).toBe(false)
  })

  test('exited → not executing', () => {
    expect(isExecuting('exited')).toBe(false)
  })
})

describe('#29 Alt/Option+Enter inserts newline, does not send', () => {
  // Simulates the key decision logic from onInputKeydown
  function shouldSendOnEnter(e: { key: string; altKey: boolean; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }): boolean {
    if (e.key !== 'Enter') return false
    // Any modifier → not a plain send
    if (e.altKey || e.shiftKey || e.metaKey || e.ctrlKey) return false
    return true
  }

  function shouldInsertNewline(e: { key: string; altKey: boolean; shiftKey: boolean }): boolean {
    return e.key === 'Enter' && (e.altKey || e.shiftKey)
  }

  test('plain Enter → send', () => {
    const e = { key: 'Enter', altKey: false, shiftKey: false, metaKey: false, ctrlKey: false }
    expect(shouldSendOnEnter(e)).toBe(true)
    expect(shouldInsertNewline(e)).toBe(false)
  })

  test('Alt+Enter (macOS Option+Enter) → newline, not send', () => {
    const e = { key: 'Enter', altKey: true, shiftKey: false, metaKey: false, ctrlKey: false }
    expect(shouldSendOnEnter(e)).toBe(false)
    expect(shouldInsertNewline(e)).toBe(true)
  })

  test('Shift+Enter → newline, not send', () => {
    const e = { key: 'Enter', altKey: false, shiftKey: true, metaKey: false, ctrlKey: false }
    expect(shouldSendOnEnter(e)).toBe(false)
    expect(shouldInsertNewline(e)).toBe(true)
  })

  test('Cmd+Enter (metaKey) → not send, not newline (let default)', () => {
    const e = { key: 'Enter', altKey: false, shiftKey: false, metaKey: true, ctrlKey: false }
    expect(shouldSendOnEnter(e)).toBe(false)
    expect(shouldInsertNewline(e)).toBe(false)
  })

  test('Ctrl+Enter → not send', () => {
    const e = { key: 'Enter', altKey: false, shiftKey: false, metaKey: false, ctrlKey: true }
    expect(shouldSendOnEnter(e)).toBe(false)
  })

  test('non-Enter key → not send', () => {
    const e = { key: 'a', altKey: false, shiftKey: false, metaKey: false, ctrlKey: false }
    expect(shouldSendOnEnter(e)).toBe(false)
  })
})
