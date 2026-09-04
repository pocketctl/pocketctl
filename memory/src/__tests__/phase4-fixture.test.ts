import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { loadFixtureFiles, parseCodeSnapshot, PARSER_VERSION } from '../codegraph/typescript-parser.js'
import { buildDeterministicWikiSkeleton, wikiCandidateContentHash } from '../wiki/skeleton-builder.js'
import type { WikiBuildSource } from '../wiki/repository.js'

const FIXTURE_ROOT = resolve(__dirname, '../../fixtures/phase4-codegraph/commit-a')
const FIXTURE_B_ROOT = resolve(__dirname, '../../fixtures/phase4-codegraph/commit-b')

afterEach(() => vi.unstubAllGlobals())

describe('phase4 fixed fixture', () => {
  test('has literal parser denominators and identical graph/Wiki hashes without external calls', () => {
    const external = vi.fn(async () => { throw new Error('external_call_forbidden') })
    vi.stubGlobal('fetch', external)
    const files = loadFixtureFiles(FIXTURE_ROOT)
    const first = parseCodeSnapshot({ files, parserVersion: PARSER_VERSION })
    const second = parseCodeSnapshot({ files: [...files].reverse(), parserVersion: PARSER_VERSION })

    expect(first.contentHash).toBe('1e2a95f27c11e057f7772433345f3f1f8027f73eac2d607418cbb09896d699f2')
    expect(second.contentHash).toBe(first.contentHash)
    expect({
      files: Object.keys(first.coverage.files).length,
      complete: first.coverage.summary.complete,
      fileOnly: first.coverage.summary.fileOnly,
      unsupported: first.coverage.summary.unsupported,
      nodes: first.nodes.length,
      edges: first.edges.length,
    }).toEqual({ files: 13, complete: 10, fileOnly: 2, unsupported: 1, nodes: 31, edges: 74 })
    expect(Object.fromEntries(['definition', 'import', 'reference', 'call', 'dependency', 'test'].map(kind => [
      kind, first.edges.filter(edge => edge.kind === kind).length,
    ]))).toEqual({ definition: 19, import: 11, reference: 18, call: 21, dependency: 2, test: 3 })
    expect(Object.fromEntries(['resolved', 'unresolved', 'dynamic'].map(resolution => [
      resolution, first.edges.filter(edge => edge.resolution === resolution).length,
    ]))).toEqual({ resolved: 64, unresolved: 1, dynamic: 9 })

    const commitB = parseCodeSnapshot({
      files: loadFixtureFiles(FIXTURE_B_ROOT),
      parserVersion: PARSER_VERSION,
    })
    expect(commitB.contentHash).toBe('5ab08e9d0a7af387a91940d22e39bb9069dac3de56647cab3bcbfbbcf0a299f2')
    expect({ nodes: commitB.nodes.length, edges: commitB.edges.length }).toEqual({ nodes: 32, edges: 75 })

    const sources: WikiBuildSource[] = first.nodes
      .filter(node => node.kind === 'file' || node.kind === 'symbol')
      .slice(0, 64)
      .map((node, ordinal) => ({
        sourceToken: `src_${createHash('sha256').update(node.stableKey).digest('hex').slice(0, 24)}`,
        ordinal,
        sourceKind: node.kind as 'file' | 'symbol',
        stableKey: node.stableKey,
        sourceRefId: `ref-${ordinal}`,
        sourceSnapshotId: 'fixture-snapshot',
        commitSha: '1111111111111111111111111111111111111111',
        path: node.path ?? null,
        contentHash: createHash('sha256').update(node.stableKey).digest('hex'),
        excerpt: null,
      }))
    const wikiA = buildDeterministicWikiSkeleton({
      coverage: 'partial',
      commitSha: '1111111111111111111111111111111111111111',
      sources,
    })
    const wikiB = buildDeterministicWikiSkeleton({
      coverage: 'partial',
      commitSha: '1111111111111111111111111111111111111111',
      sources: [...sources].reverse(),
    })
    expect(wikiCandidateContentHash(wikiA)).toBe('c4cac24fec52cc7552d8ee363707bfee97992f8983430d2bd87c6f1c1f33b735')
    expect(wikiCandidateContentHash(wikiB)).toBe(wikiCandidateContentHash(wikiA))
    expect(external).not.toHaveBeenCalled()
  })
})
