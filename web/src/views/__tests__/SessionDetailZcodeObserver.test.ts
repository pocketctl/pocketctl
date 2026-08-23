import { describe, test, expect } from 'vitest'
import { zcodeCanWrite, isZcodeObserverSession } from '../../utils/zcodeObserver'
import { buildResumeCommand } from '../../utils/resumeCommand'

describe('ZCode observer session fail-closed gate', () => {
  test('isZcodeObserverSession is true only for zcode', () => {
    expect(isZcodeObserverSession('zcode')).toBe(true)
    expect(isZcodeObserverSession('claude-code')).toBe(false)
    expect(isZcodeObserverSession('codex')).toBe(false)
    expect(isZcodeObserverSession('opencode')).toBe(false)
    expect(isZcodeObserverSession('')).toBe(false)
  })

  test('zcode is never writable in any status', () => {
    for (const status of ['idle', 'running', 'busy', 'completed', 'error', 'exited', 'waiting']) {
      expect(zcodeCanWrite({ agentType: 'zcode', status })).toBe(false)
    }
  })

  test('forged control_mode=managed does NOT re-enable write', () => {
    expect(zcodeCanWrite({ agentType: 'zcode', controlMode: 'managed' })).toBe(false)
  })

  test('forged capabilities including message_acceptance_receipt do NOT re-enable write', () => {
    expect(zcodeCanWrite({
      agentType: 'zcode',
      capabilities: ['message_acceptance_receipt', 'history_sync', 'shared_runtime'],
    })).toBe(false)
  })

  test('daemon online/offline never re-enables write', () => {
    expect(zcodeCanWrite({ agentType: 'zcode', daemonOnline: true })).toBe(false)
    expect(zcodeCanWrite({ agentType: 'zcode', daemonOnline: false })).toBe(false)
  })

  test('every forged field combined still cannot write', () => {
    expect(zcodeCanWrite({
      agentType: 'zcode', status: 'idle', controlMode: 'managed',
      capabilities: ['message_acceptance_receipt'], daemonOnline: true,
    })).toBe(false)
  })

  test('non-zcode agents pass through to normal writeability logic (true)', () => {
    expect(zcodeCanWrite({ agentType: 'claude-code' })).toBe(true)
    expect(zcodeCanWrite({ agentType: 'codex' })).toBe(true)
    expect(zcodeCanWrite({ agentType: 'opencode' })).toBe(true)
  })

  test('resume command is suppressed for zcode (no claude fallback)', () => {
    expect(buildResumeCommand({ agent: 'zcode', session_id: 'zcode-wire1', cwd: '/x' })).toBeNull()
  })
})
