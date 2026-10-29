import { validateTaskBudget, type TaskBudgetPolicy } from './budget-service.js'
import { TeamTaskBudgetRepository } from './budget-repository.js'
import type pg from 'pg'
import { randomUUID } from 'node:crypto'
import { requireTeamAccess, teamAccountsEnabled } from './access.js'
import { boundedText, stableDigest } from './delivery-contract.js'
import { TeamRepositoryError } from './repository.js'
import { TeamStepScheduler, reconciledAttemptState } from './step-scheduler.js'
import { requireUnchangedStartedSteps, type TaskPlanStep } from './plan-contract.js'

export interface PlanControlInput {
  request_id: string
  expected_revision: number
  plan_revision: number
  action: 'activate' | 'pause' | 'resume' | 'adopt_revision' | 'cancel' | 'retry' | 'reconcile' | 'new_version'
  invocation_limit?: number
  budget?: TaskBudgetPolicy
  attempt_id?: string
  expected_delivery_revision?: number
  reason?: string
}

/** Control plane; activation and scheduling remain explicitly gated.
 * Pause/cancel stop future reservations, never claim to stop an issued Call. */
export class TeamPlanExecutionService {
  constructor(private readonly pool: pg.Pool, private readonly enabledForTeam: (teamId: string) => boolean = () => false) {}

  private async read<T>(taskId: string, actor: number, run: (client: pg.PoolClient, task: any, role: string) => Promise<T>): Promise<T> {
    boundedText(taskId, 'task_id', 128)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await requireTeamAccess(client, actor, true)
      const identity = (await client.query('SELECT team_id FROM team_tasks WHERE task_id=$1', [taskId])).rows[0]
      if (!identity) throw new TeamRepositoryError('team_not_found', 'task not found')
      const team = (await client.query("SELECT 1 FROM collaboration_teams WHERE team_id=$1 AND state='active' FOR SHARE", [identity.team_id])).rows[0]
      const member = (await client.query("SELECT role FROM collaboration_team_memberships WHERE team_id=$1 AND user_id=$2 AND state='active' FOR SHARE", [identity.team_id, actor])).rows[0]
      if (!team || !member) throw new TeamRepositoryError('team_not_found', 'task not found')
      const task = (await client.query('SELECT * FROM team_tasks WHERE task_id=$1 FOR SHARE', [taskId])).rows[0]
      if (!task || task.state === 'deleted') throw new TeamRepositoryError('team_not_found', 'task not found')
      const result = await run(client, task, member.role)
      await client.query('COMMIT')
      return result
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
    finally { client.release() }
  }

  async getExecution(taskId: string, actor: number) {
    return this.read(taskId, actor, async (client, task, role) => {
      const runtime = (await client.query('SELECT plan_revision,revision,state,initiator_user_id,invocation_limit,updated_at FROM team_task_plan_runtime WHERE task_id=$1', [taskId])).rows[0]
      const attempts = (await client.query(`SELECT a.attempt_id,a.plan_revision,a.step_id,a.attempt_no,a.state,a.call_id,a.accepted_submission_id,a.input_hash,a.created_at,a.updated_at,
        c.state AS call_state,
        jsonb_array_length(a.frozen_inputs) AS input_source_count,
        h.spec_revision,h.revision AS delivery_revision,h.latest_submission_id,d.decision AS latest_decision
        FROM team_task_step_attempts a LEFT JOIN collaboration_calls c ON c.call_id=a.call_id
        LEFT JOIN team_step_delivery_heads h ON h.attempt_id=a.attempt_id
        LEFT JOIN team_acceptance_decisions d ON d.submission_id=h.latest_submission_id
        WHERE a.task_id=$1 ORDER BY a.created_at,a.attempt_id`, [taskId])).rows
      const pending = (await client.query('SELECT generation>acknowledged_generation AS pending,last_error_code FROM team_step_wakeups WHERE task_id=$1', [taskId])).rows[0]
      const controller = role !== 'viewer' && (role === 'admin' || Number(task.creator_user_id) === actor)
      return { schema_version: 1, task_id: taskId, revision: Number(runtime?.revision ?? 0),
        runtime: runtime ? { ...runtime, plan_revision: Number(runtime.plan_revision), revision: Number(runtime.revision), invocation_limit: Number(runtime.invocation_limit) } : null,
        attempts: attempts.map(a => ({ ...a, plan_revision: Number(a.plan_revision), spec_revision: a.spec_revision == null ? null : Number(a.spec_revision), delivery_revision: a.delivery_revision == null ? null : Number(a.delivery_revision) })),
        invocation_count: attempts.length, new_version_enabled: this.enabledForTeam(task.team_id), execution_enabled: this.enabledForTeam(task.team_id),
        can_control: controller, issued_calls_stopped: false, budget: await new TeamTaskBudgetRepository().snapshot(client, taskId),
        scheduler: pending ?? { pending: false, last_error_code: null } }
    })
  }

  async lookupReceipt(taskId: string, actor: number, requestId: string) {
    boundedText(requestId, 'request_id', 128)
    return this.read(taskId, actor, async client => {
      const receipt = (await client.query('SELECT response FROM team_task_plan_control_receipts WHERE task_id=$1 AND actor_user_id=$2 AND request_id=$3', [taskId, actor, requestId])).rows[0]
      return { task_id: taskId, actor_user_id: actor, request_id: requestId, found: !!receipt, response: receipt?.response ?? null }
    })
  }

  async control(taskId: string, actor: number, input: PlanControlInput) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TeamRepositoryError('invalid_request', 'invalid plan control request')
    boundedText(taskId, 'task_id', 128); boundedText(input.request_id, 'request_id', 128)
    if (!['activate','pause','resume','adopt_revision','cancel','retry','reconcile','new_version'].includes(input.action)
      || !Number.isSafeInteger(input.expected_revision) || input.expected_revision < 0
      || !Number.isSafeInteger(input.plan_revision) || input.plan_revision < 1
      || Object.keys(input).some(k => !['request_id','expected_revision','plan_revision','action','invocation_limit','budget','attempt_id','expected_delivery_revision','reason'].includes(k))) throw new TeamRepositoryError('invalid_request', 'invalid plan control request')
    if (input.action === 'activate' ? !Number.isSafeInteger(input.invocation_limit) || input.invocation_limit! < 1 || input.invocation_limit! > 128 : input.invocation_limit !== undefined) {
      throw new TeamRepositoryError('invalid_request', 'activation requires an explicit invocation limit; later controls cannot reset it')
    }
    if (input.budget !== undefined) {
      if (input.action !== 'activate') throw new TeamRepositoryError('invalid_request', 'an activated plan budget cannot be reset')
      validateTaskBudget(input.budget)
    }
    if (input.action === 'new_version') boundedText(input.reason, 'reason', 1000)
    else if (input.reason !== undefined) throw new TeamRepositoryError('invalid_request', 'reason is only valid for new versions')
    const stepAction = ['retry','reconcile','new_version'].includes(input.action)
    if (stepAction ? typeof input.attempt_id !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(input.attempt_id) : input.attempt_id !== undefined) {
      throw new TeamRepositoryError('invalid_request', 'step recovery requires an exact attempt identity')
    }
    if (['retry','new_version'].includes(input.action) ? !Number.isSafeInteger(input.expected_delivery_revision) || input.expected_delivery_revision! < 1 : input.expected_delivery_revision !== undefined) {
      throw new TeamRepositoryError('invalid_request', 'retry requires the current step delivery revision')
    }
    const requestHash = stableDigest(input), client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await requireTeamAccess(client, actor, true)
      const identity = (await client.query('SELECT team_id FROM team_tasks WHERE task_id=$1', [taskId])).rows[0]
      if (!identity) throw new TeamRepositoryError('team_not_found', 'task not found')
      const team = (await client.query("SELECT 1 FROM collaboration_teams WHERE team_id=$1 AND state='active' FOR SHARE", [identity.team_id])).rows[0]
      const member = (await client.query("SELECT role FROM collaboration_team_memberships WHERE team_id=$1 AND user_id=$2 AND state='active' FOR SHARE", [identity.team_id, actor])).rows[0]
      if (!team || !member) throw new TeamRepositoryError('team_not_found', 'task not found')
      const plan = (await client.query('SELECT * FROM team_task_plan_revisions WHERE task_id=$1 AND revision=$2', [taskId, input.plan_revision])).rows[0]
      if (!plan) throw new TeamRepositoryError('team_not_found', 'plan not found')
      // Match the only existing dispatch path's Session -> Task lock order.
      const session = (await client.query('SELECT * FROM collaboration_sessions WHERE team_session_id=$1 AND team_id=$2 FOR UPDATE', [plan.team_session_id, identity.team_id])).rows[0]
      const task = (await client.query('SELECT * FROM team_tasks WHERE task_id=$1 FOR UPDATE', [taskId])).rows[0]
      if (!session || !task || task.state === 'deleted') throw new TeamRepositoryError('team_not_found', 'task not found')
      if (member.role === 'viewer' || (member.role !== 'admin' && Number(task.creator_user_id) !== actor)) throw new TeamRepositoryError('creator_required', 'task creator or Team admin required')
      const prior = (await client.query('SELECT request_hash,response FROM team_task_plan_control_receipts WHERE task_id=$1 AND actor_user_id=$2 AND request_id=$3', [taskId, actor, input.request_id])).rows[0]
      if (prior) {
        if (prior.request_hash !== requestHash) throw new TeamRepositoryError('idempotency_conflict', 'request ID reused')
        await client.query('COMMIT'); return prior.response
      }
      const runtime = (await client.query('SELECT * FROM team_task_plan_runtime WHERE task_id=$1', [taskId])).rows[0]
      const revision = Number(runtime?.revision ?? 0)
      if (revision !== input.expected_revision) throw new TeamRepositoryError('revision_conflict', 'plan execution control changed', revision)
      if (input.action === 'activate' ? !!runtime : !runtime) throw new TeamRepositoryError('invalid_state', 'plan activation state does not match request')
      if (runtime?.state === 'cancelled' && input.action !== 'reconcile') throw new TeamRepositoryError('invalid_state', 'cancelled plan execution cannot be resumed')
      if (runtime && input.action !== 'adopt_revision' && Number(runtime.plan_revision) !== input.plan_revision) throw new TeamRepositoryError('revision_conflict', 'active plan revision changed')
      if ((input.action === 'pause' && runtime.state !== 'active') || (['resume','adopt_revision'].includes(input.action) && runtime.state !== 'paused')) throw new TeamRepositoryError('invalid_state', 'pause or resume boundary changed')
      let recovery: Record<string, unknown> | undefined
      if (stepAction) {
        if (input.action === 'retry' || input.action === 'new_version') {
          if (!this.enabledForTeam(identity.team_id)) throw new TeamRepositoryError('team_feature_disabled', 'plan execution disabled')
          if (runtime.state !== 'active' || !['open','in_progress'].includes(task.state) || session.state !== 'active') throw new TeamRepositoryError('invalid_state', 'retry requires active task, session and plan')
          const scheduler = new TeamStepScheduler(this.pool, this.enabledForTeam)
          const reserved = input.action === 'new_version'
            ? await scheduler.reserveNewVersion(client, taskId, actor, input.attempt_id!, input.expected_delivery_revision!, input.reason!)
            : await scheduler.reserveRetry(client, taskId, actor, input.attempt_id!, input.expected_delivery_revision!)
          if (reserved.state !== 'reserved') throw new TeamRepositoryError('invalid_state', 'step retry did not reserve work')
          recovery = { previous_attempt_id: input.attempt_id, attempt_id: reserved.attempt_id, call_id: reserved.call_id, attempt_state: 'reserved' }
        } else {
          const attempt = (await client.query('SELECT * FROM team_task_step_attempts WHERE task_id=$1 AND attempt_id=$2', [taskId, input.attempt_id])).rows[0]
          if (!attempt) throw new TeamRepositoryError('team_not_found', 'step attempt not found')
          const call = (await client.query('SELECT call_id,state FROM collaboration_calls WHERE task_id=$1 AND call_id=$2 FOR UPDATE NOWAIT', [taskId, attempt.call_id])).rows[0]
          if (!call) throw new TeamRepositoryError('invalid_state', 'original step Call is unavailable')
          const state = reconciledAttemptState(attempt.state, call.state)
          if (state !== attempt.state) await client.query('UPDATE team_task_step_attempts SET state=$2,updated_at=NOW() WHERE attempt_id=$1', [attempt.attempt_id, state])
          recovery = { attempt_id: attempt.attempt_id, call_id: call.call_id, call_state: call.state, attempt_state: state, new_call_created: false }
        }
      }
      const enablesWork = ['activate','resume','adopt_revision'].includes(input.action)
      if (enablesWork) {
        if (!this.enabledForTeam(identity.team_id)) throw new TeamRepositoryError('team_feature_disabled', 'plan execution disabled')
        if (!['open','in_progress'].includes(task.state) || session.state !== 'active') throw new TeamRepositoryError('invalid_state', 'task and session must be active')
        if (!(await client.query("SELECT 1 FROM collaboration_session_participants WHERE team_session_id=$1 AND user_id=$2 AND state='active' FOR SHARE", [plan.team_session_id, actor])).rows[0]) throw new TeamRepositoryError('participant_required', 'active session participant required')
        if (input.action !== 'resume') {
          const head = (await client.query('SELECT revision FROM team_task_plan_heads WHERE task_id=$1', [taskId])).rows[0]
          if (Number(head?.revision) !== input.plan_revision) throw new TeamRepositoryError('revision_conflict', 'activate the current draft revision explicitly')
        }
        if (runtime && runtime.plan_revision !== plan.revision) {
          const old = (await client.query('SELECT team_session_id FROM team_task_plan_revisions WHERE task_id=$1 AND revision=$2', [taskId, runtime.plan_revision])).rows[0]
          if (old.team_session_id !== plan.team_session_id) throw new TeamRepositoryError('invalid_request', 'an active plan cannot migrate shared sessions')
        }
        const spec = (await client.query('SELECT spec_revision FROM team_task_delivery_heads WHERE task_id=$1', [taskId])).rows[0]
        if (Number(spec?.spec_revision) !== Number(plan.spec_revision)) throw new TeamRepositoryError('revision_conflict', 'task specification changed since plan save')
        if (Number(session.current_context_version) !== Number(plan.context_version)) throw new TeamRepositoryError('context_revision_conflict', 'shared Context changed since plan save')
        const steps = (await client.query('SELECT definition FROM team_task_plan_steps WHERE task_id=$1 AND plan_revision=$2', [taskId, input.plan_revision])).rows.map(r => r.definition as TaskPlanStep)
        // Draft validation predates activation/adoption. An old revision may
        // have reserved more steps since this draft was saved.
        const started = (await client.query(`SELECT DISTINCT s.step_id,s.definition FROM team_task_step_attempts a
          JOIN team_task_plan_steps s ON s.task_id=a.task_id AND s.plan_revision=a.plan_revision AND s.step_id=a.step_id WHERE a.task_id=$1`, [taskId])).rows
        requireUnchangedStartedSteps(steps, started)
        const reviewers = [...new Set(steps.map(s => s.review_policy.reviewer_user_id))].sort((a,b) => a-b)
        if (!await teamAccountsEnabled(client, reviewers, true)) throw new TeamRepositoryError('reviewer_required', 'reviewer unavailable')
        const memberships = (await client.query("SELECT user_id FROM collaboration_team_memberships WHERE team_id=$1 AND user_id=ANY($2::int[]) AND state='active' AND role<>'viewer' FOR SHARE", [identity.team_id, reviewers])).rows
        if (memberships.length !== reviewers.length) throw new TeamRepositoryError('reviewer_required', 'reviewer must be a writable Team member')
        const offers = [...new Set(steps.map(s => s.review_policy.primary_offer_id))].sort()
        const available = (await client.query(`SELECT o.offer_id FROM team_agent_offers o
          JOIN collaboration_session_agent_bindings b ON b.offer_id=o.offer_id AND b.team_session_id=$1 AND b.state='active'
          JOIN collaboration_team_memberships m ON m.team_id=o.team_id AND m.user_id=o.owner_user_id AND m.state='active' AND m.role<>'viewer'
          JOIN users u ON u.id=o.owner_user_id AND u.team_enabled
          JOIN daemons d ON d.daemon_id=o.daemon_id AND d.user_id=o.owner_user_id AND d.status='online'
          WHERE o.team_id=$2 AND o.state='active' AND o.offer_id=ANY($3::text[])
            AND d.collaboration_capabilities @> '["team_collaboration_dispatch_v1","team_collaboration_context_v1","team_task_delivery_v1","team_task_steps_v1"]'::jsonb
          ORDER BY o.offer_id FOR SHARE OF o,b,m,u,d`, [plan.team_session_id, identity.team_id, offers])).rows
        if (available.length !== offers.length) throw new TeamRepositoryError('capability_not_supported', 'each selected Agent must support step execution')
        const used = Number((await client.query('SELECT count(*)::int n FROM team_task_step_attempts WHERE task_id=$1', [taskId])).rows[0].n)
        const limit = Number(runtime?.invocation_limit ?? input.invocation_limit)
        const unstarted = Number((await client.query(`SELECT count(*)::int n FROM team_task_plan_steps s WHERE s.task_id=$1 AND s.plan_revision=$2
          AND NOT EXISTS(SELECT 1 FROM team_task_step_attempts a WHERE a.task_id=s.task_id AND a.step_id=s.step_id)`, [taskId, input.plan_revision])).rows[0].n)
        if (used + unstarted > limit) throw new TeamRepositoryError('budget_exhausted', 'plan invocation limit cannot cover the planned work')
        if (input.action === 'activate' && (await client.query("SELECT 1 FROM collaboration_calls WHERE task_id=$1 AND state IN ('pending','dispatched','accepted','uncertain') LIMIT 1", [taskId])).rows[0]) throw new TeamRepositoryError('invalid_state', 'reconcile outstanding execution before activation')
      }
      const state = stepAction ? runtime.state : input.action === 'cancel' ? 'cancelled' : ['pause','adopt_revision'].includes(input.action) ? 'paused' : 'active'
      await client.query(`INSERT INTO team_task_plan_runtime(task_id,plan_revision,revision,state,initiator_user_id,invocation_limit,budget_policy)
        VALUES($1,$2,1,$3,$4,$5,$6::jsonb) ON CONFLICT(task_id) DO UPDATE SET plan_revision=EXCLUDED.plan_revision,
          revision=team_task_plan_runtime.revision+1,state=EXCLUDED.state,initiator_user_id=EXCLUDED.initiator_user_id,updated_at=NOW()`,
        [taskId, input.plan_revision, state, stepAction ? runtime.initiator_user_id : actor, runtime?.invocation_limit ?? input.invocation_limit,JSON.stringify(runtime?.budget_policy ?? input.budget ?? {})])
      const response = { task_id: taskId, revision: revision + 1, plan_revision: input.plan_revision, state, invocation_limit: Number(runtime?.invocation_limit ?? input.invocation_limit), budget: runtime?.budget_policy ?? input.budget ?? {}, issued_calls_stopped: false, ...(recovery ? { recovery } : {}) }
      await client.query("INSERT INTO team_delivery_outbox(event_id,task_id,kind,payload) VALUES($1,$2,'plan_control_changed',$3::jsonb)", [randomUUID(), taskId, JSON.stringify({ plan_revision: input.plan_revision, state, control_revision: revision+1 })])
      await client.query('INSERT INTO team_task_plan_control_receipts(task_id,actor_user_id,request_id,request_hash,response) VALUES($1,$2,$3,$4,$5::jsonb)', [taskId, actor, input.request_id, requestHash, JSON.stringify(response)])
      await client.query('COMMIT'); return response
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      if ((error as { code?: string }).code === '55P03') throw new TeamRepositoryError('source_busy', 'original Call is busy; retry the same control request')
      throw error
    } finally { client.release() }
  }
}
