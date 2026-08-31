import { createHash } from 'crypto'
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'

import type { GrantGuard } from '../auth/grant-guard.js'
import type { RouteV2Grant } from '../governance/authorization.js'
import { MemoryApiError } from './errors.js'
import { createAuditRepository } from '../governance/audit-repository.js'
import { createPromotionRepository } from '../governance/promotion-repository.js'
import { createPromotionService, PromotionError } from '../governance/promotion-service.js'
import { createPublicationService, createSharedClaimLifecycle, PublicationError } from '../governance/publication-service.js'
import { createReviewPolicyRepository, ReviewPolicyRevisionConflictError } from '../governance/review-policy.js'
import { createTransferService, TransferError } from '../governance/transfer-service.js'
import { createIdempotencyStore } from './idempotency.js'
import { createTransactionBoundPool } from './transaction-bound-pool.js'

/**
 * ADR-0005 §8.2 governance routes. Every mutation requires an
 * Idempotency-Key, an expected_revision, and a target installation that
 * exactly matches a validated v2 grant binding; no route executes raw
 * governance SQL outside the services. The scope selection surface for
 * federated retrieval also lives here (§6.4).
 */

export interface GovernanceRouteDeps {
  pool: pg.Pool
  guard: GrantGuard
  sharedScopesEnabled: boolean
  cursorSigningKey: string
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function registerGovernanceRoutes(app: FastifyInstance, deps: GovernanceRouteDeps): void {
  const promotionRepository = createPromotionRepository(deps.pool)
  const reviewPolicy = createReviewPolicyRepository(deps.pool)
  const audit = createAuditRepository(deps.pool, { cursorSecret: deps.cursorSigningKey })
  const idempotency = createIdempotencyStore(deps.pool)

  const fail = (reply: { code: (status: number) => unknown }, error: MemoryApiError) => {
    reply.code(error.httpStatus)
    return { error: { code: error.code, message: error.message } }
  }

  async function guardV2OrFail(
    request: { headers: { authorization?: string } },
    reply: { code: (status: number) => unknown },
    service: string,
  ): Promise<RouteV2Grant | { failed: never }> {
    try {
      return await deps.guard.guardV2({ authorization: request.headers.authorization, requiredService: service })
    } catch (error) {
      if (error instanceof MemoryApiError) {
        return { failed: fail(reply, error) as never }
      }
      throw error
    }
  }

  const isFailed = (value: unknown): value is { failed: never } =>
    typeof value === 'object' && value !== null && 'failed' in value

  function mapGovernanceError(error: unknown, reply: { code: (status: number) => unknown }): unknown {
    if (error instanceof MemoryApiError) return fail(reply, error)
    if (error instanceof PromotionError || error instanceof PublicationError) {
      const statusByCode: Record<string, number> = {
        not_found: 404,
        forbidden: 403,
        invalid_edge: 400,
        evidence_out_of_bounds: 400,
        evidence_not_owned: 400,
        evidence_empty_after_redaction: 400,
        revision_conflict: 409,
        state_conflict: 409,
        quorum_failed: 409,
        expired: 410,
        invalid_resolution: 400,
        policy_head_changed: 409,
      }
      const status = statusByCode[error.code] ?? 400
      reply.code(status)
      return { error: { code: error.code, message: error.message, ...(('details' in error && (error as PublicationError).details) || {}) } }
    }
    if (error instanceof ReviewPolicyRevisionConflictError) {
      reply.code(409)
      return { error: { code: 'revision_conflict', message: error.message } }
    }
    if (error instanceof TransferError) {
      const status = error.code === 'not_found' ? 404
        : error.code === 'forbidden' ? 403
          : error.code === 'conflict' ? 409 : 400
      reply.code(status)
      return { error: { code: error.code, message: error.message } }
    }
    throw error
  }

  function requireIdempotencyKey(
    request: { headers: { [key: string]: unknown } },
    reply: { code: (status: number) => unknown },
  ): string | null {
    const key = request.headers['idempotency-key']
    if (typeof key !== 'string' || key.length === 0 || key.length > 128) {
      reply.code(400)
      return null
    }
    return key
  }

  function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize)
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]))
    }
    return value
  }

  async function idempotentMutation<T>(input: {
    targetInstallationId: string
    operation: string
    key: string
    request: { body?: unknown; params?: unknown }
    run(pool: pg.Pool): Promise<T>
    metadata(result: T): Record<string, unknown>
    replay(metadata: Record<string, unknown>): Promise<T>
  }): Promise<T> {
    let completed: T | undefined
    const outcome = await idempotency.execute({
      installationId: input.targetInstallationId,
      operation: input.operation,
      key: input.key,
      requestCanonical: JSON.stringify(canonicalize({
        params: input.request.params ?? {},
        body: input.request.body ?? {},
      })),
      run: async client => {
        try {
          completed = await input.run(createTransactionBoundPool(client))
          return { ok: true, metadata: input.metadata(completed) }
        } catch (error) {
          return { ok: false, error }
        }
      },
    })
    if (outcome.kind === 'conflict') {
      throw new MemoryApiError('revision_conflict',
        'Idempotency-Key was already used for a different request')
    }
    if (outcome.kind === 'failed') throw outcome.error
    if (outcome.kind === 'replayed') return input.replay(outcome.metadata)
    return completed as T
  }

  app.get('/api/v1/memory/governance/scopes', async (request, reply) => {
    const grant = await guardV2OrFail(request, reply, 'memory.search')
    if (isFailed(grant)) return grant.failed
    const mirrored = await deps.pool.query<{
      installation_id: string
      state: string
      parent_organization_id: string | null
    }>(`
      SELECT installation_id::text, state, parent_organization_id::text
      FROM memory_owner_scopes
      WHERE installation_id = ANY($1::uuid[])
    `, [grant.scopeBindings.map(binding => binding.installation_id)])
    const mirrorByInstallation = new Map(mirrored.rows.map(row => [row.installation_id, row]))
    return {
      scopes: grant.scopeBindings.map(binding => {
        const mirror = mirrorByInstallation.get(binding.installation_id)
        return {
          installation_id: binding.installation_id,
          owner_scope_kind: binding.owner_scope_kind,
          owner_scope_id: binding.owner_scope_id,
          authorization_epoch: binding.authorization_epoch,
          permissions: binding.permissions,
          state: mirror?.state,
          parent_organization_id: mirror?.parent_organization_id ?? null,
        }
      }),
    }
  })

  app.get('/api/v1/memory/governance/proposals', async (request, reply) => {
    const grant = await guardV2OrFail(request, reply, 'memory.search')
    if (isFailed(grant)) return grant.failed
    const query = request.query as { target_installation_id?: string; state?: string }
    if (!UUID_PATTERN.test(query.target_installation_id ?? '')) {
      reply.code(400)
      return { error: { code: 'invalid_request', message: 'target_installation_id required' } }
    }
    if (!grant.scopeBindings.some(binding => binding.installation_id === query.target_installation_id
      && binding.permissions.some(permission => ['read', 'review'].includes(permission)))) {
      return fail(reply, new MemoryApiError('not_found', 'resource not found'))
    }
    const states = typeof query.state === 'string' && query.state
      ? query.state.split(',').filter(Boolean)
      : undefined
    const candidates = await promotionRepository.listQueue(query.target_installation_id!, states)
    const queue = []
    for (const candidate of candidates) {
      const revision = await promotionRepository.getLatestRevision(candidate.candidate_id)
      const decisions = revision
        ? await promotionRepository.listDecisions(revision.candidate_revision_id)
        : []
      const conflictClaims = candidate.state === 'conflict'
        ? await promotionRepository.listConflictClaims(query.target_installation_id!, candidate)
        : []
      queue.push({
        candidate,
        current_revision: revision
          ? { revision_number: revision.revision_number, statement: revision.statement }
          : null,
        decisions: decisions.map(decision => ({
          decision: decision.decision,
          membership_id: decision.membership_id,
          created_at: decision.created_at,
        })),
        conflict_claims: conflictClaims,
      })
    }
    return { queue }
  })

  app.post('/api/v1/memory/governance/proposals', { bodyLimit: 32 * 1024 }, async (request, reply) => {
    const grant = await guardV2OrFail(request, reply, 'memory.search')
    if (isFailed(grant)) return grant.failed
    const idempotencyKey = requireIdempotencyKey(request, reply)
    if (!idempotencyKey) return { error: { code: 'invalid_request', message: 'Idempotency-Key required' } }
    const body = request.body as Record<string, unknown> | null
    const sourceInstallationId = body?.source_installation_id
    const sourceClaimId = body?.source_claim_id
    const targetInstallationId = body?.target_installation_id
    const expectedRevision = body?.expected_revision
    const evidenceIds = body?.evidence_ids
    if (typeof sourceInstallationId !== 'string' || typeof sourceClaimId !== 'string'
      || typeof targetInstallationId !== 'string' || typeof expectedRevision !== 'number'
      || !Array.isArray(evidenceIds)
      || !evidenceIds.every(id => typeof id === 'string')) {
      reply.code(400)
      return { error: { code: 'invalid_request', message: 'target_installation_id, expected_revision, source_installation_id, source_claim_id and evidence_ids required' } }
    }
    const targetBinding = grant.scopeBindings.find(binding =>
      binding.installation_id === targetInstallationId)
    if (targetInstallationId !== grant.primaryInstallationId || !targetBinding) {
      return fail(reply, new MemoryApiError('not_found', 'resource not found'))
    }
    if (Number(targetBinding.authorization_epoch) !== expectedRevision) {
      return fail(reply, new MemoryApiError('revision_conflict', 'target scope revision mismatch'))
    }
    const digest = createHash('sha256').update(
      `${grant.installationId}|${sourceInstallationId}|${sourceClaimId}|${evidenceIds.join(',')}|${idempotencyKey}`,
    ).digest('hex')
    try {
      const result = await idempotentMutation({
        targetInstallationId,
        operation: 'governance.propose',
        key: idempotencyKey,
        request,
        run: pool => createPromotionService(pool).propose({
          grant,
          sourceInstallationId,
          sourceClaimId,
          evidenceIds,
          idempotencyDigest: digest,
        }),
        metadata: proposed => ({
          candidate_id: proposed.candidate.candidate_id,
          candidate_revision_id: proposed.candidateRevision.candidate_revision_id,
          classification: proposed.classification,
        }),
        replay: async metadata => {
          const candidateId = String(metadata.candidate_id ?? '')
          const candidate = await promotionRepository.getCandidate(targetInstallationId, candidateId)
          const candidateRevision = await promotionRepository.getLatestRevision(candidateId)
          if (!candidate || !candidateRevision) {
            throw new PromotionError('not_found', 'idempotent proposal result not found')
          }
          return {
            candidate,
            candidateRevision,
            classification: metadata.classification as 'new' | 'duplicate' | 'conflict',
          }
        },
      })
      reply.code(201)
      return {
        candidate: result.candidate,
        candidate_revision: result.candidateRevision,
        classification: result.classification,
      }
    } catch (error) {
      return mapGovernanceError(error, reply)
    }
  })

  app.post('/api/v1/memory/governance/proposals/:candidateId/decisions', { bodyLimit: 8192 }, async (request, reply) => {
    const grant = await guardV2OrFail(request, reply, 'memory.search')
    if (isFailed(grant)) return grant.failed
    const idempotencyKey = requireIdempotencyKey(request, reply)
    if (!idempotencyKey) return { error: { code: 'invalid_request', message: 'Idempotency-Key required' } }
    const body = request.body as Record<string, unknown> | null
    const targetInstallationId = body?.target_installation_id
    const expectedRevision = body?.expected_revision
    const decision = body?.decision
    if (typeof targetInstallationId !== 'string'
      || typeof expectedRevision !== 'number'
      || (decision !== 'approve' && decision !== 'request_changes' && decision !== 'reject')) {
      reply.code(400)
      return { error: { code: 'invalid_request', message: 'target_installation_id, expected_revision and decision required' } }
    }
    try {
      const result = await idempotentMutation({
        targetInstallationId,
        operation: 'governance.decision',
        key: idempotencyKey,
        request,
        run: pool => createPublicationService(pool).decide({
          grant,
          targetInstallationId,
          candidateId: (request.params as { candidateId: string }).candidateId,
          expectedCandidateRevision: expectedRevision,
          decision,
          reasonCode: typeof body?.reason_code === 'string' ? body.reason_code : undefined,
        }),
        metadata: decided => ({ decision_id: decided.decisionId }),
        replay: async metadata => ({ decisionId: String(metadata.decision_id) }),
      })
      return { decision_id: result.decisionId }
    } catch (error) {
      return mapGovernanceError(error, reply)
    }
  })

  app.post('/api/v1/memory/governance/proposals/:candidateId/revise', { bodyLimit: 32 * 1024 }, async (request, reply) => {
    const grant = await guardV2OrFail(request, reply, 'memory.search')
    if (isFailed(grant)) return grant.failed
    const idempotencyKey = requireIdempotencyKey(request, reply)
    if (!idempotencyKey) return { error: { code: 'invalid_request', message: 'Idempotency-Key required' } }
    const body = request.body as Record<string, unknown> | null
    if (typeof body?.target_installation_id !== 'string'
      || typeof body?.expected_revision !== 'number'
      || typeof body?.statement !== 'string' || body.statement.length < 1 || body.statement.length > 4000
      || body?.structured_content === null || typeof body?.structured_content !== 'object'
      || Array.isArray(body?.structured_content)) {
      reply.code(400)
      return { error: { code: 'invalid_request', message: 'target_installation_id, expected_revision, statement and structured_content required' } }
    }
    const targetInstallationId = body.target_installation_id
    const expectedRevision = body.expected_revision
    const statement = body.statement
    const structuredContent = body.structured_content as Record<string, unknown>
    const binding = grant.scopeBindings.find(entry => entry.installation_id === targetInstallationId)
    if (!binding || (!binding.permissions.includes('contribute') && !binding.permissions.includes('review'))) {
      return fail(reply, new MemoryApiError('forbidden', 'contribute or review permission required'))
    }
    const candidateId = (request.params as { candidateId: string }).candidateId
    const candidate = await promotionRepository.getCandidate(targetInstallationId, candidateId)
    if (!candidate) return fail(reply, new MemoryApiError('not_found', 'resource not found'))
    if (candidate.created_by_membership_id !== binding.membership_id && !binding.permissions.includes('review')) {
      return fail(reply, new MemoryApiError('forbidden', 'proposal revision forbidden'))
    }
    try {
      const result = await idempotentMutation({
        targetInstallationId,
        operation: 'governance.revise',
        key: idempotencyKey,
        request,
        run: pool => createPromotionRepository(pool).appendRevision({
          targetInstallationId,
          candidateId,
          expectedRevision,
          statement,
          structuredContent,
          contentHash: createHash('sha256').update(statement, 'utf8').digest('hex'),
          createdByMembershipId: binding.membership_id,
        }),
        metadata: revised => ({
          candidate_revision_id: revised.candidateRevisionId,
          revision_number: revised.revisionNumber,
        }),
        replay: async metadata => ({
          candidateRevisionId: String(metadata.candidate_revision_id),
          revisionNumber: Number(metadata.revision_number),
        }),
      })
      return result
    } catch (error) {
      reply.code(error instanceof Error && error.message.includes('revision') ? 409 : 400)
      return { error: { code: error instanceof Error && error.message.includes('revision') ? 'revision_conflict' : 'state_conflict', message: 'proposal revision rejected' } }
    }
  })

  app.post('/api/v1/memory/governance/proposals/:candidateId/withdraw', { bodyLimit: 8192 }, async (request, reply) => {
    const grant = await guardV2OrFail(request, reply, 'memory.search')
    if (isFailed(grant)) return grant.failed
    const idempotencyKey = requireIdempotencyKey(request, reply)
    if (!idempotencyKey) return { error: { code: 'invalid_request', message: 'Idempotency-Key required' } }
    const body = request.body as Record<string, unknown> | null
    if (typeof body?.target_installation_id !== 'string' || typeof body?.expected_revision !== 'number') {
      reply.code(400)
      return { error: { code: 'invalid_request', message: 'target_installation_id and expected_revision required' } }
    }
    const targetInstallationId = body.target_installation_id
    const expectedRevision = body.expected_revision
    const binding = grant.scopeBindings.find(entry => entry.installation_id === targetInstallationId)
    if (!binding) return fail(reply, new MemoryApiError('not_found', 'resource not found'))
    try {
      return await idempotentMutation({
        targetInstallationId,
        operation: 'governance.withdraw',
        key: idempotencyKey,
        request,
        run: pool => createPromotionRepository(pool).withdraw({
          targetInstallationId,
          candidateId: (request.params as { candidateId: string }).candidateId,
          expectedRevision,
          actorMembershipId: binding.membership_id,
          actorIsScopeAdmin: binding.permissions.includes('scope_admin'),
        }),
        metadata: result => result,
        replay: async metadata => ({
          state: 'withdrawn' as const,
          revision: Number(metadata.revision),
        }),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      const status = message.includes('not found') ? 404 : message.includes('forbidden') ? 403 : 409
      reply.code(status)
      return { error: { code: status === 404 ? 'not_found' : status === 403 ? 'forbidden' : 'revision_conflict', message: 'proposal withdrawal rejected' } }
    }
  })

  app.post('/api/v1/memory/governance/proposals/:candidateId/publish', { bodyLimit: 8192 }, async (request, reply) => {
    const grant = await guardV2OrFail(request, reply, 'memory.search')
    if (isFailed(grant)) return grant.failed
    const idempotencyKey = requireIdempotencyKey(request, reply)
    if (!idempotencyKey) return { error: { code: 'invalid_request', message: 'Idempotency-Key required' } }
    const body = request.body as Record<string, unknown> | null
    const targetInstallationId = body?.target_installation_id
    const expectedRevision = body?.expected_revision
    const resolution = body?.resolution
    if (typeof targetInstallationId !== 'string'
      || typeof expectedRevision !== 'number'
      || (resolution !== 'new' && resolution !== 'parallel' && resolution !== 'supersede')) {
      reply.code(400)
      return { error: { code: 'invalid_request', message: 'target_installation_id, expected_revision and resolution required' } }
    }
    const supersedeClaimIds = Array.isArray(body?.supersede_claim_ids)
      ? (body.supersede_claim_ids as unknown[]).filter((id): id is string => typeof id === 'string')
      : undefined
    try {
      const result = await idempotentMutation({
        targetInstallationId,
        operation: 'governance.publish',
        key: idempotencyKey,
        request,
        run: pool => createPublicationService(pool).publish({
          grant,
          targetInstallationId,
          candidateId: (request.params as { candidateId: string }).candidateId,
          expectedCandidateRevision: expectedRevision,
          resolution,
          supersedeClaimIds,
        }),
        metadata: published => ({
          claim_id: published.claimId,
          version_id: published.versionId,
          conflict_group_id: published.conflictGroupId,
          conflict_variant: published.conflictVariant,
          resolution: published.resolution,
        }),
        replay: async metadata => ({
          claimId: String(metadata.claim_id),
          versionId: String(metadata.version_id),
          conflictGroupId: metadata.conflict_group_id === null ? null : String(metadata.conflict_group_id),
          conflictVariant: metadata.conflict_variant === null ? null : Number(metadata.conflict_variant),
          resolution: metadata.resolution as 'new' | 'parallel' | 'supersede',
        }),
      })
      return { claim_id: result.claimId, version_id: result.versionId, resolution: result.resolution }
    } catch (error) {
      if (error instanceof PublicationError && error.code === 'forbidden') {
        const binding = grant.scopeBindings.find(entry =>
          entry.installation_id === targetInstallationId)
        await audit.append({
          installationId: targetInstallationId,
          actorMembershipId: binding?.membership_id ?? null,
          action: 'candidate_publish_denied',
          targetKind: 'promotion_candidate',
          targetId: (request.params as { candidateId: string }).candidateId,
          requestHash: createHash('sha256').update(JSON.stringify(canonicalize({
            params: request.params,
            body: request.body,
          }))).digest('hex'),
          previousState: null,
          nextState: null,
          metadata: { reason_code: error.code },
        })
      }
      return mapGovernanceError(error, reply)
    }
  })

  app.post('/api/v1/memory/governance/claims/:claimId/revoke', { bodyLimit: 8192 }, async (request, reply) => {
    const grant = await guardV2OrFail(request, reply, 'memory.search')
    if (isFailed(grant)) return grant.failed
    const idempotencyKey = requireIdempotencyKey(request, reply)
    if (!idempotencyKey) return { error: { code: 'invalid_request', message: 'Idempotency-Key required' } }
    const body = request.body as Record<string, unknown> | null
    if (typeof body?.target_installation_id !== 'string'
      || typeof body?.reason !== 'string' || typeof body?.expected_revision !== 'number') {
      reply.code(400)
      return { error: { code: 'invalid_request', message: 'target_installation_id, reason and expected_revision required' } }
    }
    const targetInstallationId = body.target_installation_id
    const reason = body.reason
    const expectedRevision = body.expected_revision
    try {
      const result = await idempotentMutation({
        targetInstallationId,
        operation: 'governance.revoke',
        key: idempotencyKey,
        request,
        run: pool => createSharedClaimLifecycle(pool).revokeSharedClaim({
          grant,
          targetInstallationId,
          claimId: (request.params as { claimId: string }).claimId,
          reason,
          expectedRevision,
        }),
        metadata: revoked => revoked,
        replay: async metadata => ({ state: String(metadata.state) }),
      })
      return result
    } catch (error) {
      return mapGovernanceError(error, reply)
    }
  })

  app.get('/api/v1/memory/governance/review-policy', async (request, reply) => {
    const grant = await guardV2OrFail(request, reply, 'memory.search')
    if (isFailed(grant)) return grant.failed
    const query = request.query as { target_installation_id?: string }
    if (!UUID_PATTERN.test(query.target_installation_id ?? '')) {
      reply.code(400)
      return { error: { code: 'invalid_request', message: 'target_installation_id required' } }
    }
    if (!grant.scopeBindings.some(binding => binding.installation_id === query.target_installation_id)) {
      return fail(reply, new MemoryApiError('not_found', 'resource not found'))
    }
    const versions = await reviewPolicy.listVersions(query.target_installation_id!)
    const head = await reviewPolicy.getHead(query.target_installation_id!)
    return { versions, head }
  })

  app.patch('/api/v1/memory/governance/review-policy', { bodyLimit: 32 * 1024 }, async (request, reply) => {
    const grant = await guardV2OrFail(request, reply, 'memory.search')
    if (isFailed(grant)) return grant.failed
    const idempotencyKey = requireIdempotencyKey(request, reply)
    if (!idempotencyKey) return { error: { code: 'invalid_request', message: 'Idempotency-Key required' } }
    const body = request.body as Record<string, unknown> | null
    if (typeof body?.target_installation_id !== 'string' || typeof body?.expected_revision !== 'number') {
      reply.code(400)
      return { error: { code: 'invalid_request', message: 'target_installation_id and expected_revision required' } }
    }
    const target = body.target_installation_id
    const expectedRevision = body.expected_revision
    const binding = grant.scopeBindings.find(entry => entry.installation_id === target)
    if (!binding || !binding.permissions.includes('policy_admin')) {
      return fail(reply, new MemoryApiError('forbidden', 'policy_admin permission required'))
    }
    try {
      const result = await idempotentMutation({
        targetInstallationId: target,
        operation: 'governance.review_policy',
        key: idempotencyKey,
        request,
        run: pool => createReviewPolicyRepository(pool).publishVersion({
          installationId: target,
          document: body.document as never,
          createdByMembershipId: binding.membership_id,
          expectedRevision,
        }),
        metadata: published => ({
          policy_version_id: published.policyVersionId,
          version_number: published.versionNumber,
        }),
        replay: async metadata => ({
          policyVersionId: String(metadata.policy_version_id),
          versionNumber: Number(metadata.version_number),
        }),
      })
      return result
    } catch (error) {
      return mapGovernanceError(error, reply)
    }
  })

  app.get('/api/v1/memory/governance/audit', async (request, reply) => {
    const grant = await guardV2OrFail(request, reply, 'memory.search')
    if (isFailed(grant)) return grant.failed
    const query = request.query as { target_installation_id?: string; cursor?: string; limit?: string }
    if (!UUID_PATTERN.test(query.target_installation_id ?? '')) {
      reply.code(400)
      return { error: { code: 'invalid_request', message: 'target_installation_id required' } }
    }
    const target = query.target_installation_id!
    if (!grant.scopeBindings.some(binding => binding.installation_id === target
      && binding.permissions.includes('scope_admin'))) {
      return fail(reply, new MemoryApiError('forbidden', 'scope_admin permission required'))
    }
    try {
      const page = await audit.listPage(target, {
        limit: query.limit ? Number(query.limit) : 50,
        cursor: query.cursor,
      })
      return { events: page.events, next_cursor: page.nextCursor }
    } catch (error) {
      if (error instanceof Error && error.message === 'invalid audit cursor') {
        reply.code(410)
        return { error: { code: 'cursor_expired', message: error.message } }
      }
      throw error
    }
  })

  app.post('/api/v1/memory/governance/transfers', { bodyLimit: 8192 }, async (request, reply) => {
    let grant: Awaited<ReturnType<GrantGuard['guardV2Disposition']>>
    try {
      grant = await deps.guard.guardV2Disposition({
        authorization: request.headers.authorization,
        requiredService: 'memory.manage',
      })
    } catch (error) {
      return fail(reply, error instanceof MemoryApiError
        ? error : new MemoryApiError('unauthorized', 'grant rejected'))
    }
    const idempotencyKey = requireIdempotencyKey(request, reply)
    if (!idempotencyKey) return { error: { code: 'invalid_request', message: 'Idempotency-Key required' } }
    const body = request.body as Record<string, unknown> | null
    if (typeof body?.source_installation_id !== 'string'
      || typeof body?.target_installation_id !== 'string'
      || typeof body?.expected_revision !== 'number') {
      reply.code(400)
      return { error: { code: 'invalid_request', message: 'source_installation_id, target_installation_id and expected_revision required' } }
    }
    const sourceInstallationId = body.source_installation_id
    const targetInstallationId = body.target_installation_id
    const expectedRevision = body.expected_revision
    try {
      return await idempotentMutation({
        targetInstallationId: sourceInstallationId,
        operation: 'governance.transfer',
        key: idempotencyKey,
        request,
        run: pool => createTransferService(pool).startTeamTransfer({
          grant,
          sourceInstallationId,
          targetInstallationId,
          expectedAuthorizationEpoch: expectedRevision,
        }),
        metadata: started => ({
          transfer_id: started.transferId,
          candidates: started.candidates,
        }),
        replay: async metadata => ({
          transferId: String(metadata.transfer_id),
          candidates: Number(metadata.candidates),
        }),
      })
    } catch (error) {
      return mapGovernanceError(error, reply)
    }
  })
}
