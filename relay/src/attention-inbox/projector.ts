import { mapApprovalActions, mapQuestionActions } from './action-mapper.js'
import type {
  AttentionProjection,
  AttentionProvider,
  AttentionRiskLevel,
} from './types.js'

export interface AttentionEventRow {
  eventId: number
  eventType: string
  sessionId: string
  payload: Record<string, unknown>
  userId: number | null
  daemonId: string | null
  provider: string | null
  controlMode: string | null
  capabilities: string[]
  sessionTitle: string | null
  sessionStatus: string | null
  daemonAlias: string | null
  daemonHostname: string | null
  createdAt: Date
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

function supportedProvider(value: string | null): 'codex' | 'opencode' | null {
  return value === 'codex' || value === 'opencode' ? value : null
}

function riskLevel(payload: Record<string, unknown>): AttentionRiskLevel {
  const value = payload.risk_level
  return value === 'low' || value === 'medium' || value === 'high' || value === 'critical'
    ? value
    : 'high'
}

function classificationIncomplete(payload: Record<string, unknown>): boolean {
  return typeof payload.classification_incomplete === 'boolean'
    ? payload.classification_incomplete
    : true
}

interface TrustedSecurityContext {
  riskLevel: AttentionRiskLevel
  classificationIncomplete: boolean
  riskReasons: string[]
  allowedActions: string[]
}

const TRUSTED_RISK_REASONS = new Set([
  'executes_command',
  'changes_files',
  'requests_permissions',
  'requires_user_input',
])
const MAX_RISK_REASONS = 4

function riskReasons(payload: Record<string, unknown>): string[] {
  if (!Array.isArray(payload.risk_reasons)) return []
  const reasons: string[] = []
  for (const value of payload.risk_reasons) {
    if (typeof value !== 'string' || !TRUSTED_RISK_REASONS.has(value) || reasons.includes(value)) continue
    reasons.push(value)
    if (reasons.length === MAX_RISK_REASONS) break
  }
  return reasons
}

const TRUSTED_APPROVAL_ACTIONS = new Set(['once', 'always', 'reject', 'cancel'])

function trustedSecurityContext(row: AttentionEventRow): TrustedSecurityContext | null {
  if (!row.capabilities.includes('trusted_action_policy_v1')) return null
  const raw = row.payload.security_context
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const context = raw as Record<string, unknown>
  if (context.schema_version !== 1
    || typeof context.risk_level !== 'string'
    || !['low', 'medium', 'high', 'critical'].includes(context.risk_level)
    || typeof context.classification_incomplete !== 'boolean'
    || !Array.isArray(context.risk_reasons)
    || !Array.isArray(context.allowed_actions)) return null
  const allowedActions: string[] = []
  for (const value of context.allowed_actions) {
    if (typeof value !== 'string' || !TRUSTED_APPROVAL_ACTIONS.has(value) || allowedActions.includes(value)) continue
    allowedActions.push(value)
    if (allowedActions.length === 4) break
  }
  return {
    riskLevel: context.risk_level as AttentionRiskLevel,
    classificationIncomplete: context.classification_incomplete,
    riskReasons: riskReasons({ risk_reasons: context.risk_reasons }),
    allowedActions,
  }
}

function requestID(payload: Record<string, unknown>): string {
  return stringValue(payload.request_id)
}

const MAX_CONTEXT_BYTES = 128 * 1024
const MAX_CONTEXT_STRING_BYTES = 32 * 1024

function truncateString(value: string): string {
  const bytes = Buffer.from(value)
  return bytes.length <= MAX_CONTEXT_STRING_BYTES
    ? value
    : bytes.subarray(0, MAX_CONTEXT_STRING_BYTES).toString('utf8')
}

function boundedValue(value: unknown, depth = 0): unknown {
  if (depth > 12) return null
  if (typeof value === 'string') return truncateString(value)
  if (Array.isArray(value)) return value.slice(0, 64).map((entry) => boundedValue(entry, depth + 1))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 64)
        .map(([key, entry]) => [key, boundedValue(entry, depth + 1)]),
    )
  }
  return value
}

function boundedContext(context: Record<string, unknown>): Record<string, unknown> {
  const bounded = boundedValue(context) as Record<string, unknown>
  if (Buffer.byteLength(JSON.stringify(bounded)) <= MAX_CONTEXT_BYTES) return bounded
  return { context_truncated: true }
}

function contextFor(payload: Record<string, unknown>, kind: 'approval' | 'question') {
  if (kind === 'question') {
    return boundedContext({ questions: Array.isArray(payload.questions) ? payload.questions : [] })
  }
  return boundedContext({
    approval_kind: stringValue(payload.approval_kind),
    tool: stringValue(payload.tool),
    command: stringValue(payload.command),
    cwd: stringValue(payload.cwd),
    description: stringValue(payload.description),
    files: stringArray(payload.files),
    permission_name: stringValue(payload.permission_name),
    patterns: stringArray(payload.patterns),
    always_rules: stringArray(payload.always),
    input: payload.input ?? null,
    metadata: payload.metadata ?? null,
  })
}

function expiry(row: AttentionEventRow, kind: 'approval' | 'question'): Date | null {
  if (kind !== 'question') return null
  const milliseconds = row.payload.auto_resolution_ms
  if (typeof milliseconds !== 'number' || !Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    return null
  }
  return new Date(row.createdAt.getTime() + milliseconds)
}

function resolution(payload: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { source: 'daemon' }
  if (typeof payload.action === 'string') result.action = payload.action
  if (typeof payload.approved === 'boolean') result.approved = payload.approved
  if (typeof payload.rejected === 'boolean') result.rejected = payload.rejected
  if (typeof payload.reason === 'string') result.reason = payload.reason
  return result
}

export function projectAttentionEvent(row: AttentionEventRow): AttentionProjection | null {
  if (row.userId === null || !row.daemonId || !row.sessionId) return null
  const provider = supportedProvider(row.provider)
  if (provider === null) return null
  if (provider === 'opencode' && row.controlMode !== 'managed') return null
  const requestId = requestID(row.payload)
  if (!requestId) return null

  if (row.eventType === 'approval_resolved' || row.eventType === 'question_resolved') {
    const kind = row.eventType === 'approval_resolved' ? 'approval' : 'question'
    return {
      operation: 'resolve',
      identity: {
        userId: row.userId,
        daemonId: row.daemonId,
        sessionId: row.sessionId,
        requestId,
        kind,
      },
      resolutionEventId: row.eventId,
      resolution: resolution(row.payload),
    }
  }

  if (row.eventType !== 'approval_request' && row.eventType !== 'question_request') return null
  const kind = row.eventType === 'approval_request' ? 'approval' : 'question'
  const securityContext = kind === 'approval' ? trustedSecurityContext(row) : null
  const level = securityContext?.riskLevel ?? (kind === 'approval' && row.capabilities.includes('trusted_action_policy_v1') ? 'high' : riskLevel(row.payload))
  const incomplete = securityContext?.classificationIncomplete
    ?? (kind === 'approval' && row.capabilities.includes('trusted_action_policy_v1') ? true : classificationIncomplete(row.payload))
  const reasons = securityContext?.riskReasons ?? riskReasons(row.payload)
  const questions = Array.isArray(row.payload.questions) ? row.payload.questions : []
  const context = contextFor(row.payload, kind)
  let allowedActions = kind === 'approval'
    ? mapApprovalActions({
        provider,
        availableDecisions: stringArray(row.payload.available_decisions),
        alwaysRules: stringArray(row.payload.always),
        controlMode: row.controlMode,
        riskLevel: level,
        classificationIncomplete: incomplete,
        enforcedAllowedActions: securityContext?.allowedActions,
      })
    : mapQuestionActions({ provider, controlMode: row.controlMode, questions })
  // If the bounded projection had to discard the question schema, answering is
  // no longer safe: the client cannot construct a response against data that
  // was intentionally not persisted. Reject remains a valid fail-closed path.
  if (kind === 'question' && !Array.isArray(context.questions)) {
    allowedActions = allowedActions.filter((action) => action.id !== 'answer')
  }
  if (allowedActions.length === 0) return null

  return {
    operation: 'upsert',
    item: {
      userId: row.userId,
      daemonId: row.daemonId,
      sessionId: row.sessionId,
      requestId,
      provider,
      kind,
      riskLevel: level,
      classificationIncomplete: incomplete,
      riskReasons: reasons,
      title: kind === 'approval' ? 'Approval required' : 'Answer required',
      summary: row.sessionTitle || (kind === 'approval' ? 'Approval request' : 'Question request'),
      context,
      allowedActions,
      sourceEventId: row.eventId,
      sourceEventType: row.eventType,
      sourceEventKey: stringValue(row.payload.event_id) || null,
      expiresAt: expiry(row, kind),
      createdAt: row.createdAt,
    },
  }
}
