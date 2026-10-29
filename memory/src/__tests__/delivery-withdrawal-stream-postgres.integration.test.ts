import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { applyMemorySchema } from '../schema.js'
import { createDeliveryWithdrawalConsumer } from '../inbox/delivery-withdrawal-consumer.js'
import type { DeliveryWithdrawalBatch, DeliveryWithdrawalItem } from '../relay/delivery-withdrawal-client.js'
const url = process.env.MEMORY_TEST_DATABASE_URL
const suite = url && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1' ? describe : describe.skip
suite('provider withdrawal persistence and worker fences', () => {
  let pool: pg.Pool
  beforeAll(async () => { pool = new pg.Pool({ connectionString: url, max: 6 }); await assertMemoryTestDatabase(pool, url!); await applyMemorySchema(pool) }, 60_000)
  beforeEach(async () => { await pool.query('TRUNCATE memory_delivery_withdrawal_checkpoint,memory_delivery_withdrawal_receipts,memory_team_delivery_withdrawals') })
  afterAll(async () => { await pool?.end() })
  const item = (sequence = '1'): DeliveryWithdrawalItem => ({ sequence, team_id: 'team', team_session_id: 'session', submission_id: randomUUID(), decision_id: randomUUID(), recorded_at: '2026-10-25T00:00:00.000Z' })
  const batch = (consumer: string, items: DeliveryWithdrawalItem[]): DeliveryWithdrawalBatch => ({ version: 1, consumer_id: consumer, items,
    through_sequence: items.at(-1)?.sequence ?? '0', next_cursor: 'cursor', lease_token: 'lease', lease_expires_at: '2099-10-25T00:00:00.000Z' })
  const signal = () => new AbortController().signal
  test('batch failure rolls back every source fence and receipt without ACK', async () => {
    const items = [item('1'), item('2')], ack = vi.fn(async () => '2')
    await pool.query(`CREATE FUNCTION fail_withdrawal_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.sequence=2 THEN RAISE EXCEPTION 'receipt fault'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_withdrawal_receipt BEFORE INSERT ON memory_delivery_withdrawal_receipts FOR EACH ROW EXECUTE FUNCTION fail_withdrawal_receipt()`)
    try {
      await expect(createDeliveryWithdrawalConsumer({ pool, signal: signal(), pull: async id => batch(id, items), ack }).runOnce()).rejects.toThrow('receipt fault')
      expect(ack).not.toHaveBeenCalled()
      expect((await pool.query('SELECT 1 FROM memory_team_delivery_withdrawals')).rowCount).toBe(0)
      expect((await pool.query('SELECT 1 FROM memory_delivery_withdrawal_receipts')).rowCount).toBe(0)
      expect((await pool.query('SELECT last_sequence::text FROM memory_delivery_withdrawal_checkpoint')).rows[0].last_sequence).toBe('0')
    } finally { await pool.query('DROP TRIGGER fail_withdrawal_receipt ON memory_delivery_withdrawal_receipts; DROP FUNCTION fail_withdrawal_receipt()') }
  })
  test('altered replay is rejected before ACK or a second identity can be installed', async () => {
    const original = item(), ack = vi.fn(async () => '1')
    const run = (value: DeliveryWithdrawalItem) => createDeliveryWithdrawalConsumer({ pool, signal: signal(), pull: async id => batch(id, [value]), ack }).runOnce()
    expect(await run(original)).toEqual({ applied: 1, skipped: false })
    ack.mockClear()
    await expect(run({ ...original, submission_id: randomUUID() })).rejects.toThrow('delivery withdrawal integrity conflict')
    expect(ack).not.toHaveBeenCalled()
    expect((await pool.query('SELECT submission_id FROM memory_team_delivery_withdrawals')).rows).toEqual([{ submission_id: original.submission_id }])
  })
  test('two workers share a database lock and one worker coalesces overlapping passes', async () => {
    const record = item(); let release!: () => void, reached!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve }), entered = new Promise<void>(resolve => { reached = resolve })
    const pull = vi.fn(async (id: string) => { reached(); await barrier; return batch(id, [record]) })
    const ack = vi.fn(async () => '1')
    const first = createDeliveryWithdrawalConsumer({ pool, signal: signal(), pull, ack })
    const running = first.runOnce()
    try {
      await entered
      expect(first.runOnce()).toBe(running)
      expect(await createDeliveryWithdrawalConsumer({ pool, signal: signal(), pull, ack }).runOnce()).toEqual({ applied: 0, skipped: true })
      expect(pull).toHaveBeenCalledTimes(1)
    } finally { release(); await running }
    expect(ack).toHaveBeenCalledTimes(1)
  })
  test('malformed control batch and empty forward gap never ACK', async () => {
    const ack = vi.fn(async () => '1')
    await expect(createDeliveryWithdrawalConsumer({ pool, signal: signal(), ack, pull: async id => ({ ...batch(id, [item()]), unexpected: 'content' }) }).runOnce()).rejects.toThrow('invalid delivery withdrawal batch')
    await expect(createDeliveryWithdrawalConsumer({ pool, signal: signal(), ack, pull: async id => ({ ...batch(id, []), through_sequence: '9' }) }).runOnce()).rejects.toThrow('delivery withdrawal replay gap')
    expect(ack).not.toHaveBeenCalled()
  })
  test('abort after pull leaves nothing persisted or ACKed and releases the database lock', async () => {
    const abort = new AbortController(), ack = vi.fn(async () => '1')
    expect(await createDeliveryWithdrawalConsumer({ pool, signal: abort.signal, ack, pull: async id => { abort.abort(); return batch(id, [item()]) } }).runOnce()).toEqual({ applied: 0, skipped: true })
    expect(ack).not.toHaveBeenCalled()
    expect((await pool.query('SELECT 1 FROM memory_team_delivery_withdrawals')).rowCount).toBe(0)
    expect((await createDeliveryWithdrawalConsumer({ pool, signal: signal(), ack, pull: async id => batch(id, [item()]) }).runOnce()).applied).toBe(1)
  })
  test('restored local checkpoint records only applied history even when Relay ACK is further ahead', async () => {
    const record = item(), ack = vi.fn(async () => '100')
    await createDeliveryWithdrawalConsumer({ pool, signal: signal(), ack, pull: async (id, after) => { expect(after).toBe('0'); return batch(id, [record]) } }).runOnce()
    expect((await pool.query('SELECT last_sequence::text,last_ack_sequence::text FROM memory_delivery_withdrawal_checkpoint')).rows[0]).toEqual({ last_sequence: '1', last_ack_sequence: '1' })
  })
})
