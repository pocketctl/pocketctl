import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { describe, expect, test } from 'vitest'

import {
  PARSER_VERSION,
  canonicalGraphHash,
  loadFixtureFiles,
  parseCodeSnapshot,
} from '../codegraph/typescript-parser.js'
import { validateGraphCandidate } from '../codegraph/validator.js'
import { canonicalJsonStringify } from '../codegraph/types.js'

const FIXTURE_ROOT = join(__dirname, '../../fixtures/phase4-codegraph/commit-a')

function collectFiles(dir: string, base = dir): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = []
  for (const name of readdirSync(dir).sort()) {
    const absolute = join(dir, name)
    if (statSync(absolute).isDirectory()) {
      files.push(...collectFiles(absolute, base))
    } else {
      files.push({
        path: join('', relativePath(base, absolute)),
        content: readFileSync(absolute, 'utf8'),
      })
    }
  }
  return files
}

function relativePath(base: string, absolute: string): string {
  return absolute.slice(base.length + 1).split('\\').join('/')
}

describe('phase4 deterministic TypeScript parser (fixture commit A)', () => {
  const files = collectFiles(FIXTURE_ROOT)
  const parsed = parseCodeSnapshot({ files, parserVersion: PARSER_VERSION })

  const nodeKeys = () => new Set(parsed.nodes.map(node => node.stableKey))
  const edgesOf = (kind: string) => parsed.edges.filter(edge => edge.kind === kind)
  const findEdge = (kind: string, from: string, to: string) => parsed.edges.find(edge =>
    edge.kind === kind && edge.fromStableKey === from && edge.toStableKey === to)

  test('parses the fixture deterministically: identical hash across runs', () => {
    const again = parseCodeSnapshot({ files, parserVersion: PARSER_VERSION })
    expect(again.contentHash).toBe(parsed.contentHash)
    expect(again.nodes).toEqual(parsed.nodes)
    expect(again.edges).toEqual(parsed.edges)
    expect(parsed.parserVersion).toBe(PARSER_VERSION)
    expect(parsed.contentHash).toMatch(/^[0-9a-f]{64}$/)
  })

  test('emits file nodes and definition nodes with exact source ranges', () => {
    const keys = nodeKeys()
    for (const file of files) {
      if (/\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/.test(file.path)) {
        expect(keys, file.path).toContain(`file:${file.path}`)
      }
    }
    const repository = parsed.nodes.find(node => node.stableKey.startsWith('symbol:src/core/model.ts#Repository:'))
    expect(repository).toMatchObject({
      kind: 'symbol',
      name: 'Repository',
      symbolKind: 'class',
      path: 'src/core/model.ts',
      startLine: 13,
      endLine: 23,
    })
    const summarize = parsed.nodes.find(node => node.stableKey === 'symbol:src/core/model.ts#summarize:function:25')
    expect(summarize).toMatchObject({ symbolKind: 'function', startLine: 25, endLine: 27 })
    const add = parsed.nodes.find(node => node.stableKey.startsWith('symbol:src/core/model.ts#Repository.add:'))
    expect(add).toMatchObject({ symbolKind: 'method', startLine: 16 })

    // Every fixture definition is present: the recall denominator is exact.
    const expectedSymbols: Array<[string, string]> = [
      ['src/core/model.ts', 'Item'],
      ['src/core/model.ts', 'ItemStatus'],
      ['src/core/model.ts', 'Priority'],
      ['src/core/model.ts', 'Repository'],
      ['src/core/model.ts', 'add'],
      ['src/core/model.ts', 'count'],
      ['src/core/model.ts', 'summarize'],
      ['src/core/service.ts', 'ServiceOptions'],
      ['src/core/service.ts', 'buildLabel'],
      ['src/core/service.ts', 'resolvePriority'],
      ['src/core/service.ts', 'serviceSlug'],
      ['src/utils/format.ts', 'formatLabel'],
      ['src/utils/format.ts', 'parsePriority'],
      ['src/utils/slug.ts', 'slugify'],
      ['src/web/app.tsx', 'renderApp'],
      ['src/web/legacy.js', 'loadPlugin'],
      ['src/entry.mts', 'entryLabel'],
    ]
    for (const [path, name] of expectedSymbols) {
      const found = parsed.nodes.some(node =>
        node.path === path && node.name === name && node.kind === 'symbol')
      expect(found, `${path}#${name}`).toBe(true)
    }
  })

  test('definition edges bind each symbol to its defining file', () => {
    const definitions = edgesOf('definition')
    expect(definitions.length).toBe(parsed.nodes.filter(node => node.kind === 'symbol').length)
    expect(findEdge('definition', 'file:src/core/model.ts', 'symbol:src/core/model.ts#Repository:class:13')).toBeTruthy()
    expect(findEdge('definition', 'file:src/core/model.ts', 'symbol:src/core/model.ts#summarize:function:25')).toBeTruthy()
  })

  test('import edges resolve relative specifiers across modules and file kinds', () => {
    expect(findEdge('import', 'file:src/core/service.ts', 'file:src/core/model.ts')?.resolution).toBe('resolved')
    expect(findEdge('import', 'file:src/core/service.ts', 'file:src/utils/format.ts')?.resolution).toBe('resolved')
    expect(findEdge('import', 'file:src/web/app.tsx', 'file:src/core/model.ts')?.resolution).toBe('resolved')
    expect(findEdge('import', 'file:tests/model.test.ts', 'file:src/core/model.ts')?.resolution).toBe('resolved')
    expect(findEdge('import', 'file:src/entry.mts', 'file:src/core/service.ts')?.resolution).toBe('resolved')
    for (const edge of edgesOf('import')) {
      expect(edge.sourcePath).toBeTruthy()
    }
  })

  test('bare specifiers create external package nodes with declared dependency resolution', () => {
    const keys = nodeKeys()
    expect(keys).toContain('external:left-pad')
    expect(keys).toContain('external:fs')
    const leftPad = findEdge('dependency', 'file:src/entry.mts', 'external:left-pad')
    expect(leftPad?.resolution).toBe('resolved') // declared in fixture package.json
    const fsDep = findEdge('dependency', 'file:src/web/legacy.js', 'external:fs')
    expect(fsDep?.resolution).toBe('unresolved') // not a declared dependency
  })

  test('reference edges connect call-site containers to referenced symbols', () => {
    const references = edgesOf('reference')
    // service.ts references Priority (imported symbol use).
    const priorityUse = references.find(edge =>
      edge.toStableKey.startsWith('symbol:src/core/model.ts#Priority:') && edge.sourcePath === 'src/core/service.ts')
    expect(priorityUse).toBeTruthy()
    // app.tsx references summarize and Repository.
    expect(references.some(edge =>
      edge.toStableKey.startsWith('symbol:src/core/model.ts#summarize:') && edge.sourcePath === 'src/web/app.tsx')).toBe(true)
    expect(references.some(edge =>
      edge.toStableKey.startsWith('symbol:src/core/model.ts#Repository:') && edge.sourcePath === 'src/web/app.tsx')).toBe(true)
  })

  test('call edges resolve static callees and mark dynamic calls explicitly', () => {
    const calls = edgesOf('call')
    expect(calls.some(edge =>
      edge.toStableKey.startsWith('symbol:src/core/model.ts#summarize:')
      && edge.sourcePath === 'src/web/app.tsx'
      && edge.resolution === 'resolved')).toBe(true)
    expect(calls.some(edge =>
      edge.toStableKey.startsWith('symbol:src/core/model.ts#Repository.add:')
      && edge.sourcePath === 'tests/model.test.ts')).toBe(true)
    // The deliberate dynamic call in legacy.js is visible as dynamic, never
    // silently complete.
    const dynamic = calls.filter(edge => edge.resolution === 'dynamic')
    expect(dynamic.length).toBeGreaterThanOrEqual(1)
    // The deliberately dynamic legacy.js call is present; test files may
    // carry additional unresolved framework calls, which stay visible too.
    expect(dynamic.some(edge => edge.sourcePath === 'src/web/legacy.js')).toBe(true)
  })

  test('test files carry explicit test edges to production imports', () => {
    expect(findEdge('test', 'file:tests/model.test.ts', 'file:src/core/model.ts')).toBeTruthy()
    expect(findEdge('test', 'file:tests/model.test.ts', 'file:src/utils/format.ts')).toBeTruthy()
    expect(findEdge('test', 'file:tests/helper.spec.ts', 'file:src/core/service.ts')).toBeTruthy()
  })

  test('coverage is honest: file_only for docs, unsupported for unknown kinds', () => {
    expect(parsed.coverage.files['docs/architecture.md']).toBe('file_only')
    expect(parsed.coverage.files['package.json']).toBe('file_only')
    expect(parsed.coverage.files['assets/logo.txt']).toBe('unsupported')
    expect(parsed.coverage.files['src/core/model.ts']).toBe('complete')
    expect(parsed.coverage.summary.unsupported).toBeGreaterThanOrEqual(1)
    expect(parsed.coverage.summary.fileOnly).toBeGreaterThanOrEqual(2)
    expect(parsed.coverage.summary.complete).toBeGreaterThanOrEqual(8)
  })

  test('treats injection-bearing comments as data, never as instructions', () => {
    const serialized = canonicalJsonStringify({
      nodes: parsed.nodes,
      edges: parsed.edges,
      coverage: parsed.coverage,
    })
    for (const forbidden of ['attacker.example', 'AKIAIOSFODNN7EXAMPLE', 'ignore previous instructions']) {
      expect(serialized.includes(forbidden), forbidden).toBe(false)
    }
  })

  test('the validator accepts the deterministic candidate', () => {
    const verdict = validateGraphCandidate(parsed)
    expect(verdict.ok).toBe(true)
    if (!verdict.ok) return
    expect(verdict.errors).toHaveLength(0)
  })

  test('a graph with duplicate stable keys or dangling edges fails validation', () => {
    const duplicated = validateGraphCandidate({
      ...parsed,
      nodes: [...parsed.nodes, parsed.nodes[0]!],
    })
    expect(duplicated.ok).toBe(false)
    const dangling = validateGraphCandidate({
      ...parsed,
      edges: [...parsed.edges, {
        edgeId: 'probe',
        kind: 'import' as const,
        fromStableKey: 'file:src/core/model.ts',
        toStableKey: 'file:src/does-not-exist.ts',
        sourcePath: 'src/core/model.ts',
        sourceLine: 1,
        resolution: 'resolved' as const,
        metadata: {},
      }],
    })
    expect(dangling.ok).toBe(false)
  })

  test('canonical hash is stable under input array reordering', () => {
    const shuffled = parseCodeSnapshot({
      files: [...files].reverse(),
      parserVersion: PARSER_VERSION,
    })
    expect(shuffled.contentHash).toBe(parsed.contentHash)
    expect(canonicalGraphHash(shuffled.nodes, shuffled.edges))
      .toBe(canonicalGraphHash(parsed.nodes, parsed.edges))
  })

  test('loadFixtureFiles reads a bounded fixture directory into parse input', () => {
    const loaded = loadFixtureFiles(FIXTURE_ROOT)
    expect(loaded.length).toBe(files.length)
    expect(loaded.some(file => file.path === 'src/core/model.ts')).toBe(true)
  })
})
