import { describe, expect, test } from 'vitest'
import { isSideEffectFreeReplay } from '../materialization/replay-batch-policy.js'
import type { MaterializationInput } from '../materialization/types.js'

const historical = (): MaterializationInput => ({
  inboxId: 1, userId: 1, daemonId: 'isolated', daemonGeneration: 1,
  sessionId: 'history', eventType: 'agent_text',
  payload: { type: 'agent_text', session_id: 'history', event_id: 'codex:1:final:hash', resync: true, text: 'synthetic' },
  context: { agentType: '', cwd: '', hostname: 'isolated', reservationId: null },
})

describe('replay batch policy uses actual ingress context', () => {
  test('accepts the explicit empty reservation emitted by WebSocket ingress', () => {
    expect(isSideEffectFreeReplay(historical())).toBe(true)
  })
  test.each([
    { reservationId: 'actual-reservation' }, { requestId: 'actual-request' },
    { quotaOperation: 'start_session' }, { futureContext: null },
  ])('keeps side effects and unknown context on ordinary processing: %j', (extra) => {
    const input = historical()
    input.context = { ...input.context, ...extra } as MaterializationInput['context']
    expect(isSideEffectFreeReplay(input)).toBe(false)
  })
  test.each(['usage', 'is_subagent', 'request_id'])('rejects payload side effect %s', key => {
    const input = historical()
    input.payload[key] = key === 'usage' ? { input_tokens: 1 } : key === 'is_subagent' ? true : 'request'
    expect(isSideEffectFreeReplay(input)).toBe(false)
  })
})
