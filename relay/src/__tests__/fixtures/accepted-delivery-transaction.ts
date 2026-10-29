import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { expect } from 'vitest'
import { TeamDeliveryService } from '../../team/delivery-service.js'
import { TeamSessionService } from '../../team/session-service.js'
import { TeamDispatchRepository } from '../../team/dispatch-repository.js'
import { TeamMemorySourceProjector } from '../../team/memory-source-projector.js'
import { artifactDigest, type AcceptanceInput } from '../../team/delivery-contract.js'
import { humanTeamFixture } from './team-v2.js'

/** Synthetic completed native Call, real Team delivery service transactions.
 * No live model/daemon execution is asserted by this fixture. */
export async function acceptedDeliveryTransactionFixture(pool: pg.Pool) {
  const f = await humanTeamFixture(pool)
  let capture = true
  const sources = new TeamMemorySourceProjector(true, { acceptedDeliveriesEnabledForTeam: id => capture && id === f.teamId })
  const sessions = new TeamSessionService(pool, {}, sources, undefined, id => id === f.teamId)
  const daemon = 'd-' + randomUUID(), offer = 'o-' + randomUUID()
  await pool.query(`INSERT INTO daemons(daemon_id,hostname,status,user_id,agents,collaboration_capabilities)
    VALUES($1,'isolated','online',$2,'[{"type":"codex","manageable":true}]',
    '["team_collaboration_dispatch_v1","team_collaboration_context_v1","team_task_delivery_v1"]')`, [daemon, f.users[0]])
  await pool.query("INSERT INTO team_agent_offers(offer_id,team_id,owner_user_id,daemon_id,provider) VALUES($1,$2,$3,$4,'codex')", [offer, f.teamId, f.users[0], daemon])
  const bound = await sessions.changeBinding({ sessionId: f.session.id, actorUserId: f.users[0], offerId: offer,
    active: true, expectedRevision: f.session.revision, requestId: 'bind' })
  const task = await sessions.assignTask({ sessionId: f.session.id, actorUserId: f.users[0], requestId: 'assign',
    instruction: 'Fix replay', acceptance: 'Stable revision', targetOfferIds: [offer], contextVersion: 0,
    reviewPolicy: { reviewer_user_id: f.users[1], primary_offer_id: offer, required_checks: ['unit'] } })
  const call = (await pool.query('SELECT call_id FROM collaboration_calls WHERE task_id=$1', [task.task_id])).rows[0].call_id
  const dispatcher = new TeamDispatchRepository(pool)
  expect(await dispatcher.claim(call)).toBeTruthy()
  expect(await dispatcher.bindNativeSession(call, daemon, f.users[0], 'fixture-' + randomUUID())).toBe(true)
  await pool.query("UPDATE collaboration_calls SET state='completed',finished_at=NOW() WHERE call_id=$1", [call])
  const delivery = new TeamDeliveryService(pool, { writesEnabledForTeam: id => id === f.teamId, memorySources: sources })
  const bytes = Buffer.from('fixture evidence only')
  const draft = await delivery.prepare(task.task_id, f.users[0], { request_id: 'prepare', expected_revision: 1,
    spec_revision: 1, source_call_id: call, summary: 'Replay uses the accepted immutable revision.',
    code_revision: 'fixture', publish_scope: 'team', contribution_ids: [],
    artifacts: [{ id: 'proof', name: 'proof.txt', mime_type: 'text/plain', byte_size: bytes.length, sha256: artifactDigest(bytes), required: true }],
    evidence: [{ check_id: 'unit', artifact_id: 'proof', result: 'passed', code_revision: 'fixture', source_kind: 'agent_claim' }] })
  await delivery.uploadArtifact(task.task_id, f.users[0], draft.submission_id, 'proof', bytes)
  await delivery.publish(task.task_id, f.users[0], draft.submission_id, { request_id: 'publish', expected_revision: 1 })
  await pool.query("INSERT INTO extension_providers(provider_id,manifest_version,manifest) VALUES('pocketctl-memory',1,'{}')")
  const target = randomUUID(), ownerScope = randomUUID(), bindingId = 'mb-' + randomUUID()
  await pool.query(`INSERT INTO extension_installations(installation_id,provider_id,owner_scope_kind,owner_scope_id,status,
    granted_scopes,subscriptions,enabled_services,event_filter,start_policy)
    VALUES($1,'pocketctl-memory','team',$2,'active','{}','{}','{memory.manage}','{}','from_now')`, [target, ownerScope])
  const personal: string[] = []
  for (const user of f.users.slice(0, 2)) {
    const id = randomUUID(); personal.push(id)
    await pool.query(`INSERT INTO extension_installations(installation_id,provider_id,owner_user_id,owner_scope_kind,owner_scope_id,status,
      granted_scopes,subscriptions,enabled_services,event_filter,start_policy)
      VALUES($1,'pocketctl-memory',$2,'personal',$1,'active','{session:events:read}','{session.event.v1}','{memory.manage}','{}','from_now')`, [id, user])
  }
  await pool.query(`INSERT INTO team_memory_bindings(binding_id,team_id,owner_scope_kind,owner_scope_id,installation_id,revision,created_by_user_id)
    VALUES($1,$2,'team',$3,$4,1,$5)`, [bindingId, f.teamId, ownerScope, target, f.users[0]])
  const decision: AcceptanceInput = { request_id: 'accept', expected_revision: 2, submission_id: draft.submission_id,
    spec_revision: 1, decision: 'accepted', reason: '', verified_checks: ['unit'] }
  return { ...f, bound, sessions, taskId: task.task_id, call, delivery, sources, personal, target, ownerScope, bindingId,
    submissionId: draft.submission_id, decision, setCapture: (value: boolean) => { capture = value } }
}
