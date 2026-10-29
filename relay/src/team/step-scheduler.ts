import { frozenTaskRequirementsText } from './task-requirements-snapshot.js'
import { TeamTaskBudgetRepository } from './budget-repository.js'
import { requireTaskBudgetCapacity } from './budget-service.js'
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { requireTeamAccess, teamAccountsEnabled } from './access.js'
import { stableDigest } from './delivery-contract.js'
import { freezeAcceptedPlanInputs, type FrozenPlanInput, type PlanInputSelection } from './plan-inputs.js'
import type { TaskPlanStep } from './plan-contract.js'
import { TeamRepositoryError } from './repository.js'
import { TeamSessionService } from './session-service.js'
import { StepWakeupRepository, type StepWakeupClaim } from './step-wakeup-repository.js'
import { requireBoundedStepInputs } from './step-input-service.js'

/** A database projection of the original Call, never a new dispatch or a
 * fabricated terminal outcome. Human acceptance and terminal attempts persist. */
export function reconciledAttemptState(attemptState: string, callState: string): string {
  if (['accepted', 'failed', 'cancelled', 'awaiting_review'].includes(attemptState)) return attemptState
  return ({ pending: 'reserved', dispatched: 'dispatched', accepted: 'running', uncertain: 'unknown',
    completed: 'awaiting_review', failed: 'failed', blocked: 'failed', cancelled: 'cancelled' } as Record<string, string>)[callState] ?? attemptState
}

export type StepAdvanceResult = { state: 'inactive' | 'waiting' | 'reconciled' | 'reserved'; attempt_id?: string; call_id?: string }

/** One fenced database transaction per wakeup. This creates ordinary Call
 * intents, never performs native I/O and never starts a polling worker itself.
 * One reservation per pass keeps all domain locks before the queue signal.
 * Failed/unknown attempts require explicit recovery; no automatic new attempt. */
export class TeamStepScheduler {
  private readonly wakeups: StepWakeupRepository
  private readonly sessions: TeamSessionService
  constructor(private readonly pool: pg.Pool, private readonly enabledForTeam: (teamId: string) => boolean = () => false) {
    this.wakeups = new StepWakeupRepository(pool)
    this.sessions = new TeamSessionService(pool)
  }

  async process(claim: StepWakeupClaim): Promise<StepAdvanceResult> {
    try { return await this.wakeups.processClaim(claim, client => this.advance(client, claim)) }
    catch (error) {
      // Native event projection can hold Call before Session. Never wait on
      // that inverse order while this transaction already holds Session.
      if ((error as { code?: string }).code === '55P03') throw new TeamRepositoryError('source_busy', 'step source is busy; retry the original wakeup')
      throw error
    }
  }

  /** Called only by the control service inside its authorized Session -> Task
   * transaction. A user request is fenced by control CAS/receipt, not a worker lease. */
  async reserveRetry(client: pg.PoolClient, taskId: string, actor: number, attemptId: string, deliveryRevision: number): Promise<StepAdvanceResult> {
    return this.advance(client, { task_id: taskId, lease_token: '0' }, { actor, attemptId, deliveryRevision })
  }

  async reserveNewVersion(client: pg.PoolClient, taskId: string, actor: number, attemptId: string, deliveryRevision: number, reason: string): Promise<StepAdvanceResult> {
    return this.advance(client, { task_id: taskId, lease_token: '0' }, { actor, attemptId, deliveryRevision, newVersionReason: reason })
  }

  private async advance(client: pg.PoolClient, claim: Pick<StepWakeupClaim, 'task_id' | 'lease_token'>,
    retry?: { actor: number; attemptId: string; deliveryRevision: number; newVersionReason?: string }): Promise<StepAdvanceResult> {
    const identity = (await client.query(`SELECT t.team_id,r.initiator_user_id,p.team_session_id
      FROM team_task_plan_runtime r JOIN team_tasks t USING(task_id)
      JOIN team_task_plan_revisions p ON p.task_id=r.task_id AND p.revision=r.plan_revision WHERE r.task_id=$1`, [claim.task_id])).rows[0]
    if (!identity || !this.enabledForTeam(identity.team_id)) return { state: 'inactive' }
    const actor = retry?.actor ?? Number(identity.initiator_user_id)
    await requireTeamAccess(client, actor, true)
    const team = (await client.query("SELECT 1 FROM collaboration_teams WHERE team_id=$1 AND state='active' FOR SHARE", [identity.team_id])).rows[0]
    const member = (await client.query("SELECT role FROM collaboration_team_memberships WHERE team_id=$1 AND user_id=$2 AND state='active' FOR SHARE", [identity.team_id, actor])).rows[0]
    const session = (await client.query('SELECT * FROM collaboration_sessions WHERE team_session_id=$1 FOR UPDATE', [identity.team_session_id])).rows[0]
    const task = (await client.query('SELECT * FROM team_tasks WHERE task_id=$1 FOR UPDATE', [claim.task_id])).rows[0]
    const runtime = (await client.query('SELECT * FROM team_task_plan_runtime WHERE task_id=$1', [claim.task_id])).rows[0]
    if (!team || !member || member.role === 'viewer' || (member.role !== 'admin' && Number(task.creator_user_id) !== actor)) throw new TeamRepositoryError('creator_required', 'plan initiator is no longer authorized')
    if (!retry && Number(runtime.initiator_user_id) !== actor) throw new TeamRepositoryError('revision_conflict', 'plan controller changed; re-read before advancing')
    if (!['open','in_progress'].includes(task.state) || session.state !== 'active') return { state: 'inactive' }
    if (!(await client.query("SELECT 1 FROM collaboration_session_participants WHERE team_session_id=$1 AND user_id=$2 AND state='active' FOR SHARE", [identity.team_session_id, actor])).rows[0]) throw new TeamRepositoryError('participant_required', 'plan initiator left the session')

    // Lock all existing Calls before any attempt/outbox update signals the queue.
    const calls = (await client.query('SELECT call_id,state FROM collaboration_calls WHERE task_id=$1 ORDER BY call_id FOR UPDATE NOWAIT', [claim.task_id])).rows
    const attempts = (await client.query('SELECT * FROM team_task_step_attempts WHERE task_id=$1 ORDER BY step_id,attempt_no DESC', [claim.task_id])).rows
    const changes: { id: string; state: string }[] = []
    for (const attempt of attempts) {
      if (['accepted','failed','cancelled','awaiting_review'].includes(attempt.state)) continue
      const call = calls.find(c => c.call_id === attempt.call_id)
      const state = call && reconciledAttemptState(attempt.state, call.state)
      if (state && state !== attempt.state) changes.push({ id: attempt.attempt_id, state })
    }
    if (changes.length && !retry) {
      for (const change of changes) await client.query('UPDATE team_task_step_attempts SET state=$2,updated_at=NOW() WHERE attempt_id=$1', [change.id, change.state])
      return { state: 'reconciled' }
    }
    if (runtime.state !== 'active') return { state: 'inactive' }
    const plan = (await client.query('SELECT * FROM team_task_plan_revisions WHERE task_id=$1 AND revision=$2', [claim.task_id, runtime.plan_revision])).rows[0]
    if (plan.team_session_id !== identity.team_session_id) throw new TeamRepositoryError('revision_conflict', 'plan session changed')
    const steps = (await client.query('SELECT definition FROM team_task_plan_steps WHERE task_id=$1 AND plan_revision=$2 ORDER BY position', [claim.task_id, runtime.plan_revision])).rows.map(r => r.definition as TaskPlanStep)
    const latest = new Map<string, any>()
    for (const attempt of attempts) if (!latest.has(attempt.step_id)) latest.set(attempt.step_id, attempt)
    let retryAttempt: any
    let retryContext = ''
    if (retry) {
      retryAttempt = attempts.find(a => a.attempt_id === retry.attemptId)
      if (!retryAttempt || latest.get(retryAttempt.step_id)?.attempt_id !== retry.attemptId) throw new TeamRepositoryError('revision_conflict', 'retry requires the latest step attempt')
      const call = calls.find(c => c.call_id === retryAttempt.call_id)
      const head = (await client.query('SELECT revision,latest_submission_id FROM team_step_delivery_heads WHERE attempt_id=$1', [retry.attemptId])).rows[0]
      if (Number(head?.revision) !== retry.deliveryRevision) throw new TeamRepositoryError('revision_conflict', 'step delivery changed before retry')
      const decision = call?.state === 'completed' && retryAttempt.state === 'awaiting_review' && head.latest_submission_id
        ? (await client.query("SELECT decision_id,reason FROM team_acceptance_decisions WHERE submission_id=$1 AND decision='changes_requested'", [head.latest_submission_id])).rows[0] : undefined
      const rejected = !!decision
      const accepted = retry.newVersionReason !== undefined && call?.state === 'completed' && retryAttempt.state === 'accepted'
        && retryAttempt.accepted_submission_id === head.latest_submission_id
        ? (await client.query("SELECT decision_id FROM team_acceptance_decisions WHERE task_id=$1 AND submission_id=$2 AND decision='accepted'", [claim.task_id, head.latest_submission_id])).rows[0] : undefined
      if (retry.newVersionReason !== undefined ? !accepted : (!call || retryAttempt.state === 'accepted' || (!['failed','blocked','cancelled'].includes(call.state) && !rejected))) {
        throw new TeamRepositoryError('invalid_state', 'reconcile the original Call; retry requires a known failure, cancellation or requested changes')
      }
      // Reconcile this attempt explicitly first; do not update the queue before
      // candidate domain locks or silently coerce unknown into a failure.
      if (reconciledAttemptState(retryAttempt.state, call.state) !== retryAttempt.state) throw new TeamRepositoryError('invalid_state', 'reconcile the original Call before retry')
      retryContext = `\n\n上一尝试：${retryAttempt.attempt_id}；原调用：${call.call_id}；状态：${call.state}。`
        + (decision ? `\n要求修改的交付：${head.latest_submission_id}；决定：${decision.decision_id}。\n验收意见：\n${decision.reason}` : '')
        + (accepted ? `\n生成新版本；保留原已验收交付：${head.latest_submission_id}；决定：${accepted.decision_id}。\n新版本说明：\n${retry.newVersionReason}` : '')
    }
    const ready = steps.filter(s => (retry ? s.step_id === retryAttempt.step_id : !latest.has(s.step_id))
      && s.depends_on.every(id => latest.get(id)?.state === 'accepted'))
    if (retry && !ready.length) throw new TeamRepositoryError('acceptance_required', 'retry dependencies are not accepted')
    if (!ready.length) return { state: 'waiting' }
    const budget = await new TeamTaskBudgetRepository().snapshot(client, claim.task_id)
    if (!budget) throw new TeamRepositoryError('invalid_state', 'plan budget unavailable')
    requireTaskBudgetCapacity(budget)
    let selected: { step: TaskPlanStep; offer: { offer_id: string; binding_id: string }; inputs: FrozenPlanInput[]; attemptId: string; message: Awaited<ReturnType<TeamSessionService['appendMessage']>> } | undefined
    let lastBlocked: unknown
    for (const step of ready) {
      // A blocked independent branch must not starve another ready branch.
      // Savepoints release candidate locks and recover NOWAIT's aborted query.
      await client.query('SAVEPOINT step_candidate')
      try {
        const reviewer = step.review_policy.reviewer_user_id
        if (!await teamAccountsEnabled(client, [reviewer], true) || !(await client.query("SELECT 1 FROM collaboration_team_memberships WHERE team_id=$1 AND user_id=$2 AND state='active' AND role<>'viewer' FOR SHARE", [identity.team_id, reviewer])).rows[0]) throw new TeamRepositoryError('reviewer_required', 'step reviewer unavailable')
        const offer = (await client.query(`SELECT o.offer_id,b.binding_id FROM team_agent_offers o
          JOIN collaboration_session_agent_bindings b ON b.offer_id=o.offer_id AND b.team_session_id=$1 AND b.state='active'
          JOIN collaboration_team_memberships m ON m.team_id=o.team_id AND m.user_id=o.owner_user_id AND m.state='active' AND m.role<>'viewer'
          JOIN users u ON u.id=o.owner_user_id AND u.team_enabled
          JOIN daemons d ON d.daemon_id=o.daemon_id AND d.user_id=o.owner_user_id AND d.status='online'
          WHERE o.team_id=$2 AND o.state='active' AND o.offer_id=$3
            AND d.collaboration_capabilities @> '["team_collaboration_dispatch_v1","team_collaboration_context_v1","team_task_delivery_v1","team_task_steps_v1"]'::jsonb
          FOR SHARE OF o,b,m,u,d NOWAIT`, [identity.team_session_id, identity.team_id, step.review_policy.primary_offer_id])).rows[0]
        if (!offer) throw new TeamRepositoryError('capability_not_supported', 'selected Agent cannot execute steps')
        if ((await client.query("SELECT 1 FROM collaboration_calls WHERE binding_id=$1 AND state IN ('pending','dispatched','accepted','uncertain') LIMIT 1", [offer.binding_id])).rows[0]) throw new TeamRepositoryError('agent_unavailable', 'selected native session is busy; retry the same wakeup')
        const selections: PlanInputSelection[] = step.depends_on.map(id => ({ step_id: id, attempt_id: latest.get(id).attempt_id, submission_id: latest.get(id).accepted_submission_id }))
        const inputs = await freezeAcceptedPlanInputs(client, claim.task_id, Number(runtime.plan_revision), step.step_id, selections)
        requireBoundedStepInputs(inputs)
        const attemptId = randomUUID()
        const message = await this.sessions.appendMessage({ sessionId: identity.team_session_id, actorUserId: actor, requestId: `step-${attemptId}`,
          content: `执行计划步骤：${step.title}\n\n任务目标：\n${step.instruction}\n\n交付与验收：\n${step.acceptance}\n\n这是一次新的步骤调用，交付文件必须写入本次调用指定目录。上游输入仅以本次冻结版本为准。可通过本次 inputs.json 的 task_context 读取任务上下文；旧格式缺少该字段时使用本调用冻结的规格。${retryContext}${frozenTaskRequirementsText(task)}`,
          targetMode: 'offers', targetOfferIds: [offer.offer_id], referenceEventId: null, contextVersion: Number(plan.context_version) }, client)
        if (message.call_ids.length !== 1) throw new Error('step requires exactly one Call')
        selected = { step, offer, inputs, attemptId, message }
        await client.query('RELEASE SAVEPOINT step_candidate')
        break
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT step_candidate')
        await client.query('RELEASE SAVEPOINT step_candidate')
        if (!['55P03','reviewer_required','capability_not_supported','agent_unavailable','artifact_unavailable','acceptance_required','evidence_required','revision_conflict','team_feature_disabled','offer_owner_required','no_callable_agent','input_limit_exceeded'].includes((error as {code:string}).code)) throw error
        lastBlocked = error
      }
    }
    if (!selected) throw lastBlocked
    const { step, offer, inputs, attemptId, message } = selected
    const reviewer = step.review_policy.reviewer_user_id
    const specRevision = Number((await client.query('SELECT COALESCE(MAX(revision),0)+1 AS revision FROM team_task_specs WHERE task_id=$1', [claim.task_id])).rows[0].revision)
    const callId = message.call_ids[0]
    await client.query('UPDATE collaboration_events SET request_id=NULL WHERE event_id=$1', [message.event.id])
    await client.query('UPDATE collaboration_calls SET task_id=$2 WHERE call_id=$1', [callId, claim.task_id])
    await client.query(`INSERT INTO team_task_specs(task_id,revision,goal,acceptance,primary_offer_id,reviewer_user_id,required_checks,created_by_user_id)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`, [claim.task_id, specRevision, step.instruction, step.acceptance, offer.offer_id, reviewer, JSON.stringify(step.review_policy.required_checks), actor])
    await client.query('INSERT INTO team_call_delivery_specs(call_id,task_id,spec_revision) VALUES($1,$2,$3)', [callId, claim.task_id, specRevision])
    await client.query("UPDATE team_tasks SET state='in_progress',revision=revision+1,updated_at=NOW() WHERE task_id=$1", [claim.task_id])
    // No pre-existing domain row locks after this first queue-producing write.
    await client.query(`INSERT INTO team_task_step_attempts(attempt_id,task_id,plan_revision,step_id,attempt_no,state,call_id,lease_token,frozen_inputs,input_hash)
      VALUES($1,$2,$3,$4,$9,'reserved',$5,$6,$7::jsonb,$8)`, [attemptId, claim.task_id, runtime.plan_revision, step.step_id, callId, claim.lease_token, JSON.stringify(inputs), stableDigest(inputs), retryAttempt ? Number(retryAttempt.attempt_no) + 1 : 1])
    await client.query('INSERT INTO team_step_delivery_heads(attempt_id,task_id,spec_revision) VALUES($1,$2,$3)', [attemptId, claim.task_id, specRevision])
    await client.query("INSERT INTO team_delivery_outbox(event_id,task_id,kind,payload) VALUES($1,$2,'step_reserved',$3::jsonb)", [randomUUID(), claim.task_id, JSON.stringify({ attempt_id: attemptId, call_id: callId, plan_revision: Number(runtime.plan_revision), step_id: step.step_id })])
    await new TeamTaskBudgetRepository().requireDurationCapacity(client, claim.task_id)
    return { state: 'reserved', attempt_id: attemptId, call_id: callId }
  }
}
