import type { FastifyInstance } from 'fastify'
import type { CorsHostPolicy } from '../auth/cors-host-policy.js'
import type { GrantGuard } from '../auth/grant-guard.js'
import { MemoryApiError, errorBody } from './errors.js'
import type { PolicyService } from '../policies/service.js'
import type { PolicyKind, PolicyLayer } from '../policies/schemas.js'
import type pg from 'pg'
import { createIdempotencyStore } from './idempotency.js'
import { createTransactionBoundPool } from './transaction-bound-pool.js'

/**
 * Policy management routes (plan 10.3): structured documents only — the diff
 * is a structural JSON diff over validated fields and never displays or
 * accepts free-form system prompt text.
 */
export interface PolicyRouteDeps {
  pool: pg.Pool
  guard: GrantGuard
  policy: CorsHostPolicy
  rateLimiter?: { check(key: string): { allowed: boolean } }
  policies: PolicyService
  transactionalPolicies: (pool: pg.Pool) => PolicyService
  onPolicyActivated?: (installationId: string) => Promise<void>
}

const KINDS: readonly PolicyKind[] = ['extraction', 'context', 'ranking']
const LAYERS: readonly PolicyLayer[] = ['user', 'repository', 'team', 'organization']
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function registerPolicyRoutes(app: FastifyInstance, deps: PolicyRouteDeps) {
  const idempotency = createIdempotencyStore(deps.pool)
  const mutation = async (
    req: Pick<import('fastify').FastifyRequest, 'headers' | 'body' | 'params'>,
    installationId: string,
    operation: string,
    run: (transactionPool: pg.Pool) => Promise<
      { ok: true; metadata: Record<string, unknown> } | { ok: false; error: unknown }
    >,
  ) => {
    const key = req.headers['idempotency-key']
    if (typeof key !== 'string' || key.length === 0 || key.length > 256) {
      throw new MemoryApiError('invalid_request', 'Idempotency-Key header required')
    }
    return idempotency.execute({
      installationId,
      operation,
      key,
      requestCanonical: JSON.stringify({ params: req.params ?? {}, body: req.body ?? {} }),
      run: async client => run(createTransactionBoundPool(client)),
    })
  }
  const manage = async (authorization: string | undefined) => {
    const grant = await deps.guard.guard({
      authorization,
      requiredService: 'memory.manage',
    })
    if (deps.rateLimiter && !deps.rateLimiter.check(`policy:${grant.installationId}`).allowed) {
      throw new MemoryApiError('rate_limited', 'rate limit exceeded')
    }
    return grant
  }
  const sharedManage = async (
    authorization: string | undefined,
    targetInstallationId: string,
    expectedOwnerScopeKind?: 'team' | 'organization',
    permission = 'read',
  ) => {
    const grant = await deps.guard.guardV2({
      authorization,
      requiredService: 'memory.manage',
    })
    const binding = grant.scopeBindings.find(entry =>
      entry.installation_id === targetInstallationId)
    if (!binding || !binding.permissions.includes(permission)
      || (expectedOwnerScopeKind && binding.owner_scope_kind !== expectedOwnerScopeKind)) {
      throw new MemoryApiError('not_found', 'resource not found')
    }
    if (deps.rateLimiter && !deps.rateLimiter.check(`policy:${targetInstallationId}`).allowed) {
      throw new MemoryApiError('rate_limited', 'rate limit exceeded')
    }
    return { grant, binding, installationId: targetInstallationId }
  }

  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof MemoryApiError) {
      reply.code(error.httpStatus).send(errorBody(error))
      return
    }
    reply.code(500).send({ error: { code: 'internal', message: 'internal error' } })
  })

  const gate = (req: { headers: { host?: string; origin?: string } }, reply: {
    code: (status: number) => { send: (body: unknown) => unknown }
  }): boolean => {
    if (!deps.policy.hostAllowed(req.headers.host)) {
      reply.code(403).send({ error: { code: 'forbidden', message: 'host rejected' } })
      return false
    }
    if (!deps.policy.originAllowed(req.headers.origin)) {
      reply.code(403).send({ error: { code: 'forbidden', message: 'origin rejected' } })
      return false
    }
    return true
  }

  app.get('/api/v1/memory/policies/:kind/effective', async (req, reply) => {
    if (!gate(req, reply)) return
    const { kind } = req.params as { kind: string }
    const query = req.query as { repository_id?: unknown; target_installation_id?: unknown }
    if (!KINDS.includes(kind as PolicyKind)
      || (query.repository_id !== undefined
        && (typeof query.repository_id !== 'string' || !UUID_RE.test(query.repository_id)))) {
      throw new MemoryApiError('invalid_request', 'unknown policy kind')
    }
    const grant = typeof query.target_installation_id === 'string'
      ? await sharedManage(req.headers.authorization, query.target_installation_id)
      : await manage(req.headers.authorization)
    const effective = await deps.policies.effective({
      installationId: grant.installationId,
      kind: kind as PolicyKind,
      repositoryId: typeof query.repository_id === 'string' ? query.repository_id : null,
    })
    return {
      document: effective.document,
      policy_version_ids: effective.policyVersionIds,
      effective_policy_hash: effective.effectivePolicyHash.toString('hex'),
    }
  })

	app.get('/api/v1/memory/policies/:kind/versions', async (req, reply) => {
		if (!gate(req, reply)) return
		const { kind } = req.params as { kind: string }
		const query = req.query as { layer?: string; scope_key?: string; target_installation_id?: string }
		const scopeKeyValid = query.layer === 'user'
			? query.scope_key === 'global'
			: query.layer === 'repository'
				? typeof query.scope_key === 'string' && UUID_RE.test(query.scope_key)
				: (query.layer === 'team' || query.layer === 'organization')
					&& query.scope_key === 'global'
		if (!KINDS.includes(kind as PolicyKind)
			|| !LAYERS.includes(query.layer as PolicyLayer)
			|| !scopeKeyValid) {
			throw new MemoryApiError('invalid_request', 'invalid policy versions query')
		}
		const grant = query.layer === 'team' || query.layer === 'organization'
			? await sharedManage(
				req.headers.authorization,
				query.target_installation_id ?? '',
				query.layer,
			)
			: await manage(req.headers.authorization)
		const versions = await deps.policies.listVersions({
			installationId: grant.installationId, kind: kind as PolicyKind,
			layer: query.layer as PolicyLayer, scopeKey: query.scope_key as string,
		})
		return {
			versions: versions.map(version => ({
				policy_version_id: version.policyVersionId,
				version_number: version.versionNumber,
				document: version.document,
				active: version.active,
				head_revision: version.headRevision,
			})),
		}
	})

  app.post('/api/v1/memory/policies/:kind/versions', { bodyLimit: 32 * 1024 }, async (req, reply) => {
    if (!gate(req, reply)) return
    const { kind } = req.params as { kind: string }
    const body = (req.body ?? {}) as Record<string, unknown>
    const scopeKeyValid = body.layer === 'user'
      ? body.scope_key === 'global'
      : body.layer === 'repository'
        ? typeof body.scope_key === 'string' && UUID_RE.test(body.scope_key)
        : (body.layer === 'team' || body.layer === 'organization')
          && body.scope_key === 'global'
    if (!KINDS.includes(kind as PolicyKind)
      || typeof body.layer !== 'string' || !LAYERS.includes(body.layer as PolicyLayer)
      || !scopeKeyValid) {
      throw new MemoryApiError('invalid_request', 'invalid policy version body')
    }
    const layer = body.layer as PolicyLayer
    const sharedLayer = layer === 'team' || layer === 'organization'
    const sharedAuth = sharedLayer
      ? await sharedManage(
          req.headers.authorization,
          typeof body.target_installation_id === 'string' ? body.target_installation_id : '',
          layer,
          'policy_admin',
        )
      : null
    const grant = sharedAuth ?? await manage(req.headers.authorization)
    const scopeKey = body.scope_key as string
    const outcome = await mutation(req, grant.installationId, `policy_version:${kind}`, async transactionPool => {
      const created = await deps.transactionalPolicies(transactionPool).createVersion({
        installationId: grant.installationId,
        kind: kind as PolicyKind,
        layer,
        scopeKey,
        document: body.document,
        ...(sharedLayer ? {
          actor: {
            permissions: sharedAuth!.binding.permissions,
            ownerScopeKind: sharedAuth!.binding.owner_scope_kind,
          },
        } : {}),
      })
      return created.ok
        ? { ok: true, metadata: {
          policy_version_id: created.policyVersionId,
          version_number: created.versionNumber,
        } }
        : { ok: false, error: created }
    })
    if (outcome.kind === 'conflict') {
      reply.code(409)
      return { error: { code: 'idempotency_conflict' } }
    }
    if (outcome.kind === 'failed') {
      reply.code(400)
      const error = outcome.error as { error?: string; issues?: string[] }
      return { error: { code: error.error ?? 'invalid_document', issues: error.issues ?? [] } }
    }
    return outcome.metadata
  })

	app.post('/api/v1/memory/policies/:kind/diff', { bodyLimit: 32 * 1024 }, async (req, reply) => {
    if (!gate(req, reply)) return
    const { kind } = req.params as { kind: string }
    const body = (req.body ?? {}) as Record<string, unknown>
    if (!KINDS.includes(kind as PolicyKind) || !body.document) {
      throw new MemoryApiError('invalid_request', 'invalid diff request')
    }
    const grant = await manage(req.headers.authorization)
    const diff = await deps.policies.previewDiff({
      installationId: grant.installationId,
      kind: kind as PolicyKind,
      document: body.document,
    })
    if (!diff.ok) {
      reply.code(400)
      return { error: { code: 'invalid_document', issues: diff.issues ?? [] } }
    }
    return { diff: diff.diff }
  })

  const activateOrRollback = (action: 'activate' | 'rollback') =>
    async (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
      if (!gate(req, reply)) return
      const { kind } = req.params as { kind: string }
      const body = (req.body ?? {}) as Record<string, unknown>
      if (!KINDS.includes(kind as PolicyKind)
        || typeof body.policy_version_id !== 'string'
        || typeof body.expected_active_version_id !== 'string'
        || typeof body.expected_revision !== 'number') {
        throw new MemoryApiError('invalid_request', `invalid ${action} body`)
      }
      const targetInstallationId = typeof body.target_installation_id === 'string'
        ? body.target_installation_id
        : null
      const grant = targetInstallationId
        ? await sharedManage(req.headers.authorization, targetInstallationId, undefined, 'policy_admin')
        : await manage(req.headers.authorization)
      const policyVersionId = body.policy_version_id as string
      const expectedActiveVersionId = body.expected_active_version_id as string
      const expectedRevision = body.expected_revision as number
      const outcome = await mutation(req, grant.installationId, `policy_${action}:${kind}`, async transactionPool => {
        const policies = deps.transactionalPolicies(transactionPool)
        const result = action === 'activate'
          ? await policies.activate({
          installationId: grant.installationId,
          policyVersionId,
          expectedActiveVersionId,
          expectedRevision,
          expectedKind: kind as PolicyKind,
        })
          : await policies.rollback({
          installationId: grant.installationId,
          policyVersionId,
          expectedActiveVersionId,
          expectedRevision,
          expectedKind: kind as PolicyKind,
          })
        return result.ok
          ? { ok: true, metadata: { ok: true, revision: result.revision } }
          : { ok: false, error: result.error }
      })
      if (outcome.kind === 'conflict' || outcome.kind === 'failed') {
        reply.code(409)
        return { error: { code: 'cas_conflict' } }
      }
      if (outcome.kind === 'completed') {
        await deps.onPolicyActivated?.(grant.installationId)
      }
      return outcome.metadata
    }

  app.post('/api/v1/memory/policies/:kind/activate', activateOrRollback('activate'))
  app.post('/api/v1/memory/policies/:kind/rollback', activateOrRollback('rollback'))
}
