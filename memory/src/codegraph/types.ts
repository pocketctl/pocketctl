import { z } from 'zod'

/**
 * Phase 4 CodeGraph frozen contracts (ADR-0006). These constants and helpers
 * are the single authority for the parser matrix version, the language
 * capability matrix, upload limits, stable node keys, and canonical JSON
 * hashing. Changes require a dated ADR.
 */

export const PHASE4_PARSER_MATRIX_VERSION = 'phase4-v1' as const
export type ParserMatrixVersion = typeof PHASE4_PARSER_MATRIX_VERSION

/** Hard source limits from ADR-0006 §2 (frozen). */
export const CODE_SNAPSHOT_MAX_FILES = 5_000
export const CODE_SNAPSHOT_MAX_TOTAL_BYTES = 64 * 1024 * 1024
export const CODE_SNAPSHOT_MAX_FILE_BYTES = 256 * 1024
export const CODE_SNAPSHOT_MAX_REQUEST_BYTES = 1024 * 1024
export const CODE_SNAPSHOT_RETENTION_DAYS = 30

/** Bounded impact traversal defaults from ADR-0006 §4 (frozen). */
export const IMPACT_DEFAULT_DEPTH = 3
export const IMPACT_MAX_NODES = 500
export const IMPACT_MAX_EDGES = 2_000
export const IMPACT_SERVER_BUDGET_MS = 2_000

export const GitObjectFormatSchema = z.enum(['sha1', 'sha256'])
export type GitObjectFormat = z.infer<typeof GitObjectFormatSchema>

export type SourceSnapshotCapability = 'symbols_and_edges' | 'file_only'
export const SOURCE_SNAPSHOT_CAPABILITIES: readonly SourceSnapshotCapability[] = [
  'symbols_and_edges',
  'file_only',
]

export type SourceSnapshotState =
  | 'staging'
  | 'ready'
  | 'parsing'
  | 'active'
  | 'superseded'
  | 'failed'
  | 'purged'

export type CodeGraphVersionState =
  | 'candidate'
  | 'active'
  | 'superseded'
  | 'failed'
  | 'purged'

export type CodeNodeKind = 'repository' | 'file' | 'symbol' | 'external_package'

export type CodeEdgeKind =
  | 'definition'
  | 'reference'
  | 'import'
  | 'call'
  | 'dependency'
  | 'test'

export type CodeEdgeResolution = 'resolved' | 'unresolved' | 'dynamic'

export type GraphCoverage = 'complete' | 'partial' | 'unsupported' | 'degraded'

/**
 * Frozen language capability matrix (ADR-0006 §3). `symbols_and_edges` is
 * granted to exactly the TS/JS family; documentation/config and Go inputs are
 * bounded `file_only` Wiki evidence and never symbol-complete; everything
 * else is `unsupported` and excluded from snapshots.
 */
const SYMBOL_CAPABILITY_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs',
])

const FILE_ONLY_PATHS = new Set(['go.mod', 'go.sum'])
const FILE_ONLY_SUFFIXES = new Set([
  '.md', '.json', '.yaml', '.yml', '.sql', '.sh', '.go',
])

export const CODE_SYMBOL_EXTENSIONS: readonly string[] = [
  ...SYMBOL_CAPABILITY_EXTENSIONS,
].sort()

export const FILE_ONLY_EXTENSIONS: readonly string[] = [
  ...FILE_ONLY_SUFFIXES, ...FILE_ONLY_PATHS,
].sort()

export type LanguageCapability = SourceSnapshotCapability | 'unsupported'

export function languageCapabilityFor(path: string): LanguageCapability {
  const normalized = normalizeSourcePath(path)
  if (normalized === null) return 'unsupported'
  const segments = normalized.split('/')
  const file = segments[segments.length - 1]!
  if (SYMBOL_CAPABILITY_EXTENSIONS.has(extensionOf(file))) {
    return 'symbols_and_edges'
  }
  if (FILE_ONLY_PATHS.has(file) || FILE_ONLY_SUFFIXES.has(extensionOf(file))) {
    return 'file_only'
  }
  return 'unsupported'
}

function extensionOf(file: string): string {
  const dot = file.lastIndexOf('.')
  if (dot <= 0) return ''
  return file.slice(dot).toLowerCase()
}

/**
 * Normalized relative POSIX source path or null when the path is ambiguous.
 * Rejects NUL bytes, backslashes, absolute roots, empty components, `.`/`..`
 * traversal, and non-normalized Unicode.
 */
export function normalizeSourcePath(path: string): string | null {
  if (path.length === 0 || path.length > 1024) return null
  if (path.includes('\0') || path.includes('\\')) return null
  if (!/^[ -~]+$/.test(path)) {
    // Restrict to printable ASCII to guarantee byte-stable normalization.
    return null
  }
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return null
  const segments = path.split('/')
  for (const segment of segments) {
    if (segment.length === 0) return null
    if (segment === '.' || segment === '..') return null
  }
  if (path.endsWith('/')) return null
  return path
}

/** Frozen stable node keys (ADR-0006 / plan §3.5). */
export function stableFileKey(path: string): string {
  return `file:${path}`
}

export function stableSymbolKey(
  path: string,
  fullyQualifiedName: string,
  symbolKind: string,
  startLine: number,
): string {
  return `symbol:${path}#${fullyQualifiedName}:${symbolKind}:${startLine}`
}

export function stableExternalPackageKey(packageName: string): string {
  return `external:${packageName}`
}

export function stableRepositoryKey(repositoryId: string, commitSha: string): string {
  return `repo:${repositoryId}@${commitSha}`
}

/**
 * Deterministic canonical JSON: object keys sorted lexicographically, no
 * insignificant whitespace. Two structurally equal values always serialize to
 * identical bytes, which is what graph content hashing requires.
 */
export function canonicalJsonStringify(value: unknown): string {
  return serializeCanonical(value)
}

function serializeCanonical(value: unknown): string {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map(item => serializeCanonical(item)).join(',')}]`
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${serializeCanonical(item)}`).join(',')}}`
  }
  throw new Error(`canonical json cannot serialize ${typeof value}`)
}

export const BlobHashSchema = z.string().regex(/^[0-9a-f]{64}$/)
export const CommitShaSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
export const ManifestHashSchema = z.string().regex(/^[0-9a-f]{64}$/)
