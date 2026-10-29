import { TRUSTED_EVIDENCE_COLUMNS } from './evidence-service.js'
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { requireTeamAccess } from './access.js'
import { TeamRepositoryError } from './repository.js'
import { requireDeliverySource } from './delivery-source.js'
import { TeamMemorySourceProjector, type TeamMemorySourceProjectorLike } from './memory-source-projector.js'
import { artifactDigest, boundedText, DELIVERY_LIMITS, stableDigest, validateAcceptance, validateMutation, validateReviewPolicy, validateSubmission,
  type AcceptanceInput, type ArtifactManifest, type DeliveryMutation, type PrepareSubmission, type SubmissionEvidence, type TaskReviewPolicy } from './delivery-contract.js'

type DB = Pick<pg.PoolClient, 'query'>
type TaskRow = { revision: string; requirements_revision: string; task_id: string; team_id: string; creator_user_id: number; state: string; team_creator_user_id: number; role: string }
type Head = { revision: string; spec_revision: string; latest_submission_id: string | null }
export interface DeliveryOptions {
  writesEnabledForTeam(teamId: string): boolean
  stepWritesEnabledForTeam?(teamId: string): boolean
  attemptId?: string
  memorySources?: TeamMemorySourceProjectorLike
}

/** Called by assignTask in its existing transaction, before any dispatch. */
export async function createInitialTaskSpec(db: DB, taskId: string, actorUserId: number, goal: string, acceptance: string, policy: TaskReviewPolicy): Promise<void> {
  validateReviewPolicy(policy)
  await requireTeamAccess(db, policy.reviewer_user_id, true)
  const member = (await db.query(`SELECT m.role FROM collaboration_team_memberships m JOIN team_tasks t ON t.team_id=m.team_id
    WHERE t.task_id=$1 AND m.user_id=$2 AND m.state='active' FOR SHARE OF m`, [taskId, policy.reviewer_user_id])).rows[0]
  if (!member || member.role === 'viewer') throw new TeamRepositoryError('reviewer_required', 'reviewer must be an active writable Team member')
  await db.query(`INSERT INTO team_task_specs(task_id,revision,goal,acceptance,reviewer_user_id,required_checks,created_by_user_id,primary_offer_id)
    VALUES($1,1,$2,$3,$4,$5::jsonb,$6,$7)`, [taskId, goal, acceptance, policy.reviewer_user_id, JSON.stringify(policy.required_checks), actorUserId, policy.primary_offer_id])
  await db.query(`INSERT INTO team_task_delivery_heads(task_id,spec_revision) VALUES($1,1)`, [taskId])
}
export async function requireTaskDeliveryComplete(db: DB, taskId: string): Promise<void> {
  const row = (await db.query<{ allowed: boolean }>('SELECT team_task_delivery_complete($1) AS allowed', [taskId])).rows[0]
  if (!row?.allowed) throw new TeamRepositoryError('acceptance_required', 'current delivery must be accepted before completing this task')
}

/** Small, bounded file snapshots use the same PostgreSQL BYTEA storage model as
 * session documents. Private session URLs are never republished implicitly. */
export class TeamDeliveryService {
  private readonly cleanupMemorySources = new TeamMemorySourceProjector(false)
  constructor(private readonly pool: pg.Pool, private readonly options: DeliveryOptions = { writesEnabledForTeam: () => false }) {}

  forAttempt(attemptId: string): TeamDeliveryService {
    if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(attemptId)) throw new TeamRepositoryError('invalid_request', 'invalid attempt identity')
    return new TeamDeliveryService(this.pool, { ...this.options, attemptId: attemptId.toLowerCase() })
  }

  private async transaction<T>(run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try { await client.query('BEGIN'); const result = await run(client); await client.query('COMMIT'); return result }
    catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
    finally { client.release() }
  }
  private async task(client: pg.PoolClient, taskId: string, actor: number, write = false): Promise<TaskRow> {
    await requireTeamAccess(client, actor, true)
    const identity = (await client.query<{ team_id: string }>('SELECT team_id FROM team_tasks WHERE task_id=$1', [taskId])).rows[0]
    if (!identity) throw new TeamRepositoryError('team_not_found', 'task not found')
    const team = (await client.query(`SELECT creator_user_id FROM collaboration_teams WHERE team_id=$1 AND state='active' FOR SHARE`, [identity.team_id])).rows[0]
    const member = (await client.query(`SELECT role FROM collaboration_team_memberships WHERE team_id=$1 AND user_id=$2 AND state='active' FOR SHARE`, [identity.team_id, actor])).rows[0]
    if (!team || !member) throw new TeamRepositoryError('team_not_found', 'task not found')
    if (write && member.role === 'viewer') throw new TeamRepositoryError('team_access_denied', 'read-only Team member')
    if (write && !this.options.writesEnabledForTeam(identity.team_id)) throw new TeamRepositoryError('team_feature_disabled', 'task delivery writes disabled for this Team')
    if (write && this.options.attemptId && !this.options.stepWritesEnabledForTeam?.(identity.team_id)) throw new TeamRepositoryError('team_feature_disabled', 'step delivery writes disabled for this Team')
    const task = (await client.query(`SELECT * FROM team_tasks WHERE task_id=$1 FOR ${write ? 'UPDATE' : 'SHARE'}`, [taskId])).rows[0]
    if (!task || task.state === 'deleted') throw new TeamRepositoryError('team_not_found', 'task not found')
    if (this.options.attemptId && !(await client.query('SELECT 1 FROM team_task_step_attempts WHERE attempt_id=$1 AND task_id=$2', [this.options.attemptId, taskId])).rows[0]) throw new TeamRepositoryError('team_not_found', 'step attempt not found')
    return { ...task, role: member.role, team_creator_user_id: Number(team.creator_user_id) }
  }
  private editable(task: TaskRow): void {
    if (!['open', 'in_progress'].includes(task.state)) throw new TeamRepositoryError('invalid_state', 'restore or reopen task before editing delivery')
  }
  private async requireActiveAttempt(client: DB, taskId: string, operation: string): Promise<void> {
    if (!this.options.attemptId) {
      if ((await client.query('SELECT 1 FROM team_task_plan_runtime WHERE task_id=$1', [taskId])).rows[0]) throw new TeamRepositoryError('invalid_state', 'activated plans require step-scoped delivery')
      return
    }
    // Called under the Task write lock, after receipt replay. Terminal attempts
    // retain history and revocation authority, but cannot resume via delivery.
    const attempt = (await client.query('SELECT state,step_id,attempt_no FROM team_task_step_attempts WHERE task_id=$1 AND attempt_id=$2 FOR UPDATE', [taskId, this.options.attemptId])).rows[0]
    const allowed = operation === 'acceptance' ? ['awaiting_review'] : ['reserved', 'dispatched', 'running', 'awaiting_review']
    if (!attempt || !allowed.includes(attempt.state)) throw new TeamRepositoryError('invalid_state', 'step attempt cannot accept new delivery writes in its current state')
    if ((await client.query('SELECT 1 FROM team_task_step_attempts WHERE task_id=$1 AND step_id=$2 AND attempt_no>$3 LIMIT 1', [taskId, attempt.step_id, attempt.attempt_no])).rows[0]) {
      throw new TeamRepositoryError('invalid_state', 'superseded step attempt retains history only')
    }
  }
  private async head(client: DB, taskId: string): Promise<Head> {
    const row = this.options.attemptId
      ? (await client.query<Head>('SELECT * FROM team_step_delivery_heads WHERE task_id=$1 AND attempt_id=$2', [taskId, this.options.attemptId])).rows[0]
      : (await client.query<Head>('SELECT * FROM team_task_delivery_heads WHERE task_id=$1', [taskId])).rows[0]
    if (!row) throw new TeamRepositoryError('capability_not_supported', 'task has no delivery contract')
    return row
  }
  private async advanceHead(client: DB, taskId: string, submissionId?: string, primary = false): Promise<void> {
    if (this.options.attemptId) await client.query(`UPDATE team_step_delivery_heads SET revision=revision+1,
      latest_submission_id=CASE WHEN $3 THEN $2::uuid ELSE latest_submission_id END WHERE task_id=$1 AND attempt_id=$4`, [taskId, submissionId ?? null, primary, this.options.attemptId])
    else await client.query(`UPDATE team_task_delivery_heads SET revision=revision+1,
      latest_submission_id=CASE WHEN $3 THEN $2::uuid ELSE latest_submission_id END WHERE task_id=$1`, [taskId, submissionId ?? null, primary])
  }
  private async requireCallScope(client: DB, taskId: string, callId: string): Promise<void> {
    const attempt = (await client.query('SELECT attempt_id FROM team_task_step_attempts WHERE task_id=$1 AND call_id=$2', [taskId, callId])).rows[0]
    if ((attempt?.attempt_id ?? null) !== (this.options.attemptId ?? null)) throw new TeamRepositoryError('invalid_request', 'delivery Call belongs to a different execution scope')
  }
  private expect(head: Head, revision: number): void {
    if (Number(head.revision) !== revision) throw new TeamRepositoryError('revision_conflict', 'delivery revision changed', Number(head.revision))
  }
  private async event(client: DB, taskId: string, kind: string, payload: unknown): Promise<void> {
    if (this.options.attemptId) payload = { ...(payload as Record<string, unknown>), attempt_id: this.options.attemptId }
    await client.query(`INSERT INTO team_delivery_outbox(event_id,task_id,kind,payload) VALUES($1,$2,$3,$4::jsonb)`, [randomUUID(), taskId, kind, JSON.stringify(payload)])
  }
  private async mutate<T>(taskId: string, actor: number, operation: string, input: DeliveryMutation, run: (client: pg.PoolClient, task: TaskRow, head: Head) => Promise<T>, allowTerminal = false): Promise<T> {
    validateMutation(input)
    const fingerprint = stableDigest({ operation, input, ...(this.options.attemptId ? { attempt_id: this.options.attemptId } : {}) })
    return this.transaction(async client => {
      const task = await this.task(client, taskId, actor, true)
      // Task lock serializes all delivery mutations, including receipt races.
      const prior = (await client.query(`SELECT request_hash,response FROM team_delivery_receipts WHERE task_id=$1 AND actor_user_id=$2 AND request_id=$3`, [taskId, actor, input.request_id])).rows[0]
      if (prior) {
        if (prior.request_hash !== fingerprint) throw new TeamRepositoryError('idempotency_conflict', 'request ID reused with different content')
        return (this.options.attemptId ? { ...prior.response, attempt_id: this.options.attemptId } : prior.response) as T
      }
      if (!allowTerminal) {
        this.editable(task)
        await this.requireActiveAttempt(client, taskId, operation)
      }
      const head = await this.head(client, taskId)
      this.expect(head, input.expected_revision)
      const result = await run(client, task, head)
      const response = this.options.attemptId ? { ...result, attempt_id: this.options.attemptId } : result
      await client.query(`INSERT INTO team_delivery_receipts(task_id,actor_user_id,request_id,request_hash,operation,response,attempt_id) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`,
        [taskId, actor, input.request_id, fingerprint, operation, JSON.stringify(response), this.options.attemptId ?? null])
      return response
    })
  }
  async getDelivery(taskId: string, actor: number) {
    return this.transaction(async client => {
      const task = await this.task(client, taskId, actor)
      const head = await this.head(client, taskId)
      const spec = (await client.query(`SELECT * FROM team_task_specs WHERE task_id=$1 AND revision=$2`, [taskId, head.spec_revision])).rows[0]
      const submissions = (await client.query(`SELECT s.*,d.decision_id,d.decision,d.reason AS decision_reason,d.reviewer_user_id,d.verified_checks,
        CASE WHEN d.decision='accepted' THEN COALESCE((
          SELECT CASE WHEN m.withdrawn_at IS NOT NULL THEN 'withdrawn'
            WHEN m.revoked_at IS NOT NULL THEN 'access_revoked' ELSE 'captured' END
          FROM team_delivery_memory_sources m WHERE m.decision_id=d.decision_id AND m.reader_user_id=$2
        ),'not_captured') ELSE NULL END AS personal_memory_capture,
        COALESCE((SELECT jsonb_agg(r.artifact_id) FROM team_artifact_revocations r WHERE r.submission_id=s.submission_id),'[]') AS revoked_artifact_ids
        FROM team_task_submissions s LEFT JOIN team_acceptance_decisions d USING(submission_id)
        WHERE s.task_id=$1 AND (s.state='published' OR s.submitted_by_user_id=$2)
          AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM team_task_step_attempts a WHERE a.attempt_id=$3 AND a.task_id=s.task_id AND a.call_id=s.source_call_id))
          AND ($3::uuid IS NOT NULL OR NOT EXISTS(SELECT 1 FROM team_task_step_attempts a WHERE a.task_id=s.task_id AND a.call_id=s.source_call_id))
        ORDER BY s.created_at,s.submission_id`, [taskId, actor, this.options.attemptId ?? null])).rows
      const specs = (await client.query('SELECT * FROM team_task_specs WHERE task_id=$1 AND (revision=$2 OR revision=ANY($3::bigint[])) ORDER BY revision', [taskId, head.spec_revision, submissions.map(s => s.spec_revision)])).rows
      const trustedEvidence = (await client.query(`SELECT ${TRUSTED_EVIDENCE_COLUMNS} FROM team_trusted_evidence
        WHERE task_id=$1 AND submission_id=ANY($2::uuid[]) ORDER BY received_at,evidence_id`, [taskId, submissions.map(s => s.submission_id)])).rows
      const legacyLocked = !this.options.attemptId && !!(await client.query('SELECT 1 FROM team_task_plan_runtime WHERE task_id=$1', [taskId])).rows[0]
      const superseded = this.options.attemptId && !!(await client.query(`SELECT 1 FROM team_task_step_attempts newer
        JOIN team_task_step_attempts current ON current.task_id=newer.task_id AND current.step_id=newer.step_id
        WHERE current.attempt_id=$1 AND newer.attempt_no>current.attempt_no LIMIT 1`, [this.options.attemptId])).rows[0]
      return { team_id: task.team_id, task_id: taskId, task_state: task.state, specs, revision: Number(head.revision), spec: { ...spec, revision: Number(spec.revision) },
        latest_submission_id: head.latest_submission_id, submissions, trusted_evidence: trustedEvidence, ...(this.options.attemptId ? { attempt_id: this.options.attemptId } : {}),
        writes_enabled: !superseded && !legacyLocked && this.options.writesEnabledForTeam(task.team_id) && task.role !== 'viewer' && (!this.options.attemptId || !!this.options.stepWritesEnabledForTeam?.(task.team_id)) }
    })
  }
  async sessionCards(sessionId: string, actor: number, after = '') {
    if (after.length > 128) throw new TeamRepositoryError('invalid_request', 'invalid cursor')
    return this.transaction(async client => {
      await requireTeamAccess(client, actor, true)
      const session = (await client.query(`SELECT s.team_id FROM collaboration_sessions s
        JOIN collaboration_teams t ON t.team_id=s.team_id AND t.state='active'
        JOIN collaboration_team_memberships m ON m.team_id=s.team_id AND m.user_id=$2 AND m.state='active'
        JOIN collaboration_session_participants p ON p.team_session_id=s.team_session_id AND p.user_id=$2 AND p.state='active'
        WHERE s.team_session_id=$1 FOR SHARE OF s,t,m,p`, [sessionId,actor])).rows[0]
      if (!session) throw new TeamRepositoryError('team_not_found', 'shared session not found')
      // One stable card per task, independent of locally retained chat events.
      // All content is Team-scoped; private native session IDs never leave this query.
      const rows = (await client.query(`SELECT t.task_id,t.title,t.state AS task_state,h.revision,h.spec_revision,
        p.reviewer_user_id,h.latest_submission_id,s.spec_revision AS submission_spec_revision,s.version,s.summary,s.manifest,
        s.source_call_id,s.published_at,d.decision,d.reason AS decision_reason,
        COALESCE((SELECT jsonb_agg(r.artifact_id) FROM team_artifact_revocations r WHERE r.submission_id=s.submission_id),'[]') AS revoked_artifact_ids,
        (SELECT c.event_id FROM collaboration_calls c WHERE c.task_id=t.task_id AND c.team_session_id=$1 ORDER BY c.created_at,c.call_id LIMIT 1) AS event_id,
        EXISTS(SELECT 1 FROM collaboration_calls c WHERE c.task_id=t.task_id AND c.state IN ('pending','dispatched','accepted','uncertain')) AS execution_pending
        FROM team_tasks t JOIN team_task_delivery_heads h ON h.task_id=t.task_id
        JOIN team_task_specs p ON p.task_id=t.task_id AND p.revision=h.spec_revision
        LEFT JOIN team_task_submissions s ON s.submission_id=h.latest_submission_id AND s.state='published'
        LEFT JOIN team_acceptance_decisions d ON d.submission_id=s.submission_id
        WHERE t.team_id=$2 AND t.state<>'deleted' AND t.task_id>$3 AND
          (EXISTS(SELECT 1 FROM collaboration_calls c WHERE c.task_id=t.task_id AND c.team_session_id=$1)
           OR EXISTS(SELECT 1 FROM collaboration_sessions ss WHERE ss.team_session_id=$1 AND ss.task_id=t.task_id)
           OR EXISTS(SELECT 1 FROM team_task_template_sources ts WHERE ts.task_id=t.task_id AND ts.team_session_id=$1))
        ORDER BY t.task_id LIMIT 51`, [sessionId,session.team_id,after])).rows
      return { team_id: session.team_id, team_session_id: sessionId,
        items: rows.slice(0,50).map(row => ({ ...row, revision:Number(row.revision), spec_revision:Number(row.spec_revision),
          submission_spec_revision:row.submission_spec_revision===null?null:Number(row.submission_spec_revision), version:row.version===null?null:Number(row.version),
          // Only filenames, never reusable private URLs or filesystem paths.
          files: (row.manifest ?? []).map((f:ArtifactManifest)=>({id:f.id,name:f.name,byte_size:f.byte_size})), manifest:undefined })),
        next_cursor: rows.length>50 ? rows[49].task_id as string : null }
    })
  }
  /** Advisory choices only; each write rechecks authority and revisions in its transaction. */
  async management(taskId: string, actor: number) {
    return this.transaction(async client => {
      const task = await this.task(client, taskId, actor)
      const head = await this.head(client, taskId)
      const canManage = task.role !== 'viewer' && (Number(task.creator_user_id) === actor || task.role === 'admin')
        && this.options.writesEnabledForTeam(task.team_id) && ['open', 'in_progress'].includes(task.state)
        && !(await client.query('SELECT 1 FROM team_task_plan_runtime WHERE task_id=$1 UNION ALL SELECT 1 FROM team_task_template_sources WHERE task_id=$1 LIMIT 1', [taskId])).rows[0]
      // Display metadata never grants eligibility for legacy single-call writes.
      const displayOffers = (await client.query("SELECT offer_id,provider,owner_user_id FROM team_agent_offers WHERE team_id=$1 AND state='active' ORDER BY offer_id", [task.team_id])).rows
      const base = { task_revision: Number(task.revision), requirements_revision: Number(task.requirements_revision ?? 0), can_manage: canManage, revision: Number(head.revision), spec_revision: Number(head.spec_revision), display_offers: displayOffers }
      if (!canManage) return { ...base, reviewers: [], offers: [], sessions: [], execution_block: 'read_only' }
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
        WHERE s.team_id=$1 AND s.state='active' AND p.user_id=$2 AND p.state='active'
        ORDER BY s.created_at DESC,s.team_session_id`, [task.team_id, actor])).rows
        .map(row => ({ ...row, current_context_version: Number(row.current_context_version) }))
      const outstanding = (await client.query("SELECT 1 FROM collaboration_calls WHERE task_id=$1 AND state IN ('pending','dispatched','accepted','uncertain') LIMIT 1", [taskId])).rows.length > 0
      const accepted = (await client.query("SELECT 1 FROM team_acceptance_decisions WHERE submission_id=$1 AND spec_revision=$2 AND decision='accepted'", [head.latest_submission_id, head.spec_revision])).rows.length > 0
      return { ...base, reviewers, offers, sessions, execution_block: outstanding ? 'outstanding_execution' : accepted ? 'accepted_delivery' : null }
    })
  }
  async capabilities(teamId: string, actor: number) {
    await requireTeamAccess(this.pool, actor)
    const row = (await this.pool.query(`SELECT m.role FROM collaboration_team_memberships m
      JOIN collaboration_teams t ON t.team_id=m.team_id AND t.state='active'
      WHERE m.team_id=$1 AND m.user_id=$2 AND m.state='active'`, [teamId, actor])).rows[0]
    if (!row) throw new TeamRepositoryError('team_not_found', 'team not found')
    return { writes_enabled: row.role !== 'viewer' && this.options.writesEnabledForTeam(teamId) }
  }

  /** Poll only Relay-confirmed completed Calls. This is a read contract, not a
   * second dispatch queue: missing/invalid files cannot cause another execution.
   * The keyset cursor advances across disabled Teams as well as enabled ones,
   * so one old missing manifest cannot starve newer completed Calls. */
  async exportJobs(daemonId: string, actor: number, after = '', includeSteps = false) {
    boundedText(daemonId, 'daemon_id', 128)
    boundedText(after, 'after', 128, true)
    await requireTeamAccess(this.pool, actor, true)
    if (!(await this.pool.query('SELECT 1 FROM daemons WHERE daemon_id=$1 AND user_id=$2', [daemonId, actor])).rows[0]) {
      throw new TeamRepositoryError('team_not_found', 'daemon not found')
    }
    const rows = (await this.pool.query(`WITH heads AS (
        SELECT task_id,spec_revision,revision,latest_submission_id,NULL::uuid AS attempt_id,NULL::text AS call_id FROM team_task_delivery_heads h
          WHERE NOT EXISTS(SELECT 1 FROM team_task_plan_runtime r WHERE r.task_id=h.task_id)
        UNION ALL
        SELECT h.task_id,h.spec_revision,h.revision,h.latest_submission_id,h.attempt_id,a.call_id FROM team_step_delivery_heads h
          JOIN team_task_step_attempts a ON a.attempt_id=h.attempt_id AND a.task_id=h.task_id
          WHERE $4 AND a.state IN ('reserved','dispatched','running','awaiting_review')
      ) SELECT c.call_id,c.task_id,c.team_session_id,c.operation,c.native_session_id,h.attempt_id,
        c.binding_id,c.binding_revision,c.offer_id,c.offer_revision,o.provider,o.team_id,
        f.spec_revision,h.revision,h.latest_submission_id,p.primary_offer_id,COALESCE(x.revision,0) AS export_revision
      FROM collaboration_calls c
      LEFT JOIN team_delivery_export_status x ON x.call_id=c.call_id
      JOIN team_call_delivery_specs f ON f.call_id=c.call_id AND f.task_id=c.task_id
      JOIN heads h ON h.task_id=f.task_id AND h.spec_revision=f.spec_revision
        AND ((h.attempt_id IS NOT NULL AND h.call_id=c.call_id) OR (h.attempt_id IS NULL
          AND NOT EXISTS(SELECT 1 FROM team_task_step_attempts a WHERE a.task_id=c.task_id AND a.call_id=c.call_id)))
      JOIN team_task_specs p ON p.task_id=f.task_id AND p.revision=f.spec_revision
      JOIN team_tasks t ON t.task_id=c.task_id AND t.state IN ('open','in_progress')
      JOIN collaboration_sessions s ON s.team_session_id=c.team_session_id AND s.team_id=t.team_id AND s.state='active'
      JOIN collaboration_teams team ON team.team_id=s.team_id AND team.state='active'
      JOIN team_agent_offers o ON o.offer_id=c.offer_id AND o.team_id=team.team_id
        AND o.owner_user_id=$2 AND o.daemon_id=$1 AND o.state='active' AND o.revision=c.offer_revision
      JOIN collaboration_session_agent_bindings b ON b.binding_id=c.binding_id AND b.team_session_id=c.team_session_id
        AND b.offer_id=c.offer_id AND b.owner_user_id=$2 AND b.state='active' AND b.revision=c.binding_revision
        AND b.native_session_id=c.native_session_id
      JOIN collaboration_team_memberships m ON m.team_id=team.team_id AND m.user_id=$2 AND m.state='active' AND m.role<>'viewer'
      WHERE c.state='completed' AND c.native_session_id IS NOT NULL AND c.operation IN ('create','message')
        AND NOT EXISTS(SELECT 1 FROM deleted_sessions gone WHERE gone.session_id=c.native_session_id)
        AND NOT EXISTS(SELECT 1 FROM sessions private_source WHERE private_source.session_id=c.native_session_id
          AND (private_source.user_id IS DISTINCT FROM $2 OR private_source.daemon_id IS DISTINCT FROM $1
            OR private_source.content_state IN ('deleting','deleted')))
        AND c.call_id>$3 AND NOT EXISTS(SELECT 1 FROM team_task_submissions d WHERE d.source_call_id=c.call_id AND d.state='published')
      ORDER BY c.call_id LIMIT 101`, [daemonId, actor, after, includeSteps])).rows
    const page = rows.slice(0, 100)
    return {
      owner_user_id: actor,
      jobs: page.filter(row => this.options.writesEnabledForTeam(row.team_id) && (!row.attempt_id || this.options.stepWritesEnabledForTeam?.(row.team_id))).map(row => ({
        call_id: row.call_id, task_id: row.task_id, spec_revision: Number(row.spec_revision), revision: Number(row.revision),
        export_revision: Number(row.export_revision),
        ...(row.attempt_id ? { attempt_id: row.attempt_id } : {}),
        native_session_id: row.native_session_id, provider: row.provider,
        latest_submission_id: row.latest_submission_id, delivery_role: row.primary_offer_id === row.offer_id ? 'primary' : 'contribution',
        authorization: {
          protocol_version: 1, operation: row.operation, call_id: row.call_id, team_session_id: row.team_session_id,
          binding_id: row.binding_id, binding_revision: Number(row.binding_revision), offer_id: row.offer_id,
          offer_revision: Number(row.offer_revision), owner_user_id: actor, daemon_id: daemonId,
          delivery: { task_id: row.task_id, spec_revision: Number(row.spec_revision), ...(row.attempt_id ? { attempt_id: row.attempt_id } : {}) },
        },
      })),
      next_cursor: rows.length > 100 ? page[page.length - 1].call_id as string : null,
    }
  }
  async reportExportStatus(taskId: string, actor: number, daemonId: string, callId: string, input: { expected_revision: number; phase: string; error_code: string }) {
    const codes = ['manifest_unavailable','manifest_invalid','artifact_unavailable','source_changed','transport_unavailable','authorization_changed','revision_conflict','quota_exceeded','retry_pending']
    if (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 0 ||
      !['waiting_for_files','publication_pending','blocked'].includes(input.phase) || !codes.includes(input.error_code)) {
      throw new TeamRepositoryError('invalid_request', 'invalid export diagnostic')
    }
    return this.transaction(async client => {
      const task = await this.task(client,taskId,actor,true)
      await this.requireCallScope(client, taskId, callId)
      const source = (await client.query(`SELECT c.call_id,c.state,c.native_session_id,c.binding_revision,c.offer_revision,
          b.revision AS current_binding_revision,b.native_session_id AS current_native_session_id,b.state AS binding_state,
          o.revision AS current_offer_revision,o.state AS offer_state,f.spec_revision
        FROM collaboration_calls c JOIN team_agent_offers o ON o.offer_id=c.offer_id AND o.team_id=$5
        JOIN daemons d ON d.daemon_id=o.daemon_id AND d.user_id=o.owner_user_id
        JOIN collaboration_session_agent_bindings b ON b.binding_id=c.binding_id AND b.offer_id=c.offer_id AND b.owner_user_id=o.owner_user_id
        JOIN team_call_delivery_specs f ON f.call_id=c.call_id AND f.task_id=c.task_id
        WHERE c.call_id=$1 AND c.task_id=$2 AND o.owner_user_id=$3 AND o.daemon_id=$4 FOR SHARE OF c,o,b`,[callId,taskId,actor,daemonId,task.team_id])).rows[0]
      if (!source) throw new TeamRepositoryError('team_not_found','source call not found')
      const prior = (await client.query('SELECT * FROM team_delivery_export_status WHERE call_id=$1',[callId])).rows[0]
      // Publication is Relay authority. A delayed daemon report cannot downgrade it.
      if (prior?.phase === 'published') return { revision:Number(prior.revision),phase:'published' }
      if ((await client.query("SELECT 1 FROM team_task_submissions WHERE source_call_id=$1 AND state='published' LIMIT 1",[callId])).rows[0]) {
        const revision=Number(prior?.revision ?? 0)+1
        await client.query(`INSERT INTO team_delivery_export_status(call_id,revision,phase) VALUES($1,$2,'published') ON CONFLICT(call_id)
          DO UPDATE SET phase='published',error_code=NULL,revision=EXCLUDED.revision,updated_at=NOW()`,[callId,revision])
        return {revision,phase:'published'}
      }
      this.editable(task)
      await this.requireActiveAttempt(client, taskId, 'export_status')
      const head = await this.head(client,taskId)
      if (source.state !== 'completed' || !source.native_session_id || source.native_session_id !== source.current_native_session_id ||
          source.binding_state !== 'active' || source.offer_state !== 'active' || Number(source.binding_revision) !== Number(source.current_binding_revision) ||
          Number(source.offer_revision) !== Number(source.current_offer_revision) || Number(source.spec_revision) !== Number(head.spec_revision)) {
        throw new TeamRepositoryError('invalid_state','source no longer eligible for export')
      }
      if (Number(prior?.revision ?? 0) !== input.expected_revision) throw new TeamRepositoryError('revision_conflict','export status changed',Number(prior?.revision ?? 0))
      if (prior?.phase === input.phase && prior?.error_code === input.error_code) return {revision:Number(prior.revision),phase:prior.phase}
      const next = input.expected_revision+1
      await client.query(`INSERT INTO team_delivery_export_status(call_id,revision,phase,error_code,reporter_user_id,reporter_daemon_id)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(call_id) DO UPDATE SET revision=EXCLUDED.revision,phase=EXCLUDED.phase,
        error_code=EXCLUDED.error_code,reporter_user_id=EXCLUDED.reporter_user_id,reporter_daemon_id=EXCLUDED.reporter_daemon_id,updated_at=NOW()`,
        [callId,next,input.phase,input.error_code,actor,daemonId])
      return {revision:next,phase:input.phase}
    })
  }
  async reviseSpec(taskId: string, actor: number, input: DeliveryMutation & { goal: string; acceptance: string; policy: TaskReviewPolicy }) {
    if (this.options.attemptId) throw new TeamRepositoryError('invalid_state', 'step attempt specification is frozen; retry with a new attempt')
    boundedText(input.goal, 'goal', 32000); boundedText(input.acceptance, 'acceptance', 16000); validateReviewPolicy(input.policy)
    return this.mutate(taskId, actor, 'revise_spec', input, async (client, task, head) => {
      if (actor !== Number(task.creator_user_id) && task.role !== 'admin') throw new TeamRepositoryError('creator_required', 'task creator or Team admin required')
      await requireTeamAccess(client, input.policy.reviewer_user_id, true)
      const member = (await client.query(`SELECT role FROM collaboration_team_memberships WHERE team_id=$1 AND user_id=$2 AND state='active' FOR SHARE`, [task.team_id, input.policy.reviewer_user_id])).rows[0]
      if (!member || member.role === 'viewer') throw new TeamRepositoryError('reviewer_required', 'reviewer must be an active writable member')
      const primary = (await client.query("SELECT 1 FROM team_agent_offers WHERE offer_id=$1 AND team_id=$2 AND state='active'", [input.policy.primary_offer_id,task.team_id])).rows[0]
      if (!primary) throw new TeamRepositoryError('team_not_found', 'primary Agent not found')
      const revision = Number((await client.query('SELECT COALESCE(MAX(revision),0)+1 AS revision FROM team_task_specs WHERE task_id=$1', [taskId])).rows[0].revision)
      await client.query(`INSERT INTO team_task_specs(task_id,revision,goal,acceptance,reviewer_user_id,required_checks,created_by_user_id,primary_offer_id) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
        [taskId, revision, input.goal, input.acceptance, input.policy.reviewer_user_id, JSON.stringify(input.policy.required_checks), actor, input.policy.primary_offer_id])
      await client.query('UPDATE team_task_delivery_heads SET spec_revision=$2,revision=revision+1 WHERE task_id=$1', [taskId, revision])
      await this.event(client, taskId, 'spec_revised', { spec_revision: revision, actor_user_id: actor })
      return { spec_revision: revision, revision: Number(head.revision) + 1 }
    })
  }
  async prepare(taskId: string, actor: number, input: PrepareSubmission) {
    validateSubmission(input)
    return this.mutate(taskId, actor, 'prepare_submission', input, async (client, task, head) => {
      await this.requireCallScope(client, taskId, input.source_call_id)
      if (this.options.attemptId && input.contribution_ids.length) throw new TeamRepositoryError('invalid_request', 'step inputs belong in the frozen dependency manifest')
      if (input.spec_revision !== Number(head.spec_revision)) throw new TeamRepositoryError('revision_conflict', 'task specification changed', Number(head.revision))
      const source = await requireDeliverySource(client, taskId, task.team_id, actor, input.source_call_id, input.spec_revision)
      const count = (await client.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM team_task_submissions WHERE task_id=$1', [taskId])).rows[0].n
      if (count >= DELIVERY_LIMITS.submissions) throw new TeamRepositoryError('budget_exhausted', 'task submission limit reached')
      const spec = (await client.query('SELECT primary_offer_id FROM team_task_specs WHERE task_id=$1 AND revision=$2', [taskId, head.spec_revision])).rows[0]
      const deliveryRole = source.offer_id === spec.primary_offer_id ? 'primary' : 'contribution'
      for (const id of input.contribution_ids) {
        if (!(await client.query("SELECT 1 FROM team_task_submissions WHERE submission_id=$1 AND task_id=$2 AND spec_revision=$3 AND state='published' AND delivery_role='contribution'", [id,taskId,head.spec_revision])).rows[0]) throw new TeamRepositoryError('invalid_request', 'contribution must be a published version of this task and specification')
      }
      const submissionId = randomUUID()
      const manifest = input.artifacts.map(a => ({ id: a.id, name: a.name, mime_type: a.mime_type, byte_size: a.byte_size, sha256: a.sha256, required: a.required }))
      await client.query(`INSERT INTO team_task_submissions(submission_id,task_id,spec_revision,source_call_id,source_run_id,source_offer_id,native_session_id,context_version,context_hash,
        submitted_by_user_id,summary,code_revision,manifest,evidence,manifest_sha256,delivery_role,contribution_ids)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15,$16,$17::jsonb)`,
        [submissionId, taskId, input.spec_revision, source.call_id, source.run_id, source.offer_id, source.native_session_id, source.context_version, source.context_snapshot_hash,
          actor, input.summary, input.code_revision, JSON.stringify(manifest), JSON.stringify(input.evidence), stableDigest(manifest), deliveryRole, JSON.stringify(input.contribution_ids)])
      await client.query('INSERT INTO team_delivery_staging_activity(submission_id) VALUES($1)', [submissionId])
      return { submission_id: submissionId, state: 'preparing', revision: Number(head.revision) }
    })
  }
  private async submission(client: DB, taskId: string, submissionId: string) {
    const row = (await client.query(`SELECT * FROM team_task_submissions WHERE task_id=$1 AND submission_id=$2`, [taskId, submissionId])).rows[0]
    if (!row) throw new TeamRepositoryError('team_not_found', 'submission not found')
    await this.requireCallScope(client, taskId, row.source_call_id)
    return row as { submission_id: string; state: string; spec_revision: string; submitted_by_user_id: number; manifest: ArtifactManifest[]; evidence: SubmissionEvidence[]; [key: string]: any }
  }
  async uploadArtifact(taskId: string, actor: number, submissionId: string, artifactId: string, bytes: Buffer) {
    if (!bytes.length || bytes.length > DELIVERY_LIMITS.artifactBytes) throw new TeamRepositoryError('invalid_request', 'artifact byte limit exceeded')
    return this.transaction(async client => {
      const task = await this.task(client, taskId, actor, true); this.editable(task)
      await this.requireActiveAttempt(client, taskId, 'upload')
      const submission = await this.submission(client, taskId, submissionId)
      if (Number(submission.submitted_by_user_id) !== actor) throw new TeamRepositoryError('offer_owner_required', 'submission owner required')
      const artifact = submission.manifest.find(a => a.id === artifactId)
      if (!artifact || bytes.length !== artifact.byte_size || artifactDigest(bytes) !== artifact.sha256) throw new TeamRepositoryError('artifact_integrity', 'artifact does not match immutable manifest')
      const existing = (await client.query(`SELECT a.sha256,r.artifact_id AS revoked FROM team_submission_artifacts a
        LEFT JOIN team_artifact_revocations r USING(submission_id,artifact_id) WHERE a.submission_id=$1 AND a.artifact_id=$2`, [submissionId, artifactId])).rows[0]
      if (existing?.revoked) throw new TeamRepositoryError('artifact_unavailable', 'revoked artifact cannot be restored by upload')
      if (submission.state === 'preparing') {
        await requireDeliverySource(client, taskId, task.team_id, actor, submission.source_call_id, Number(submission.spec_revision))
        await client.query(`INSERT INTO team_delivery_staging_activity(submission_id) VALUES($1)
          ON CONFLICT(submission_id) DO UPDATE SET last_activity_at=NOW()`, [submissionId])
      }
      if (existing) return { artifact_id: artifactId, sha256: artifact.sha256, state: 'ready' }
      if (submission.state !== 'preparing') throw new TeamRepositoryError('invalid_state', 'published submission is immutable')
      const used = Number((await client.query(`SELECT COALESCE(SUM(a.byte_size),0) AS bytes FROM team_submission_artifacts a JOIN team_task_submissions s USING(submission_id) WHERE s.task_id=$1`, [taskId])).rows[0].bytes)
      if (used + bytes.length > DELIVERY_LIMITS.taskBytes) throw new TeamRepositoryError('budget_exhausted', 'task artifact quota reached')
      await client.query(`INSERT INTO team_submission_artifacts(submission_id,artifact_id,sha256,byte_size,content_bytes) VALUES($1,$2,$3,$4,$5)`, [submissionId, artifactId, artifact.sha256, bytes.length, bytes])
      return { artifact_id: artifactId, sha256: artifact.sha256, state: 'ready' }
    })
  }
  private async available(client: DB, submission: Awaited<ReturnType<TeamDeliveryService['submission']>>, ids: Set<string>): Promise<void> {
    const artifacts = (await client.query(`SELECT a.artifact_id,a.content_bytes,a.sha256,a.byte_size,r.artifact_id AS revoked FROM team_submission_artifacts a
      LEFT JOIN team_artifact_revocations r USING(submission_id,artifact_id) WHERE a.submission_id=$1 AND a.artifact_id=ANY($2::text[])`, [submission.submission_id, [...ids]])).rows
    for (const id of ids) {
      const row = artifacts.find(a => a.artifact_id === id), manifest = submission.manifest.find(a => a.id === id)
      if (!row || row.revoked || !manifest || Number(row.byte_size) !== manifest.byte_size || artifactDigest(Buffer.from(row.content_bytes)) !== manifest.sha256) {
        throw new TeamRepositoryError('artifact_unavailable', 'required artifact missing, revoked or corrupt')
      }
    }
  }
  async publish(taskId: string, actor: number, submissionId: string, input: DeliveryMutation) {
    return this.mutate(taskId, actor, `publish:${submissionId}`, input, async (client, task, head) => {
      const submission = await this.submission(client, taskId, submissionId)
      if (Number(submission.submitted_by_user_id) !== actor) throw new TeamRepositoryError('offer_owner_required', 'submission owner required')
      if (submission.state !== 'preparing' || Number(submission.spec_revision) !== Number(head.spec_revision)) throw new TeamRepositoryError('revision_conflict', 'submission is published or specification changed', Number(head.revision))
      await requireDeliverySource(client, taskId, task.team_id, actor, submission.source_call_id, Number(submission.spec_revision))
      // A late draft cannot replace a currently accepted main delivery. An
      // explicit spec revision is needed; contributions never win by timing.
      if (submission.delivery_role === 'primary' && head.latest_submission_id) {
        const accepted = (await client.query(`SELECT 1 FROM team_acceptance_decisions WHERE submission_id=$1 AND spec_revision=$2 AND decision='accepted'`, [head.latest_submission_id, head.spec_revision])).rows[0]
        if (accepted) throw new TeamRepositoryError('invalid_state', 'accepted main delivery cannot be replaced implicitly')
      }
      await this.available(client, submission, new Set(submission.manifest.map(a => a.id)))
      const version = Number((await client.query('SELECT COALESCE(MAX(version),0)+1 AS version FROM team_task_submissions WHERE task_id=$1', [taskId])).rows[0].version)
      await client.query(`UPDATE team_task_submissions SET state='published',version=$2,published_at=NOW() WHERE submission_id=$1`, [submissionId, version])
      await this.advanceHead(client, taskId, submissionId, submission.delivery_role === 'primary')
      if (this.options.attemptId) await client.query("UPDATE team_task_step_attempts SET state='awaiting_review',updated_at=NOW() WHERE attempt_id=$1", [this.options.attemptId])
      await client.query(`UPDATE team_tasks SET state='in_progress',revision=revision+1,updated_at=NOW() WHERE task_id=$1`, [taskId])
      await client.query(`INSERT INTO team_delivery_export_status(call_id,phase) VALUES($1,'published') ON CONFLICT(call_id)
        DO UPDATE SET phase='published',error_code=NULL,revision=team_delivery_export_status.revision+1,updated_at=NOW()`,[submission.source_call_id])
      await this.event(client, taskId, 'submission_published', { submission_id: submissionId, spec_revision: Number(head.spec_revision), version })
      return { submission_id: submissionId, version, delivery_role: submission.delivery_role, state: 'published', revision: Number(head.revision) + 1 }
    })
  }
  async decide(taskId: string, actor: number, input: AcceptanceInput) {
    validateAcceptance(input)
    return this.mutate(taskId, actor, 'acceptance', input, async (client, task, head) => {
      if (input.spec_revision !== Number(head.spec_revision) || input.submission_id !== head.latest_submission_id) throw new TeamRepositoryError('revision_conflict', 'only the current delivery and specification can be reviewed', Number(head.revision))
      const spec = (await client.query('SELECT * FROM team_task_specs WHERE task_id=$1 AND revision=$2', [taskId, head.spec_revision])).rows[0]
      if (Number(spec.reviewer_user_id) !== actor) throw new TeamRepositoryError('reviewer_required', 'current designated reviewer required')
      const submission = await this.submission(client, taskId, input.submission_id)
      if (submission.state !== 'published' || Number(submission.spec_revision) !== Number(head.spec_revision)) throw new TeamRepositoryError('revision_conflict', 'submission specification changed', Number(head.revision))
      if ((await client.query('SELECT 1 FROM team_acceptance_decisions WHERE submission_id=$1', [input.submission_id])).rows[0]) throw new TeamRepositoryError('invalid_state', 'submission already reviewed; submit a new version')
      if (input.decision === 'accepted') {
        const required = spec.required_checks as string[]
        if (input.verified_checks.length !== required.length || required.some(id => !input.verified_checks.includes(id))) throw new TeamRepositoryError('evidence_required', 'reviewer must explicitly verify every required check')
        const evidence = required.map(id => submission.evidence.find(e => e.check_id === id))
        if (evidence.some(e => !e || e.result === 'failed')) throw new TeamRepositoryError('evidence_required', 'required check has missing or failed evidence')
        await this.available(client, submission, new Set([...submission.manifest.filter(a => a.required).map(a => a.id), ...evidence.map(e => e!.artifact_id)]))
      }
      const id = randomUUID()
      await client.query(`INSERT INTO team_acceptance_decisions(decision_id,submission_id,task_id,spec_revision,reviewer_user_id,decision,reason,verified_checks,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,clock_timestamp())`, [id, input.submission_id, taskId, head.spec_revision, actor, input.decision, input.reason.trim(), JSON.stringify(input.verified_checks)])
      await this.advanceHead(client, taskId)
      if (this.options.attemptId && input.decision === 'accepted') await client.query(`UPDATE team_task_step_attempts SET state='accepted',accepted_submission_id=$2,
        lease_token=lease_token+1,updated_at=NOW() WHERE attempt_id=$1`, [this.options.attemptId, input.submission_id])
      await this.event(client, taskId, 'acceptance_decided', { decision_id: id, submission_id: input.submission_id, decision: input.decision, reviewer_user_id: actor })
      if (input.decision === 'accepted') await this.options.memorySources?.projectAcceptedDelivery?.(client, { teamId: task.team_id, decisionId: id })
      return { decision_id: id, submission_id: input.submission_id, decision: input.decision, revision: Number(head.revision) + 1 }
    })
  }
  async readArtifact(taskId: string, actor: number, submissionId: string, artifactId: string) {
    return this.transaction(async client => {
      await this.task(client, taskId, actor)
      const submission = await this.submission(client, taskId, submissionId)
      if (submission.state !== 'published' && Number(submission.submitted_by_user_id) !== actor) throw new TeamRepositoryError('team_not_found', 'artifact not found')
      await this.available(client, submission, new Set([artifactId]))
      const row = (await client.query('SELECT content_bytes FROM team_submission_artifacts WHERE submission_id=$1 AND artifact_id=$2', [submissionId, artifactId])).rows[0]
      return { bytes: Buffer.from(row.content_bytes), manifest: submission.manifest.find(a => a.id === artifactId)! }
    })
  }
  async revokeArtifact(taskId: string, actor: number, submissionId: string, artifactId: string, input: DeliveryMutation & { reason: string }) {
    boundedText(input.reason, 'reason', 2000)
    return this.mutate(taskId, actor, `revoke:${submissionId}:${artifactId}`, input, async (client, task, head) => {
      const submission = await this.submission(client, taskId, submissionId)
      if (Number(submission.submitted_by_user_id) !== actor && task.role !== 'admin') throw new TeamRepositoryError('offer_owner_required', 'publisher or Team admin required')
      if (!(await client.query('SELECT 1 FROM team_submission_artifacts WHERE submission_id=$1 AND artifact_id=$2', [submissionId, artifactId])).rows[0]) throw new TeamRepositoryError('team_not_found', 'artifact not found')
      await client.query(`INSERT INTO team_artifact_revocations(submission_id,artifact_id,actor_user_id,reason) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [submissionId, artifactId, actor, input.reason])
      await this.cleanupMemorySources.revokeAcceptedDelivery(client, submissionId)
      await this.advanceHead(client, taskId)
      await this.event(client, taskId, 'artifact_revoked', { submission_id: submissionId, artifact_id: artifactId, actor_user_id: actor })
      return { artifact_id: artifactId, state: 'revoked', revision: Number(head.revision) + 1 }
    }, true)
  }
  async getReceipt(taskId: string, actor: number, requestId: string) {
    const result = await this.lookupReceipt(taskId, actor, requestId)
    if (!result.found) throw new TeamRepositoryError('team_not_found', 'operation receipt not found')
    return result.receipt!
  }
  async lookupReceipt(taskId: string, actor: number, requestId: string) {
    boundedText(requestId, 'request_id', 128)
    return this.transaction(async client => {
      await this.task(client, taskId, actor)
      const row = (await client.query('SELECT operation,response FROM team_delivery_receipts WHERE task_id=$1 AND actor_user_id=$2 AND request_id=$3 AND attempt_id IS NOT DISTINCT FROM $4::uuid', [taskId, actor, requestId, this.options.attemptId ?? null])).rows[0]
      // Only this explicit, authorized response proves absence. A legacy 404
      // could also mean an unknown route, removed task, or revoked membership.
      return { task_id: taskId, request_id: requestId, ...(this.options.attemptId ? { attempt_id: this.options.attemptId } : {}), found: Boolean(row), receipt: row && this.options.attemptId ? { ...row, response: { ...row.response, attempt_id: this.options.attemptId } } : row ?? null }
    })
  }

  async executionHistory(taskId: string, actor: number) {
    return this.transaction(async client => {
      await this.task(client, taskId, actor)
      const executions = (await client.query(`SELECT c.call_id,c.team_session_id,c.offer_id,o.provider,c.state,c.context_version,c.context_snapshot_hash,
        f.spec_revision,c.created_at,c.dispatched_at,c.accepted_at,c.finished_at,
        NULL::timestamptz AS started_at,
        CASE WHEN x.call_id IS NULL THEN NULL ELSE jsonb_build_object('phase',x.phase,'error_code',x.error_code,'revision',x.revision,'updated_at',x.updated_at) END AS export_status,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('submission_id',s.submission_id,'version',s.version,'published_at',s.published_at) ORDER BY s.version)
          FROM team_task_submissions s WHERE s.source_call_id=c.call_id AND s.state='published'),'[]') AS deliveries
        FROM collaboration_calls c LEFT JOIN team_call_delivery_specs f USING(call_id)
        LEFT JOIN team_agent_offers o ON o.offer_id=c.offer_id
        LEFT JOIN team_delivery_export_status x ON x.call_id=c.call_id
        WHERE c.task_id=$1
          AND ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM team_task_step_attempts a WHERE a.attempt_id=$2 AND a.task_id=c.task_id AND a.call_id=c.call_id))
          AND ($2::uuid IS NOT NULL OR NOT EXISTS(SELECT 1 FROM team_task_step_attempts a WHERE a.task_id=c.task_id AND a.call_id=c.call_id))
        ORDER BY c.created_at DESC,c.call_id DESC LIMIT 201`, [taskId, this.options.attemptId ?? null])).rows
      return { task_id: taskId, executions: executions.slice(0,200), has_more: executions.length > 200, started_at_source: 'unavailable' }
    })
  }

  async listInbox(actor: number, includeSteps = false) {
    await requireTeamAccess(this.pool, actor)
    // Projector lag must not expose old or newly unauthorized actions. Resolve
    // against current authority on every read, including with writes disabled.
    const items = (await this.pool.query(`WITH heads AS (
        SELECT task_id,revision,spec_revision,latest_submission_id,NULL::uuid AS attempt_id FROM team_task_delivery_heads h
          WHERE NOT EXISTS(SELECT 1 FROM team_task_plan_runtime r WHERE r.task_id=h.task_id)
        UNION ALL
        SELECT h.task_id,h.revision,h.spec_revision,h.latest_submission_id,h.attempt_id FROM team_step_delivery_heads h
          JOIN team_task_step_attempts a ON a.attempt_id=h.attempt_id AND a.task_id=h.task_id WHERE $2 AND a.state<>'cancelled'
      ) SELECT i.item_id,i.task_id,i.submission_id,i.kind,i.revision,i.seen_at,i.created_at,
      t.team_id,t.title,s.version,h.revision AS delivery_revision,h.spec_revision,h.attempt_id,
      (SELECT c.team_session_id FROM collaboration_calls c WHERE c.call_id=s.source_call_id) AS team_session_id,
      EXISTS(SELECT 1 FROM team_artifact_revocations r WHERE r.submission_id=s.submission_id) AS has_revoked_artifacts
      FROM team_delivery_attention_items i JOIN team_tasks t ON t.task_id=i.task_id AND t.state IN ('open','in_progress')
      JOIN collaboration_teams team ON team.team_id=t.team_id AND team.state='active'
      JOIN collaboration_team_memberships m ON m.team_id=t.team_id AND m.user_id=$1 AND m.state='active' AND m.role<>'viewer'
      JOIN users u ON u.id=m.user_id AND u.team_enabled=true
      JOIN heads h ON h.task_id=i.task_id AND h.latest_submission_id=i.submission_id
      JOIN team_task_specs p ON p.task_id=h.task_id AND p.revision=h.spec_revision
      JOIN team_task_submissions s ON s.submission_id=i.submission_id AND s.spec_revision=h.spec_revision
      LEFT JOIN team_acceptance_decisions d ON d.submission_id=s.submission_id
      WHERE i.user_id=$1 AND i.state='open' AND
        ((i.kind='review_required' AND d.decision IS NULL AND p.reviewer_user_id=$1)
          OR (i.kind='changes_requested' AND d.decision='changes_requested' AND s.submitted_by_user_id=$1))
      ORDER BY i.created_at,i.item_id LIMIT 200`, [actor, includeSteps])).rows
    return { items }
  }

  async markInboxSeen(actor: number, itemId: string) {
    return this.transaction(async client => {
      const item = (await client.query('SELECT task_id,user_id FROM team_delivery_attention_items WHERE item_id=$1', [itemId])).rows[0]
      if (!item || Number(item.user_id) !== actor) throw new TeamRepositoryError('team_not_found', 'reminder not found')
      await this.task(client, item.task_id, actor)
      await client.query('UPDATE team_delivery_attention_items SET seen_at=COALESCE(seen_at,NOW()) WHERE item_id=$1 AND user_id=$2', [itemId,actor])
      return { item_id: itemId, seen: true }
    })
  }
}
