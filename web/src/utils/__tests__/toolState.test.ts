import { describe, expect, test } from 'vitest'
import { reconcileUnresolvedTools } from '../toolState'

describe('reconcileUnresolvedTools', () => {
  test('marks running historical tools unknown after a settled session', () => {
    const messages = [
      { type: 'tool_call', call_id: 'running', status: 'running' },
      { type: 'tool_call', call_id: 'completed', status: 'completed' },
      { type: 'tool_call', call_id: 'timeout', status: 'timeout' },
    ]

    reconcileUnresolvedTools(messages, 'idle')

    expect(messages.map((message) => message.status)).toEqual(['unknown', 'completed', 'timeout'])
  })

  test('keeps tools running while the session can still produce a result', () => {
    for (const sessionStatus of ['running', 'busy', 'retry', 'waiting', 'disconnected']) {
      const messages = [{ type: 'tool_call', call_id: sessionStatus, status: 'running' }]

      reconcileUnresolvedTools(messages, sessionStatus)

      expect(messages[0].status, sessionStatus).toBe('running')
    }
  })
})
