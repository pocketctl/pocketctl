/**
 * Stable event identity extraction (frozen priority):
 *   1. event_id
 *   2. message_id + part_id + revision
 *   3. call_id + event_type
 * Anything else has no stable identity; callers fall back to the origin
 * position instead of inventing one.
 */
export function extractCanonicalEventKey(data: Record<string, unknown> | null | undefined): string | null {
  if (typeof data !== 'object' || data === null) return null

  const eventId = data.event_id
  if (typeof eventId === 'string' && eventId.length > 0) {
    return `event_id:${eventId}`
  }

  const messageId = data.message_id
  const partId = data.part_id
  const revision = data.revision
  if (typeof messageId === 'string' && messageId.length > 0
    && typeof partId === 'string' && partId.length > 0
    && (typeof revision === 'number' || (typeof revision === 'string' && revision.length > 0))) {
    return `message:${messageId}:${partId}:${revision}`
  }

  const callId = data.call_id
  const eventType = data.event_type
  if (typeof callId === 'string' && callId.length > 0
    && typeof eventType === 'string' && eventType.length > 0) {
    return `call:${callId}:${eventType}`
  }

  return null
}
