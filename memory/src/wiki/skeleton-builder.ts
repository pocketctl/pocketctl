import { createHash } from 'node:crypto'

import { canonicalJsonStringify } from '../codegraph/types.js'
import {
  WIKI_CANDIDATE_SCHEMA_VERSION,
  type WikiCandidateDocumentV1,
  type WikiCoverage,
} from './types.js'
import type { WikiBuildSource } from './repository.js'

// Keep the deterministic candidate and the Provider packet set bounded even
// for repositories with thousands of graph nodes. Coverage remains honest;
// the overview is representative rather than an exhaustive file manifest.
export const WIKI_SKELETON_SOURCES_PER_SECTION = 4

export function buildDeterministicWikiSkeleton(input: {
  coverage: WikiCoverage
  commitSha: string
  sources: readonly WikiBuildSource[]
  maxSections?: number
}): WikiCandidateDocumentV1 {
  if (input.sources.length === 0) throw new Error('wiki_sources_empty')
  const ordered = [...input.sources].sort((a, b) => a.ordinal - b.ordinal)
  const fileSources = ordered.filter(source => source.sourceKind === 'file')
  const symbolSources = ordered.filter(source => source.sourceKind === 'symbol')
  const primary = fileSources[0] ?? ordered[0]!
  const selectedFiles = fileSources.slice(0, WIKI_SKELETON_SOURCES_PER_SECTION)
  const selectedSymbols = symbolSources.slice(0, WIKI_SKELETON_SOURCES_PER_SECTION)
  const fileList = selectedFiles.map(source => `- \`${source.path ?? source.stableKey}\``).join('\n')
  const symbolList = selectedSymbols.map(source => `- \`${source.stableKey}\``).join('\n')
  const sections: WikiCandidateDocumentV1['pages'][number]['sections'] = [
    {
      section_key: 'source-snapshot',
      heading: 'Source snapshot',
      markdown: `Generated from immutable commit \`${input.commitSha}\`.\n\n${fileList || '- No file nodes captured.'}`,
      source_tokens: selectedFiles.length > 0
        ? selectedFiles.map(source => source.sourceToken)
        : [primary.sourceToken],
      coverage: input.coverage,
    },
  ]
  if (selectedSymbols.length > 0 && (input.maxSections ?? 2) > 1) {
    sections.push({
      section_key: 'symbol-index',
      heading: 'Symbol index',
      markdown: symbolList,
      source_tokens: selectedSymbols.map(source => source.sourceToken),
      coverage: input.coverage,
    })
  }
  return {
    schema_version: WIKI_CANDIDATE_SCHEMA_VERSION,
    pages: [{ page_key: 'repository-overview', title: 'Repository overview', sections }],
  }
}

export function wikiCandidateContentHash(document: WikiCandidateDocumentV1): string {
  return createHash('sha256').update(canonicalJsonStringify(document)).digest('hex')
}
