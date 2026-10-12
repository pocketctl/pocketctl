import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type pg from 'pg'
import { AttentionNotificationRepository } from './notification-repository.js'
import {
  serializeNotificationSubject,
  serializeSystemNotification,
} from './notification-dto.js'

interface Dependencies {
  pool: pg.Pool
  repository: AttentionNotificationRepository
  enabled: boolean
  verifyAccessToken(
    token: string,
    pool: pg.Pool,
  ): Promise<{ userId: number } | null>
}
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i
function error(reply: FastifyReply, status: number, code: string) {
  return reply
    .code(status)
    .send({ error: { code, retryable: status === 409 || status === 503 } })
}
export function systemNotificationsEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const mode = env.ATTENTION_SYSTEM_NOTIFICATIONS ?? 'on'
  if (mode !== 'off' && mode !== 'on')
    throw new Error('ATTENTION_SYSTEM_NOTIFICATIONS must be off or on')
  return mode === 'on'
}
export function registerAttentionNotificationRoutes(
  app: FastifyInstance,
  deps: Dependencies,
): void {
  const authenticate = async (req: FastifyRequest, reply: FastifyReply) => {
    reply
      .header('Cache-Control', 'no-store, private')
      .header('Pragma', 'no-cache')
    const auth = req.headers.authorization
    const access = auth?.startsWith('Bearer ')
      ? await deps.verifyAccessToken(auth.slice(7), deps.pool)
      : null
    if (!access) {
      error(reply, 401, 'unauthorized')
      return null
    }
    if (!deps.enabled) {
      error(reply, 503, 'feature_disabled')
      return null
    }
    return access
  }
  const query = (req: FastifyRequest) => {
    const q = req.query as Record<string, unknown>
    for (const key of ['daemon_id', 'cursor', 'read', 'limit'])
      if (q[key] !== undefined && typeof q[key] !== 'string')
        throw new Error('invalid_query')
    const limit = q.limit === undefined ? 50 : Number(q.limit)
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (q.read !== undefined && q.read !== 'true' && q.read !== 'false') ||
      (typeof q.daemon_id === 'string' &&
        (!q.daemon_id || q.daemon_id.length > 64))
    )
      throw new Error('invalid_query')
    return {
      limit,
      daemonId: (q.daemon_id as string) ?? null,
      cursor: (q.cursor as string) ?? null,
      read: q.read === undefined ? undefined : q.read === 'true',
    }
  }
  const run = async (reply: FastifyReply, work: () => Promise<unknown>) => {
    try {
      return await work()
    } catch (cause) {
      if (
        cause instanceof Error &&
        [
          'invalid_query',
          'invalid notification cursor',
          'invalid notification page limit',
        ].includes(cause.message)
      )
        return error(reply, 400, 'invalid_request')
      throw cause
    }
  }
  const ids = (req: FastifyRequest) =>
    req.params as { notificationId: string; subjectId?: string }
  // Native navigation resolves current metadata after reauthorizing the notification subject.
  app.get('/api/sessions/:sessionId', async (req, reply) => {
    const access = await authenticate(req, reply)
    if (!access) return
    const { sessionId } = req.params as { sessionId: string }
    if (!sessionId || sessionId.length > 64) return error(reply, 404, 'session_not_found')
    const result = await deps.pool.query(`SELECT s.session_id,s.daemon_id,s.agent_type,s.cwd,s.title,s.source,s.status,
      s.created_at,s.updated_at,s.last_activity_at,s.model,s.pinned,s.archived_at,s.control_mode,s.capabilities,
      s.codex_home_id,s.codex_home_label,s.parent_session_id,s.root_session_id,s.is_subagent
      FROM sessions s JOIN daemons d ON d.daemon_id=s.daemon_id
      WHERE s.session_id=$1 AND s.user_id=$2 AND d.user_id=$2
        AND s.content_state NOT IN ('deleting','deleted')
        AND NOT EXISTS (SELECT 1 FROM deleted_sessions ds WHERE ds.session_id=s.session_id)`, [sessionId, access.userId])
    return result.rows[0] ? { session: result.rows[0] } : error(reply, 404, 'session_not_found')
  })
  app.get('/api/attention/notifications', async (req, reply) => {
    const access = await authenticate(req, reply)
    if (!access) return
    return run(reply, async () => {
      const result = await deps.repository.list({
        userId: access.userId,
        ...query(req),
      })
      return {
        schema_version: 1,
        notifications: result.notifications.map(serializeSystemNotification),
        notification_counts: { unread: result.unread },
        next_cursor: result.nextCursor,
      }
    })
  })
  app.get(
    '/api/attention/notifications/:notificationId',
    async (req, reply) => {
      const access = await authenticate(req, reply)
      if (!access) return
      const { notificationId } = ids(req)
      if (!UUID.test(notificationId))
        return error(reply, 404, 'notification_not_found')
      return run(reply, async () => {
        const result = await deps.repository.get(
          access.userId,
          notificationId,
          query(req).daemonId,
        )
        return result
          ? { notification: serializeSystemNotification(result) }
          : error(reply, 404, 'notification_not_found')
      })
    },
  )
  app.get(
    '/api/attention/notifications/:notificationId/subjects',
    async (req, reply) => {
      const access = await authenticate(req, reply)
      if (!access) return
      const { notificationId } = ids(req)
      if (!UUID.test(notificationId))
        return error(reply, 404, 'notification_not_found')
      return run(reply, async () => {
        const result = await deps.repository.subjects({
          userId: access.userId,
          notificationId,
          ...query(req),
        })
        return result
          ? {
              subjects: result.subjects.map(serializeNotificationSubject),
              subject_count: result.total,
              next_cursor: result.nextCursor,
            }
          : error(reply, 404, 'notification_not_found')
      })
    },
  )
  app.get(
    '/api/attention/notifications/:notificationId/subjects/:subjectId',
    async (req, reply) => {
      const access = await authenticate(req, reply)
      if (!access) return
      const { notificationId, subjectId } = ids(req)
      if (!UUID.test(notificationId) || !UUID.test(subjectId ?? ''))
        return error(reply, 404, 'notification_not_found')
      return run(reply, async () => {
        const result = await deps.repository.getSubject(
          access.userId,
          notificationId,
          subjectId!,
          query(req).daemonId,
        )
        return result
          ? { subject: serializeNotificationSubject(result) }
          : error(reply, 404, 'notification_not_found')
      })
    },
  )
  app.post(
    '/api/attention/notifications/:notificationId/read',
    async (req, reply) => {
      const access = await authenticate(req, reply)
      if (!access) return
      const { notificationId } = ids(req)
      if (!UUID.test(notificationId))
        return error(reply, 404, 'notification_not_found')
      const body = req.body as { expected_revision?: unknown } | null
      if (
        !Number.isSafeInteger(body?.expected_revision) ||
        Number(body?.expected_revision) < 1
      )
        return error(reply, 400, 'invalid_request')
      return run(reply, async () => {
        const result = await deps.repository.markRead(
          access.userId,
          notificationId,
          Number(body!.expected_revision),
          query(req).daemonId,
        )
        if (result === 'not_found')
          return error(reply, 404, 'notification_not_found')
        if (result === 'stale_revision')
          return error(reply, 409, 'stale_revision')
        return { status: 'read' }
      })
    },
  )
}
