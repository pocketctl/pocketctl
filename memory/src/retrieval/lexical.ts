/**
 * Lexical document construction for claim search (plan §8 / Task 8). The
 * document carries the statement, claim type, bounded structured fields, and
 * repository/branch context — never raw event payloads or evidence bodies.
 */

const MAX_STRUCTURED_VALUE_CHARS = 200
const MAX_KEYWORDS = 16

export interface LexicalClaimInput {
  claimType: string
  statement: string
  structuredContent: Record<string, unknown>
  repositoryKey: string | null
  branch: string | null
}

export function buildSearchDocument(input: LexicalClaimInput): string {
  const parts: string[] = [input.statement.trim(), input.claimType.replace(/_/g, ' ')]
  if (input.repositoryKey) parts.push(input.repositoryKey)
  if (input.branch) parts.push(input.branch)

  // Bounded structured fields: short scalar values plus explicit keywords.
  const structured = input.structuredContent ?? {}
  for (const [key, value] of Object.entries(structured).slice(0, 12)) {
    if (key === 'keywords') continue
    if (typeof value === 'string' && value.length > 0 && value.length <= MAX_STRUCTURED_VALUE_CHARS) {
      parts.push(value)
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      parts.push(`${key} ${value}`)
    }
  }
  const keywords = Array.isArray(structured.keywords) ? structured.keywords : []
  for (const keyword of keywords.slice(0, MAX_KEYWORDS)) {
    if (typeof keyword === 'string' && keyword.length > 0 && keyword.length <= 64) {
      parts.push(keyword)
    }
  }
  const document = parts.filter(part => part.length > 0).join('\n')
  if (document.length === 0 || document.length > 20_000) {
    throw new Error(`search document out of bounds: ${document.length}`)
  }
  return document
}
