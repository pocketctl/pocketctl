import { describe, expect, test } from 'vitest'

import {
  CODE_SNAPSHOT_MAX_FILE_BYTES,
  CODE_SNAPSHOT_MAX_FILES,
  CODE_SNAPSHOT_MAX_REQUEST_BYTES,
  CODE_SNAPSHOT_MAX_TOTAL_BYTES,
  CODE_SNAPSHOT_RETENTION_DAYS,
  CODE_SYMBOL_EXTENSIONS,
  FILE_ONLY_EXTENSIONS,
  GitObjectFormatSchema,
  IMPACT_DEFAULT_DEPTH,
  IMPACT_MAX_EDGES,
  IMPACT_MAX_NODES,
  IMPACT_SERVER_BUDGET_MS,
  PHASE4_PARSER_MATRIX_VERSION,
  SOURCE_SNAPSHOT_CAPABILITIES,
  canonicalJsonStringify,
  languageCapabilityFor,
  normalizeSourcePath,
  stableExternalPackageKey,
  stableFileKey,
  stableSymbolKey,
} from '../codegraph/types.js'
import {
  WIKI_BUILD_ACTIVE_STATES,
  WIKI_CANDIDATE_SCHEMA_VERSION,
  WIKI_MAX_PAGES,
  WIKI_MAX_SECTIONS,
  WIKI_MAX_SOURCE_CHARS,
  WikiCandidateDocumentSchema,
  type WikiCandidateDocumentV1,
} from '../wiki/types.js'

describe('phase 4 codegraph frozen constants', () => {
  test('pins the parser matrix version and upload limits', () => {
    expect(PHASE4_PARSER_MATRIX_VERSION).toBe('phase4-v1')
    expect(CODE_SNAPSHOT_MAX_FILES).toBe(5_000)
    expect(CODE_SNAPSHOT_MAX_TOTAL_BYTES).toBe(64 * 1024 * 1024)
    expect(CODE_SNAPSHOT_MAX_FILE_BYTES).toBe(256 * 1024)
    expect(CODE_SNAPSHOT_MAX_REQUEST_BYTES).toBe(1024 * 1024)
    expect(CODE_SNAPSHOT_RETENTION_DAYS).toBe(30)
  })

  test('pins the bounded impact traversal defaults', () => {
    expect(IMPACT_DEFAULT_DEPTH).toBe(3)
    expect(IMPACT_MAX_NODES).toBe(500)
    expect(IMPACT_MAX_EDGES).toBe(2_000)
    expect(IMPACT_SERVER_BUDGET_MS).toBe(2_000)
  })

  test('accepts only sha1 and sha256 git object formats', () => {
    expect(GitObjectFormatSchema.parse('sha1')).toBe('sha1')
    expect(GitObjectFormatSchema.parse('sha256')).toBe('sha256')
    expect(GitObjectFormatSchema.safeParse('sha384').success).toBe(false)
  })
})

describe('phase 4 language capability matrix', () => {
  test('maps exactly the frozen TS/JS symbol extensions', () => {
    expect([...CODE_SYMBOL_EXTENSIONS].sort()).toEqual(
      ['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx'],
    )
  })

  test('maps documentation/config and Go inputs to file_only', () => {
    expect([...FILE_ONLY_EXTENSIONS].sort()).toEqual(
      ['.go', '.json', '.md', '.sql', '.sh', 'go.mod', 'go.sum', '.yaml', '.yml'].sort(),
    )
    for (const path of ['README.md', 'pkg.json', 'a.yaml', 'b.yml', 'q.sql', 'run.sh', 'main.go', 'go.mod', 'go.sum']) {
      expect(languageCapabilityFor(path)).toBe('file_only')
    }
  })

  test('treats everything else as unsupported and never symbol-complete', () => {
    for (const path of ['lib.rs', 'main.py', 'App.java', 'logo.png', 'bundle.min.js.map', 'archive.tar.gz', 'native.so']) {
      expect(languageCapabilityFor(path)).toBe('unsupported')
    }
  })

  test('grants symbols_and_edges only to the frozen TS/JS set', () => {
    for (const path of ['a.ts', 'a.tsx', 'a.js', 'a.jsx', 'a.mts', 'a.cts', 'a.mjs', 'a.cjs']) {
      expect(languageCapabilityFor(path)).toBe('symbols_and_edges')
    }
    expect(SOURCE_SNAPSHOT_CAPABILITIES).toEqual(['symbols_and_edges', 'file_only'])
  })
})

describe('phase 4 source path normalization', () => {
  test('normalizes POSIX relative paths and rejects ambiguous forms', () => {
    expect(normalizeSourcePath('src/lib/a.ts')).toBe('src/lib/a.ts')
    expect(normalizeSourcePath('src//a.ts')).toBeNull()
    expect(normalizeSourcePath('./src/a.ts')).toBeNull()
    expect(normalizeSourcePath('/abs/a.ts')).toBeNull()
    expect(normalizeSourcePath('../escape.ts')).toBeNull()
    expect(normalizeSourcePath('a/../b.ts')).toBeNull()
    expect(normalizeSourcePath('')).toBeNull()
    expect(normalizeSourcePath('src/\0bad.ts')).toBeNull()
    expect(normalizeSourcePath('src\\bad.ts')).toBeNull()
    expect(normalizeSourcePath('src/./a.ts')).toBeNull()
  })

  test('builds the frozen stable node keys', () => {
    expect(stableFileKey('src/a.ts')).toBe('file:src/a.ts')
    expect(stableSymbolKey('src/a.ts', 'mod.fn', 'function', 12)).toBe(
      'symbol:src/a.ts#mod.fn:function:12',
    )
    expect(stableExternalPackageKey('lodash')).toBe('external:lodash')
  })
})

describe('phase 4 canonical json', () => {
  test('hashes are stable across key insertion order', () => {
    const a = canonicalJsonStringify({ b: 1, a: [{ z: true, y: null }] })
    const b = canonicalJsonStringify({ a: [{ y: null, z: true }], b: 1 })
    expect(a).toBe(b)
    expect(a).toBe('{"a":[{"y":null,"z":true}],"b":1}')
  })
})

describe('phase 4 wiki candidate schema', () => {
  test('pins the frozen schema version and section bounds', () => {
    expect(WIKI_CANDIDATE_SCHEMA_VERSION).toBe('wiki-candidate.v1')
    expect(WIKI_MAX_PAGES).toBe(32)
    expect(WIKI_MAX_SECTIONS).toBe(256)
    expect(WIKI_MAX_SOURCE_CHARS).toBe(200_000)
    expect(WIKI_BUILD_ACTIVE_STATES).toEqual(['queued', 'running', 'validating'])
  })

  const validDocument: WikiCandidateDocumentV1 = {
    schema_version: 'wiki-candidate.v1',
    pages: [
      {
        page_key: 'overview',
        title: 'Overview',
        sections: [
          {
            section_key: 'overview/modules',
            heading: 'Modules',
            markdown: 'Index of modules.',
            source_tokens: ['tok-file-1', 'tok-symbol-2'],
            coverage: 'complete',
          },
        ],
      },
    ],
  }

  test('accepts a strictly valid candidate document', () => {
    expect(WikiCandidateDocumentSchema.parse(validDocument)).toEqual(validDocument)
  })

  test('rejects unknown fields, bad coverage, and missing citations', () => {
    expect(WikiCandidateDocumentSchema.safeParse({
      ...validDocument,
      extra: 1,
    }).success).toBe(false)
    expect(WikiCandidateDocumentSchema.safeParse({
      schema_version: 'wiki-candidate.v2',
      pages: [],
    }).success).toBe(false)
    expect(WikiCandidateDocumentSchema.safeParse({
      ...validDocument,
      pages: [{
        page_key: 'p',
        title: 'P',
        sections: [{
          section_key: 'p/s',
          heading: 'S',
          markdown: 'm',
          source_tokens: [],
          coverage: 'complete',
        }],
      }],
    }).success).toBe(false)
    expect(WikiCandidateDocumentSchema.safeParse({
      ...validDocument,
      pages: [{
        page_key: 'p',
        title: 'P',
        sections: [{
          section_key: 'p/s',
          heading: 'S',
          markdown: 'm',
          source_tokens: ['t'],
          coverage: 'maybe',
        }],
      }],
    }).success).toBe(false)
  })
})
