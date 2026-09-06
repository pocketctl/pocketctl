import { describe, expect, test, vi } from 'vitest'
import { AttentionInboxService } from '../attention-inbox/service.js'
import type { AttentionItemRecord } from '../attention-inbox/types.js'

function item(overrides: Partial<AttentionItemRecord> = {}): AttentionItemRecord {
  const now = new Date('2026-08-11T08:00:00.000Z')
  return {
    itemId: '11111111-1111-4111-8111-111111111111', userId: 7,
    daemonId: 'd1', sessionId: 's1', requestId: 'r1', provider: 'codex',
    kind: 'approval', state: 'submitting', revision: 2, riskLevel: 'high',
    classificationIncomplete: true, riskReasons: ['executes_command'], title: 'Approval required', summary: 'Run command',
    context: {}, allowedActions: [{ id: 'once', style: 'primary', destructive: false, labelKey: 'once' }],
    seenAt: null, snoozedUntil: null, submittedAt: now, resolvedAt: null,
    handledAt: null, expiresAt: null, resolution: null, lastErrorCode: null,
    createdAt: now, updatedAt: now, ...overrides,
  }
}

function service(options: {
  mode?: 'off' | 'observe' | 'on'
  claim?: any
  route?: any
} = {}) {
  const claimed = options.claim ?? { outcome: 'claimed', item: item(), receiptId: '42' }
  const repository = {
    claimAction: vi.fn(async () => claimed),
    restoreSubmission: vi.fn(async () => undefined),
  }
  const router = {
    submitAttentionInboxInteraction: vi.fn(async () => options.route ?? { accepted: true }),
  }
  return {
    value: new AttentionInboxService({
      mode: options.mode ?? 'on', repository, router,
    }),
    repository,
    router,
  }
}

describe('Attention Inbox action service', () => {
  test.each([
    ['off', 'feature_disabled'],
    ['observe', 'remote_response_disabled'],
  ] as const)('fails closed in %s mode', async (mode, code) => {
    const subject = service({ mode })
    await expect(subject.value.submitAction({
      userId: 7, itemId: 'i1', idempotencyKey: '11111111-1111-4111-8111-111111111111',
      request: { expectedRevision: 1, actionId: 'once' },
    })).resolves.toEqual({ outcome: 'error', code })
    expect(subject.repository.claimAction).not.toHaveBeenCalled()
  })

  test('claims and submits without treating daemon acceptance as final resolution', async () => {
    const subject = service()
    const result = await subject.value.submitAction({
      userId: 7, itemId: 'i1', idempotencyKey: '11111111-1111-4111-8111-111111111111',
      request: { expectedRevision: 1, actionId: 'once' },
    })

    expect(result).toEqual(expect.objectContaining({ outcome: 'submitted', final: false, receiptId: '42' }))
    expect(subject.router.submitAttentionInboxInteraction).toHaveBeenCalledWith(7, {
      type: 'approval_response', session_id: 's1', request_id: 'r1', action: 'once',
    })
  })

  test('does not route an idempotent replay or resolved race', async () => {
    for (const claim of [
      { outcome: 'idempotent', item: item(), receiptId: '42', status: 'accepted' },
      { outcome: 'resolved_elsewhere', item: item({ state: 'resolved' }) },
    ]) {
      const subject = service({ claim })
      const result = await subject.value.submitAction({
        userId: 7, itemId: 'i1', idempotencyKey: '11111111-1111-4111-8111-111111111111',
        request: { expectedRevision: 1, actionId: 'once' },
      })
      expect(result.outcome).toBe(claim.outcome === 'idempotent' ? 'already_submitted' : 'resolved_elsewhere')
      expect(subject.router.submitAttentionInboxInteraction).not.toHaveBeenCalled()
    }
  })

  test('replays the original known failure for a rejected idempotency receipt', async () => {
    const subject = service({ claim: {
      outcome: 'idempotent', item: item({ state: 'open' }), receiptId: '42',
      status: 'rejected', errorCode: 'daemon_unreachable',
    } })
    const result = await subject.value.submitAction({
      userId: 7, itemId: 'i1', idempotencyKey: '11111111-1111-4111-8111-111111111111',
      request: { expectedRevision: 1, actionId: 'once' },
    })
    expect(result).toEqual({ outcome: 'error', code: 'daemon_unreachable' })
    expect(subject.router.submitAttentionInboxInteraction).not.toHaveBeenCalled()
  })

  test('restores the prior actionable state when the daemon is unreachable', async () => {
    const subject = service({ route: { accepted: false, code: 'daemon_unreachable' } })
    const result = await subject.value.submitAction({
      userId: 7, itemId: 'i1', idempotencyKey: '11111111-1111-4111-8111-111111111111',
      request: { expectedRevision: 1, actionId: 'once' },
    })

    expect(result).toEqual({ outcome: 'error', code: 'daemon_unreachable' })
    expect(subject.repository.restoreSubmission).toHaveBeenCalledWith({
      userId: 7, itemId: 'i1', idempotencyKey: '11111111-1111-4111-8111-111111111111',
      errorCode: 'daemon_unreachable',
    })
  })

  test('preserves observer_read_only through routing, restoration, and the public service result', async () => {
    const subject = service({ route: { accepted: false, code: 'observer_read_only' } })
    const result = await subject.value.submitAction({
      userId: 7, itemId: 'i1', idempotencyKey: '11111111-1111-4111-8111-111111111111',
      request: { expectedRevision: 1, actionId: 'once' },
    })

    expect(result).toEqual({ outcome: 'error', code: 'observer_read_only' })
    expect(subject.repository.restoreSubmission).toHaveBeenCalledWith({
      userId: 7, itemId: 'i1', idempotencyKey: '11111111-1111-4111-8111-111111111111',
      errorCode: 'observer_read_only',
    })
  })

  test('replays a persisted observer_read_only rejection without routing again', async () => {
    const subject = service({ claim: {
      outcome: 'idempotent', item: item({ state: 'open' }), receiptId: '42',
      status: 'rejected', errorCode: 'observer_read_only',
    } })

    const result = await subject.value.submitAction({
      userId: 7, itemId: 'i1', idempotencyKey: '11111111-1111-4111-8111-111111111111',
      request: { expectedRevision: 1, actionId: 'once' },
    })

    expect(result).toEqual({ outcome: 'error', code: 'observer_read_only' })
    expect(subject.router.submitAttentionInboxInteraction).not.toHaveBeenCalled()
  })

  test('validates question answers before claiming and never logs or persists answer text', async () => {
    const subject = service()
    const result = await subject.value.submitAction({
      userId: 7, itemId: 'i1', idempotencyKey: '11111111-1111-4111-8111-111111111111',
      request: { expectedRevision: 1, actionId: 'answer', answers: [] },
    })
    expect(result).toEqual({ outcome: 'error', code: 'answers_invalid' })
    expect(subject.repository.claimAction).not.toHaveBeenCalled()
  })
})
