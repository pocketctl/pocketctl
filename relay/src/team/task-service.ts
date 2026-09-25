import { createHash, randomUUID } from 'node:crypto'
import type pg from 'pg'

import { TeamRepositoryError } from './repository.js'
import type { TeamTaskState } from './types.js'

type VisibleTaskState = Exclude<TeamTaskState, 'archived' | 'deleted'>

export interface TeamTaskView {
  id: string
  team_id: string
  creator_user_id: number
  title: string
  background: string
  state: TeamTaskState
  previous_state: VisibleTaskState | null
  revision: number
  holder_user_ids: number[]
  session_ids: string[]
  created_at: string
  updated_at: string
  deleted_at: string | null
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function nullableIso(value: Date | string | null): string | null {
  return value === null ? null : iso(value)
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export class TeamTaskService {
  constructor(private readonly pool: pg.Pool) {}

  private async transaction<T>(run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await run(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      try { await client.query('ROLLBACK') } catch { /* Preserve the domain error. */ }
      throw error
    } finally {
      client.release()
    }
  }

  private async idempotent<T>(actorUserId: number, operation: string, requestId: string, payload: unknown, mutate: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const requestHash = hash(payload)
    return this.transaction(async client => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`team:${actorUserId}:${operation}:${requestId}`])
      const prior = await client.query<{ request_hash: string; response: T }>(
        `SELECT request_hash, response FROM collaboration_team_idempotency
         WHERE user_id = $1 AND operation = $2 AND request_id = $3`,
        [actorUserId, operation, requestId],
      )
      if (prior.rows[0]) {
        if (prior.rows[0].request_hash !== requestHash) throw new TeamRepositoryError('idempotency_conflict', 'request_id was reused with different content')
        return prior.rows[0].response
      }
      const response = await mutate(client)
      await client.query(
        `INSERT INTO collaboration_team_idempotency (user_id, operation, request_id, request_hash, response)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [actorUserId, operation, requestId, requestHash, JSON.stringify(response)],
      )
      return response
    })
  }

  private async activeMembership(client: Pick<pg.Pool, 'query'>, teamId: string, actorUserId: number): Promise<{ creator_user_id: number }> {
    const result = await client.query<{ creator_user_id: number }>(
      `SELECT t.creator_user_id FROM collaboration_teams t
       JOIN collaboration_team_memberships m
         ON m.team_id = t.team_id AND m.user_id = $2 AND m.state = 'active'
       WHERE t.team_id = $1 AND t.state = 'active'`,
      [teamId, actorUserId],
    )
    if (!result.rows[0]) throw new TeamRepositoryError('team_not_found', 'team not found')
    return result.rows[0]
  }

  private async taskForUpdate(client: pg.PoolClient, taskId: string, actorUserId: number): Promise<any> {
    const result = await client.query(
      `SELECT task.*, team.creator_user_id AS team_creator_user_id
       FROM team_tasks task
       JOIN collaboration_teams team ON team.team_id = task.team_id AND team.state = 'active'
       JOIN collaboration_team_memberships membership
         ON membership.team_id = task.team_id AND membership.user_id = $2 AND membership.state = 'active'
       WHERE task.task_id = $1 FOR UPDATE OF task`,
      [taskId, actorUserId],
    )
    if (!result.rows[0]) throw new TeamRepositoryError('team_not_found', 'task not found')
    return result.rows[0]
  }

  private expectRevision(row: { revision: string | number }, expectedRevision: number): void {
    const current = Number(row.revision)
    if (current !== expectedRevision) throw new TeamRepositoryError('revision_conflict', 'revision mismatch', current)
  }

  async listTasks(teamId: string, actorUserId: number, includeDeleted = false): Promise<TeamTaskView[]> {
    await this.activeMembership(this.pool, teamId, actorUserId)
    const result = await this.pool.query(
      `SELECT * FROM team_tasks WHERE team_id = $1
         AND ($2::boolean OR state <> 'deleted')
       ORDER BY updated_at DESC`,
      [teamId, includeDeleted],
    )
    return Promise.all(result.rows.map(row => this.view(this.pool, row)))
  }

  async getTask(taskId: string, actorUserId: number): Promise<TeamTaskView> {
    const result = await this.pool.query(
      `SELECT task.* FROM team_tasks task
       JOIN collaboration_team_memberships membership
         ON membership.team_id = task.team_id AND membership.user_id = $2 AND membership.state = 'active'
       JOIN collaboration_teams team ON team.team_id = task.team_id AND team.state = 'active'
       WHERE task.task_id = $1`,
      [taskId, actorUserId],
    )
    if (!result.rows[0]) throw new TeamRepositoryError('team_not_found', 'task not found')
    return this.view(this.pool, result.rows[0])
  }

  async createTask(input: { teamId: string; actorUserId: number; title: string; background: string; requestId: string }): Promise<TeamTaskView> {
    return this.idempotent(input.actorUserId, `team.task.create:${input.teamId}`, input.requestId, {
      title: input.title, background: input.background,
    }, async client => {
      await this.activeMembership(client as unknown as pg.Pool, input.teamId, input.actorUserId)
      const result = await client.query(
        `INSERT INTO team_tasks (task_id, team_id, creator_user_id, title, background)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [`ctk_${randomUUID()}`, input.teamId, input.actorUserId, input.title, input.background],
      )
      return this.view(client as unknown as pg.Pool, result.rows[0])
    })
  }

  async updateTask(input: {
    taskId: string
    actorUserId: number
    title?: string
    background?: string
    state?: VisibleTaskState | 'archived'
    expectedRevision: number
    requestId: string
  }): Promise<TeamTaskView> {
    return this.idempotent(input.actorUserId, `team.task.update:${input.taskId}`, input.requestId, {
      title: input.title, background: input.background, state: input.state, expected_revision: input.expectedRevision,
    }, async client => {
      const task = await this.taskForUpdate(client, input.taskId, input.actorUserId)
      this.expectRevision(task, input.expectedRevision)
      if (task.state === 'archived' || task.state === 'deleted') throw new TeamRepositoryError('invalid_state', 'task must be restored before editing')
      let nextState = (input.state ?? task.state) as TeamTaskState
      let previousState = task.previous_state as VisibleTaskState | null
      if (nextState === 'archived') {
        if (task.team_creator_user_id !== input.actorUserId && task.creator_user_id !== input.actorUserId) {
          throw new TeamRepositoryError('creator_required', 'team or task creator authority required')
        }
        previousState = task.state
      } else {
        const allowed = task.state === nextState
          || (task.state === 'open' && nextState === 'in_progress')
          || (task.state === 'in_progress' && (nextState === 'open' || nextState === 'completed'))
        if (!allowed) throw new TeamRepositoryError('invalid_state', `cannot transition task from ${task.state} to ${nextState}`)
      }
      const updated = await client.query(
        `UPDATE team_tasks SET title = COALESCE($2, title), background = COALESCE($3, background),
           state = $4, previous_state = $5, revision = revision + 1, updated_at = NOW()
         WHERE task_id = $1 RETURNING *`,
        [input.taskId, input.title ?? null, input.background ?? null, nextState, previousState],
      )
      return this.view(client as unknown as pg.Pool, updated.rows[0])
    })
  }

  async deleteTask(input: { taskId: string; actorUserId: number; expectedRevision: number; requestId: string }): Promise<TeamTaskView> {
    return this.idempotent(input.actorUserId, `team.task.delete:${input.taskId}`, input.requestId, { expected_revision: input.expectedRevision }, async client => {
      const task = await this.taskForUpdate(client, input.taskId, input.actorUserId)
      this.expectRevision(task, input.expectedRevision)
      if (task.team_creator_user_id !== input.actorUserId && task.creator_user_id !== input.actorUserId) {
        throw new TeamRepositoryError('creator_required', 'team or task creator authority required')
      }
      if (task.state === 'deleted') return this.view(client as unknown as pg.Pool, task)
      const previousState = task.state === 'archived' ? task.previous_state : task.state
      const updated = await client.query(
        `UPDATE team_tasks SET state = 'deleted', previous_state = $2, revision = revision + 1,
           updated_at = NOW(), deleted_at = NOW() WHERE task_id = $1 RETURNING *`,
        [input.taskId, previousState],
      )
      return this.view(client as unknown as pg.Pool, updated.rows[0])
    })
  }

  async restoreTask(input: { taskId: string; actorUserId: number; expectedRevision: number; requestId: string }): Promise<TeamTaskView> {
    return this.idempotent(input.actorUserId, `team.task.restore:${input.taskId}`, input.requestId, { expected_revision: input.expectedRevision }, async client => {
      const task = await this.taskForUpdate(client, input.taskId, input.actorUserId)
      this.expectRevision(task, input.expectedRevision)
      if (task.team_creator_user_id !== input.actorUserId && task.creator_user_id !== input.actorUserId) {
        throw new TeamRepositoryError('creator_required', 'team or task creator authority required')
      }
      if (task.state !== 'archived' && task.state !== 'deleted') throw new TeamRepositoryError('invalid_state', 'task is not archived or deleted')
      const updated = await client.query(
        `UPDATE team_tasks SET state = COALESCE(previous_state, 'open'), previous_state = NULL,
           revision = revision + 1, updated_at = NOW(), deleted_at = NULL
         WHERE task_id = $1 RETURNING *`,
        [input.taskId],
      )
      return this.view(client as unknown as pg.Pool, updated.rows[0])
    })
  }

  async setHolder(input: { taskId: string; actorUserId: number; holderUserId: number; active: boolean; expectedRevision: number; requestId: string }): Promise<TeamTaskView> {
    return this.idempotent(input.actorUserId, `team.task.holder:${input.taskId}:${input.holderUserId}`, input.requestId, {
      active: input.active, expected_revision: input.expectedRevision,
    }, async client => {
      const task = await this.taskForUpdate(client, input.taskId, input.actorUserId)
      this.expectRevision(task, input.expectedRevision)
      if (task.state === 'archived' || task.state === 'deleted') throw new TeamRepositoryError('invalid_state', 'task is not editable')
      if (input.holderUserId !== input.actorUserId && task.team_creator_user_id !== input.actorUserId) {
        throw new TeamRepositoryError('creator_required', 'team creator authority required to change another holder')
      }
      const member = await client.query(
        `SELECT 1 FROM collaboration_team_memberships WHERE team_id = $1 AND user_id = $2 AND state = 'active'`,
        [task.team_id, input.holderUserId],
      )
      if (!member.rows[0]) throw new TeamRepositoryError('team_not_found', 'member not found')
      await client.query(
        `INSERT INTO team_task_holders (task_id, user_id, state, released_at)
         VALUES ($1, $2, $3::varchar, CASE WHEN $3::varchar = 'released' THEN NOW() ELSE NULL END)
         ON CONFLICT (task_id, user_id) DO UPDATE SET state = EXCLUDED.state,
           revision = team_task_holders.revision + 1, updated_at = NOW(), released_at = EXCLUDED.released_at`,
        [input.taskId, input.holderUserId, input.active ? 'active' : 'released'],
      )
      const updated = await client.query(
        `UPDATE team_tasks SET revision = revision + 1, updated_at = NOW() WHERE task_id = $1 RETURNING *`,
        [input.taskId],
      )
      return this.view(client as unknown as pg.Pool, updated.rows[0])
    })
  }

  async linkSession(input: { taskId: string; sessionId: string; actorUserId: number; linked: boolean; expectedRevision: number; requestId: string }): Promise<TeamTaskView> {
    return this.idempotent(input.actorUserId, `team.task.session:${input.taskId}:${input.sessionId}`, input.requestId, {
      linked: input.linked, expected_revision: input.expectedRevision,
    }, async client => {
      const task = await this.taskForUpdate(client, input.taskId, input.actorUserId)
      this.expectRevision(task, input.expectedRevision)
      if (task.state === 'archived' || task.state === 'deleted') throw new TeamRepositoryError('invalid_state', 'task is not editable')
      const session = await client.query<{ task_id: string | null }>(
        `SELECT task_id FROM collaboration_sessions WHERE team_session_id = $1 AND team_id = $2 FOR UPDATE`,
        [input.sessionId, task.team_id],
      )
      if (!session.rows[0]) throw new TeamRepositoryError('team_not_found', 'session not found')
      if (input.linked && session.rows[0].task_id && session.rows[0].task_id !== input.taskId) {
        throw new TeamRepositoryError('invalid_state', 'session is already linked to another task')
      }
      if (!input.linked && session.rows[0].task_id !== input.taskId) {
        throw new TeamRepositoryError('invalid_state', 'session is not linked to this task')
      }
      await client.query(
        `UPDATE collaboration_sessions SET task_id = $2, revision = revision + 1, updated_at = NOW()
         WHERE team_session_id = $1`,
        [input.sessionId, input.linked ? input.taskId : null],
      )
      const updated = await client.query(
        `UPDATE team_tasks SET revision = revision + 1, updated_at = NOW() WHERE task_id = $1 RETURNING *`,
        [input.taskId],
      )
      return this.view(client as unknown as pg.Pool, updated.rows[0])
    })
  }

  private async view(db: Pick<pg.Pool, 'query'>, row: any): Promise<TeamTaskView> {
    const [holders, sessions] = await Promise.all([
      db.query<{ user_id: number }>(`SELECT user_id FROM team_task_holders WHERE task_id = $1 AND state = 'active' ORDER BY user_id`, [row.task_id]),
      db.query<{ team_session_id: string }>(`SELECT team_session_id FROM collaboration_sessions WHERE task_id = $1 ORDER BY created_at`, [row.task_id]),
    ])
    return {
      id: row.task_id,
      team_id: row.team_id,
      creator_user_id: Number(row.creator_user_id),
      title: row.title,
      background: row.background,
      state: row.state,
      previous_state: row.previous_state,
      revision: Number(row.revision),
      holder_user_ids: holders.rows.map(holder => Number(holder.user_id)),
      session_ids: sessions.rows.map(session => session.team_session_id),
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
      deleted_at: nullableIso(row.deleted_at),
    }
  }
}
