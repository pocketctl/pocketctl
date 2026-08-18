import { expect, test, vi } from 'vitest'
import { InboxRepository, LostClaimError } from '../ingress/inbox-repository.js'
import type { IngressEnvelope } from '../ingress/types.js'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function event(seq: number): IngressEnvelope {
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
    payload: { agent: 'opencode', seq },
    materializationContext: {},
    receivedAt: new Date('2026-07-28T08:00:00.000Z'),
  }
}

function checkpoint(result: Map<string, { ackSeq: number }>): number {
  return result.get('d1\0' + '17')?.ackSeq ?? -1
}

function transactionPool(commitGate: Promise<void>, failCanonical = false) {
  const state = { committed: false, rolledBack: false, released: false }
  const client = {
    async query(sql: string) {
      if (sql === 'COMMIT') {
        await commitGate
        state.committed = true
        return { rows: [], rowCount: 0 }
      }
      if (sql === 'ROLLBACK') {
        state.rolledBack = true
        return { rows: [], rowCount: 0 }
      }
      if (sql.includes('INSERT INTO daemon_ack_checkpoint')) return { rows: [], rowCount: 1 }
      if (sql.includes('FROM daemon_ack_checkpoint') && sql.includes('FOR UPDATE')) {
        return { rows: [{ daemon_id: 'd1', daemon_generation: '17', ack_seq: '0' }], rowCount: 1 }
      }
      if (sql.includes('INSERT INTO event_inbox') && !sql.includes('event_inbox_receipt')) {
        if (failCanonical) throw new Error('injected canonical insert failure')
        return {
          rows: [{ inbox_id: '1', user_id: null, dedup_key: 'event-1' }],
          rowCount: 1,
        }
      }
      if (sql.includes('WITH RECURSIVE contiguous')) {
        return { rows: [{ ack_seq: '1' }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    },
    release() {
      state.released = true
    },
  }
  return {
    pool: { async connect() { return client } },
    state,
  }
}

test('does not resolve checkpoints before COMMIT', async () => {
  const commit = deferred<void>()
  const { pool, state } = transactionPool(commit.promise)
  const repo = new InboxRepository(pool as never)
  let resolved = false

  const pending = repo.persistBatch([event(1)]).then((result) => {
    resolved = true
    return result
  })
  await new Promise<void>((resolve) => setImmediate(resolve))

  expect(resolved).toBe(false)
  expect(state.committed).toBe(false)
  commit.resolve()
  expect(checkpoint(await pending)).toBe(1)
  expect(state).toEqual({ committed: true, rolledBack: false, released: true })
})

test('rolls back and releases the client when canonical persistence fails', async () => {
  const { pool, state } = transactionPool(Promise.resolve(), true)
  const repo = new InboxRepository(pool as never)

  await expect(repo.persistBatch([event(1)])).rejects.toThrow('injected canonical insert failure')
  expect(state).toEqual({ committed: false, rolledBack: true, released: true })
})

test('emits deterministic receipt lock and canonical insert order', async () => {
  const observed = {
    receiptLockSql: '',
    canonicalDedupKeys: [] as string[],
  }
  const client = {
    async query(sql: string, values: unknown[] = []) {
      if (sql.includes('FROM daemon_ack_checkpoint') && sql.includes('FOR UPDATE')) {
        return {
          rows: [{
            daemon_id: values[0],
            daemon_generation: String(values[1]),
            ack_seq: '0',
          }],
          rowCount: 1,
        }
      }
      if (sql.includes('FOR UPDATE OF receipt')) {
        observed.receiptLockSql = sql
        return { rows: [], rowCount: 0 }
      }
      if (sql.includes('INSERT INTO event_inbox') && !sql.includes('event_inbox_receipt')) {
        const rows = []
        for (let offset = 0; offset < values.length; offset += 11) {
          observed.canonicalDedupKeys.push(String(values[offset + 4]))
          rows.push({
            inbox_id: String(rows.length + 1),
            user_id: values[offset],
            dedup_key: values[offset + 4],
          })
        }
        return { rows, rowCount: rows.length }
      }
      if (sql.includes('WITH RECURSIVE contiguous')) {
        return { rows: [{ ack_seq: '2' }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    },
    release() {},
  }
  const repo = new InboxRepository({
    async connect() {
      return client
    },
  } as never)

  await repo.persistBatch([
    { ...event(1), dedupKey: 'zeta' },
    { ...event(2), dedupKey: 'alpha' },
    { ...event(3), dedupKey: 'receipt-only', receiptOnly: true },
  ])

  expect(observed.canonicalDedupKeys).toEqual(['alpha', 'zeta'])
  expect(observed.receiptLockSql).toContain(
    'ORDER BY inbox.inbox_id ASC, receipt.receipt_id ASC',
  )
})

test('claims by bigint-safe daemon hash expression', async () => {
  let claimSql = ''
  const repo = new InboxRepository({
    query: vi.fn(async (sql: string) => {
      claimSql = sql
      return { rows: [], rowCount: 0 }
    }),
  } as never)

  await repo.claimBatch({ workerId: 'worker', limit: 10, shardCount: 2, shardIndex: 1 })

  expect(claimSql).toContain('ABS(hashtext(inbox.daemon_id)::bigint)')
  expect(claimSql).toContain('MOD(')
})

test('selects claims from a materialized per-stream head set without a correlated anti-join', async () => {
  let claimSql = ''
  const repo = new InboxRepository({
    query: vi.fn(async (sql: string) => {
      claimSql = sql
      return { rows: [], rowCount: 0 }
    }),
  } as never)

  await repo.claimBatch({ workerId: 'worker', limit: 10, shardCount: 2, shardIndex: 1 })

  expect(claimSql).toContain('WITH stream_heads AS MATERIALIZED')
  expect(claimSql).toContain('DISTINCT ON (daemon_id, daemon_generation)')
  expect(claimSql).toContain('FOR UPDATE OF inbox SKIP LOCKED')
  expect(claimSql).toContain('inbox.status = 0')
  expect(claimSql).toContain('inbox.available_at <= NOW()')
  expect(claimSql).not.toContain('FROM event_inbox earlier')
})

test('keeps claim validation unchanged for limit zero and invalid shards', async () => {
  const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
  const repo = new InboxRepository({ query } as never)

  await expect(repo.claimBatch({
    workerId: 'worker',
    limit: 0,
    shardCount: 2,
    shardIndex: 1,
  })).resolves.toEqual([])
  expect(query).not.toHaveBeenCalled()

  await expect(repo.claimBatch({
    workerId: 'worker',
    limit: 10,
    shardCount: 0,
    shardIndex: 0,
  })).rejects.toThrow('invalid inbox shard')
  await expect(repo.claimBatch({
    workerId: 'worker',
    limit: 10,
    shardCount: 2,
    shardIndex: 2,
  })).rejects.toThrow('invalid inbox shard')
})

test('rejects a stale completion fence instead of overwriting the new owner', async () => {
  const repo = new InboxRepository({
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  } as never)

  await expect(repo.complete(7, 81, 'old-worker', 2)).rejects.toBeInstanceOf(LostClaimError)
})

test('resets stale processing claims in a bounded skip-locked batch', async () => {
  let resetSql = ''
  const repo = new InboxRepository({
    query: vi.fn(async (sql: string) => {
      resetSql = sql
      return { rows: [{ inbox_id: '1' }], rowCount: 1 }
    }),
  } as never)

  await expect(repo.resetStaleClaims(300_000, 1_000)).resolves.toBe(1)
  expect(resetSql).toContain('FOR UPDATE SKIP LOCKED')
  expect(resetSql).toContain('make_interval')
  expect(resetSql).toContain('LIMIT $2')
})

test('renews only claims still owned by the same worker and attempt fence', async () => {
  let renewSql = ''
  let renewParams: unknown[] = []
  const repo = new InboxRepository({
    query: vi.fn(async (sql: string, params: unknown[]) => {
      renewSql = sql
      renewParams = params
      return { rows: [{ inbox_id: '7' }], rowCount: 1 }
    }),
  } as never)

  await expect(repo.renewClaims([
    { inboxId: 7, attempts: 2 },
    { inboxId: 8, attempts: 4 },
  ], 'worker-a')).resolves.toEqual(new Set([7]))
  expect(renewSql).toContain('claimed_at = NOW()')
  expect(renewSql).toContain('status = 1')
  expect(renewSql).toContain('claimed_by = $3')
  expect(renewSql).toContain('UNNEST($1::bigint[], $2::int[])')
  expect(renewParams).toEqual([[7, 8], [2, 4], 'worker-a'])
})
