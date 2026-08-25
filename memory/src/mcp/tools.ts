import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import type pg from 'pg'
import { createSearchService } from '../retrieval/search-service.js'
import { createRecallService } from '../retrieval/recall-service.js'
import { createMemoryReadService } from '../retrieval/read-service.js'
import type { EmbeddingProvider } from '../ports/embedding-provider.js'

/**
 * The six read-only MCP tools (plan §12). They call the same application
 * services as REST with the same limits — MCP adapts schemas and output
 * formatting only; it never issues its own SQL or widens result bounds.
 */

export interface MemoryToolDeps {
  pool: pg.Pool
  /** Verified installation context — set per request by the MCP route. */
  installationId(): string
  recallEmbeddingTimeoutMs: number
  cursorSigningKey: string
  embed?: EmbeddingProvider & { provider: string; model: string }
  embeddingConsentFingerprint?: string
}

function textResult(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] }
}

export function registerMemoryTools(server: McpServer, deps: MemoryToolDeps): void {
  const search = createSearchService({
    pool: deps.pool,
    recallEmbeddingTimeoutMs: deps.recallEmbeddingTimeoutMs,
    cursorSigningKey: deps.cursorSigningKey,
    ...(deps.embed ? { embed: deps.embed } : {}),
    ...(deps.embeddingConsentFingerprint
      ? { embeddingConsentFingerprint: deps.embeddingConsentFingerprint }
      : {}),
  })
  const recall = createRecallService(deps.pool, search)
  const reads = createMemoryReadService(deps.pool, deps.cursorSigningKey)

  const ClaimTypeEnum = z.enum([
    'architecture_decision', 'repository_convention', 'bug_root_cause',
    'rejected_hypothesis', 'test_invariant', 'implementation_map',
    'operational_runbook', 'work_method', 'reusable_skill_candidate',
  ])

  server.registerTool('memory_search', {
    description: 'Search active personal engineering claims (read-only).',
    inputSchema: {
      query: z.string().min(1).max(2000),
      repository_id: z.string().uuid().optional(),
      repo_snapshot_id: z.string().uuid().optional(),
      branch: z.string().min(1).max(255).optional(),
      claim_types: z.array(ClaimTypeEnum).min(1).max(9).optional(),
      as_of: z.string().datetime().optional(),
      limit: z.number().int().min(1).max(20).optional(),
      cursor: z.string().min(1).max(2048).optional(),
    },
  }, async args => {
    const result = await search.search({
      installationId: deps.installationId(),
      query: args.query,
      repositoryId: args.repository_id ?? null,
      repoSnapshotId: args.repo_snapshot_id ?? null,
      branch: args.branch ?? null,
      claimTypes: args.claim_types ?? null,
      asOf: args.as_of ? new Date(args.as_of) : null,
      limit: args.limit ?? 10,
      cursor: args.cursor ?? null,
    })
    return textResult(result)
  })

  server.registerTool('memory_recall', {
    description: 'Assemble a bounded evidence-backed recall bundle (read-only).',
    inputSchema: {
      query: z.string().min(1).max(2000),
      repository_id: z.string().uuid().optional(),
      repo_snapshot_id: z.string().uuid().optional(),
      branch: z.string().min(1).max(255).optional(),
      claim_types: z.array(ClaimTypeEnum).min(1).max(9).optional(),
      as_of: z.string().datetime().optional(),
      max_claims: z.number().int().min(1).max(10).optional(),
      max_evidence_per_claim: z.number().int().min(1).max(5).optional(),
      max_chars: z.number().int().min(1000).max(12000).optional(),
    },
  }, async args => {
    const result = await recall.recall({
      installationId: deps.installationId(),
      query: args.query,
      repositoryId: args.repository_id ?? null,
      repoSnapshotId: args.repo_snapshot_id ?? null,
      branch: args.branch ?? null,
      claimTypes: args.claim_types ?? null,
      asOf: args.as_of ? new Date(args.as_of) : null,
      maxClaims: args.max_claims ?? 5,
      maxEvidencePerClaim: args.max_evidence_per_claim ?? 2,
      maxChars: args.max_chars ?? 8000,
    })
    return textResult(result)
  })

  server.registerTool('memory_get_claim', {
    description: 'Fetch one claim with its immutable version history (read-only).',
    inputSchema: {
      claim_id: z.string().uuid(),
      version_limit: z.number().int().min(1).max(20).optional(),
      version_cursor: z.string().min(1).max(512).optional(),
    },
  }, async args => {
    const claim = await reads.getClaim(deps.installationId(), args.claim_id, {
      versionLimit: args.version_limit ?? 20,
      versionCursor: args.version_cursor ?? null,
    })
    return textResult(claim ?? { error: { code: 'not_found' } })
  })

  server.registerTool('memory_get_evidence', {
    description: 'Fetch one sanitized evidence excerpt with its locator (read-only).',
    inputSchema: { evidence_id: z.string().uuid() },
  }, async args => {
    const evidence = await reads.getEvidence(deps.installationId(), args.evidence_id)
    return textResult(evidence ?? { error: { code: 'not_found' } })
  })

  server.registerTool('memory_find_related_episodes', {
    description: 'List related work episode metadata (read-only).',
    inputSchema: {
      session_id: z.string().min(1).max(128).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
  }, async args => {
    return textResult(await reads.findRelatedEpisodes(deps.installationId(), {
      sessionId: args.session_id ?? null,
      limit: args.limit ?? 20,
    }))
  })

  server.registerTool('memory_get_repository_context', {
    description: 'Active claims grouped by type for one repository (read-only).',
    inputSchema: { repository_id: z.string().uuid() },
  }, async args => {
    return textResult(await reads.getRepositoryContext(deps.installationId(), args.repository_id))
  })
}
