import { createHash, randomUUID } from 'node:crypto'
import type pg from 'pg'

import { requireTaskDeliveryComplete } from './delivery-service.js'
import { requireTeamAccess } from './access.js'
import { TeamRepositoryError } from './repository.js'
import { parseTaskRequirements, taskReadiness, type TaskRequirements } from './task-readiness.js'
import type { TeamTaskState } from './types.js'

export interface TaskRequirementReceipt {task_id:string;actor_user_id:number;kind:'save'|'override';request_id:string;found:boolean;response:TeamTaskView|null}
export interface TaskHolderReceipt {task_id:string;actor_user_id:number;request_id:string;found:boolean;response:TeamTaskView|null}
export type TaskPoolFilter='all'|'unclaimed'|'mine'
export interface TaskRequirementHistory {events:Array<{event_id:string;actor_user_id:number|null;kind:'updated'|'override';requirements_revision:number;task_revision:number;details:Record<string,unknown>;created_at:string}>;next_before_revision:number|null}

type VisibleTaskState = Exclude<TeamTaskState, 'archived' | 'deleted'>

export interface TeamTaskView {
  has_delivery_contract?: boolean
  requirements?: {document:TaskRequirements;revision:number;readiness:ReturnType<typeof taskReadiness>;override:{actor_user_id:number;reason:string;requirements_revision:number}|null}
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

  private async idempotent(actorUserId: number, operation: string, requestId: string, payload: unknown, mutate: (client: pg.PoolClient) => Promise<TeamTaskView>): Promise<TeamTaskView> {
    const requestHash = hash(payload)
    return this.transaction(async client => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`team:${actorUserId}:${operation}:${requestId}`])
      const prior = await client.query<{ request_hash: string; response: TeamTaskView }>(
        `SELECT request_hash, response FROM collaboration_team_idempotency
         WHERE user_id = $1 AND operation = $2 AND request_id = $3`,
        [actorUserId, operation, requestId],
      )
      if (prior.rows[0]) {
        // A receipt retains the result, not the actor's former membership.
        // Do not reapply CAS or state transitions when replaying accepted work.
        await this.taskForUpdate(client, prior.rows[0].response.id, actorUserId)
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

  private async activeMembership(client: Pick<pg.Pool, 'query'>, teamId: string, actorUserId: number, lock = false): Promise<{ creator_user_id: number }> {
    await requireTeamAccess(client, actorUserId, lock)
    if (lock) {
      // Match revocation's Team -> membership -> Task lock order. Separate
      // reads also observe a membership change committed while waiting on Team.
      const team = await client.query<{ creator_user_id: number }>(
        `SELECT creator_user_id FROM collaboration_teams WHERE team_id = $1 AND state = 'active' FOR SHARE`, [teamId],
      )
      if (!team.rows[0]) throw new TeamRepositoryError('team_not_found', 'team not found')
      const member = await client.query(
        `SELECT role FROM collaboration_team_memberships WHERE team_id = $1 AND user_id = $2 AND state = 'active' FOR SHARE`,
        [teamId, actorUserId],
      )
      if (!member.rows[0]) throw new TeamRepositoryError('team_not_found', 'team not found')
      if (member.rows[0].role === 'viewer') throw new TeamRepositoryError('team_access_denied', 'read-only team member')
      return team.rows[0]
    }
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
    const identity = await client.query<{ team_id: string }>(`SELECT team_id FROM team_tasks WHERE task_id = $1`, [taskId])
    if (!identity.rows[0]) throw new TeamRepositoryError('team_not_found', 'task not found')
    const team = await this.activeMembership(client, identity.rows[0].team_id, actorUserId, true)
    const result = await client.query(
      `SELECT * FROM team_tasks WHERE task_id = $1 FOR UPDATE`,
      [taskId],
    )
    if (!result.rows[0]) throw new TeamRepositoryError('team_not_found', 'task not found')
    return { ...result.rows[0], team_creator_user_id: team.creator_user_id }
  }

  private expectRevision(row: { revision: string | number }, expectedRevision: number): void {
    const current = Number(row.revision)
    if (current !== expectedRevision) throw new TeamRepositoryError('revision_conflict', 'revision mismatch', current)
  }

  async listTasks(teamId: string, actorUserId: number, includeDeleted = false, filter:TaskPoolFilter='all'): Promise<TeamTaskView[]> {
    await this.activeMembership(this.pool, teamId, actorUserId)
    const result = await this.pool.query(
      `SELECT team_tasks.*, EXISTS(SELECT 1 FROM team_task_delivery_heads d WHERE d.task_id=team_tasks.task_id) AS has_delivery_contract FROM team_tasks WHERE team_id = $1
         AND ($2::boolean OR state <> 'deleted')
         AND ($3='all' OR state IN ('open','in_progress'))
         AND ($3<>'unclaimed' OR NOT EXISTS(SELECT 1 FROM team_task_holders h WHERE h.task_id=team_tasks.task_id AND h.state='active'))
         AND ($3<>'mine' OR EXISTS(SELECT 1 FROM team_task_holders h WHERE h.task_id=team_tasks.task_id AND h.state='active' AND h.user_id=$4))
       ORDER BY updated_at DESC,task_id`,
      [teamId, includeDeleted,filter,actorUserId],
    )
    return Promise.all(result.rows.map(row => this.view(this.pool, row)))
  }

  async getTask(taskId: string, actorUserId: number): Promise<TeamTaskView> {
    const result = await this.pool.query(
      `SELECT task.*, EXISTS(SELECT 1 FROM team_task_delivery_heads d WHERE d.task_id=task.task_id) AS has_delivery_contract FROM team_tasks task
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
      await this.activeMembership(client, input.teamId, input.actorUserId, true)
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
      if (nextState === 'completed') await requireTaskDeliveryComplete(client, input.taskId)
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
      if (task.previous_state === 'completed') await requireTaskDeliveryComplete(client, input.taskId)
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
        `SELECT role FROM collaboration_team_memberships WHERE team_id = $1 AND user_id = $2 AND state = 'active' FOR SHARE`,
        [task.team_id, input.holderUserId],
      )
      if (!member.rows[0]) throw new TeamRepositoryError('team_not_found', 'member not found')
      if (input.active && member.rows[0].role === 'viewer') throw new TeamRepositoryError('team_access_denied', 'read-only member cannot hold a task')
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

  async selfHolderReceipt(taskId: string, actorUserId: number, requestId: string): Promise<TaskHolderReceipt> {
    return this.transaction(async client => {
      // Recheck current access before exposing a retained write result. The
      // operation key binds both author and holder to the authenticated actor.
      await this.taskForUpdate(client, taskId, actorUserId)
      const result = await client.query<{ response: TeamTaskView }>(
        `SELECT response FROM collaboration_team_idempotency
         WHERE user_id=$1 AND operation=$2 AND request_id=$3`,
        [actorUserId, `team.task.holder:${taskId}:${actorUserId}`, requestId],
      )
      const response = result.rows[0]?.response ?? null
      return { task_id: taskId, actor_user_id: actorUserId, request_id: requestId, found: response !== null, response }
    })
  }

  async requirementReceipt(taskId:string,actorUserId:number,kind:'save'|'override',requestId:string):Promise<TaskRequirementReceipt>{
    return this.transaction(async client=>{
      // Same Team -> membership -> task order as writes/revocation. A retained
      // receipt never restores former permissions, even when writes are off.
      await this.taskForUpdate(client,taskId,actorUserId)
      const operation=kind==='save'?`team.task.requirements:${taskId}`:`team.task.requirements.override:${taskId}`
      const result=await client.query<{response:TeamTaskView}>(`SELECT response FROM collaboration_team_idempotency WHERE user_id=$1 AND operation=$2 AND request_id=$3`,[actorUserId,operation,requestId])
      const response=result.rows[0]?.response??null
      return {task_id:taskId,actor_user_id:actorUserId,kind,request_id:requestId,found:response!==null,response}
    })
  }

  async requirementHistory(taskId:string,actorUserId:number,beforeRevision?:number):Promise<TaskRequirementHistory>{
    await this.getTask(taskId,actorUserId)
    if(beforeRevision!==undefined&&(!Number.isSafeInteger(beforeRevision)||beforeRevision<1))throw new TeamRepositoryError('invalid_state','invalid history cursor')
    const rows=(await this.pool.query(`SELECT e.event_id,e.actor_user_id,e.kind,e.requirements_revision,e.task_revision,e.details,e.created_at
      FROM team_task_requirement_events e JOIN team_tasks task ON task.task_id=e.task_id
      JOIN collaboration_teams t ON t.team_id=task.team_id AND t.state='active'
      JOIN collaboration_team_memberships m ON m.team_id=t.team_id AND m.user_id=$2 AND m.state='active'
      WHERE e.task_id=$1 AND ($3::bigint IS NULL OR e.task_revision<$3)
      ORDER BY e.task_revision DESC LIMIT 51`,[taskId,actorUserId,beforeRevision??null])).rows
    const events=rows.slice(0,50).map(r=>({...r,requirements_revision:Number(r.requirements_revision),task_revision:Number(r.task_revision),created_at:iso(r.created_at)}))
    return {events,next_before_revision:rows.length>50?events[events.length-1].task_revision:null}
  }

  async updateRequirements(input:{taskId:string;actorUserId:number;expectedRevision:number;requestId:string;requirements:TaskRequirements}):Promise<TeamTaskView>{
    const requirements=parseTaskRequirements(input.requirements)
    return this.idempotent(input.actorUserId,`team.task.requirements:${input.taskId}`,input.requestId,{requirements,expected_revision:input.expectedRevision},async client=>{
      const task=await this.taskForUpdate(client,input.taskId,input.actorUserId)
      this.expectRevision(task,input.expectedRevision)
      if(task.state!=='open'&&task.state!=='in_progress')throw new TeamRepositoryError('invalid_state','task requirements are not editable')
      const row=(await client.query(`UPDATE team_tasks SET requirements=$2::jsonb,requirements_revision=requirements_revision+1,
        requirements_override=NULL,revision=revision+1,updated_at=NOW() WHERE task_id=$1 RETURNING *`,[input.taskId,JSON.stringify(requirements)])).rows[0]
      await client.query(`INSERT INTO team_task_requirement_events(event_id,task_id,actor_user_id,kind,requirements_revision,task_revision,details)
        VALUES($1,$2,$3,'updated',$4,$5,$6::jsonb)`,[randomUUID(),input.taskId,input.actorUserId,row.requirements_revision,row.revision,JSON.stringify({requirements})])
      return this.view(client as unknown as pg.Pool,row)
    })
  }

  async overrideRequirements(input:{taskId:string;actorUserId:number;expectedRevision:number;requestId:string;reason:string}):Promise<TeamTaskView>{
    const reason=input.reason.trim()
    if(!reason||reason.length>1000||reason.includes('\0'))throw new TeamRepositoryError('invalid_state','override reason required')
    return this.idempotent(input.actorUserId,`team.task.requirements.override:${input.taskId}`,input.requestId,{reason,expected_revision:input.expectedRevision},async client=>{
      const task=await this.taskForUpdate(client,input.taskId,input.actorUserId)
      this.expectRevision(task,input.expectedRevision)
      if(task.state!=='open'&&task.state!=='in_progress')throw new TeamRepositoryError('invalid_state','task requirements are not editable')
      if(task.creator_user_id!==input.actorUserId&&task.team_creator_user_id!==input.actorUserId)throw new TeamRepositoryError('creator_required','team or task creator authority required')
      if(!task.requirements)throw new TeamRepositoryError('invalid_state','save task requirements before overriding')
      const readiness=taskReadiness(parseTaskRequirements(task.requirements))
      if(!readiness.missing.length)throw new TeamRepositoryError('invalid_state','complete requirements need no override')
      const override={actor_user_id:input.actorUserId,reason,requirements_revision:Number(task.requirements_revision)}
      const row=(await client.query(`UPDATE team_tasks SET requirements_override=$2::jsonb,revision=revision+1,updated_at=NOW() WHERE task_id=$1 RETURNING *`,[input.taskId,JSON.stringify(override)])).rows[0]
      await client.query(`INSERT INTO team_task_requirement_events(event_id,task_id,actor_user_id,kind,requirements_revision,task_revision,details)
        VALUES($1,$2,$3,'override',$4,$5,$6::jsonb)`,[randomUUID(),input.taskId,input.actorUserId,row.requirements_revision,row.revision,JSON.stringify({reason,missing:readiness.missing})])
      return this.view(client as unknown as pg.Pool,row)
    })
  }

  private async view(db: Pick<pg.Pool, 'query'>, row: any): Promise<TeamTaskView> {
    const [holders, sessions] = await Promise.all([
      db.query<{ user_id: number }>(`SELECT user_id FROM team_task_holders WHERE task_id = $1 AND state = 'active' ORDER BY user_id`, [row.task_id]),
      db.query<{ team_session_id: string }>(`SELECT team_session_id FROM collaboration_sessions WHERE task_id = $1 OR EXISTS (SELECT 1 FROM collaboration_calls c WHERE c.task_id=$1 AND c.team_session_id=collaboration_sessions.team_session_id) ORDER BY created_at`, [row.task_id]),
    ])
    return {
      ...(row.requirements ? {requirements:{document:row.requirements,revision:Number(row.requirements_revision),readiness:taskReadiness(row.requirements),override:row.requirements_override??null}} : {}),
      ...(typeof row.has_delivery_contract === 'boolean' ? {has_delivery_contract:row.has_delivery_contract} : {}),
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
