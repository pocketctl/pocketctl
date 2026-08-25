import type { ExtensionTopic } from './types.js'
import { extensionTopicForEventType } from './types.js'

export const EXTENSION_ENVELOPE_VERSION = 1
export const SESSION_DELETED_SOURCE_KIND = 'session_deleted'
export const SESSION_ACCESS_REVOKED_SOURCE_KIND = 'session_access_revoked'

export interface ExtensionSourceRow {
  source_seq: number | string
  source_kind: string
  source_id: string
  owner_user_id: number | string
  session_id: string | null
  event_type: string
  occurred_at: Date | string | null
  payload: Record<string, unknown>
  created_at: Date | string
}

export interface ExtensionFeedEnvelope {
  envelope_version: number
  feed_id: string
  topic: ExtensionTopic
  source: {
    kind: string
    id: string
    recorded_at: string
  }
  subject: {
    session_id: string | null
    turn_id?: string
    event_type: string
  }
  classification: {
    actor_scope?: string
    flow_scope?: string
    content_class?: string
    classifier_version?: string
  }
  data: Record<string, unknown>
}

/**
 * Versioned pure mapping from a Source Journal row to its feed topics.
 * Tombstone kinds carry their own topic; every other source kind maps by
 * canonical event type with a fail-open default — a durable event must never
 * be silently dropped for postdating this mapping.
 */
export function extensionTopicForSource(
  row: Pick<ExtensionSourceRow, 'source_kind' | 'event_type'>,
): ExtensionTopic {
  if (row.source_kind === SESSION_DELETED_SOURCE_KIND) return 'session.deleted.v1'
  if (row.source_kind === SESSION_ACCESS_REVOKED_SOURCE_KIND) return 'session.access.revoked.v1'
  return extensionTopicForEventType(row.event_type)
}

/**
 * Build the shared, immutable feed envelope. The owner identity stays in the
 * feed row's (server-side filtered) owner_user_id column and never enters the
 * envelope; providers correlate through opaque installation-scoped delivery.
 */
export function buildFeedEnvelope(
  row: ExtensionSourceRow,
  feedId: number | string,
): ExtensionFeedEnvelope {
  const { envelope_version, ...rest } = buildStoredFeedPayload(row)
  return {
    envelope_version,
    feed_id: String(feedId),
    ...rest,
  }
}

/**
 * Stored projection payload: the envelope minus feed_id, which the BIGSERIAL
 * row assigns and the delivery path injects at read time.
 */
export function buildStoredFeedPayload(
  row: ExtensionSourceRow,
): Omit<ExtensionFeedEnvelope, 'feed_id'> {
  const payload = row.payload ?? {}
  const turnId = typeof payload.turn_id === 'string' && payload.turn_id
    ? payload.turn_id
    : typeof payload.source_turn_id === 'string' && payload.source_turn_id
      ? payload.source_turn_id
      : undefined
  const classification: ExtensionFeedEnvelope['classification'] = {}
  for (const key of ['actor_scope', 'flow_scope', 'content_class', 'classifier_version'] as const) {
    if (typeof payload[key] === 'string') classification[key] = payload[key] as string
  }
  return {
    envelope_version: EXTENSION_ENVELOPE_VERSION,
    topic: extensionTopicForSource(row),
    source: {
      kind: row.source_kind,
      id: row.source_id,
      recorded_at: new Date(row.created_at).toISOString(),
    },
    subject: {
      session_id: row.session_id,
      ...(turnId !== undefined ? { turn_id: turnId } : {}),
      event_type: row.event_type,
    },
    classification,
    data: payload,
  }
}
