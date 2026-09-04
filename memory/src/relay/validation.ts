import {
  EXTENSION_TOPICS,
  SCOPE_CONTROL_TOPICS,
  type ExtensionFeedEnvelopeV1,
  type ExtensionScopeFeedEnvelopeV2,
  type ExtensionTopic,
  type FeedBatch,
  type ScopeControlFeedBatch,
} from './contracts.js'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type EnvelopeDecision =
  | { kind: 'accepted'; envelope: ExtensionFeedEnvelopeV1 }
  | { kind: 'quarantined'; errorCode: 'unsupported_envelope_version' | 'invalid_envelope' }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isIsoTimestamp(value: unknown): value is string {
  return isNonEmptyString(value) && !Number.isNaN(Date.parse(value))
}

/**
 * Boundary validation for one feed envelope. Unknown envelope versions are
 * quarantined with their own code so the row can be durably stored and acked
 * without ever being projected (invariant 9). Malformed v1 payloads quarantine
 * as invalid_envelope. Unknown event types stay accepted — they persist as
 * generic source events (invariant 8).
 */
export function classifyEnvelope(input: unknown): EnvelopeDecision {
  if (!isPlainObject(input)) return { kind: 'quarantined', errorCode: 'invalid_envelope' }
  if (typeof input.envelope_version !== 'number' || !Number.isInteger(input.envelope_version)) {
    return { kind: 'quarantined', errorCode: 'invalid_envelope' }
  }
  if (input.envelope_version !== 1) {
    return { kind: 'quarantined', errorCode: 'unsupported_envelope_version' }
  }
  const topic = input.topic
  if (!(EXTENSION_TOPICS as readonly string[]).includes(topic as string)) {
    return { kind: 'quarantined', errorCode: 'invalid_envelope' }
  }
  const source = input.source
  if (!isPlainObject(source)
    || !isNonEmptyString(source.kind)
    || !isNonEmptyString(source.id)
    || !isIsoTimestamp(source.recorded_at)) {
    return { kind: 'quarantined', errorCode: 'invalid_envelope' }
  }
  const subject = input.subject
  if (!isPlainObject(subject)
    || !(typeof subject.session_id === 'string' || subject.session_id === null)
    || !isNonEmptyString(subject.event_type)
    || (subject.turn_id !== undefined && !isNonEmptyString(subject.turn_id))) {
    return { kind: 'quarantined', errorCode: 'invalid_envelope' }
  }
  const classification = input.classification
  if (classification !== undefined && !isPlainObject(classification)) {
    return { kind: 'quarantined', errorCode: 'invalid_envelope' }
  }
  for (const key of ['actor_scope', 'flow_scope', 'content_class', 'classifier_version']) {
    const value = (classification as Record<string, unknown>)?.[key]
    if (value !== undefined && typeof value !== 'string') {
      return { kind: 'quarantined', errorCode: 'invalid_envelope' }
    }
  }
  if (!isPlainObject(input.data)) {
    return { kind: 'quarantined', errorCode: 'invalid_envelope' }
  }
  if (typeof input.feed_id !== 'string' || !/^[1-9][0-9]*$/.test(input.feed_id)) {
    return { kind: 'quarantined', errorCode: 'invalid_envelope' }
  }
  return {
    kind: 'accepted',
    envelope: input as unknown as ExtensionFeedEnvelopeV1,
  }
}

export type FeedBatchDecision =
  | { ok: true; batch: FeedBatch }
  | { ok: false; error: 'invalid_batch' }

/**
 * A feed batch is only valid as a whole: installation, cursor and lease
 * material must all be present and well-formed, because the inbox commits the
 * complete batch in one transaction. Individual envelope validity is decided
 * per row by classifyEnvelope.
 */
export function validateFeedBatch(input: unknown): FeedBatchDecision {
  if (!isPlainObject(input)) return { ok: false, error: 'invalid_batch' }
  if (!UUID_PATTERN.test(String(input.installation_id ?? ''))) {
    return { ok: false, error: 'invalid_batch' }
  }
  if (!Array.isArray(input.items)) return { ok: false, error: 'invalid_batch' }
  if (!isNonEmptyString(input.next_cursor)) return { ok: false, error: 'invalid_batch' }
  if (!isNonEmptyString(input.lease_token)) return { ok: false, error: 'invalid_batch' }
  if (!isIsoTimestamp(input.lease_expires_at)) return { ok: false, error: 'invalid_batch' }
  return { ok: true, batch: input as unknown as FeedBatch }
}

export function isExtensionTopic(value: unknown): value is ExtensionTopic {
  return typeof value === 'string' && (EXTENSION_TOPICS as readonly string[]).includes(value)
}

export type ScopeControlDecision =
  | { kind: 'accepted'; envelope: ExtensionScopeFeedEnvelopeV2 }
  | { kind: 'rejected'; errorCode: 'unsupported_envelope_version' | 'invalid_envelope' }

const SCOPE_ROLE_ALLOWLIST = new Set([
  'reader', 'contributor', 'reviewer', 'publisher',
  'policy_administrator', 'scope_administrator',
])
const MEMBERSHIP_STATE_ALLOWLIST = new Set(['invited', 'active', 'suspended', 'revoked'])
const SCOPE_STATE_ALLOWLIST = new Set(['active', 'suspended', 'dissolving', 'dissolved'])
const INSTALLATION_STATE_ALLOWLIST = new Set(['pending', 'active', 'paused', 'revoking', 'revoked'])

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allow = new Set(allowed)
  return Object.keys(value).every(key => allow.has(key))
}

/**
 * Boundary validation for one extension-feed.v2 scope-control envelope. The
 * data allowlist is opaque ids, state, roles, revisions, and epochs only
 * (§5.2); anything carrying user identity or arbitrary metadata is rejected.
 */
export function classifyScopeControlEnvelope(input: unknown): ScopeControlDecision {
  if (!isPlainObject(input)) return { kind: 'rejected', errorCode: 'invalid_envelope' }
  if (input.envelope_version !== 2) {
    return { kind: 'rejected', errorCode: 'unsupported_envelope_version' }
  }
  if (!(SCOPE_CONTROL_TOPICS as readonly string[]).includes(input.topic as string)) {
    return { kind: 'rejected', errorCode: 'invalid_envelope' }
  }
  if (typeof input.feed_id !== 'string' || !/^[1-9][0-9]*$/.test(input.feed_id)) {
    return { kind: 'rejected', errorCode: 'invalid_envelope' }
  }
  const ownerScope = input.owner_scope
  if (!isPlainObject(ownerScope)
    || !hasOnlyKeys(ownerScope, ['kind', 'id', 'authorization_epoch'])
    || (ownerScope.kind !== 'team' && ownerScope.kind !== 'organization')
    || !UUID_PATTERN.test(String(ownerScope.id ?? ''))
    || typeof ownerScope.authorization_epoch !== 'string'
    || !/^[1-9][0-9]*$/.test(ownerScope.authorization_epoch)) {
    return { kind: 'rejected', errorCode: 'invalid_envelope' }
  }
  const source = input.source
  if (!isPlainObject(source)
    || !hasOnlyKeys(source, ['kind', 'id', 'recorded_at'])
    || !isNonEmptyString(source.kind)
    || !UUID_PATTERN.test(String(source.id ?? ''))
    || !isIsoTimestamp(source.recorded_at)) {
    return { kind: 'rejected', errorCode: 'invalid_envelope' }
  }
  const subject = input.subject
  if (!isPlainObject(subject)
    || !hasOnlyKeys(subject, ['membership_id', 'event_type'])
    || !isNonEmptyString(subject.event_type)) {
    return { kind: 'rejected', errorCode: 'invalid_envelope' }
  }
  if (subject.membership_id !== undefined && !UUID_PATTERN.test(String(subject.membership_id))) {
    return { kind: 'rejected', errorCode: 'invalid_envelope' }
  }
  if (input.classification !== undefined
    && (!isPlainObject(input.classification) || Object.keys(input.classification).length > 0)) {
    return { kind: 'rejected', errorCode: 'invalid_envelope' }
  }
  const data = input.data
  if (!isPlainObject(data)) return { kind: 'rejected', errorCode: 'invalid_envelope' }
  if (input.topic === 'scope.membership.v2') {
    if (typeof subject.membership_id !== 'string') {
      return { kind: 'rejected', errorCode: 'invalid_envelope' }
    }
    if (typeof data.membership_revision !== 'string'
      || !/^[1-9][0-9]*$/.test(data.membership_revision)
      || typeof data.state !== 'string' || !MEMBERSHIP_STATE_ALLOWLIST.has(data.state)
      || !Array.isArray(data.roles)
      || data.roles.some(role => typeof role !== 'string' || !SCOPE_ROLE_ALLOWLIST.has(role))
      || new Set(data.roles).size !== data.roles.length
      || !hasOnlyKeys(data, ['membership_revision', 'state', 'roles'])
      || source.kind !== 'scope_membership'
      || source.id !== subject.membership_id) {
      return { kind: 'rejected', errorCode: 'invalid_envelope' }
    }
  } else if (input.topic === 'scope.lifecycle.v2') {
    if (typeof data.state !== 'string' || !SCOPE_STATE_ALLOWLIST.has(data.state)
      || !hasOnlyKeys(data, ['state'])
      || source.kind !== 'scope_lifecycle' || source.id !== ownerScope.id) {
      return { kind: 'rejected', errorCode: 'invalid_envelope' }
    }
  } else if (typeof data.state !== 'string' || !INSTALLATION_STATE_ALLOWLIST.has(data.state)
    || !hasOnlyKeys(data, ['state'])
    || source.kind !== 'scope_installation' || source.id !== ownerScope.id) {
    return { kind: 'rejected', errorCode: 'invalid_envelope' }
  }
  // PII can never ride inside the v2 allowlist.
  for (const forbidden of ['email', 'display_name', 'user_id']) {
    if (data[forbidden] !== undefined) return { kind: 'rejected', errorCode: 'invalid_envelope' }
  }
  return { kind: 'accepted', envelope: input as unknown as ExtensionScopeFeedEnvelopeV2 }
}

export type ScopeControlBatchDecision =
  | { ok: true; batch: ScopeControlFeedBatch }
  | { ok: false; error: 'invalid_batch' }

export function validateScopeControlBatch(input: unknown): ScopeControlBatchDecision {
  if (!isPlainObject(input)) return { ok: false, error: 'invalid_batch' }
  if (!UUID_PATTERN.test(String(input.installation_id ?? ''))) {
    return { ok: false, error: 'invalid_batch' }
  }
  if (!Array.isArray(input.items)) return { ok: false, error: 'invalid_batch' }
  if (input.items.some(item => classifyScopeControlEnvelope(item).kind === 'rejected')) {
    return { ok: false, error: 'invalid_batch' }
  }
  if (!isNonEmptyString(input.next_cursor)) return { ok: false, error: 'invalid_batch' }
  if (!isNonEmptyString(input.lease_token)) return { ok: false, error: 'invalid_batch' }
  if (!isIsoTimestamp(input.lease_expires_at)) return { ok: false, error: 'invalid_batch' }
  return { ok: true, batch: input as unknown as ScopeControlFeedBatch }
}
