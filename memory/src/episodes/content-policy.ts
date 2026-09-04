/**
 * Deny-by-default content policy for Episode Packets. Every field that
 * reaches the model-facing document passes through `sanitizeText`, which
 * redacts known secret shapes, collapses whitespace, and truncates with
 * hash/length metadata for the omitted bytes. Absolute paths are display-only
 * and never become repository identity.
 */

import { createHash } from 'crypto'

export const PACKET_POLICY_VERSION = 'episode-packet-policy-v2'
/** ADR-P3-06: per-item cap for re-redacted shared evidence copies. */
export const SHARED_EVIDENCE_MAX_CHARS = 4000

export interface SanitizedText {
  text: string
  truncated: boolean
  originalLength: number
  originalHash: string
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(sk|pk|rk)-[A-Za-z0-9]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g,
  /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/g,
  /["']?\b(?:password|passwd|secret|token|api[_-]?key|auth[_-]?code|authorization)\b["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}&]{4,})/gi,
]

/** Redact known secret/token shapes; never log or echo the original. */
export function redactSecrets(text: string): string {
  let redacted = text
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, match => {
      const name = /\b(password|passwd|secret|token|api[_-]?key|auth[_-]?code|authorization)\b/i.exec(match)
      return name ? `${name[1]}=[redacted]` : '[redacted]'
    })
  }
  return redacted
}

export function sanitizeText(raw: string, maxChars: number): SanitizedText {
  const collapsed = raw.replace(/\s+/g, ' ').trim()
  const redacted = minimizeAbsolutePaths(redactSecrets(collapsed))
  // This digest leaves PocketCtl in evidence manifests and handles. Hash the
  // redacted representation, never the original secret-bearing bytes.
  const originalHash = createHash('sha256').update(redacted, 'utf8').digest('hex').slice(0, 16)
  if (redacted.length <= maxChars) {
    return { text: redacted, truncated: false, originalLength: raw.length, originalHash }
  }
  return {
    text: `${redacted.slice(0, Math.max(0, maxChars - 1))}…`,
    truncated: true,
    originalLength: raw.length,
    originalHash,
  }
}

/**
 * Minimize absolute filesystem paths embedded anywhere in free text. URLs are
 * intentionally left alone except for file URIs; Unix, drive-letter and UNC
 * paths retain at most their final two segments, matching structured fields.
 */
export function minimizeAbsolutePaths(text: string): string {
  const fileUri = /\bfile:\/{2,}([^\s"'()\[\]{},;]+)/gi
  const editorUri = /\b(?:vscode(?:-insiders)?|idea):\/\/([^\s"'()\[\]{},;]+)/gi
  const quotedAbsolute = /(["'])((?:\/(?!\/)|[A-Za-z]:[\\/])[^"']+)\1/g
  // Minimize URI and quoted paths while their complete boundaries are still
  // visible. The remaining pass redacts home-directory identities even when a
  // malformed/unclosed quote prevents reliable path parsing.
  const withoutHomeIdentity = text
    .replace(fileUri, (_match, path: string) => `[file:${basenameOnly(path)}]`)
    .replace(editorUri, (_match, path: string) => `[editor:${basenameOnly(path)}]`)
    .replace(quotedAbsolute, (_match, quote: string, path: string) => `${quote}${basenameOnly(path)}${quote}`)
    .replace(/(\/(?:Users|home)\/)[^/\\\s"']+/g, '$1[user]')
    .replace(/([A-Za-z]:[\\/]Users[\\/])[^\\/\s"']+/gi, '$1[user]')
  const boundary = '(^|[\\s"\'`([{=,:])'
  const unix = new RegExp(`${boundary}((?:\\/(?!\\/)[^\\s"'(){},;]+){2,})`, 'g')
  const drive = new RegExp(`${boundary}([A-Za-z]:[\\\\/](?:[^\\\\/\\s"'(){},;]+[\\\\/])+[^\\\\/\\s"'(){},;]+)`, 'g')
  const unc = new RegExp(`${boundary}(\\\\\\\\[^\\\\/\\s"'(){},;]+[\\\\/][^\\s"'(){},;]+)`, 'g')
  const minimize = (_match: string, prefix: string, path: string) => `${prefix}${basenameOnly(path)}`
  return withoutHomeIdentity
    .replace(drive, minimize)
    .replace(unc, minimize)
    .replace(unix, minimize)
}

/**
 * Field-level allowlist per canonical event type. Unknown event types and
 * unknown fields are dropped entirely (deny by default); only these bounded
 * fields may ever become packet statements.
 */
const EVENT_FIELD_ALLOWLIST: Readonly<Record<string, readonly string[]>> = Object.freeze({
  user_message: ['text'],
  agent_text: ['text'],
  user_goal: ['text'],
  tool_call: ['tool', 'call_id', 'status', 'summary'],
  tool_result: ['call_id', 'status', 'summary'],
  file_change: ['file_path', 'path', 'change_type', 'lines_added', 'lines_removed'],
  diff: ['file_path', 'path', 'change_type', 'lines_added', 'lines_removed'],
  test_result: ['test_run_id', 'call_id', 'name', 'status'],
  ci_result: ['name', 'status', 'conclusion'],
  approval: ['approval_id', 'call_id', 'status'],
  command: ['command_id', 'status'],
  correction: ['text'],
  retry: ['text'],
  turn_status: ['turn_status', 'status', 'turn_reason', 'reason'],
  session_status: ['status'],
  code_symbol: ['symbol', 'file_path', 'path', 'kind'],
  user_correction: ['text'],
  hypothesis_rejected: ['text'],
})

export function allowedEventFields(eventType: string): readonly string[] {
  return EVENT_FIELD_ALLOWLIST[eventType] ?? []
}

/** Render an allowlisted payload subset as a bounded, ordered description. */
export function describeEvent(
  eventType: string,
  data: Record<string, unknown>,
  maxChars: number,
): SanitizedText {
  const allowed = allowedEventFields(eventType)
  const parts: string[] = [eventType]
  for (const field of allowed) {
    const value = data?.[field]
    if (value === undefined || value === null || value === '') continue
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      // Path-like fields are basename-only: the packet may leave PocketCtl,
      // so absolute layouts must not travel with it.
      const rendered = (field === 'file_path' || field === 'path') && typeof value === 'string'
        ? basenameOnly(value)
        : String(value)
      parts.push(`${field}=${rendered}`)
    }
  }
  return sanitizeText(parts.join(' '), maxChars)
}

/** Bases for absolute paths: display only, never repository identity. */
export function basenameOnly(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const segments = normalized.split('/').filter(segment => segment.length > 0)
  return segments.slice(-2).join('/')
}

/**
 * ADR-P3-06 shared-evidence re-redaction. Every promotion copy passes
 * through this wrapper: secrets are stripped, absolute paths minimized, and
 * the excerpt hard-capped at 4,000 characters before it ever lands in a
 * target installation. Returns null when nothing survives redaction.
 */
export function sanitizeSharedEvidenceExcerpt(raw: string): {
  text: string
  excerptHash: string
} | null {
  const sanitized = sanitizeText(raw, SHARED_EVIDENCE_MAX_CHARS)
  if (sanitized.text.length === 0) return null
  return {
    text: sanitized.text,
    excerptHash: createHash('sha256').update(sanitized.text, 'utf8').digest('hex'),
  }
}
