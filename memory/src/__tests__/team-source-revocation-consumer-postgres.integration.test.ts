import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { createInboxRepository } from '../inbox/repository.js'
import { canonicalPayloadHash } from '../inbox/canonical-json.js'
import { createSourceProjector } from '../projection/source-projector.js'
import { createProjectionHandler } from '../projection/repository.js'
import { createJobRepository } from '../jobs/repository.js'
import { createPurgeRepository } from '../purge/repository.js'
import type { ExtensionFeedEnvelopeV1 } from '../relay/contracts.js'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1')
const INSTALLATION = '56565656-5656-4565-8565-565656565656'
const OLD_SESSION = 'team_old_generation'
const NEW_SESSION = 'team_new_generation'

function source(feedId: string, sessionId: string): ExtensionFeedEnvelopeV1 {
  const old = sessionId === OLD_SESSION
  return {
    envelope_version: 1, feed_id: feedId, topic: 'session.event.v1',
    source: { kind: 'team_collaboration_event', id: `team:${old ? 'old' : 'new'}:reply:u7:b1:v1`, recorded_at: '2026-10-10T00:00:00Z' },
    subject: { session_id: sessionId, turn_id: `team-call:${old ? 'old' : 'new'}`, event_type: 'team_source' },
    classification: { actor_scope: 'root', flow_scope: 'main', content_class: 'dialogue' },
    data: {
      team_source_version: 1, team_id: 'ctm_test', team_session_id: 'css_test',
      team_call_id: old ? 'old' : 'new', source_role: 'reply', context_version: 0,
      turn_id: `team-call:${old ? 'old' : 'new'}`, team_event_ids: ['cev_reply'], team_event_seqs: [2],
      text: old ? 'REVOKED RAW PRIVATE BODY' : 'CURRENT GENERATION BODY', author_offer_id: 'cao_test',
      read_scope: {
        kind: 'team_session', team_id: 'ctm_test', team_session_id: 'css_test',
        team_memory_binding_id: old ? 'cmbd_old' : 'cmbd_new', team_memory_binding_revision: 1,
        target_installation_id: '57575757-5757-4575-8575-575757575757',
        target_owner_scope_kind: 'team', target_owner_scope_id: '58585858-5858-4585-8585-585858585858',
        participant_user_id: 7, participant_revision: old ? 1 : 3,
      },
    },
  }
}

function revoke(feedId: string): ExtensionFeedEnvelopeV1 {
  return {
    envelope_version: 1, feed_id: feedId, topic: 'session.access.revoked.v1',
    source: { kind: 'session_access_revoked', id: 'team-access:css_test:u7:b1:p1:icmbd_old', recorded_at: '2026-10-10T00:00:01Z' },
    subject: { session_id: OLD_SESSION, event_type: 'session_access_revoked' },
    classification: {}, data: { reason: 'participant_removed' },
  }
}

(enabled ? describe : describe.skip)('Team revocation consumer raw retention (PostgreSQL)', () => {
  let pool: pg.Pool
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
    await assertMemoryTestDatabase(pool, databaseUrl!)
    await applyMemorySchema(pool)
  }, 60_000)
  afterAll(async () => { await pool?.end() })
  beforeEach(async () => {
    await pool.query(`TRUNCATE memory_installations RESTART IDENTITY CASCADE`)
    await pool.query(`INSERT INTO memory_installations
      (installation_id, provider_id, relay_status, local_status, config_version)
      VALUES ($1, 'pocketctl-memory', 'active', 'ready', 1)`, [INSTALLATION])
  })

  async function deliver(envelopes: ExtensionFeedEnvelopeV1[], ack = async () => 1) {
    return createInboxRepository(pool).commitBatch({
      installationId: INSTALLATION, envelopes, rawQuarantined: [], cursor: 'opaque-cursor',
      leaseToken: 'opaque-lease', ack,
    })
  }

  function projector(failOnEventType?: string) {
    return createSourceProjector(pool, {
      stabilizationMs: 0, failOnEventType,
      purge: createPurgeRepository(pool, { hmacKey: 'team-consumer-test' }),
    })
  }

  test('delayed revoked raw replay loses its body while durable hash still accepts ACK retry', async () => {
    await deliver([source('1', OLD_SESSION), source('2', NEW_SESSION)])
    await projector().projectOnce(INSTALLATION)
    await deliver([revoke('3')])
    await projector().projectOnce(INSTALLATION)
    const replay = source('4', OLD_SESSION)
    await expect(deliver([replay], async () => { throw new Error('ACK crash') })).rejects.toThrow('ACK crash')
    await projector().projectOnce(INSTALLATION)
    const row = (await pool.query(`SELECT data, classification, payload_hash, projection_state
      FROM memory_feed_inbox WHERE installation_id=$1 AND feed_id=4`, [INSTALLATION])).rows[0]
    expect(row.data).toEqual({})
    expect(row.classification).toEqual({})
    expect(row.projection_state).toBe('purged')
    expect(row.payload_hash.equals(canonicalPayloadHash(replay))).toBe(true)
    expect(await deliver([replay])).toBe(0)
    expect((await pool.query(`SELECT session_id, payload FROM source_events WHERE installation_id=$1`, [INSTALLATION])).rows)
      .toMatchObject([{ session_id: NEW_SESSION, payload: { text: 'CURRENT GENERATION BODY' } }])
    expect((await pool.query(`SELECT COUNT(*)::int AS count FROM memory_feed_inbox
      WHERE installation_id=$1 AND data::text LIKE '%REVOKED RAW PRIVATE BODY%'`, [INSTALLATION])).rows[0].count).toBe(0)
  })

  test('redaction and tombstone projection roll back together before a later batch failure', async () => {
    await createPurgeRepository(pool, { hmacKey: 'team-consumer-test' }).purgeSession({
      installationId: INSTALLATION, sessionId: OLD_SESSION, reason: 'access_revoked', sourceFeedId: null,
    })
    await deliver([source('1', OLD_SESSION), { ...source('2', NEW_SESSION), subject: {
      session_id: NEW_SESSION, turn_id: 'team-call:new', event_type: 'fail_after_redaction',
    } }])
    await expect(projector('fail_after_redaction').projectOnce(INSTALLATION)).rejects.toThrow('injected failure')
    expect((await pool.query(`SELECT projection_state, data->>'text' AS text
      FROM memory_feed_inbox WHERE installation_id=$1 AND feed_id=1`, [INSTALLATION])).rows[0])
      .toEqual({ projection_state: 'pending', text: 'REVOKED RAW PRIVATE BODY' })
    await projector().projectOnce(INSTALLATION)
    expect((await pool.query(`SELECT projection_state, data FROM memory_feed_inbox
      WHERE installation_id=$1 AND feed_id=1`, [INSTALLATION])).rows[0])
      .toEqual({ projection_state: 'purged', data: {} })
  })

  test.each(['completed', 'dead'])('same Feed IDs rearm a %s projection job after raw Session purge', async terminalState => {
    const old = source('1', OLD_SESSION), jobs = createJobRepository(pool)
    await deliver([old])
    const [first] = await jobs.claimJobs({ workerId: 'consumer-first', limit: 1, leaseMs: 30_000 })
    expect(first.job_type).toBe('project_feed')
    await createProjectionHandler(pool, { stabilizationMs: 0 }).handleProjectFeed(first, new AbortController().signal)
    expect(await jobs.completeJob({ jobId: first.job_id, claimedBy: 'consumer-first', claimEpoch: first.claim_epoch })).toBe(true)
    if (terminalState === 'dead') await pool.query(`UPDATE memory_jobs SET state='dead' WHERE job_id=$1`, [first.job_id])
    await createPurgeRepository(pool, { hmacKey: 'team-consumer-test' }).purgeSession({
      installationId: INSTALLATION, sessionId: OLD_SESSION, reason: 'access_revoked', sourceFeedId: null,
    })
    expect(await deliver([old])).toBe(1)
    const replayJob = (await pool.query(`SELECT state FROM memory_jobs WHERE job_id=$1`, [first.job_id])).rows[0]
    expect(replayJob.state).toBe('pending')
    const claim = (await jobs.claimJobs({ workerId: 'consumer-replay', limit: 1, leaseMs: 30_000 }))[0]
    expect(claim.job_id).toBe(first.job_id)
    await createProjectionHandler(pool, { stabilizationMs: 0, purge: createPurgeRepository(pool, { hmacKey: 'team-consumer-test' }) })
      .handleProjectFeed(claim, new AbortController().signal)
    await jobs.completeJob({ jobId: claim.job_id, claimedBy: 'consumer-replay', claimEpoch: claim.claim_epoch })
    expect((await pool.query(`SELECT data,projection_state FROM memory_feed_inbox WHERE installation_id=$1 AND feed_id=1`, [INSTALLATION])).rows[0])
      .toEqual({ data: {}, projection_state: 'purged' })
    expect(await deliver([old])).toBe(0)
    expect((await pool.query(`SELECT state FROM memory_jobs WHERE job_id=$1`, [first.job_id])).rows[0].state).toBe('completed')
  })

  test('new admission while the matching projection job is running preserves its fence and requires one rerun', async () => {
    const old = source('1', OLD_SESSION), jobs = createJobRepository(pool)
    await deliver([old])
    const [claim] = await jobs.claimJobs({ workerId: 'consumer-running', limit: 1, leaseMs: 30_000 })
    await createProjectionHandler(pool, { stabilizationMs: 0 }).handleProjectFeed(claim, new AbortController().signal)
    await createPurgeRepository(pool, { hmacKey: 'team-consumer-test' }).purgeSession({
      installationId: INSTALLATION, sessionId: OLD_SESSION, reason: 'access_revoked', sourceFeedId: null,
    })
    await deliver([old])
    expect((await pool.query(`SELECT state,claimed_by,claim_epoch::int,last_error_code FROM memory_jobs WHERE job_id=$1`, [claim.job_id])).rows[0])
      .toEqual({ state: 'running', claimed_by: 'consumer-running', claim_epoch: claim.claim_epoch, last_error_code: 'rerun_required' })
    expect(await jobs.completeJob({ jobId: claim.job_id, claimedBy: 'consumer-running', claimEpoch: claim.claim_epoch })).toBe(true)
    expect((await pool.query(`SELECT state FROM memory_jobs WHERE job_id=$1`, [claim.job_id])).rows[0].state).toBe('pending')
    const [rerun] = await jobs.claimJobs({ workerId: 'consumer-rerun', limit: 1, leaseMs: 30_000 })
    expect(rerun.job_id).toBe(claim.job_id)
    await createProjectionHandler(pool, { stabilizationMs: 0 }).handleProjectFeed(rerun, new AbortController().signal)
    expect((await pool.query(`SELECT data,projection_state FROM memory_feed_inbox WHERE installation_id=$1 AND feed_id=1`, [INSTALLATION])).rows[0])
      .toEqual({ data: {}, projection_state: 'purged' })
  })
})
