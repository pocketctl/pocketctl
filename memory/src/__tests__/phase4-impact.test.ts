import { describe, expect, test } from 'vitest'

import { loadFixtureFiles, parseCodeSnapshot, PARSER_VERSION } from '../codegraph/typescript-parser.js'
import { analyzeImpact } from '../codegraph/impact-service.js'

const GRAPH = parseCodeSnapshot({
  files: loadFixtureFiles(`${process.cwd()}/fixtures/phase4-codegraph/commit-a`),
  parserVersion: PARSER_VERSION,
})

describe('phase4 bounded change impact', () => {
  test('traces dependents of a changed file completely within bounds', () => {
    const result = analyzeImpact({
      graph: GRAPH,
      entryPaths: ['src/core/model.ts'],
    })
    expect(result.coverage).toBe('complete')
    expect(result.paths).toEqual([
      'src/core/broker.ts',
      'src/core/model.ts',
      'src/core/service.ts',
      'src/entry.mts',
      'src/web/app.tsx',
      'tests/helper.spec.ts',
      'tests/model.test.ts',
    ])
    expect(result.edgeCount).toBe(6)
    expect(result.reasons).toHaveLength(0)
  })

  test('propagates transitively through imports up to the default depth', () => {
    const result = analyzeImpact({
      graph: GRAPH,
      entryPaths: ['src/utils/slug.ts'],
      depth: 3,
    })
    expect(result.coverage).toBe('complete')
    expect(result.paths).toContain('src/core/service.ts')
  })

  test('file_only entries report unsupported, never a confident no-impact', () => {
    const result = analyzeImpact({
      graph: GRAPH,
      entryPaths: ['docs/architecture.md'],
    })
    expect(result.coverage).toBe('unsupported')
    expect(result.reasons).toContain('file_only_entry')
  })

  test('dynamic or unresolved edges cap the answer at partial/degraded', () => {
    const result = analyzeImpact({
      graph: GRAPH,
      entryPaths: ['src/web/legacy.js'],
    })
    expect(['partial', 'degraded']).toContain(result.coverage)
    expect(result.reasons.length).toBeGreaterThan(0)
  })

  test('degrades when an unresolved edge is encountered inside the traversed closure', () => {
    const graph = structuredClone(GRAPH)
    const closureEdge = graph.edges.find(edge => edge.sourcePath === 'src/core/service.ts'
      && edge.toStableKey.includes('src/core/model.ts'))
    expect(closureEdge).toBeDefined()
    closureEdge!.resolution = 'dynamic'
    const result = analyzeImpact({ graph, entryPaths: ['src/core/model.ts'] })
    expect(result.coverage).toBe('degraded')
    expect(result.reasons).toContain('unresolved_or_dynamic_edges')
  })

  test('bounds produce partial with an explicit reason, never an empty complete', () => {
    const nodeLimited = analyzeImpact({
      graph: GRAPH,
      entryPaths: ['src/core/model.ts'],
      maxNodes: 1,
    })
    expect(nodeLimited.coverage).toBe('partial')
    expect(nodeLimited.reasons).toContain('node_limit')

    const edgeLimited = analyzeImpact({
      graph: GRAPH,
      entryPaths: ['src/core/model.ts'],
      maxEdges: 1,
    })
    expect(edgeLimited.coverage).toBe('partial')
    expect(edgeLimited.reasons).toContain('edge_limit')

    const depthLimited = analyzeImpact({
      graph: GRAPH,
      entryPaths: ['src/core/model.ts'],
      depth: 0,
    })
    expect(depthLimited.coverage).toBe('partial')
    expect(depthLimited.reasons).toContain('depth_limit')
  })

  test('cycles terminate with a visited set', () => {
    const cyclical = parseCodeSnapshot({
      files: [
        { path: 'a.ts', content: "import { b } from './b.js'\nexport const a = 1\n" },
        { path: 'b.ts', content: "import { a } from './a.js'\nexport const b = 2\n" },
      ],
      parserVersion: PARSER_VERSION,
    })
    const result = analyzeImpact({ graph: cyclical, entryPaths: ['a.ts'] })
    expect(result.coverage).toBe('complete')
    expect(result.paths).toEqual(expect.arrayContaining(['a.ts', 'b.ts']))
  })

  test('a missing entry path is an explicit not-found, not an empty complete', () => {
    expect(() => analyzeImpact({
      graph: GRAPH,
      entryPaths: ['src/missing.ts'],
    })).toThrow(/not_found/)
  })

  test('unsupported-language files never resolve to confident no-impact', () => {
    const mixed = parseCodeSnapshot({
      files: [
        { path: 'src/x.ts', content: 'export const x = 1\n' },
        { path: 'asset.bin', content: 'not code' },
      ],
      parserVersion: PARSER_VERSION,
    })
    const result = analyzeImpact({ graph: mixed, entryPaths: ['asset.bin'] })
    expect(result.coverage).toBe('unsupported')
  })
})
