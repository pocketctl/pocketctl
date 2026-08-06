const postgresNUL = /\u0000/g

/**
 * PostgreSQL JSONB rejects a Unicode NUL even though JSON.stringify can encode
 * it. Daemon events may contain arbitrary terminal output, so normalize the
 * value before it reaches an inbox, event ledger, or other JSONB column.
 */
export function sanitizeJSONBPayload<T>(value: T): T {
  if (typeof value === 'string') return value.replace(postgresNUL, '\uFFFD') as T
  if (Array.isArray(value)) return value.map((item) => sanitizeJSONBPayload(item)) as T
  if (!value || typeof value !== 'object') return value

  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = sanitizeJSONBPayload(item)
  }
  return result as T
}
