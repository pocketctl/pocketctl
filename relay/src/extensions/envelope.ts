import type { ExtensionTopic, ScopeControlTopic } from './types.js'
import { extensionTopicForEventType, isScopeControlTopic } from './types.js'

export const EXTENSION_ENVELOPE_VERSION = 1
export const EXTENSION_ENVELOPE_VERSION_V2 = 2
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

// --- extension-feed.v2 scope-control envelopes (ADR-0005 §5.2) ---------------

export interface ScopeOutboxRow {
  outbox_id: number | string
  scope_kind: 'team' | 'organization'
  scope_id: string
  topic: string
  payload: Record<string, unknown>
  recorded_at: Date | string
}

export interface ExtensionScopeFeedEnvelope {
  envelope_version: number
  feed_id: string
  topic: ScopeControlTopic
  owner_scope: {
    kind: 'team' | 'organization'
    id: string
    authorization_epoch: string
  }
  source: {
    kind: 'scope_membership' | 'scope_lifecycle' | 'scope_installation'
    id: string
    recorded_at: string
  }
  subject: {
    membership_id?: string
    event_type: string
  }
  classification: Record<string, never>
  data: Record<string, unknown>
}

/**
 * Build the v2 scope-control envelope from a scope-outbox row. The data
 * allowlist is opaque ids, state, roles, and revisions only (§5.2): no email,
 * display name, claim text, grant, token, or arbitrary metadata can pass.
 * Malformed or foreign payloads throw instead of degrading to a partial
 * envelope — the projector must fail closed.
 */
export function buildScopeFeedEnvelope(
  row: ScopeOutboxRow,
  feedId: number | string,
): ExtensionScopeFeedEnvelope {
  if (!isScopeControlTopic(row.topic)) {
    throw new Error(`scope feed envelope requires a control topic, got ${row.topic}`)
  }
  const payload = row.payload ?? {}
  const eventType = typeof payload.event_type === 'string' ? payload.event_type : ''
  if (!eventType) throw new Error('scope feed envelope requires an event_type')
  const epoch = Number(payload.authorization_epoch)
  if (!Number.isSafeInteger(epoch) || epoch < 1) {
    throw new Error('scope feed envelope requires a positive authorization_epoch')
  }

  const isMembership = row.topic === 'scope.membership.v2'
  if (isMembership && typeof payload.membership_id !== 'string') {
    throw new Error('membership envelopes require a membership_id')
  }
  const sourceId = isMembership
    ? payload.membership_id as string
    : row.scope_id

  const data: Record<string, unknown> = {}
  if (isMembership) {
    const revision = Number(payload.membership_revision)
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new Error('membership envelopes require a positive membership_revision')
    }
    if (typeof payload.state !== 'string') {
      throw new Error('membership envelopes require a state')
    }
    data.membership_revision = String(revision)
    data.state = payload.state
    data.roles = Array.isArray(payload.roles)
      ? payload.roles.filter((role): role is string => typeof role === 'string')
      : []
  } else if (row.topic === 'scope.lifecycle.v2') {
    if (typeof payload.state !== 'string') {
      throw new Error('lifecycle envelopes require a state')
    }
    data.state = payload.state
  } else {
    data.state = typeof payload.state === 'string' ? payload.state : 'active'
  }

  return {
    envelope_version: EXTENSION_ENVELOPE_VERSION_V2,
    feed_id: String(feedId),
    topic: row.topic,
    owner_scope: {
      kind: row.scope_kind,
      id: row.scope_id,
      authorization_epoch: String(epoch),
    },
    source: {
      kind: isMembership
        ? 'scope_membership'
        : row.topic === 'scope.lifecycle.v2' ? 'scope_lifecycle' : 'scope_installation',
      id: sourceId,
      recorded_at: new Date(row.recorded_at).toISOString(),
    },
    subject: {
      ...(isMembership ? { membership_id: payload.membership_id as string } : {}),
      event_type: eventType,
    },
    classification: {},
    data,
  }
}
