import { createHash } from 'crypto'

/**
 * Deterministic JSON serialization: object keys sorted recursively, arrays
 * order-significant, primitives via JSON.stringify. Two structurally equal
 * payloads always produce the same bytes — and therefore the same durable
 * inbox payload hash.
 */
export function canonicalJsonString(value: unknown): string {
  return serialize(value)
}

function serialize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null'
  }
  if (Array.isArray(value)) {
    return `[${value.map(entry => serialize(entry)).join(',')}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, v]) => `${JSON.stringify(key)}:${serialize(v)}`).join(',')}}`
}

/** SHA-256 digest of the canonical serialization. */
export function canonicalPayloadHash(value: unknown): Buffer {
  return createHash('sha256').update(canonicalJsonString(value), 'utf8').digest()
}
