import { randomUUID } from 'node:crypto'
import pg from 'pg'
import Fastify from 'fastify'
import { beforeAll, afterAll, beforeEach, describe, expect, test } from 'vitest'
import { deleteUserAccount, initDB, userExists } from '../db.js'
import { initTeamAccountLifecycleSchema } from '../team/account-lifecycle-schema.js'
import { initTeamDeliverySchema } from '../team/delivery-schema.js'
import { TeamDeliveryService } from '../team/delivery-service.js'
import { TeamSessionService } from '../team/session-service.js'
import { TeamTaskService } from '../team/task-service.js'
import { artifactDigest, DELIVERY_LIMITS, type PrepareSubmission, type AcceptanceInput } from '../team/delivery-contract.js'
import { registerTeamDeliveryRoutes } from '../team/delivery-routes.js'
import { TeamDeliveryProjector } from '../attention-inbox/team-delivery-projector.js'
import { TeamContextDeliveryService } from '../team/context-delivery.js'
import { TeamDispatchRepository } from '../team/dispatch-repository.js'
import { TeamDeliveryStagingCleanup } from '../team/delivery-staging-cleanup.js'
import { humanTeamFixture } from './fixtures/team-v2.js'

const enabled = process.env.RUN_POSTGRES_INTEGRATION === '1' && Boolean(process.env.TEST_DATABASE_URL)
;(enabled ? describe : describe.skip)('Team delivery authority (isolated PostgreSQL)', () => {
  let pool: pg.Pool
  beforeAll(async () => {
    const url = new URL(process.env.TEST_DATABASE_URL!)
    if (url.hostname !== '127.0.0.1' || !['18993', '18998'].includes(url.port) || url.pathname !== '/team_relay_test' || url.username !== 'team_relay_test') throw new Error('delivery-only isolated test database required')
    pool = new pg.Pool({ connectionString: url.toString(), max: 8 })
    const identity = (await pool.query(`SELECT current_database() db,current_user usr,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) superuser`)).rows[0]
    if (identity.db !== 'team_relay_test' || identity.usr !== identity.db || identity.superuser) throw new Error('non-superuser test identity required')
    await initDB(pool)
  }, 30_000)
  beforeEach(async () => { await pool.query('TRUNCATE users,daemons RESTART IDENTITY CASCADE') })
  afterAll(async () => { await pool?.end() })

  async function completeSyntheticCall(callId: string) {
    const source=(await pool.query(`SELECT o.owner_user_id,o.daemon_id FROM collaboration_calls c JOIN team_agent_offers o USING(offer_id) WHERE c.call_id=$1`,[callId])).rows[0]
    const dispatcher=new TeamDispatchRepository(pool)
    const claimed=await dispatcher.claim(callId)
    if(!claimed)throw Error('synthetic Call claim failed')
    if(claimed.authorization.operation==='create'&&!await dispatcher.bindNativeSession(callId,source.daemon_id,Number(source.owner_user_id),'fixture-'+randomUUID()))throw Error('synthetic native binding failed')
    await pool.query("UPDATE collaboration_calls SET state='completed',finished_at=NOW() WHERE call_id=$1",[callId])
  }
  async function fixture(multi = false, native = true) {
    const f = await humanTeamFixture(pool)
    const service = new TeamSessionService(pool, {}, undefined, undefined, id => id === f.teamId)
    const offers: string[] = []
    for (const owner of multi ? [f.users[0], f.users[2]] : [f.users[0]]) {
      const daemon = `delivery-d-${randomUUID()}`, offer = `delivery-o-${randomUUID()}`
      await pool.query(`INSERT INTO daemons(daemon_id,hostname,status,user_id,agents,collaboration_capabilities) VALUES($1,'delivery-test','online',$2,
        '[{"type":"codex","manageable":true}]','["team_collaboration_dispatch_v1","team_collaboration_context_v1","team_task_delivery_v1"]')`, [daemon, owner])
      await pool.query(`INSERT INTO team_agent_offers(offer_id,team_id,owner_user_id,daemon_id,provider) VALUES($1,$2,$3,$4,'codex')`, [offer, f.teamId, owner, daemon])
      const session = await service.getSession(f.session.id, f.users[0])
      await service.changeBinding({ sessionId: f.session.id, actorUserId: f.users[0], offerId: offer, active: true, expectedRevision: session.revision, requestId: `bind-${offer}` })
      offers.push(offer)
    }
    const assignment = { sessionId: f.session.id, actorUserId: f.users[0], requestId: 'assign', instruction: 'Fix reconnect', acceptance: 'Stable event identities',
      targetOfferIds: offers, contextVersion: 0, reviewPolicy: { reviewer_user_id: f.users[1], primary_offer_id: offers[0], required_checks: ['unit'] } }
    const assigned = await service.assignTask(assignment)
    // Database fixtures deliberately do not pretend that a real model ran.
    const calls = (await pool.query('SELECT call_id,offer_id FROM collaboration_calls WHERE task_id=$1', [assigned.task_id])).rows
    if(native)for(const call of calls)await completeSyntheticCall(call.call_id)
    else await pool.query("UPDATE collaboration_calls SET state='completed',finished_at=NOW() WHERE task_id=$1", [assigned.task_id])
    const delivery = new TeamDeliveryService(pool, { writesEnabledForTeam: id => id === f.teamId })
    const bytes = Buffer.from('# Test proof\n12 synthetic checks passed\n')
    const payload = (request = 'prepare', rev = 1, source = calls.find(c => c.offer_id === offers[0]).call_id): PrepareSubmission => ({
      request_id: request, expected_revision: rev, spec_revision: 1, source_call_id: source, summary: 'Fix and proof', code_revision: 'commit-1', publish_scope: 'team', contribution_ids: [],
      artifacts: [{ id: 'proof', name: 'report.md', mime_type: 'text/markdown', byte_size: bytes.length, sha256: artifactDigest(bytes), required: true }],
      evidence: [{ check_id: 'unit', artifact_id: 'proof', result: 'passed', code_revision: 'commit-1', source_kind: 'agent_claim' }],
    })
    const stage = async (request = 'prepare', rev = 1, owner = f.users[0], source?: string) => {
      const draft = await delivery.prepare(assigned.task_id, owner, payload(request, rev, source))
      await delivery.uploadArtifact(assigned.task_id, owner, draft.submission_id, 'proof', bytes)
      return draft
    }
    const published = async (request = 'prepare', rev = 1) => {
      const draft = await stage(request, rev)
      return delivery.publish(assigned.task_id, f.users[0], draft.submission_id, { request_id: `${request}-publish`, expected_revision: rev })
    }
    const decision = (submissionId: string, rev = 2, key = 'accept'): AcceptanceInput => ({ request_id: key, expected_revision: rev, submission_id: submissionId, spec_revision: 1, decision: 'accepted', reason: '', verified_checks: ['unit'] })
    return { ...f, service, offers, assignment, assigned, taskId: assigned.task_id, calls, delivery, bytes, payload, stage, published, decision }
  }

  // Age immutable fixture timestamps only, in a transaction that restores both
  // guards before commit. No test/cleanup option weakens production immutability.
  async function agePreparation(id: string) {
    const client=await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('ALTER TABLE team_task_submissions DISABLE TRIGGER protect_team_submission')
      await client.query('ALTER TABLE team_submission_artifacts DISABLE TRIGGER protect_team_artifact')
      await client.query("UPDATE team_task_submissions SET created_at=NOW()-interval '8 days' WHERE submission_id=$1",[id])
      await client.query("UPDATE team_submission_artifacts SET created_at=NOW()-interval '8 days' WHERE submission_id=$1",[id])
      await client.query("UPDATE team_delivery_staging_activity SET last_activity_at=NOW()-interval '8 days' WHERE submission_id=$1",[id])
      await client.query('ALTER TABLE team_task_submissions ENABLE TRIGGER protect_team_submission')
      await client.query('ALTER TABLE team_submission_artifacts ENABLE TRIGGER protect_team_artifact')
      await client.query('COMMIT')
    }catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
  }

  test('history identity migration upgrades populated legacy foreign keys without changing frozen evidence', async () => {
    const f=await fixture(),published=await f.published()
    await f.delivery.decide(f.taskId,f.users[1],f.decision(published.submission_id))
    const before=(await pool.query('SELECT manifest_sha256,manifest,evidence,submitted_by_user_id FROM team_task_submissions WHERE submission_id=$1',[published.submission_id])).rows
    // Recreate representative pre-upgrade foreign keys on this disposable DB.
    // No row/trigger edits are needed to migrate immutable historical records.
    for(const [table,column,target,key] of [
      ['team_task_specs','reviewer_user_id','users','id'],
      ['team_task_submissions','submitted_by_user_id','users','id'],
      ['team_agent_offers','daemon_id','daemons','daemon_id'],
    ])await pool.query(`ALTER TABLE ${table} DROP CONSTRAINT ${table}_${column}_history_fk,
      ADD CONSTRAINT ${table}_${column}_fkey FOREIGN KEY(${column}) REFERENCES ${target}(${key}) ON DELETE RESTRICT`)
    await initTeamAccountLifecycleSchema(pool)
    await initTeamAccountLifecycleSchema(pool)
    expect((await pool.query('SELECT manifest_sha256,manifest,evidence,submitted_by_user_id FROM team_task_submissions WHERE submission_id=$1',[published.submission_id])).rows).toEqual(before)
    expect(await deleteUserAccount(pool,f.users[1])).toBe(true)
    expect((await f.delivery.readArtifact(f.taskId,f.users[0],published.submission_id,'proof')).bytes).toEqual(f.bytes)
  })
  test('legacy raw account and active host deletion fail closed after identity migration', async () => {
    const f=await fixture()
    const daemon=(await pool.query('SELECT daemon_id FROM team_agent_offers WHERE offer_id=$1',[f.offers[0]])).rows[0].daemon_id
    await expect(pool.query('DELETE FROM users WHERE id=$1',[f.users[1]])).rejects.toMatchObject({code:'55000'})
    await expect(pool.query('DELETE FROM daemons WHERE daemon_id=$1',[daemon])).rejects.toMatchObject({code:'55000'})
    expect(await userExists(pool,f.users[1])).toBe(true)
    expect((await pool.query('SELECT 1 FROM daemons WHERE daemon_id=$1',[daemon])).rowCount).toBe(1)
    expect(await deleteUserAccount(pool,f.users[0])).toBe(true)
  })
  test('deleting a reviewer removes the account without rewriting immutable shared decisions', async () => {
    const f=await fixture(),published=await f.published()
    await f.delivery.decide(f.taskId,f.users[1],f.decision(published.submission_id))
    const before=(await pool.query('SELECT * FROM team_acceptance_decisions WHERE submission_id=$1',[published.submission_id])).rows
    expect(await deleteUserAccount(pool,f.users[1])).toBe(true)
    expect(await userExists(pool,f.users[1])).toBe(false)
    expect(await deleteUserAccount(pool,f.users[1])).toBe(false)
    expect((await pool.query('SELECT * FROM team_acceptance_decisions WHERE submission_id=$1',[published.submission_id])).rows).toEqual(before)
    expect((await pool.query('SELECT account_user_id FROM team_actor_identities WHERE actor_user_id=$1',[f.users[1]])).rows).toEqual([{account_user_id:null}])
    expect((await f.delivery.readArtifact(f.taskId,f.users[0],published.submission_id,'proof')).bytes).toEqual(f.bytes)
    await expect(f.delivery.getDelivery(f.taskId,f.users[1])).rejects.toMatchObject({code:'team_access_denied'})
    await expect(pool.query("INSERT INTO users(id,email,password_hash) VALUES($1,'identity-reuse@example.test','x')",[f.users[1]])).rejects.toMatchObject({code:'23505'})
    await initTeamAccountLifecycleSchema(pool)
    expect((await pool.query('SELECT account_user_id FROM team_actor_identities WHERE actor_user_id=$1',[f.users[1]])).rows[0].account_user_id).toBeNull()
  })
  test('deleting a contributor purges private preparations and daemon but preserves shared bytes', async () => {
    const f=await fixture(true),primary=await f.published()
    const source=f.calls.find(c=>c.offer_id===f.offers[1]).call_id
    const contribution=await f.stage('contribution',2,f.users[2],source)
    await f.delivery.publish(f.taskId,f.users[2],contribution.submission_id,{request_id:'contribution-publish',expected_revision:2})
    const privateDraft=await f.stage('unpublished',3,f.users[2],source)
    const daemon=(await pool.query('SELECT daemon_id FROM team_agent_offers WHERE offer_id=$1',[f.offers[1]])).rows[0].daemon_id
    await pool.query("INSERT INTO sessions(session_id,daemon_id,user_id) VALUES('private-contributor-session',$1,$2)",[daemon,f.users[2]])
    expect(await deleteUserAccount(pool,f.users[2])).toBe(true)
    expect((await pool.query('SELECT 1 FROM team_task_submissions WHERE submission_id=$1',[privateDraft.submission_id])).rows).toEqual([])
    expect((await pool.query('SELECT 1 FROM daemons WHERE daemon_id=$1',[daemon])).rows).toEqual([])
    expect((await pool.query('SELECT state FROM team_agent_offers WHERE offer_id=$1',[f.offers[1]])).rows[0].state).toBe('revoked')
    expect((await pool.query('SELECT live_daemon_id FROM team_daemon_identities WHERE daemon_id=$1',[daemon])).rows[0].live_daemon_id).toBeNull()
    for(const id of [primary.submission_id,contribution.submission_id])expect((await f.delivery.readArtifact(f.taskId,f.users[1],id,'proof')).bytes).toEqual(f.bytes)
    expect((await pool.query('SELECT removed_preparations,dissolved_teams FROM team_account_deletion_audit WHERE actor_user_id=$1',[f.users[2]])).rows[0]).toEqual({removed_preparations:1,dissolved_teams:0})
  })
  test('creator account deletion dissolves owned teams without deleting other members or unrelated teams', async () => {
    const f=await fixture(true),published=await f.published(),other=await fixture()
    await pool.query("INSERT INTO collaboration_team_memberships(membership_id,team_id,user_id) VALUES($1,$2,$3)",[randomUUID(),other.teamId,f.users[0]])
    await deleteUserAccount(pool,f.users[0])
    expect((await pool.query('SELECT state FROM collaboration_teams WHERE team_id=$1',[f.teamId])).rows[0].state).toBe('dissolved')
    expect((await pool.query('SELECT state FROM collaboration_teams WHERE team_id=$1',[other.teamId])).rows[0].state).toBe('active')
    expect(await userExists(pool,f.users[2])).toBe(true)
    expect((await pool.query('SELECT COUNT(*)::int n FROM daemons WHERE user_id=$1',[f.users[2]])).rows[0].n).toBe(1)
    expect((await pool.query('SELECT COUNT(*)::int n FROM team_submission_artifacts WHERE submission_id=$1',[published.submission_id])).rows[0].n).toBe(1)
    expect((await pool.query("SELECT COUNT(*)::int n FROM team_agent_offers WHERE team_id=$1 AND state='active'",[f.teamId])).rows[0].n).toBe(0)
    await expect(f.delivery.getDelivery(f.taskId,f.users[1])).rejects.toMatchObject({code:'team_not_found'})
    expect((await other.delivery.getDelivery(other.taskId,other.users[1])).task_id).toBe(other.taskId)
  })
  test('account deletion fences future work without claiming already dispatched native work stopped', async () => {
    for(const state of ['pending','dispatched','accepted'] as const){
      const f=await fixture()
      await pool.query('UPDATE collaboration_calls SET state=$2,finished_at=NULL WHERE call_id=$1',[f.calls[0].call_id,state])
      await deleteUserAccount(pool,f.users[0])
      const call=(await pool.query('SELECT state,outcome,finished_at FROM collaboration_calls WHERE call_id=$1',[f.calls[0].call_id])).rows[0]
      expect(call).toEqual({state:state==='pending'?'blocked':'uncertain',outcome:'account_deleted',finished_at:null})
    }
  })
  test('late deletion failure rolls back Team revocation, private removal and identity retirement', async () => {
    const f=await fixture(),draft=await f.stage()
    await pool.query(`CREATE FUNCTION fail_account_delete_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'account delete fault'; END $$;
      CREATE TRIGGER fail_account_delete_test BEFORE DELETE ON users FOR EACH ROW EXECUTE FUNCTION fail_account_delete_test()`)
    try{
      await expect(deleteUserAccount(pool,f.users[0])).rejects.toThrow('account delete fault')
      expect(await userExists(pool,f.users[0])).toBe(true)
      expect((await pool.query('SELECT state FROM collaboration_teams WHERE team_id=$1',[f.teamId])).rows[0].state).toBe('active')
      expect((await pool.query('SELECT state FROM team_agent_offers WHERE offer_id=$1',[f.offers[0]])).rows[0].state).toBe('active')
      expect((await pool.query('SELECT COUNT(*)::int n FROM team_submission_artifacts WHERE submission_id=$1',[draft.submission_id])).rows[0].n).toBe(1)
      expect((await pool.query('SELECT 1 FROM team_account_deletion_audit WHERE actor_user_id=$1',[f.users[0]])).rows).toEqual([])
    }finally{await pool.query('DROP TRIGGER fail_account_delete_test ON users; DROP FUNCTION fail_account_delete_test()')}
    expect(await deleteUserAccount(pool,f.users[0])).toBe(true)
  })

  test('a synthetic completed state without an exact native binding cannot prepare a delivery',async()=>{
    const f=await fixture(false,false)
    await expect(f.delivery.prepare(f.taskId,f.users[0],f.payload())).rejects.toMatchObject({code:'invalid_state'})
    expect((await pool.query('SELECT COUNT(*)::int n FROM team_task_submissions')).rows[0].n).toBe(0)
  })
  test.each(['session','offer','binding','native','deleted','deleting','private_owner','private_daemon'] as const)('new upload/publication recheck source after %s withdrawal',async(kind)=>{
    const f=await fixture(),draft=await f.stage()
    const source=(await pool.query('SELECT * FROM collaboration_calls WHERE call_id=$1',[f.calls[0].call_id])).rows[0]
    if(kind==='session')await pool.query("UPDATE collaboration_sessions SET state='archived' WHERE team_session_id=$1",[f.session.id])
    if(kind==='offer')await pool.query("UPDATE team_agent_offers SET state='revoked',revision=revision+1 WHERE offer_id=$1",[f.offers[0]])
    if(kind==='binding')await pool.query('UPDATE collaboration_session_agent_bindings SET revision=revision+1 WHERE binding_id=$1',[source.binding_id])
    if(kind==='native')await pool.query("UPDATE collaboration_session_agent_bindings SET native_session_id='different' WHERE binding_id=$1",[source.binding_id])
    if(kind==='deleted')await pool.query('INSERT INTO deleted_sessions(session_id) VALUES($1)',[source.native_session_id])
    const daemon=(await pool.query('SELECT daemon_id FROM team_agent_offers WHERE offer_id=$1',[f.offers[0]])).rows[0].daemon_id
    if(['deleting','private_owner','private_daemon'].includes(kind))await pool.query(
      'INSERT INTO sessions(session_id,user_id,daemon_id,content_state) VALUES($1,$2,$3,$4)',
      [source.native_session_id,kind==='private_owner'?f.users[1]:f.users[0],kind==='private_daemon'?null:daemon,kind==='deleting'?'deleting':'hot'])
    expect((await f.delivery.exportJobs(daemon,f.users[0])).jobs).toHaveLength(0)
    await expect(f.delivery.uploadArtifact(f.taskId,f.users[0],draft.submission_id,'proof',f.bytes)).rejects.toMatchObject({code:'invalid_state'})
    await expect(f.delivery.publish(f.taskId,f.users[0],draft.submission_id,{request_id:'publish',expected_revision:1})).rejects.toMatchObject({code:'invalid_state'})
    expect((await f.delivery.getDelivery(f.taskId,f.users[1])).latest_submission_id).toBeNull()
    expect((await f.delivery.lookupReceipt(f.taskId,f.users[0],'publish')).found).toBe(false)
  })
  test('published Team copies survive private-source deletion and remain explicitly revocable',async()=>{
    const f=await fixture(),published=await f.published()
    const source=(await pool.query('SELECT native_session_id FROM collaboration_calls WHERE call_id=$1',[f.calls[0].call_id])).rows[0]
    await pool.query('INSERT INTO deleted_sessions(session_id) VALUES($1)',[source.native_session_id])
    const original={request_id:'prepare-publish',expected_revision:1}
    expect(await f.delivery.publish(f.taskId,f.users[0],published.submission_id,original)).toEqual(published)
    expect((await f.delivery.readArtifact(f.taskId,f.users[1],published.submission_id,'proof')).bytes).toEqual(f.bytes)
    await f.delivery.decide(f.taskId,f.users[1],f.decision(published.submission_id))
    await f.delivery.revokeArtifact(f.taskId,f.users[0],published.submission_id,'proof',{request_id:'withdraw-copy',expected_revision:3,reason:'Withdraw explicit Team copy'})
    await expect(f.delivery.readArtifact(f.taskId,f.users[1],published.submission_id,'proof')).rejects.toMatchObject({code:'artifact_unavailable'})
  })
  test('publication does not race source lifecycle or binding row locks',async()=>{
    const f=await fixture(),draft=await f.stage(),locker=await pool.connect()
    const source=(await pool.query('SELECT native_session_id,binding_id FROM collaboration_calls WHERE call_id=$1',[f.calls[0].call_id])).rows[0]
    try {
      await locker.query('BEGIN');await locker.query('SELECT pg_advisory_xact_lock(1885566061,hashtext($1))',[source.native_session_id])
      await expect(f.delivery.publish(f.taskId,f.users[0],draft.submission_id,{request_id:'held',expected_revision:1})).rejects.toMatchObject({code:'source_busy'})
      await locker.query('ROLLBACK');await locker.query('BEGIN')
      await locker.query('SELECT binding_id FROM collaboration_session_agent_bindings WHERE binding_id=$1 FOR UPDATE',[source.binding_id])
      await expect(f.delivery.publish(f.taskId,f.users[0],draft.submission_id,{request_id:'held',expected_revision:1})).rejects.toMatchObject({code:'source_busy'})
      await locker.query('ROLLBACK')
      expect((await f.delivery.lookupReceipt(f.taskId,f.users[0],'held')).found).toBe(false)
      expect((await f.delivery.publish(f.taskId,f.users[0],draft.submission_id,{request_id:'held',expected_revision:1})).state).toBe('published')
    }finally{await locker.query('ROLLBACK');locker.release()}
  })
  test('staging cleanup frees only inactive bytes, retaining exact preparation receipts for reupload',async()=>{
    const f=await fixture(),draft=await f.stage();await agePreparation(draft.submission_id)
    const gc=new TeamDeliveryStagingCleanup(pool,[f.teamId])
    const before=(await pool.query('SELECT manifest_sha256,manifest FROM team_task_submissions WHERE submission_id=$1',[draft.submission_id])).rows[0]
    expect(await gc.runOnce()).toEqual({submissions:1,artifacts:1,bytes:f.bytes.length})
    expect(await gc.runOnce()).toEqual({submissions:0,artifacts:0,bytes:0})
    expect((await pool.query('SELECT manifest_sha256,manifest FROM team_task_submissions WHERE submission_id=$1',[draft.submission_id])).rows[0]).toEqual(before)
    expect(await f.delivery.prepare(f.taskId,f.users[0],f.payload())).toEqual(draft)
    await expect(f.delivery.publish(f.taskId,f.users[0],draft.submission_id,{request_id:'publish',expected_revision:1})).rejects.toMatchObject({code:'artifact_unavailable'})
    await f.delivery.uploadArtifact(f.taskId,f.users[0],draft.submission_id,'proof',f.bytes)
    expect((await f.delivery.publish(f.taskId,f.users[0],draft.submission_id,{request_id:'publish',expected_revision:1})).state).toBe('published')
    expect((await pool.query('SELECT COUNT(*)::int n FROM collaboration_calls WHERE task_id=$1',[f.taskId])).rows[0].n).toBe(1)
    expect((await pool.query('SELECT artifact_count,byte_count,policy_version FROM team_delivery_staging_reclaims')).rows).toEqual([{artifact_count:1,byte_count:String(f.bytes.length),policy_version:'staging-bytes-v1'}])
  })
  test('cleanup preserves published/revoked/recent and actively resumed preparations',async()=>{
    const f=await fixture(),published=await f.published();await agePreparation(published.submission_id)
    const revoked=await f.stage('withdraw',2);await agePreparation(revoked.submission_id)
    await f.delivery.revokeArtifact(f.taskId,f.users[0],revoked.submission_id,'proof',{request_id:'revoke',expected_revision:2,reason:'withdraw'})
    const resumed=await f.stage('resume',3);await agePreparation(resumed.submission_id)
    await f.delivery.uploadArtifact(f.taskId,f.users[0],resumed.submission_id,'proof',f.bytes)
    await f.stage('recent',3)
    expect(await new TeamDeliveryStagingCleanup(pool,[f.teamId]).runOnce()).toEqual({submissions:0,artifacts:0,bytes:0})
    expect((await pool.query('SELECT COUNT(*)::int n FROM team_submission_artifacts')).rows[0].n).toBe(4)
    await expect(f.delivery.uploadArtifact(f.taskId,f.users[0],revoked.submission_id,'proof',f.bytes)).rejects.toMatchObject({code:'artifact_unavailable'})
  })
  test('cleanup is team-scoped, restartable and serialized across workers',async()=>{
    const f=await fixture(),other=await fixture(),draft=await f.stage(),otherDraft=await other.stage()
    await agePreparation(draft.submission_id);await agePreparation(otherDraft.submission_id)
    const results=await Promise.all([new TeamDeliveryStagingCleanup(pool,[f.teamId]).runOnce(),new TeamDeliveryStagingCleanup(pool,[f.teamId]).runOnce()])
    expect(results.reduce((n,r)=>n+r.artifacts,0)).toBe(1)
    expect((await pool.query('SELECT COUNT(*)::int n FROM team_submission_artifacts WHERE submission_id=$1',[otherDraft.submission_id])).rows[0].n).toBe(1)
    expect((await pool.query('SELECT COUNT(*)::int n FROM team_delivery_staging_reclaims')).rows[0].n).toBe(1)
  })
  test('cleanup skips a publishing task and never reclaims the committed publication',async()=>{
    const f=await fixture(),draft=await f.stage();await agePreparation(draft.submission_id)
    const locker=await pool.connect(),gc=new TeamDeliveryStagingCleanup(pool,[f.teamId])
    try {
      await locker.query('BEGIN');await locker.query('SELECT task_id FROM team_tasks WHERE task_id=$1 FOR UPDATE',[f.taskId])
      expect(await gc.runOnce()).toEqual({submissions:0,artifacts:0,bytes:0})
      await locker.query('ROLLBACK')
      await f.delivery.publish(f.taskId,f.users[0],draft.submission_id,{request_id:'publish',expected_revision:1})
      expect(await gc.runOnce()).toEqual({submissions:0,artifacts:0,bytes:0})
    }finally{await locker.query('ROLLBACK');locker.release()}
  })
  test('cleanup audit failure rolls back the byte deletion and retry records exactly once',async()=>{
    const f=await fixture(),draft=await f.stage();await agePreparation(draft.submission_id)
    const gc=new TeamDeliveryStagingCleanup(pool,[f.teamId])
    await pool.query(`CREATE FUNCTION fail_staging_cleanup_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected reclaim failure'; END $$;
      CREATE TRIGGER fail_staging_cleanup_test BEFORE INSERT ON team_delivery_staging_reclaims FOR EACH ROW EXECUTE FUNCTION fail_staging_cleanup_test()`)
    try {
      await expect(gc.runOnce()).rejects.toThrow('injected reclaim failure')
      expect((await pool.query('SELECT COUNT(*)::int n FROM team_submission_artifacts WHERE submission_id=$1',[draft.submission_id])).rows[0].n).toBe(1)
      expect((await pool.query('SELECT COUNT(*)::int n FROM team_delivery_staging_reclaims')).rows[0].n).toBe(0)
    }finally{await pool.query('DROP TRIGGER fail_staging_cleanup_test ON team_delivery_staging_reclaims; DROP FUNCTION fail_staging_cleanup_test()')}
    expect((await gc.runOnce()).submissions).toBe(1)
  })

  test('session cards survive reload, keep primary delivery versions and enforce session membership', async () => {
    const f = await fixture(true)
    let page = await f.delivery.sessionCards(f.session.id, f.users[1])
    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({ task_id:f.taskId, latest_submission_id:null, event_id:f.assigned.event.id })
    const submission = await f.published()
    await f.delivery.decide(f.taskId, f.users[1], f.decision(submission.submission_id))
    const restored = new TeamDeliveryService(pool)
    page = await restored.sessionCards(f.session.id, f.users[1])
    expect(page.items[0]).toMatchObject({ latest_submission_id:submission.submission_id, version:1, decision:'accepted', files:[{id:'proof',name:'report.md'}] })
    expect(JSON.stringify(page)).not.toContain('native_session_id')
    await f.delivery.reviseSpec(f.taskId, f.users[0], { request_id:'spec-card', expected_revision:3, goal:'Next', acceptance:'New criteria', policy:f.assignment.reviewPolicy })
    page = await restored.sessionCards(f.session.id, f.users[1])
    expect(page.items[0]).toMatchObject({ spec_revision:2, submission_spec_revision:1, decision:'accepted' })
    await pool.query("UPDATE collaboration_session_participants SET state='removed' WHERE team_session_id=$1 AND user_id=$2", [f.session.id,f.users[1]])
    await expect(restored.sessionCards(f.session.id, f.users[1])).rejects.toMatchObject({code:'team_not_found'})
    await pool.query('UPDATE users SET team_enabled=false WHERE id=$1',[f.users[0]])
    await expect(restored.sessionCards(f.session.id, f.users[0])).rejects.toMatchObject({code:'team_access_denied'})
  })

  test('session cards paginate without duplicates and reading never dispatches', async () => {
    const f = await fixture()
    for(let i=0;i<51;i++){
      const next=await f.service.assignTask({...f.assignment,requestId:'page-'+i,instruction:'Task '+i})
      await pool.query("UPDATE collaboration_calls SET state='completed' WHERE task_id=$1",[next.task_id])
    }
    const before=(await pool.query('SELECT COUNT(*)::int n FROM collaboration_calls')).rows[0].n
    const first=await f.delivery.sessionCards(f.session.id,f.users[0]),second=await f.delivery.sessionCards(f.session.id,f.users[0],first.next_cursor!)
    expect(first.items).toHaveLength(50);expect(second.items).toHaveLength(2);expect(second.next_cursor).toBeNull()
    expect(new Set([...first.items,...second.items].map(i=>i.task_id)).size).toBe(52)
    expect((await pool.query('SELECT COUNT(*)::int n FROM collaboration_calls')).rows[0].n).toBe(before)
  },30_000)

  test('management choices respect creator role, membership, execution state and frozen versions', async () => {
    const f = await fixture(true)
    const opts = await f.delivery.management(f.taskId, f.users[0])
    expect(opts).toMatchObject({ can_manage: true, revision: 1, spec_revision: 1, execution_block: null })
    expect(opts.sessions.find(s => s.team_session_id === f.session.id)?.offer_ids.sort()).toEqual([...f.offers].sort())
    expect(await f.delivery.management(f.taskId, f.users[1])).toMatchObject({ can_manage: false, reviewers: [], offers: [], sessions: [] })
    const before = (await pool.query('SELECT COUNT(*)::int n FROM collaboration_calls WHERE task_id=$1', [f.taskId])).rows[0].n
    await f.delivery.management(f.taskId, f.users[0])
    expect((await pool.query('SELECT COUNT(*)::int n FROM collaboration_calls WHERE task_id=$1', [f.taskId])).rows[0].n).toBe(before)
    await pool.query("UPDATE collaboration_calls SET state='uncertain' WHERE call_id=$1", [f.calls[0].call_id])
    expect((await f.delivery.management(f.taskId, f.users[0])).execution_block).toBe('outstanding_execution')
    await pool.query("UPDATE collaboration_calls SET state='completed' WHERE call_id=$1", [f.calls[0].call_id])
    const submission = await f.published()
    await f.delivery.decide(f.taskId, f.users[1], f.decision(submission.submission_id))
    expect((await f.delivery.management(f.taskId, f.users[0])).execution_block).toBe('accepted_delivery')
    await f.delivery.reviseSpec(f.taskId, f.users[0], { request_id: 'next-spec', expected_revision: 3, goal: 'Next', acceptance: 'New criteria', policy: f.assignment.reviewPolicy })
    expect(await f.delivery.management(f.taskId, f.users[0])).toMatchObject({ revision: 4, spec_revision: 2, execution_block: null })
    await pool.query("UPDATE collaboration_session_participants SET state='removed' WHERE team_session_id=$1 AND user_id=$2", [f.session.id, f.users[0]])
    expect((await f.delivery.management(f.taskId, f.users[0])).sessions).toEqual([])
    await pool.query('UPDATE users SET team_enabled=false WHERE id=$1', [f.users[1]])
    expect((await f.delivery.management(f.taskId, f.users[0])).reviewers.some(m => m.user_id === f.users[1])).toBe(false)
    await pool.query("UPDATE collaboration_team_memberships SET role='viewer' WHERE team_id=$1 AND user_id=$2", [f.teamId,f.users[0]])
    expect((await f.delivery.management(f.taskId, f.users[0])).can_manage).toBe(false)
    await pool.query("UPDATE collaboration_team_memberships SET state='removed' WHERE team_id=$1 AND user_id=$2", [f.teamId,f.users[0]])
    await expect(f.delivery.management(f.taskId, f.users[0])).rejects.toMatchObject({ code: 'team_not_found' })
  })

  test('client capabilities follow membership and rollout; detail includes the exact visible submission specs', async () => {
    const f = await fixture()
    expect(await f.delivery.capabilities(f.teamId, f.users[1])).toEqual({ writes_enabled: true })
    const readOnly = new TeamDeliveryService(pool, { writesEnabledForTeam: () => false })
    expect(await readOnly.capabilities(f.teamId, f.users[1])).toEqual({ writes_enabled: false })
    await f.published()
    await f.delivery.reviseSpec(f.taskId, f.users[0], { request_id: 'spec-2', expected_revision: 2, goal: 'Next goal', acceptance: 'New criteria', policy: { reviewer_user_id: f.users[1], primary_offer_id: f.offers[0], required_checks: ['unit'] } })
    const detail = await f.delivery.getDelivery(f.taskId, f.users[1])
    expect(detail.task_state).toBe('in_progress')
    expect(detail.specs.map(s => Number(s.revision))).toEqual([1, 2])
    expect(detail.specs[0].acceptance).toBe('Stable event identities')
    await pool.query("UPDATE collaboration_team_memberships SET role='viewer' WHERE team_id=$1 AND user_id=$2", [f.teamId, f.users[1]])
    expect(await f.delivery.capabilities(f.teamId, f.users[1])).toEqual({ writes_enabled: false })
    await pool.query("UPDATE collaboration_team_memberships SET state='removed' WHERE team_id=$1 AND user_id=$2", [f.teamId, f.users[1]])
    await expect(f.delivery.capabilities(f.teamId, f.users[1])).rejects.toMatchObject({ code: 'team_not_found' })
    await expect(f.delivery.getDelivery(f.taskId, f.users[1])).rejects.toMatchObject({ code: 'team_not_found' })
  })

  test('daemon export jobs require completed exact native ownership and disappear after publication', async () => {
    const f = await fixture(false,false)
    const call = f.calls[0].call_id
    const daemon = (await pool.query('SELECT daemon_id FROM team_agent_offers WHERE offer_id=$1', [f.offers[0]])).rows[0].daemon_id
    // A synthetic terminal state without native receipts is not a publish job.
    expect((await f.delivery.exportJobs(daemon, f.users[0])).jobs).toEqual([])
    await expect(f.delivery.exportJobs(daemon, f.users[1])).rejects.toMatchObject({ code: 'team_not_found' })
    await pool.query("UPDATE collaboration_calls SET state='pending',finished_at=NULL WHERE call_id=$1", [call])
    const dispatch = new TeamDispatchRepository(pool)
    const claimed = await dispatch.claim(call)
    expect(claimed?.authorization.delivery).toEqual({ task_id: f.taskId, spec_revision: 1 })
    expect(await dispatch.bindNativeSession(call, daemon, f.users[0], 'delivery-native')).toBe(true)
    expect((await f.delivery.exportJobs(daemon, f.users[0])).jobs).toEqual([])
    await pool.query("UPDATE collaboration_calls SET state='completed',finished_at=NOW() WHERE call_id=$1", [call])
    const page = await f.delivery.exportJobs(daemon, f.users[0])
    expect(page.jobs).toEqual([expect.objectContaining({ call_id: call, task_id: f.taskId, native_session_id: 'delivery-native',
      delivery_role: 'primary', revision: 1, spec_revision: 1, authorization: claimed!.authorization })])
    expect(page.next_cursor).toBeNull()
    expect((await f.delivery.exportJobs(daemon, f.users[0], call)).jobs).toEqual([])
    const off = new TeamDeliveryService(pool, { writesEnabledForTeam: () => false })
    expect((await off.exportJobs(daemon, f.users[0])).jobs).toEqual([])
    await f.published()
    expect((await f.delivery.exportJobs(daemon, f.users[0])).jobs).toEqual([])
  })

  test('export diagnostics are owner-bound CAS records and cannot downgrade an authoritative publication', async () => {
    const f=await fixture(false,false), call=f.calls[0].call_id
    const daemon=(await pool.query('SELECT daemon_id FROM team_agent_offers WHERE offer_id=$1',[f.offers[0]])).rows[0].daemon_id
    await pool.query("UPDATE collaboration_calls SET state='pending',finished_at=NULL WHERE call_id=$1",[call])
    const dispatch=new TeamDispatchRepository(pool)
    await dispatch.claim(call)
    await dispatch.bindNativeSession(call,daemon,f.users[0],'diagnostic-native')
    const input={expected_revision:0,phase:'waiting_for_files',error_code:'manifest_unavailable'}
    await expect(f.delivery.reportExportStatus(f.taskId,f.users[0],daemon,call,input)).rejects.toMatchObject({code:'invalid_state'})
    await pool.query("UPDATE collaboration_calls SET state='completed',finished_at=NOW() WHERE call_id=$1",[call])
    await expect(f.delivery.reportExportStatus(f.taskId,f.users[1],daemon,call,input)).rejects.toMatchObject({code:'team_not_found'})
    await expect(f.delivery.reportExportStatus(f.taskId,f.users[0],'other-daemon',call,input)).rejects.toMatchObject({code:'team_not_found'})
    await expect(f.delivery.reportExportStatus(f.taskId,f.users[0],daemon,call,{...input,phase:'published'})).rejects.toMatchObject({code:'invalid_request'})
    await expect(f.delivery.reportExportStatus(f.taskId,f.users[0],daemon,call,{...input,error_code:'/private/secret'})).rejects.toMatchObject({code:'invalid_request'})
    expect(await f.delivery.reportExportStatus(f.taskId,f.users[0],daemon,call,input)).toEqual({revision:1,phase:'waiting_for_files'})
    await expect(f.delivery.reportExportStatus(f.taskId,f.users[0],daemon,call,input)).rejects.toMatchObject({code:'revision_conflict'})
    expect(await f.delivery.reportExportStatus(f.taskId,f.users[0],daemon,call,{...input,expected_revision:1})).toEqual({revision:1,phase:'waiting_for_files'})
    expect((await f.delivery.exportJobs(daemon,f.users[0])).jobs[0].export_revision).toBe(1)
    const history=await f.delivery.executionHistory(f.taskId,f.users[1])
    expect(history.executions[0].export_status).toMatchObject({phase:'waiting_for_files',error_code:'manifest_unavailable',revision:1})
    expect(history.executions[0].started_at).toBeNull()
    await f.published()
    expect(await f.delivery.reportExportStatus(f.taskId,f.users[0],daemon,call,{...input,expected_revision:1})).toEqual({revision:2,phase:'published'})
    const final=await f.delivery.executionHistory(f.taskId,f.users[1])
    expect(final.executions[0].export_status).toMatchObject({phase:'published',error_code:null,revision:2})
    expect(final.executions[0].deliveries).toHaveLength(1)
    expect((await f.delivery.getDelivery(f.taskId,f.users[1])).revision).toBe(2)
    // An upgrade may encounter a published source without a diagnostic row.
    await pool.query('DELETE FROM team_delivery_export_status WHERE call_id=$1',[call])
    expect(await f.delivery.reportExportStatus(f.taskId,f.users[0],daemon,call,input)).toEqual({revision:1,phase:'published'})
  })

  test('reviewed tasks block old daemons; export authority follows binding, membership and frozen specification', async () => {
    const f = await fixture(false,false)
    const call = f.calls[0].call_id
    const daemon = (await pool.query('SELECT daemon_id FROM team_agent_offers WHERE offer_id=$1', [f.offers[0]])).rows[0].daemon_id
    const dispatch = new TeamDispatchRepository(pool)
    await pool.query("UPDATE collaboration_calls SET state='pending',finished_at=NULL WHERE call_id=$1", [call])
    await pool.query(`UPDATE daemons SET collaboration_capabilities='["team_collaboration_dispatch_v1","team_collaboration_context_v1"]' WHERE daemon_id=$1`, [daemon])
    expect(await dispatch.claim(call)).toBeNull()
    expect((await pool.query('SELECT state FROM collaboration_calls WHERE call_id=$1', [call])).rows[0].state).toBe('blocked')
    await pool.query(`UPDATE daemons SET collaboration_capabilities=collaboration_capabilities || '["team_task_delivery_v1"]'::jsonb WHERE daemon_id=$1`, [daemon])
    await pool.query("UPDATE collaboration_calls SET state='pending',finished_at=NULL WHERE call_id=$1", [call])
    const claim = await dispatch.claim(call)
    expect(claim).not.toBeNull()
    await dispatch.bindNativeSession(call, daemon, f.users[0], 'delivery-native')
    await pool.query("UPDATE collaboration_calls SET state='completed',finished_at=NOW() WHERE call_id=$1", [call])
    expect((await f.delivery.exportJobs(daemon, f.users[0])).jobs).toHaveLength(1)
    await pool.query("UPDATE collaboration_team_memberships SET role='viewer' WHERE team_id=$1 AND user_id=$2", [f.teamId, f.users[0]])
    expect((await f.delivery.exportJobs(daemon, f.users[0])).jobs).toHaveLength(0)
    await pool.query("UPDATE collaboration_team_memberships SET role='admin' WHERE team_id=$1 AND user_id=$2", [f.teamId, f.users[0]])
    await pool.query("UPDATE collaboration_session_agent_bindings SET native_session_id='another-native' WHERE binding_id=$1", [claim!.authorization.binding_id])
    expect((await f.delivery.exportJobs(daemon, f.users[0])).jobs).toHaveLength(0)
    await pool.query("UPDATE collaboration_session_agent_bindings SET native_session_id='delivery-native' WHERE binding_id=$1", [claim!.authorization.binding_id])
    await f.delivery.reviseSpec(f.taskId, f.users[0], { request_id: 'new-spec', expected_revision: 1, goal: 'New goal', acceptance: 'New acceptance', policy: f.assignment.reviewPolicy })
    expect((await f.delivery.exportJobs(daemon, f.users[0])).jobs).toHaveLength(0)
  })

  test('migration is reentrant; old completed tasks stay legacy and new assignment freezes spec atomically', async () => {
    const f = await fixture()
    await initTeamDeliverySchema(pool)
    expect(await f.service.assignTask(f.assignment)).toEqual(f.assigned)
    const spec = (await f.delivery.getDelivery(f.taskId, f.users[1])).spec
    expect(spec).toMatchObject({ revision: 1, reviewer_user_id: f.users[1], primary_offer_id: f.offers[0], required_checks: ['unit'] })
    expect((await pool.query('SELECT count(*)::int n FROM team_call_delivery_specs WHERE task_id=$1', [f.taskId])).rows[0].n).toBe(1)
    const tasks = new TeamTaskService(pool)
    const legacy = await tasks.createTask({ teamId: f.teamId, actorUserId: f.users[0], title: 'Legacy', background: '', requestId: 'legacy' })
    const running = await tasks.updateTask({ taskId: legacy.id, actorUserId: f.users[0], expectedRevision: legacy.revision, requestId: 'run', state: 'in_progress' })
    expect((await tasks.updateTask({ taskId: legacy.id, actorUserId: f.users[0], expectedRevision: running.revision, requestId: 'end', state: 'completed' })).state).toBe('completed')
    expect((await pool.query('SELECT count(*)::int n FROM team_task_specs WHERE task_id=$1', [legacy.id])).rows[0].n).toBe(0)
  })
  test('submission provenance prevents source Call deletion before and after publication', async () => {
    const f = await fixture(), draft = await f.stage()
    const source = f.payload().source_call_id
    await expect(pool.query('DELETE FROM collaboration_calls WHERE call_id=$1', [source])).rejects.toMatchObject({ code: '23503' })
    const published = await f.delivery.publish(f.taskId, f.users[0], draft.submission_id, { request_id: 'publish-retained', expected_revision: 1 })
    await f.delivery.decide(f.taskId, f.users[1], f.decision(published.submission_id))
    await expect(pool.query('DELETE FROM collaboration_calls WHERE call_id=$1', [source])).rejects.toMatchObject({ code: '23503' })
    expect((await pool.query('SELECT source_call_id,manifest_sha256 FROM team_task_submissions WHERE submission_id=$1', [published.submission_id])).rows[0])
      .toMatchObject({ source_call_id: source, manifest_sha256: expect.any(String) })
    expect((await pool.query('SELECT COUNT(*)::int n FROM team_acceptance_decisions WHERE submission_id=$1', [published.submission_id])).rows[0].n).toBe(1)
    expect((await pool.query('SELECT content_bytes FROM team_submission_artifacts WHERE submission_id=$1', [published.submission_id])).rows[0].content_bytes).toEqual(f.bytes)
  })

  test('partial files cannot publish, immutable bytes and versioned manifests survive service recreation', async () => {
    const f = await fixture(), input = f.payload()
    const draft = await f.delivery.prepare(f.taskId, f.users[0], input)
    await expect(f.delivery.publish(f.taskId, f.users[0], draft.submission_id, { request_id: 'publish', expected_revision: 1 })).rejects.toMatchObject({ code: 'artifact_unavailable' })
    await expect(f.delivery.uploadArtifact(f.taskId, f.users[0], draft.submission_id, 'proof', Buffer.from('wrong'))).rejects.toMatchObject({ code: 'artifact_integrity' })
    expect((await pool.query('SELECT COUNT(*)::int n FROM team_delivery_outbox')).rows[0].n).toBe(0)
    await f.delivery.uploadArtifact(f.taskId, f.users[0], draft.submission_id, 'proof', f.bytes)
    const restarted = new TeamDeliveryService(pool, { writesEnabledForTeam: () => true })
    const published = await restarted.publish(f.taskId, f.users[0], draft.submission_id, { request_id: 'publish', expected_revision: 1 })
    expect(published).toMatchObject({ version: 1, state: 'published', revision: 2 })
    expect((await restarted.readArtifact(f.taskId, f.users[1], draft.submission_id, 'proof')).bytes).toEqual(f.bytes)
    await expect(pool.query("UPDATE team_submission_artifacts SET content_bytes=content_bytes WHERE submission_id=$1", [draft.submission_id])).rejects.toThrow('immutable')
    await expect(pool.query("UPDATE team_task_submissions SET summary='changed' WHERE submission_id=$1", [draft.submission_id])).rejects.toThrow('immutable')
    await expect(pool.query("UPDATE team_task_specs SET acceptance='changed' WHERE task_id=$1", [f.taskId])).rejects.toThrow('immutable')
  })
  test('only confirmed source-call owner can prepare; identity cannot cross task boundaries', async () => {
    const f = await fixture()
    await expect(f.delivery.prepare(f.taskId, f.users[1], f.payload())).rejects.toMatchObject({ code: 'offer_owner_required' })
    await pool.query("UPDATE collaboration_calls SET state='uncertain' WHERE call_id=$1", [f.payload().source_call_id])
    await expect(f.delivery.prepare(f.taskId, f.users[0], f.payload())).rejects.toMatchObject({ code: 'invalid_state' })
    const other = await fixture()
    await expect(other.delivery.prepare(other.taskId, other.users[0], { ...other.payload(), source_call_id: f.payload().source_call_id })).rejects.toMatchObject({ code: 'offer_owner_required' })
    expect((await pool.query('SELECT COUNT(*)::int n FROM team_task_submissions')).rows[0].n).toBe(0)
  })
  test('return and resubmit create independent decisions; legacy completion and direct SQL cannot bypass acceptance', async () => {
    const f = await fixture(), tasks = new TeamTaskService(pool), first = await f.published()
    const task = await tasks.getTask(f.taskId, f.users[0])
    await expect(tasks.updateTask({ taskId: f.taskId, actorUserId: f.users[0], expectedRevision: task.revision, requestId: 'bypass', state: 'completed' })).rejects.toMatchObject({ code: 'acceptance_required' })
    await expect(pool.query("UPDATE team_tasks SET state='completed' WHERE task_id=$1", [f.taskId])).rejects.toThrow('acceptance required')
    const returned = await f.delivery.decide(f.taskId, f.users[1], { ...f.decision(first.submission_id), decision: 'changes_requested', reason: 'Add proof', verified_checks: [] })
    const second = await f.published('revision', returned.revision)
    await expect(f.delivery.decide(f.taskId, f.users[1], f.decision(first.submission_id, second.revision, 'stale'))).rejects.toMatchObject({ code: 'revision_conflict' })
    await f.delivery.decide(f.taskId, f.users[1], f.decision(second.submission_id, second.revision, 'v2-accepted'))
    const current = await tasks.getTask(f.taskId, f.users[0])
    expect((await tasks.updateTask({ taskId: f.taskId, actorUserId: f.users[0], expectedRevision: current.revision, requestId: 'complete', state: 'completed' })).state).toBe('completed')
    expect((await pool.query('SELECT decision FROM team_acceptance_decisions ORDER BY created_at')).rows.map(r => r.decision)).toEqual(['changes_requested', 'accepted'])
  })
  test('parallel decisions have one winner and repeated operation IDs replay after completion', async () => {
    for (let i = 0; i < 20; i++) {
      const f = await fixture(), submitted = await f.published(), input = f.decision(submitted.submission_id)
      const outcomes = await Promise.allSettled([f.delivery.decide(f.taskId, f.users[1], input), f.delivery.decide(f.taskId, f.users[1], { ...input, request_id: 'competing', decision: 'changes_requested', reason: 'Different reviewer tab' })])
      expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(1)
      expect((await pool.query('SELECT COUNT(*)::int n FROM team_acceptance_decisions WHERE task_id=$1', [f.taskId])).rows[0].n).toBe(1)
      const key = outcomes[0].status === 'fulfilled' ? 'accept' : 'competing'
      const receipt = await f.delivery.getReceipt(f.taskId, f.users[1], key)
      const replayInput = key === 'accept' ? input : { ...input, request_id: 'competing', decision: 'changes_requested' as const, reason: 'Different reviewer tab' }
      expect(await f.delivery.decide(f.taskId, f.users[1], replayInput)).toEqual(receipt.response)
    }
  }, 30_000)
  test('explicit receipt lookup distinguishes absence from denial and never reveals another actor receipt', async () => {
    const f = await fixture(), submitted = await f.published(), input = f.decision(submitted.submission_id)
    const missing = { task_id: f.taskId, request_id: input.request_id, found: false, receipt: null }
    expect(await f.delivery.lookupReceipt(f.taskId, f.users[1], input.request_id)).toEqual(missing)
    const response = await f.delivery.decide(f.taskId, f.users[1], input)
    expect(await f.delivery.lookupReceipt(f.taskId, f.users[1], input.request_id)).toEqual({ ...missing, found: true, receipt: { operation: 'acceptance', response } })
    expect(await f.delivery.lookupReceipt(f.taskId, f.users[0], input.request_id)).toEqual(missing)
    expect(await f.delivery.getReceipt(f.taskId, f.users[1], input.request_id)).toEqual({ operation: 'acceptance', response })
    await pool.query("UPDATE collaboration_team_memberships SET state='removed' WHERE team_id=$1 AND user_id=$2", [f.teamId, f.users[1]])
    await expect(f.delivery.lookupReceipt(f.taskId, f.users[1], input.request_id)).rejects.toMatchObject({ code: 'team_not_found' })
    await expect(f.delivery.lookupReceipt('absent-task', f.users[0], input.request_id)).rejects.toMatchObject({ code: 'team_not_found' })
    expect((await pool.query('SELECT COUNT(*)::int n FROM team_acceptance_decisions WHERE task_id=$1', [f.taskId])).rows[0].n).toBe(1)
  })
  test('concurrent duplicate prepare/publish/decision requests produce one receipt and outbox event per action', async () => {
    const f = await fixture()
    const drafts = await Promise.all([f.delivery.prepare(f.taskId, f.users[0], f.payload()), f.delivery.prepare(f.taskId, f.users[0], f.payload())])
    expect(drafts[0]).toEqual(drafts[1])
    await f.delivery.uploadArtifact(f.taskId, f.users[0], drafts[0].submission_id, 'proof', f.bytes)
    const published = await Promise.all([1, 2].map(() => f.delivery.publish(f.taskId, f.users[0], drafts[0].submission_id, { request_id: 'publish', expected_revision: 1 })))
    expect(published[0]).toEqual(published[1])
    const decision = f.decision(drafts[0].submission_id)
    const results = await Promise.all([1, 2].map(() => f.delivery.decide(f.taskId, f.users[1], decision)))
    expect(results[0]).toEqual(results[1])
    await expect(f.delivery.decide(f.taskId, f.users[1], { ...decision, reason: 'changed' })).rejects.toMatchObject({ code: 'idempotency_conflict' })
    expect((await pool.query("SELECT count(*)::int n FROM team_delivery_outbox WHERE kind IN ('submission_published','acceptance_decided')")).rows[0].n).toBe(2)
    expect((await pool.query('SELECT count(*)::int n FROM team_delivery_receipts')).rows[0].n).toBe(3)
  })
  test('evidence is not trusted automatically; missing/failed evidence prevents approval but allows return', async () => {
    const f = await fixture()
    const draft = await f.delivery.prepare(f.taskId, f.users[0], { ...f.payload(), evidence: [] })
    await f.delivery.uploadArtifact(f.taskId, f.users[0], draft.submission_id, 'proof', f.bytes)
    await f.delivery.publish(f.taskId, f.users[0], draft.submission_id, { request_id: 'pub', expected_revision: 1 })
    await expect(f.delivery.decide(f.taskId, f.users[1], f.decision(draft.submission_id))).rejects.toMatchObject({ code: 'evidence_required' })
    expect((await f.delivery.decide(f.taskId, f.users[1], { ...f.decision(draft.submission_id), decision: 'changes_requested', reason: 'Provide unit check', verified_checks: [] })).decision).toBe('changes_requested')
  })
  test('reviewer changes preserve old snapshots and fence stale submissions and decisions', async () => {
    const f = await fixture(), published = await f.published()
    const changed = await f.delivery.reviseSpec(f.taskId, f.users[0], { request_id: 'change-reviewer', expected_revision: 2, goal: 'Updated goal', acceptance: 'New policy', policy: { reviewer_user_id: f.users[2], primary_offer_id: f.offers[0], required_checks: ['unit'] } })
    expect(changed).toEqual({ spec_revision: 2, revision: 3 })
    await expect(f.delivery.decide(f.taskId, f.users[1], f.decision(published.submission_id, 3))).rejects.toMatchObject({ code: 'revision_conflict' })
    await expect(f.delivery.decide(f.taskId, f.users[1], { ...f.decision(published.submission_id, 3), spec_revision: 2 })).rejects.toMatchObject({ code: 'reviewer_required' })
    await expect(f.delivery.decide(f.taskId, f.users[2], { ...f.decision(published.submission_id, 3), spec_revision: 2 })).rejects.toMatchObject({ code: 'revision_conflict' })
    expect((await pool.query('SELECT COUNT(*)::int n FROM team_task_specs WHERE task_id=$1', [f.taskId])).rows[0].n).toBe(2)
  })
  test('membership/account revocation invalidates reads and receipt replay without deleting historical decisions', async () => {
    const f = await fixture(), published = await f.published(), input = f.decision(published.submission_id)
    await f.delivery.decide(f.taskId, f.users[1], input)
    await pool.query("UPDATE collaboration_team_memberships SET state='removed' WHERE team_id=$1 AND user_id=$2", [f.teamId, f.users[1]])
    await expect(f.delivery.getDelivery(f.taskId, f.users[1])).rejects.toMatchObject({ code: 'team_not_found' })
    await expect(f.delivery.readArtifact(f.taskId, f.users[1], published.submission_id, 'proof')).rejects.toMatchObject({ code: 'team_not_found' })
    await expect(f.delivery.decide(f.taskId, f.users[1], input)).rejects.toMatchObject({ code: 'team_not_found' })
    await pool.query('UPDATE users SET team_enabled=false WHERE id=$1', [f.users[0]])
    await expect(f.delivery.getDelivery(f.taskId, f.users[0])).rejects.toMatchObject({ code: 'team_access_denied' })
    expect((await pool.query('SELECT COUNT(*)::int n FROM team_acceptance_decisions')).rows[0].n).toBe(1)
  })
  test('contributors publish immutable input without overriding the selected primary deliverable', async () => {
    const f = await fixture(true), main = await f.published()
    const contributorCall = f.calls.find(c => c.offer_id === f.offers[1]).call_id
    const draft = await f.stage('contribution', 2, f.users[2], contributorCall)
    const contribution = await f.delivery.publish(f.taskId, f.users[2], draft.submission_id, { request_id: 'contrib-publish', expected_revision: 2 })
    expect(contribution.delivery_role).toBe('contribution')
    expect((await f.delivery.getDelivery(f.taskId, f.users[1])).latest_submission_id).toBe(main.submission_id)
    await expect(f.delivery.decide(f.taskId, f.users[1], f.decision(contribution.submission_id, 3))).rejects.toMatchObject({ code: 'revision_conflict' })
  })
  test('revoked necessary files prevent read/accept/complete and remain separate from the immutable decision', async () => {
    const f = await fixture(), published = await f.published()
    await f.delivery.decide(f.taskId, f.users[1], f.decision(published.submission_id))
    await f.delivery.revokeArtifact(f.taskId, f.users[0], published.submission_id, 'proof', { request_id: 'revoke', expected_revision: 3, reason: 'Published accidentally' })
    await expect(f.delivery.readArtifact(f.taskId, f.users[1], published.submission_id, 'proof')).rejects.toMatchObject({ code: 'artifact_unavailable' })
    await expect(pool.query("UPDATE team_tasks SET state='completed' WHERE task_id=$1", [f.taskId])).rejects.toThrow('acceptance required')
    expect((await pool.query('SELECT decision FROM team_acceptance_decisions')).rows[0].decision).toBe('accepted')
  })
  test('a required check keeps its evidence file required even if the manifest marks it optional', async () => {
    const f = await fixture(), payload = f.payload()
    payload.artifacts[0].required = false
    const draft = await f.delivery.prepare(f.taskId, f.users[0], payload)
    await f.delivery.uploadArtifact(f.taskId, f.users[0], draft.submission_id, 'proof', f.bytes)
    await f.delivery.publish(f.taskId, f.users[0], draft.submission_id, { request_id: 'publish', expected_revision: 1 })
    await f.delivery.decide(f.taskId, f.users[1], f.decision(draft.submission_id))
    expect((await pool.query('SELECT team_task_delivery_complete($1) allowed', [f.taskId])).rows[0].allowed).toBe(true)
    await f.delivery.revokeArtifact(f.taskId, f.users[0], draft.submission_id, 'proof', { request_id: 'revoke', expected_revision: 3, reason: 'Withdraw evidence' })
    await expect(f.delivery.uploadArtifact(f.taskId, f.users[0], draft.submission_id, 'proof', f.bytes)).rejects.toMatchObject({ code: 'artifact_unavailable' })
    await expect(pool.query("UPDATE team_tasks SET state='completed' WHERE task_id=$1", [f.taskId])).rejects.toThrow('acceptance required')
  })
  test('fault after publication rolls back files publication, head, event and receipt together', async () => {
    const f = await fixture(), draft = await f.stage()
    await pool.query(`CREATE OR REPLACE FUNCTION delivery_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected publication failure'; END $$;
      CREATE TRIGGER delivery_test_fail BEFORE INSERT ON team_delivery_outbox FOR EACH ROW EXECUTE FUNCTION delivery_test_fail()`)
    try {
      await expect(f.delivery.publish(f.taskId, f.users[0], draft.submission_id, { request_id: 'publish', expected_revision: 1 })).rejects.toThrow('injected')
      expect((await pool.query('SELECT state FROM team_task_submissions')).rows[0].state).toBe('preparing')
      expect((await f.delivery.getDelivery(f.taskId, f.users[1])).latest_submission_id).toBeNull()
      expect((await pool.query("SELECT count(*)::int n FROM team_delivery_receipts WHERE operation LIKE 'publish:%'")).rows[0].n).toBe(0)
    } finally { await pool.query('DROP TRIGGER delivery_test_fail ON team_delivery_outbox; DROP FUNCTION delivery_test_fail()') }
    expect((await f.delivery.publish(f.taskId, f.users[0], draft.submission_id, { request_id: 'publish', expected_revision: 1 })).version).toBe(1)
  })
  test('base64 boundary accepts every byte size through 2 MiB and rejects one byte over', async () => {
    const f = await fixture(), app = Fastify()
    registerTeamDeliveryRoutes(app, { service: f.delivery, verifyAccessToken: async t => t === 'owner' ? { userId: f.users[0] } : null, getDatabaseReady: () => true })
    try {
      for (const size of [DELIVERY_LIMITS.artifactBytes - 2, DELIVERY_LIMITS.artifactBytes - 1, DELIVERY_LIMITS.artifactBytes]) {
        const bytes = Buffer.alloc(size, 'L'), input = f.payload(`boundary-${size}`)
        input.artifacts[0] = { ...input.artifacts[0], byte_size: size, sha256: artifactDigest(bytes) }
        const draft = await f.delivery.prepare(f.taskId, f.users[0], input)
        const url = `/api/team/tasks/${f.taskId}/delivery/submissions/${draft.submission_id}/artifacts/proof`
        const result = await app.inject({ method: 'PUT', url, headers: { authorization: 'Bearer owner' }, payload: { content_base64: bytes.toString('base64') } })
        expect(result.statusCode).toBe(200)
        const over = await app.inject({ method: 'PUT', url, headers: { authorization: 'Bearer owner' }, payload: { content_base64: Buffer.alloc(DELIVERY_LIMITS.artifactBytes + 1, 'X').toString('base64') } })
        expect(over.statusCode).toBe(400)
        expect((await pool.query('SELECT content_bytes FROM team_submission_artifacts WHERE submission_id=$1', [draft.submission_id])).rows[0].content_bytes).toEqual(bytes)
      }
    } finally { await app.close() }
  })

  test('real HTTP handlers return exact file bytes with attachment and no-store, and reject stale decisions', async () => {
    const f = await fixture(), published = await f.published(), app = Fastify()
    registerTeamDeliveryRoutes(app, { service: f.delivery, verifyAccessToken: async t => t === 'reviewer' ? { userId: f.users[1] } : null, getDatabaseReady: () => true })
    try {
      const base = `/api/team/tasks/${f.taskId}/delivery`
      const file = await app.inject({ method: 'GET', url: `${base}/submissions/${published.submission_id}/artifacts/proof`, headers: { authorization: 'Bearer reviewer' } })
      expect(file.statusCode).toBe(200); expect(file.rawPayload).toEqual(f.bytes)
      expect(file.headers['cache-control']).toBe('no-store'); expect(file.headers['content-disposition']).toContain('attachment')
      const bad = await app.inject({ method: 'POST', url: `${base}/decisions`, headers: { authorization: 'Bearer reviewer' }, payload: f.decision(published.submission_id, 1) })
      expect(bad.statusCode).toBe(409)
      const good = await app.inject({ method: 'POST', url: `${base}/decisions`, headers: { authorization: 'Bearer reviewer' }, payload: f.decision(published.submission_id) })
      expect(good.statusCode).toBe(200)
      expect(good.json().decision).toBe('accepted')
    } finally { await app.close() }
  })
  test('revised task dispatch freezes the new spec, replays once and blocks uncertain execution', async () => {
    const f = await fixture()
    await f.delivery.reviseSpec(f.taskId, f.users[0], { request_id: 'spec', expected_revision: 1, goal: 'New goal', acceptance: 'New check', policy: { reviewer_user_id: f.users[1], primary_offer_id: f.offers[0], required_checks: ['unit'] } })
    const input = { sessionId: f.session.id, taskId: f.taskId, actorUserId: f.users[0], request_id: 'execute', expected_revision: 2, spec_revision: 2, context_version: 0, target_offer_ids: f.offers }
    const results = await Promise.all(Array.from({ length: 5 }, () => f.service.executeTask(input)))
    expect(new Set(results.map(r => r.call_ids[0])).size).toBe(1)
    const fresh = results[0].call_ids[0]
    expect((await pool.query('SELECT count(*)::int n FROM collaboration_calls WHERE task_id=$1', [f.taskId])).rows[0].n).toBe(2)
    expect((await pool.query('SELECT spec_revision FROM team_call_delivery_specs WHERE call_id=$1', [fresh])).rows[0].spec_revision).toBe('2')
    await expect(f.service.executeTask({ ...input, request_id: 'again', expected_revision: 3 })).rejects.toMatchObject({ code: 'invalid_state' })
    await pool.query("UPDATE collaboration_calls SET state='uncertain' WHERE call_id=$1", [fresh])
    await expect(f.service.executeTask({ ...input, request_id: 'again', expected_revision: 3 })).rejects.toMatchObject({ code: 'invalid_state' })
    const contexts = new TeamContextDeliveryService(pool)
    const oldContext = await contexts.prepare(f.calls[0].call_id), nextContext = await contexts.prepare(fresh)
    expect(oldContext.stable_text).toContain('"spec_revision":1')
    expect(nextContext.stable_text).toContain('"spec_revision":2')
    expect(nextContext.stable_text).toContain('New goal')
    expect(nextContext.payload_hash).toBe(artifactDigest(Buffer.from(nextContext.stable_text)))
    await pool.query("UPDATE collaboration_calls SET state='pending' WHERE call_id=$1", [fresh])
    await completeSyntheticCall(fresh)
    const prepared = await f.delivery.prepare(f.taskId, f.users[0], { ...f.payload('new-delivery', 3, fresh), spec_revision: 2 })
    expect(prepared.state).toBe('preparing')
    await expect(f.delivery.prepare(f.taskId, f.users[0], { ...f.payload('wrong-source', 3), spec_revision: 2 })).rejects.toMatchObject({ code: 'offer_owner_required' })
  })
  test('explicit re-execution carries rejected delivery feedback in its immutable user request', async () => {
    const f = await fixture(), published = await f.published()
    await f.delivery.decide(f.taskId, f.users[1], { ...f.decision(published.submission_id), decision: 'changes_requested', reason: 'Explain the arithmetic and deliver a fresh version.' })
    const head = await f.delivery.getDelivery(f.taskId, f.users[0])
    const input = { sessionId: f.session.id, taskId: f.taskId, actorUserId: f.users[0], request_id: 'explicit-redelivery',
      expected_revision: head.revision, spec_revision: 1, context_version: 0, target_offer_ids: f.offers }
    const result = await f.service.executeTask(input)
    expect(result.event.content).toContain('这是本任务的新一次显式执行')
    expect(result.event.content).toContain('历史目录中的文件不能代替本次交付')
    expect(result.event.content).toContain('Explain the arithmetic and deliver a fresh version.')
    expect(result.event.content).toContain(published.submission_id)
    expect(result.event.content).toContain('"decision":"changes_requested"')
    expect(await f.service.executeTask(input)).toEqual(result)
    expect((await pool.query('SELECT content FROM collaboration_events WHERE event_id=$1', [result.event.id])).rows[0].content).toBe(result.event.content)
    const context = await new TeamContextDeliveryService(pool).prepare(result.call_ids[0])
    expect(context.stable_text).toContain(`.pocketctl-deliveries/${artifactDigest(Buffer.from(result.call_ids[0]))}`)
  })
  test('execution rejects wrong context, actor, team and accepted main delivery without new side effects', async () => {
    const f = await fixture()
    const input = { sessionId: f.session.id, taskId: f.taskId, actorUserId: f.users[0], request_id: 'execute', expected_revision: 1, spec_revision: 1, context_version: 0, target_offer_ids: f.offers }
    await expect(f.service.executeTask({ ...input, context_version: 99 })).rejects.toMatchObject({ code: 'context_revision_conflict' })
    await expect(f.service.executeTask({ ...input, actorUserId: f.users[1] })).rejects.toMatchObject({ code: 'creator_required' })
    await expect(f.service.executeTask({ ...input, taskId: 'absent' })).rejects.toMatchObject({ code: 'team_not_found' })
    const published = await f.published()
    await f.delivery.decide(f.taskId, f.users[1], f.decision(published.submission_id))
    await expect(f.service.executeTask({ ...input, expected_revision: 3 })).rejects.toMatchObject({ code: 'invalid_state' })
    expect((await pool.query('SELECT count(*)::int n FROM collaboration_calls WHERE task_id=$1', [f.taskId])).rows[0].n).toBe(1)
  })
  test('parallel/restarted projectors produce one reminder and read authority closes it before projection catches up', async () => {
    const f = await fixture(), published = await f.published()
    const a = new TeamDeliveryProjector(pool), b = new TeamDeliveryProjector(pool)
    await Promise.all([a.runOnce(), b.runOnce()])
    const inbox = await f.delivery.listInbox(f.users[1])
    expect(inbox.items).toHaveLength(1)
    expect(inbox.items[0]).toMatchObject({ task_id: f.taskId, submission_id: published.submission_id, kind: 'review_required', team_session_id: f.session.id })
    await f.delivery.markInboxSeen(f.users[1], inbox.items[0].item_id)
    expect((await f.delivery.listInbox(f.users[1])).items[0].seen_at).not.toBeNull()
    await expect(f.delivery.markInboxSeen(f.users[0], inbox.items[0].item_id)).rejects.toMatchObject({ code: 'team_not_found' })
    await f.delivery.decide(f.taskId, f.users[1], f.decision(published.submission_id))
    expect((await f.delivery.listInbox(f.users[1])).items).toHaveLength(0)
    await new TeamDeliveryProjector(pool).runOnce()
    expect((await pool.query('SELECT state FROM team_delivery_attention_items')).rows[0].state).toBe('resolved')
    expect(await a.runOnce()).toBe(0)
  })
  test('returned submission reminds publisher; replacement and stale outbox replay cannot reopen old review', async () => {
    const f = await fixture(), first = await f.published(), projector = new TeamDeliveryProjector(pool)
    await projector.runOnce()
    await f.delivery.decide(f.taskId, f.users[1], { ...f.decision(first.submission_id), decision: 'changes_requested', reason: 'Needs correction', verified_checks: [] })
    await projector.runOnce()
    expect((await f.delivery.listInbox(f.users[0])).items[0].kind).toBe('changes_requested')
    const next = await f.published('v2', 3)
    expect((await f.delivery.listInbox(f.users[0])).items).toHaveLength(0)
    await pool.query('UPDATE team_delivery_outbox SET processed_at=NULL')
    await projector.runOnce()
    expect((await f.delivery.listInbox(f.users[1])).items.map(i => i.submission_id)).toEqual([next.submission_id])
    expect((await pool.query("SELECT count(*)::int n FROM team_delivery_attention_items WHERE state='open'")).rows[0].n).toBe(1)
  })
  test('projector transaction rollback retains pending work and authorization hides revoked reminders immediately', async () => {
    const f = await fixture(); await f.published()
    await pool.query(`CREATE FUNCTION delivery_projection_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'projection failure'; END $$;
      CREATE TRIGGER delivery_projection_fail BEFORE INSERT ON team_delivery_attention_items FOR EACH ROW EXECUTE FUNCTION delivery_projection_fail()`)
    try {
      await expect(new TeamDeliveryProjector(pool).runOnce()).rejects.toThrow('projection failure')
      expect((await pool.query("SELECT count(*)::int n FROM team_delivery_outbox WHERE processed_at IS NULL AND kind='submission_published'")).rows[0].n).toBe(1)
      expect((await pool.query('SELECT count(*)::int n FROM team_delivery_attention_items')).rows[0].n).toBe(0)
    } finally { await pool.query('DROP TRIGGER delivery_projection_fail ON team_delivery_attention_items; DROP FUNCTION delivery_projection_fail()') }
    await new TeamDeliveryProjector(pool).runOnce()
    expect((await f.delivery.listInbox(f.users[1])).items).toHaveLength(1)
    await pool.query("UPDATE collaboration_team_memberships SET state='removed' WHERE team_id=$1 AND user_id=$2", [f.teamId, f.users[1]])
    expect((await f.delivery.listInbox(f.users[1])).items).toHaveLength(0)
    expect((await f.delivery.listInbox(f.users[2])).items).toHaveLength(0)
  })
  test('archiving closes attention and restoring reopens the same durable reminder', async () => {
    const f = await fixture(); await f.published()
    const tasks = new TeamTaskService(pool), projector = new TeamDeliveryProjector(pool)
    await projector.runOnce()
    const id = (await f.delivery.listInbox(f.users[1])).items[0].item_id
    const task = await tasks.getTask(f.taskId, f.users[0])
    const archived = await tasks.updateTask({ taskId: f.taskId, actorUserId: f.users[0], requestId: 'archive', expectedRevision: task.revision, state: 'archived' })
    await projector.runOnce()
    expect((await f.delivery.listInbox(f.users[1])).items).toHaveLength(0)
    await tasks.restoreTask({ taskId: f.taskId, actorUserId: f.users[0], requestId: 'restore', expectedRevision: archived.revision })
    await projector.runOnce()
    expect((await f.delivery.listInbox(f.users[1])).items[0].item_id).toBe(id)
  })
  test('an oversized frozen contract fails explicitly instead of truncating requirements', async () => {
    const f = await fixture()
    await expect(new TeamContextDeliveryService(pool, 300).prepare(f.calls[0].call_id)).rejects.toThrow('exceeds context budget')
    expect((await pool.query('SELECT count(*)::int n FROM collaboration_context_deliveries')).rows[0].n).toBe(0)
  })
  test('history separates dispatch, receipt and unknown native start, and reading creates no work', async () => {
    const f = await fixture(); await f.published()
    const before = (await pool.query('SELECT count(*)::int n FROM collaboration_calls')).rows[0].n
    const history = await f.delivery.executionHistory(f.taskId, f.users[1])
    expect(history.executions[0]).toMatchObject({ spec_revision: '1', started_at: null, dispatched_at: expect.any(Date), accepted_at: null })
    expect(history.executions[0].finished_at).not.toBeNull()
    expect(history.executions[0].deliveries).toHaveLength(1)
    expect((await pool.query('SELECT count(*)::int n FROM collaboration_calls')).rows[0].n).toBe(before)
  })
  test('feature off and viewer membership cannot write, but rollout off preserves authenticated reads', async () => {
    const f = await fixture(), published = await f.published(), off = new TeamDeliveryService(pool)
    await expect(off.decide(f.taskId, f.users[1], f.decision(published.submission_id))).rejects.toMatchObject({ code: 'team_feature_disabled' })
    expect((await off.getDelivery(f.taskId, f.users[1])).writes_enabled).toBe(false)
    await pool.query("UPDATE collaboration_team_memberships SET role='viewer' WHERE team_id=$1 AND user_id=$2", [f.teamId, f.users[1]])
    await expect(f.delivery.decide(f.taskId, f.users[1], f.decision(published.submission_id))).rejects.toMatchObject({ code: 'team_access_denied' })
    expect((await f.delivery.readArtifact(f.taskId, f.users[1], published.submission_id, 'proof')).bytes).toEqual(f.bytes)
  })
})
