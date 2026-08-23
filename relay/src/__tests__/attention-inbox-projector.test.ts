import { describe, expect, test } from 'vitest'

import { projectAttentionEvent, type AttentionEventRow } from '../attention-inbox/projector.js'

function row(overrides: Partial<AttentionEventRow> = {}): AttentionEventRow {
  return {
    eventId: 10,
    eventType: 'approval_request',
    sessionId: 'session-1',
    payload: {
      type: 'approval_request',
      session_id: 'session-1',
      request_id: 'request-1',
      approval_kind: 'commandExecution',
      available_decisions: ['accept', 'acceptForSession', 'decline'],
      command: 'git status',
      cwd: '/repo',
    },
    userId: 7,
    daemonId: 'daemon-1',
    provider: 'codex',
    controlMode: 'managed',
    capabilities: ['terminal_coapproval', 'questions'],
    sessionTitle: 'Release',
    sessionStatus: 'waiting_approval',
    daemonAlias: 'Studio',
    daemonHostname: 'host.local',
    createdAt: new Date('2026-08-11T00:00:00.000Z'),
    ...overrides,
  }
}

describe('Attention Inbox event projector', () => {
  test('bounds persisted context without adding actions', () => {
    const projection = projectAttentionEvent(row({
      eventType: 'approval_request',
      payload: {
        request_id: 'req-large', available_decisions: ['accept', 'decline'],
        command: 'x'.repeat(200_000),
      },
    }))
    expect(projection?.operation).toBe('upsert')
    if (projection?.operation !== 'upsert') return
    expect(Buffer.byteLength(JSON.stringify(projection.item.context))).toBeLessThanOrEqual(128 * 1024)
    expect(projection.item.allowedActions.map((action) => action.id)).toEqual(['once', 'reject'])
  })
  test('projects a Codex approval conservatively without inventing persistent scope', () => {
    expect(projectAttentionEvent(row())).toEqual({
      operation: 'upsert',
      item: expect.objectContaining({
        userId: 7,
        daemonId: 'daemon-1',
        sessionId: 'session-1',
        requestId: 'request-1',
        provider: 'codex',
        kind: 'approval',
        riskLevel: 'high',
        classificationIncomplete: true,
        allowedActions: [
          expect.objectContaining({ id: 'once' }),
          expect.objectContaining({ id: 'reject' }),
        ],
        context: expect.objectContaining({
          approval_kind: 'commandExecution', command: 'git status', cwd: '/repo',
        }),
      }),
    })
  })

  test('keeps only bounded trusted risk-reason codes without changing actions', () => {
    const projection = projectAttentionEvent(row({
      payload: {
        request_id: 'request-risk', available_decisions: ['accept', 'acceptForSession', 'decline'],
        risk_level: 'high', classification_incomplete: true,
        risk_reasons: [
          'executes_command', 'server supplied prose', 'executes_command',
          'changes_files', 'requests_permissions', 'requires_user_input', 'unknown_code',
        ],
      },
    }))

    expect(projection?.operation).toBe('upsert')
    if (projection?.operation !== 'upsert') return
    expect(projection.item.riskReasons).toEqual([
      'executes_command', 'changes_files', 'requests_permissions', 'requires_user_input',
    ])
    expect(projection.item.allowedActions.map((action) => action.id)).toEqual(['once', 'reject'])
  })

  test('projects only managed OpenCode approval actions and preserves explicit save rules', () => {
    const projection = projectAttentionEvent(row({
      provider: 'opencode',
      capabilities: ['terminal_coapproval', 'trusted_action_policy_v1'],
      payload: {
        type: 'approval_request', session_id: 'session-1', request_id: 'permission-1',
        permission_name: 'bash', patterns: ['git *'], always: ['git status'],
        risk_level: 'low', classification_incomplete: false,
        security_context: {
          schema_version: 1, risk_level: 'low', classification_incomplete: false,
          risk_reasons: ['executes_command'], allowed_actions: ['once', 'always', 'reject'],
        },
      },
    }))

    expect(projection).toEqual({
      operation: 'upsert',
      item: expect.objectContaining({
        requestId: 'permission-1',
        provider: 'opencode',
        allowedActions: [
          expect.objectContaining({ id: 'once' }),
          expect.objectContaining({ id: 'always' }),
          expect.objectContaining({ id: 'reject' }),
        ],
        context: expect.objectContaining({
          permission_name: 'bash', patterns: ['git *'], always_rules: ['git status'],
        }),
      }),
    })
  })

  test('intersects a valid enforced security context with native decisions and policy', () => {
    const projection = projectAttentionEvent(row({
      capabilities: ['trusted_action_policy_v1'],
      payload: {
        request_id: 'request-trusted',
        available_decisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
        risk_level: 'low', classification_incomplete: false,
        security_context: {
          schema_version: 1, risk_level: 'high', classification_incomplete: false,
          risk_reasons: ['executes_command'],
          allowed_actions: ['once', 'always', 'cancel'],
        },
      },
    }))
    expect(projection?.operation).toBe('upsert')
    if (projection?.operation !== 'upsert') return
    expect(projection.item.riskLevel).toBe('high')
    expect(projection.item.classificationIncomplete).toBe(false)
    expect(projection.item.allowedActions.map((action) => action.id)).toEqual(['once', 'cancel'])
  })

  test('fails malformed enforced context closed and ignores legacy complete-low persistence claims', () => {
    const malformed = projectAttentionEvent(row({
      capabilities: ['trusted_action_policy_v1'],
      payload: {
        request_id: 'request-malformed', available_decisions: ['accept', 'acceptForSession', 'decline'],
        risk_level: 'low', classification_incomplete: false,
        security_context: { schema_version: 1, risk_level: 'low', allowed_actions: 'always' },
      },
    }))
    expect(malformed?.operation).toBe('upsert')
    if (malformed?.operation !== 'upsert') return
    expect(malformed.item.riskLevel).toBe('high')
    expect(malformed.item.classificationIncomplete).toBe(true)
    expect(malformed.item.allowedActions.map((action) => action.id)).toEqual(['once', 'reject'])

    const legacy = projectAttentionEvent(row({
      payload: {
        request_id: 'request-legacy', available_decisions: ['accept', 'acceptForSession', 'decline'],
        risk_level: 'low', classification_incomplete: false,
      },
    }))
    expect(legacy?.operation).toBe('upsert')
    if (legacy?.operation !== 'upsert') return
    expect(legacy.item.allowedActions.map((action) => action.id)).toEqual(['once', 'reject'])
  })

  test('rejects non-string risk levels even when JavaScript string coercion looks valid', () => {
    const malformed = projectAttentionEvent(row({
      capabilities: ['trusted_action_policy_v1'],
      payload: {
        request_id: 'request-risk-array',
        available_decisions: ['accept', 'acceptForSession', 'decline'],
        security_context: {
          schema_version: 1,
          risk_level: ['low'],
          classification_incomplete: false,
          risk_reasons: [],
          allowed_actions: ['once', 'always', 'reject'],
        },
      },
    }))
    expect(malformed?.operation).toBe('upsert')
    if (malformed?.operation !== 'upsert') return
    expect(malformed.item.riskLevel).toBe('high')
    expect(malformed.item.classificationIncomplete).toBe(true)
    expect(malformed.item.allowedActions.map((action) => action.id)).toEqual(['once', 'reject'])
  })

  test('projects questions with ordered schema and answer/reject actions', () => {
    const questions = [{
      id: 'mode', question: 'Choose mode', multiple: false, custom: false,
      options: [{ label: 'safe', description: 'Safe mode' }],
    }]
    const projection = projectAttentionEvent(row({
      eventType: 'question_request',
      payload: {
        type: 'question_request', session_id: 'session-1', request_id: 'question-1', questions,
        auto_resolution_ms: 60_000,
      },
    }))

    expect(projection).toEqual({
      operation: 'upsert',
      item: expect.objectContaining({
        kind: 'question',
        requestId: 'question-1',
        context: expect.objectContaining({ questions }),
        allowedActions: [
          expect.objectContaining({ id: 'answer' }),
          expect.objectContaining({ id: 'reject' }),
        ],
        expiresAt: new Date('2026-08-11T00:01:00.000Z'),
      }),
    })
  })

  test('removes answer when an oversized question schema cannot be persisted', () => {
    const projection = projectAttentionEvent(row({
      eventType: 'question_request',
      payload: {
        request_id: 'question-large',
        questions: Array.from({ length: 5 }, (_, index) => ({
          id: `secret-${index}`, question: 'x'.repeat(200_000), multiple: false, custom: true,
          options: [],
        })),
      },
    }))

    expect(projection?.operation).toBe('upsert')
    if (projection?.operation !== 'upsert') return
    expect(projection.item.context).toEqual({ context_truncated: true })
    expect(projection.item.allowedActions.map((action) => action.id)).toEqual(['reject'])
  })

  test('projects native resolution as a terminal state update without guessing the answering client', () => {
    expect(projectAttentionEvent(row({
      eventId: 11,
      eventType: 'approval_resolved',
      payload: {
        type: 'approval_resolved', session_id: 'session-1', request_id: 'request-1',
        action: 'reject', approved: false, reason: 'resolved_elsewhere',
      },
    }))).toEqual({
      operation: 'resolve',
      identity: {
        userId: 7, daemonId: 'daemon-1', sessionId: 'session-1',
        requestId: 'request-1', kind: 'approval',
      },
      resolutionEventId: 11,
      resolution: {
        action: 'reject', approved: false, reason: 'resolved_elsewhere', source: 'daemon',
      },
    })
  })

  test('skips Claude, unmanaged OpenCode questions, and incomplete ownership rows', () => {
    expect(projectAttentionEvent(row({ provider: 'claude-code' }))).toBeNull()
    expect(projectAttentionEvent(row({ provider: 'opencode', controlMode: 'legacy_read_only' }))).toBeNull()
    expect(projectAttentionEvent(row({ userId: null }))).toBeNull()
  })
})
