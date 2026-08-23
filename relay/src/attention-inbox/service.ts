import { createHmac } from 'node:crypto'

import type {
  AttentionActionClaim,
  AttentionActionRequest,
  AttentionInboxMode,
  AttentionInteractionCommand,
  AttentionInteractionRouteResult,
  AttentionItemRecord,
} from './types.js'

export interface AttentionActionRepository {
  claimAction(input: {
    userId: number
    itemId: string
    idempotencyKey: string
    requestHash: string
    request: AttentionActionRequest
  }): Promise<AttentionActionClaim>
  restoreSubmission(input: {
    userId: number
    itemId: string
    idempotencyKey: string
    errorCode: 'daemon_unreachable' | 'submission_failed' | 'answers_invalid'
  }): Promise<void>
}

export interface AttentionInteractionRouter {
  submitAttentionInboxInteraction(
    userId: number,
    command: AttentionInteractionCommand,
  ): Promise<AttentionInteractionRouteResult>
}

export type AttentionSubmissionResult =
  | { outcome: 'submitted'; receiptId: string; item: AttentionItemRecord; final: false }
  | { outcome: 'already_submitted'; receiptId: string; item: AttentionItemRecord; final: false }
  | { outcome: 'already_submitting'; item: AttentionItemRecord; final: false }
  | { outcome: 'resolved_elsewhere'; item: AttentionItemRecord; final: true }
  | {
      outcome: 'error'
      code:
        | 'feature_disabled'
        | 'remote_response_disabled'
        | 'item_not_found'
        | 'stale_revision'
        | 'idempotency_key_reused'
        | 'action_not_allowed'
        | 'provider_not_enabled'
        | 'answers_invalid'
        | 'daemon_unreachable'
        | 'submission_failed'
      item?: AttentionItemRecord
    }

function requestHash(request: AttentionActionRequest, secret: string): string {
  return createHmac('sha256', secret).update(JSON.stringify({
    expected_revision: request.expectedRevision,
    action_id: request.actionId,
    answers: request.answers ?? null,
  })).digest('hex')
}

function structurallyValidAnswers(answers: unknown): answers is string[][] {
  if (!Array.isArray(answers) || answers.length === 0 || answers.length > 16) return false
  return answers.every((selection) => Array.isArray(selection)
    && selection.length > 0
    && selection.length <= 64
    && selection.every((answer) => typeof answer === 'string'
      && answer.trim().length > 0
      && Buffer.byteLength(answer, 'utf8') <= 4096))
}

function validAnswersForItem(item: AttentionItemRecord, answers: string[][]): boolean {
  if (item.kind !== 'question') return false
  const questions = Array.isArray(item.context.questions) ? item.context.questions : []
  if (questions.length === 0 || questions.length !== answers.length || questions.length > 16) return false
  return questions.every((raw, index) => {
    if (!raw || typeof raw !== 'object') return false
    const question = raw as Record<string, unknown>
    const multiple = question.multiple === true
    if (!multiple && answers[index].length !== 1) return false
    const options = Array.isArray(question.options) ? question.options : []
    if (options.length > 64) return false
    const labels = new Set(options.map((option) => {
      if (typeof option === 'string') return option
      if (option && typeof option === 'object' && typeof (option as Record<string, unknown>).label === 'string') {
        return (option as Record<string, unknown>).label as string
      }
      return ''
    }).filter(Boolean))
    const custom = question.custom === true
    return answers[index].every((answer) => labels.has(answer) || custom)
  })
}

function commandFor(item: AttentionItemRecord, request: AttentionActionRequest): AttentionInteractionCommand | null {
  if (item.kind === 'approval') {
    if (request.actionId === 'answer') return null
    return {
      type: 'approval_response', session_id: item.sessionId,
      request_id: item.requestId, action: request.actionId,
    }
  }
  if (request.actionId === 'reject') {
    return { type: 'question_reject', session_id: item.sessionId, request_id: item.requestId }
  }
  if (request.actionId !== 'answer' || !request.answers) return null
  return {
    type: 'question_response', session_id: item.sessionId,
    request_id: item.requestId, answers: request.answers,
  }
}

export class AttentionInboxService {
  constructor(private readonly dependencies: {
    mode: AttentionInboxMode
    repository: AttentionActionRepository
    router: AttentionInteractionRouter
    requestHashSecret?: string
  }) {}

  async submitAction(input: {
    userId: number
    itemId: string
    idempotencyKey: string
    request: AttentionActionRequest
  }): Promise<AttentionSubmissionResult> {
    if (this.dependencies.mode === 'off') return { outcome: 'error', code: 'feature_disabled' }
    if (this.dependencies.mode !== 'on') return { outcome: 'error', code: 'remote_response_disabled' }
    if (input.request.actionId === 'answer' && !structurallyValidAnswers(input.request.answers)) {
      return { outcome: 'error', code: 'answers_invalid' }
    }

    let claim: AttentionActionClaim
    try {
      claim = await this.dependencies.repository.claimAction({
        ...input,
        requestHash: requestHash(input.request, this.dependencies.requestHashSecret ?? 'attention-inbox-test-only'),
      })
    } catch {
      return { outcome: 'error', code: 'submission_failed' }
    }
    switch (claim.outcome) {
      case 'not_found': return { outcome: 'error', code: 'item_not_found' }
      case 'stale_revision': return { outcome: 'error', code: claim.outcome, item: claim.item }
      case 'idempotency_key_reused': return { outcome: 'error', code: claim.outcome, item: claim.item }
      case 'action_not_allowed': return { outcome: 'error', code: claim.outcome, item: claim.item }
      case 'provider_not_enabled': return { outcome: 'error', code: claim.outcome, item: claim.item }
      case 'already_submitting': return { outcome: claim.outcome, item: claim.item, final: false }
      case 'resolved_elsewhere': return { outcome: claim.outcome, item: claim.item, final: true }
      case 'idempotent':
        if (claim.status === 'rejected') {
          const code = claim.errorCode === 'daemon_unreachable' || claim.errorCode === 'answers_invalid'
            ? claim.errorCode
            : 'submission_failed'
          return { outcome: 'error', code }
        }
        return { outcome: 'already_submitted', receiptId: claim.receiptId, item: claim.item, final: false }
      case 'claimed': break
    }

    if (input.request.actionId === 'answer'
      && (!input.request.answers || !validAnswersForItem(claim.item, input.request.answers))) {
      await this.dependencies.repository.restoreSubmission({
        userId: input.userId, itemId: input.itemId,
        idempotencyKey: input.idempotencyKey, errorCode: 'answers_invalid',
      })
      return { outcome: 'error', code: 'answers_invalid' }
    }
    const command = commandFor(claim.item, input.request)
    if (!command) {
      await this.dependencies.repository.restoreSubmission({
        userId: input.userId, itemId: input.itemId,
        idempotencyKey: input.idempotencyKey, errorCode: 'submission_failed',
      })
      return { outcome: 'error', code: 'submission_failed' }
    }

    let routed: AttentionInteractionRouteResult
    try {
      routed = await this.dependencies.router.submitAttentionInboxInteraction(input.userId, command)
    } catch {
      routed = { accepted: false, code: 'daemon_unreachable' }
    }
    if (!routed.accepted) {
      const errorCode = routed.code === 'daemon_unreachable' ? 'daemon_unreachable' : 'submission_failed'
      await this.dependencies.repository.restoreSubmission({
        userId: input.userId, itemId: input.itemId,
        idempotencyKey: input.idempotencyKey, errorCode,
      })
      return { outcome: 'error', code: errorCode }
    }
    return { outcome: 'submitted', receiptId: claim.receiptId, item: claim.item, final: false }
  }
}
