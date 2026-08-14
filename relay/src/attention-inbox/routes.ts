import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Pool } from 'pg'

import {
  serializeAttentionConfig,
  serializeAttentionConfigV2,
  serializeAttentionItem,
  serializeAttentionRecovery,
} from './dto.js'
import type { AttentionInboxConfig, AttentionItemState } from './types.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ITEM_STATES = new Set<AttentionItemState>([
  'open', 'snoozed', 'submitting', 'result_unknown', 'resolved', 'expired',
])
const ACTIONS = new Set(['once', 'always', 'reject', 'cancel', 'answer'])

interface RouteRepository {
  listItems(input: {
    userId: number
    daemonId: string | null
    states: AttentionItemState[]
    cursor: string | null
    limit: number
  }): Promise<any>
  mutateMetadata(input: any): Promise<any>
}

interface RouteService {
  submitAction(input: any): Promise<any>
}

interface RecoveryRouteRepository {
  listItems(input: {
    userId: number
    daemonId: string | null
    states: string[]
    limit?: number
  }): Promise<any>
  mutateMetadata(input: any): Promise<any>
}

interface AttentionInboxRouteDependencies {
  pool: Pool
  config: AttentionInboxConfig
  repository: RouteRepository
  recoveryRepository: RecoveryRouteRepository
  service: RouteService
  verifyAccessToken: (token: string, pool: Pool) => Promise<{ userId: number } | null>
}

function headers(reply: FastifyReply): void {
  reply.header('Cache-Control', 'no-store, private')
  reply.header('Pragma', 'no-cache')
}

function fail(reply: FastifyReply, status: number, code: string, message: string, retryable = false, item?: any) {
  reply.code(status)
  return {
    error: {
      code, message, retryable,
      ...(item ? { current_item: serializeAttentionItem(item) } : {}),
    },
  }
}

async function authenticate(
  req: FastifyRequest,
  reply: FastifyReply,
  dependencies: AttentionInboxRouteDependencies,
): Promise<{ userId: number } | null> {
  headers(reply)
  const authorization = req.headers.authorization
  if (!authorization?.startsWith('Bearer ')) return null
  const access = await dependencies.verifyAccessToken(authorization.slice(7), dependencies.pool)
  if (!access) return null
  return { userId: access.userId }
}

function actionError(reply: FastifyReply, result: any) {
  const definitions: Record<string, [number, string, boolean]> = {
    item_not_found: [404, 'Item not found', false],
    stale_revision: [409, 'Item revision is stale', true],
    idempotency_key_reused: [409, 'Idempotency key was reused', false],
    action_not_allowed: [409, 'Action is not allowed', false],
    answers_invalid: [422, 'Answers are invalid', false],
    provider_not_enabled: [423, 'Provider is not enabled', false],
    feature_disabled: [503, 'Attention Inbox is disabled', true],
    remote_response_disabled: [503, 'Remote response is disabled', true],
    daemon_unreachable: [503, 'Daemon is unreachable', true],
    submission_failed: [500, 'Submission failed', true],
  }
  const [status, message, retryable] = definitions[result.code] ?? [500, 'Submission failed', true]
  return fail(reply, status, result.code, message, retryable, result.item)
}

export function registerAttentionInboxRoutes(
  app: FastifyInstance,
  dependencies: AttentionInboxRouteDependencies,
): void {
  app.get('/api/attention-inbox/v1/items', async (req, reply) => {
    const access = await authenticate(req, reply, dependencies)
    if (!access) return fail(reply, 401, 'unauthorized', 'Unauthorized')
    const capabilities = serializeAttentionConfig(dependencies.config)
    const query = req.query as Record<string, string | undefined>
    const scope = query.scope ?? 'global'
    if (scope !== 'global' && scope !== 'daemon') return fail(reply, 400, 'invalid_request', 'Invalid scope')
    if (scope === 'daemon' && !query.daemon_id) return fail(reply, 400, 'invalid_request', 'daemon_id is required')
    const requestedStates = (query.states ?? 'open,snoozed,submitting,result_unknown').split(',')
    if (requestedStates.length === 0 || requestedStates.some((state) => !ITEM_STATES.has(state as AttentionItemState))) {
      return fail(reply, 400, 'invalid_request', 'Invalid states')
    }
    const limit = query.limit === undefined ? 50 : Number(query.limit)
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return fail(reply, 400, 'invalid_request', 'Invalid limit')
    if (!dependencies.config.enabled) {
      return {
        schema_version: 1, server_time: new Date().toISOString(), capabilities,
        scope: { type: scope, daemon_id: scope === 'daemon' ? query.daemon_id : null },
        counts: { actionable: 0, open: 0, snoozed: 0, submitting: 0, result_unknown: 0 },
        items: [], next_cursor: null,
      }
    }
    let snapshot
    try {
      snapshot = await dependencies.repository.listItems({
        userId: access.userId,
        daemonId: scope === 'daemon' ? query.daemon_id! : null,
        states: requestedStates as AttentionItemState[], cursor: query.cursor ?? null, limit,
      })
    } catch (error) {
      if (error instanceof Error && error.message === 'daemon_not_found') {
        return fail(reply, 404, 'item_not_found', 'Item not found')
      }
      return fail(reply, 400, 'invalid_request', 'Invalid cursor')
    }
    return {
      schema_version: 1, server_time: new Date().toISOString(), capabilities,
      scope: { type: scope, daemon_id: scope === 'daemon' ? query.daemon_id : null },
      counts: snapshot.counts,
      items: snapshot.items.map(serializeAttentionItem), next_cursor: snapshot.nextCursor,
    }
  })

  app.get('/api/attention-inbox/v2/items', async (req, reply) => {
    const access = await authenticate(req, reply, dependencies)
    if (!access) return fail(reply, 401, 'unauthorized', 'Unauthorized')
    const query = req.query as Record<string, string | undefined>
    const scope = query.scope ?? 'global'
    if (scope !== 'global' && scope !== 'daemon') return fail(reply, 400, 'invalid_request', 'Invalid scope')
    if (scope === 'daemon' && !query.daemon_id) return fail(reply, 400, 'invalid_request', 'daemon_id is required')
    const requestedStates = (query.states ?? 'open,snoozed,submitting,result_unknown').split(',')
    if (requestedStates.length === 0 || requestedStates.some((state) => !ITEM_STATES.has(state as AttentionItemState))) {
      return fail(reply, 400, 'invalid_request', 'Invalid states')
    }
    const limit = query.limit === undefined ? 50 : Number(query.limit)
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return fail(reply, 400, 'invalid_request', 'Invalid limit')
    const capabilities = serializeAttentionConfigV2(dependencies.config)
    if (!dependencies.config.enabled) {
      return {
        schema_version: 2, server_time: new Date().toISOString(), capabilities,
        scope: { type: scope, daemon_id: scope === 'daemon' ? query.daemon_id : null },
        counts: {
          actionable: 0, open: 0, snoozed: 0, submitting: 0, result_unknown: 0,
          recovery_open: 0, recovery_snoozed: 0, attention_required: 0,
        },
        items: [], recovery_items: [], next_cursor: null,
      }
    }
    try {
      const daemonId = scope === 'daemon' ? query.daemon_id! : null
      const items = await dependencies.repository.listItems({
        userId: access.userId, daemonId,
        states: requestedStates as AttentionItemState[], cursor: query.cursor ?? null, limit,
      })
      const recoveryStates = requestedStates.filter((state) => ['open', 'snoozed', 'resolved'].includes(state))
      const recovery = dependencies.config.recovery.visible
        ? await dependencies.recoveryRepository.listItems({
          userId: access.userId, daemonId, states: recoveryStates, limit: 100,
        })
        : { items: [], counts: { open: 0, snoozed: 0 } }
      return {
        schema_version: 2, server_time: new Date().toISOString(), capabilities,
        scope: { type: scope, daemon_id: daemonId },
        counts: {
          ...items.counts,
          recovery_open: recovery.counts.open,
          recovery_snoozed: recovery.counts.snoozed,
          attention_required: items.counts.actionable + recovery.counts.open,
        },
        items: items.items.map(serializeAttentionItem),
        recovery_items: recovery.items.map(serializeAttentionRecovery),
        next_cursor: items.nextCursor,
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'daemon_not_found') {
        return fail(reply, 404, 'item_not_found', 'Item not found')
      }
      return fail(reply, 400, 'invalid_request', 'Invalid cursor')
    }
  })

  app.patch('/api/attention-inbox/v1/items/:itemId', async (req, reply) => {
    const access = await authenticate(req, reply, dependencies)
    if (!access) return fail(reply, 401, 'unauthorized', 'Unauthorized')
    if (!dependencies.config.enabled) return fail(reply, 503, 'feature_disabled', 'Attention Inbox is disabled', true)
    const itemId = (req.params as any).itemId
    if (typeof itemId !== 'string' || !UUID.test(itemId)) {
      return fail(reply, 404, 'item_not_found', 'Item not found')
    }
    const body = req.body as Record<string, unknown> | null
    const operation = body?.operation
    const revision = body?.expected_revision
    if (!body || !Number.isSafeInteger(revision) || !['mark_seen', 'snooze', 'restore'].includes(String(operation))) {
      return fail(reply, 400, 'invalid_request', 'Invalid request')
    }
    const result = await dependencies.repository.mutateMetadata({
      userId: access.userId, itemId,
      expectedRevision: revision, operation,
      snoozedUntil: typeof body.snoozed_until === 'string' ? body.snoozed_until : null,
    })
    if (result.outcome === 'not_found') return fail(reply, 404, 'item_not_found', 'Item not found')
    if (result.outcome === 'stale_revision') return fail(reply, 409, 'stale_revision', 'Item revision is stale', true, result.item)
    if (result.outcome === 'invalid') return fail(reply, 409, 'operation_not_allowed', 'Operation is not allowed')
    return { item: serializeAttentionItem(result.item) }
  })

  app.patch('/api/attention-inbox/v2/recovery-items/:itemId', async (req, reply) => {
    const access = await authenticate(req, reply, dependencies)
    if (!access) return fail(reply, 401, 'unauthorized', 'Unauthorized')
    if (!dependencies.config.recovery.visible) {
      return fail(reply, 503, 'feature_disabled', 'Attention recovery is disabled', true)
    }
    const recoveryId = (req.params as any).itemId
    if (typeof recoveryId !== 'string' || !UUID.test(recoveryId)) {
      return fail(reply, 404, 'item_not_found', 'Item not found')
    }
    const body = req.body as Record<string, unknown> | null
    const operation = body?.operation
    const revision = body?.expected_revision
    if (!body || !Number.isSafeInteger(revision) || !['mark_seen', 'snooze', 'restore'].includes(String(operation))) {
      return fail(reply, 400, 'invalid_request', 'Invalid request')
    }
    const result = await dependencies.recoveryRepository.mutateMetadata({
      userId: access.userId, recoveryId, expectedRevision: revision, operation,
      snoozedUntil: typeof body.snoozed_until === 'string' ? body.snoozed_until : null,
    })
    if (result.outcome === 'not_found') return fail(reply, 404, 'item_not_found', 'Item not found')
    if (result.outcome === 'stale_revision') {
      reply.code(409)
      return {
        error: {
          code: 'stale_revision', message: 'Item revision is stale', retryable: true,
          current_recovery: serializeAttentionRecovery(result.item),
        },
      }
    }
    if (result.outcome === 'invalid') return fail(reply, 409, 'operation_not_allowed', 'Operation is not allowed')
    return { recovery: serializeAttentionRecovery(result.item) }
  })

  app.post('/api/attention-inbox/v1/items/:itemId/actions', async (req, reply) => {
    const access = await authenticate(req, reply, dependencies)
    if (!access) return fail(reply, 401, 'unauthorized', 'Unauthorized')
    const key = req.headers['idempotency-key']
    const itemId = (req.params as any).itemId
    const body = req.body as Record<string, unknown> | null
    if (typeof itemId !== 'string' || !UUID.test(itemId)) {
      return fail(reply, 404, 'item_not_found', 'Item not found')
    }
    if (typeof key !== 'string' || !UUID.test(key)
      || !body || !Number.isSafeInteger(body.expected_revision)
      || typeof body.action_id !== 'string' || !ACTIONS.has(body.action_id)
      || (body.answers !== undefined && !Array.isArray(body.answers))) {
      return fail(reply, 400, 'invalid_request', 'Invalid request')
    }
    const result = await dependencies.service.submitAction({
      userId: access.userId, itemId, idempotencyKey: key,
      request: {
        expectedRevision: body.expected_revision,
        actionId: body.action_id,
        ...(body.answers !== undefined ? { answers: body.answers } : {}),
      },
    })
    if (result.outcome === 'error') return actionError(reply, result)
    if (result.outcome === 'resolved_elsewhere') reply.code(200)
    else reply.code(202)
    return {
      outcome: result.outcome,
      ...(result.receiptId ? { receipt_id: result.receiptId } : {}),
      item: serializeAttentionItem(result.item), final: result.final,
    }
  })
}
