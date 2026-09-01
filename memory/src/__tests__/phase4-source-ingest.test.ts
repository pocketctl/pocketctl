import { createHash } from 'crypto'
import { describe, expect, test } from 'vitest'

import {
  CodeSnapshotBatchSchema,
  FinalizeCodeSnapshotRequestSchema,
  StartCodeSnapshotRequestSchema,
  computeManifestHash,
} from '../codegraph/source-repository.js'

const COMMIT = 'a'.repeat(40)
const MANIFEST = 'b'.repeat(64)

function validStart() {
  return {
    repository: { repository_key: 'github.com/example/repo', canonical_remote: 'https://github.com/example/repo.git' },
    git_object_format: 'sha1',
    commit_sha: COMMIT,
    manifest_sha256: MANIFEST,
    expected_file_count: 2,
    expected_byte_count: 12,
    parser_matrix_version: 'phase4-v1',
    idempotency_key: 'idem-1',
  }
}

describe('phase4 snapshot wire schemas', () => {
  test('accepts the frozen start shape and rejects unknown fields', () => {
    expect(StartCodeSnapshotRequestSchema.parse(validStart())).toEqual(validStart())
    expect(StartCodeSnapshotRequestSchema.safeParse({
      ...validStart(), user_id: 7,
    }).success).toBe(false)
    expect(StartCodeSnapshotRequestSchema.safeParse({
      ...validStart(), repository_path: '/leak',
    }).success).toBe(false)
    expect(StartCodeSnapshotRequestSchema.safeParse({
      ...validStart(), parser_matrix_version: 'phase5-v9',
    }).success).toBe(false)
    expect(StartCodeSnapshotRequestSchema.safeParse({
      ...validStart(), git_object_format: 'sha384',
    }).success).toBe(false)
    expect(StartCodeSnapshotRequestSchema.safeParse({
      ...validStart(), commit_sha: 'deadbeef',
    }).success).toBe(false)
    expect(StartCodeSnapshotRequestSchema.safeParse({
      ...validStart(), expected_file_count: 0,
    }).success).toBe(false)
  })

  test('bounds batch entries and finalization bodies strictly', () => {
    const entry = {
      path: 'src/a.ts',
      git_mode: '100644',
      language: 'typescript',
      capability: 'symbols_and_edges',
      blob_sha256: 'c'.repeat(64),
      byte_count: 3,
      content_base64: Buffer.from('abc').toString('base64'),
    }
    expect(CodeSnapshotBatchSchema.parse({ batch_index: 0, entries: [entry] })).toBeTruthy()
    expect(CodeSnapshotBatchSchema.safeParse({
      batch_index: -1, entries: [entry],
    }).success).toBe(false)
    expect(CodeSnapshotBatchSchema.safeParse({
      batch_index: 0, entries: [{ ...entry, capability: 'vibes' }],
    }).success).toBe(false)
    expect(CodeSnapshotBatchSchema.safeParse({
      batch_index: 0, entries: [{ ...entry, git_mode: '100600' }],
    }).success).toBe(false)
    expect(CodeSnapshotBatchSchema.safeParse({
      batch_index: 0, entries: [{ ...entry, path: '/absolute.ts' }],
    }).success).toBe(false)
    expect(CodeSnapshotBatchSchema.safeParse({
      batch_index: 0, entries: [{ ...entry, path: 'src/../escape.ts' }],
    }).success).toBe(false)

    expect(FinalizeCodeSnapshotRequestSchema.parse({
      manifest_sha256: MANIFEST,
      expected_file_count: 2,
      expected_byte_count: 12,
      idempotency_key: 'idem-1',
    })).toBeTruthy()
    expect(FinalizeCodeSnapshotRequestSchema.safeParse({
      manifest_sha256: MANIFEST,
      expected_file_count: 2,
      expected_byte_count: 12,
    }).success).toBe(false)
  })
})

describe('phase4 manifest hash', () => {
  test('matches the Go collector golden vector exactly', () => {
    const hash = computeManifestHash([
      {
        path: 'src/a.ts',
        gitMode: '100644',
        language: 'typescript',
        capability: 'symbols_and_edges',
        blobSha256: 'c'.repeat(64),
        byteCount: 3,
      },
      {
        path: 'README.md',
        gitMode: '100644',
        language: 'markdown',
        capability: 'file_only',
        blobSha256: 'd'.repeat(64),
        byteCount: 9,
      },
    ])
    expect(hash).toBe('83a1b0467a33bdb5af5e02df8a2b01c832dbdbdc885e2a93b3a2a8478f1bb1b0')
    // And equals an independent reimplementation of the frozen algorithm
    // (sorted-by-path order: README.md precedes src/a.ts).
    const manual = createHash('sha256')
      .update(`README.md\t100644\tmarkdown\tfile_only\t${'d'.repeat(64)}\t9\n`)
      .update(`src/a.ts\t100644\ttypescript\tsymbols_and_edges\t${'c'.repeat(64)}\t3\n`)
      .digest('hex')
    expect(hash).toBe(manual)
  })

  test('is order-independent: entries sort by path first', () => {
    const entries = [
      {
        path: 'z.ts', gitMode: '100644', language: 'typescript',
        capability: 'symbols_and_edges', blobSha256: '0'.repeat(64), byteCount: 1,
      },
      {
        path: 'a.ts', gitMode: '100644', language: 'typescript',
        capability: 'symbols_and_edges', blobSha256: '0'.repeat(64), byteCount: 1,
      },
    ]
    expect(computeManifestHash(entries)).toBe(computeManifestHash([...entries].reverse()))
  })
})
