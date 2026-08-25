/**
 * Local declaration of the extension-feed.v1 wire contract. Memory owns this
 * copy on purpose: importing relay/src at runtime is forbidden, so the DTOs
 * are frozen here and validated at the boundary (validation.ts).
 */
export type ExtensionTopic =
  | 'session.event.v1'
  | 'session.lifecycle.v1'
  | 'turn.lifecycle.v1'
  | 'session.deleted.v1'
  | 'session.access.revoked.v1'

export const EXTENSION_TOPICS: readonly ExtensionTopic[] = Object.freeze([
  'session.event.v1',
  'session.lifecycle.v1',
  'turn.lifecycle.v1',
  'session.deleted.v1',
  'session.access.revoked.v1',
])

export interface ExtensionFeedEnvelopeV1 {
  envelope_version: 1
  feed_id: string
  topic: ExtensionTopic
  source: { kind: string; id: string; recorded_at: string }
  subject: { session_id: string | null; turn_id?: string; event_type: string }
  classification: {
    actor_scope?: string
    flow_scope?: string
    content_class?: string
    classifier_version?: string
  }
  data: Record<string, unknown>
}

export interface FeedBatch {
  installation_id: string
  items: ExtensionFeedEnvelopeV1[]
  next_cursor: string
  lease_token: string
  lease_expires_at: string
}

export interface ProviderInstallationItem {
  installation_id: string
  status: 'pending' | 'active' | 'paused' | 'revoking' | 'revoked'
  config_version: string
  granted_scopes: string[]
  subscriptions: ExtensionTopic[]
  enabled_services: string[]
  event_filter: Record<string, unknown>
  snapshot_required: boolean
  created_at: string
  updated_at: string
}

export interface ProviderInstallationPage {
  installations: ProviderInstallationItem[]
  next_cursor: string | null
  has_more: boolean
}

export interface RelayExtensionClient {
  listInstallations(cursor?: string): Promise<ProviderInstallationPage>
  pullFeed(installationId: string, limit: number): Promise<FeedBatch>
  ackFeed(input: { installation_id: string; cursor: string; lease_token: string }): Promise<number>
  listSessions(installationId: string, cursor?: string): Promise<{
    sessions: Array<Record<string, unknown>>; next_cursor: string
  }>
  getSnapshot(installationId: string, sessionId: string, cursor?: string): Promise<{
    events: Array<Record<string, unknown>>; next_cursor: string
  }>
  acknowledgeReconcile(installationId: string): Promise<void>
  listPurges(): Promise<Array<Record<string, unknown>>>
  acknowledgePurge(requestId: string, receipt: string): Promise<void>
  reportStatus(input: Record<string, unknown>): Promise<void>
  reportUsage(installationId: string, facts: Array<Record<string, unknown>>): Promise<number>
}
