import { GIT_INPUT_LIMITS } from './paths.js'

export function decodeUtf8(bytes: Uint8Array): string {
  if (bytes.byteLength > GIT_INPUT_LIMITS.maxFileBytes) throw new Error('file_too_large')
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new Error('bom_not_allowed')
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { throw new Error('invalid_utf8') }
}

/** Bounded JSON grammar. JSON.parse is used only for an individual validated
 * string token, never on a document where duplicate keys could be overwritten. */
export function parseStrictJson(bytes: Uint8Array): unknown {
  const source = decodeUtf8(bytes)
  let offset = 0
  const invalid = (): never => { throw new Error('invalid_json') }
  const whitespace = () => { while (/[\x20\t\r\n]/.test(source[offset] ?? '\0')) offset++ }
  function string(): string {
    const start = offset++
    while (offset < source.length) {
      const ch = source[offset++]
      if (ch === '"') {
        let value: string
        try { value = JSON.parse(source.slice(start, offset)) as string } catch { return invalid() }
        if (/[\uD800-\uDFFF]/u.test(value)) throw new Error('invalid_unicode')
        return value
      }
      if (ch.charCodeAt(0) < 0x20) return invalid()
      if (ch === '\\') offset++
    }
    return invalid()
  }
  function value(depth: number): unknown {
    whitespace()
    const ch = source[offset]
    if (ch === '{' || ch === '[') {
      if (depth >= GIT_INPUT_LIMITS.maxDepth) throw new Error('document_too_deep')
      const object = ch === '{', close = object ? '}' : ']'
      offset++; whitespace()
      const entries: [string, unknown][] = [], values: unknown[] = [], keys = new Set<string>()
      if (source[offset] === close) { offset++; return object ? {} : [] }
      while (offset < source.length) {
        whitespace()
        if (object) {
          if (source[offset] !== '"') return invalid()
          const key = string()
          if (keys.has(key)) throw new Error('duplicate_json_key')
          keys.add(key); whitespace()
          if (source[offset++] !== ':') return invalid()
          entries.push([key, value(depth + 1)])
        } else values.push(value(depth + 1))
        whitespace()
        if (source[offset] === close) { offset++; return object ? Object.fromEntries(entries) : values }
        if (source[offset++] !== ',') return invalid()
      }
      return invalid()
    }
    if (ch === '"') return string()
    for (const [literal, result] of [['true', true], ['false', false], ['null', null]] as const) {
      if (source.startsWith(literal, offset)) { offset += literal.length; return result }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(offset))?.[0]
    if (number === undefined) return invalid()
    offset += number.length
    const parsed = Number(number)
    if (!Number.isFinite(parsed) || (Number.isInteger(parsed) && !Number.isSafeInteger(parsed))) throw new Error('invalid_number')
    return parsed
  }
  const result = value(0)
  whitespace()
  if (offset !== source.length) return invalid()
  return result
}

/** Enforce the same JSON domain on trusted input before serialization, including
 * cycles, lone surrogates and values JSON.stringify would silently discard. */
export function assertJsonValue(value: unknown, depth = 0): void {
  if (typeof value === 'string') {
    if (/[\uD800-\uDFFF]/u.test(value)) throw new Error('invalid_unicode')
  } else if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) throw new Error('invalid_number')
  } else if (value !== null && typeof value === 'object') {
    if (depth >= GIT_INPUT_LIMITS.maxDepth) throw new Error('document_too_deep')
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('invalid_json_value')
    for (const [key, child] of Object.entries(value)) { assertJsonValue(key, depth + 1); assertJsonValue(child, depth + 1) }
  } else if (value !== null && typeof value !== 'boolean') throw new Error('invalid_json_value')
}
