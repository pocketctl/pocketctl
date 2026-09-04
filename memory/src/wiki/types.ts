import { z } from 'zod'

/**
 * Phase 4 Living Wiki frozen contracts (ADR-0006 §5-§7). Wiki candidate
 * documents, build-run states, section authority, source binding kinds, and
 * the deterministic validation bounds all live here. Changes require a dated
 * ADR.
 */

export const WIKI_CANDIDATE_SCHEMA_VERSION = 'wiki-candidate.v1' as const
export type WikiCandidateSchemaVersion = typeof WIKI_CANDIDATE_SCHEMA_VERSION

/** Exactly one of these states may be active per Wiki (partial unique index). */
export const WIKI_BUILD_ACTIVE_STATES = ['queued', 'running', 'validating'] as const

export type WikiBuildRunState =
  | 'queued'
  | 'running'
  | 'validating'
  | 'candidate'
  | 'published'
  | 'failed'
  | 'superseded'
  | 'cancelled'
  | 'stale_generation'

export type WikiVersionState = 'active' | 'superseded' | 'purged'

/** Frozen section authority semantics (ADR-0006 §6). */
export type WikiSectionAuthority = 'generated' | 'manual' | 'locked'
export const WIKI_SECTION_AUTHORITIES: readonly WikiSectionAuthority[] = [
  'generated', 'manual', 'locked',
]

export type WikiSourceBindingKind = 'file' | 'symbol' | 'claim_version' | 'evidence'

export type WikiCoverage = 'complete' | 'partial' | 'unsupported' | 'degraded'

export type WikiStaleReason =
  | 'source_file_changed'
  | 'source_symbol_changed'
  | 'binding_removed'
  | 'graph_rebuilt'

/** Deterministic output bounds (plan §4.4). */
export const WIKI_MAX_PAGES = 32
export const WIKI_MAX_SECTIONS = 256
export const WIKI_MAX_SOURCE_CHARS = 200_000
export const WIKI_MAX_SECTION_HEADING_CHARS = 200
export const WIKI_MAX_PAGE_KEY_CHARS = 128

export const WikiSourceTokenSchema = z.string().min(1).max(256)

export const WikiCandidateSectionSchema = z.object({
  section_key: z.string().min(1).max(WIKI_MAX_PAGE_KEY_CHARS),
  heading: z.string().min(1).max(WIKI_MAX_SECTION_HEADING_CHARS),
  markdown: z.string().max(WIKI_MAX_SOURCE_CHARS),
  source_tokens: z.array(WikiSourceTokenSchema).min(1).max(64),
  coverage: z.enum(['complete', 'partial', 'unsupported', 'degraded']),
}).strict()

export const WikiCandidatePageSchema = z.object({
  page_key: z.string().min(1).max(WIKI_MAX_PAGE_KEY_CHARS),
  title: z.string().min(1).max(WIKI_MAX_SECTION_HEADING_CHARS),
  sections: z.array(WikiCandidateSectionSchema).min(1).max(WIKI_MAX_SECTIONS),
}).strict()

/**
 * Strict Wiki candidate document contract (plan §3.7). Every section carries
 * at least one build-issued opaque source token and an honest coverage label.
 * Unknown fields are rejected: a model may not extend its own schema.
 */
export const WikiCandidateDocumentSchema = z.object({
  schema_version: z.literal(WIKI_CANDIDATE_SCHEMA_VERSION),
  pages: z.array(WikiCandidatePageSchema).min(1).max(WIKI_MAX_PAGES),
}).strict()

export type WikiCandidateSection = z.infer<typeof WikiCandidateSectionSchema>
export type WikiCandidatePage = z.infer<typeof WikiCandidatePageSchema>
export type WikiCandidateDocumentV1 = z.infer<typeof WikiCandidateDocumentSchema>

/** Aggregated guard over the whole document, not just per-page slices. */
export function wikiCandidateSectionCount(document: WikiCandidateDocumentV1): number {
  return document.pages.reduce((total, page) => total + page.sections.length, 0)
}

export const WIKI_TOTAL_SECTION_LIMIT = WIKI_MAX_SECTIONS
