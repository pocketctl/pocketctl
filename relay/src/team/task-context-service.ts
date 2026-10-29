import { TRUSTED_EVIDENCE_COLUMNS } from './evidence-service.js'
import type pg from 'pg'
import { requireTeamAccess } from './access.js'
import { boundedText } from './delivery-contract.js'
import { TeamRepositoryError } from './repository.js'

/** Human read contract. No dispatch, receipt, reservation or provider I/O. */
export class TeamTaskContextService {
  constructor(private readonly pool: pg.Pool) {}

  async resolve(taskId: string, actor: number, attemptId?: string) {
    boundedText(taskId, 'task_id', 128)
    if (attemptId !== undefined && !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(attemptId)) throw new TeamRepositoryError('invalid_request', 'invalid attempt identity')
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await requireTeamAccess(client, actor, true)
      const identity = (await client.query('SELECT team_id FROM team_tasks WHERE task_id=$1', [taskId])).rows[0]
      if (!identity) throw new TeamRepositoryError('team_not_found', 'task not found')
      const team = (await client.query("SELECT 1 FROM collaboration_teams WHERE team_id=$1 AND state='active' FOR SHARE", [identity.team_id])).rows[0]
      const member = (await client.query("SELECT 1 FROM collaboration_team_memberships WHERE team_id=$1 AND user_id=$2 AND state='active' FOR SHARE", [identity.team_id, actor])).rows[0]
      if (!team || !member) throw new TeamRepositoryError('team_not_found', 'task not found')
      const task = (await client.query("SELECT task_id,title,state FROM team_tasks WHERE task_id=$1 AND state<>'deleted' FOR SHARE", [taskId])).rows[0]
      if (!task) throw new TeamRepositoryError('team_not_found', 'task not found')
      const runtime = (await client.query('SELECT plan_revision,revision,state,invocation_limit FROM team_task_plan_runtime WHERE task_id=$1', [taskId])).rows[0]
      const attempt = attemptId ? (await client.query(`SELECT a.*,c.state AS call_state,c.context_version,c.context_snapshot_hash,h.spec_revision,h.latest_submission_id,h.revision AS delivery_revision
        FROM team_task_step_attempts a JOIN collaboration_calls c ON c.call_id=a.call_id
        JOIN team_step_delivery_heads h ON h.attempt_id=a.attempt_id WHERE a.task_id=$1 AND a.attempt_id=$2`, [taskId, attemptId])).rows[0] : undefined
      if (attemptId && !attempt) throw new TeamRepositoryError('team_not_found', 'step attempt not found')
      const head = attempt ?? (await client.query('SELECT spec_revision,latest_submission_id,revision AS delivery_revision FROM team_task_delivery_heads WHERE task_id=$1', [taskId])).rows[0]
      if (!head) throw new TeamRepositoryError('capability_not_supported', 'task has no delivery contract')
      const spec = (await client.query(`SELECT revision,goal,acceptance,primary_offer_id,reviewer_user_id,required_checks
        FROM team_task_specs WHERE task_id=$1 AND revision=$2`, [taskId, head.spec_revision])).rows[0]
      const decisions = (await client.query(`SELECT d.decision_id,d.submission_id,d.decision,d.reason,d.verified_checks,d.reviewer_user_id,s.version,s.spec_revision,s.source_call_id,a.attempt_id
        FROM team_acceptance_decisions d JOIN team_task_submissions s USING(submission_id)
        LEFT JOIN team_task_step_attempts a ON a.call_id=s.source_call_id AND a.task_id=s.task_id
        WHERE d.task_id=$1 AND ($2::text IS NULL OR (a.step_id=$2 AND a.attempt_no<=$3)) ORDER BY s.version DESC LIMIT 10`, [taskId, attempt?.step_id ?? null, attempt?.attempt_no ?? null])).rows
      const counts = (await client.query('SELECT count(*)::int n FROM team_task_step_attempts WHERE task_id=$1', [taskId])).rows[0].n as number
      const steps = runtime ? (await client.query(`SELECT s.step_id,s.definition->>'title' AS title,s.definition->'depends_on' AS depends_on,
          a.attempt_id,a.attempt_no,a.state,c.state AS call_state
        FROM team_task_plan_steps s LEFT JOIN LATERAL (
          SELECT attempt_id,attempt_no,state,call_id FROM team_task_step_attempts WHERE task_id=s.task_id AND step_id=s.step_id ORDER BY attempt_no DESC LIMIT 1
        ) a ON true LEFT JOIN collaboration_calls c ON c.call_id=a.call_id
        WHERE s.task_id=$1 AND s.plan_revision=$2 ORDER BY s.position`, [taskId, runtime.plan_revision])).rows : []
      const superseded = !!attempt && steps.some(s => s.step_id === attempt.step_id && s.attempt_id !== attempt.attempt_id)
      const inputs = []
      for (const input of attempt?.frozen_inputs ?? []) {
        const revoked = (await client.query('SELECT artifact_id FROM team_artifact_revocations WHERE submission_id=$1', [input.submission_id])).rows.map(r => r.artifact_id)
        inputs.push({ step_id: input.step_id, attempt_id: input.attempt_id, submission_id: input.submission_id,
          submission_version: input.submission_version, spec_revision: input.spec_revision, decision_id: input.decision_id,
          artifacts: input.artifacts.map((a: { id: string; name: string; sha256: string; byte_size: number }) =>
            ({ id: a.id, name: a.name, sha256: a.sha256, byte_size: a.byte_size, revoked: revoked.includes(a.id) })) })
      }
      const trustedEvidence = (await client.query(`SELECT ${TRUSTED_EVIDENCE_COLUMNS} FROM team_trusted_evidence
        WHERE task_id=$1 AND ($2::text IS NULL OR submission_id IN (SELECT submission_id FROM team_task_submissions WHERE source_call_id=$2))
        ORDER BY received_at,evidence_id`, [taskId, attempt?.call_id ?? null])).rows
      const diagnostics: { code: string; action: string }[] = []
      if (attempt?.call_state === 'uncertain') diagnostics.push({ code: 'original_call_unknown', action: 'reconcile_original_call' })
      if (superseded) diagnostics.push({ code: 'attempt_superseded', action: 'inspect_latest_attempt' })
      if (!superseded && ['failed','blocked','cancelled'].includes(attempt?.call_state)) diagnostics.push({ code: 'execution_terminal', action: 'review_then_explicit_retry' })
      if (attempt?.state === 'awaiting_review') diagnostics.push({ code: 'review_required', action: 'inspect_current_delivery' })
      if (!superseded && decisions[0]?.submission_id === head.latest_submission_id && decisions[0].decision === 'changes_requested') diagnostics.push({ code: 'changes_requested', action: 'review_then_explicit_retry' })
      if (steps.some(s => !s.attempt_id && s.depends_on.some((id: string) => steps.find(d => d.step_id === id)?.state !== 'accepted'))) diagnostics.push({ code: 'dependency_waiting', action: 'inspect_upstream_acceptance' })
      if (inputs.some(i => i.artifacts.some((a: { revoked: boolean }) => a.revoked))) diagnostics.push({ code: 'input_revoked', action: 'review_source_revocation' })
      if (runtime && runtime.state !== 'active') diagnostics.push({ code: `plan_${runtime.state}`, action: 'inspect_plan_control' })
      if (runtime && counts >= Number(runtime.invocation_limit)) diagnostics.push({ code: 'budget_exhausted', action: 'inspect_budget' })
      const result = { schema_version: 1, read_only: true, new_call_created: false, scope: attempt ? 'attempt' : 'task', task,
        spec: { ...spec, revision: Number(spec.revision) }, delivery_revision: Number(head.delivery_revision),
        runtime: runtime ? { ...runtime, plan_revision: Number(runtime.plan_revision), revision: Number(runtime.revision), invocation_limit: Number(runtime.invocation_limit) } : null,
        attempt: attempt ? { attempt_id: attempt.attempt_id, step_id: attempt.step_id, plan_revision: Number(attempt.plan_revision),
          attempt_no: attempt.attempt_no, state: attempt.state, call_id: attempt.call_id, call_state: attempt.call_state, context_version: Number(attempt.context_version), context_hash: attempt.context_snapshot_hash, input_hash: attempt.input_hash } : null,
        invocation_count: counts, steps, inputs, decisions, trusted_evidence: trustedEvidence, diagnostics }
      await client.query('COMMIT')
      return result
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
    finally { client.release() }
  }
}

/** Caller must already hold the Task lock and authorize this exact daemon Call.
 * Only immutable source material enters the local snapshot; live diagnostics
 * remain in the human read endpoint so download/replay cannot drift. */
export async function readNativeTaskContext(client: pg.PoolClient, taskId: string, callId: string, attemptId: string) {
  const row = (await client.query(`SELECT a.plan_revision,a.step_id,a.input_hash,cs.spec_revision,e.content,c.context_version,c.context_snapshot_hash,
      s.reviewer_user_id,s.primary_offer_id,s.required_checks
    FROM team_task_step_attempts a JOIN collaboration_calls c ON c.call_id=a.call_id
    JOIN collaboration_events e ON e.event_id=c.event_id
    JOIN team_call_delivery_specs cs ON cs.call_id=c.call_id AND cs.task_id=a.task_id
    JOIN team_task_specs s ON s.task_id=cs.task_id AND s.revision=cs.spec_revision
    WHERE a.task_id=$1 AND a.call_id=$2 AND a.attempt_id=$3`, [taskId, callId, attemptId])).rows[0]
  if (!row) throw new TeamRepositoryError('team_not_found', 'task context unavailable')
  return { schema_version: 1, read_only: true, task_id: taskId, call_id: callId, attempt_id: attemptId,
    spec_revision: Number(row.spec_revision), plan_revision: Number(row.plan_revision), step_id: row.step_id,
    instruction: row.content, context_version: Number(row.context_version), context_hash: row.context_snapshot_hash, input_hash: row.input_hash, inputs_ref: 'inputs',
    review_policy: { reviewer_user_id: Number(row.reviewer_user_id), primary_offer_id: row.primary_offer_id, required_checks: row.required_checks } }
}
