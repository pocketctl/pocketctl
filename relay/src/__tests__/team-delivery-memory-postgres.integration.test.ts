import { recordDeliveryWithdrawal, initDeliveryWithdrawalLedger } from '../team/delivery-withdrawal-ledger.js'
import { randomUUID } from 'node:crypto'
import { queryFeedRows } from '../extensions/feed-repository.js'
import { acceptedDeliveryTransactionFixture } from './fixtures/accepted-delivery-transaction.js'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { deleteUserAccount, initDB } from '../db.js'
import { TeamDeliveryService } from '../team/delivery-service.js'
import { TeamMemorySourceProjector } from '../team/memory-source-projector.js'
import { TeamRepository } from '../team/repository.js'
import { projectFeedBatch } from '../extensions/feed-projector.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const suite = databaseUrl && process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip

suite('accepted delivery transaction and durable Memory cleanup (isolated PostgreSQL)', () => {
  let pool: pg.Pool
  beforeAll(async () => {
    const url = new URL(databaseUrl!)
    if (url.hostname !== '127.0.0.1' || url.username !== 'pocketctl_delivery_relay_test'
      || url.pathname !== '/pocketctl_delivery_relay_test' || url.search) throw new Error('dedicated delivery Memory test database required')
    pool = new pg.Pool({ connectionString: databaseUrl, max: 8 })
    const identity = (await pool.query('SELECT current_database() AS db,current_user AS role,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser')).rows[0]
    expect(identity).toEqual({ db: 'pocketctl_delivery_relay_test', role: 'pocketctl_delivery_relay_test', superuser: false })
    await initDB(pool)
  }, 30_000)
  beforeEach(async () => { await pool.query('TRUNCATE team_delivery_memory_consumers,team_delivery_memory_withdrawals,extension_source_outbox,extension_feed,extension_providers,users,daemons RESTART IDENTITY CASCADE') })
  afterAll(async () => { await pool?.end() })

  const fixture = () => acceptedDeliveryTransactionFixture(pool)
  async function counts() {
    return (await pool.query(`SELECT
      (SELECT count(*)::int FROM team_acceptance_decisions) AS decisions,
      (SELECT count(*)::int FROM team_delivery_memory_sources) AS sources,
      (SELECT count(*)::int FROM extension_source_outbox WHERE source_kind='team_collaboration_event') AS packets,
      (SELECT count(*)::int FROM extension_source_outbox WHERE source_kind='session_access_revoked' AND payload->>'team_delivery_source_revoked'='true') AS revocations`)).rows[0]
  }
  async function accept(f: Awaited<ReturnType<typeof fixture>>) { return f.delivery.decide(f.taskId, f.users[1], f.decision) }

  test('acceptance commits two reader packets and durable receipts, with no replay after outbox consumption', async () => {
    const f = await fixture(), decision = await accept(f)
    expect(await counts()).toEqual({ decisions: 1, sources: 2, packets: 6, revocations: 0 })
    const rows = (await pool.query('SELECT payload FROM extension_source_outbox ORDER BY source_seq')).rows
    expect(rows.every(row => row.payload.accepted_delivery.decision_id === decision.decision_id)).toBe(true)
    expect(JSON.stringify(rows)).not.toContain('native_session')
    await projectFeedBatch(pool, { batchSize: 100 })
    expect((await pool.query('SELECT count(*)::int AS n FROM extension_feed')).rows[0].n).toBe(6)
    expect(await accept(f)).toEqual(decision)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      expect(await f.sources.projectAcceptedDelivery(client, { teamId: f.teamId, decisionId: decision.decision_id })).toBe(0)
      await client.query('COMMIT')
    } finally { client.release() }
    expect(await counts()).toEqual({ decisions: 1, sources: 2, packets: 0, revocations: 0 })
  })

  test.each(['off', 'no-binding', 'target-paused', 'no-readers', 'changes-requested'])('does not capture when %s', async mode => {
    const f = await fixture()
    if (mode === 'off') f.setCapture(false)
    if (mode === 'no-binding') await pool.query("UPDATE team_memory_bindings SET state='removed' WHERE binding_id=$1", [f.bindingId])
    if (mode === 'target-paused') await pool.query("UPDATE extension_installations SET status='paused' WHERE installation_id=$1", [f.target])
    if (mode === 'no-readers') await pool.query("UPDATE extension_installations SET subscriptions='{}' WHERE installation_id=ANY($1::uuid[])", [f.personal])
    if (mode === 'changes-requested') Object.assign(f.decision, { decision: 'changes_requested', reason: 'Needs revision' })
    await accept(f)
    expect(await counts()).toEqual({ decisions: 1, sources: 0, packets: 0, revocations: 0 })
    f.setCapture(true)
    await accept(f)
    expect((await counts()).sources).toBe(0)
  })

  test('delivery read exposes only the current reader capture status and immutable decision identity', async () => {
    const f = await fixture()
    expect((await f.delivery.getDelivery(f.taskId, f.users[0])).submissions[0].personal_memory_capture).toBeNull()
    const decision = await accept(f)
    for (const user of f.users.slice(0, 2)) {
      const submission = (await f.delivery.getDelivery(f.taskId, user)).submissions[0]
      expect(submission.decision_id).toBe(decision.decision_id)
      expect(submission.personal_memory_capture).toBe('captured')
      expect(submission).not.toHaveProperty('reader_user_id')
      expect(submission).not.toHaveProperty('source_session_id')
    }
    await pool.query("UPDATE team_delivery_memory_sources SET revoked_at=NOW(),revocation_reason='binding_removed' WHERE reader_user_id=$1", [f.users[1]])
    expect((await f.delivery.getDelivery(f.taskId, f.users[0])).submissions[0].personal_memory_capture).toBe('captured')
    expect((await f.delivery.getDelivery(f.taskId, f.users[1])).submissions[0].personal_memory_capture).toBe('access_revoked')
    await pool.query('DELETE FROM team_delivery_memory_sources WHERE reader_user_id=$1', [f.users[1]])
    expect((await f.delivery.getDelivery(f.taskId, f.users[1])).submissions[0].personal_memory_capture).toBe('not_captured')
    await f.delivery.revokeArtifact(f.taskId, f.users[0], f.submissionId, 'proof', { request_id: 'withdraw-ui', expected_revision: 3, reason: 'invalid evidence' })
    expect((await f.delivery.getDelivery(f.taskId, f.users[0])).submissions[0].personal_memory_capture).toBe('withdrawn')
  })

  test('a projection failure rolls back acceptance, mappings, outbox and its request receipt together', async () => {
    const f = await fixture()
    const broken = new TeamDeliveryService(pool, { writesEnabledForTeam: () => true, memorySources: {
      projectCompletedCall: async () => 0,
      projectAcceptedDelivery: async (client, input) => { await f.sources.projectAcceptedDelivery(client, input); throw new Error('injected projection failure') },
    } })
    await expect(broken.decide(f.taskId, f.users[1], f.decision)).rejects.toThrow('injected projection failure')
    expect(await counts()).toEqual({ decisions: 0, sources: 0, packets: 0, revocations: 0 })
    expect((await pool.query("SELECT 1 FROM team_delivery_receipts WHERE request_id='accept'")).rowCount).toBe(0)
    await accept(f)
    expect((await counts()).sources).toBe(2)
  })

  test('capture-off artifact withdrawal works after Feed consumes sources, and withdrawal replay remains durable', async () => {
    const f = await fixture(); await accept(f); await projectFeedBatch(pool, { batchSize: 100 }); f.setCapture(false)
    const closedCapture = new TeamDeliveryService(pool, { writesEnabledForTeam: () => true })
    const request = { request_id: 'withdraw', expected_revision: 3, reason: 'invalid evidence' }
    const receipt = await closedCapture.revokeArtifact(f.taskId, f.users[0], f.submissionId, 'proof', request)
    expect((await counts()).revocations).toBe(2)
    expect((await pool.query('SELECT 1 FROM team_delivery_memory_sources WHERE withdrawn_at IS NOT NULL')).rowCount).toBe(2)
    await projectFeedBatch(pool, { batchSize: 100 })
    expect(await closedCapture.revokeArtifact(f.taskId, f.users[0], f.submissionId, 'proof', request)).toEqual(receipt)
    expect((await counts()).revocations).toBe(0)
    expect((await pool.query("SELECT payload FROM extension_feed WHERE source_id LIKE 'team-delivery-withdraw:%'")).rows).toHaveLength(2)
  })

  test('participant removal keeps its durable source receipt even after the personal installation disappears', async () => {
    const f = await fixture(); await accept(f); await projectFeedBatch(pool, { batchSize: 100 }); f.setCapture(false)
    await pool.query('DELETE FROM extension_installations WHERE installation_id=$1', [f.personal[1]])
    const current = await f.sessions.getSession(f.session.id, f.users[0])
    await f.sessions.removeParticipant({ sessionId: f.session.id, actorUserId: f.users[0], userId: f.users[1], expectedRevision: current.revision, requestId: 'remove' })
    expect((await counts()).revocations).toBe(1)
    expect((await pool.query('SELECT reader_user_id FROM team_delivery_memory_sources WHERE revoked_at IS NULL')).rows).toEqual([{ reader_user_id: f.users[0] }])
    // Later artifact withdrawal still invalidates a previously revoked reader's
    // accepted evidence. It is a separate control receipt, not a lost no-op.
    await f.delivery.revokeArtifact(f.taskId, f.users[0], f.submissionId, 'proof', { request_id: 'withdraw', expected_revision: 3, reason: 'invalid evidence' })
    expect((await counts()).revocations).toBe(3)
  })

  test.each(['leave', 'account-delete', 'dissolve'])('%s revokes the captured generations with capture disabled', async action => {
    const f = await fixture(); await accept(f); await projectFeedBatch(pool, { batchSize: 100 })
    const teams = new TeamRepository(pool, new TeamMemorySourceProjector(false))
    if (action === 'leave') await teams.leaveTeam({ teamId: f.teamId, actorUserId: f.users[1], expectedRevision: 1, requestId: 'leave' })
    if (action === 'account-delete') expect(await deleteUserAccount(pool, f.users[1])).toBe(true)
    if (action === 'dissolve') {
      const revision = Number((await pool.query('SELECT revision FROM collaboration_teams WHERE team_id=$1', [f.teamId])).rows[0].revision)
      await teams.dissolveTeam({ teamId: f.teamId, actorUserId: f.users[0], expectedRevision: revision, requestId: 'dissolve' })
    }
    const expected = action === 'dissolve' ? 2 : 1
    expect((await pool.query('SELECT 1 FROM team_delivery_memory_sources WHERE revoked_at IS NOT NULL')).rowCount).toBe(expected)
    // Account purge may remove its pending personal feed by design; durable
    // mapping history must still show that cleanup ran before account deletion.
    if (action !== 'account-delete') expect((await counts()).revocations).toBe(expected)
    expect((await counts()).sources).toBe(2)
  })

  test('a removed reader is excluded even when the reviewer subsequently accepts through Team delivery', async () => {
    const f = await fixture(), current = await f.sessions.getSession(f.session.id, f.users[0])
    await f.sessions.removeParticipant({ sessionId: f.session.id, actorUserId: f.users[0], userId: f.users[1], expectedRevision: current.revision, requestId: 'remove-first' })
    await accept(f)
    expect((await pool.query('SELECT reader_user_id FROM team_delivery_memory_sources')).rows).toEqual([{ reader_user_id: f.users[0] }])
    expect((await counts()).packets).toBe(3)
  })

  test('concurrent participant removal waits for capture and then revokes the exact committed generation', async () => {
    const f = await fixture(), current = await f.sessions.getSession(f.session.id, f.users[0])
    let release!: () => void, captured!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    const reached = new Promise<void>(resolve => { captured = resolve })
    const delivery = new TeamDeliveryService(pool, { writesEnabledForTeam: () => true, memorySources: {
      projectCompletedCall: async () => 0,
      projectAcceptedDelivery: async (client, input) => {
        const n = await f.sources.projectAcceptedDelivery(client, input)
        captured(); await barrier; return n
      },
    } })
    const accepting = delivery.decide(f.taskId, f.users[1], f.decision)
    let removing: Promise<unknown> | undefined
    try {
      await Promise.race([reached, accepting.then(() => { throw new Error('capture barrier was not reached') })])
      removing = f.sessions.removeParticipant({ sessionId: f.session.id, actorUserId: f.users[0], userId: f.users[1], expectedRevision: current.revision, requestId: 'remove-concurrent' })
      let waiting = false
      for (let attempt = 0; attempt < 100; attempt++) {
        waiting = (await pool.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
          AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0
          AND query LIKE '%SELECT session.*, member.role%'`)).rowCount! > 0
        if (waiting) break
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      expect(waiting).toBe(true)
    } finally { release(); await Promise.allSettled([accepting, ...(removing ? [removing] : [])]) }
    await accepting; await removing
    expect(await counts()).toMatchObject({ decisions: 1, sources: 2, packets: 6, revocations: 1 })
    expect((await pool.query('SELECT reader_user_id,participant_revision::int FROM team_delivery_memory_sources WHERE revoked_at IS NOT NULL')).rows)
      .toEqual([{ reader_user_id: f.users[1], participant_revision: 1 }])
  })

  test('binding cleanup covers inactive readers and remains idempotent after the capture configuration is withdrawn', async () => {
    const f = await fixture(); await accept(f); await projectFeedBatch(pool, { batchSize: 100 })
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      // A durable mapping is the source of cleanup authority, even if a legacy
      // lifecycle writer already changed the participant row without cleanup.
      await client.query("UPDATE collaboration_session_participants SET state='removed' WHERE team_session_id=$1 AND user_id=$2", [f.session.id, f.users[1]])
      const sources = new TeamMemorySourceProjector(false)
      const input = { teamId: f.teamId, bindingId: f.bindingId, bindingRevision: 1 }
      expect(await sources.revokeTeamBinding(client, input)).toBeGreaterThanOrEqual(2)
      expect(await sources.revokeTeamBinding(client, input)).toBe(0)
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    expect((await counts()).revocations).toBe(2)
    expect((await pool.query('SELECT 1 FROM team_delivery_memory_sources WHERE revoked_at IS NULL')).rowCount).toBe(0)
  })

  test('the enabled Team cannot be substituted to capture a different Team decision', async () => {
    const f = await fixture(); f.setCapture(false)
    const result = await accept(f)
    const sources = new TeamMemorySourceProjector(true, { acceptedDeliveriesEnabledForTeam: id => id === 'another-team' })
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      expect(await sources.projectAcceptedDelivery(client, { teamId: 'another-team', decisionId: result.decision_id })).toBe(0)
      await client.query('COMMIT')
    } finally { client.release() }
    expect((await counts()).sources).toBe(0)
  })

  test.each(['extra-data', 'extra-envelope', 'wrong-submission', 'wrong-session', 'wrong-reader', 'string-revision', 'invalid-reason', 'content-event', 'unsafe-integer'])('mandatory privacy feed rejects a delivery control with %s', async mutation => {
    const f = await fixture(); await accept(f)
    await f.delivery.revokeArtifact(f.taskId, f.users[0], f.submissionId, 'proof', { request_id: 'withdraw-filter', expected_revision: 3, reason: 'invalid evidence' })
    await projectFeedBatch(pool, { batchSize: 100 })
    const options = { ownerUserId: f.users[0], topics: [], afterFeedId: 0, limit: 100, mandatoryTeamRevocations: true }
    const read = () => queryFeedRows(pool, options)
    expect(await queryFeedRows(pool, { ...options, mandatoryTeamRevocations: false })).toEqual([])
    const rows = await read(); expect(rows).toHaveLength(1)
    const row = rows[0], payload = structuredClone(row.payload) as any
    let sessionId = row.session_id, sourceId = payload.source.id, topic = 'session.access.revoked.v1', sourceKind = 'session_access_revoked'
    if (mutation === 'extra-data') payload.data.text = 'must never bypass capture scope'
    if (mutation === 'extra-envelope') payload.text = 'must never bypass capture scope'
    if (mutation === 'wrong-submission') payload.data.submission_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    if (mutation === 'wrong-reader') payload.data.participant_user_id = f.users[1]
    if (mutation === 'string-revision') payload.data.participant_revision = '1'
    if (mutation === 'invalid-reason') payload.data.reason = 'arbitrary_content'
    if (mutation === 'unsafe-integer') payload.data.participant_revision = 9007199254740992
    if (mutation === 'wrong-session') {
      sessionId = 'team_delivery_' + 'a'.repeat(32)
      sourceId = 'team-delivery-withdraw:' + sessionId
      payload.subject.session_id = sessionId; payload.source.id = sourceId
    }
    if (mutation === 'content-event') {
      topic = payload.topic = 'session.event.v1'; sourceKind = payload.source.kind = 'canonical_event'
    }
    await pool.query('UPDATE extension_feed SET session_id=$2,source_id=$3,topic=$4,source_kind=$5,payload=$6 WHERE feed_id=$1',
      [row.feed_id, sessionId, sourceId, topic, sourceKind, payload])
    expect(await read()).toEqual([])
  })

  test('participant revoke and later artifact withdrawal both bypass withdrawn capture subscriptions', async () => {
    const f = await fixture(); await accept(f)
    const current = await f.sessions.getSession(f.session.id, f.users[0])
    await f.sessions.removeParticipant({ sessionId: f.session.id, actorUserId: f.users[0], userId: f.users[1], expectedRevision: current.revision, requestId: 'remove-filter' })
    await f.delivery.revokeArtifact(f.taskId, f.users[0], f.submissionId, 'proof', { request_id: 'withdraw-filter', expected_revision: 3, reason: 'invalid evidence' })
    await projectFeedBatch(pool, { batchSize: 100 })
    const controls = await queryFeedRows(pool, { ownerUserId: f.users[1], topics: [], afterFeedId: 0, limit: 100, mandatoryTeamRevocations: true })
    const delivery = controls.filter(row => (row.payload.data as Record<string, unknown>).team_delivery_source_revoked === true)
    expect(delivery.map(row => (row.payload.data as Record<string, unknown>).reason)).toEqual(['participant_removed', 'artifact_revoked'])
  })

  test('mandatory delivery controls remain readable after their transient source mapping is purged', async () => {
    const f = await fixture(); await accept(f)
    await f.delivery.revokeArtifact(f.taskId, f.users[0], f.submissionId, 'proof', { request_id: 'withdraw-mapping', expected_revision: 3, reason: 'invalid evidence' })
    await projectFeedBatch(pool, { batchSize: 100 })
    await pool.query('DELETE FROM team_delivery_memory_sources')
    expect(await queryFeedRows(pool, { ownerUserId: f.users[0], topics: [], afterFeedId: 0, limit: 100, mandatoryTeamRevocations: true })).toHaveLength(1)
  })

  test('a failed withdrawal outbox insert rolls back artifact revocation and the durable source state', async () => {
    const f = await fixture(); await accept(f); await projectFeedBatch(pool, { batchSize: 100 })
    await pool.query(`CREATE FUNCTION test_fail_delivery_memory_control() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.payload->>'team_delivery_source_revoked'='true' THEN RAISE EXCEPTION 'injected control failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER test_fail_delivery_memory_control BEFORE INSERT ON extension_source_outbox
      FOR EACH ROW EXECUTE FUNCTION test_fail_delivery_memory_control()`)
    const request = { request_id: 'withdraw-fault', expected_revision: 3, reason: 'withdraw test evidence' }
    try {
      await expect(f.delivery.revokeArtifact(f.taskId, f.users[0], f.submissionId, 'proof', request)).rejects.toThrow('injected control failure')
      expect((await pool.query('SELECT 1 FROM team_artifact_revocations')).rowCount).toBe(0)
      expect((await pool.query('SELECT 1 FROM team_delivery_memory_withdrawals')).rowCount).toBe(0)
      expect((await pool.query('SELECT 1 FROM team_delivery_memory_sources WHERE revoked_at IS NOT NULL')).rowCount).toBe(0)
      expect((await pool.query("SELECT 1 FROM team_delivery_receipts WHERE request_id='withdraw-fault'")).rowCount).toBe(0)
    } finally {
      await pool.query('DROP TRIGGER test_fail_delivery_memory_control ON extension_source_outbox; DROP FUNCTION test_fail_delivery_memory_control()')
    }
    await f.delivery.revokeArtifact(f.taskId, f.users[0], f.submissionId, 'proof', request)
    expect((await counts()).revocations).toBe(2)
  })
  test('independent ledger sequences cannot commit out of order under concurrent publishers', async () => {
    const first = await pool.connect(), second = await pool.connect()
    const source = () => ({ team_id: 'transaction-test', team_session_id: 'session-test', submission_id: randomUUID(), decision_id: randomUUID() })
    let pending: Promise<void> | undefined
    try {
      await first.query('BEGIN'); await second.query('BEGIN')
      const pid = (await second.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      await recordDeliveryWithdrawal(first, source())
      pending = recordDeliveryWithdrawal(second, source())
      let waiting = false
      for (let attempt = 0; attempt < 100; attempt++) {
        waiting = (await pool.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'", [pid])).rowCount === 1
        if (waiting) break
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      expect(waiting).toBe(true)
      expect((await pool.query('SELECT 1 FROM team_delivery_memory_withdrawals')).rowCount).toBe(0)
      await first.query('COMMIT'); await pending
      const visible = (await pool.query('SELECT sequence::text FROM team_delivery_memory_withdrawals')).rows
      expect(visible).toHaveLength(1)
      await second.query('COMMIT')
      const all = (await pool.query('SELECT sequence::text FROM team_delivery_memory_withdrawals ORDER BY sequence')).rows
      expect(all).toHaveLength(2)
      expect(all[0]).toEqual(visible[0]); expect(BigInt(all[1].sequence)).toBeGreaterThan(BigInt(all[0].sequence))
    } finally {
      await first.query('ROLLBACK'); await pending?.catch(() => undefined); await second.query('ROLLBACK')
      first.release(); second.release()
    }
  })

  test('upgrade backfills withdrawn sources once and ledger survives source mapping deletion', async () => {
    const f = await fixture(); await accept(f)
    await f.delivery.revokeArtifact(f.taskId, f.users[0], f.submissionId, 'proof', { request_id: 'withdraw-upgrade', expected_revision: 3, reason: 'invalid evidence' })
    expect((await pool.query('SELECT 1 FROM team_delivery_memory_withdrawals')).rowCount).toBe(1)
    await pool.query('TRUNCATE team_delivery_memory_withdrawals')
    await initDeliveryWithdrawalLedger(pool)
    const original = (await pool.query('SELECT * FROM team_delivery_memory_withdrawals')).rows
    expect(original).toHaveLength(1)
    await initDeliveryWithdrawalLedger(pool)
    await pool.query('DELETE FROM team_delivery_memory_sources')
    await initDeliveryWithdrawalLedger(pool)
    expect((await pool.query('SELECT * FROM team_delivery_memory_withdrawals')).rows).toEqual(original)
  })

})
