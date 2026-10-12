import { useAuth } from '../composables/useAuth'
import { getRelayOrigin } from '../composables/useEnv'
import type {
  AttentionActionID,
  AttentionInboxActionResponse,
  AttentionInboxItem,
  AttentionInboxItemResponse,
  AttentionInboxScope,
  AttentionInboxSnapshot,
  AttentionInboxState,
  AttentionMetadataOperation,
  AttentionRecoveryItem,
  AttentionRecoveryResponse,
  SystemNotificationPage,
  SystemNotification,
  NotificationSubjectPage,
  LifecycleNotificationSubject,
} from '../types/attentionInbox'

interface ErrorEnvelope {
  error?: {
    code?: string
    message?: string
    retryable?: boolean
    current_item?: AttentionInboxItem
    current_recovery?: AttentionRecoveryItem
  }
}

function notificationQuery(scope: AttentionInboxScope, cursor?: string | null): string {
  const query = new URLSearchParams({ limit: '50' })
  if (scope.type === 'daemon') query.set('daemon_id', scope.daemonId)
  if (cursor) query.set('cursor', cursor)
  return query.toString()
}

export function listSystemNotifications(scope: AttentionInboxScope, cursor?: string | null): Promise<SystemNotificationPage> {
  return request(`/api/attention/notifications?${notificationQuery(scope, cursor)}`, { method: 'GET' })
}
export function getSystemNotification(id: string, scope: AttentionInboxScope): Promise<{ notification: SystemNotification }> {
  return request(`/api/attention/notifications/${encodeURIComponent(id)}?${notificationQuery(scope)}`, { method: 'GET' })
}
export function listNotificationSubjects(id: string, scope: AttentionInboxScope, cursor?: string | null): Promise<NotificationSubjectPage> {
  return request(`/api/attention/notifications/${encodeURIComponent(id)}/subjects?${notificationQuery(scope, cursor)}`, { method: 'GET' })
}
export function getNotificationSubject(id: string, subjectId: string, scope: AttentionInboxScope): Promise<{ subject: LifecycleNotificationSubject }> {
  return request(`/api/attention/notifications/${encodeURIComponent(id)}/subjects/${encodeURIComponent(subjectId)}?${notificationQuery(scope)}`, { method: 'GET' })
}
export function markSystemNotificationRead(id: string, revision: number, scope: AttentionInboxScope): Promise<{ status: 'read' }> {
  return request(`/api/attention/notifications/${encodeURIComponent(id)}/read?${notificationQuery(scope)}`, {
    method: 'POST', body: JSON.stringify({ expected_revision: revision }),
  })
}

export class AttentionInboxApiError extends Error {
  readonly status: number
  readonly code: string
  readonly retryable: boolean
  readonly item?: AttentionInboxItem
  readonly recovery?: AttentionRecoveryItem

  constructor(status: number, body: ErrorEnvelope) {
    const error = body.error ?? {}
    super(error.message || 'Attention Inbox request failed')
    this.name = 'AttentionInboxApiError'
    this.status = status
    this.code = error.code || 'request_failed'
    this.retryable = error.retryable === true
    this.item = error.current_item
    this.recovery = error.current_recovery
  }
}

function endpoint(path: string): string {
  return `${getRelayOrigin()}${path}`
}

async function request<T>(path: string, init: RequestInit, allowRefresh = true): Promise<T> {
  const { accessToken, doRefreshToken } = useAuth()
  const headers = new Headers(init.headers)
  headers.set('Accept', 'application/json')
  if (init.body !== undefined) headers.set('Content-Type', 'application/json')
  if (accessToken.value) headers.set('Authorization', `Bearer ${accessToken.value}`)

  let response: Response
  try {
    response = await fetch(endpoint(path), { ...init, headers: Object.fromEntries(headers.entries()), credentials: 'include' })
  } catch {
    throw new AttentionInboxApiError(0, {
      error: { code: 'network_error', message: 'Network request failed', retryable: true },
    })
  }
  if (response.status === 401 && allowRefresh && await doRefreshToken()) {
    return request<T>(path, init, false)
  }
  let body: unknown = {}
  try { body = await response.json() } catch {}
  if (!response.ok) throw new AttentionInboxApiError(response.status, body as ErrorEnvelope)
  return body as T
}

export interface ListAttentionInboxInput {
  scope: AttentionInboxScope
  states?: AttentionInboxState[]
  cursor?: string | null
  limit?: number
}

export function listAttentionInbox(input: ListAttentionInboxInput): Promise<AttentionInboxSnapshot> {
  const query = new URLSearchParams()
  query.set('scope', input.scope.type)
  if (input.scope.type === 'daemon') query.set('daemon_id', input.scope.daemonId)
  if (input.states?.length) query.set('states', input.states.join(','))
  if (input.cursor) query.set('cursor', input.cursor)
  if (input.limit !== undefined) query.set('limit', String(input.limit))
  return request(`/api/attention-inbox/v2/items?${query.toString()}`, { method: 'GET' })
}

export interface MutateAttentionRecoveryInput {
  recoveryId: string
  expectedRevision: number
  operation: AttentionMetadataOperation
  snoozedUntil?: string
}

export function mutateAttentionRecovery(input: MutateAttentionRecoveryInput): Promise<AttentionRecoveryResponse> {
  return request(`/api/attention-inbox/v2/recovery-items/${encodeURIComponent(input.recoveryId)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      expected_revision: input.expectedRevision,
      operation: input.operation,
      ...(input.snoozedUntil ? { snoozed_until: input.snoozedUntil } : {}),
    }),
  })
}

export interface MutateAttentionItemInput {
  itemId: string
  expectedRevision: number
  operation: AttentionMetadataOperation
  snoozedUntil?: string
}

export function mutateAttentionItem(input: MutateAttentionItemInput): Promise<AttentionInboxItemResponse> {
  return request(`/api/attention-inbox/v1/items/${encodeURIComponent(input.itemId)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      expected_revision: input.expectedRevision,
      operation: input.operation,
      ...(input.snoozedUntil ? { snoozed_until: input.snoozedUntil } : {}),
    }),
  })
}

export interface SubmitAttentionActionInput {
  itemId: string
  expectedRevision: number
  actionId: AttentionActionID
  answers?: string[][]
  idempotencyKey: string
}

export function submitAttentionAction(input: SubmitAttentionActionInput): Promise<AttentionInboxActionResponse> {
  return request(`/api/attention-inbox/v1/items/${encodeURIComponent(input.itemId)}/actions`, {
    method: 'POST',
    headers: { 'Idempotency-Key': input.idempotencyKey },
    body: JSON.stringify({
      expected_revision: input.expectedRevision,
      action_id: input.actionId,
      ...(input.answers ? { answers: input.answers } : {}),
    }),
  })
}
