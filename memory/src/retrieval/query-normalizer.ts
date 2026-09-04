import { createHash } from 'node:crypto'

/**
 * Deterministic text normalization for candidate identity and retrieval.
 * Normalization collapses layout noise but never erases case-sensitive code
 * identifiers: `verifyToken` and `verifytoken` stay distinct tokens so a
 * renamed symbol cannot silently merge two different facts.
 */

const IDENTIFIER_PATTERN = /^[$A-Za-z_][$$\w]*$/
const MAX_NORMALIZED_KEY_CHARS = 512

function boundedIdentityKey(value: string): string {
  const characters = Array.from(value)
  if (characters.length <= MAX_NORMALIZED_KEY_CHARS) return value
  const suffix = `|sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`
  return `${characters.slice(0, MAX_NORMALIZED_KEY_CHARS - suffix.length).join('')}${suffix}`
}

/** Split into display tokens; identifier-shaped tokens keep their case. */
export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^$$$\w]+/)
    .map(token => token.trim())
    .filter(token => token.length > 0)
}

/** Case-insensitive token multiset for similarity comparison. */
export function tokenFingerprint(text: string): ReadonlySet<string> {
  return new Set(tokenize(text).map(token => token.toLowerCase()))
}

/** Jaccard similarity over case-insensitive token fingerprints. */
export function tokenSimilarity(left: string, right: string): number {
  const a = tokenFingerprint(left)
  const b = tokenFingerprint(right)
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const token of a) if (b.has(token)) intersection++
  return intersection / (a.size + b.size - intersection)
}

/**
 * Deterministic identity key for a claim (exact-duplicate domain). Keeps
 * code-identifier case inside the statement component; only structural
 * whitespace and punctuation collapse.
 */
export function normalizedClaimKey(input: {
  claimType: string
  scopeKey: string
  statement: string
}): string {
  const compactStatement = input.statement
    .replace(/\s+/g, ' ')
    .trim()
  return boundedIdentityKey(`${input.claimType}|${input.scopeKey}|${compactStatement}`)
}

/**
 * Case-folded view of the same key for exact-duplicate matching of
 * natural-language statements while identifiers still distinguish in the
 * token layer.
 */
export function caseInsensitiveClaimKey(input: {
  claimType: string
  scopeKey: string
  statement: string
}): string {
  const compactStatement = input.statement
    .replace(/\s+/g, ' ')
    .trim()
  return boundedIdentityKey(`${input.claimType}|${input.scopeKey}|${compactStatement}`.toLowerCase())
}

export { IDENTIFIER_PATTERN }
