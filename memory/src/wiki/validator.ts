import {
  WIKI_TOTAL_SECTION_LIMIT,
  WikiCandidateDocumentSchema,
  wikiCandidateSectionCount,
  type WikiCandidateDocumentV1,
  type WikiCoverage,
} from './types.js'
import type { WikiBuildSource } from './repository.js'

export type WikiValidationErrorCode =
  | 'invalid_schema'
  | 'too_many_sections'
  | 'duplicate_page_key'
  | 'duplicate_section_key'
  | 'duplicate_source_token'
  | 'unknown_source_token'
  | 'source_snapshot_mismatch'
  | 'source_commit_mismatch'
  | 'coverage_overclaim'

export type WikiValidationResult =
  | { ok: true; document: WikiCandidateDocumentV1 }
  | { ok: false; code: WikiValidationErrorCode }

/** Resolve every model citation against the immutable build registry. */
export function validateWikiCandidate(input: {
  document: unknown
  sources: readonly WikiBuildSource[]
  expectedSnapshotId: string
  expectedCommitSha: string
  expectedCoverage: WikiCoverage
  maxPages?: number
  maxSections?: number
}): WikiValidationResult {
  const parsed = WikiCandidateDocumentSchema.safeParse(input.document)
  if (!parsed.success) return { ok: false, code: 'invalid_schema' }
  const document = parsed.data
  if (document.pages.length > (input.maxPages ?? Number.MAX_SAFE_INTEGER)) {
    return { ok: false, code: 'invalid_schema' }
  }
  if (wikiCandidateSectionCount(document) > (input.maxSections ?? WIKI_TOTAL_SECTION_LIMIT)) {
    return { ok: false, code: 'too_many_sections' }
  }
  const pageKeys = new Set<string>()
  const sectionKeys = new Set<string>()
  for (const page of document.pages) {
    if (pageKeys.has(page.page_key)) return { ok: false, code: 'duplicate_page_key' }
    pageKeys.add(page.page_key)
    for (const section of page.sections) {
      if (sectionKeys.has(section.section_key)) return { ok: false, code: 'duplicate_section_key' }
      sectionKeys.add(section.section_key)
      if (new Set(section.source_tokens).size !== section.source_tokens.length) {
        return { ok: false, code: 'duplicate_source_token' }
      }
      if (input.expectedCoverage !== 'complete' && section.coverage === 'complete') {
        return { ok: false, code: 'coverage_overclaim' }
      }
    }
  }

  const registry = new Map<string, WikiBuildSource>()
  for (const source of input.sources) {
    if (registry.has(source.sourceToken)) return { ok: false, code: 'duplicate_source_token' }
    if (source.sourceSnapshotId !== input.expectedSnapshotId) {
      return { ok: false, code: 'source_snapshot_mismatch' }
    }
    if (source.commitSha !== input.expectedCommitSha) {
      return { ok: false, code: 'source_commit_mismatch' }
    }
    registry.set(source.sourceToken, source)
  }
  for (const page of document.pages) {
    for (const section of page.sections) {
      for (const token of section.source_tokens) {
        if (!registry.has(token)) return { ok: false, code: 'unknown_source_token' }
      }
    }
  }
  return { ok: true, document }
}
