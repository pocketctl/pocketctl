import {TeamTaskService} from '../team/task-service.js'
import { TeamTaskBudgetRepository } from '../team/budget-repository.js'
import { requireTaskBudgetCapacity, type TaskBudgetPolicy } from '../team/budget-service.js'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import Fastify from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { initDB, deleteUserAccount } from '../db.js'
import { humanTeamFixture } from './fixtures/team-v2.js'
import { TeamSessionService } from '../team/session-service.js'
import { TeamPlanService } from '../team/plan-service.js'
import { initTeamSchema } from '../team/schema.js'
import { initTeamPlanSchema } from '../team/plan-schema.js'
import { initTeamDeliverySchema } from '../team/delivery-schema.js'
import { registerTeamPlanRoutes } from '../team/plan-routes.js'
import { registerTeamDeliveryRoutes } from '../team/delivery-routes.js'
import { stableDigest, artifactDigest } from '../team/delivery-contract.js'
import { TeamDeliveryService, requireTaskDeliveryComplete } from '../team/delivery-service.js'
import { TeamDispatchRepository } from '../team/dispatch-repository.js'
import { freezeAcceptedPlanInputs } from '../team/plan-inputs.js'
import { TeamDeliveryProjector } from '../attention-inbox/team-delivery-projector.js'
import { StepWakeupRepository, StepWakeupLeaseLost, type StepWakeupClaim } from '../team/step-wakeup-repository.js'
import { TeamPlanExecutionService, type PlanControlInput } from '../team/plan-execution-service.js'
import { TeamStepScheduler } from '../team/step-scheduler.js'
import { TeamStepWorker } from '../team/step-worker.js'
import { TeamAgentConfigService } from '../team/agent-config-service.js'
import { TeamEvidenceService, evidenceConnectors, type TrustedEvidenceInput } from '../team/evidence-service.js'
import { registerTeamEvidenceRoutes } from '../team/evidence-routes.js'
import { registerTeamAccessGuard } from '../team/access.js'
import { TeamTaskContextService } from '../team/task-context-service.js'
import { TeamStepInputService } from '../team/step-input-service.js'
import { TeamContextDeliveryService } from '../team/context-delivery.js'
import type { TaskPlanInput } from '../team/plan-contract.js'

const enabled = process.env.RUN_POSTGRES_INTEGRATION === '1' && Boolean(process.env.TEST_DATABASE_URL)
;(enabled ? describe : describe.skip)('task plan drafts (isolated PostgreSQL)', () => {
  let pool: pg.Pool
  beforeAll(async () => {
    const url = new URL(process.env.TEST_DATABASE_URL!)
    if (url.hostname !== '127.0.0.1' || !['18998', '18999', '19030'].includes(url.port) || url.pathname !== '/team_relay_test' || url.username !== 'team_relay_test') throw Error('dedicated disposable plan database required')
    pool = new pg.Pool({ connectionString: url.toString(), max: 8 })
    const identity = (await pool.query('SELECT current_database() db,current_user usr,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) superuser')).rows[0]
    if (identity.db !== 'team_relay_test' || identity.usr !== identity.db || identity.superuser) throw Error('non-superuser test identity required')
    await initDB(pool)
  }, 30000)
  beforeEach(async () => { await pool.query('TRUNCATE users,daemons RESTART IDENTITY CASCADE') })
  afterAll(async () => { await pool?.end() })
  async function fixture() {
    const f = await humanTeamFixture(pool), offer = `plan-offer-${randomUUID()}`, daemon = `plan-daemon-${randomUUID()}`
    await pool.query(`INSERT INTO daemons(daemon_id,hostname,status,user_id,agents,collaboration_capabilities) VALUES($1,'plan-test','online',$2,
      '[{"type":"codex","manageable":true}]','["team_collaboration_dispatch_v1","team_collaboration_context_v1","team_task_delivery_v1"]')`, [daemon, f.users[0]])
    await pool.query("INSERT INTO team_agent_offers(offer_id,team_id,owner_user_id,daemon_id,provider) VALUES($1,$2,$3,$4,'codex')", [offer, f.teamId, f.users[0], daemon])
    const sessions = new TeamSessionService(pool, {}, undefined, undefined, id => id === f.teamId)
    await sessions.changeBinding({ sessionId: f.session.id, actorUserId: f.users[0], offerId: offer, active: true, expectedRevision: f.session.revision, requestId: 'bind' })
    const assigned = await sessions.assignTask({ sessionId: f.session.id, actorUserId: f.users[0], requestId: 'assign', instruction: 'Plan fixture', acceptance: 'Independent review', targetOfferIds: [offer], contextVersion: 0,
      reviewPolicy: { reviewer_user_id: f.users[1], primary_offer_id: offer, required_checks: ['unit'] } })
    const service = new TeamPlanService(pool, { writesEnabledForTeam: id => id === f.teamId })
    const input: TaskPlanInput = { request_id: 'save', expected_revision: 0, team_session_id: f.session.id, context_version: 0, spec_revision: 1,
      steps: ['implement', 'review', 'regress'].map((id, i, ids) => ({ step_id: id, title: id, instruction: `Do ${id}`, acceptance: 'Checked', required: true, depends_on: i ? [ids[i - 1]] : [],
        review_policy: { reviewer_user_id: f.users[1], primary_offer_id: offer, required_checks: ['unit'] } })) }
    const task = assigned.task_id
    const save = (value = input, actor = f.users[0]) => service.saveDraft(task, actor, value)
    return { ...f, offer, daemon, service, input, task, save }
  }
  async function insertReservedAttempt(task: string, step = 'implement') {
    const attempt = randomUUID()
    // Synthetic reservation only: no scheduler or native execution is claimed.
    await pool.query(`INSERT INTO team_task_step_attempts(attempt_id,task_id,plan_revision,step_id,attempt_no,state,frozen_inputs,input_hash)
      VALUES($1,$2,1,$3,1,'reserved','[]',$4)`, [attempt, task, step, stableDigest([])])
    return attempt
  }
  async function preparedSource(f: Awaited<ReturnType<typeof fixture>>) {
    await f.save()
    const attempt = await insertReservedAttempt(f.task)
    const call = (await pool.query('SELECT call_id FROM collaboration_calls WHERE task_id=$1', [f.task])).rows[0].call_id
    const dispatcher = new TeamDispatchRepository(pool)
    expect(await dispatcher.claim(call)).not.toBeNull()
    expect(await dispatcher.bindNativeSession(call, f.daemon, f.users[0], `fixture-${randomUUID()}`)).toBe(true)
    await pool.query("UPDATE collaboration_calls SET state='completed',finished_at=NOW() WHERE call_id=$1", [call])
    await pool.query('UPDATE team_task_step_attempts SET call_id=$2 WHERE attempt_id=$1', [attempt, call])
    await pool.query('INSERT INTO team_step_delivery_heads(attempt_id,task_id,spec_revision) VALUES($1,$2,1)', [attempt, f.task])
    const rootDelivery = new TeamDeliveryService(pool, { writesEnabledForTeam: id => id === f.teamId, stepWritesEnabledForTeam: id => id === f.teamId })
    const delivery = rootDelivery.forAttempt(attempt), bytes = Buffer.from('synthetic step evidence')
    const payload = { request_id: 'prepare', expected_revision: 1, spec_revision: 1, source_call_id: call, summary: 'Synthetic input', code_revision: 'code-v1', publish_scope: 'team' as const, contribution_ids: [],
      artifacts: [{ id: 'proof', name: 'proof.md', mime_type: 'text/markdown', byte_size: bytes.length, sha256: artifactDigest(bytes), required: true }],
      evidence: [{ check_id: 'unit', result: 'passed' as const, source_kind: 'agent_claim' as const, artifact_id: 'proof', code_revision: 'code-v1' }] }
    const stage = await delivery.prepare(f.task, f.users[0], payload)
    await delivery.uploadArtifact(f.task, f.users[0], stage.submission_id, 'proof', bytes)
    return { attempt, call, delivery, rootDelivery, bytes, stage, payload }
  }
  async function acceptedSource(f: Awaited<ReturnType<typeof fixture>>) {
    const { attempt, call, delivery, rootDelivery, bytes, stage } = await preparedSource(f)
    await delivery.publish(f.task, f.users[0], stage.submission_id, { request_id: 'publish', expected_revision: 1 })
    const decision = await delivery.decide(f.task, f.users[1], { request_id: 'accept', expected_revision: 2, spec_revision: 1, submission_id: stage.submission_id, decision: 'accepted', reason: '', verified_checks: ['unit'] })
    const selected = [{ step_id: 'implement', attempt_id: attempt, submission_id: stage.submission_id }]
    return { attempt, call, delivery, rootDelivery, bytes, decision, submission: stage.submission_id, selected }
  }
  test('new/repeated migration and plan save preserve the original Call; snapshots are immutable', async () => {
    const f = await fixture(), before = (await pool.query('SELECT call_id FROM collaboration_calls WHERE task_id=$1', [f.task])).rows
    await initTeamPlanSchema(pool); await initTeamPlanSchema(pool)
    const result = await f.save()
    expect(result).toMatchObject({ revision: 1, state: 'draft', execution_enabled: false })
    expect(await f.save()).toEqual(result)
    expect((await f.service.getPlan(f.task, f.users[1])).plan?.steps).toEqual(f.input.steps)
    expect((await pool.query('SELECT call_id FROM collaboration_calls WHERE task_id=$1', [f.task])).rows).toEqual(before)
    expect((await pool.query('SELECT count(*)::int n FROM team_task_step_attempts')).rows[0].n).toBe(0)
    await expect(pool.query("UPDATE team_task_plan_revisions SET context_version=1 WHERE task_id=$1", [f.task])).rejects.toMatchObject({ code: '23514' })
    await expect(pool.query("UPDATE team_task_plan_steps SET definition='{}' WHERE task_id=$1", [f.task])).rejects.toMatchObject({ code: '23514' })
  })
  test('20 concurrent CAS pairs produce exactly one revision/receipt each and no Call', async () => {
    const f = await fixture()
    for (let i = 0; i < 20; i++) {
      const requests = [1, 2].map(n => ({ ...f.input, expected_revision: i, request_id: `r${i}-${n}` }))
      const result = await Promise.allSettled(requests.map(value => f.save(value)))
      expect(result.filter(r => r.status === 'fulfilled')).toHaveLength(1)
      expect((result.find(r => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'revision_conflict' })
      const winner = result.findIndex(r => r.status === 'fulfilled')
      expect(await f.save(requests[winner])).toEqual((result[winner] as PromiseFulfilledResult<unknown>).value)
    }
    expect((await pool.query('SELECT count(*)::int n FROM team_task_plan_revisions WHERE task_id=$1', [f.task])).rows[0].n).toBe(20)
    expect((await pool.query('SELECT count(*)::int n FROM team_task_plan_receipts WHERE task_id=$1', [f.task])).rows[0].n).toBe(20)
    expect((await pool.query('SELECT count(*)::int n FROM collaboration_calls WHERE task_id=$1', [f.task])).rows[0].n).toBe(1)
  })
  test('payload conflict and cross-actor receipt lookup cannot reuse a saved operation', async () => {
    const f = await fixture(); await f.save()
    await expect(f.save({ ...f.input, context_version: 1 })).rejects.toMatchObject({ code: 'idempotency_conflict' })
    expect(await f.service.lookupReceipt(f.task, f.users[0], 'save')).toMatchObject({ found: true })
    expect(await f.service.lookupReceipt(f.task, f.users[1], 'save')).toMatchObject({ found: false, response: null })
  })
  test('old revisions survive edits; a reserved step cannot change or disappear', async () => {
    const f = await fixture(); await f.save()
    await insertReservedAttempt(f.task)
    const next = structuredClone(f.input); next.expected_revision = 1; next.request_id = 'edit'; next.steps[1].instruction = 'Updated not-started review'
    await f.save(next)
    expect((await f.service.getPlan(f.task, f.users[0], 1)).plan?.steps).toEqual(f.input.steps)
    expect((await f.service.getPlan(f.task, f.users[0])).plan?.steps[1].instruction).toBe(next.steps[1].instruction)
    next.expected_revision = 2; next.request_id = 'bad'; next.steps[0].acceptance = 'Changed started policy'
    await expect(f.save(next)).rejects.toMatchObject({ code: 'invalid_state' })
    expect((await f.service.getPlan(f.task, f.users[0])).revision).toBe(2)
    await expect(pool.query("UPDATE team_task_step_attempts SET frozen_inputs='[{}]' WHERE task_id=$1", [f.task])).rejects.toMatchObject({ code: '23514' })
  })
  test('revocation blocks reads and receipt replay; disabled writes keep authorized recovery readable', async () => {
    const f = await fixture(); await f.save()
    const off = new TeamPlanService(pool)
    await expect(off.saveDraft(f.task, f.users[0], f.input)).rejects.toMatchObject({ code: 'team_feature_disabled' })
    expect(await off.lookupReceipt(f.task, f.users[0], 'save')).toMatchObject({ found: true })
    await pool.query("UPDATE collaboration_team_memberships SET state='removed' WHERE team_id=$1 AND user_id=$2", [f.teamId, f.users[0]])
    await expect(f.save()).rejects.toMatchObject({ code: 'team_not_found' })
    await expect(f.service.getPlan(f.task, f.users[0])).rejects.toMatchObject({ code: 'team_not_found' })
    await expect(f.service.lookupReceipt(f.task, f.users[0], 'save')).rejects.toMatchObject({ code: 'team_not_found' })
  })
  test('members can read but cannot change another creator plan; viewer and outsider cannot mutate', async () => {
    const f = await fixture(), other = await humanTeamFixture(pool); await f.save()
    await expect(f.save(f.input, f.users[1])).rejects.toMatchObject({ code: 'creator_required' })
    await pool.query("UPDATE collaboration_team_memberships SET role='viewer' WHERE team_id=$1 AND user_id=$2", [f.teamId, f.users[2]])
    expect((await f.service.getPlan(f.task, f.users[2])).writes_enabled).toBe(false)
    await expect(f.save(f.input, f.users[2])).rejects.toMatchObject({ code: 'creator_required' })
    await expect(f.service.getPlan(f.task, other.users[0])).rejects.toMatchObject({ code: 'team_not_found' })
  })
  test('same-Team session unrelated to the Task and other-Team reviewers are rejected', async () => {
    const f = await fixture(), other = await humanTeamFixture(pool)
    const unlinked = await new TeamSessionService(pool).createSession({ teamId: f.teamId, actorUserId: f.users[0], title: 'unlinked', taskId: null, offerIds: [], participantUserIds: [], requestId: 'unlinked' })
    await expect(f.save({ ...f.input, team_session_id: unlinked.id })).rejects.toMatchObject({ code: 'invalid_request' })
    const bad = structuredClone(f.input); bad.steps[0].review_policy.reviewer_user_id = other.users[0]
    await expect(f.save(bad)).rejects.toMatchObject({ code: 'reviewer_required' })
    expect((await f.service.getPlan(f.task, f.users[0])).revision).toBe(0)
  })
  test('stale specification/context and missing Agent capability cannot save a draft', async () => {
    const f = await fixture()
    await expect(f.save({ ...f.input, spec_revision: 2 })).rejects.toMatchObject({ code: 'revision_conflict' })
    await expect(f.save({ ...f.input, context_version: 1 })).rejects.toMatchObject({ code: 'context_revision_conflict' })
    await pool.query("UPDATE daemons SET collaboration_capabilities='[]' WHERE daemon_id=$1", [f.daemon])
    await expect(f.save()).rejects.toMatchObject({ code: 'agent_unavailable' })
    expect((await f.service.getPlan(f.task, f.users[0])).revision).toBe(0)
  })
  test('late receipt failure rolls back revision and steps together', async () => {
    const f = await fixture()
    await pool.query(`CREATE FUNCTION fail_plan_receipt_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'plan receipt fault'; END $$;
      CREATE TRIGGER fail_plan_receipt_test BEFORE INSERT ON team_task_plan_receipts FOR EACH ROW EXECUTE FUNCTION fail_plan_receipt_test()`)
    try { await expect(f.save()).rejects.toThrow('plan receipt fault') }
    finally { await pool.query('DROP TRIGGER fail_plan_receipt_test ON team_task_plan_receipts; DROP FUNCTION fail_plan_receipt_test()') }
    expect((await f.service.getPlan(f.task, f.users[0])).revision).toBe(0)
    expect((await pool.query('SELECT count(*)::int n FROM team_task_plan_steps WHERE task_id=$1', [f.task])).rows[0].n).toBe(0)
    expect(await f.save()).toMatchObject({ revision: 1 })
  })
  test('account deletion preserves draft provenance without blocking deletion', async () => {
    const f = await fixture(); await f.save()
    const before = (await pool.query('SELECT * FROM team_task_plan_revisions WHERE task_id=$1', [f.task])).rows
    expect(await deleteUserAccount(pool, f.users[0])).toBe(true)
    expect((await pool.query('SELECT * FROM team_task_plan_revisions WHERE task_id=$1', [f.task])).rows).toEqual(before)
    await expect(f.service.getPlan(f.task, f.users[1])).rejects.toMatchObject({ code: 'team_not_found' })
  })
  test('freeze pins accepted version, policy, evidence and file hashes; a later spec cannot rewrite it', async () => {
    const f = await fixture(), source = await acceptedSource(f)
    const input = await freezeAcceptedPlanInputs(pool, f.task, 1, 'review', source.selected)
    expect(input).toHaveLength(1)
    expect(input[0]).toMatchObject({ attempt_id: source.attempt, submission_id: source.submission, source_call_id: source.call, submission_version: 1, spec_revision: 1,
      decision_id: source.decision.decision_id, context_version: 0, code_revision: 'code-v1', verified_checks: ['unit'] })
    const downstream = randomUUID()
    await pool.query(`INSERT INTO team_task_step_attempts(attempt_id,task_id,plan_revision,step_id,attempt_no,state,frozen_inputs,input_hash)
      VALUES($1,$2,1,'review',1,'reserved',$3::jsonb,$4)`, [downstream, f.task, JSON.stringify(input), stableDigest(input)])
    await source.rootDelivery.reviseSpec(f.task, f.users[0], { request_id: 'spec-v2', expected_revision: 1, goal: 'Changed global goal', acceptance: 'New criteria', policy: { reviewer_user_id: f.users[1], primary_offer_id: f.offer, required_checks: ['unit'] } })
    expect((await pool.query('SELECT frozen_inputs,input_hash FROM team_task_step_attempts WHERE attempt_id=$1', [downstream])).rows[0]).toEqual({ frozen_inputs: input, input_hash: stableDigest(input) })
    expect(await freezeAcceptedPlanInputs(pool, f.task, 1, 'review', source.selected)).toEqual(input)
    await expect(pool.query('UPDATE team_task_step_attempts SET accepted_submission_id=NULL WHERE attempt_id=$1', [source.attempt])).rejects.toMatchObject({ code: '23514' })
  })
  test('join inputs cannot be omitted, duplicated, cross-task, unaccepted or revoked', async () => {
    const f = await fixture(), source = await acceptedSource(f)
    await expect(freezeAcceptedPlanInputs(pool, f.task, 1, 'review', [])).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(freezeAcceptedPlanInputs(pool, f.task, 1, 'review', [...source.selected, ...source.selected])).rejects.toMatchObject({ code: 'invalid_request' })
    const other = await fixture(); await other.save()
    await expect(freezeAcceptedPlanInputs(pool, other.task, 1, 'review', source.selected)).rejects.toMatchObject({ code: 'acceptance_required' })
    await pool.query("UPDATE team_task_step_attempts SET state='unknown' WHERE attempt_id=$1", [source.attempt])
    await expect(freezeAcceptedPlanInputs(pool, f.task, 1, 'review', source.selected)).rejects.toMatchObject({ code: 'acceptance_required' })
    await pool.query("UPDATE team_task_step_attempts SET state='accepted' WHERE attempt_id=$1", [source.attempt])
    await source.delivery.revokeArtifact(f.task, f.users[0], source.submission, 'proof', { request_id: 'revoke', expected_revision: 3, reason: 'fixture source revoked' })
    await expect(freezeAcceptedPlanInputs(pool, f.task, 1, 'review', source.selected)).rejects.toMatchObject({ code: 'artifact_unavailable' })
  })
  test('two step scopes retain independent heads and decisions; the join freezes both accepted outputs', async () => {
    const f = await fixture()
    f.input.steps[1].depends_on = []
    f.input.steps[2].depends_on = ['implement', 'review']
    await f.save()
    const dispatcher = new TeamDispatchRepository(pool)
    async function complete(call: string) {
      const claimed = await dispatcher.claim(call)
      expect(claimed).not.toBeNull()
      if (claimed!.authorization.operation === 'create') expect(await dispatcher.bindNativeSession(call, f.daemon, f.users[0], `fixture-${randomUUID()}`)).toBe(true)
      await pool.query("UPDATE collaboration_calls SET state='completed',finished_at=NOW() WHERE call_id=$1", [call])
    }
    const firstCall = (await pool.query('SELECT call_id FROM collaboration_calls WHERE task_id=$1', [f.task])).rows[0].call_id
    await complete(firstCall)
    const sessions = new TeamSessionService(pool, {}, undefined, undefined, id => id === f.teamId)
    const execution = await sessions.executeTask({ sessionId: f.session.id, taskId: f.task, actorUserId: f.users[0], request_id: 'second-step-fixture', expected_revision: 1, spec_revision: 1, context_version: 0, target_offer_ids: [f.offer] })
    const secondCall = execution.call_ids[0]
    await complete(secondCall)
    const base = new TeamDeliveryService(pool, { writesEnabledForTeam: id => id === f.teamId, stepWritesEnabledForTeam: id => id === f.teamId })
    const scopes = []
    for (const [index, call] of [firstCall, secondCall].entries()) {
      const step = f.input.steps[index].step_id, attempt = await insertReservedAttempt(f.task, step)
      await pool.query('UPDATE team_task_step_attempts SET call_id=$2 WHERE attempt_id=$1', [attempt, call])
      await pool.query('INSERT INTO team_step_delivery_heads(attempt_id,task_id,spec_revision) VALUES($1,$2,1)', [attempt, f.task])
      const scoped = base.forAttempt(attempt), bytes = Buffer.from(`synthetic scoped proof ${step}`)
      const payload = { request_id: `prepare-${step}`, expected_revision: 1, spec_revision: 1, source_call_id: call, summary: step, code_revision: null, publish_scope: 'team' as const, contribution_ids: [],
        artifacts: [{ id: 'proof', name: 'proof.md', mime_type: 'text/markdown', byte_size: bytes.length, sha256: artifactDigest(bytes), required: true }],
        evidence: [{ check_id: 'unit', result: 'passed' as const, source_kind: 'agent_claim' as const, artifact_id: 'proof', code_revision: null }] }
      await expect(base.prepare(f.task, f.users[0], { ...payload, expected_revision: execution.revision })).rejects.toMatchObject({ code: 'invalid_request' })
      const submission = await scoped.prepare(f.task, f.users[0], payload)
      await scoped.uploadArtifact(f.task, f.users[0], submission.submission_id, 'proof', bytes)
      await scoped.publish(f.task, f.users[0], submission.submission_id, { request_id: `publish-${step}`, expected_revision: 1 })
      scopes.push({ step_id: step, attempt_id: attempt, submission_id: submission.submission_id, scoped, bytes, payload })
    }
    for (const row of scopes) expect((await row.scoped.getDelivery(f.task, f.users[1])).latest_submission_id).toBe(row.submission_id)
    for (const row of scopes) {
      expect((await row.scoped.executionHistory(f.task, f.users[1])).executions.map(c => c.call_id)).toEqual([row.payload.source_call_id])
      const upper = base.forAttempt(row.attempt_id.toUpperCase())
      expect((await upper.readArtifact(f.task, f.users[1], row.submission_id, 'proof')).bytes).toEqual(row.bytes)
      expect(await upper.prepare(f.task, f.users[0], row.payload)).toMatchObject({ submission_id: row.submission_id })
    }
    expect((await base.executionHistory(f.task, f.users[1])).executions).toEqual([])
    expect((await base.getDelivery(f.task, f.users[0])).latest_submission_id).toBeNull()
    expect((await base.getDelivery(f.task, f.users[0])).submissions).toHaveLength(0)
    await expect(scopes[1].scoped.readArtifact(f.task, f.users[1], scopes[0].submission_id, 'proof')).rejects.toMatchObject({ code: 'invalid_request' })
    expect((await scopes[1].scoped.lookupReceipt(f.task, f.users[0], scopes[0].payload.request_id)).found).toBe(false)
    expect(await scopes[0].scoped.lookupReceipt(f.task, f.users[0], scopes[0].payload.request_id)).toMatchObject({ found: true, attempt_id: scopes[0].attempt_id, receipt: { response: { attempt_id: scopes[0].attempt_id } } })
    // Older stored receipts predate the explicit response scope; replay decorates
    // only after the durable attempt filter/fingerprint has matched.
    await pool.query("UPDATE team_delivery_receipts SET response=response-'attempt_id' WHERE task_id=$1 AND request_id=$2", [f.task, scopes[0].payload.request_id])
    expect(await scopes[0].scoped.prepare(f.task, f.users[0], scopes[0].payload)).toMatchObject({ attempt_id: scopes[0].attempt_id })
    expect(await scopes[0].scoped.lookupReceipt(f.task, f.users[0], scopes[0].payload.request_id)).toMatchObject({ attempt_id: scopes[0].attempt_id, receipt: { response: { attempt_id: scopes[0].attempt_id } } })
    expect(await base.lookupReceipt(f.task, f.users[0], scopes[0].payload.request_id)).toMatchObject({ found: false, receipt: null })
    await expect(scopes[1].scoped.prepare(f.task, f.users[0], scopes[0].payload)).rejects.toMatchObject({ code: 'idempotency_conflict' })
    const choices = scopes.map(({ step_id, attempt_id, submission_id }) => ({ step_id, attempt_id, submission_id }))
    await expect(freezeAcceptedPlanInputs(pool, f.task, 1, 'regress', choices)).rejects.toMatchObject({ code: 'acceptance_required' })
    const projector = new TeamDeliveryProjector(pool)
    await projector.runOnce()
    expect((await pool.query("SELECT count(*)::int n FROM team_delivery_attention_items WHERE task_id=$1 AND state='open'", [f.task])).rows[0].n).toBe(2)
    expect((await base.listInbox(f.users[1])).items).toHaveLength(0)
    expect((await base.listInbox(f.users[1], true)).items.map(row => row.attempt_id).sort()).toEqual(scopes.map(row => row.attempt_id).sort())
    for (const [i, row] of scopes.entries()) {
      await row.scoped.decide(f.task, f.users[1], { request_id: `accept-${row.step_id}`, expected_revision: 2, spec_revision: 1, submission_id: row.submission_id, decision: 'accepted', reason: '', verified_checks: ['unit'] })
      await projector.runOnce()
      expect((await pool.query("SELECT count(*)::int n FROM team_delivery_attention_items WHERE task_id=$1 AND state='open'", [f.task])).rows[0].n).toBe(1 - i)
      expect((await base.listInbox(f.users[1], true)).items).toHaveLength(1 - i)
      if (i === 0) await expect(freezeAcceptedPlanInputs(pool, f.task, 1, 'regress', choices)).rejects.toMatchObject({ code: 'acceptance_required' })
    }
    await projector.runOnce()
    expect((await pool.query('SELECT count(*)::int n FROM team_delivery_attention_items WHERE task_id=$1', [f.task])).rows[0].n).toBe(2)
    const frozen = await freezeAcceptedPlanInputs(pool, f.task, 1, 'regress', choices)
    expect(frozen.map(row => row.submission_id).sort()).toEqual(choices.map(row => row.submission_id).sort())
    expect((await pool.query("SELECT count(*)::int n FROM team_task_step_attempts WHERE task_id=$1 AND state='accepted'", [f.task])).rows[0].n).toBe(2)
    expect((await base.getDelivery(f.task, f.users[0])).revision).toBe(execution.revision)
    const read = await new TeamPlanExecutionService(pool, () => true).getExecution(f.task, f.users[0])
    expect(read.attempts.map(a => a.latest_decision)).toEqual(['accepted', 'accepted'])
    const off = new TeamDeliveryService(pool, { writesEnabledForTeam: () => true }).forAttempt(scopes[0].attempt_id)
    expect((await off.getDelivery(f.task, f.users[0])).writes_enabled).toBe(false)
    await expect(off.prepare(f.task, f.users[0], scopes[0].payload)).rejects.toMatchObject({ code: 'team_feature_disabled' })
  })
  test('HTTP auth/query/body validation, real save and receipt read use the draft-only contract', async () => {
    const f = await fixture(), app = Fastify()
    registerTeamPlanRoutes(app, { service: f.service, verifyAccessToken: async token => token === 'valid' ? { userId: f.users[0] } : null, getDatabaseReady: () => true })
    const url = `/api/team/tasks/${f.task}/plan`, headers = { authorization: 'Bearer valid' }
    try {
      expect((await app.inject({ url })).statusCode).toBe(401)
      expect((await app.inject({ url: `${url}?revision=1x`, headers })).statusCode).toBe(400)
      expect((await app.inject({ method: 'POST', url, headers, payload: { ...f.input, activate: true } })).statusCode).toBe(400)
      const response = await app.inject({ method: 'POST', url, headers, payload: f.input })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({ state: 'draft', execution_enabled: false })
      const receipt = await app.inject({ url: `${url}/receipt-lookup/save`, headers })
      expect(receipt.json()).toMatchObject({ found: true, response: response.json() })
      expect(receipt.headers['cache-control']).toBe('no-store')
    } finally { await app.close() }
  })
  test('database rejects cross-task Call binding and another attempt output as the current head', async () => {
    const f = await fixture(), other = await fixture(); await f.save()
    const attempt = await insertReservedAttempt(f.task)
    const foreignCall = (await pool.query('SELECT call_id FROM collaboration_calls WHERE task_id=$1', [other.task])).rows[0].call_id
    await expect(pool.query('UPDATE team_task_step_attempts SET call_id=$2 WHERE attempt_id=$1', [attempt, foreignCall])).rejects.toMatchObject({ code: '23514' })
    const source = await acceptedSource(other)
    await pool.query('INSERT INTO team_step_delivery_heads(attempt_id,task_id,spec_revision) VALUES($1,$2,1)', [attempt, f.task])
    await expect(pool.query('UPDATE team_step_delivery_heads SET latest_submission_id=$2 WHERE attempt_id=$1', [attempt, source.submission])).rejects.toMatchObject({ code: '23514' })
    await expect(pool.query('UPDATE team_step_delivery_heads SET spec_revision=2 WHERE attempt_id=$1', [attempt])).rejects.toMatchObject({ code: '23514' })
  })
  test.each(['cancelled', 'unknown', 'failed'] as const)('%s attempt rejects late delivery writes while preserving receipts, history and revocation', async state => {
    const f = await fixture(), source = await preparedSource(f)
    const { delivery, stage, payload, attempt, bytes } = source
    expect((await source.rootDelivery.exportJobs(f.daemon, f.users[0])).jobs).toEqual([])
    await expect(source.rootDelivery.reportExportStatus(f.task, f.users[0], f.daemon, source.call, { expected_revision: 0, phase: 'waiting_for_files', error_code: 'manifest_unavailable' })).rejects.toMatchObject({ code: 'invalid_request' })
    await pool.query('UPDATE team_task_step_attempts SET state=$2 WHERE attempt_id=$1', [attempt, state])
    expect(await delivery.prepare(f.task, f.users[0], payload)).toEqual(stage)
    expect((await delivery.lookupReceipt(f.task, f.users[0], 'prepare')).found).toBe(true)
    await expect(delivery.prepare(f.task, f.users[0], { ...payload, request_id: 'late-prepare' })).rejects.toMatchObject({ code: 'invalid_state' })
    await expect(delivery.uploadArtifact(f.task, f.users[0], stage.submission_id, 'proof', bytes)).rejects.toMatchObject({ code: 'invalid_state' })
    await expect(delivery.publish(f.task, f.users[0], stage.submission_id, { request_id: 'late-publish', expected_revision: 1 })).rejects.toMatchObject({ code: 'invalid_state' })
    expect((await delivery.getDelivery(f.task, f.users[0])).revision).toBe(1)
    expect((await delivery.readArtifact(f.task, f.users[0], stage.submission_id, 'proof')).bytes).toEqual(bytes)
    expect((await pool.query('SELECT count(*)::int n FROM team_delivery_receipts WHERE task_id=$1', [f.task])).rows[0].n).toBe(1)
    await delivery.revokeArtifact(f.task, f.users[0], stage.submission_id, 'proof', { request_id: 'revoke', expected_revision: 1, reason: 'Remove cancelled execution evidence' })
    expect((await pool.query('SELECT state FROM team_task_step_attempts WHERE attempt_id=$1', [attempt])).rows[0].state).toBe(state)
    if (state === 'cancelled') await expect(pool.query("UPDATE team_task_step_attempts SET state='running' WHERE attempt_id=$1", [attempt])).rejects.toMatchObject({ code: '23514' })
  })
  test('cancelled review cannot accept or supply downstream inputs; publish replay remains unchanged', async () => {
    const f = await fixture(), source = await preparedSource(f)
    const { delivery, stage, attempt } = source, publish = { request_id: 'publish', expected_revision: 1 }
    const result = await delivery.publish(f.task, f.users[0], stage.submission_id, publish)
    await pool.query("UPDATE team_task_step_attempts SET state='cancelled' WHERE attempt_id=$1", [attempt])
    expect(await delivery.publish(f.task, f.users[0], stage.submission_id, publish)).toEqual(result)
    await expect(delivery.decide(f.task, f.users[1], { request_id: 'late-accept', expected_revision: 2, spec_revision: 1, submission_id: stage.submission_id, decision: 'accepted', reason: '', verified_checks: ['unit'] })).rejects.toMatchObject({ code: 'invalid_state' })
    await expect(freezeAcceptedPlanInputs(pool, f.task, 1, 'review', [{ step_id: 'implement', attempt_id: attempt, submission_id: stage.submission_id }])).rejects.toMatchObject({ code: 'acceptance_required' })
    expect((await pool.query('SELECT count(*)::int n FROM team_acceptance_decisions WHERE task_id=$1', [f.task])).rows[0].n).toBe(0)
    expect((await delivery.getDelivery(f.task, f.users[1])).revision).toBe(2)
  })
  test('global specification edits allocate beyond independently reserved step specifications', async () => {
    const f = await fixture()
    await pool.query(`INSERT INTO team_task_specs(task_id,revision,goal,acceptance,primary_offer_id,reviewer_user_id,required_checks,created_by_user_id)
      SELECT task_id,4,'step-specific goal',acceptance,primary_offer_id,reviewer_user_id,required_checks,created_by_user_id FROM team_task_specs WHERE task_id=$1 AND revision=1`, [f.task])
    const delivery = new TeamDeliveryService(pool, { writesEnabledForTeam: () => true })
    const updated = await delivery.reviseSpec(f.task, f.users[0], { request_id: 'revise-after-step', expected_revision: 1, goal: 'new global goal', acceptance: 'checked', policy: f.input.steps[0].review_policy })
    expect(updated.spec_revision).toBe(5)
    expect((await pool.query('SELECT goal FROM team_task_specs WHERE task_id=$1 AND revision=4', [f.task])).rows[0].goal).toBe('step-specific goal')
  })
  test('step HTTP publication, receipt recovery, jobs and reads remain scoped and gated', async () => {
    const f = await fixture(), source = await preparedSource(f), apps = [Fastify(), Fastify()]
    const base = `/api/team/tasks/${f.task}/attempts/${source.attempt}/delivery`
    const headers = { authorization: 'Bearer owner' }
    for (const app of apps) registerTeamDeliveryRoutes(app, { service: source.rootDelivery, getDatabaseReady: () => true,
      verifyAccessToken: async token => token === 'owner' ? { userId: f.users[0] } : token === 'reviewer' ? { userId: f.users[1] } : null })
    try {
      const jobsURL = `/api/team/daemons/${f.daemon}/delivery-jobs`
      expect((await apps[0].inject({ url: jobsURL, headers })).json().jobs).toEqual([])
      const jobs = (await apps[0].inject({ url: `${jobsURL}?include_steps=true`, headers })).json().jobs
      expect(jobs).toHaveLength(1)
      expect(jobs[0]).toMatchObject({ attempt_id: source.attempt, call_id: source.call, authorization: { delivery: { attempt_id: source.attempt, task_id: f.task, spec_revision: 1 } } })
      expect((await new TeamDeliveryService(pool, { writesEnabledForTeam: () => true }).exportJobs(f.daemon, f.users[0], '', true)).jobs).toEqual([])
      expect((await apps[0].inject({ url: `${jobsURL}?include_steps=1`, headers })).statusCode).toBe(400)
      expect((await apps[0].inject({ url: base })).statusCode).toBe(401)
      expect((await apps[0].inject({ url: base.replace(source.attempt, randomUUID()), headers })).statusCode).toBe(404)
      expect((await apps[0].inject({ url: `${base}/management`, headers })).statusCode).toBe(404)
      expect((await apps[0].inject({ url: `${base}/receipt-lookup/missing`, headers })).json()).toMatchObject({ found: false, receipt: null })
      const result = await Promise.all(apps.map(app => app.inject({ method: 'POST', url: `${base}/submissions/${source.stage.submission_id}/publish`, headers, payload: { request_id: 'http-publish', expected_revision: 1 } })))
      expect(result.map(r => r.statusCode)).toEqual([200, 200])
      expect(result[0].json()).toEqual(result[1].json())
      expect((await apps[1].inject({ url: `${base}/receipt-lookup/http-publish`, headers })).json()).toMatchObject({ found: true, receipt: { response: result[0].json() } })
      const file = await apps[0].inject({ url: `${base}/submissions/${source.stage.submission_id}/artifacts/proof`, headers })
      expect(file.statusCode).toBe(200); expect(file.rawPayload).toEqual(source.bytes)
      expect(file.headers['cache-control']).toBe('no-store')
      const accepted = await apps[0].inject({ method: 'POST', url: `${base}/decisions`, headers: { authorization: 'Bearer reviewer' }, payload: {
        request_id: 'http-accept', expected_revision: 2, spec_revision: 1, submission_id: source.stage.submission_id, decision: 'accepted', reason: '', verified_checks: ['unit'] } })
      expect(accepted.statusCode).toBe(200)
      expect((await apps[0].inject({ url: `${jobsURL}?include_steps=true`, headers })).json().jobs).toEqual([])
      expect((await pool.query('SELECT state FROM team_task_step_attempts WHERE attempt_id=$1', [source.attempt])).rows[0].state).toBe('accepted')
    } finally { await Promise.all(apps.map(app => app.close())) }
  })
  test('step wakeups are transactional and independent of the Inbox cursor and repeated migrations', async () => {
    const f = await fixture(), repo = new StepWakeupRepository(pool)
    expect((await pool.query('SELECT * FROM team_step_wakeups WHERE task_id=$1', [f.task])).rows).toEqual([])
    await f.save()
    const generation = async () => (await pool.query('SELECT generation FROM team_step_wakeups WHERE task_id=$1', [f.task])).rows[0].generation
    expect(await generation()).toBe('1')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query("INSERT INTO team_delivery_outbox(event_id,task_id,kind,payload) VALUES($1,$2,'rollback_fixture','{}')", [randomUUID(), f.task])
      expect((await client.query('SELECT generation FROM team_step_wakeups WHERE task_id=$1', [f.task])).rows[0].generation).toBe('2')
      await client.query('ROLLBACK')
    } finally { client.release() }
    expect(await generation()).toBe('1')
    await pool.query("INSERT INTO team_delivery_outbox(event_id,task_id,kind,payload) VALUES($1,$2,'committed_fixture','{}')", [randomUUID(), f.task])
    expect(await generation()).toBe('2')
    await new TeamDeliveryProjector(pool).runOnce()
    expect((await pool.query('SELECT count(*)::int n FROM team_delivery_outbox WHERE task_id=$1 AND processed_at IS NULL', [f.task])).rows[0].n).toBe(0)
    expect(await generation()).toBe('2')
    const claim = await repo.claim([f.teamId]); expect(claim).not.toBeNull()
    await repo.processClaim(claim!, async () => 'no dispatch')
    await initTeamPlanSchema(pool)
    expect(await repo.claim([f.teamId])).toBeNull()
    expect(await generation()).toBe('2')
  })
  test('20 competing wakeup claim pairs produce one committed effect each with stale replay rejected', async () => {
    const f = await fixture(); await f.save()
    const a = new StepWakeupRepository(pool), b = new StepWakeupRepository(pool)
    const before = Number((await pool.query('SELECT revision FROM team_tasks WHERE task_id=$1', [f.task])).rows[0].revision)
    expect(await a.claim([])).toBeNull(); expect(await a.claim(['another-team'])).toBeNull()
    for (let i = 0; i < 20; i++) {
      if (i) await pool.query('SELECT signal_team_step_wakeup($1)', [f.task])
      const claims = await Promise.all([a.claim([f.teamId]), b.claim([f.teamId])])
      expect(claims.filter(Boolean)).toHaveLength(1)
      const claim = claims.find(Boolean)!
      await a.processClaim(claim, async client => { await client.query('UPDATE team_tasks SET revision=revision+1 WHERE task_id=$1', [f.task]) })
      await expect(b.processClaim(claim, async () => { throw Error('stale callback must not run') })).rejects.toBeInstanceOf(StepWakeupLeaseLost)
    }
    expect(Number((await pool.query('SELECT revision FROM team_tasks WHERE task_id=$1', [f.task])).rows[0].revision)).toBe(before + 20)
    expect(await b.claim([f.teamId])).toBeNull()
  })
  test('a newer signal during processing survives acknowledgement of the older generation', async () => {
    const f = await fixture(); await f.save()
    const repo = new StepWakeupRepository(pool), old = (await repo.claim([f.teamId]))!
    await repo.processClaim(old, async client => {
      await client.query('SELECT task_id FROM team_tasks WHERE task_id=$1 FOR UPDATE', [f.task])
      await pool.query('SELECT signal_team_step_wakeup($1)', [f.task])
    })
    const next = await repo.claim([f.teamId])
    expect(next?.generation).toBe(String(BigInt(old.generation) + 1n))
    expect(BigInt(next!.lease_token)).toBeGreaterThan(BigInt(old.lease_token))
    await repo.processClaim(next!, async () => undefined)
    expect(await repo.claim([f.teamId])).toBeNull()
  })
  test('three expired in-flight claims roll back effects after another worker acquires a newer fence', async () => {
    const f = await fixture(); await f.save()
    const repo = new StepWakeupRepository(pool)
    for (let i = 0; i < 3; i++) {
      if (i) await pool.query('SELECT signal_team_step_wakeup($1)', [f.task])
      const old = (await repo.claim([f.teamId]))!, before = (await pool.query('SELECT revision FROM team_tasks WHERE task_id=$1', [f.task])).rows[0].revision
      let replacement: StepWakeupClaim | null = null
      await expect(repo.processClaim(old, async client => {
        await client.query('UPDATE team_tasks SET revision=revision+1 WHERE task_id=$1', [f.task])
        await pool.query("UPDATE team_step_wakeups SET lease_until=clock_timestamp()-interval '1 second' WHERE task_id=$1", [f.task])
        replacement = await new StepWakeupRepository(pool).claim([f.teamId])
        expect(replacement).not.toBeNull()
      })).rejects.toBeInstanceOf(StepWakeupLeaseLost)
      expect((await pool.query('SELECT revision FROM team_tasks WHERE task_id=$1', [f.task])).rows[0].revision).toBe(before)
      expect(await repo.retry(old, 'retry_pending', 0)).toBe(false)
      await repo.processClaim(replacement!, async client => { await client.query('UPDATE team_tasks SET revision=revision+1 WHERE task_id=$1', [f.task]) })
      expect(Number((await pool.query('SELECT revision FROM team_tasks WHERE task_id=$1', [f.task])).rows[0].revision)).toBe(Number(before) + 1)
    }
  })
  test('three failed transactions keep pending work; retry backoff is interrupted by a new signal', async () => {
    const f = await fixture(); await f.save()
    const repo = new StepWakeupRepository(pool)
    for (let i = 0; i < 3; i++) {
      const claim = (await repo.claim([f.teamId]))!
      await expect(repo.processClaim(claim, async client => {
        await client.query("INSERT INTO team_delivery_outbox(event_id,task_id,kind,payload) VALUES($1,$2,'rolled_back_effect','{}')", [randomUUID(), f.task])
        throw Error('simulated consumer failure before commit')
      })).rejects.toThrow('simulated consumer failure')
      expect((await pool.query("SELECT count(*)::int n FROM team_delivery_outbox WHERE task_id=$1 AND kind='rolled_back_effect'", [f.task])).rows[0].n).toBe(0)
      expect(await repo.retry(claim, 'dependency_unavailable', 60_000)).toBe(true)
      expect(await repo.claim([f.teamId])).toBeNull()
      await pool.query('SELECT signal_team_step_wakeup($1)', [f.task])
    }
    const last = await repo.claim([f.teamId]); expect(last).not.toBeNull()
    await repo.processClaim(last!, async () => undefined)
    expect(await repo.claim([f.teamId])).toBeNull()
  })
  test('step Call transitions and attempts enqueue work without relying on a delivery event', async () => {
    const f = await fixture(), source = await preparedSource(f)
    const before = BigInt((await pool.query('SELECT generation FROM team_step_wakeups WHERE task_id=$1', [f.task])).rows[0].generation)
    await pool.query("UPDATE collaboration_calls SET state='failed' WHERE call_id=$1", [source.call])
    expect(BigInt((await pool.query('SELECT generation FROM team_step_wakeups WHERE task_id=$1', [f.task])).rows[0].generation)).toBe(before + 1n)
    await pool.query("UPDATE team_task_step_attempts SET state='unknown' WHERE attempt_id=$1", [source.attempt])
    expect(BigInt((await pool.query('SELECT generation FROM team_step_wakeups WHERE task_id=$1', [f.task])).rows[0].generation)).toBe(before + 2n)
  })
  async function activateFixture(f: Awaited<ReturnType<typeof fixture>>) {
    // Control-plane fixture only; no public activation or scheduler is enabled.
    await pool.query("INSERT INTO team_task_plan_runtime(task_id,plan_revision,state,initiator_user_id) VALUES($1,1,'active',$2)", [f.task, f.users[0]])
  }
  const complete = async (task: string) => (await pool.query('SELECT team_task_delivery_complete($1) allowed', [task])).rows[0].allowed
  test('an activated plan cannot complete through an accepted legacy head while required steps are missing', async () => {
    const f = await fixture(), source = await acceptedSource(f)
    // Deliberately seed a legacy head that would pass the old completion rule.
    await pool.query('UPDATE team_task_delivery_heads SET latest_submission_id=$2 WHERE task_id=$1', [f.task, source.submission])
    expect(await complete(f.task)).toBe(true)
    await activateFixture(f)
    expect(await complete(f.task)).toBe(false)
    await expect(requireTaskDeliveryComplete(pool, f.task)).rejects.toMatchObject({ code: 'acceptance_required' })
    await expect(pool.query("UPDATE team_tasks SET state='completed' WHERE task_id=$1", [f.task])).rejects.toMatchObject({ code: '23514', constraint: 'team_task_acceptance_required' })
  })
  test('all required steps suffice independently of legacy head; draft edits do not silently replace the active plan', async () => {
    const f = await fixture(); f.input.steps[1].required = false; f.input.steps[2].required = false
    await acceptedSource(f)
    expect(await complete(f.task)).toBe(false)
    await activateFixture(f)
    expect(await complete(f.task)).toBe(true)
    await pool.query("UPDATE team_task_plan_runtime SET state='paused' WHERE task_id=$1", [f.task])
    expect(await complete(f.task)).toBe(true)
    const next = structuredClone(f.input); next.request_id = 'add-required'; next.expected_revision = 1; next.steps[2].required = true
    await f.save(next)
    expect(await complete(f.task)).toBe(true)
    await pool.query("UPDATE team_tasks SET state='completed' WHERE task_id=$1", [f.task])
    await pool.query("UPDATE team_tasks SET state='in_progress' WHERE task_id=$1", [f.task])
    await pool.query('UPDATE team_task_plan_runtime SET plan_revision=2 WHERE task_id=$1', [f.task])
    expect(await complete(f.task)).toBe(false)
  })
  test('revoked accepted output or a newer failed attempt blocks whole-plan completion', async () => {
    const f = await fixture(); f.input.steps[1].required = false; f.input.steps[2].required = false
    const source = await acceptedSource(f); await activateFixture(f)
    expect(await complete(f.task)).toBe(true)
    await source.delivery.revokeArtifact(f.task, f.users[0], source.submission, 'proof', { request_id: 'revoke-complete', expected_revision: 3, reason: 'fixture revocation' })
    await expect(requireTaskDeliveryComplete(pool,f.task)).rejects.toMatchObject({code:'acceptance_required',message:'当前交付的必需附件或验收证据已撤销，无法完成任务。请重新提交有效附件并完成验收；历史验收记录仍保留。'})
    expect(await complete(f.task)).toBe(false)
    const other = await fixture(); other.input.steps[1].required = false; other.input.steps[2].required = false
    await acceptedSource(other); await activateFixture(other)
    expect(await complete(other.task)).toBe(true)
    await pool.query(`INSERT INTO team_task_step_attempts(attempt_id,task_id,plan_revision,step_id,attempt_no,state,frozen_inputs,input_hash)
      VALUES($1,$2,1,'implement',2,'failed','[]',$3)`, [randomUUID(), other.task, stableDigest([])])
    expect(await complete(other.task)).toBe(false)
  })
  test('cancelled runtime fails completion and repeated initialization preserves the plan guard', async () => {
    const f = await fixture(); f.input.steps[1].required = false; f.input.steps[2].required = false
    await acceptedSource(f); await activateFixture(f)
    expect(await complete(f.task)).toBe(true)
    await pool.query("UPDATE team_task_plan_runtime SET state='cancelled' WHERE task_id=$1", [f.task])
    expect(await complete(f.task)).toBe(false)
    await initTeamDeliverySchema(pool)
    expect(await complete(f.task)).toBe(false)
    await initDB(pool)
    expect(await complete(f.task)).toBe(false)
    await expect(pool.query("UPDATE team_tasks SET state='completed' WHERE task_id=$1", [f.task])).rejects.toMatchObject({ code: '23514' })
  })
  test('attempt numbers are unique across revisions of a stable step', async () => {
    const f = await fixture(); await f.save(); await insertReservedAttempt(f.task)
    await f.save({ ...f.input, request_id: 'same-steps-v2', expected_revision: 1 })
    await expect(pool.query(`INSERT INTO team_task_step_attempts(attempt_id,task_id,plan_revision,step_id,attempt_no,state,frozen_inputs,input_hash)
      VALUES($1,$2,2,'implement',1,'reserved','[]',$3)`, [randomUUID(), f.task, stableDigest([])])).rejects.toMatchObject({ code: '23505' })
  })
  async function controlFixture() {
    const f = await fixture(); await f.save()
    const call = (await pool.query('SELECT call_id FROM collaboration_calls WHERE task_id=$1', [f.task])).rows[0].call_id
    const dispatch = new TeamDispatchRepository(pool)
    expect(await dispatch.claim(call)).not.toBeNull()
    expect(await dispatch.bindNativeSession(call, f.daemon, f.users[0], `control-fixture-${randomUUID()}`)).toBe(true)
    await pool.query("UPDATE collaboration_calls SET state='completed',finished_at=NOW() WHERE call_id=$1", [call])
    // Only the fixture advertises this capability; real daemon activation is gated.
    await pool.query(`UPDATE daemons SET collaboration_capabilities=collaboration_capabilities||'["team_task_steps_v1"]'::jsonb WHERE daemon_id=$1`, [f.daemon])
    const controls = new TeamPlanExecutionService(pool, id => id === f.teamId)
    const activation: PlanControlInput = { request_id: 'activate', expected_revision: 0, plan_revision: 1, action: 'activate', invocation_limit: 3 }
    return { ...f, controls, activation, call }
  }
  async function schedulerFixture(customize?: (input: TaskPlanInput) => void, budget?: TaskBudgetPolicy, invocationLimit = 3) {
    const f = await controlFixture()
    f.activation.invocation_limit = invocationLimit
    if (customize) {
      const input = structuredClone(f.input); customize(input)
      await f.save({ ...input, request_id: 'scheduler-plan', expected_revision: 1 })
      f.activation.plan_revision = 2
    }
    if (budget) f.activation.budget = budget
    await f.controls.control(f.task, f.users[0], f.activation)
    const queue = new StepWakeupRepository(pool), scheduler = new TeamStepScheduler(pool, id => id === f.teamId)
    return { ...f, queue, scheduler, next: async () => {
      const claim = await queue.claim([f.teamId]); expect(claim).not.toBeNull()
      return scheduler.process(claim!)
    } }
  }
  async function acceptScheduled(f: Awaited<ReturnType<typeof schedulerFixture>>, result: Awaited<ReturnType<TeamStepScheduler['process']>>, decision: 'accepted' | 'changes_requested' | null = 'accepted') {
    const dispatch = await new TeamDispatchRepository(pool, undefined, id=>id===f.teamId).claim(result.call_id!)
    expect(dispatch).not.toBeNull()
    // Synthetic native completion. This validates the actual publication and
    // decision services, not a provider or end-to-end daemon execution.
    await pool.query("UPDATE collaboration_calls SET state='completed',finished_at=NOW() WHERE call_id=$1", [result.call_id])
    const delivery = new TeamDeliveryService(pool, { writesEnabledForTeam:()=>true,stepWritesEnabledForTeam:()=>true }).forAttempt(result.attempt_id!)
    const bytes=Buffer.from(`Frozen output ${result.attempt_id}`), spec=dispatch!.authorization.delivery!.spec_revision
    const prepared=await delivery.prepare(f.task,f.users[0],{request_id:`prepare-${result.attempt_id}`,expected_revision:1,spec_revision:spec,source_call_id:result.call_id!,summary:'Step result',code_revision:'fixture-v1',publish_scope:'team',contribution_ids:[],
      artifacts:[{id:'proof',name:'proof.md',mime_type:'text/markdown',byte_size:bytes.length,sha256:artifactDigest(bytes),required:true}],
      evidence:[{check_id:'unit',result:'passed',source_kind:'agent_claim',artifact_id:'proof',code_revision:'fixture-v1'}]})
    await delivery.uploadArtifact(f.task,f.users[0],prepared.submission_id,'proof',bytes)
    await delivery.publish(f.task,f.users[0],prepared.submission_id,{request_id:`publish-${result.attempt_id}`,expected_revision:1})
    if (decision) await delivery.decide(f.task,f.users[1],{request_id:`accept-${result.attempt_id}`,expected_revision:2,spec_revision:spec,submission_id:prepared.submission_id,decision,reason:decision==='accepted'?'':'Fix the result',verified_checks:decision==='accepted'?['unit']:[]})
    return {delivery,submission:prepared.submission_id,bytes}
  }
  test('requirements freeze per step and explicit retry without rewriting earlier native context', async () => {
    const f=await schedulerFixture(), tasks=new TeamTaskService(pool)
    const save=async(goal:string,key:string)=>{
      const task=await tasks.getTask(f.task,f.users[0])
      return tasks.updateRequirements({taskId:f.task,actorUserId:f.users[0],expectedRevision:task.revision,requestId:key,requirements:{goal,scope:'Step scope',acceptance:'Human review',repository:null}})
    }
    const content=async(call:string)=>(await pool.query('SELECT e.content FROM collaboration_calls c JOIN collaboration_events e USING(event_id) WHERE c.call_id=$1',[call])).rows[0].content
    await save('First snapshot','first-requirements')
    const first=await f.next(), old=await content(first.call_id!)
    expect(old).toContain('"goal":"First snapshot"')
    await save('Retry snapshot','retry-requirements')
    await pool.query("UPDATE collaboration_calls SET state='failed',finished_at=NOW() WHERE call_id=$1",[first.call_id])
    await f.controls.control(f.task,f.users[0],{request_id:'reconcile-req',action:'reconcile',expected_revision:1,plan_revision:1,attempt_id:first.attempt_id})
    const retry:PlanControlInput={request_id:'retry-req',action:'retry',expected_revision:2,plan_revision:1,attempt_id:first.attempt_id,expected_delivery_revision:1}
    const result=await f.controls.control(f.task,f.users[0],retry)
    expect(await content(result.recovery.call_id)).toContain('"goal":"Retry snapshot"')
    expect(await content(result.recovery.call_id)).toContain('"revision":2')
    expect(await content(first.call_id!)).toBe(old)
    await save('Later snapshot','later-requirements')
    expect(await f.controls.control(f.task,f.users[0],retry)).toEqual(result)
    expect(await content(result.recovery.call_id)).not.toContain('Later snapshot')
    await acceptScheduled(f,{state:'reserved',attempt_id:result.recovery.attempt_id,call_id:result.recovery.call_id})
    const next=await f.next()
    expect(next.state).toBe('reserved')
    expect(await content(next.call_id!)).toContain('"goal":"Later snapshot"')
    expect(await content(next.call_id!)).toContain('"revision":3')
  })
  test('three-step chain freezes exact accepted inputs and completes only after every required decision', async () => {
    const f=await schedulerFixture(), first=await f.next(), source=await acceptScheduled(f,first)
    const second=await f.next(); expect(second.state).toBe('reserved')
    const frozen=(await pool.query('SELECT frozen_inputs,input_hash FROM team_task_step_attempts WHERE attempt_id=$1',[second.attempt_id])).rows[0]
    expect(frozen.frozen_inputs).toHaveLength(1)
    expect(frozen.frozen_inputs[0]).toMatchObject({step_id:'implement',attempt_id:first.attempt_id,submission_id:source.submission,spec_revision:2,source_call_id:first.call_id,submission_version:1})
    expect(frozen.input_hash).toBe(stableDigest(frozen.frozen_inputs))
    await expect(requireTaskDeliveryComplete(pool,f.task)).rejects.toMatchObject({code:'acceptance_required'})
    await acceptScheduled(f,second)
    const third=await f.next(); expect(third.state).toBe('reserved')
    await acceptScheduled(f,third)
    await expect(requireTaskDeliveryComplete(pool,f.task)).resolves.toBeUndefined()
    expect(await f.next()).toEqual({state:'waiting'})
    expect((await pool.query('SELECT count(*)::int n FROM collaboration_calls WHERE task_id=$1',[f.task])).rows[0].n).toBe(4)
    expect((await pool.query('SELECT frozen_inputs FROM team_task_step_attempts WHERE attempt_id=$1',[second.attempt_id])).rows[0].frozen_inputs).toEqual(frozen.frozen_inputs)
  })
  test('input HTTP reads bind the exact dispatched Call, daemon and frozen bytes without creating work', async () => {
    const f=await schedulerFixture(), first=await f.next(), source=await acceptScheduled(f,first), second=await f.next()
    const inputs=new TeamStepInputService(pool)
    await expect(inputs.getManifest(second.call_id!,f.daemon,f.users[0])).rejects.toMatchObject({code:'team_not_found'})
    expect(await new TeamDispatchRepository(pool,undefined,()=>true).claim(second.call_id!)).not.toBeNull()
    const app=Fastify()
    registerTeamDeliveryRoutes(app,{service:new TeamDeliveryService(pool),stepInputs:inputs,verifyAccessToken:async token=>({userId:Number(token)}),getDatabaseReady:()=>true})
    const base=`/api/team/daemons/${f.daemon}/calls/${second.call_id}/step-inputs`,headers={authorization:`Bearer ${f.users[0]}`}
    const manifest=await app.inject({method:'GET',url:base,headers})
    expect(manifest.statusCode).toBe(200);expect(manifest.headers['cache-control']).toBe('no-store')
    expect(manifest.json()).toMatchObject({schema_version:1,call_id:second.call_id,attempt_id:second.attempt_id,task_id:f.task,spec_revision:3})
    expect(manifest.json().inputs[0]).toMatchObject({attempt_id:first.attempt_id,submission_id:source.submission})
    expect(artifactDigest(Buffer.from(manifest.json().inputs_json))).toBe(manifest.json().input_hash)
    expect(JSON.parse(manifest.json().inputs_json)).toEqual(manifest.json().inputs)
    const context=await new TeamContextDeliveryService(pool).prepare(second.call_id!)
    expect(context.step_input_hash).toBe(manifest.json().input_hash)
    expect(context.payload_hash).toBe(artifactDigest(Buffer.from(`${context.stable_text}\nstep-inputs:${context.step_input_hash}`)))
    expect(context.stable_text).toContain(`.pocketctl-inputs/${artifactDigest(Buffer.from(second.call_id!))}`)
    const url=`${base}/${first.attempt_id}/${source.submission}/artifacts/proof`
    const file=await app.inject({method:'GET',url,headers});expect(file.statusCode).toBe(200)
    expect(file.rawPayload.equals(source.bytes)).toBe(true);expect(file.headers['x-content-sha256']).toBe(artifactDigest(source.bytes))
    expect((await app.inject({method:'GET',url:base,headers:{authorization:`Bearer ${f.users[1]}`}})).statusCode).toBe(404)
    expect((await app.inject({method:'GET',url:base.replace(f.daemon,'wrong-daemon'),headers})).statusCode).toBe(404)
    expect((await app.inject({method:'GET',url:`${base}/${randomUUID()}/${source.submission}/artifacts/proof`,headers})).statusCode).toBe(404)
    expect((await app.inject({method:'GET',url:`${base}?latest=true`,headers})).statusCode).toBe(400)
    expect((await pool.query('SELECT count(*)::int n FROM collaboration_calls WHERE task_id=$1',[f.task])).rows[0].n).toBe(3)
    await source.delivery.revokeArtifact(f.task,f.users[0],source.submission,'proof',{request_id:'withdraw-after-reservation',expected_revision:3,reason:'withdrawn'})
    expect((await app.inject({method:'GET',url,headers})).statusCode).toBe(503)
    expect((await app.inject({method:'GET',url:base,headers})).statusCode).toBe(503)
    await app.close()
  })
  test('step input contention is retryable on the same Call, and history preserves only safe failure codes', async () => {
    const f=await schedulerFixture(), first=await f.next(), inputs=new TeamStepInputService(pool)
    expect(await new TeamDispatchRepository(pool,undefined,()=>true).claim(first.call_id!)).not.toBeNull()
    const holder=await pool.connect()
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT 1 FROM daemons WHERE daemon_id=$1 FOR UPDATE',[f.daemon])
      await expect(inputs.getManifest(first.call_id!,f.daemon,f.users[0])).rejects.toMatchObject({code:'source_busy'})
    } finally {await holder.query('ROLLBACK');holder.release()}
    expect((await inputs.getManifest(first.call_id!,f.daemon,f.users[0])).inputs).toEqual([])
    const attempt=(await pool.query('SELECT attempt_id FROM team_task_step_attempts WHERE call_id=$1',[first.call_id])).rows[0]
    const scoped=new TeamDeliveryService(pool,{writesEnabledForTeam:()=>true,attemptId:attempt.attempt_id})
    await pool.query("UPDATE collaboration_calls SET state='failed',outcome='delivery_http_503:source_busy' WHERE call_id=$1",[first.call_id])
    const history=await scoped.executionHistory(f.task,f.users[0])
    expect(history.executions[0].failure_code).toBe('delivery_http_503:source_busy')
    expect(history.executions[0]).not.toHaveProperty('outcome')
    await pool.query("UPDATE collaboration_calls SET outcome='private /home/file token=secret' WHERE call_id=$1",[first.call_id])
    expect((await scoped.executionHistory(f.task,f.users[0])).executions[0].failure_code).toBe('execution_failed')
  })
  test('step input access is rechecked after member removal and original Call uncertainty', async () => {
    const f=await schedulerFixture(), first=await f.next(), inputs=new TeamStepInputService(pool)
    expect(await new TeamDispatchRepository(pool,undefined,()=>true).claim(first.call_id!)).not.toBeNull()
    expect((await inputs.getManifest(first.call_id!,f.daemon,f.users[0])).inputs).toEqual([])
    await pool.query("UPDATE collaboration_calls SET state='uncertain' WHERE call_id=$1",[first.call_id])
    await expect(inputs.getManifest(first.call_id!,f.daemon,f.users[0])).rejects.toMatchObject({code:'team_not_found'})
    await pool.query("UPDATE collaboration_calls SET state='dispatched' WHERE call_id=$1",[first.call_id])
    await pool.query("UPDATE collaboration_team_memberships SET state='removed' WHERE team_id=$1 AND user_id=$2",[f.teamId,f.users[0]])
    await expect(inputs.getManifest(first.call_id!,f.daemon,f.users[0])).rejects.toMatchObject({code:'team_not_found'})
    expect((await pool.query('SELECT count(*)::int n FROM collaboration_calls WHERE task_id=$1',[f.task])).rows[0].n).toBe(2)
  })
  test('join waits for both branches; a busy binding never causes a second execution intent', async () => {
    const f=await schedulerFixture(input=>{input.steps[1].depends_on=[];input.steps[2].depends_on=['implement','review']})
    const first=await f.next(), busy=await f.queue.claim([f.teamId])
    await expect(f.scheduler.process(busy!)).rejects.toMatchObject({code:'agent_unavailable'})
    expect(await f.queue.retry(busy!,'retry_pending',0)).toBe(true)
    const left=await acceptScheduled(f,first), second=await f.next()
    expect((await pool.query('SELECT step_id,frozen_inputs FROM team_task_step_attempts WHERE attempt_id=$1',[second.attempt_id])).rows[0]).toMatchObject({step_id:'review',frozen_inputs:[]})
    expect(await f.next()).toEqual({state:'waiting'})
    const right=await acceptScheduled(f,second), join=await f.next()
    const inputs=(await pool.query('SELECT frozen_inputs FROM team_task_step_attempts WHERE attempt_id=$1',[join.attempt_id])).rows[0].frozen_inputs
    expect(inputs.map((i:any)=>i.submission_id).sort()).toEqual([left.submission,right.submission].sort())
  })
  test('revoked accepted input blocks downstream reservation without changing its historical decision', async () => {
    const f=await schedulerFixture(), first=await f.next(), source=await acceptScheduled(f,first)
    await source.delivery.revokeArtifact(f.task,f.users[0],source.submission,'proof',{request_id:'revoke-upstream',expected_revision:3,reason:'Source withdrawn'})
    await expect(f.next()).rejects.toMatchObject({code:'artifact_unavailable'})
    expect((await pool.query('SELECT count(*)::int n FROM team_task_step_attempts WHERE task_id=$1',[f.task])).rows[0].n).toBe(1)
    expect((await pool.query('SELECT decision FROM team_acceptance_decisions WHERE submission_id=$1',[source.submission])).rows[0].decision).toBe('accepted')
  })
  test.each(['offline','stale_config','config_disabled'])('a blocked %s optional branch does not starve an independent required branch', async scenario => {
    const f=await controlFixture(), otherOffer=`other-${randomUUID()}`, otherDaemon=`other-${randomUUID()}`
    await pool.query(`INSERT INTO daemons(daemon_id,hostname,status,user_id,agents,collaboration_capabilities)
      SELECT $1,'other-scheduler','online',user_id,agents,collaboration_capabilities FROM daemons WHERE daemon_id=$2`,[otherDaemon,f.daemon])
    await pool.query("INSERT INTO team_agent_offers(offer_id,team_id,owner_user_id,daemon_id,provider) VALUES($1,$2,$3,$4,'codex')",[otherOffer,f.teamId,f.users[0],otherDaemon])
    const sessions=new TeamSessionService(pool), revision=Number((await pool.query('SELECT revision FROM collaboration_sessions WHERE team_session_id=$1',[f.session.id])).rows[0].revision)
    await sessions.changeBinding({sessionId:f.session.id,actorUserId:f.users[0],offerId:otherOffer,active:true,expectedRevision:revision,requestId:'other-binding'})
    const plan=structuredClone(f.input);plan.steps[0].required=false;plan.steps[1].depends_on=[];plan.steps[1].review_policy.primary_offer_id=otherOffer
    await f.save({...plan,request_id:'independent-branches',expected_revision:1})
    await f.controls.control(f.task,f.users[0],{...f.activation,plan_revision:2})
    if(scenario==='offline') await pool.query("UPDATE daemons SET status='offline' WHERE daemon_id=$1",[f.daemon])
    else await pool.query("UPDATE collaboration_session_agent_bindings SET requested_config='{}',config_capability_revision='stale' WHERE team_session_id=$1 AND offer_id=$2",[f.session.id,f.offer])
    const before=(await pool.query('SELECT count(*)::int n FROM collaboration_events WHERE team_session_id=$1',[f.session.id])).rows[0].n
    const previous=process.env.TEAM_AGENT_CONFIG_V2
    try {
      if(scenario==='stale_config') {
        process.env.TEAM_AGENT_CONFIG_V2='on'
        const capability={schema_version:2,revision:'current-capability',models:[{id:'model-a',reasoning_efforts:[]}],permission_profiles:['request_approval'],default_config:{model:'model-a',reasoning_effort:null,permission_profile:'request_approval'},default_source:'local-settings',runtime_switch:'recreate',read_only:false}
        await pool.query(`UPDATE daemons SET agents=$2::jsonb,collaboration_capabilities=collaboration_capabilities||'["team_collaboration_config_v2"]'::jsonb WHERE daemon_id=$1`,[f.daemon,JSON.stringify([{type:'codex',manageable:true,team_config:capability}])])
        await expect(new TeamAgentConfigService(pool).freeze(pool,f.session.id,f.offer,f.users[0])).rejects.toMatchObject({code:'revision_conflict'})
      }
      if(scenario==='config_disabled') process.env.TEAM_AGENT_CONFIG_V2='off'
      const queue=new StepWakeupRepository(pool),scheduler=new TeamStepScheduler(pool,()=>true),claim=await queue.claim([f.teamId])
      const result=await scheduler.process(claim!)
      expect(result.state).toBe('reserved')
      expect((await pool.query('SELECT step_id FROM team_task_step_attempts WHERE attempt_id=$1',[result.attempt_id])).rows[0].step_id).toBe('review')
      expect((await pool.query('SELECT offer_id FROM collaboration_calls WHERE call_id=$1',[result.call_id])).rows[0].offer_id).toBe(otherOffer)
      expect((await pool.query('SELECT count(*)::int n FROM collaboration_events WHERE team_session_id=$1',[f.session.id])).rows[0].n).toBe(before+1)
    } finally { if(previous===undefined) delete process.env.TEAM_AGENT_CONFIG_V2;else process.env.TEAM_AGENT_CONFIG_V2=previous }

  })
  test('execution HTTP control, actor-scoped receipts and reads survive write rollback without new Calls', async () => {
    const f = await controlFixture()
    let enabled = true
    const execution = new TeamPlanExecutionService(pool, id => enabled && id === f.teamId)
    const app = Fastify()
    registerTeamPlanRoutes(app, { service: f.service, execution, getDatabaseReady: () => true,
      verifyAccessToken: async token => f.users.includes(Number(token)) ? { userId: Number(token) } : null })
    const url = `/api/team/tasks/${f.task}/plan/execution`
    const request = (method: 'GET' | 'POST', path = url, payload?: unknown, actor = f.users[0]) => app.inject({ method, url: path, headers: { authorization: `Bearer ${actor}` }, ...(payload === undefined ? {} : { payload: payload as any }) })
    try {
      expect((await request('GET')).json()).toMatchObject({ runtime: null, revision: 0, invocation_count: 0, execution_enabled: true, can_control: true })
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401)
      expect((await request('GET', `${url}?revision=1`)).statusCode).toBe(400)
      expect((await request('POST', url, {})).statusCode).toBe(400)
      expect((await request('POST', url, { ...f.activation, unexpected: true })).statusCode).toBe(400)
      expect((await request('POST', url, f.activation, f.users[1])).statusCode).toBe(403)
      const activated = await request('POST', url, f.activation)
      expect(activated.statusCode).toBe(200)
      expect(activated.json()).toMatchObject({ state: 'active', revision: 1, issued_calls_stopped: false })
      enabled = false
      expect((await request('POST', url, f.activation)).json()).toEqual(activated.json())
      expect((await request('GET', `${url}/receipt-lookup/${f.activation.request_id}`)).json()).toMatchObject({ found: true, response: activated.json() })
      expect((await request('GET', `${url}/receipt-lookup/${f.activation.request_id}`, undefined, f.users[1])).json()).toMatchObject({ found: false })
      expect((await request('GET', url, undefined, f.users[1])).json()).toMatchObject({ execution_enabled: false, can_control: false, runtime: { state: 'active' } })
      const pause = { request_id: 'api-pause', action: 'pause', expected_revision: 1, plan_revision: 1 }
      expect((await request('POST', url, pause)).json()).toMatchObject({ state: 'paused', revision: 2 })
      expect((await request('POST', url, { ...pause, request_id: 'api-resume', action: 'resume', expected_revision: 2 })).statusCode).toBe(503)
      expect((await request('POST', url, { ...pause, request_id: 'api-stale' })).statusCode).toBe(409)
      expect((await request('POST', url, { request_id: 'api-cancel', action: 'cancel', expected_revision: 2, plan_revision: 1 })).json()).toMatchObject({ state: 'cancelled', revision: 3 })
      expect((await request('GET')).headers['cache-control']).toBe('no-store')
      await pool.query("UPDATE collaboration_team_memberships SET state='removed' WHERE team_id=$1 AND user_id=$2", [f.teamId, f.users[1]])
      expect((await request('GET', url, undefined, f.users[1])).statusCode).toBe(404)
      expect((await request('GET', `${url}/receipt-lookup/${f.activation.request_id}`, undefined, f.users[1])).statusCode).toBe(404)
      expect((await pool.query('SELECT count(*)::int n FROM collaboration_calls WHERE task_id=$1', [f.task])).rows[0].n).toBe(1)
      expect((await pool.query('SELECT count(*)::int n FROM team_task_step_attempts WHERE task_id=$1', [f.task])).rows[0].n).toBe(0)
    } finally { await app.close() }
  })
  test('execution read projects exact attempts and bounded metadata with no file contents or lease secrets', async () => {
    const f = await schedulerFixture(), first = await f.next()
    await pool.query('UPDATE collaboration_calls SET outcome=$2 WHERE call_id=$1', [first.call_id, 'open /private/owner/work/secret.md: permission denied'])
    const execution = await f.controls.getExecution(f.task, f.users[1])
    expect(execution).toMatchObject({ revision: 1, invocation_count: 1, can_control: false, attempts: [{ attempt_id: first.attempt_id, call_id: first.call_id, step_id: 'implement', state: 'reserved', call_state: 'pending', input_source_count: 0, delivery_revision: 1 }] })
    expect(execution.attempts[0]).not.toHaveProperty('frozen_inputs')
    expect(execution.attempts[0]).not.toHaveProperty('lease_token')
    expect(execution.attempts[0]).not.toHaveProperty('call_outcome')
    expect(JSON.stringify(execution)).not.toContain('/private/owner')
    expect(execution.scheduler).not.toHaveProperty('lease_owner')
    expect((await pool.query('SELECT count(*)::int n FROM collaboration_calls WHERE task_id=$1', [f.task])).rows[0].n).toBe(2)
  })
  test('worker restart and lost notification recover one committed Call through the existing dispatcher', async () => {
    const f = await schedulerFixture()
    const makeWorker = () => new TeamStepWorker({ repository: new StepWakeupRepository(pool), scheduler: new TeamStepScheduler(pool, id => id === f.teamId), teamIds: () => [f.teamId], onCall: () => { throw Error('lost notification') } })
    expect(await makeWorker().runOnce()).toBe(true)
    const attempt = (await pool.query('SELECT attempt_id,call_id FROM team_task_step_attempts WHERE task_id=$1', [f.task])).rows[0]
    for (let i = 0; i < 3; i++) {
      await pool.query('SELECT signal_team_step_wakeup($1)', [f.task])
      expect(await makeWorker().runOnce()).toBe(true)
      expect((await pool.query('SELECT count(*)::int n FROM team_task_step_attempts WHERE task_id=$1', [f.task])).rows[0].n).toBe(1)
    }
    expect(await new TeamDispatchRepository(pool).listPendingCallIds()).not.toContain(attempt.call_id)
    const enabled = new TeamDispatchRepository(pool, undefined, id => id === f.teamId)
    expect(await enabled.listPendingCallIds()).toContain(attempt.call_id)
    expect(await enabled.claim(attempt.call_id)).not.toBeNull()
    expect(await enabled.claim(attempt.call_id)).toBeNull()
    expect((await pool.query('SELECT count(*)::int n FROM collaboration_calls WHERE task_id=$1', [f.task])).rows[0].n).toBe(2)
  })
  test('shared Session resume wakes a ready step after its paused wakeup was acknowledged', async () => {
    const f = await schedulerFixture()
    const worker = new TeamStepWorker({ repository: f.queue, scheduler: f.scheduler, teamIds: () => [f.teamId] })
    for (let i = 0; i < 3; i++) {
      await pool.query("UPDATE collaboration_sessions SET state='paused' WHERE team_session_id=$1", [f.session.id])
      expect(await worker.runOnce()).toBe(true)
      expect(await worker.runOnce()).toBe(false)
      expect((await pool.query('SELECT count(*)::int n FROM team_task_step_attempts WHERE task_id=$1', [f.task])).rows[0].n).toBe(0)
      await pool.query("UPDATE collaboration_sessions SET state='active' WHERE team_session_id=$1", [f.session.id])
    }
    const restarted = new TeamStepWorker({ repository: new StepWakeupRepository(pool), scheduler: new TeamStepScheduler(pool, () => true), teamIds: () => [f.teamId] })
    expect(await restarted.runOnce()).toBe(true)
    expect((await pool.query('SELECT count(*)::int n FROM team_task_step_attempts WHERE task_id=$1', [f.task])).rows[0].n).toBe(1)
  })
  test('worker dependency backoff is durable and a new signal resumes the same work', async () => {
    const f = await schedulerFixture()
    await pool.query("UPDATE daemons SET status='offline' WHERE daemon_id=$1", [f.daemon])
    const worker = new TeamStepWorker({ repository: f.queue, scheduler: f.scheduler, teamIds: () => [f.teamId] })
    expect(await worker.runOnce()).toBe(true)
    expect((await pool.query('SELECT last_error_code FROM team_step_wakeups WHERE task_id=$1', [f.task])).rows[0].last_error_code).toBe('dependency_unavailable')
    expect(await worker.runOnce()).toBe(false)
    expect((await pool.query('SELECT count(*)::int n FROM team_task_step_attempts WHERE task_id=$1', [f.task])).rows[0].n).toBe(0)
    await pool.query("UPDATE daemons SET status='online' WHERE daemon_id=$1", [f.daemon])
    await pool.query('SELECT signal_team_step_wakeup($1)', [f.task])
    expect(await worker.runOnce()).toBe(true)
    expect((await pool.query('SELECT count(*)::int n FROM team_task_step_attempts WHERE task_id=$1', [f.task])).rows[0].n).toBe(1)
  })
  test('scheduler reserves one ordinary Call and scoped spec atomically; duplicate wakeups never repeat it', async () => {
    const f = await schedulerFixture(), first = await f.next()
    expect(first.state).toBe('reserved')
    expect((await pool.query('SELECT state,attempt_no,frozen_inputs,input_hash FROM team_task_step_attempts WHERE attempt_id=$1', [first.attempt_id])).rows[0]).toMatchObject({ state: 'reserved', attempt_no: 1, frozen_inputs: [], input_hash: stableDigest([]) })
    expect((await pool.query('SELECT spec_revision FROM team_step_delivery_heads WHERE attempt_id=$1', [first.attempt_id])).rows[0].spec_revision).toBe('2')
    for (let i=0;i<20;i++) {
      await pool.query('SELECT signal_team_step_wakeup($1)', [f.task])
      const claims = await Promise.all([f.queue.claim([f.teamId]), f.queue.claim([f.teamId])])
      expect(claims.filter(Boolean)).toHaveLength(1)
      expect(await f.scheduler.process(claims.find(Boolean)!)).toEqual({ state: 'waiting' })
    }
    expect((await pool.query('SELECT count(*)::int n FROM collaboration_calls WHERE task_id=$1', [f.task])).rows[0].n).toBe(2)
    expect((await pool.query('SELECT count(*)::int n FROM team_task_step_attempts WHERE task_id=$1', [f.task])).rows[0].n).toBe(1)
    expect(await new TeamDispatchRepository(pool).claim(first.call_id!)).toBeNull()
    expect((await pool.query('SELECT state FROM collaboration_calls WHERE call_id=$1', [first.call_id])).rows[0].state).toBe('pending')
    const dispatch = await new TeamDispatchRepository(pool, undefined, id => id===f.teamId).claim(first.call_id!)
    expect(dispatch?.authorization.delivery).toEqual({ task_id:f.task, spec_revision:2, attempt_id:first.attempt_id })
  })
  test('scheduler rechecks pause, authority and capability without reserving new work', async () => {
    const f = await schedulerFixture()
    await f.controls.control(f.task,f.users[0],{request_id:'pause-before-claim',expected_revision:1,plan_revision:1,action:'pause'})
    expect(await f.next()).toEqual({state:'inactive'})
    await f.controls.control(f.task,f.users[0],{request_id:'resume-before-revoke',expected_revision:2,plan_revision:1,action:'resume'})
    await pool.query("UPDATE collaboration_team_memberships SET role='viewer' WHERE team_id=$1 AND user_id=$2",[f.teamId,f.users[0]])
    const claim=await f.queue.claim([f.teamId]); await expect(f.scheduler.process(claim!)).rejects.toMatchObject({code:'creator_required'})
    expect(await f.queue.retry(claim!,'authorization_changed',0)).toBe(true)
    await pool.query("UPDATE collaboration_team_memberships SET role='admin' WHERE team_id=$1 AND user_id=$2",[f.teamId,f.users[0]])
    await pool.query("UPDATE daemons SET collaboration_capabilities=collaboration_capabilities-'team_task_steps_v1' WHERE daemon_id=$1",[f.daemon])
    await expect(f.next()).rejects.toMatchObject({code:'capability_not_supported'})
    expect((await pool.query('SELECT count(*)::int n FROM team_task_step_attempts WHERE task_id=$1',[f.task])).rows[0].n).toBe(0)
  })
  test.each(['pause', 'reservation'] as const)('pause/reservation lock boundary: %s wins before the other transaction', async first => {
    for (let round = 0; round < 3; round++) {
      const f = await schedulerFixture(), claim = await f.queue.claim([f.teamId])
      expect(claim).not.toBeNull()
      const gate = await pool.connect()
      const pending: Promise<unknown>[] = []
      try {
        await gate.query('BEGIN')
        await gate.query('SELECT 1 FROM collaboration_sessions WHERE team_session_id=$1 FOR UPDATE', [f.session.id])
        const pid = (await gate.query('SELECT pg_backend_pid() pid')).rows[0].pid
        const blocked = async (count: number) => {
          const deadline = Date.now() + 3000
          while (Date.now() < deadline) {
            // PostgreSQL may put the second waiter behind the first tuple
            // waiter rather than directly behind the gate transaction.
            const rows = await pool.query(`WITH RECURSIVE blocked(pid) AS (
              SELECT $1::integer UNION
              SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid=ANY(pg_blocking_pids(a.pid))
              WHERE a.datname=current_database() AND a.wait_event_type='Lock'
            ) SELECT pid FROM blocked WHERE pid<>$1`, [pid])
            if (rows.rowCount! >= count) return
            await new Promise(resolve => setTimeout(resolve, 10))
          }
          throw Error(`expected ${count} transactions waiting on the Session gate`)
        }
        const pause = () => f.controls.control(f.task, f.users[0], {
          request_id: `pause-reservation-${first}-${round}`, action: 'pause', expected_revision: 1, plan_revision: 1,
        })
        const reserve = () => f.scheduler.process(claim!)
        pending.push(first === 'pause' ? pause() : reserve())
        // Attach rejection handlers before observing the database barrier.
        void pending[0].catch(() => {})
        await blocked(1)
        pending.push(first === 'pause' ? reserve() : pause())
        void pending[1].catch(() => {})
        await blocked(2)
        await gate.query('COMMIT')
        const results = await Promise.all(pending)
        expect(results[first === 'pause' ? 0 : 1]).toMatchObject({ state: 'paused', issued_calls_stopped: false })
        expect(results[first === 'pause' ? 1 : 0]).toMatchObject({ state: first === 'pause' ? 'inactive' : 'reserved' })
        const attempts = (await pool.query('SELECT attempt_id,call_id FROM team_task_step_attempts WHERE task_id=$1', [f.task])).rows
        expect(attempts).toHaveLength(first === 'pause' ? 0 : 1)
        expect((await pool.query('SELECT count(*)::int n FROM collaboration_calls WHERE task_id=$1', [f.task])).rows[0].n).toBe(first === 'pause' ? 1 : 2)
        if (attempts.length) expect((await pool.query('SELECT state FROM collaboration_calls WHERE call_id=$1', [attempts[0].call_id])).rows[0].state).toBe('pending')
        await pool.query('SELECT signal_team_step_wakeup($1)', [f.task])
        expect(await f.next()).toEqual({ state: 'inactive' })
        expect((await pool.query('SELECT attempt_id,call_id FROM team_task_step_attempts WHERE task_id=$1', [f.task])).rows).toEqual(attempts)
      } finally {
        await gate.query('ROLLBACK'); gate.release()
        await Promise.allSettled(pending)
      }
    }
  })
  test('scheduler derives status from the original Call and never retries unknown or failed execution', async () => {
    const f=await schedulerFixture(), first=await f.next()
    for(const [callState,attemptState] of [['dispatched','dispatched'],['accepted','running'],['uncertain','unknown'],['failed','failed']]) {
      await pool.query('UPDATE collaboration_calls SET state=$2 WHERE call_id=$1',[first.call_id,callState])
      expect(await f.next()).toEqual({state:'reconciled'})
      expect((await pool.query('SELECT state FROM team_task_step_attempts WHERE attempt_id=$1',[first.attempt_id])).rows[0].state).toBe(attemptState)
      expect(await f.next()).toEqual({state:'waiting'})
    }
    expect((await pool.query('SELECT count(*)::int n FROM collaboration_calls WHERE task_id=$1',[f.task])).rows[0].n).toBe(2)
  })
  test('explicit retry preserves old inputs, charges a new attempt and replays one committed Call', async () => {
    const f = await schedulerFixture(), first = await f.next()
    await pool.query("UPDATE collaboration_calls SET state='failed',finished_at=NOW() WHERE call_id=$1", [first.call_id])
    const reconcile: PlanControlInput = { request_id:'reconcile-failure', action:'reconcile', expected_revision:1, plan_revision:1, attempt_id:first.attempt_id }
    expect(await f.controls.control(f.task,f.users[0],reconcile)).toMatchObject({revision:2,recovery:{call_id:first.call_id,attempt_state:'failed',new_call_created:false}})
    const old = (await pool.query('SELECT * FROM team_task_step_attempts WHERE attempt_id=$1',[first.attempt_id])).rows[0]
    const retry: PlanControlInput = {request_id:'retry-failure',action:'retry',expected_revision:2,plan_revision:1,attempt_id:first.attempt_id,expected_delivery_revision:1}
    const results = await Promise.all([f.controls.control(f.task,f.users[0],retry),f.controls.control(f.task,f.users[0],retry)])
    expect(results[0]).toEqual(results[1])
    expect(results[0]).toMatchObject({revision:3,recovery:{previous_attempt_id:first.attempt_id,attempt_state:'reserved'}})
    expect(results[0].recovery.call_id).not.toBe(first.call_id)
    expect((await pool.query('SELECT * FROM team_task_step_attempts WHERE attempt_id=$1',[first.attempt_id])).rows[0]).toEqual(old)
    expect((await pool.query('SELECT attempt_no,state FROM team_task_step_attempts WHERE task_id=$1 ORDER BY attempt_no',[f.task])).rows).toEqual([{attempt_no:1,state:'failed'},{attempt_no:2,state:'reserved'}])
    const disabled = new TeamPlanExecutionService(pool)
    expect(await disabled.control(f.task,f.users[0],retry)).toEqual(results[0])
    expect(await disabled.lookupReceipt(f.task,f.users[0],retry.request_id)).toMatchObject({found:true,response:results[0]})
    await expect(disabled.control(f.task,f.users[0],{...retry,request_id:'retry-disabled',expected_revision:3})).rejects.toMatchObject({code:'team_feature_disabled'})
    await expect(f.controls.control(f.task,f.users[0],{...retry,request_id:'retry-stale',expected_revision:3})).rejects.toMatchObject({code:'revision_conflict'})
    const next = results[0].recovery
    await pool.query("UPDATE collaboration_calls SET state='failed',finished_at=NOW() WHERE call_id=$1",[next.call_id])
    await f.controls.control(f.task,f.users[0],{...reconcile,request_id:'reconcile-second',expected_revision:3,attempt_id:next.attempt_id})
    const third = await f.controls.control(f.task,f.users[0],{...retry,request_id:'retry-second',expected_revision:4,attempt_id:next.attempt_id})
    await pool.query("UPDATE collaboration_calls SET state='failed',finished_at=NOW() WHERE call_id=$1",[third.recovery.call_id])
    await f.controls.control(f.task,f.users[0],{...reconcile,request_id:'reconcile-third',expected_revision:5,attempt_id:third.recovery.attempt_id})
    await expect(f.controls.control(f.task,f.users[0],{...retry,request_id:'retry-exhausted',expected_revision:6,attempt_id:third.recovery.attempt_id})).rejects.toMatchObject({code:'budget_exhausted'})
    expect((await f.controls.getExecution(f.task,f.users[0])).invocation_count).toBe(3)
    expect((await pool.query('SELECT count(*)::int n FROM collaboration_calls WHERE task_id=$1',[f.task])).rows[0].n).toBe(4)
  })
  test('unknown reconciliation preserves original Call with flags off and cannot authorize a retry', async () => {
    const f = await schedulerFixture(), first = await f.next()
    const retry: PlanControlInput = {request_id:'retry-unknown',action:'retry',expected_revision:1,plan_revision:1,attempt_id:first.attempt_id,expected_delivery_revision:1}
    for (const state of ['pending','dispatched','accepted','uncertain']) {
      await pool.query('UPDATE collaboration_calls SET state=$2 WHERE call_id=$1',[first.call_id,state])
      await expect(f.controls.control(f.task,f.users[0],retry)).rejects.toMatchObject({code:'invalid_state'})
    }
    const disabled = new TeamPlanExecutionService(pool)
    const reconcile: PlanControlInput = {request_id:'query-original',action:'reconcile',expected_revision:1,plan_revision:1,attempt_id:first.attempt_id}
    const unknown = await disabled.control(f.task,f.users[0],reconcile)
    expect(unknown).toMatchObject({recovery:{call_id:first.call_id,call_state:'uncertain',attempt_state:'unknown',new_call_created:false}})
    expect(await disabled.control(f.task,f.users[0],reconcile)).toEqual(unknown)
    await disabled.control(f.task,f.users[0],{request_id:'cancel-unknown',action:'cancel',expected_revision:2,plan_revision:1})
    await pool.query("UPDATE collaboration_calls SET state='completed',finished_at=NOW() WHERE call_id=$1",[first.call_id])
    expect(await disabled.control(f.task,f.users[0],{...reconcile,request_id:'query-terminal',expected_revision:3})).toMatchObject({state:'cancelled',recovery:{attempt_state:'awaiting_review',call_state:'completed',new_call_created:false}})
    expect((await pool.query('SELECT count(*)::int n FROM collaboration_calls WHERE task_id=$1',[f.task])).rows[0].n).toBe(2)
  })
  test('retry and pause share a transaction boundary and authorization failures create no Call', async () => {
    const f=await schedulerFixture(), first=await f.next()
    await pool.query("UPDATE collaboration_calls SET state='cancelled',finished_at=NOW() WHERE call_id=$1",[first.call_id])
    await f.next()
    const retry:PlanControlInput={request_id:'retry-cancelled',action:'retry',expected_revision:1,plan_revision:1,attempt_id:first.attempt_id,expected_delivery_revision:1}
    await expect(f.controls.control(f.task,f.users[1],retry)).rejects.toMatchObject({code:'creator_required'})
    await expect(f.controls.control(f.task,f.users[0],{...retry,expected_delivery_revision:2})).rejects.toMatchObject({code:'revision_conflict'})
    const race=await Promise.allSettled([f.controls.control(f.task,f.users[0],retry),f.controls.control(f.task,f.users[0],{request_id:'pause-retry-race',action:'pause',expected_revision:1,plan_revision:1})])
    expect(race.filter(r=>r.status==='fulfilled')).toHaveLength(1)
    expect((race.find(r=>r.status==='rejected') as PromiseRejectedResult).reason).toMatchObject({code:'revision_conflict'})
    const execution=await f.controls.getExecution(f.task,f.users[0])
    expect(execution.invocation_count).toBe(execution.runtime!.state==='paused'?1:2)
    if(execution.runtime!.state==='paused') await expect(f.controls.control(f.task,f.users[0],{...retry,request_id:'retry-paused',expected_revision:2})).rejects.toMatchObject({code:'invalid_state'})
  })
  test('retry revalidates frozen input availability and does not overwrite the failed snapshot', async () => {
    const f=await schedulerFixture(),first=await f.next(),source=await acceptScheduled(f,first),second=await f.next()
    await pool.query("UPDATE collaboration_calls SET state='failed',finished_at=NOW() WHERE call_id=$1",[second.call_id])
    await f.next()
    const old=(await pool.query('SELECT frozen_inputs,input_hash FROM team_task_step_attempts WHERE attempt_id=$1',[second.attempt_id])).rows[0]
    await source.delivery.revokeArtifact(f.task,f.users[0],source.submission,'proof',{request_id:'revoke-before-retry',expected_revision:3,reason:'fixture revocation'})
    await expect(f.controls.control(f.task,f.users[0],{request_id:'retry-revoked-input',action:'retry',expected_revision:1,plan_revision:1,attempt_id:second.attempt_id,expected_delivery_revision:1})).rejects.toMatchObject({code:'artifact_unavailable'})
    expect((await pool.query('SELECT frozen_inputs,input_hash FROM team_task_step_attempts WHERE attempt_id=$1',[second.attempt_id])).rows[0]).toEqual(old)
    expect((await f.controls.getExecution(f.task,f.users[0])).invocation_count).toBe(2)
  })
  test('new accepted version preserves old acceptance and reserves only one successor under 20 competing controls', async () => {
    const f = await schedulerFixture(undefined, undefined, 8), first = await f.next(), source = await acceptScheduled(f, first)
    const before = (await pool.query('SELECT * FROM team_task_step_attempts WHERE attempt_id=$1', [first.attempt_id])).rows[0]
    const input = { action: 'new_version', expected_revision: 1, plan_revision: 1, attempt_id: first.attempt_id,
      expected_delivery_revision: 3, reason: 'Produce a new accepted version without rewriting the prior result.' }
    const requests = Array.from({ length: 20 }, (_, i) => ({ ...input, request_id: `new-version-${i}` } as PlanControlInput))
    const results = await Promise.allSettled(requests.map(r => f.controls.control(f.task, f.users[0], r)))
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    for (const result of results.filter(r => r.status === 'rejected') as PromiseRejectedResult[]) expect(result.reason.code).toBe('revision_conflict')
    const winner = results.findIndex(r => r.status === 'fulfilled'), result = (results[winner] as PromiseFulfilledResult<any>).value
    expect(await f.controls.control(f.task, f.users[0], requests[winner])).toEqual(result)
    expect((await pool.query('SELECT * FROM team_task_step_attempts WHERE attempt_id=$1', [first.attempt_id])).rows[0]).toEqual(before)
    expect((await f.controls.getExecution(f.task, f.users[0])).invocation_count).toBe(2)
    const message = (await pool.query('SELECT e.content FROM collaboration_calls c JOIN collaboration_events e ON e.event_id=c.event_id WHERE c.call_id=$1', [result.recovery.call_id])).rows[0].content
    expect(message).toContain(input.reason); expect(message).toContain(source.submission)
    expect(result.recovery.previous_attempt_id).toBe(first.attempt_id)
    expect(await new TeamPlanExecutionService(pool).control(f.task, f.users[0], requests[winner])).toEqual(result)
    await expect(f.controls.control(f.task, f.users[0], { ...requests[winner], request_id: 'stale-accepted-source', expected_revision: 2 })).rejects.toMatchObject({ code: 'revision_conflict' })
  })

  test('new accepted version requires exact revision, control authority and nonempty explanation without weakening retry', async () => {
    const f = await schedulerFixture(), first = await f.next(); await acceptScheduled(f, first)
    const input: PlanControlInput = { request_id: 'new-version-guard', action: 'new_version', expected_revision: 1,
      plan_revision: 1, attempt_id: first.attempt_id, expected_delivery_revision: 3, reason: 'Explicit successor' }
    for (const reason of [undefined, '', ' ', 'x'.repeat(1001)]) {
      await expect(f.controls.control(f.task, f.users[0], { ...input, reason })).rejects.toMatchObject({ code: 'invalid_request' })
    }
    await expect(f.controls.control(f.task, f.users[1], input)).rejects.toMatchObject({ code: 'creator_required' })
    await expect(f.controls.control(f.task, f.users[0], { ...input, expected_delivery_revision: 2 })).rejects.toMatchObject({ code: 'revision_conflict' })
    await expect(new TeamPlanExecutionService(pool).control(f.task, f.users[0], input)).rejects.toMatchObject({ code: 'team_feature_disabled' })
    await expect(f.controls.control(f.task, f.users[0], { ...input, action: 'retry', reason: undefined })).rejects.toMatchObject({ code: 'invalid_state' })
    await f.controls.control(f.task, f.users[0], { request_id: 'pause-before-new-version', action: 'pause', expected_revision: 1, plan_revision: 1 })
    await expect(f.controls.control(f.task, f.users[0], { ...input, expected_revision: 2 })).rejects.toMatchObject({ code: 'invalid_state' })
    expect((await f.controls.getExecution(f.task, f.users[0])).invocation_count).toBe(1)
  })

  test('new accepted version cannot reset the original exhausted invocation budget', async () => {
    const f = await schedulerFixture(plan => { plan.steps = plan.steps.slice(0, 1) }, undefined, 1)
    const first = await f.next(); await acceptScheduled(f, first)
    await expect(f.controls.control(f.task, f.users[0], { request_id: 'new-version-exhausted', action: 'new_version',
      expected_revision: 1, plan_revision: 2, attempt_id: first.attempt_id, expected_delivery_revision: 3, reason: 'New work consumes budget' })).rejects.toMatchObject({ code: 'budget_exhausted' })
    expect((await f.controls.getExecution(f.task, f.users[0])).invocation_count).toBe(1)
  })

  test('new accepted upstream version leaves existing downstream frozen and explicit downstream retry adopts the successor', async () => {
    const f = await schedulerFixture(undefined, undefined, 8), first = await f.next()
    const old = await acceptScheduled(f, first), downstream = await f.next()
    const frozen = (await pool.query('SELECT frozen_inputs,input_hash FROM team_task_step_attempts WHERE attempt_id=$1', [downstream.attempt_id])).rows[0]
    expect(frozen.frozen_inputs[0].submission_id).toBe(old.submission)
    await acceptScheduled(f, downstream, 'changes_requested')
    const successor = await f.controls.control(f.task, f.users[0], { request_id: 'upstream-successor', action: 'new_version',
      expected_revision: 1, plan_revision: 1, attempt_id: first.attempt_id, expected_delivery_revision: 3, reason: 'Produce the next upstream version.' } as PlanControlInput)
    const next = await acceptScheduled(f, { state: 'reserved', ...successor.recovery })
    expect((await pool.query('SELECT frozen_inputs,input_hash FROM team_task_step_attempts WHERE attempt_id=$1', [downstream.attempt_id])).rows[0]).toEqual(frozen)
    const retried = await f.controls.control(f.task, f.users[0], { request_id: 'downstream-adopt', action: 'retry',
      expected_revision: 2, plan_revision: 1, attempt_id: downstream.attempt_id, expected_delivery_revision: 3 })
    const newInputs = (await pool.query('SELECT frozen_inputs FROM team_task_step_attempts WHERE attempt_id=$1', [retried.recovery.attempt_id])).rows[0].frozen_inputs
    expect(newInputs[0].submission_id).toBe(next.submission)
    expect(newInputs[0].attempt_id).toBe(successor.recovery.attempt_id)
    expect((await f.controls.getExecution(f.task, f.users[0])).invocation_count).toBe(4)
  })

  test('changes-requested retry closes superseded writes while preserving delivery receipts and revocation', async () => {
    const f=await schedulerFixture(),first=await f.next(),source=await acceptScheduled(f,first,'changes_requested')
    const retry:PlanControlInput={request_id:'retry-review',action:'retry',expected_revision:1,plan_revision:1,attempt_id:first.attempt_id,expected_delivery_revision:3}
    const second=await f.controls.control(f.task,f.users[0],retry)
    expect(second).toMatchObject({recovery:{previous_attempt_id:first.attempt_id,attempt_state:'reserved'}})
    const message=(await pool.query('SELECT e.content FROM collaboration_calls c JOIN collaboration_events e ON e.event_id=c.event_id WHERE c.call_id=$1',[second.recovery.call_id])).rows[0].content
    expect(message).toContain('Fix the result');expect(message).toContain(source.submission)
    expect(await source.delivery.publish(f.task,f.users[0],source.submission,{request_id:`publish-${first.attempt_id}`,expected_revision:1})).toMatchObject({submission_id:source.submission,state:'published'})
    await expect(source.delivery.decide(f.task,f.users[1],{request_id:'late-review',expected_revision:3,spec_revision:2,submission_id:source.submission,decision:'accepted',reason:'',verified_checks:['unit']})).rejects.toMatchObject({code:'invalid_state'})
    await source.delivery.revokeArtifact(f.task,f.users[0],source.submission,'proof',{request_id:'old-revoke',expected_revision:3,reason:'retain historical revocation authority'})
    const old=await source.delivery.getDelivery(f.task,f.users[0])
    expect(old.writes_enabled).toBe(false)
    expect(old.submissions[0]).toMatchObject({decision:'changes_requested',revoked_artifact_ids:['proof']})
    expect((await pool.query('SELECT attempt_no FROM team_task_step_attempts WHERE attempt_id=$1',[second.recovery.attempt_id])).rows[0].attempt_no).toBe(2)
  })
  test('recovery HTTP validates exact scope, protects receipts and bounds conflicting original Call locks', async () => {
    const f=await schedulerFixture(),first=await f.next(),app=Fastify()
    registerTeamPlanRoutes(app,{service:f.service,execution:f.controls,getDatabaseReady:()=>true,verifyAccessToken:async token=>({userId:Number(token)})})
    const url=`/api/team/tasks/${f.task}/plan/execution`
    const post=(payload:unknown,actor=f.users[0])=>app.inject({method:'POST',url,headers:{authorization:`Bearer ${actor}`},payload:payload as any})
    const query:PlanControlInput={request_id:'http-reconcile',action:'reconcile',expected_revision:1,plan_revision:1,attempt_id:first.attempt_id}
    try {
      expect((await post({...query,attempt_id:'not-a-uuid'})).statusCode).toBe(400)
      expect((await post({...query,action:'retry'})).statusCode).toBe(400)
      expect((await post({...query,expected_delivery_revision:1})).statusCode).toBe(400)
      expect((await post({...query,attempt_id:randomUUID()})).statusCode).toBe(404)
      expect((await post(query,f.users[1])).statusCode).toBe(403)
      const projection=await pool.connect()
      try {
        await projection.query('BEGIN')
        await projection.query('SELECT 1 FROM collaboration_calls WHERE call_id=$1 FOR UPDATE',[first.call_id])
        const busy=await post(query)
        expect(busy.statusCode).toBe(409);expect(busy.json()).toMatchObject({error:{code:'source_busy'}})
        await projection.query('SELECT 1 FROM collaboration_sessions WHERE team_session_id=$1 FOR UPDATE NOWAIT',[f.session.id])
      } finally {await projection.query('ROLLBACK');projection.release()}
      const result=await post(query)
      expect(result.statusCode).toBe(200);expect(result.json()).toMatchObject({recovery:{call_id:first.call_id,new_call_created:false}})
      expect((await post({...query,action:'retry',expected_delivery_revision:1})).json()).toMatchObject({error:{code:'idempotency_conflict'}})
      expect((await pool.query('SELECT count(*)::int n FROM collaboration_calls WHERE task_id=$1',[f.task])).rows[0].n).toBe(2)
    } finally {await app.close()}
  })
  test('resolve-task returns exact scoped facts and safe diagnostics without mutating Calls or wakeups', async () => {
    const f=await schedulerFixture(),first=await f.next(),source=await acceptScheduled(f,first),second=await f.next()
    const service=new TeamTaskContextService(pool)
    const counts=async()=>(await pool.query(`SELECT (SELECT count(*)::int FROM collaboration_calls WHERE task_id=$1) calls,
      (SELECT count(*)::int FROM team_delivery_outbox WHERE task_id=$1) outbox,
      (SELECT generation FROM team_step_wakeups WHERE task_id=$1) generation`,[f.task])).rows[0]
    const before=await counts()
    const root=await service.resolve(f.task,f.users[1])
    expect(root).toMatchObject({read_only:true,new_call_created:false,scope:'task',spec:{revision:1,goal:'Plan fixture'},invocation_count:2})
    expect(root.diagnostics).toContainEqual({code:'dependency_waiting',action:'inspect_upstream_acceptance'})
    const context=await service.resolve(f.task,f.users[1],second.attempt_id)
    expect(context).toMatchObject({scope:'attempt',spec:{revision:3,goal:'Do review'},attempt:{attempt_id:second.attempt_id,step_id:'review'},inputs:[{attempt_id:first.attempt_id,submission_id:source.submission,artifacts:[{id:'proof',revoked:false}]}]})
    expect(JSON.stringify(context)).not.toContain('frozen_inputs');expect(JSON.stringify(context)).not.toContain('native_session_id')
    expect(await counts()).toEqual(before)
    await pool.query("UPDATE collaboration_calls SET state='uncertain',outcome='/private/secret/project' WHERE call_id=$1",[second.call_id])
    const unknown=await service.resolve(f.task,f.users[0],second.attempt_id)
    expect(unknown.diagnostics).toContainEqual({code:'original_call_unknown',action:'reconcile_original_call'})
    expect(JSON.stringify(unknown)).not.toContain('/private/secret')
    await source.delivery.revokeArtifact(f.task,f.users[0],source.submission,'proof',{request_id:'resolve-revoke',expected_revision:3,reason:'fixture'})
    expect((await service.resolve(f.task,f.users[1],second.attempt_id)).diagnostics).toContainEqual({code:'input_revoked',action:'review_source_revocation'})
    const foreign=await fixture()
    await expect(service.resolve(foreign.task,f.users[0])).rejects.toMatchObject({code:'team_not_found'})
    await expect(service.resolve(f.task,f.users[1],randomUUID())).rejects.toMatchObject({code:'team_not_found'})
    await pool.query("UPDATE collaboration_team_memberships SET state='removed' WHERE team_id=$1 AND user_id=$2",[f.teamId,f.users[1]])
    await expect(service.resolve(f.task,f.users[1],second.attempt_id)).rejects.toMatchObject({code:'team_not_found'})
  })
  test('resolve-task HTTP rejects ambiguous queries and native snapshots are fixed to the authorized Call', async () => {
    const f=await schedulerFixture(),first=await f.next(),context=new TeamTaskContextService(pool),inputs=new TeamStepInputService(pool)
    expect(await new TeamDispatchRepository(pool,undefined,()=>true).claim(first.call_id!)).not.toBeNull()
    const before=await inputs.getManifest(first.call_id!,f.daemon,f.users[0])
    expect(JSON.parse(before.task_context_json)).toMatchObject({schema_version:1,read_only:true,task_id:f.task,call_id:first.call_id,attempt_id:first.attempt_id,spec_revision:2,step_id:'implement',input_hash:before.input_hash})
    expect(JSON.parse(before.task_context_json).instruction).toContain('Do implement')
    await f.controls.control(f.task,f.users[0],{request_id:'pause-context-read',action:'pause',expected_revision:1,plan_revision:1})
    expect((await inputs.getManifest(first.call_id!,f.daemon,f.users[0])).task_context_json).toBe(before.task_context_json)
    await expect(inputs.getManifest(first.call_id!,'wrong-daemon',f.users[0])).rejects.toMatchObject({code:'team_not_found'})
    await pool.query("UPDATE collaboration_session_participants SET state='removed' WHERE team_session_id=$1 AND user_id=$2",[f.session.id,f.users[0]])
    await expect(inputs.getManifest(first.call_id!,f.daemon,f.users[0])).rejects.toMatchObject({code:'team_not_found'})
    const app=Fastify()
    registerTeamPlanRoutes(app,{service:f.service,context,getDatabaseReady:()=>true,verifyAccessToken:async token=>({userId:Number(token)})})
    const url=`/api/team/tasks/${f.task}/context`
    const get=(suffix='')=>app.inject({method:'GET',url:url+suffix,headers:{authorization:`Bearer ${f.users[1]}`}})
    try {
      expect((await app.inject({method:'GET',url})).statusCode).toBe(401)
      expect((await get('?latest=true')).statusCode).toBe(400)
      expect((await get('?attempt_id=bad')).statusCode).toBe(400)
      const response=await get(`?attempt_id=${first.attempt_id}`)
      expect(response.statusCode).toBe(200);expect(response.headers['cache-control']).toBe('no-store')
      expect(response.json()).toMatchObject({attempt:{attempt_id:first.attempt_id},runtime:{state:'paused'},read_only:true})
      expect((await pool.query('SELECT count(*)::int n FROM collaboration_calls WHERE task_id=$1',[f.task])).rows[0].n).toBe(2)
    } finally {await app.close()}
  })
  async function evidenceFixture(kind: 'ci' | 'review' = 'ci') {
    const f=await schedulerFixture(),first=await f.next(),source=await acceptScheduled(f,first,null)
    const token='isolated-evidence-fixture-token-0123456789', connector={id:`connector-${randomUUID()}`,team_id:f.teamId,principal_user_id:f.users[0],kind,repository:'fixture/repository',checks:['unit'],token_sha256:artifactDigest(Buffer.from(token))}
    const service=new TeamEvidenceService(pool,[connector],()=>true),report=Buffer.from('trusted fixture report; no real external CI')
    const input:TrustedEvidenceInput={submission_id:source.submission,spec_revision:2,code_revision:'fixture-v1',repository:connector.repository,run_id:`run-${randomUUID()}`,check_id:'unit',result:'passed',report_base64:report.toString('base64'),report_sha256:artifactDigest(report),expires_at:new Date(Date.now()+60000).toISOString(),publish_scope:'team'}
    return {...f,first,source,connector,token,service,input,report,authorization:`Evidence ${token}`}
  }
  test('trusted evidence deduplicates callbacks, freezes exact code/report and invalidates stale review CAS', async () => {
    const f=await evidenceFixture()
    const received=await Promise.all([f.service.receive(f.task,f.connector.id,f.authorization,f.input),f.service.receive(f.task,f.connector.id,f.authorization,f.input)])
    expect(received[0]).toEqual(received[1]);expect(received[0]).toMatchObject({source_kind:'ci',human_acceptance_created:false,revision:3,report_sha256:f.input.report_sha256})
    const delivery=await f.source.delivery.getDelivery(f.task,f.users[1])
    expect(delivery.trusted_evidence).toMatchObject([{connector_id:f.connector.id,run_id:f.input.run_id,code_revision:'fixture-v1',result:'passed'}])
    expect(delivery.submissions[0].evidence[0].source_kind).toBe('agent_claim')
    expect((await pool.query('SELECT count(*)::int n FROM team_acceptance_decisions WHERE task_id=$1',[f.task])).rows[0].n).toBe(0)
    expect((await f.service.readReport(f.task,received[0].evidence_id,f.users[1])).bytes).toEqual(f.report)
    await expect(pool.query("UPDATE team_trusted_evidence SET result='failed' WHERE evidence_id=$1",[received[0].evidence_id])).rejects.toMatchObject({code:'23514'})
    await expect(f.service.receive(f.task,f.connector.id,f.authorization,{...f.input,result:'failed'})).rejects.toMatchObject({code:'idempotency_conflict'})
    const accept={request_id:'human-after-evidence',expected_revision:2,spec_revision:2,submission_id:f.source.submission,decision:'accepted' as const,reason:'',verified_checks:['unit']}
    await expect(f.source.delivery.decide(f.task,f.users[1],accept)).rejects.toMatchObject({code:'revision_conflict'})
    await f.source.delivery.decide(f.task,f.users[1],{...accept,expected_revision:3})
    const next=await f.next()
    const frozen=(await pool.query('SELECT frozen_inputs FROM team_task_step_attempts WHERE attempt_id=$1',[next.attempt_id])).rows[0].frozen_inputs[0]
    expect(frozen.trusted_evidence).toMatchObject([{evidence_id:received[0].evidence_id,report_sha256:f.input.report_sha256,code_revision:'fixture-v1'}])
    expect(frozen.trusted_evidence_sha256).toBe(stableDigest(frozen.trusted_evidence))
    expect((await new TeamTaskContextService(pool).resolve(f.task,f.users[1],f.first.attempt_id)).trusted_evidence).toMatchObject([{evidence_id:received[0].evidence_id}])
    await expect(f.service.receive(f.task,f.connector.id,f.authorization,{...f.input,run_id:'late-after-review'})).rejects.toMatchObject({code:'invalid_state'})
    const disabled=new TeamEvidenceService(pool,[f.connector])
    expect(await disabled.receive(f.task,f.connector.id,f.authorization,f.input)).toEqual(received[0])
    expect((await pool.query('SELECT count(*)::int n FROM team_trusted_evidence WHERE task_id=$1',[f.task])).rows[0].n).toBe(1)
  })
  test('trusted evidence rejects forged credentials, wrong scope/version, expired callbacks and revoked authority', async () => {
    const f=await evidenceFixture('review')
    for(const authorization of [undefined,`Bearer ${f.token}`,'Evidence wrong-token-with-at-least-thirty-two-characters']) await expect(f.service.receive(f.task,f.connector.id,authorization,f.input)).rejects.toMatchObject({code:'authorization_required'})
    for(const input of [{...f.input,code_revision:'other-code'},{...f.input,spec_revision:3}]) await expect(f.service.receive(f.task,f.connector.id,f.authorization,input)).rejects.toMatchObject({code:'revision_conflict'})
    for(const input of [{...f.input,repository:'other/repo'},{...f.input,check_id:'security'},{...f.input,expires_at:new Date(Date.now()-1000).toISOString()}]) await expect(f.service.receive(f.task,f.connector.id,f.authorization,input)).rejects.toMatchObject({code:'invalid_request'})
    await expect(f.service.receive(f.task,f.connector.id,f.authorization,{...f.input,report_sha256:'0'.repeat(64)})).rejects.toMatchObject({code:'artifact_integrity'})
    const foreign=await fixture()
    await expect(f.service.receive(foreign.task,f.connector.id,f.authorization,f.input)).rejects.toMatchObject({code:'team_not_found'})
    const receipt=await f.service.receive(f.task,f.connector.id,f.authorization,f.input)
    expect(receipt).toMatchObject({source_kind:'review',human_acceptance_created:false})
    expect((await pool.query('SELECT state FROM team_task_step_attempts WHERE attempt_id=$1',[f.first.attempt_id])).rows[0].state).toBe('awaiting_review')
    await pool.query("UPDATE collaboration_team_memberships SET role='member' WHERE team_id=$1 AND user_id=$2",[f.teamId,f.users[0]])
    await expect(f.service.receive(f.task,f.connector.id,f.authorization,f.input)).rejects.toMatchObject({code:'team_access_denied'})
    await expect(f.service.readReport(f.task,receipt.evidence_id,foreign.users[0])).rejects.toMatchObject({code:'team_not_found'})
  })
  test('trusted evidence HTTP works with the real Team JWT guard while ordinary JWT cannot attest', async () => {
    const f=await evidenceFixture(),app=Fastify()
    const verify=async(token:string)=>f.users.includes(Number(token))?{userId:Number(token)}:null
    registerTeamAccessGuard(app,{verifyAccessToken:verify,isTeamEnabled:async()=>true,getDatabaseReady:()=>true})
    registerTeamEvidenceRoutes(app,{service:f.service,verifyAccessToken:verify,getDatabaseReady:()=>true})
    const url=`/api/team-evidence/connectors/${f.connector.id}/tasks/${f.task}/reports`
    const post=(authorization=f.authorization,payload=f.input)=>app.inject({method:'POST',url,headers:{authorization},payload})
    try {
      expect((await post(`Bearer ${f.users[0]}`)).statusCode).toBe(401)
      const response=await post();expect(response.statusCode).toBe(200)
      const receipt=response.json(),path=`/api/team/tasks/${f.task}/trusted-evidence/${receipt.evidence_id}/report`
      expect((await app.inject({method:'GET',url:path,headers:{authorization:f.authorization}})).statusCode).toBe(401)
      const report=await app.inject({method:'GET',url:path,headers:{authorization:`Bearer ${f.users[1]}`}})
      expect(report.statusCode).toBe(200);expect(report.body).toBe(f.report.toString());expect(report.headers['x-content-sha256']).toBe(f.input.report_sha256)
      expect(report.headers['cache-control']).toBe('no-store');expect(report.headers['x-content-type-options']).toBe('nosniff')
      expect((await post()).json()).toEqual(receipt)
      expect((await pool.query('SELECT count(*)::int n FROM collaboration_calls WHERE task_id=$1',[f.task])).rows[0].n).toBe(2)
    } finally {await app.close()}
  })
  test('late trusted callbacks cannot replace a newer delivery and storage is bounded atomically', async () => {
    const f=await evidenceFixture(),bytes=Buffer.from('new delivery version')
    const prepared=await f.source.delivery.prepare(f.task,f.users[0],{request_id:'newer-proof-target',expected_revision:2,spec_revision:2,source_call_id:f.first.call_id!,summary:'New version',code_revision:'fixture-v2',publish_scope:'team',contribution_ids:[],artifacts:[{id:'proof',name:'proof.md',mime_type:'text/markdown',byte_size:bytes.length,sha256:artifactDigest(bytes),required:true}],evidence:[{check_id:'unit',result:'passed',source_kind:'agent_claim',artifact_id:'proof',code_revision:'fixture-v2'}]})
    await f.source.delivery.uploadArtifact(f.task,f.users[0],prepared.submission_id,'proof',bytes)
    await f.source.delivery.publish(f.task,f.users[0],prepared.submission_id,{request_id:'publish-newer-proof',expected_revision:2})
    await expect(f.service.receive(f.task,f.connector.id,f.authorization,f.input)).rejects.toMatchObject({code:'revision_conflict'})
    const input={...f.input,submission_id:prepared.submission_id,code_revision:'fixture-v2'}
    const large=Buffer.alloc(2*1024*1024,97)
    const largeInput={...input,report_base64:large.toString('base64'),report_sha256:artifactDigest(large)}
    await f.service.receive(f.task,f.connector.id,f.authorization,largeInput)
    // Remaining storage is seeded explicitly; the production receive path is
    // exercised at the exact limit and serializes competing writes under Task.
    await pool.query(`INSERT INTO team_trusted_evidence(evidence_id,task_id,submission_id,connector_id,connector_kind,repository,run_id,check_id,spec_revision,code_revision,result,report_sha256,report_bytes,request_hash,receipt)
      SELECT gen_random_uuid(),task_id,submission_id,connector_id,connector_kind,repository,'seed-'||i,check_id,spec_revision,code_revision,result,report_sha256,report_bytes,request_hash,receipt
      FROM team_trusted_evidence CROSS JOIN generate_series(1,15) i WHERE task_id=$1`,[f.task])
    await expect(f.service.receive(f.task,f.connector.id,f.authorization,{...input,run_id:'over-storage-limit'})).rejects.toMatchObject({code:'input_limit_exceeded'})
    const totals=(await pool.query('SELECT count(*)::int n,sum(octet_length(report_bytes))::bigint bytes FROM team_trusted_evidence WHERE task_id=$1',[f.task])).rows[0]
    expect(totals.n).toBe(16);expect(Number(totals.bytes)).toBe(32*1024*1024)
    expect((await pool.query('SELECT count(*)::int n FROM team_acceptance_decisions WHERE task_id=$1',[f.task])).rows[0].n).toBe(0)
  })
  test('connector principal deletion revokes future writes while shared evidence retains historical identity', async () => {
    const f=await evidenceFixture()
    await pool.query("UPDATE collaboration_team_memberships SET role='admin' WHERE team_id=$1 AND user_id=$2",[f.teamId,f.users[2]])
    const connector={...f.connector,principal_user_id:f.users[2]},service=new TeamEvidenceService(pool,[connector],()=>true)
    const receipt=await service.receive(f.task,connector.id,f.authorization,f.input)
    expect(receipt.principal_user_id).toBe(f.users[2])
    expect(await deleteUserAccount(pool,f.users[2])).toBe(true)
    await expect(service.receive(f.task,connector.id,f.authorization,f.input)).rejects.toMatchObject({code:'team_access_denied'})
    expect((await service.readReport(f.task,receipt.evidence_id,f.users[0])).bytes).toEqual(f.report)
    const history=(await f.source.delivery.getDelivery(f.task,f.users[0])).trusted_evidence
    expect(history).toMatchObject([{principal_user_id:f.users[2],connector_id:connector.id}])
  })
  test('activation HTTP receipts freeze optional budget and preserve it on resume and replay', async () => {
    const f=await controlFixture(), app=Fastify()
    registerTeamPlanRoutes(app,{service:f.service,execution:f.controls,verifyAccessToken:async token=>({userId:Number(token)}),getDatabaseReady:()=>true})
    const url=`/api/team/tasks/${f.task}/plan/execution`,headers={authorization:`Bearer ${f.users[0]}`}
    const budget={max_concurrent_calls:2,max_duration_seconds:3600,token_warning_limit:12000}
    const payload={...f.activation,budget}
    try {
      const activated=await app.inject({method:'POST',url,headers,payload})
      expect(activated.statusCode).toBe(200);expect(activated.json().budget).toEqual(budget)
      const before=(await f.controls.getExecution(f.task,f.users[0])).budget!
      expect(before.policy).toEqual(budget)
      const replay=await app.inject({method:'POST',url,headers,payload});expect(replay.json()).toEqual(activated.json())
      const lookup=await app.inject({method:'GET',url:url+'/receipt-lookup/activate',headers});expect(lookup.json().response).toEqual(activated.json())
      expect((await app.inject({method:'POST',url,headers,payload:{request_id:'pause',expected_revision:1,plan_revision:1,action:'pause'}})).json().budget).toEqual(budget)
      expect((await app.inject({method:'POST',url,headers,payload:{request_id:'reset',expected_revision:2,plan_revision:1,action:'resume',budget:{}}})).statusCode).toBe(400)
      expect((await app.inject({method:'POST',url,headers,payload:{request_id:'resume',expected_revision:2,plan_revision:1,action:'resume'}})).json().budget).toEqual(budget)
      const after=(await f.controls.getExecution(f.task,f.users[0])).budget!
      expect(after.policy).toEqual(before.policy);expect(after.started_at).toEqual(before.started_at)
      expect(after.invocation_count).toEqual(before.invocation_count)
      expect((await pool.query('SELECT count(*)::int n FROM collaboration_calls WHERE task_id=$1',[f.task])).rows[0].n).toBe(1)
    } finally { await app.close() }
  })
  test('plan concurrency budget counts uncertain reservations and cannot reset across pause or resume', async () => {
    const f=await schedulerFixture(input=>{input.steps[1].depends_on=[]},{max_concurrent_calls:1}),first=await f.next()
    const initial=(await f.controls.getExecution(f.task,f.users[0])).budget!
    expect(initial).toMatchObject({scope:'plan_attempts',policy:{max_concurrent_calls:1},invocation_count:1,in_flight:1,capabilities:{token_hard_limit:false}})
    const blocked=await f.queue.claim([f.teamId])
    await expect(f.scheduler.process(blocked!)).rejects.toMatchObject({code:'budget_exhausted'})
    await f.queue.retry(blocked!,'budget_exhausted',0)
    await pool.query("UPDATE collaboration_calls SET state='uncertain' WHERE call_id=$1",[first.call_id])
    await f.next() // Project unknown only, never another attempt.
    expect((await f.controls.getExecution(f.task,f.users[0])).budget!.in_flight).toBe(1)
    const unknown=await f.queue.claim([f.teamId]);await expect(f.scheduler.process(unknown!)).rejects.toMatchObject({code:'budget_exhausted'})
    await f.queue.retry(unknown!,'budget_exhausted',0)
    await f.controls.control(f.task,f.users[0],{request_id:'pause-budget',action:'pause',expected_revision:1,plan_revision:2})
    await expect(f.controls.control(f.task,f.users[0],{request_id:'reset-budget',action:'resume',expected_revision:2,plan_revision:2,budget:{max_concurrent_calls:2}})).rejects.toMatchObject({code:'invalid_request'})
    await f.controls.control(f.task,f.users[0],{request_id:'resume-budget',action:'resume',expected_revision:2,plan_revision:2})
    const resumed=(await f.controls.getExecution(f.task,f.users[0])).budget!
    expect(resumed.policy).toEqual(initial.policy);expect(resumed.started_at).toEqual(initial.started_at)
    await expect(pool.query("UPDATE team_task_plan_runtime SET budget_policy='{}' WHERE task_id=$1",[f.task])).rejects.toMatchObject({code:'23514'})
    await expect(pool.query('UPDATE team_task_plan_runtime SET invocation_limit=128 WHERE task_id=$1',[f.task])).rejects.toMatchObject({code:'23514'})
    expect((await pool.query('SELECT count(*)::int n FROM team_task_step_attempts WHERE task_id=$1',[f.task])).rows[0].n).toBe(1)
  })
  test('plan duration stops future reservations without claiming that an issued Call was cancelled', async () => {
    const f=await schedulerFixture(input=>{input.steps[1].depends_on=[]},{max_duration_seconds:1}),first=await f.next()
    await pool.query('SELECT pg_sleep(1.05)')
    const claim=await f.queue.claim([f.teamId])
    await expect(f.scheduler.process(claim!)).rejects.toMatchObject({code:'budget_exhausted'})
    const snapshot=(await f.controls.getExecution(f.task,f.users[0])).budget!
    expect(snapshot).toMatchObject({duration_exhausted:true,issued_calls_stopped:false,invocation_count:1})
    expect((await pool.query('SELECT state FROM collaboration_calls WHERE call_id=$1',[first.call_id])).rows[0].state).toBe('pending')
  })
  test('plan duration expiring while reviewer lock waits rolls back the entire reservation', async () => {
    const f=await schedulerFixture(undefined,{max_duration_seconds:1}),lock=await pool.connect()
    const counts=async()=> (await pool.query(`SELECT
      (SELECT count(*) FROM collaboration_calls WHERE task_id=$1) calls,
      (SELECT count(*) FROM collaboration_events WHERE team_session_id=$2) events,
      (SELECT count(*) FROM team_task_step_attempts WHERE task_id=$1) attempts,
      (SELECT count(*) FROM team_delivery_outbox WHERE task_id=$1) outbox`,[f.task,f.session.id])).rows[0]
    const before=await counts()
    let pending: Promise<unknown> | undefined
    try {
      await lock.query('BEGIN')
      const pid=(await lock.query('SELECT pg_backend_pid() pid')).rows[0].pid
      await lock.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[f.users[1]])
      pending=expect(f.next()).rejects.toMatchObject({code:'budget_exhausted'})
      let waiting=false
      for(let i=0;i<100;i++) {
        waiting=(await pool.query('SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid])).rowCount!>0
        if(waiting) break
        await new Promise(resolve=>setTimeout(resolve,10))
      }
      expect(waiting).toBe(true)
      await pool.query('SELECT pg_sleep(1.05)')
      await lock.query('ROLLBACK')
      await pending
      expect(await counts()).toEqual(before)
    } finally { await lock.query('ROLLBACK');lock.release();await pending }
  })
  test('plan token observation uses exact native facts once, excludes unbound child/private usage and never implies a hard cap', async () => {
    const f=await schedulerFixture(undefined,{token_warning_limit:100}),first=await f.next(),dispatch=new TeamDispatchRepository(pool,undefined,()=>true)
    const claimed=await dispatch.claim(first.call_id!)
    expect(claimed).not.toBeNull()
    const native=claimed!.nativeSessionId!
    const event=(await pool.query("INSERT INTO events(session_id,event_type,payload) VALUES($1,'agent_text','{}') RETURNING id",[native])).rows[0].id
    const projected=await dispatch.projectDaemonEvent(f.daemon,f.users[0],{type:'agent_text',session_id:native,seq:1,text:'Shared root answer'},900,Number(event))
    expect(projected?.event.call_id).toBe(first.call_id)
    expect(projected?.event).not.toHaveProperty('native_source_event_id')
    expect(String((await pool.query('SELECT native_source_event_id FROM collaboration_events WHERE event_id=$1',[projected!.event.id])).rows[0].native_source_event_id)).toBe(String(event))
    await pool.query(`INSERT INTO event_inbox(user_id,daemon_id,daemon_generation,seq,dedup_key,session_id,event_type,priority_class,payload,materialized_event_id)
      VALUES($1,$2,900,1,'usage-link',$3,'agent_text',1,'{}',$4),($1,$2,900,1,'usage-link-alias',$3,'agent_text',1,'{}',$4)`,[f.users[0],f.daemon,native,event])
    const budget=new TeamTaskBudgetRepository()
    expect((await budget.snapshot(pool as any,f.task))!.usage).toMatchObject({coverage:'unavailable',observed_tokens:null})
    await pool.query(`INSERT INTO token_usage_facts(fact_key,source_event_id,user_id,daemon_id,session_id,usage_date,recorded_at,input,output,cache_read,cache_create,reasoning,reported_total)
      VALUES('root-fact',$1,$2,$3,$4,CURRENT_DATE,NOW(),100,20,5,10,10,999),('child-or-private',$1::bigint+1,$2,$3,$4,CURRENT_DATE,NOW(),1000,0,0,0,0,1000)`,[event,f.users[0],f.daemon,native])
    // A normalized zero fact is not proof of measured zero: providers can
    // emit usage:{} and accounting defaults all missing components to zero.
    for (const usage of [{}, { total_tokens: 999 }, { input_tokens: '100' }, { input_tokens: -1 }]) {
      await pool.query('UPDATE events SET payload=$2::jsonb WHERE id=$1',[event,JSON.stringify({usage})])
      expect((await budget.snapshot(pool as any,f.task))!.usage).toMatchObject({coverage:'unavailable',observed_tokens:null,fact_count:0})
    }
    await pool.query('UPDATE events SET payload=$2::jsonb WHERE id=$1',[event,JSON.stringify({usage:{input_tokens:100,output_tokens:20,cache_read_tokens:5,cache_create_tokens:10}})])
    const observed=(await f.controls.getExecution(f.task,f.users[0])).budget!
    expect(observed.usage).toMatchObject({coverage:'partial',observed_tokens:'135',fact_count:1,attributed_calls:1,token_warning_exceeded:true,includes_subagents:'unknown',estimated_cost:null})
    expect(()=>requireTaskBudgetCapacity(observed)).not.toThrow()
    expect((await f.controls.getExecution(f.task,f.users[0])).budget).toEqual(observed)
    // Upgrade only the exact retained transport link, idempotently.
    await pool.query('UPDATE collaboration_events SET native_source_event_id=NULL WHERE event_id=$1',[projected!.event.id])
    await initTeamSchema(pool)
    await initTeamSchema(pool)
    expect(String((await pool.query('SELECT native_source_event_id FROM collaboration_events WHERE event_id=$1',[projected!.event.id])).rows[0].native_source_event_id)).toBe(String(event))
    expect((await budget.snapshot(pool as any,f.task))!.usage).toEqual(observed.usage)
    // Explicit measured zero is different from an absent measurement.
    await pool.query('UPDATE events SET payload=$2::jsonb WHERE id=$1',[event,JSON.stringify({usage:{input_tokens:0,output_tokens:0}})])
    await pool.query("UPDATE token_usage_facts SET input=0,output=0,cache_read=0,cache_create=0 WHERE fact_key='root-fact'")
    expect((await budget.snapshot(pool as any,f.task))!.usage).toMatchObject({coverage:'partial',observed_tokens:'0',fact_count:1})
    await pool.query("UPDATE token_usage_facts SET session_attribution_revoked=true WHERE fact_key='root-fact'")
    expect((await budget.snapshot(pool as any,f.task))!.usage.observed_tokens).toBeNull()
    await pool.query("UPDATE token_usage_facts SET session_attribution_revoked=false WHERE fact_key='root-fact'")
    await pool.query('DELETE FROM event_inbox WHERE daemon_id=$1',[f.daemon])
    expect((await budget.snapshot(pool as any,f.task))!.usage).toMatchObject({coverage:'partial',observed_tokens:'0',fact_count:1})
    await pool.query('DELETE FROM events WHERE id=$1',[event])
    expect((await budget.snapshot(pool as any,f.task))!.usage).toMatchObject({coverage:'unavailable',observed_tokens:null})
    expect((await pool.query('SELECT count(*)::int n FROM collaboration_calls WHERE task_id=$1',[f.task])).rows[0].n).toBe(2)
  })
  test('an expired scheduler lease rolls back source event, Call, spec and attempt together', async () => {
    const f=await schedulerFixture(), claim=await f.queue.claim([f.teamId],100)
    const blocker=await pool.connect(); await blocker.query('BEGIN'); await blocker.query('SELECT 1 FROM team_tasks WHERE task_id=$1 FOR UPDATE',[f.task])
    const result=f.scheduler.process(claim!).then(()=>null,error=>error)
    await pool.query('SELECT pg_sleep(0.15)'); await blocker.query('COMMIT');blocker.release()
    expect(await result).toBeInstanceOf(StepWakeupLeaseLost)
    expect((await pool.query('SELECT count(*)::int n FROM collaboration_calls WHERE task_id=$1',[f.task])).rows[0].n).toBe(1)
    expect((await pool.query('SELECT count(*)::int n FROM team_task_specs WHERE task_id=$1',[f.task])).rows[0].n).toBe(1)
    expect((await pool.query('SELECT count(*)::int n FROM team_task_step_attempts WHERE task_id=$1',[f.task])).rows[0].n).toBe(0)
    expect((await f.next()).state).toBe('reserved')
  })
  test('native Call-first projection cannot deadlock the Session-first scheduler', async () => {
    const f=await schedulerFixture(), claim=await f.queue.claim([f.teamId]), projection=await pool.connect()
    try {
      await projection.query('BEGIN')
      await projection.query('SELECT 1 FROM collaboration_calls WHERE call_id=$1 FOR UPDATE',[f.call])
      await expect(f.scheduler.process(claim!)).rejects.toMatchObject({code:'source_busy'})
      // The failed scheduler released Session, so the original projection
      // can finish without deadlock detection killing either transaction.
      await projection.query("SET LOCAL lock_timeout='500ms'")
      await projection.query('UPDATE collaboration_sessions SET updated_at=NOW() WHERE team_session_id=$1',[f.session.id])
      await projection.query('COMMIT')
    } finally { await projection.query('ROLLBACK'); projection.release() }
    expect(await f.queue.retry(claim!,'retry_pending',0)).toBe(true)
    expect((await f.next()).state).toBe('reserved')
    expect((await pool.query('SELECT count(*)::int n FROM team_task_step_attempts WHERE task_id=$1',[f.task])).rows[0].n).toBe(1)
  })
  test('50 gated pending step Calls cannot starve later legacy Calls in dispatch polling', async () => {
    const f=await controlFixture(), sessions=new TeamSessionService(pool), steps:string[]=[]
    for(let i=1;i<=50;i++) {
      const message=await sessions.appendMessage({sessionId:f.session.id,actorUserId:f.users[0],requestId:`pending-step-${i}`,content:'Synthetic queued intent',targetMode:'offers',targetOfferIds:[f.offer],referenceEventId:null})
      const call=message.call_ids[0];steps.push(call)
      await pool.query('UPDATE collaboration_calls SET task_id=$2 WHERE call_id=$1',[call,f.task])
      await pool.query(`INSERT INTO team_task_step_attempts(attempt_id,task_id,plan_revision,step_id,attempt_no,state,call_id,frozen_inputs,input_hash)
        VALUES($1,$2,1,'implement',$3,'reserved',$4,'[]',$5)`,[randomUUID(),f.task,i,call,stableDigest([])])
    }
    const legacy=await sessions.appendMessage({sessionId:f.session.id,actorUserId:f.users[0],requestId:'later-legacy',content:'Ordinary legacy message',targetMode:'offers',targetOfferIds:[f.offer],referenceEventId:null})
    expect(await new TeamDispatchRepository(pool).listPendingCallIds()).toEqual(legacy.call_ids)
    expect(await new TeamDispatchRepository(pool,undefined,id=>id===f.teamId).listPendingCallIds()).toEqual(steps)
    expect((await pool.query("SELECT count(*)::int n FROM collaboration_calls WHERE call_id=ANY($1::text[]) AND state='pending'",[steps])).rows[0].n).toBe(50)
  })
  test('plan activation requires explicit limit, current authority, feature and step capability', async () => {
    const f = await controlFixture()
    await expect(new TeamPlanExecutionService(pool).control(f.task, f.users[0], f.activation)).rejects.toMatchObject({ code: 'team_feature_disabled' })
    await expect(f.controls.control(f.task, f.users[1], f.activation)).rejects.toMatchObject({ code: 'creator_required' })
    await expect(f.controls.control(f.task, f.users[0], { ...f.activation, invocation_limit: undefined })).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(f.controls.control(f.task, f.users[0], { ...f.activation, invocation_limit: 2 })).rejects.toMatchObject({ code: 'budget_exhausted' })
    await pool.query("UPDATE daemons SET collaboration_capabilities=collaboration_capabilities-'team_task_steps_v1' WHERE daemon_id=$1", [f.daemon])
    await expect(f.controls.control(f.task, f.users[0], f.activation)).rejects.toMatchObject({ code: 'capability_not_supported' })
    expect((await pool.query('SELECT * FROM team_task_plan_runtime WHERE task_id=$1', [f.task])).rows).toEqual([])
    expect((await pool.query('SELECT * FROM team_task_plan_control_receipts WHERE task_id=$1', [f.task])).rows).toEqual([])
  })
  test('20 control CAS pairs preserve original receipts and create no Call or attempt', async () => {
    const f = await controlFixture()
    const initial = await f.controls.control(f.task, f.users[0], f.activation)
    expect(initial).toMatchObject({ revision: 1, state: 'active', invocation_limit: 3, issued_calls_stopped: false })
    for (let i = 0; i < 20; i++) {
      const requests: PlanControlInput[] = [1,2].map(n => ({ request_id: `control-${i}-${n}`, expected_revision: i+1, plan_revision: 1, action: i%2 ? 'resume' : 'pause' }))
      const results = await Promise.allSettled(requests.map(input => f.controls.control(f.task, f.users[0], input)))
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
      expect((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'revision_conflict' })
      const winner = results.findIndex(r => r.status === 'fulfilled')
      expect(await f.controls.control(f.task, f.users[0], requests[winner])).toEqual((results[winner] as PromiseFulfilledResult<unknown>).value)
    }
    expect(await f.controls.control(f.task, f.users[0], f.activation)).toEqual(initial)
    await expect(f.controls.control(f.task, f.users[0], { ...f.activation, invocation_limit: 4 })).rejects.toMatchObject({ code: 'idempotency_conflict' })
    expect((await pool.query('SELECT count(*)::int n FROM collaboration_calls WHERE task_id=$1', [f.task])).rows[0].n).toBe(1)
    expect((await pool.query('SELECT count(*)::int n FROM team_task_step_attempts WHERE task_id=$1', [f.task])).rows[0].n).toBe(0)
    expect((await pool.query('SELECT count(*)::int n FROM team_task_plan_control_receipts WHERE task_id=$1', [f.task])).rows[0].n).toBe(21)
  })
  test('pause and cancel remain available with execution disabled, but cannot resume or reset accounting', async () => {
    const f = await controlFixture(), off = new TeamPlanExecutionService(pool)
    const initial = await f.controls.control(f.task, f.users[0], f.activation)
    expect(await off.control(f.task, f.users[0], f.activation)).toEqual(initial)
    await off.control(f.task, f.users[0], { request_id: 'pause', expected_revision: 1, plan_revision: 1, action: 'pause' })
    await expect(off.control(f.task, f.users[0], { request_id: 'resume-off', expected_revision: 2, plan_revision: 1, action: 'resume' })).rejects.toMatchObject({ code: 'team_feature_disabled' })
    await expect(f.controls.control(f.task, f.users[0], { request_id: 'reset-budget', expected_revision: 2, plan_revision: 1, action: 'resume', invocation_limit: 128 })).rejects.toMatchObject({ code: 'invalid_request' })
    const cancelled = await off.control(f.task, f.users[0], { request_id: 'cancel', expected_revision: 2, plan_revision: 1, action: 'cancel' })
    expect(cancelled).toMatchObject({ state: 'cancelled', invocation_limit: 3, issued_calls_stopped: false })
    await expect(f.controls.control(f.task, f.users[0], { request_id: 'resurrect', expected_revision: 3, plan_revision: 1, action: 'resume' })).rejects.toMatchObject({ code: 'invalid_state' })
    expect((await pool.query('SELECT state FROM collaboration_calls WHERE call_id=$1', [f.call])).rows[0].state).toBe('completed')
  })
  test('draft adoption is explicit and paused; budget and past plan revisions do not reset', async () => {
    const f = await controlFixture(); await f.controls.control(f.task, f.users[0], f.activation)
    const next = structuredClone(f.input); next.request_id = 'plan-v2'; next.expected_revision = 1; next.steps[2].instruction += ' plus a fixture check'
    await f.save(next)
    expect((await pool.query('SELECT plan_revision FROM team_task_plan_runtime WHERE task_id=$1', [f.task])).rows[0].plan_revision).toBe('1')
    await expect(f.controls.control(f.task, f.users[0], { request_id: 'adopt-running', expected_revision: 1, plan_revision: 2, action: 'adopt_revision' })).rejects.toMatchObject({ code: 'invalid_state' })
    await f.controls.control(f.task, f.users[0], { request_id: 'pause-v1', expected_revision: 1, plan_revision: 1, action: 'pause' })
    const adopted = await f.controls.control(f.task, f.users[0], { request_id: 'adopt-v2', expected_revision: 2, plan_revision: 2, action: 'adopt_revision' })
    expect(adopted).toMatchObject({ revision: 3, plan_revision: 2, state: 'paused', invocation_limit: 3 })
    await f.controls.control(f.task, f.users[0], { request_id: 'resume-v2', expected_revision: 3, plan_revision: 2, action: 'resume' })
    expect((await f.service.getPlan(f.task, f.users[0], 1)).plan?.steps[2].instruction).toBe(f.input.steps[2].instruction)
  })
  test.each(['modify', 'remove'])('adoption rechecks a step reserved after the draft was saved: %s', async change => {
    const f = await controlFixture(); await f.controls.control(f.task, f.users[0], f.activation)
    const next = structuredClone(f.input); next.request_id = 'future-draft'; next.expected_revision = 1
    if (change === 'modify') next.steps[2].instruction += ' changed after reservation'
    else next.steps.pop()
    await f.save(next)
    await insertReservedAttempt(f.task, 'regress')
    await f.controls.control(f.task, f.users[0], { request_id: 'pause-before-adopt', expected_revision: 1, plan_revision: 1, action: 'pause' })
    await expect(f.controls.control(f.task, f.users[0], { request_id: 'adopt-started-change', expected_revision: 2, plan_revision: 2, action: 'adopt_revision' })).rejects.toThrow('started step')
    expect((await pool.query('SELECT revision,plan_revision,state FROM team_task_plan_runtime WHERE task_id=$1', [f.task])).rows[0]).toMatchObject({ revision: '2', plan_revision: '1', state: 'paused' })
  })
  test('active plan rejects legacy execution and delivery writes without losing original receipts', async () => {
    const f = await controlFixture(), delivery = new TeamDeliveryService(pool, { writesEnabledForTeam: () => true })
    const payload = { request_id: 'old-stage', expected_revision: 1, spec_revision: 1, source_call_id: f.call, summary: 'legacy late submission', code_revision: null, publish_scope: 'team' as const, contribution_ids: [],
      artifacts: [{ id: 'proof', name: 'proof.md', mime_type: 'text/markdown', byte_size: 1, sha256: artifactDigest(Buffer.from('x')), required: true }], evidence: [] }
    const stage = await delivery.prepare(f.task, f.users[0], payload)
    await f.controls.control(f.task, f.users[0], f.activation)
    expect(await delivery.prepare(f.task, f.users[0], payload)).toEqual(stage)
    expect((await delivery.lookupReceipt(f.task, f.users[0], payload.request_id)).found).toBe(true)
    await expect(delivery.uploadArtifact(f.task, f.users[0], stage.submission_id, 'proof', Buffer.from('x'))).rejects.toMatchObject({ code: 'invalid_state' })
    await expect(delivery.reviseSpec(f.task, f.users[0], { request_id: 'bypass-spec', expected_revision: 1, goal: 'legacy edit', acceptance: 'checked', policy: f.input.steps[0].review_policy })).rejects.toMatchObject({ code: 'invalid_state' })
    await expect(new TeamSessionService(pool, {}, undefined, undefined, () => true).executeTask({ sessionId: f.session.id, taskId: f.task, actorUserId: f.users[0], request_id: 'bypass-execute', expected_revision: 1, spec_revision: 1, context_version: 0, target_offer_ids: [f.offer] })).rejects.toMatchObject({ code: 'invalid_state' })
    expect((await delivery.exportJobs(f.daemon, f.users[0])).jobs).toEqual([])
    expect((await pool.query('SELECT count(*)::int n FROM collaboration_calls WHERE task_id=$1', [f.task])).rows[0].n).toBe(1)
  })
  test('activation removes legacy actions while preserving history, receipts and file governance', async () => {
    const f = await controlFixture(), delivery = new TeamDeliveryService(pool, { writesEnabledForTeam: () => true })
    const bytes = Buffer.from('legacy proof')
    const stage = await delivery.prepare(f.task, f.users[0], { request_id: 'legacy-prepare', expected_revision: 1, spec_revision: 1, source_call_id: f.call, summary: 'legacy pending review', code_revision: null, publish_scope: 'team', contribution_ids: [],
      artifacts: [{ id: 'proof', name: 'proof.md', mime_type: 'text/markdown', byte_size: bytes.length, sha256: artifactDigest(bytes), required: true }], evidence: [] })
    await delivery.uploadArtifact(f.task, f.users[0], stage.submission_id, 'proof', bytes)
    await delivery.publish(f.task, f.users[0], stage.submission_id, { request_id: 'legacy-publish', expected_revision: 1 })
    const projector = new TeamDeliveryProjector(pool); await projector.runOnce()
    expect((await delivery.listInbox(f.users[1])).items).toHaveLength(1)
    await f.controls.control(f.task, f.users[0], f.activation)
    expect((await delivery.listInbox(f.users[1])).items).toHaveLength(0)
    expect((await delivery.getDelivery(f.task, f.users[0])).writes_enabled).toBe(false)
    expect((await delivery.management(f.task, f.users[0])).can_manage).toBe(false)
    await projector.runOnce()
    expect((await pool.query("SELECT count(*)::int n FROM team_delivery_attention_items WHERE task_id=$1 AND state='open'", [f.task])).rows[0].n).toBe(0)
    expect((await delivery.getDelivery(f.task, f.users[0])).submissions).toHaveLength(1)
    expect((await delivery.lookupReceipt(f.task, f.users[0], 'legacy-publish')).found).toBe(true)
    expect((await delivery.readArtifact(f.task, f.users[1], stage.submission_id, 'proof')).bytes).toEqual(bytes)
    await delivery.revokeArtifact(f.task, f.users[0], stage.submission_id, 'proof', { request_id: 'legacy-revoke', expected_revision: 2, reason: 'governance remains available' })
    await expect(delivery.readArtifact(f.task, f.users[1], stage.submission_id, 'proof')).rejects.toMatchObject({ code: 'artifact_unavailable' })
  })
})
