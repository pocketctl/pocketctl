import { describe, expect, it } from 'vitest'
import { canSendClaudeSession } from '../claudeSessionControl'

const base = {
  source: 'terminal',
  daemonOnline: true,
  isSubagent: false,
  capabilities: ['history_sync', 'resume_after_exit'],
}

describe('canSendClaudeSession', () => {
  it.each(['running', 'busy', 'waiting', 'waiting_approval'])(
    'keeps a terminal Claude session read-only while %s',
    (status) => expect(canSendClaudeSession({ ...base, status })).toBe(false),
  )

  it('allows idle terminal handoff', () => {
    expect(canSendClaudeSession({ ...base, status: 'idle' })).toBe(true)
  })

  it.each(['exited', 'completed', 'error', 'killed'])(
    'allows %s only with resume_after_exit',
    (status) => {
      expect(canSendClaudeSession({ ...base, status })).toBe(true)
      expect(canSendClaudeSession({ ...base, status, capabilities: ['history_sync'] })).toBe(false)
    },
  )

  it('preserves daemon-owned Claude PTY input', () => {
    expect(canSendClaudeSession({ ...base, source: 'daemon', status: 'running', capabilities: [] })).toBe(true)
  })

  it('fails closed for offline and subagent sessions', () => {
    expect(canSendClaudeSession({ ...base, status: 'idle', daemonOnline: false })).toBe(false)
    expect(canSendClaudeSession({ ...base, status: 'idle', isSubagent: true })).toBe(false)
  })
})
