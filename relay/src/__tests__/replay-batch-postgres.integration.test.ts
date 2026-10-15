import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { initDB } from '../db.js';
import { InboxRepository } from '../ingress/inbox-repository.js';
import { createInboxWorker } from '../inbox-worker.js';
import { EventMaterializer } from '../materialization/event-materializer.js';
import { RealtimeOutboxWriter } from '../materialization/realtime-outbox.js';
import { createPostgresExtensionJournalSink } from '../extensions/journal.js';
import { assertDurableIngressTestDatabase, resetDurableIngressTestDatabase } from './durable-ingress-test-db.js';
const url = process.env.TEST_DATABASE_URL;
const suite = url && process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip;
suite('contiguous side-effect-free history batching', () => {
  let pool: pg.Pool;
  let userId: number;
  let queryCount = 0;
  let countQueries = false;
  let measured: pg.Pool;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 8 });
    await assertDurableIngressTestDatabase(pool, url!);
    await initDB(pool);
    measured = new Proxy(pool, { get(target, key) {
        if (key === 'query')
          return (...args: any[]) => { if (countQueries)
            queryCount++; return (target.query as any)(...args); };
        if (key === 'connect')
          return async () => {
            const client = await target.connect();
            return new Proxy(client, { get(c, k) {
                if (k === 'query')
                  return (...args: any[]) => { if (countQueries)
                    queryCount++; return (c.query as any)(...args); };
                const value = Reflect.get(c, k);
                return typeof value === 'function' ? value.bind(c) : value;
              } });
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
  }, 30000);
  afterAll(async () => { await pool?.end(); });
  beforeEach(async () => {
    countQueries = false;
    await resetDurableIngressTestDatabase(pool, url!);
    userId = (await pool.query(`INSERT INTO users(email,password_hash) VALUES('replay-batch@example.test','') RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO daemons(daemon_id,user_id) VALUES('replay-batch',$1)`, [userId]);
    await pool.query(`INSERT INTO sessions(session_id,daemon_id,user_id,agent_type,status,cwd) VALUES('replay-session','replay-batch',$1,'codex','idle','/synthetic')`, [userId]);
  });
  async function seed(count: number, mutate?: (i: number, payload: Record<string, unknown>) => void) {
    const repository = new InboxRepository(measured);
    await repository.persistBatch(Array.from({ length: count }, (_, i) => {
      const payload: Record<string, unknown> = { type: 'tool_result', session_id: 'replay-session', event_id: `history:${i}`, seq: i + 1, resync: true, output: `synthetic ${i}` };
      mutate?.(i, payload);
      return { userId, daemonId: 'replay-batch', registrationId: 'fixture', daemonGeneration: 1, seq: i + 1, dedupKey: `history:${i}`, sessionId: String(payload.session_id), eventType: String(payload.type), priority: 'replay' as const, payload, materializationContext: { agentType: '', cwd: '', hostname: 'isolated', reservationId: null }, receivedAt: new Date() };
    }));
    return repository;
  }
  function worker(repository: InboxRepository, materializer = new EventMaterializer({ pool: measured, extensionJournalSink: createPostgresExtensionJournalSink() })) {
    return createInboxWorker({ repository, materializer, outboxWriter: new RealtimeOutboxWriter(measured), workerId: 'batch-worker', shardCount: 1, shardIndex: 0, maxDrainPasses: 300 });
  }
  test('persists 128 history facts, journal and ordered outbox without per-row transaction overhead', async () => {
    const repository = await seed(128);
    queryCount = 0;
    countQueries = true;
    await worker(repository).runOnce();
    countQueries = false;
    const rows = (await pool.query(`SELECT i.seq,i.status,e.payload->>'output' AS output,e.effect_status,o.outbox_id FROM event_inbox i JOIN events e ON e.id=i.materialized_event_id JOIN realtime_outbox o USING(inbox_id) ORDER BY i.seq`)).rows;
    expect(rows).toHaveLength(128);
    expect(rows.every((r, i) => Number(r.seq) === i + 1 && r.status === 2 && r.effect_status === 'completed' && r.output === `synthetic ${i}`)).toBe(true);
    expect(rows.map(r => Number(r.outbox_id))).toEqual([...rows.map(r => Number(r.outbox_id))].sort((a, b) => a - b));
    expect(Number((await pool.query('SELECT count(*) FROM extension_source_outbox')).rows[0].count)).toBe(128);
    expect(queryCount).toBeLessThan(220);
  });
  test('does not bypass an intervening live event or usage effect', async () => {
    const repository = await seed(80, (i, payload) => {
      if (i === 20) {
        payload.resync = false;
        payload.type = 'agent_text';
        payload.text = 'live boundary';
      }
      if (i === 40) {
        payload.type = 'agent_text';
        payload.usage = { input_tokens: 10, output_tokens: 5 };
      }
    });
    await worker(repository).runOnce();
    const rows = (await pool.query(`SELECT i.seq,i.status,e.payload->>'type' AS type FROM event_inbox i JOIN events e ON e.id=i.materialized_event_id ORDER BY e.id`)).rows;
    expect(rows.map(r => Number(r.seq))).toEqual(Array.from({ length: 80 }, (_, i) => i + 1));
    expect(rows.every(r => r.status === 2)).toBe(true);
    expect(rows[20].type).toBe('agent_text');
    expect(rows[40].type).toBe('agent_text');
    expect(Number((await pool.query(`SELECT tok_input FROM sessions WHERE session_id='replay-session'`)).rows[0].tok_input)).toBe(10);
  });
  test('a journal failure rolls the prefix back and ordinary retries lose no facts', async () => {
    const repository = await seed(64);
    const actual = createPostgresExtensionJournalSink();
    let calls = 0;
    const materializer = new EventMaterializer({ pool: measured, extensionJournalSink: { async appendCanonicalEvent(client, input) {
          if (++calls === 3)
            throw new Error('synthetic journal fault');
          return actual.appendCanonicalEvent(client, input);
        } } });
    await worker(repository, materializer).runOnce();
    for (const table of ['events', 'event_inbox', 'realtime_outbox', 'extension_source_outbox']) {
      expect(Number((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count)).toBe(64);
    }
    expect(Number((await pool.query('SELECT count(*) FROM event_inbox WHERE status<>2')).rows[0].count)).toBe(0);
  });
  test('outbox failure rolls back canonical writes and retries one delivery for every receipt', async () => {
    const repository = await seed(64);
    const outbox = new RealtimeOutboxWriter(measured);
    const completeReplayBatch = outbox.completeReplayBatch.bind(outbox);
    let fail = true;
    outbox.completeReplayBatch = async (...args) => { if (fail) {
      fail = false;
      throw new Error('synthetic failure before atomic completion');
    } return completeReplayBatch(...args); };
    await createInboxWorker({ repository, materializer: new EventMaterializer({ pool: measured }), outboxWriter: outbox, workerId: 'crash-worker', shardCount: 1, shardIndex: 0, maxDrainPasses: 100 }).runOnce();
    expect(Number((await pool.query('SELECT count(*) FROM events')).rows[0].count)).toBe(64);
    expect(Number((await pool.query('SELECT count(*) FROM realtime_outbox')).rows[0].count)).toBe(64);
    expect(Number((await pool.query('SELECT count(*) FROM event_inbox WHERE status<>2')).rows[0].count)).toBe(0);
  });
  test('old pending effect ledgers fall back instead of being marked completed by the shortcut', async () => {
    const repository = await seed(64);
    await pool.query(`INSERT INTO events(session_id,event_type,payload,event_hash,user_id,effect_status,effect_step)
   VALUES('replay-session','tool_result','{}',substring(md5('replay-session:tool_result:event:history:0'),1,16),$1,'pending',2)`, [userId]);
    let ordinary = 0;
    const materializer = new EventMaterializer({ pool: measured });
    const materialize = materializer.materialize.bind(materializer);
    materializer.materialize = async (...args) => { ordinary++; return materialize(...args); };
    await worker(repository, materializer).runOnce();
    expect(ordinary).toBeGreaterThan(0);
    expect(Number((await pool.query(`SELECT effect_step FROM events WHERE event_hash=substring(md5('replay-session:tool_result:event:history:0'),1,16)`)).rows[0].effect_step)).toBe(2);
    expect(Number((await pool.query('SELECT count(*) FROM event_inbox WHERE status<>2')).rows[0].count)).toBe(0);
  });
  test('foreign ownership produces no canonical event, journal or delivery', async () => {
    const repository = await seed(16);
    const other = (await pool.query(`INSERT INTO users(email,password_hash) VALUES('other@example.test','') RETURNING id`)).rows[0].id;
    await pool.query(`UPDATE sessions SET user_id=$1 WHERE session_id='replay-session'`, [other]);
    await worker(repository).runOnce();
    for (const table of ['events', 'realtime_outbox', 'extension_source_outbox']) {
      expect(Number((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count)).toBe(0);
    }
    expect(Number((await pool.query(`SELECT count(*) FROM event_inbox WHERE status=3 AND last_error='session_ownership_violation'`)).rows[0].count)).toBe(16);
  });
  test('session boundaries keep global daemon ordering intact', async () => {
    await pool.query(`INSERT INTO sessions(session_id,daemon_id,user_id,agent_type,status,cwd) VALUES('other-session','replay-batch',$1,'codex','idle','/synthetic')`, [userId]);
    const repository = await seed(64, (i, payload) => { if (i === 16)
      payload.session_id = 'other-session'; });
    await worker(repository).runOnce();
    expect((await pool.query(`SELECT i.seq FROM event_inbox i JOIN events e ON e.id=i.materialized_event_id ORDER BY e.id`)).rows.map(r => Number(r.seq))).toEqual(Array.from({ length: 64 }, (_, i) => i + 1));
  });
  test('repeated fallback does not spend pending followers retry budgets', async () => {
    const repository = await seed(64);
    await pool.query(`INSERT INTO events(session_id,event_type,payload,event_hash,user_id,effect_status,effect_step)
      VALUES('replay-session','tool_result','{}',substring(md5('replay-session:tool_result:event:history:31'),1,16),$1,'pending',2)`, [userId]);
    const materializer = new EventMaterializer({ pool: measured });
    const ordinary = materializer.materialize.bind(materializer);
    let fail = true;
    materializer.materialize = async (...args) => {
      if (args[0].payload.seq === 13 && fail) {
        fail = false;
        throw new Error('first real processing transient failure');
      }
      return ordinary(...args);
    };
    await worker(repository, materializer).runOnce();
    const pending = (await pool.query('SELECT status,attempts FROM event_inbox WHERE seq=13')).rows[0];
    expect(pending).toEqual({ status: 0, attempts: 1 });
    expect((await pool.query('SELECT attempts FROM event_inbox WHERE seq=14')).rows[0].attempts).toBe(0);
    await pool.query('UPDATE event_inbox SET available_at=NOW() WHERE status=0');
    await worker(repository, materializer).runOnce();
    expect(Number((await pool.query('SELECT count(*) FROM event_inbox WHERE status<>2')).rows[0].count)).toBe(0);
    expect(Number((await pool.query('SELECT count(*) FROM realtime_outbox')).rows[0].count)).toBe(64);
  });
  test('batch journals honor the same app review demo exclusion', async () => {
    await pool.query(`UPDATE sessions SET session_id='app-review-demo-history' WHERE session_id='replay-session'`);
    const repository = await seed(64, (_, payload) => { payload.session_id = 'app-review-demo-history'; });
    await worker(repository).runOnce();
    expect(Number((await pool.query('SELECT count(*) FROM events')).rows[0].count)).toBe(64);
    expect(Number((await pool.query('SELECT count(*) FROM extension_source_outbox')).rows[0].count)).toBe(0);
  });
  test.each(['stale_head', 'delayed_follower'])('%s aborts without speculative claims or partial canonical writes', async (fault) => {
    const repository = await seed(8);
    const [head] = await repository.claimBatch({ workerId: 'fence-worker', limit: 32, shardCount: 1, shardIndex: 0 });
    const tail = await repository.readReplayPrefix(head);
    if (fault === 'stale_head') {
      await pool.query(`UPDATE event_inbox SET attempts=attempts+1,claimed_by='new-worker' WHERE inbox_id=$1`, [head.inboxId]);
    } else {
      await pool.query(`UPDATE event_inbox SET available_at=NOW()+INTERVAL '1 hour' WHERE inbox_id=$1`, [tail[0].inboxId]);
    }
    const prefix = [head, ...tail];
    const materializer = new EventMaterializer({ pool: measured });
    let completed = false;
    await expect(materializer.materializeReplayBatch(prefix.map(row => ({
      ...row, context: row.materializationContext,
    })), async () => {}, {
      workerId: 'fence-worker', fences: prefix,
      complete: async () => { completed = true; },
    })).rejects.toHaveProperty('name', 'LostClaimError');
    expect(completed).toBe(false);
    expect(Number((await pool.query('SELECT count(*) FROM events')).rows[0].count)).toBe(0);
    expect(Number((await pool.query('SELECT sum(attempts) FROM event_inbox WHERE status=0')).rows[0].sum)).toBe(0);
  });
  test('duplicate immutable IDs retain one canonical identity and one delivery per receipt', async () => {
    const repository = await seed(64, (_, payload) => { payload.event_id = 'same-immutable-event'; });
    await worker(repository).runOnce();
    expect(Number((await pool.query('SELECT count(*) FROM events')).rows[0].count)).toBe(1);
    expect(Number((await pool.query('SELECT count(*) FROM extension_source_outbox')).rows[0].count)).toBe(1);
    expect(Number((await pool.query('SELECT count(*) FROM realtime_outbox')).rows[0].count)).toBe(64);
    expect(Number((await pool.query('SELECT count(*) FROM event_inbox WHERE status<>2')).rows[0].count)).toBe(0);
  });
  test('a deleted session cannot be recreated by a read prefix', async () => {
    const repository = await seed(8);
    const [head] = await repository.claimBatch({ workerId: 'delete-worker', limit: 32, shardCount: 1, shardIndex: 0 });
    const prefix = [head, ...await repository.readReplayPrefix(head)];
    await pool.query(`INSERT INTO deleted_sessions(session_id) VALUES('replay-session')`);
    const materializer = new EventMaterializer({ pool: measured });
    await expect(materializer.materializeReplayBatch(prefix.map(row => ({ ...row, context: row.materializationContext })), async () => {}, {
      workerId: 'delete-worker', fences: prefix,
      complete: async () => { throw new Error('must not complete deleted content'); },
    })).rejects.toHaveProperty('name', 'DeletedDaemonSessionError');
    for (const table of ['events', 'extension_source_outbox', 'realtime_outbox']) {
      expect(Number((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count)).toBe(0);
    }
  });
  test('large histories stay within the byte cap and preserve every sequence', async () => {
    const repository = await seed(64, (_, payload) => { payload.output = 'x'.repeat(64 * 1024); });
    const materializer = new EventMaterializer({ pool: measured });
    const original = materializer.materializeReplayBatch.bind(materializer);
    const sizes: number[] = [];
    materializer.materializeReplayBatch = async (inputs, ...rest) => {
      const size = inputs.reduce((sum, input) => sum + Buffer.byteLength(JSON.stringify(input.payload)), 0);
      sizes.push(size);
      return original(inputs, ...rest);
    };
    await worker(repository, materializer).runOnce();
    expect(sizes.length).toBeGreaterThan(2);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(512 * 1024);
    expect((await pool.query('SELECT i.seq FROM event_inbox i JOIN events e ON e.id=i.materialized_event_id ORDER BY e.id')).rows.map(r => Number(r.seq))).toEqual(Array.from({ length: 64 }, (_, i) => i + 1));
  });
});
