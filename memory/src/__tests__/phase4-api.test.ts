import { describe, expect, test } from 'vitest'

import { CodeGraphImpactRequestSchema, CodeGraphQuerySchema } from '../api/codegraph-routes.js'
import {
  WikiBuildRequestSchema,
  WikiManualEditRequestSchema,
  WikiPublishRequestSchema,
} from '../api/wiki-routes.js'

describe('Phase 4 REST request contracts', () => {
  test('bounds graph pagination and impact traversal while rejecting unknown fields', () => {
    expect(CodeGraphQuerySchema.safeParse({ limit: 101 }).success).toBe(false)
    expect(CodeGraphQuerySchema.safeParse({ limit: 20, extra: true }).success).toBe(false)
    expect(CodeGraphImpactRequestSchema.safeParse({ entry_paths: [], depth: 3 }).success).toBe(false)
    expect(CodeGraphImpactRequestSchema.safeParse({ entry_paths: ['src/a.ts'], depth: 4 }).success).toBe(false)
    expect(CodeGraphImpactRequestSchema.safeParse({
      entry_paths: ['src/a.ts'], depth: 3, max_nodes: 500, max_edges: 2000,
    }).success).toBe(true)
  })

  test('all Wiki mutation bodies are strict and carry only CAS/user content fields', () => {
    expect(WikiBuildRequestSchema.safeParse({ expected_generation: 1 }).success).toBe(true)
    expect(WikiBuildRequestSchema.safeParse({ installation_id: crypto.randomUUID() }).success).toBe(false)
    expect(WikiPublishRequestSchema.safeParse({
      expected_generation: 1, expected_head_revision: 0,
    }).success).toBe(true)
    expect(WikiPublishRequestSchema.safeParse({
      expected_generation: 1, expected_head_revision: 0, auto_publish: true,
    }).success).toBe(false)
    expect(WikiManualEditRequestSchema.safeParse({
      markdown: 'manual', expected_lock_version: 0, reason_code: 'reviewed',
    }).success).toBe(true)
    expect(WikiManualEditRequestSchema.safeParse({ markdown: '', expected_lock_version: 0 }).success).toBe(false)
  })
})
