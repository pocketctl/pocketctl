import { describe, expect, test } from 'vitest'
import { classifyArtifact } from '../projection/artifact-classifier.js'
import { extractCanonicalEventKey } from '../projection/event-identity.js'

describe('canonical event identity', () => {
  test('prefers an explicit event id', () => {
    expect(extractCanonicalEventKey({
      event_id: 'evt-1', message_id: 'm', part_id: 'p', call_id: 'c',
    })).toBe('event_id:evt-1')
  })

  test('falls back to message identity with part and revision', () => {
    expect(extractCanonicalEventKey({
      message_id: 'm-1', part_id: 'p-2', revision: 3, call_id: 'c',
    })).toBe('message:m-1:p-2:3')
  })

  test('falls back to call identity combined with the event type', () => {
    expect(extractCanonicalEventKey({ call_id: 'call-9', event_type: 'tool_call' }))
      .toBe('call:call-9:tool_call')
  })

  test('returns null when no stable identity exists', () => {
    expect(extractCanonicalEventKey({})).toBeNull()
    expect(extractCanonicalEventKey({ event_id: '', message_id: 'only-message' })).toBeNull()
    expect(extractCanonicalEventKey({ event_id: 42 })).toBeNull()
    expect(extractCanonicalEventKey(null as unknown as Record<string, unknown>)).toBeNull()
  })

  test('empty-string and blank identities are rejected', () => {
    expect(extractCanonicalEventKey({ message_id: 'm', part_id: '', revision: 1 })).toBeNull()
    expect(extractCanonicalEventKey({ call_id: '', event_type: 'tool_call' })).toBeNull()
  })
})

describe('deterministic artifact classification', () => {
  test('file changes classify on an explicit path', () => {
    const artifact = classifyArtifact('file_change', { file_path: 'src/a.ts', change_type: 'edit' })
    expect(artifact).toMatchObject({ artifact_type: 'file_change', identity_key: 'src/a.ts', path: 'src/a.ts' })
  })

  test('tool calls and results require a call id', () => {
    const call = classifyArtifact('tool_call', { call_id: 'c-1', tool: 'read' })
    expect(call).toMatchObject({ artifact_type: 'tool_call', identity_key: 'c-1', call_id: 'c-1' })
    const result = classifyArtifact('tool_result', { call_id: 'c-1', status: 'ok' })
    expect(result).toMatchObject({ artifact_type: 'tool_result', identity_key: 'c-1', call_id: 'c-1', status: 'ok' })
    expect(classifyArtifact('tool_call', { tool: 'read' })).toBeNull()
  })

  test('test events, approvals and commands map through the allowlist', () => {
    expect(classifyArtifact('test_finished', { test_run_id: 't-1', status: 'failed' }))
      .toMatchObject({ artifact_type: 'test_result', identity_key: 't-1', status: 'failed' })
    expect(classifyArtifact('approval_granted', { approval_id: 'a-1' }))
      .toMatchObject({ artifact_type: 'approval', identity_key: 'a-1' })
    expect(classifyArtifact('shell_command', { command: 'npm test', command_id: 'cmd-1' }))
      .toMatchObject({ artifact_type: 'command', identity_key: 'cmd-1' })
  })

  test('unclassified event types never produce artifacts', () => {
    expect(classifyArtifact('agent_text', { text: 'redacted' })).toBeNull()
    expect(classifyArtifact('brand_new_event', { anything: true })).toBeNull()
    expect(classifyArtifact('file_change', { file_path: '' })).toBeNull()
  })
})
