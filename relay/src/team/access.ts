import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { TeamRepositoryError } from './repository.js'

type Queryable = Pick<pg.PoolClient, 'query'>

// Independent from plans, quota whitelists, invitations and membership.
// Mutation callers reuse their transaction, so revocation serializes with
// accepted work without borrowing another connection from the pool.
export async function isTeamEnabled(db: Queryable, userId: number): Promise<boolean> {
  const result = await db.query<{ team_enabled: boolean }>('SELECT team_enabled FROM users WHERE id = $1', [userId])
  return result.rows[0]?.team_enabled === true
}

export async function teamAccountsEnabled(db: Queryable, userIds: number[], lock = false): Promise<boolean> {
  const ids = [...new Set(userIds)].sort((a, b) => a - b)
  if (!ids.length || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) return false
  const result = await db.query<{ id: number; team_enabled: boolean }>(
    `SELECT id, team_enabled FROM users WHERE id = ANY($1::int[]) ORDER BY id${lock ? ' FOR SHARE' : ''}`, [ids],
  )
  return result.rows.length === ids.length && result.rows.every(row => row.team_enabled === true)
}

export async function requireTeamAccess(db: Queryable, userId: number, lock = false): Promise<void> {
  if (!await teamAccountsEnabled(db, [userId], lock)) {
    throw new TeamRepositoryError('team_access_denied', 'Team is not enabled for this account')
  }
}

export async function setTeamAccess(pool: pg.Pool, input: {
  userId: number; enabled: boolean; operator: string; reason: string
}): Promise<{ user_id: number; team_enabled: boolean; changed: boolean }> {
  if (!Number.isSafeInteger(input.userId) || input.userId <= 0 || typeof input.enabled !== 'boolean'
    || !input.operator.trim() || input.operator.length > 100 || !input.reason.trim() || input.reason.length > 1000) {
    throw new Error('A positive user ID, boolean access, operator (1-100 chars) and reason (1-1000 chars) are required')
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const user = (await client.query<{ team_enabled: boolean }>('SELECT team_enabled FROM users WHERE id = $1 FOR UPDATE', [input.userId])).rows[0]
    if (!user) throw new Error('Account not found')
    const changed = user.team_enabled !== input.enabled
    if (changed) {
      await client.query('UPDATE users SET team_enabled = $2 WHERE id = $1', [input.userId, input.enabled])
      await client.query(`INSERT INTO team_access_audit(user_id,previous_enabled,enabled,operator,reason) VALUES($1,$2,$3,$4,$5)`,
        [input.userId, user.team_enabled, input.enabled, input.operator.trim(), input.reason.trim()])
    }
    await client.query('COMMIT')
    return { user_id: input.userId, team_enabled: input.enabled, changed }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally { client.release() }
}

export function registerTeamAccessGuard(app: FastifyInstance, dependencies: {
  verifyAccessToken(token: string): Promise<{ userId: number } | null>
  isTeamEnabled(userId: number): Promise<boolean>
  getDatabaseReady(): boolean
}): void {
  app.addHook('preHandler', async (request, reply) => {
    const path = request.routeOptions.url
    if (!path?.startsWith('/api/team/') || path === '/api/team/capabilities') return
    const header = request.headers.authorization
    const actor = header?.startsWith('Bearer ') ? await dependencies.verifyAccessToken(header.slice(7).trim()) : null
    if (!actor) return reply.code(401).send({ error: { code: 'authorization_required', message: 'Authorization required', retryable: false } })
    if (!dependencies.getDatabaseReady()) return reply.code(503).send({ error: { code: 'database_unavailable', message: 'Database unavailable', retryable: true } })
    if (!await dependencies.isTeamEnabled(actor.userId)) {
      return reply.code(403).send({ error: { code: 'team_access_denied', message: 'Team is not enabled for this account', retryable: false } })
    }
  })
}
