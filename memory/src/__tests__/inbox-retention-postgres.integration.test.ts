import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { createInboxRepository, FeedReplayExpiredError } from '../inbox/repository.js'
import { createFeedConsumer } from '../inbox/feed-worker.js'
import { createSourceProjector } from '../projection/source-projector.js'
import { createSnapshotRepository } from '../snapshot/repository.js'
import { createPurgeRepository } from '../purge/repository.js'
import { retainInboxInstallation, createInboxRetentionWorker, type InboxRetentionSettings } from '../inbox/retention.js'
import type { ExtensionFeedEnvelopeV1 } from '../relay/contracts.js'

const url = process.env.MEMORY_TEST_DATABASE_URL
const describeDb = url && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1' ? describe : describe.skip
const id = '71717171-7171-4171-8171-717171717171'
const settings: InboxRetentionSettings = { mode: 'enabled', bodyDays: 7, metadataDays: 14, batchSize: 500, intervalMs: 60_000 }

function envelope(feedId: number): ExtensionFeedEnvelopeV1 {
  return {
    envelope_version: 1, feed_id: String(feedId), topic: 'session.event.v1',
    source: { kind: 'canonical_event', id: `event-${feedId}`, recorded_at: '2026-01-01T00:00:00.000Z' },
    subject: { session_id: 'retention-session', turn_id: 'retention-turn', event_type: 'agent_text' },
    classification: { actor_scope: 'root', flow_scope: 'main', content_class: 'dialogue' },
    data: { event_id: `event-${feedId}`, text: 'private source content' },
  }
}

describeDb('two-stage inbox retention (PostgreSQL)', () => {
  let pool: pg.Pool
  let inbox: ReturnType<typeof createInboxRepository>
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 4 })
    await assertMemoryTestDatabase(pool, url!)
    await applyMemorySchema(pool)
    inbox = createInboxRepository(pool)
  })
  afterAll(async () => { await pool?.end() })
  beforeEach(async () => {
    await pool.query('TRUNCATE memory_purge_receipts,memory_installations CASCADE')
    await pool.query(`INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version)
      VALUES($1,'pocketctl-memory','active','ready',1)`, [id])
  })
  const commit = (feedId: number, ack = async () => feedId) => inbox.commitBatch({
    installationId: id, envelopes: [envelope(feedId)], rawQuarantined: [], cursor: 'cursor', leaseToken: 'lease', ack,
  })
  async function seed(feedId: number, age: string, state = 'projected') {
    await commit(feedId)
    await createSourceProjector(pool).projectOnce(id)
    await pool.query(`UPDATE memory_feed_inbox SET projected_at=NOW()-$3::interval,projection_state=$4
      WHERE installation_id=$1 AND feed_id=$2`, [id, feedId, age, state])
  }
  const sweep = (overrides: Partial<InboxRetentionSettings> = {}) => retainInboxInstallation(pool, id, { ...settings, ...overrides })
  const receipt = async (feedId: number) => (await pool.query(`SELECT * FROM memory_feed_inbox WHERE installation_id=$1 AND feed_id=$2`, [id, feedId])).rows[0]
  const checkpoint = async () => (await pool.query(`SELECT last_ack_feed_id::text,gc_feed_id::text FROM memory_inbox_checkpoints WHERE installation_id=$1`, [id])).rows[0]

  test('seven days clears body/classification only, preserving the original receipt and source', async () => {
    await seed(1, '8 days')
    const before = await receipt(1)
    expect(await sweep()).toMatchObject({ reclaimed: 1, deleted: 0 })
    const after = await receipt(1)
    expect(after.data).toEqual({})
    expect(after.classification).toEqual({})
    expect(after.body_reclaimed_at).toBeInstanceOf(Date)
    for (const field of ['installation_id', 'feed_id', 'payload_hash', 'projection_state', 'session_id', 'turn_id', 'projected_at']) {
      expect(after[field]).toEqual(before[field])
    }
    expect((await pool.query(`SELECT payload FROM source_events WHERE installation_id=$1`, [id])).rows[0].payload).toEqual(envelope(1).data)
    expect(await sweep()).toMatchObject({ reclaimed: 0, deleted: 0 })
  })

  test('same-ID replay after body reclamation stays idempotent and changed envelope is rejected', async () => {
    await seed(1, '8 days'); await sweep()
    const ack = vi.fn(async () => 1)
    expect(await commit(1, ack)).toBe(0)
    expect(ack).toHaveBeenCalledTimes(1)
    expect((await receipt(1)).data).toEqual({})
    const alteredAck = vi.fn(async () => 1)
    await expect(inbox.commitBatch({ installationId: id, envelopes: [{ ...envelope(1), data: { text: 'altered' } }],
      rawQuarantined: [], cursor: 'cursor', leaseToken: 'lease', ack: alteredAck })).rejects.toThrow('feed integrity violation')
    expect(alteredAck).not.toHaveBeenCalled()
  })

  test('fourteen days deletes the handled prefix and commits its replay floor', async () => {
    await seed(1, '15 days'); await seed(2, '8 days'); await seed(3, '1 day')
    expect(await sweep()).toMatchObject({ reclaimed: 2, deleted: 1, metadataBlocked: true })
    expect(await receipt(1)).toBeUndefined()
    expect((await receipt(2)).body_reclaimed_at).toBeInstanceOf(Date)
    expect((await receipt(3)).data).toEqual(envelope(3).data)
    expect(await checkpoint()).toEqual({ last_ack_feed_id: '3', gc_feed_id: '1' })
  })

  test('expired replay fails the entire batch before insert or ACK and fences polling', async () => {
    await seed(1, '15 days'); await sweep()
    const ack = vi.fn(async () => 2)
    await expect(inbox.commitBatch({ installationId: id, envelopes: [envelope(2), envelope(1)],
      rawQuarantined: [], cursor: 'cursor', leaseToken: 'lease', ack })).rejects.toBeInstanceOf(FeedReplayExpiredError)
    expect(ack).not.toHaveBeenCalled()
    expect(await receipt(2)).toBeUndefined()
    expect((await pool.query(`SELECT local_status,last_error_code FROM memory_installations WHERE installation_id=$1`, [id])).rows[0])
      .toEqual({ local_status: 'integrity_error', last_error_code: 'inbox_replay_expired' })
    expect(await checkpoint()).toEqual({ last_ack_feed_id: '1', gc_feed_id: '1' })
  })

  test('consumer leaves expired replay unacknowledged and skips the fenced installation thereafter', async () => {
    await seed(1, '15 days'); await sweep()
    const pull = vi.fn(async () => ({ installation_id: id, items: [envelope(1)], next_cursor: 'cursor', lease_token: 'lease', lease_expires_at: new Date().toISOString() }))
    const ack = vi.fn(async () => 1)
    const consumer = createFeedConsumer({ pool, workerId: 'test', signal: new AbortController().signal, pullFeed: pull, ackFeed: ack })
    await consumer.runOnce(); await consumer.runOnce()
    expect(ack).not.toHaveBeenCalled(); expect(pull).toHaveBeenCalledTimes(1)
  })

  test('an already-running snapshot cannot clear a rejected expired replay fence', async () => {
    await seed(1, '20 days'); await sweep()
    const snapshots = createSnapshotRepository(pool)
    const run = await snapshots.startRun(id)
    await expect(commit(1)).rejects.toBeInstanceOf(FeedReplayExpiredError)
    await expect(snapshots.finalizeRun({ installationId: id, generation: run.generation,
      inventorySessionIds: [], sessionsSeen: 0, eventsSeen: 0 })).rejects.toThrow('snapshot_installation_unavailable')
    expect((await pool.query(`SELECT count(*)::int n FROM source_events WHERE installation_id=$1`, [id])).rows[0].n).toBe(1)
    expect((await pool.query(`SELECT last_error_code FROM memory_installations WHERE installation_id=$1`, [id])).rows[0].last_error_code).toBe('inbox_replay_expired')
  })

  test.each(['pending', 'quarantined', 'purged'])('%s record blocks metadata prefix advancement and is preserved', async state => {
    await seed(1, '20 days', state); await seed(2, '20 days')
    expect(await sweep()).toMatchObject({ reclaimed: 1, deleted: 0, metadataBlocked: true })
    expect((await receipt(1)).data).toEqual(envelope(1).data)
    expect(await checkpoint()).toEqual({ last_ack_feed_id: '2', gc_feed_id: '0' })
  })

  test('a young lower ID prevents deleting later old metadata, without blocking body reclamation', async () => {
    await seed(1, '1 day'); await seed(2, '20 days')
    expect(await sweep()).toMatchObject({ reclaimed: 1, deleted: 0 })
    expect(await receipt(2)).toBeDefined()
    expect((await checkpoint()).gc_feed_id).toBe('0')
  })

  test('source/receipt age is irrelevant: both thresholds use successful projection time', async () => {
    await seed(1, '7 days - 1 minute'); await seed(2, '7 days + 1 minute')
    await pool.query(`UPDATE memory_feed_inbox SET received_at=NOW()-INTERVAL '100 days'`)
    expect(await sweep()).toMatchObject({ reclaimed: 1, deleted: 0 })
    expect((await receipt(1)).body_reclaimed_at).toBeNull()
    expect((await receipt(2)).body_reclaimed_at).toBeInstanceOf(Date)
  })

  test('fourteen-day boundary is independent of body reclamation time', async () => {
    await seed(1, '14 days - 1 minute')
    expect(await sweep()).toMatchObject({ reclaimed: 1, deleted: 0 })
    await pool.query(`UPDATE memory_feed_inbox SET projected_at=NOW()-INTERVAL '14 days 1 minute'`)
    expect(await sweep()).toMatchObject({ reclaimed: 0, deleted: 1 })
  })

  test('a checkpoint write failure rolls back body clearing and metadata deletion together', async () => {
    await seed(1, '20 days')
    await pool.query(`CREATE FUNCTION retention_test_fail_gc() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.gc_feed_id>OLD.gc_feed_id THEN RAISE EXCEPTION 'injected GC failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER retention_test_fail_gc BEFORE UPDATE ON memory_inbox_checkpoints
      FOR EACH ROW EXECUTE FUNCTION retention_test_fail_gc()`)
    try {
      await expect(sweep()).rejects.toThrow('injected GC failure')
      expect((await receipt(1)).data).toEqual(envelope(1).data)
      expect((await receipt(1)).body_reclaimed_at).toBeNull()
      expect((await checkpoint()).gc_feed_id).toBe('0')
    } finally {
      await pool.query('DROP TRIGGER retention_test_fail_gc ON memory_inbox_checkpoints; DROP FUNCTION retention_test_fail_gc()')
    }
  })

  test('failed ACK cannot bootstrap the watermark, including after an upgrade', async () => {
    await expect(commit(1, async () => { throw new Error('ACK unavailable') })).rejects.toThrow('ACK unavailable')
    await createSourceProjector(pool).projectOnce(id)
    await pool.query(`UPDATE memory_feed_inbox SET projected_at=NOW()-INTERVAL '20 days'`)
    expect(await checkpoint()).toBeUndefined()
    expect(await sweep()).toMatchObject({ skipped: 'unacknowledged', reclaimed: 0, deleted: 0 })
    await commit(1)
    expect(await sweep()).toMatchObject({ reclaimed: 1, deleted: 1 })
  })

  test('ACK watermark is monotonic and cannot reclaim receipts beyond the confirmed position', async () => {
    await seed(1, '20 days')
    await commit(2, async () => 0)
    await createSourceProjector(pool).projectOnce(id)
    await pool.query(`UPDATE memory_feed_inbox SET projected_at=NOW()-INTERVAL '20 days' WHERE feed_id=2`)
    expect((await checkpoint()).last_ack_feed_id).toBe('1')
    expect(await sweep()).toMatchObject({ reclaimed: 1, deleted: 1 })
    expect((await receipt(2)).body_reclaimed_at).toBeNull()
    await inbox.commitBatch({ installationId: id, envelopes: [], rawQuarantined: [], cursor: 'empty', leaseToken: 'lease', ack: async () => 2 })
    expect(await sweep()).toMatchObject({ reclaimed: 1, deleted: 1 })
  })

  test.each(['running', 'completed'])('%s snapshot blocks reclamation until safe', async state => {
    await seed(1, '20 days')
    await pool.query(`INSERT INTO memory_snapshot_runs(run_id,installation_id,generation,state) VALUES(gen_random_uuid(),$1,1,$2)`, [id, state])
    expect(await sweep()).toMatchObject({ skipped: 'snapshot', reclaimed: 0, deleted: 0 })
    await pool.query(`UPDATE memory_snapshot_runs SET state='completed',relay_acked_at=NOW()`)
    expect(await sweep()).toMatchObject({ reclaimed: 1, deleted: 1 })
  })

  test('a later snapshot rebuilds from Relay history without requeueing reclaimed old bodies', async () => {
    await seed(1, '8 days'); await sweep()
    const snapshots = createSnapshotRepository(pool)
    const run = await snapshots.startRun(id)
    const payload = { ...envelope(1).data, turn_id: 'retention-turn' }
    await snapshots.persistSessionEvents(id, run.generation, 'retention-session', [{
      event_id: '101', event_type: 'agent_text', payload, created_at: '2026-01-01T00:00:00.000Z',
    }])
    await snapshots.finalizeRun({ installationId: id, generation: run.generation,
      inventorySessionIds: ['retention-session'], sessionsSeen: 1, eventsSeen: 1 })
    expect((await receipt(1)).projection_state).toBe('projected')
    expect((await receipt(1)).body_reclaimed_at).toBeInstanceOf(Date)
    expect((await receipt(1)).data).toEqual({})
    expect((await pool.query(`SELECT origin,payload FROM source_events WHERE installation_id=$1`, [id])).rows)
      .toEqual([{ origin: 'snapshot', payload }])
  })

  test('snapshot_required and off mode preserve data', async () => {
    await seed(1, '20 days')
    expect(await sweep({ mode: 'off' })).toMatchObject({ reclaimed: 0, deleted: 0 })
    await pool.query(`UPDATE memory_installations SET snapshot_required=TRUE WHERE installation_id=$1`, [id])
    expect(await sweep()).toMatchObject({ skipped: 'snapshot', reclaimed: 0, deleted: 0 })
  })

  test('batch limit makes bounded progress without crossing an unhandled receipt', async () => {
    for (const feedId of [1, 2, 3]) await seed(feedId, '20 days')
    expect(await sweep({ batchSize: 1 })).toMatchObject({ reclaimed: 1, deleted: 1 })
    expect((await checkpoint()).gc_feed_id).toBe('1')
    expect(await sweep({ batchSize: 1 })).toMatchObject({ reclaimed: 1, deleted: 1 })
    expect((await checkpoint()).gc_feed_id).toBe('2')
  })

  test('lifecycle ownership skips a sweep; snapshot start shares the same fence', async () => {
    await seed(1, '20 days')
    const lock = await pool.connect()
    await lock.query('BEGIN')
    await lock.query(`SELECT pg_advisory_xact_lock(hashtextextended('purge:installation:'||$1,0))`, [id])
    try {
      expect(await sweep()).toMatchObject({ skipped: 'busy' })
      let started = false
      const run = createSnapshotRepository(pool).startRun(id).then(value => { started = true; return value })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(started).toBe(false)
      await lock.query('COMMIT')
      await run
      expect(await sweep()).toMatchObject({ skipped: 'snapshot' })
    } finally { await lock.query('ROLLBACK'); lock.release() }
  })

  test('projector refuses accidentally requeued reclaimed bodies', async () => {
    await seed(1, '8 days'); await sweep()
    await pool.query(`UPDATE memory_feed_inbox SET projection_state='pending'`)
    await expect(createSourceProjector(pool).projectOnce(id)).rejects.toThrow('inbox_body_unavailable')
    expect((await pool.query(`SELECT payload FROM source_events WHERE installation_id=$1`, [id])).rows[0].payload).toEqual(envelope(1).data)
  })

  test('installation privacy purge erases the checkpoint along with inbox receipts', async () => {
    await seed(1, '8 days'); await sweep()
    await createPurgeRepository(pool, { hmacKey: 'retention-test-key' }).purgeInstallation({
      installationId: id, requestId: '72727272-7272-4272-8272-727272727272', reason: 'revoked',
    })
    expect(await checkpoint()).toBeUndefined()
    expect(await receipt(1)).toBeUndefined()
  })

  test('an ACK returning after privacy purge cannot recreate the checkpoint', async () => {
    await commit(1, async () => {
      await createPurgeRepository(pool, { hmacKey: 'retention-test-key' }).purgeInstallation({
        installationId: id, requestId: '73737373-7373-4373-8373-737373737373', reason: 'revoked',
      })
      return 1
    })
    expect(await checkpoint()).toBeUndefined()
    expect(await receipt(1)).toBeUndefined()
  })

  test('scheduler coalesces overlapping passes and stops before pool shutdown', async () => {
    await seed(1, '8 days')
    const results: unknown[] = []
    const worker = createInboxRetentionWorker({ pool, settings, signal: new AbortController().signal, onResult: r => results.push(r) })
    const a = worker.runOnce(), b = worker.runOnce()
    expect(a).toBe(b)
    await worker.stop(); await a
    await worker.runOnce()
    expect(results.length).toBeLessThanOrEqual(1)
  })
})
