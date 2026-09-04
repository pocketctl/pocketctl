import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

describe('Phase 3 worker runtime wiring', () => {
  test('registers shared-claim indexing on the claim indexer', () => {
    const source = readFileSync(fileURLToPath(new URL('../worker-main.ts', import.meta.url)), 'utf8')

    expect(source).toMatch(/const indexClaimVersion[\s\S]*?claimIndexer\.handleIndexClaimVersion/)
    expect(source).toMatch(/jobWorker\.register\('index_shared_claim', indexClaimVersion\)/)
    expect(source).toMatch(/const JOB_TYPES = \[[\s\S]*?'index_shared_claim'/)
  })
})
