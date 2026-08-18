import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { initDB } from '../db.js'
import { createInboxWorker } from '../inbox-worker.js'
import { InboxRepository, LostClaimError } from '../ingress/inbox-repository.js'
import { RealtimeOutboxWriter } from '../materialization/realtime-outbox.js'
import type { IngressEnvelope } from '../ingress/types.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const integrationEnabled = Boolean(databaseUrl && process.env.RUN_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = integrationEnabled ? describe : describe.skip

function event(
  seq: number,
  overrides: Partial<IngressEnvelope> = {},
): IngressEnvelope {
  return {
    userId: null,
    daemonId: 'd1',
    registrationId: 'registration-1',
    daemonGeneration: 17,
    seq,
    dedupKey: `event-${seq}`,
    sessionId: 'session-1',
    eventType: 'agent_event',
    priority: 'live',
    payload: { agent: 'opencode', nested: { seq } },
    materializationContext: {},
    receivedAt: new Date('2026-07-28T08:00:00.000Z'),
    ...overrides,
  }
}

function checkpoint(
  result: Map<string, { ackSeq: number }>,
  daemonId = 'd1',
  generation = 17,
): number {
  return result.get(`${daemonId}\0${generation}`)?.ackSeq ?? -1
}

describeWithDatabase('InboxRepository PostgreSQL integration', () => {
  let pool: pg.Pool
  let repo: InboxRepository

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 8 })
    const database = await pool.query<{ database_name: string }>(
      'SELECT current_database() AS database_name',
    )
    const databaseName = database.rows[0]?.database_name ?? ''
    if (!/test/i.test(databaseName)) {
      throw new Error(`Refusing PostgreSQL integration test against non-test database: ${databaseName || '<unknown>'}`)
    }
    await initDB(pool)
    repo = new InboxRepository(pool)
  }, 30_000)

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE realtime_outbox, event_inbox_receipt, event_inbox, daemon_ack_checkpoint, events RESTART IDENTITY CASCADE',
    )
  })

  test('advances only across contiguous receipts and restores seeded checkpoints', async () => {
    expect(checkpoint(await repo.persistBatch([event(1), event(3)]))).toBe(1)
    expect(checkpoint(await repo.persistBatch([event(2)]))).toBe(3)

    expect((await new InboxRepository(pool).seedCheckpoint('d1', 17, 50)).ackSeq).toBe(50)
    expect(checkpoint(await new InboxRepository(pool).persistBatch([event(51), event(52)]))).toBe(52)
    expect((await repo.seedCheckpoint('d1', 17, 4)).ackSeq).toBe(52)
  })

  test('advances one checkpoint across durable and receipt-only events', async () => {
    expect(checkpoint(await repo.persistBatch([
      event(1, { dedupKey: 'durable-1' }),
      event(2, {
        dedupKey: 'ephemeral-2',
        eventType: 'generate_subagent_title_request',
        priority: 'aggregate',
        receiptOnly: true,
      }),
      event(3, { dedupKey: 'durable-3' }),
    ]))).toBe(3)

    const counts = await pool.query<{ inbox: number; receipts: number; receipt_only: number }>(`
      SELECT
        (SELECT COUNT(*)::int FROM event_inbox) AS inbox,
        (SELECT COUNT(*)::int FROM event_inbox_receipt) AS receipts,
        (SELECT COUNT(*)::int FROM event_inbox_receipt WHERE inbox_id IS NULL) AS receipt_only
    `)
    expect(counts.rows[0]).toEqual({ inbox: 2, receipts: 3, receipt_only: 1 })
  })

  test('rejects a transport coordinate remapped to another canonical event without partial commit', async () => {
    expect(checkpoint(await repo.persistBatch([
      event(2, { dedupKey: 'original-gap-receipt' }),
    ]))).toBe(0)

    await expect(repo.persistBatch([
      event(2, { dedupKey: 'conflicting-replay' }),
      event(1, { dedupKey: 'fills-gap' }),
    ])).rejects.toThrow('transport coordinate canonical mismatch')

    const checkpointRow = await pool.query<{ ack_seq: string }>(
      `SELECT ack_seq FROM daemon_ack_checkpoint
       WHERE daemon_id = 'd1' AND daemon_generation = 17`,
    )
    const canonical = await pool.query<{ dedup_key: string }>(
      `SELECT dedup_key FROM event_inbox ORDER BY dedup_key`,
    )
    const receipts = await pool.query<{ seq: string; dedup_key: string }>(
      `SELECT receipt.seq, inbox.dedup_key
       FROM event_inbox_receipt receipt
       JOIN event_inbox inbox ON inbox.inbox_id = receipt.inbox_id
       ORDER BY receipt.seq`,
    )
    expect(checkpointRow.rows).toEqual([{ ack_seq: '0' }])
    expect(canonical.rows).toEqual([{ dedup_key: 'original-gap-receipt' }])
    expect(receipts.rows).toEqual([{ seq: '2', dedup_key: 'original-gap-receipt' }])
  })

  test('acks replay below a retained checkpoint without recreating a cleaned inbox row', async () => {
    await repo.seedCheckpoint('d1', 17, 100)
    const result = await repo.persistBatch([event(42)])
    expect(checkpoint(result)).toBe(100)

    const inbox = await pool.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM event_inbox')
    const receipts = await pool.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM event_inbox_receipt')
    expect({ inbox: inbox.rows[0].count, receipts: receipts.rows[0].count }).toEqual({ inbox: 0, receipts: 0 })
  })

  test('stores one canonical payload and separate receipts across generations', async () => {
    const originalPayload = { agent: 'opencode', native: { role: 'build', untouched: true } }
    const originalContext = {
      agentType: 'codex', cwd: '/workspace', requestId: 'request-1',
      reservationId: 'reservation-1', hostname: 'host-1',
    }
    const first = event(1, {
      dedupKey: 'stable-1', payload: originalPayload,
      materializationContext: originalContext,
    })
    const replay = event(9, {
      daemonGeneration: 18,
      registrationId: 'registration-2',
      dedupKey: 'stable-1',
      payload: { agent: 'codex', mustNotReplaceCanonical: true },
      materializationContext: { hostname: 'must-not-replace' },
    })

    const [firstAck, replayAck] = await Promise.all([
      new InboxRepository(pool).persistBatch([first]),
      new InboxRepository(pool).persistBatch([replay]),
    ])
    expect(checkpoint(firstAck)).toBe(1)
    expect(checkpoint(replayAck, 'd1', 18)).toBe(0)

    await repo.seedCheckpoint('d1', 18, 8)
    expect(checkpoint(await repo.persistBatch([replay]), 'd1', 18)).toBe(9)

    const canonical = await pool.query<{ payload: unknown; materialization_context: unknown }>(
      `SELECT payload, materialization_context FROM event_inbox WHERE dedup_key = 'stable-1'`,
    )
    const receipts = await pool.query<{ daemon_generation: string; seq: string }>(
      `SELECT daemon_generation, seq FROM event_inbox_receipt
       WHERE inbox_id = (SELECT inbox_id FROM event_inbox WHERE dedup_key = 'stable-1')
       ORDER BY daemon_generation`,
    )
    expect(canonical.rows).toEqual([{
      payload: originalPayload,
      materialization_context: originalContext,
    }])
    expect(receipts.rows).toEqual([
      { daemon_generation: '17', seq: '1' },
      { daemon_generation: '18', seq: '9' },
    ])
  })

  test('deduplicates two Relay writers without duplicate canonical rows', async () => {
    const batch = Array.from({ length: 256 }, (_, index) => event(index + 1))
    const [left, right] = await Promise.all([
      new InboxRepository(pool).persistBatch(batch),
      new InboxRepository(pool).persistBatch(batch),
    ])
    expect(checkpoint(left)).toBe(256)
    expect(checkpoint(right)).toBe(256)

    const counts = await pool.query<{ inbox: number; receipts: number }>(`
      SELECT
        (SELECT COUNT(*)::int FROM event_inbox) AS inbox,
        (SELECT COUNT(*)::int FROM event_inbox_receipt) AS receipts
    `)
    expect(counts.rows[0]).toEqual({ inbox: 256, receipts: 256 })
  })

  test('does not retain rows or checkpoints when COMMIT fails', async () => {
    const rollbackAtCommitPool = {
      async connect() {
        const client = await pool.connect()
        return {
          async query(...args: Parameters<typeof client.query>) {
            if (args[0] === 'COMMIT') {
              await client.query('ROLLBACK')
              throw new Error('injected commit failure')
            }
            return await (client.query as (...queryArgs: typeof args) => Promise<unknown>)(...args)
          },
          release() {
            client.release()
          },
        }
      },
    }
    const failing = new InboxRepository(rollbackAtCommitPool as never)
    await expect(failing.persistBatch([event(1)])).rejects.toThrow('injected commit failure')

    const counts = await pool.query<{ inbox: number; receipts: number; checkpoints: number }>(`
      SELECT
        (SELECT COUNT(*)::int FROM event_inbox) AS inbox,
        (SELECT COUNT(*)::int FROM event_inbox_receipt) AS receipts,
        (SELECT COUNT(*)::int FROM daemon_ack_checkpoint) AS checkpoints
    `)
    expect(counts.rows[0]).toEqual({ inbox: 0, receipts: 0, checkpoints: 0 })
  })

  test('claims by priority and records reschedule and completion state', async () => {
    await repo.persistBatch([
      event(1, { priority: 'live' }),
      event(2, { priority: 'control', daemonId: 'd2', daemonGeneration: 18, sessionId: 'session-2' }),
    ])

    const first = await repo.claimBatch({
      workerId: 'worker-1',
      limit: 1,
      shardCount: 1,
      shardIndex: 0,
    })
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({
      seq: 2,
      status: 1,
      attempts: 1,
      claimedBy: 'worker-1',
      payload: { agent: 'opencode', nested: { seq: 2 } },
    })

    const retryAt = new Date('2030-01-01T00:00:00.000Z')
    await repo.reschedule(first[0].inboxId, first[0].attempts, retryAt, 'transient materialization error', 'worker-1')
    const rescheduled = await pool.query(
      `SELECT status, attempts, available_at, claimed_at, claimed_by, last_error
       FROM event_inbox WHERE inbox_id = $1`,
      [first[0].inboxId],
    )
    expect(rescheduled.rows[0]).toMatchObject({
      status: 0,
      attempts: 1,
      claimed_at: null,
      claimed_by: null,
      last_error: 'transient materialization error',
    })
    expect(new Date(rescheduled.rows[0].available_at).toISOString()).toBe(retryAt.toISOString())

    const second = await repo.claimBatch({
      workerId: 'worker-2',
      limit: 10,
      shardCount: 1,
      shardIndex: 0,
    })
    expect(second.map((row) => row.seq)).toEqual([1])

    const materialized = await pool.query<{ id: string }>(
      `INSERT INTO events (session_id, event_type, payload)
       VALUES ('session-1', 'agent_event', '{"materialized":true}'::jsonb)
       RETURNING id`,
    )
    await repo.complete(second[0].inboxId, Number(materialized.rows[0].id), 'worker-2', second[0].attempts)
    const completed = await pool.query(
      `SELECT status, materialized_event_id, completed_at, claimed_at, claimed_by, last_error
       FROM event_inbox WHERE inbox_id = $1`,
      [second[0].inboxId],
    )
    expect(completed.rows[0]).toMatchObject({
      status: 2,
      materialized_event_id: materialized.rows[0].id,
      claimed_at: null,
      claimed_by: null,
      last_error: null,
    })
    expect(completed.rows[0].completed_at).toBeInstanceOf(Date)
  })

  test('returns eligible daemon heads in stable priority, receipt time, and inbox order', async () => {
    await repo.persistBatch([
      event(1, { priority: 'control', daemonId: 'd1' }),
      event(2, { priority: 'aggregate', daemonId: 'd2' }),
      event(3, { priority: 'replay', daemonId: 'd3' }),
      event(4, { priority: 'aggregate', daemonId: 'd4' }),
      event(5, { priority: 'aggregate', daemonId: 'd5' }),
    ])
    await pool.query(`
      UPDATE event_inbox
      SET available_at = CASE seq
        WHEN 1 THEN '2026-07-28T08:04:00.000Z'::timestamptz
        WHEN 2 THEN '2026-07-28T08:02:00.000Z'::timestamptz
        WHEN 3 THEN '2026-07-28T08:03:00.000Z'::timestamptz
        WHEN 4 THEN '2026-07-28T08:01:00.000Z'::timestamptz
        WHEN 5 THEN '2026-07-28T08:01:00.000Z'::timestamptz
      END
    `)

    const claimed = await repo.claimBatch({
      workerId: 'ordered-worker',
      limit: 10,
      shardCount: 1,
      shardIndex: 0,
    })

    expect(claimed.map((row) => row.seq)).toEqual([1, 3, 2, 4, 5])
  })

  test('filters claims by daemon shard without splitting a daemon sequence', async () => {
    await repo.persistBatch(Array.from({ length: 8 }, (_, index) => event(1, {
      daemonId: `daemon-${index + 1}`,
      daemonGeneration: index + 1,
      dedupKey: `daemon-event-${index + 1}`,
    })))

    const even = await repo.claimBatch({
      workerId: 'even-worker',
      limit: 10,
      shardCount: 2,
      shardIndex: 0,
    })
    const odd = await repo.claimBatch({
      workerId: 'odd-worker',
      limit: 10,
      shardCount: 2,
      shardIndex: 1,
    })

    const evenIds = new Set(even.map((row) => row.inboxId))
    const oddIds = new Set(odd.map((row) => row.inboxId))
    expect(evenIds.size + oddIds.size).toBe(8)
    expect([...evenIds].every((id) => !oddIds.has(id))).toBe(true)
  })

  test('keeps two transactional workers disjoint with SKIP LOCKED', async () => {
    await repo.persistBatch(Array.from({ length: 6 }, (_, index) => event(1, {
      daemonId: `daemon-${index + 1}`,
      daemonGeneration: index + 1,
      dedupKey: `worker-event-${index + 1}`,
    })))
    const workerOneClient = await pool.connect()
    await workerOneClient.query('BEGIN')
    try {
      const workerOne = new InboxRepository({
        query: (...args: Parameters<typeof workerOneClient.query>) =>
          (workerOneClient.query as (...queryArgs: typeof args) => Promise<unknown>)(...args),
      } as never)
      const first = await workerOne.claimBatch({
        workerId: 'worker-one',
        limit: 2,
        shardCount: 1,
        shardIndex: 0,
      })
      const second = await repo.claimBatch({
        workerId: 'worker-two',
        limit: 10,
        shardCount: 1,
        shardIndex: 0,
      })
      await workerOneClient.query('COMMIT')

      const firstIds = new Set(first.map((row) => row.inboxId))
      expect(first).toHaveLength(2)
      expect(second).toHaveLength(4)
      expect(second.every((row) => !firstIds.has(row.inboxId))).toBe(true)
      expect(new Set([...first, ...second].map((row) => row.inboxId)).size).toBe(6)
    } catch (error) {
      await workerOneClient.query('ROLLBACK')
      throw error
    } finally {
      workerOneClient.release()
    }
  })

  test('claims only the strict minimum pending sequence for a daemon generation', async () => {
    await repo.persistBatch([event(1), event(2), event(3)])

    const first = await repo.claimBatch({ workerId: 'ordered', limit: 10, shardCount: 1, shardIndex: 0 })
    expect(first.map((entry) => entry.seq)).toEqual([1])
    const materialized = await pool.query<{ id: string }>(
      `INSERT INTO events (session_id, event_type, payload)
       VALUES ('session-1', 'agent_event', '{"materialized":true}'::jsonb)
       RETURNING id`,
    )
    await repo.complete(first[0].inboxId, Number(materialized.rows[0].id), 'ordered', first[0].attempts)

    const second = await repo.claimBatch({ workerId: 'ordered', limit: 10, shardCount: 1, shardIndex: 0 })
    expect(second.map((entry) => entry.seq)).toEqual([2])
  })

  test('blocks later rows while the stream head is retry-delayed', async () => {
    await repo.persistBatch([event(1), event(2), event(3)])
    const head = (await repo.claimBatch({
      workerId: 'retry-worker',
      limit: 1,
      shardCount: 1,
      shardIndex: 0,
    }))[0]
    expect(head.seq).toBe(1)

    await repo.reschedule(
      head.inboxId,
      head.attempts,
      new Date('2030-01-01T00:00:00.000Z'),
      'transient materialization error',
      'retry-worker',
    )

    const blocked = await repo.claimBatch({
      workerId: 'retry-worker',
      limit: 10,
      shardCount: 1,
      shardIndex: 0,
    })
    expect(blocked).toEqual([])

    await pool.query(
      `UPDATE event_inbox SET available_at = NOW() - INTERVAL '1 second' WHERE inbox_id = $1`,
      [head.inboxId],
    )
    const released = await repo.claimBatch({
      workerId: 'retry-worker',
      limit: 10,
      shardCount: 1,
      shardIndex: 0,
    })
    expect(released.map((row) => row.seq)).toEqual([1])
    expect(released[0].attempts).toBe(2)
  })

  test('does not substitute the next row of a stream whose head another worker locked', async () => {
    await repo.persistBatch([event(1), event(2)])
    const workerOneClient = await pool.connect()
    await workerOneClient.query('BEGIN')
    try {
      const workerOne = new InboxRepository({
        query: (...args: Parameters<typeof workerOneClient.query>) =>
          (workerOneClient.query as (...queryArgs: typeof args) => Promise<unknown>)(...args),
      } as never)
      const claimed = await workerOne.claimBatch({
        workerId: 'head-holder',
        limit: 5,
        shardCount: 1,
        shardIndex: 0,
      })
      expect(claimed.map((row) => row.seq)).toEqual([1])

      const byOther = await repo.claimBatch({
        workerId: 'other-worker',
        limit: 5,
        shardCount: 1,
        shardIndex: 0,
      })
      expect(byOther).toEqual([])
      await workerOneClient.query('COMMIT')
    } catch (error) {
      await workerOneClient.query('ROLLBACK')
      throw error
    } finally {
      workerOneClient.release()
    }
  })

  test('releases the successor of a dead-lettered stream head on the next claim', async () => {
    await repo.persistBatch([event(1), event(2)])
    const head = (await repo.claimBatch({
      workerId: 'dead-letter-worker',
      limit: 1,
      shardCount: 1,
      shardIndex: 0,
    }))[0]
    expect(head.seq).toBe(1)

    await repo.deadLetter(head.inboxId, head.attempts, 'poison payload', 'dead-letter-worker')

    const successor = await repo.claimBatch({
      workerId: 'dead-letter-worker',
      limit: 10,
      shardCount: 1,
      shardIndex: 0,
    })
    expect(successor.map((row) => row.seq)).toEqual([2])
    expect(successor[0].attempts).toBe(1)
  })

  test('yields one independent stream head per daemon generation of the same daemon id', async () => {
    await repo.persistBatch([
      event(1, { daemonGeneration: 17, dedupKey: 'gen17-seq1' }),
      event(2, { daemonGeneration: 17, dedupKey: 'gen17-seq2' }),
      event(1, { daemonGeneration: 18, registrationId: 'registration-2', dedupKey: 'gen18-seq1' }),
      event(2, { daemonGeneration: 18, registrationId: 'registration-2', dedupKey: 'gen18-seq2' }),
    ])

    const claimed = await repo.claimBatch({
      workerId: 'generation-worker',
      limit: 10,
      shardCount: 1,
      shardIndex: 0,
    })
    expect(claimed).toHaveLength(2)
    expect(claimed.map((row) => [row.daemonGeneration, row.seq]))
      .toEqual([[17, 1], [18, 1]])
  })

  test('recovers a stale claim without losing payload or attempts and fences the old owner', async () => {
    await repo.persistBatch([event(1)])
    const oldClaim = (await repo.claimBatch({
      workerId: 'worker-old',
      limit: 1,
      shardCount: 1,
      shardIndex: 0,
    }))[0]
    await pool.query(
      `UPDATE event_inbox
       SET claimed_at = NOW() - INTERVAL '301 seconds'
       WHERE inbox_id = $1`,
      [oldClaim.inboxId],
    )

    await expect(repo.resetStaleClaims(300_000, 1_000)).resolves.toBe(1)
    const recovered = await pool.query(
      `SELECT status, attempts, seq, priority_class, payload, claimed_at, claimed_by
       FROM event_inbox
       WHERE inbox_id = $1`,
      [oldClaim.inboxId],
    )
    expect(recovered.rows[0]).toMatchObject({
      status: 0,
      attempts: 1,
      seq: '1',
      priority_class: 1,
      payload: { agent: 'opencode', nested: { seq: 1 } },
      claimed_at: null,
      claimed_by: null,
    })

    const newClaim = (await repo.claimBatch({
      workerId: 'worker-new',
      limit: 1,
      shardCount: 1,
      shardIndex: 0,
    }))[0]
    expect(newClaim.attempts).toBe(2)
    await expect(repo.complete(oldClaim.inboxId, null, 'worker-old', oldClaim.attempts))
      .rejects.toBeInstanceOf(LostClaimError)
    await expect(repo.reschedule(
      oldClaim.inboxId,
      oldClaim.attempts,
      new Date(),
      'stale',
      'worker-old',
    )).rejects.toBeInstanceOf(LostClaimError)
    await expect(repo.deadLetter(oldClaim.inboxId, oldClaim.attempts, 'stale', 'worker-old'))
      .rejects.toBeInstanceOf(LostClaimError)
    await expect(repo.complete(newClaim.inboxId, null, 'worker-new', newClaim.attempts))
      .resolves.toBeUndefined()
  })

  test('concurrent stale-claim sweepers reset a row only once', async () => {
    await repo.persistBatch([event(1)])
    const claimed = (await repo.claimBatch({
      workerId: 'worker-old',
      limit: 1,
      shardCount: 1,
      shardIndex: 0,
    }))[0]
    await pool.query(
      `UPDATE event_inbox
       SET claimed_at = NOW() - INTERVAL '301 seconds'
       WHERE inbox_id = $1`,
      [claimed.inboxId],
    )

    const [left, right] = await Promise.all([
      repo.resetStaleClaims(300_000, 1_000),
      new InboxRepository(pool).resetStaleClaims(300_000, 1_000),
    ])
    expect(left + right).toBe(1)
  })

  test('renews an active claim fence and lets it become reclaimable after heartbeats stop', async () => {
    await repo.persistBatch([event(1)])
    const claimed = (await repo.claimBatch({
      workerId: 'worker-live',
      limit: 1,
      shardCount: 1,
      shardIndex: 0,
    }))[0]
    await pool.query(
      `UPDATE event_inbox
       SET claimed_at = NOW() - INTERVAL '301 seconds'
       WHERE inbox_id = $1`,
      [claimed.inboxId],
    )

    await expect(repo.renewClaims(
      [{ inboxId: claimed.inboxId, attempts: claimed.attempts }],
      'worker-live',
    )).resolves.toEqual(new Set([claimed.inboxId]))
    await expect(repo.renewClaims(
      [{ inboxId: claimed.inboxId, attempts: claimed.attempts }],
      'worker-stale',
    )).resolves.toEqual(new Set())
    await expect(repo.resetStaleClaims(300_000, 1_000)).resolves.toBe(0)

    await pool.query(
      `UPDATE event_inbox
       SET claimed_at = NOW() - INTERVAL '301 seconds'
       WHERE inbox_id = $1`,
      [claimed.inboxId],
    )
    await expect(repo.resetStaleClaims(300_000, 1_000)).resolves.toBe(1)
  })

  test('persists 10,000 rows in 256-row batches with a durable checkpoint', async () => {
    for (let start = 1; start <= 10_000; start += 256) {
      const end = Math.min(start + 255, 10_000)
      const batch = Array.from({ length: end - start + 1 }, (_, index) => event(start + index))
      expect(checkpoint(await repo.persistBatch(batch))).toBe(end)
    }

    const rebuilt = new InboxRepository(pool)
    const checkpointRow = await rebuilt.seedCheckpoint('d1', 17, 0)
    const counts = await pool.query<{ inbox: number; receipts: number }>(`
      SELECT
        (SELECT COUNT(*)::int FROM event_inbox) AS inbox,
        (SELECT COUNT(*)::int FROM event_inbox_receipt) AS receipts
    `)
    expect(checkpointRow.ackSeq).toBe(10_000)
    expect(counts.rows[0]).toEqual({ inbox: 10_000, receipts: 10_000 })
  }, 30_000)

  test('worker drains a two-daemon backlog through bounded passes in strict per-daemon seq order', async () => {
    await repo.persistBatch([
      ...Array.from({ length: 100 }, (_, index) => event(index + 1)),
      ...Array.from({ length: 10 }, (_, index) => event(index + 1, {
        daemonId: 'd2',
        daemonGeneration: 18,
        registrationId: 'registration-2',
        sessionId: 'session-2',
        dedupKey: `d2-event-${index + 1}`,
      })),
    ])

    const seen: Array<{ daemonId: string; seq: number }> = []
    const materializer = {
      materialize: vi.fn(async (input: {
        inboxId: number; daemonId: string; sessionId: string | null;
        eventType: string; payload: { nested?: { seq?: number } };
      }) => {
        seen.push({ daemonId: input.daemonId, seq: Number(input.payload.nested?.seq ?? -1) })
        const inserted = await pool.query<{ id: string }>(
          `INSERT INTO events (session_id, event_type, payload)
           VALUES ($1, $2, $3::jsonb)
           RETURNING id`,
          [input.sessionId, input.eventType, JSON.stringify(input.payload)],
        )
        const eventId = Number(inserted.rows[0].id)
        return {
          eventId,
          deliveries: [{
            eventId,
            userId: null,
            audience: 'session' as const,
            sessionId: input.sessionId,
            requestId: null,
            ordinal: 0,
            deliveryKey: `drain:${input.inboxId}`,
            type: input.eventType,
            payload: input.payload,
          }],
        }
      }),
    }
    const worker = createInboxWorker({
      repository: new InboxRepository(pool),
      materializer: materializer as never,
      outboxWriter: new RealtimeOutboxWriter(pool),
      workerId: 'drain-worker',
      shardCount: 1,
      shardIndex: 0,
      maxDrainPasses: 8,
    })

    // Bounded drain forces several outer runs; every run must keep per-daemon
    // seq order without waiting on a wall-clock timer between claims.
    for (let round = 0; seen.length < 110 && round < 20; round += 1) {
      await worker.runOnce()
    }
    expect(seen).toHaveLength(110)

    for (const daemonId of ['d1', 'd2']) {
      const seqs = seen.filter(entry => entry.daemonId === daemonId).map(entry => entry.seq)
      expect(seqs).toHaveLength(daemonId === 'd1' ? 100 : 10)
      expect(seqs).toEqual([...seqs].sort((left, right) => left - right))
    }
    expect(new Set(seen.map(entry => `${entry.daemonId}:${entry.seq}`)).size).toBe(110)

    const statuses = await pool.query<{ status: number; count: number }>(
      'SELECT status, COUNT(*)::int AS count FROM event_inbox GROUP BY status ORDER BY status',
    )
    expect(statuses.rows).toEqual([{ status: 2, count: 110 }])

    const outbox = await pool.query<{ count: number; inboxes: number }>(
      'SELECT COUNT(*)::int AS count, COUNT(DISTINCT inbox_id)::int AS inboxes FROM realtime_outbox',
    )
    expect(outbox.rows[0]).toEqual({ count: 110, inboxes: 110 })
  }, 30_000)
})
