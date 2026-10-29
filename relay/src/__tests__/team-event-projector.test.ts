import { describe, expect, test, vi } from 'vitest'
import { createTeamEventProjector } from '../team/event-projector.js'
import { classifyDaemonEvent } from '../ingress/event-policy.js'
import type { MaterializationInput } from '../materialization/types.js'

const input = (payload: Record<string, unknown>): MaterializationInput => ({
  inboxId: 12, userId: 7, daemonId: 'trusted-daemon', daemonGeneration: 123,
  sessionId: 'native', eventType: String(payload.type), payload,
})

describe('durable Team event projection', () => {
  test.each(['collaboration_dispatch_receipt', 'collaboration_context_receipt', 'collaboration_config_receipt'])(
    '%s uses trusted ingress identity and propagates failures for retry', async type => {
      const failure = new Error('transaction aborted')
      const service = { handleDaemonEvent: vi.fn().mockRejectedValue(failure) }
      const event = input({ type, collaboration: { owner_user_id: 99, daemon_id: 'untrusted' } })
      await expect(createTeamEventProjector(service)(event)).rejects.toBe(failure)
      expect(service.handleDaemonEvent).toHaveBeenCalledExactlyOnceWith('trusted-daemon', 7, event.payload, 123, undefined)
      expect(classifyDaemonEvent(event.payload)).toEqual({ durable: true, priority: 'control' })
    },
  )

  test('passes trusted materialized identity separately from daemon payload', async () => {
    const service = { handleDaemonEvent: vi.fn().mockResolvedValue(undefined) }
    const event=input({type:'agent_text',text:'root',materializedEventId:999})
    await createTeamEventProjector(service)(event,91)
    expect(service.handleDaemonEvent).toHaveBeenCalledExactlyOnceWith('trusted-daemon',7,event.payload,123,91)
  })

  test('preserves terminal/approval projection while excluding replay, child and private content', async () => {
    const service = { handleDaemonEvent: vi.fn().mockResolvedValue(undefined) }
    const project = createTeamEventProjector(service)
    for (const payload of [
      { type: 'agent_text', text: 'root answer' },
      { type: 'turn_status', turn_status: 'completed' },
      { type: 'approval_request' },
      { type: 'session_created', collaboration: {} },
    ]) await project(input(payload))
    expect(service.handleDaemonEvent).toHaveBeenCalledTimes(4)
    service.handleDaemonEvent.mockClear()
    for (const payload of [
      { type: 'agent_text', text: 'old', resync: true },
      { type: 'turn_status', turn_status: 'completed', is_subagent: true },
      { type: 'agent_text', text: 'private', agent_id: 'child' },
      { type: 'tool_call' }, { type: 'agent_reasoning' }, { type: 'session_created' },
    ]) await project(input(payload))
    await project({ ...input({ type: 'approval_request' }), userId: null })
    await project({ ...input({ type: 'approval_request' }), eventType: 'tool_call' })
    expect(service.handleDaemonEvent).not.toHaveBeenCalled()
  })
})
