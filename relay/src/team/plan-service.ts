import type pg from 'pg'
import { requireTeamAccess, teamAccountsEnabled } from './access.js'
import { boundedText, stableDigest } from './delivery-contract.js'
import { PLAN_LIMITS, requireUnchangedStartedSteps, stepDigest, validateTaskPlan, type TaskPlanInput, type TaskPlanStep } from './plan-contract.js'
import { TeamRepositoryError } from './repository.js'

export class TeamPlanService {
  constructor(private readonly pool: pg.Pool, private readonly options: { writesEnabledForTeam(teamId: string): boolean } = { writesEnabledForTeam: () => false }) {}

  private async transaction<T>(run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try { await client.query('BEGIN'); const result = await run(client); await client.query('COMMIT'); return result }
    catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
    finally { client.release() }
  }

  private async access(client: pg.PoolClient, taskId: string, actor: number, write: boolean) {
    boundedText(taskId, 'task_id', 128)
    await requireTeamAccess(client, actor, true)
    const task = (await client.query('SELECT * FROM team_tasks WHERE task_id=$1', [taskId])).rows[0]
    if (!task) throw new TeamRepositoryError('team_not_found', 'task not found')
    const team = (await client.query("SELECT creator_user_id FROM collaboration_teams WHERE team_id=$1 AND state='active' FOR SHARE", [task.team_id])).rows[0]
    const member = (await client.query("SELECT role FROM collaboration_team_memberships WHERE team_id=$1 AND user_id=$2 AND state='active' FOR SHARE", [task.team_id, actor])).rows[0]
    if (!team || !member) throw new TeamRepositoryError('team_not_found', 'task not found')
    if (write && (member.role === 'viewer' || (member.role !== 'admin' && Number(task.creator_user_id) !== actor))) throw new TeamRepositoryError('creator_required', 'task creator or Team admin required')
    if (write && !this.options.writesEnabledForTeam(task.team_id)) throw new TeamRepositoryError('team_feature_disabled', 'task plan draft writes disabled for this Team')
    return { ...task, role: member.role }
  }

  private async snapshot(client: pg.PoolClient, taskId: string, revision: number) {
    const plan = (await client.query('SELECT * FROM team_task_plan_revisions WHERE task_id=$1 AND revision=$2', [taskId, revision])).rows[0]
    if (!plan) return null
    const steps = (await client.query('SELECT definition FROM team_task_plan_steps WHERE task_id=$1 AND plan_revision=$2 ORDER BY position', [taskId, revision])).rows.map(row => row.definition as TaskPlanStep)
    return { ...plan, revision: Number(plan.revision), context_version: Number(plan.context_version), spec_revision: Number(plan.spec_revision), steps }
  }

  async getPlan(taskId: string, actor: number, revision?: number) {
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) throw new TeamRepositoryError('invalid_request', 'invalid plan revision')
    return this.transaction(async client => {
      const task = await this.access(client, taskId, actor, false)
      // Shared Task lock also fences delete/restore during this read.
      const currentTask = (await client.query('SELECT state FROM team_tasks WHERE task_id=$1 FOR SHARE', [taskId])).rows[0]
      if (!currentTask || currentTask.state === 'deleted') throw new TeamRepositoryError('team_not_found', 'task not found')
      const head = (await client.query('SELECT revision,state FROM team_task_plan_heads WHERE task_id=$1', [taskId])).rows[0]
      const current = Number(head?.revision ?? 0)
      const plan = current ? await this.snapshot(client, taskId, revision ?? current) : null
      if (revision !== undefined && !plan) throw new TeamRepositoryError('team_not_found', 'plan revision not found')
      return { task_id: taskId, revision: current, state: head?.state ?? 'absent', plan,
        writes_enabled: this.options.writesEnabledForTeam(task.team_id) && task.role !== 'viewer' && (task.role === 'admin' || Number(task.creator_user_id) === actor),
        execution_enabled: false as const }
    })
  }

  async lookupReceipt(taskId: string, actor: number, requestId: string) {
    boundedText(requestId, 'request_id', 128)
    return this.transaction(async client => {
      await this.access(client, taskId, actor, false)
      const task = (await client.query('SELECT state FROM team_tasks WHERE task_id=$1 FOR SHARE', [taskId])).rows[0]
      if (!task || task.state === 'deleted') throw new TeamRepositoryError('team_not_found', 'task not found')
      const row = (await client.query('SELECT response FROM team_task_plan_receipts WHERE task_id=$1 AND actor_user_id=$2 AND request_id=$3', [taskId, actor, requestId])).rows[0]
      return { task_id: taskId, actor_user_id: actor, request_id: requestId, found: !!row, response: row?.response ?? null }
    })
  }

  /** Read-only advisory choices for plans; never enables legacy task execution. */
  async editingOptions(taskId: string, actor: number) {
    return this.transaction(async client => {
      const task = await this.access(client, taskId, actor, false)
      const current = (await client.query('SELECT state FROM team_tasks WHERE task_id=$1 FOR SHARE', [taskId])).rows[0]
      if (!current || current.state === 'deleted') throw new TeamRepositoryError('team_not_found', 'task not found')
      const head = (await client.query('SELECT revision FROM team_task_plan_heads WHERE task_id=$1', [taskId])).rows[0]
      const spec = (await client.query('SELECT spec_revision FROM team_task_delivery_heads WHERE task_id=$1', [taskId])).rows[0]
      const runtime = (await client.query(`SELECT p.team_session_id FROM team_task_plan_runtime r JOIN team_task_plan_revisions p ON p.task_id=r.task_id AND p.revision=r.plan_revision WHERE r.task_id=$1`, [taskId])).rows[0]
      const started = (await client.query('SELECT DISTINCT step_id FROM team_task_step_attempts WHERE task_id=$1 ORDER BY step_id', [taskId])).rows.map(r => r.step_id as string)
      const canEdit = this.options.writesEnabledForTeam(task.team_id) && ['open','in_progress'].includes(current.state) && !!spec && task.role !== 'viewer' && (task.role === 'admin' || Number(task.creator_user_id) === actor)
      const base = { task_id: taskId, can_edit: canEdit, revision: Number(head?.revision ?? 0), spec_revision: Number(spec?.spec_revision ?? 0), started_step_ids: started, locked_session_id: runtime?.team_session_id ?? null }
      if (!canEdit) return { ...base, reviewers: [], offers: [], sessions: [] }
      const reviewers = (await client.query(`SELECT m.user_id FROM collaboration_team_memberships m JOIN users u ON u.id=m.user_id
        WHERE m.team_id=$1 AND m.state='active' AND m.role<>'viewer' AND u.team_enabled ORDER BY m.user_id`, [task.team_id])).rows
      const offers = (await client.query(`SELECT o.offer_id,o.provider,o.owner_user_id FROM team_agent_offers o
        JOIN collaboration_team_memberships m ON m.team_id=o.team_id AND m.user_id=o.owner_user_id AND m.state='active'
        JOIN users u ON u.id=o.owner_user_id AND u.team_enabled
        WHERE o.team_id=$1 AND o.state='active' ORDER BY o.offer_id`, [task.team_id])).rows
      const sessions = (await client.query(`SELECT s.team_session_id,s.title,s.current_context_version,
        COALESCE((SELECT jsonb_agg(b.offer_id ORDER BY b.offer_id) FROM collaboration_session_agent_bindings b
          JOIN team_agent_offers o ON o.offer_id=b.offer_id AND o.state='active' AND o.team_id=s.team_id
          JOIN collaboration_team_memberships m ON m.team_id=o.team_id AND m.user_id=o.owner_user_id AND m.state='active'
          JOIN users u ON u.id=o.owner_user_id AND u.team_enabled
          JOIN daemons d ON d.daemon_id=o.daemon_id AND d.user_id=o.owner_user_id AND d.status='online'
          WHERE b.team_session_id=s.team_session_id AND b.state='active'
            AND d.collaboration_capabilities @> '["team_collaboration_dispatch_v1","team_collaboration_context_v1","team_task_delivery_v1"]'::jsonb),'[]') AS offer_ids
        FROM collaboration_sessions s JOIN collaboration_session_participants p ON p.team_session_id=s.team_session_id
        WHERE s.team_id=$1 AND s.state='active' AND p.user_id=$2 AND p.state='active' AND (s.task_id=$3 OR EXISTS(SELECT 1 FROM collaboration_calls c WHERE c.task_id=$3 AND c.team_session_id=s.team_session_id) OR EXISTS(SELECT 1 FROM team_task_template_sources ts WHERE ts.task_id=$3 AND ts.team_session_id=s.team_session_id))
        ORDER BY s.created_at DESC,s.team_session_id`, [task.team_id, actor, taskId])).rows
        .map(row => ({ ...row, current_context_version: Number(row.current_context_version) }))
      return { ...base, reviewers, offers, sessions: sessions.filter(row => !runtime || row.team_session_id === runtime.team_session_id) }
    })
  }

  async saveDraft(taskId: string, actor: number, input: TaskPlanInput) {
    return this.transaction(client => this.saveDraftInTransaction(client, taskId, actor, input))
  }

  /** Internal transaction composition for atomic template task creation. */
  async saveDraftInTransaction(client: pg.PoolClient, taskId: string, actor: number, input: TaskPlanInput) {
    const order = validateTaskPlan(input), requestHash = stableDigest(input)
      const task = await this.access(client, taskId, actor, true)
      // Session before Task matches executeTask, preventing an inverse lock pair.
      const session = (await client.query(`SELECT * FROM collaboration_sessions WHERE team_session_id=$1 AND team_id=$2 AND state='active' FOR SHARE`, [input.team_session_id, task.team_id])).rows[0]
      if (!session) throw new TeamRepositoryError('team_not_found', 'active shared session not found')
      const participant = (await client.query("SELECT 1 FROM collaboration_session_participants WHERE team_session_id=$1 AND user_id=$2 AND state='active' FOR SHARE", [input.team_session_id, actor])).rows[0]
      if (!participant) throw new TeamRepositoryError('participant_required', 'active session participant required')
      const currentTask = (await client.query('SELECT * FROM team_tasks WHERE task_id=$1 FOR UPDATE', [taskId])).rows[0]
      if (!currentTask || currentTask.state === 'deleted') throw new TeamRepositoryError('team_not_found', 'task not found')
      const prior = (await client.query('SELECT request_hash,response FROM team_task_plan_receipts WHERE task_id=$1 AND actor_user_id=$2 AND request_id=$3', [taskId, actor, input.request_id])).rows[0]
      if (prior) {
        if (prior.request_hash !== requestHash) throw new TeamRepositoryError('idempotency_conflict', 'request ID reused with different content')
        return prior.response
      }
      if (!['open', 'in_progress'].includes(currentTask.state)) throw new TeamRepositoryError('invalid_state', 'restore or reopen task before editing plan')
      const linked = (await client.query('SELECT 1 FROM collaboration_calls WHERE task_id=$1 AND team_session_id=$2 UNION ALL SELECT 1 FROM team_task_template_sources WHERE task_id=$1 AND team_session_id=$2 LIMIT 1', [taskId, input.team_session_id])).rows[0]
      if (session.task_id !== taskId && !linked) throw new TeamRepositoryError('invalid_request', 'session does not belong to this task')
      const head = (await client.query('SELECT revision,state FROM team_task_plan_heads WHERE task_id=$1', [taskId])).rows[0]
      const revision = Number(head?.revision ?? 0)
      if (revision !== input.expected_revision) throw new TeamRepositoryError('revision_conflict', 'plan revision changed', revision)
      if (revision >= PLAN_LIMITS.revisions) throw new TeamRepositoryError('invalid_state', 'plan revision limit reached')
      const spec = (await client.query('SELECT spec_revision FROM team_task_delivery_heads WHERE task_id=$1', [taskId])).rows[0]
      if (!spec || Number(spec.spec_revision) !== input.spec_revision) throw new TeamRepositoryError('revision_conflict', 'task specification changed')
      if (Number(session.current_context_version) !== input.context_version) throw new TeamRepositoryError('context_revision_conflict', 'shared Context version changed')
      const context = input.context_version === 0 ? null : (await client.query('SELECT content_hash FROM collaboration_context_versions WHERE team_session_id=$1 AND version=$2', [input.team_session_id, input.context_version])).rows[0]
      if (input.context_version > 0 && !context) throw new TeamRepositoryError('context_revision_conflict', 'shared Context version unavailable')
      const started = (await client.query(`SELECT DISTINCT s.step_id,s.definition FROM team_task_step_attempts a
        JOIN team_task_plan_steps s ON s.task_id=a.task_id AND s.plan_revision=a.plan_revision AND s.step_id=a.step_id WHERE a.task_id=$1`, [taskId])).rows
      requireUnchangedStartedSteps(input.steps, started)
      const reviewers = [...new Set(input.steps.map(step => step.review_policy.reviewer_user_id))].sort((a, b) => a - b)
      if (!await teamAccountsEnabled(client, reviewers, true)) throw new TeamRepositoryError('reviewer_required', 'reviewer account unavailable')
      const members = (await client.query("SELECT user_id FROM collaboration_team_memberships WHERE team_id=$1 AND user_id=ANY($2::int[]) AND state='active' AND role<>'viewer' ORDER BY user_id FOR SHARE", [task.team_id, reviewers])).rows
      if (members.length !== reviewers.length) throw new TeamRepositoryError('reviewer_required', 'reviewers must be writable members of this Team')
      const offers = [...new Set(input.steps.map(step => step.review_policy.primary_offer_id))].sort()
      const available = (await client.query(`SELECT o.offer_id FROM team_agent_offers o
        JOIN collaboration_session_agent_bindings b ON b.offer_id=o.offer_id AND b.team_session_id=$1 AND b.state='active'
        JOIN collaboration_team_memberships m ON m.team_id=o.team_id AND m.user_id=o.owner_user_id AND m.state='active'
        JOIN users u ON u.id=o.owner_user_id AND u.team_enabled
        JOIN daemons d ON d.daemon_id=o.daemon_id AND d.user_id=o.owner_user_id AND d.status='online'
        WHERE o.team_id=$2 AND o.state='active' AND o.offer_id=ANY($3::text[])
          AND d.collaboration_capabilities @> '["team_collaboration_dispatch_v1","team_collaboration_context_v1","team_task_delivery_v1"]'::jsonb
        ORDER BY o.offer_id FOR SHARE OF o,b,m,u,d`, [input.team_session_id, task.team_id, offers])).rows
      if (available.length !== offers.length) throw new TeamRepositoryError('agent_unavailable', 'each step needs an active bound Agent with delivery capability')
      const steps = order.map(id => input.steps.find(step => step.step_id === id)!)
      const planHash = stableDigest({ team_session_id: input.team_session_id, context_version: input.context_version, context_hash: context?.content_hash ?? null,
        spec_revision: input.spec_revision, steps: steps.map(step => ({ step_id: step.step_id, hash: stepDigest(step) })) })
      await client.query(`INSERT INTO team_task_plan_revisions(task_id,revision,team_session_id,context_version,context_hash,spec_revision,plan_hash,created_by_user_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [taskId, revision + 1, input.team_session_id, input.context_version, context?.content_hash ?? null, input.spec_revision, planHash, actor])
      for (const [position, step] of steps.entries()) await client.query(`INSERT INTO team_task_plan_steps(task_id,plan_revision,step_id,position,definition,step_hash) VALUES($1,$2,$3,$4,$5::jsonb,$6)`, [taskId, revision + 1, step.step_id, position, JSON.stringify(step), stepDigest(step)])
      await client.query(`INSERT INTO team_task_plan_heads(task_id,revision) VALUES($1,$2) ON CONFLICT(task_id) DO UPDATE SET revision=EXCLUDED.revision`, [taskId, revision + 1])
      const response = { task_id: taskId, revision: revision + 1, state: 'draft', plan_hash: planHash, execution_enabled: false }
      await client.query('INSERT INTO team_task_plan_receipts(task_id,actor_user_id,request_id,request_hash,response) VALUES($1,$2,$3,$4,$5::jsonb)', [taskId, actor, input.request_id, requestHash, JSON.stringify(response)])
      return response
  }
}
