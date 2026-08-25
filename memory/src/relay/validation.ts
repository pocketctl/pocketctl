import {
  EXTENSION_TOPICS,
  type ExtensionFeedEnvelopeV1,
  type ExtensionTopic,
  type FeedBatch,
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
