import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { createInboxRepository } from '../inbox/repository.js'
import { createFeedConsumer } from '../inbox/feed-worker.js'
import { canonicalPayloadHash } from '../inbox/canonical-json.js'
import type { ExtensionFeedEnvelopeV1, FeedBatch } from '../relay/contracts.js'
import { RelayRequestError } from '../relay/errors.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const integrationEnabled = Boolean(
  databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1',
)
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const INSTALLATION = '11111111-1111-1111-1111-111111111111'

function envelope(feedId: number, overrides: Record<string, unknown> = {}): ExtensionFeedEnvelopeV1 {
  return {
    envelope_version: 1,
    feed_id: String(feedId),
    topic: 'session.event.v1',
    source: { kind: 'canonical_event', id: `evt-${feedId}`, recorded_at: '2026-08-23T00:00:00.000Z' },
    subject: { session_id: 'ses-1', turn_id: 'turn-1', event_type: 'agent_text' },
    classification: {},
    data: { type: 'agent_text', text: 'redacted' },
    ...overrides,
  } as ExtensionFeedEnvelopeV1
}

function batch(items: unknown[], overrides: Record<string, unknown> = {}): FeedBatch {
  return {
    installation_id: INSTALLATION,
    items: items as FeedBatch['items'],
    next_cursor: 'cursor-opaque',
    lease_token: 'lease-opaque',
    lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  }
}

describeWithDatabase('durable inbox (PostgreSQL)', () => {
  let pool: pg.Pool
  let inbox: ReturnType<typeof createInboxRepository>

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
    await assertMemoryTestDatabase(pool, databaseUrl!)
    await applyMemorySchema(pool)
    inbox = createInboxRepository(pool)
  }, 30_000)

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE memory_jobs, memory_feed_inbox, memory_installations RESTART IDENTITY CASCADE
    `)
    await pool.query(`
      INSERT INTO memory_installations
        (installation_id, provider_id, relay_status, local_status, config_version)
      VALUES ($1, 'pocketctl-memory', 'active', 'syncing', 1)
    `, [INSTALLATION])
  })

  test('commits a batch atomically and acks only after the commit', async () => {
    const ack = vi.fn(async () => 2)
    const committed = await inbox.commitBatch({
      installationId: INSTALLATION,
      envelopes: [envelope(1), envelope(2)],
      rawQuarantined: [],
      cursor: 'cursor-opaque',
      leaseToken: 'lease-opaque',
      ack,
    })
    expect(committed).toBe(2)
    expect(ack).toHaveBeenCalledTimes(1)

    const rows = await pool.query<{ feed_id: string; projection_state: string }>(
      `SELECT feed_id::text, projection_state FROM memory_feed_inbox ORDER BY feed_id`,
    )
    expect(rows.rows.map(row => [row.feed_id, row.projection_state])).toEqual([
      ['1', 'pending'], ['2', 'pending'],
    ])
    const jobs = await pool.query<{ job_type: string }>(
      `SELECT job_type FROM memory_jobs`,
    )
    expect(jobs.rows.map(job => job.job_type)).toEqual(['project_feed'])
    const installation = await pool.query<{ last_feed_id: string }>(
      `SELECT last_feed_id::text FROM memory_installations WHERE installation_id = $1`, [INSTALLATION],
    )
    expect(installation.rows[0].last_feed_id).toBe('2')
  })

  test('a successful ack does not erase a discovery degradation', async () => {
    await pool.query(`
      UPDATE memory_installations
      SET local_status = 'degraded', last_error_code = 'missing_from_relay'
      WHERE installation_id = $1
    `, [INSTALLATION])
    await inbox.commitBatch({
      installationId: INSTALLATION,
      envelopes: [envelope(61)],
      rawQuarantined: [],
      cursor: 'cursor-opaque',
      leaseToken: 'lease-opaque',
      ack: async () => 61,
    })

    const installation = await pool.query<{
      local_status: string; last_error_code: string | null
    }>(`SELECT local_status, last_error_code FROM memory_installations WHERE installation_id = $1`, [INSTALLATION])
    expect(installation.rows[0]).toEqual({
      local_status: 'degraded', last_error_code: 'missing_from_relay',
    })
  })

  test('a failed commit never acks and leaves no partial rows', async () => {
    const ack = vi.fn()
    await expect(inbox.commitBatch({
      installationId: INSTALLATION,
      envelopes: [envelope(3)],
      rawQuarantined: [],
      cursor: 'cursor-opaque',
      leaseToken: 'lease-opaque',
      ack: async () => {
        throw new Error('relay unreachable')
      },
    })).rejects.toThrow()
    // Ack failure happens AFTER commit: rows exist and await a later ack.
    const rows = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM memory_feed_inbox`,
    )
    expect(Number(rows.rows[0].count)).toBe(1)
  })

  test('a relay redelivery collapses onto the stored rows and acks again', async () => {
    const firstAck = vi.fn(async () => 1)
    await inbox.commitBatch({
      installationId: INSTALLATION, envelopes: [envelope(5)], rawQuarantined: [],
      cursor: 'cursor-opaque', leaseToken: 'lease-opaque', ack: firstAck,
    })
    const secondAck = vi.fn(async () => 5)
    const result = await inbox.commitBatch({
      installationId: INSTALLATION,
      envelopes: [envelope(4), envelope(5)],  // 4 is new, 5 replays
      rawQuarantined: [],
      cursor: 'cursor-opaque',
      leaseToken: 'lease-opaque',
      ack: secondAck,
    })
    expect(result).toBe(1) // only the new row counts as committed
    expect(secondAck).toHaveBeenCalledTimes(1)
    const count = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM memory_feed_inbox`,
    )
    expect(Number(count.rows[0].count)).toBe(2)
  })

  test('the same feed id with a different payload hash fences the installation', async () => {
    await inbox.commitBatch({
      installationId: INSTALLATION, envelopes: [envelope(7)], rawQuarantined: [],
      cursor: 'cursor-opaque', leaseToken: 'lease-opaque', ack: async () => 7,
    })
    const tampered = envelope(7, { data: { type: 'agent_text', text: 'tampered' } })
    await expect(inbox.commitBatch({
      installationId: INSTALLATION, envelopes: [tampered], rawQuarantined: [],
      cursor: 'cursor-opaque', leaseToken: 'lease-opaque', ack: async () => 7,
    })).rejects.toThrow(/integrity/)
    const installation = await pool.query<{ local_status: string; last_error_code: string | null }>(
      `SELECT local_status, last_error_code FROM memory_installations`,
    )
    expect(installation.rows[0].local_status).toBe('integrity_error')
    expect(installation.rows[0].last_error_code).toBe('feed_integrity')
    // The stored row keeps its original payload.
    const stored = await pool.query<{ payload_hash: Buffer }>(
      `SELECT payload_hash FROM memory_feed_inbox WHERE feed_id = 7`,
    )
    expect(stored.rows[0].payload_hash.equals(canonicalPayloadHash(envelope(7)))).toBe(true)
  })

  test('different payloads with the same feed id inside one batch trigger the integrity fence', async () => {
    const original = envelope(71)
    const tampered = envelope(71, { data: { type: 'agent_text', text: 'tampered' } })
    await expect(inbox.commitBatch({
      installationId: INSTALLATION,
      envelopes: [original, tampered],
      rawQuarantined: [],
      cursor: 'cursor-opaque',
      leaseToken: 'lease-opaque',
      ack: async () => 71,
    })).rejects.toThrow(/integrity/)
    const installation = await pool.query<{ local_status: string }>(
      `SELECT local_status FROM memory_installations`,
    )
    expect(installation.rows[0].local_status).toBe('integrity_error')
  })

  test('stores bigint feed ids without JavaScript number rounding', async () => {
    const feedId = '9007199254740993'
    await inbox.commitBatch({
      installationId: INSTALLATION,
      envelopes: [envelope(1, { feed_id: feedId })],
      rawQuarantined: [],
      cursor: 'cursor-opaque',
      leaseToken: 'lease-opaque',
      ack: async () => 1,
    })
    const stored = await pool.query<{ feed_id: string; last_feed_id: string }>(`
      SELECT i.feed_id::text, m.last_feed_id::text
      FROM memory_feed_inbox i
      JOIN memory_installations m USING (installation_id)
    `)
    expect(stored.rows[0]).toEqual({ feed_id: feedId, last_feed_id: feedId })
  })

  test('unsupported envelope versions quarantine durably and still ack', async () => {
    const ack = vi.fn(async () => 9)
    const committed = await inbox.commitBatch({
      installationId: INSTALLATION,
      envelopes: [envelope(9)],
      rawQuarantined: [{
        feed_id: '8',
        error_code: 'unsupported_envelope_version',
        raw: { envelope_version: 99, data: { redacted: true } },
      }],
      cursor: 'cursor-opaque',
      leaseToken: 'lease-opaque',
      ack,
    })
    expect(committed).toBe(1)
    expect(ack).toHaveBeenCalledTimes(1)
    const rows = await pool.query<{ feed_id: string; projection_state: string; error_code: string | null }>(
      `SELECT feed_id::text, projection_state, error_code FROM memory_feed_inbox ORDER BY feed_id`,
    )
    expect(rows.rows.find(row => row.feed_id === '8')).toMatchObject({
      projection_state: 'quarantined',
      error_code: 'unsupported_envelope_version',
    })
    expect(rows.rows.find(row => row.feed_id === '9')?.projection_state).toBe('pending')
  })
})

describeWithDatabase('feed consumer typed recovery (PostgreSQL)', () => {
  let pool: pg.Pool

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
    await assertMemoryTestDatabase(pool, databaseUrl!)
    await applyMemorySchema(pool)
  }, 30_000)

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE memory_jobs, memory_feed_inbox, memory_installations RESTART IDENTITY CASCADE
    `)
    await pool.query(`
      INSERT INTO memory_installations
        (installation_id, provider_id, relay_status, local_status, config_version)
      VALUES ($1, 'pocketctl-memory', 'active', 'syncing', 1)
    `, [INSTALLATION])
  })

  function consumerWith(
    pull: (installationId: string, limit: number) => Promise<FeedBatch>,
    ack: (input: { installation_id: string; cursor: string; lease_token: string }) => Promise<number>,
  ) {
    return createFeedConsumer({
      pool,
      pullFeed: pull,
      ackFeed: ack,
      workerId: 'test-worker',
      signal: new AbortController().signal,
    })
  }

  test('pulls, commits and acks one installation end to end', async () => {
    const ack = vi.fn(async () => 2)
    const consumer = consumerWith(async () => batch([envelope(1), envelope(2)]), ack)
    const processed = await consumer.runOnce()
    expect(processed.installations).toBe(1)
    expect(ack).toHaveBeenCalledTimes(1)
    const installation = await pool.query<{ last_ack_at: Date | null; local_status: string }>(
      `SELECT last_ack_at, local_status FROM memory_installations`,
    )
    expect(installation.rows[0].last_ack_at).not.toBeNull()
    expect(installation.rows[0].local_status).toBe('ready')
  })

  test('stale lease answers re-pull without acking or storing', async () => {
    const pull = vi.fn(async () => {
      throw new RelayRequestError({ operation: 'pull_feed', code: 'stale_lease', status: 409 })
    })
    const ack = vi.fn()
    const consumer = consumerWith(pull, ack)
    await consumer.runOnce()
    expect(ack).not.toHaveBeenCalled()
    const rows = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM memory_feed_inbox`,
    )
    expect(Number(rows.rows[0].count)).toBe(0)
    // The installation remains pullable (no error state).
    const installation = await pool.query<{ local_status: string }>(
      `SELECT local_status FROM memory_installations`,
    )
    expect(installation.rows[0].local_status).toBe('syncing')
  })

  test('hard-retention cursor expiry enqueues a snapshot reconcile job', async () => {
    const pull = vi.fn(async () => {
      throw new RelayRequestError({
        operation: 'pull_feed', code: 'cursor_expired', status: 410, snapshotRequired: true,
      })
    })
    const consumer = consumerWith(pull, vi.fn())
    await consumer.runOnce()
    const jobs = await pool.query<{ job_type: string; idempotency_key: string }>(
      `SELECT job_type, idempotency_key FROM memory_jobs`,
    )
    expect(jobs.rows.map(job => [job.job_type, job.idempotency_key])).toEqual([
      ['snapshot_reconcile', `snapshot:${INSTALLATION}`],
    ])
    const installation = await pool.query<{ snapshot_required: boolean }>(
      `SELECT snapshot_required FROM memory_installations`,
    )
    expect(installation.rows[0].snapshot_required).toBe(true)
  })

  test('paused and revoked installations are never pulled', async () => {
    const pull = vi.fn()
    for (const relayStatus of ['paused', 'revoking', 'revoked']) {
      await pool.query(`UPDATE memory_installations SET relay_status = $1`, [relayStatus])
      const consumer = consumerWith(pull, vi.fn())
      await consumer.runOnce()
    }
    expect(pull).not.toHaveBeenCalled()
  })

  test('unaddressable malformed envelopes isolate the batch without acking', async () => {
    const ack = vi.fn(async () => 42)
    const onError = vi.fn()
    const consumer = createFeedConsumer({
      pool,
      pullFeed: async () => batch([
        envelope(42),
        { envelope_version: 99, feed_id: 123, data: {} },        // numeric feed id
        { envelope_version: 99, feed_id: 'nope', data: {} },     // non-numeric feed id
      ]),
      ackFeed: ack,
      workerId: 'skip-worker',
      signal: new AbortController().signal,
      onError,
    })
    await expect(consumer.runOnce()).resolves.toEqual({ installations: 0 })
    expect(ack).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringMatching(/unaddressable/),
    }))
    const rows = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM memory_feed_inbox`,
    )
    expect(Number(rows.rows[0].count)).toBe(0)
  })

  test('an unaddressable batch does not starve later installations', async () => {
    const secondInstallation = '22222222-2222-2222-2222-222222222222'
    await pool.query(`
      INSERT INTO memory_installations
        (installation_id, provider_id, relay_status, local_status, config_version)
      VALUES ($1, 'pocketctl-memory', 'active', 'syncing', 1)
    `, [secondInstallation])
    const ack = vi.fn(async () => 51)
    const consumer = createFeedConsumer({
      pool,
      pullFeed: async installationId => installationId === INSTALLATION
        ? batch([{ envelope_version: 1, data: {} }])
        : batch([envelope(51)], { installation_id: secondInstallation }),
      ackFeed: ack,
      workerId: 'isolating-worker',
      signal: new AbortController().signal,
    })

    await expect(consumer.runOnce()).resolves.toEqual({ installations: 1 })
    expect(ack).toHaveBeenCalledTimes(1)
    const stored = await pool.query<{ installation_id: string; feed_id: string }>(`
      SELECT installation_id::text, feed_id::text FROM memory_feed_inbox
    `)
    expect(stored.rows).toEqual([{ installation_id: secondInstallation, feed_id: '51' }])
  })

  test('only one worker holds a local poll lease at a time', async () => {
    let pullCalls = 0
    const slowPull = async () => {
      pullCalls++
      await new Promise(resolve => setTimeout(resolve, 100))
      return batch([envelope(pullCalls)])
    }
    const a = createFeedConsumer({
      pool, pullFeed: slowPull, ackFeed: async () => 1,
      workerId: 'worker-a', signal: new AbortController().signal,
    })
    const b = createFeedConsumer({
      pool, pullFeed: slowPull, ackFeed: async () => 1,
      workerId: 'worker-b', signal: new AbortController().signal,
    })
    await Promise.all([a.runOnce(), b.runOnce()])
    // Two concurrent runs, but the installation is leased: exactly one pulls.
    expect(pullCalls).toBe(1)
  })

  test('one feed consumer never overlaps two passes for the same worker id', async () => {
    let pullCalls = 0
    let releasePull: (() => void) | undefined
    const pullGate = new Promise<void>(resolve => {
      releasePull = resolve
    })
    const consumer = createFeedConsumer({
      pool,
      pullFeed: async () => {
        pullCalls++
        await pullGate
        return batch([envelope(88)])
      },
      ackFeed: async () => 88,
      workerId: 'same-worker',
      signal: new AbortController().signal,
    })

    const first = consumer.runOnce()
    const second = consumer.runOnce()
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(pullCalls).toBe(1)
    releasePull?.()
    await Promise.all([first, second])
    expect(pullCalls).toBe(1)
  })
})
