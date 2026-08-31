import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import type pg from 'pg'
import { createSearchService } from '../retrieval/search-service.js'
import { createRecallService } from '../retrieval/recall-service.js'
import { createMemoryReadService } from '../retrieval/read-service.js'
import type { EmbeddingProvider } from '../ports/embedding-provider.js'
import type { VerifiedMemoryGrant } from '../auth/grant-guard.js'
import type { RouteV2Grant } from '../governance/authorization.js'
import {
  buildFederatedRecallResult,
  collectFederatedSearchPages,
  defaultReadInstallationId,
  decorateWithScopeMetadata,
  encodeFederatedCursor,
  mergeFederatedRrf,
  MAX_FEDERATED_OFFSET,
  resolveFederatedCursor,
  selectFederatedScopes,
} from '../retrieval/federated-search-service.js'

/**
 * The six read-only MCP tools (plan §12). They call the same application
 * services as REST with the same limits — MCP adapts schemas and output
 * formatting only; it never issues its own SQL or widens result bounds.
 */

export interface MemoryToolDeps {
  pool: pg.Pool
  /** Verified grant context — set per request by the MCP route. */
  grant(): VerifiedMemoryGrant | undefined
  sharedScopesEnabled: boolean
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

  const currentGrant = (): VerifiedMemoryGrant => {
    const grant = deps.grant()
    if (!grant) throw new Error('grant context unavailable')
    return grant
  }
  const installationId = (): string => defaultReadInstallationId(currentGrant())
  const requireV2Grant = (): RouteV2Grant => {
    const grant = currentGrant()
    if (!('version' in grant) || grant.version !== 'v2') {
      throw new Error('explicit scope selection requires a v2 grant')
    }
    return grant
  }
  const qualifiedInstallation = (requested?: string): string => {
    if (!requested) return installationId()
    const selected = selectFederatedScopes({
      grant: requireV2Grant(),
      requestedInstallationIds: [requested],
      sharedScopesEnabled: deps.sharedScopesEnabled,
    })
    if (selected.length !== 1) throw new Error('installation is not authorized')
    return selected[0].installationId
  }

  const ClaimTypeEnum = z.enum([
    'architecture_decision', 'repository_convention', 'bug_root_cause',
    'rejected_hypothesis', 'test_invariant', 'implementation_map',
    'operational_runbook', 'work_method', 'reusable_skill_candidate',
  ])

  server.registerTool('memory_search', {
    description: 'Search active claims in explicitly selected authorized scopes (read-only).',
    inputSchema: {
      query: z.string().min(1).max(2000),
      repository_id: z.string().uuid().optional(),
      repo_snapshot_id: z.string().uuid().optional(),
      branch: z.string().min(1).max(255).optional(),
      claim_types: z.array(ClaimTypeEnum).min(1).max(9).optional(),
      as_of: z.string().datetime().optional(),
      limit: z.number().int().min(1).max(20).optional(),
      cursor: z.string().min(1).max(2048).optional(),
      scope_installation_ids: z.array(z.string().uuid()).min(1).max(16)
        .refine(ids => new Set(ids).size === ids.length).optional(),
    },
  }, async args => {
    if (args.scope_installation_ids) {
      const scopes = selectFederatedScopes({
        grant: requireV2Grant(),
        requestedInstallationIds: args.scope_installation_ids,
        sharedScopesEnabled: deps.sharedScopesEnabled,
      })
      const cursorContext = {
        scopes,
        query: args.query,
        repositoryId: args.repository_id,
        repoSnapshotId: args.repo_snapshot_id,
        branch: args.branch,
        claimTypes: args.claim_types,
      }
      const cursor = resolveFederatedCursor({
        cursor: args.cursor,
        context: cursorContext,
        key: deps.cursorSigningKey,
        requestedAsOf: args.as_of ? new Date(args.as_of) : null,
      })
      const limit = args.limit ?? 10
      const perScope = await collectFederatedSearchPages({
        scopes,
        targetCount: cursor.offset + limit,
        load: async (scope, innerCursor, pageLimit) => search.search({
          installationId: scope.installationId,
          query: args.query,
          repositoryId: args.repository_id ?? null,
          repoSnapshotId: args.repo_snapshot_id ?? null,
          branch: args.branch ?? null,
          claimTypes: args.claim_types ?? null,
          asOf: cursor.asOf,
          limit: pageLimit,
          cursor: innerCursor,
        }),
      })
      const merged = mergeFederatedRrf(perScope.flatMap(({ scope, hits }) =>
        hits.map(hit => ({
          scope,
          hit,
          claimId: hit.claimId,
          repositoryApplicable: args.repository_id ? hit.repositoryId === args.repository_id : true,
          authority: hit.authority,
          freshnessAt: hit.freshnessAt,
        }))), cursor.offset + limit)
      const page = merged.slice(cursor.offset, cursor.offset + limit)
      const ids = new Map<string, string[]>()
      for (const entry of page) {
        const list = ids.get(entry.scope.installationId) ?? []
        list.push(entry.hit.claimId)
        ids.set(entry.scope.installationId, list)
      }
      const metadata = await decorateWithScopeMetadata(
        deps.pool, scopes.map(scope => scope.installationId), ids,
      )
      return textResult({
        hits: page.map(entry => ({
          ...entry.hit,
          installationId: entry.scope.installationId,
          score: entry.rank,
          ownerScopeKind: entry.scope.ownerScopeKind,
          ownerScopeId: entry.scope.ownerScopeId,
          conflictGroupId: metadata.get(`${entry.scope.installationId}:${entry.hit.claimId}`)?.conflictGroupId ?? null,
          conflictVariant: metadata.get(`${entry.scope.installationId}:${entry.hit.claimId}`)?.conflictVariant ?? null,
        })),
        nextCursor: cursor.offset + limit <= MAX_FEDERATED_OFFSET && (merged.length > cursor.offset + limit
          || perScope.some(entry => entry.hasMore)
          || perScope.reduce((count, entry) => count + entry.hits.length, 0) > merged.length)
          ? encodeFederatedCursor({
              offset: cursor.offset + limit,
              asOf: cursor.asOf,
              context: cursorContext,
              key: deps.cursorSigningKey,
            })
          : null,
        degradedComponents: [...new Set(perScope.flatMap(entry => entry.degradedComponents))],
        poolSizes: Object.fromEntries(perScope.map(entry => [entry.scope.installationId, entry.hits.length])),
      })
    }
    const result = await search.search({
      installationId: installationId(),
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
    description: 'Assemble a bounded recall bundle from explicitly selected authorized scopes (read-only).',
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
      scope_installation_ids: z.array(z.string().uuid()).min(1).max(16)
        .refine(ids => new Set(ids).size === ids.length).optional(),
    },
  }, async args => {
    if (args.scope_installation_ids) {
      const scopes = selectFederatedScopes({
        grant: requireV2Grant(),
        requestedInstallationIds: args.scope_installation_ids,
        sharedScopesEnabled: deps.sharedScopesEnabled,
      })
      const perScope = await Promise.all(scopes.map(async scope => ({
        scope,
        result: await recall.recall({
          installationId: scope.installationId,
          query: args.query,
          repositoryId: args.repository_id ?? null,
          repoSnapshotId: args.repo_snapshot_id ?? null,
          branch: args.branch ?? null,
          claimTypes: args.claim_types ?? null,
          asOf: args.as_of ? new Date(args.as_of) : null,
          maxClaims: args.max_claims ?? 5,
          maxEvidencePerClaim: args.max_evidence_per_claim ?? 2,
          maxChars: args.max_chars ?? 8000,
        }),
      })))
      const merged = mergeFederatedRrf(perScope.flatMap(({ scope, result }) =>
        result.claims.map(claim => ({
          scope,
          hit: claim,
          claimId: claim.claimId,
          repositoryApplicable: true,
          authority: claim.authority,
          freshnessAt: claim.freshnessAt,
        }))), args.max_claims ?? 5)
      return textResult(buildFederatedRecallResult(
        perScope,
        merged,
        args.max_chars ?? 8000,
      ))
    }
    const result = await recall.recall({
      installationId: installationId(),
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
      installation_id: z.string().uuid().optional(),
      version_limit: z.number().int().min(1).max(20).optional(),
      version_cursor: z.string().min(1).max(512).optional(),
    },
  }, async args => {
    const claim = await reads.getClaim(qualifiedInstallation(args.installation_id), args.claim_id, {
      versionLimit: args.version_limit ?? 20,
      versionCursor: args.version_cursor ?? null,
    })
    return textResult(claim ?? { error: { code: 'not_found' } })
  })

  server.registerTool('memory_get_evidence', {
    description: 'Fetch one sanitized evidence excerpt with its locator (read-only).',
    inputSchema: {
      evidence_id: z.string().uuid(),
      installation_id: z.string().uuid().optional(),
    },
  }, async args => {
    const evidence = await reads.getEvidence(qualifiedInstallation(args.installation_id), args.evidence_id)
    return textResult(evidence ?? { error: { code: 'not_found' } })
  })

  server.registerTool('memory_find_related_episodes', {
    description: 'List related work episode metadata (read-only).',
    inputSchema: {
      session_id: z.string().min(1).max(128).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
  }, async args => {
    return textResult(await reads.findRelatedEpisodes(installationId(), {
      sessionId: args.session_id ?? null,
      limit: args.limit ?? 20,
    }))
  })

  server.registerTool('memory_get_repository_context', {
    description: 'Active claims grouped by type for one repository (read-only).',
    inputSchema: { repository_id: z.string().uuid() },
  }, async args => {
    return textResult(await reads.getRepositoryContext(installationId(), args.repository_id))
  })
}
