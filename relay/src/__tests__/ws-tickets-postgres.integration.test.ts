import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { initDB } from '../db.js';
import {
  createPostgresWsTicketPersistence,
  createWsTicketStore,
} from '../config/ws-tickets.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integrationEnabled = Boolean(databaseUrl && process.env.RUN_POSTGRES_INTEGRATION === '1');
const describeWithDatabase = integrationEnabled ? describe : describe.skip;

describeWithDatabase('websocket tickets PostgreSQL integration', () => {
  let issuerPool: pg.Pool;
  let websocketPool: pg.Pool;
  let userId: number;

  beforeAll(async () => {
    issuerPool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
    websocketPool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
    const database = await issuerPool.query<{ database_name: string }>(
      'SELECT current_database() AS database_name',
    );
    const databaseName = database.rows[0]?.database_name ?? '';
    if (!/test/i.test(databaseName)) {
      throw new Error(`Refusing PostgreSQL integration test against non-test database: ${databaseName || '<unknown>'}`);
    }
    await initDB(issuerPool);
  }, 30_000);

  afterAll(async () => {
    await Promise.all([issuerPool?.end(), websocketPool?.end()]);
  });

  beforeEach(async () => {
    await issuerPool.query('TRUNCATE websocket_tickets, users RESTART IDENTITY CASCADE');
    const users = await issuerPool.query<{ id: number }>(
      `INSERT INTO users (email, password_hash)
       VALUES ('ws-ticket-user@test.invalid', 'x')
       RETURNING id`,
    );
    userId = users.rows[0]!.id;
  });

  function payload() {
    return {
      userId,
      email: 'ws-ticket-user@test.invalid',
      jti: 'integration-jti',
      machine_id: 'web',
    };
  }

  test('a ticket issued through one pool is atomically consumed through another', async () => {
    const issuer = createWsTicketStore(createPostgresWsTicketPersistence(issuerPool), 60_000);
    const websocketRelay = createWsTicketStore(createPostgresWsTicketPersistence(websocketPool), 60_000);
    const { ticket } = await issuer.create(payload());

    const [first, second] = await Promise.all([
      websocketRelay.consume(ticket),
      issuer.consume(ticket),
    ]);

    expect([first, second].filter(Boolean)).toEqual([payload()]);
  });

  test('expired tickets are rejected and removed', async () => {
    const issuer = createWsTicketStore(createPostgresWsTicketPersistence(issuerPool), 60_000);
    const websocketRelay = createWsTicketStore(createPostgresWsTicketPersistence(websocketPool), 60_000);
    const { ticket } = await issuer.create(payload());
    await issuerPool.query(`UPDATE websocket_tickets SET expires_at = NOW() - interval '1 second'`);

    await expect(websocketRelay.consume(ticket)).resolves.toBeNull();
    const remaining = await issuerPool.query('SELECT ticket_hash FROM websocket_tickets');
    expect(remaining.rowCount).toBe(0);
  });

  test('the hard cap is atomic across concurrent issuers', async () => {
    const relayA = createWsTicketStore(createPostgresWsTicketPersistence(issuerPool), 60_000, { maxTickets: 1 });
    const relayB = createWsTicketStore(createPostgresWsTicketPersistence(websocketPool), 60_000, { maxTickets: 1 });

    const results = await Promise.allSettled([
      relayA.create(payload()),
      relayB.create({ ...payload(), jti: 'integration-jti-2' }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const stored = await issuerPool.query('SELECT ticket_hash FROM websocket_tickets');
    expect(stored.rowCount).toBe(1);
  });
});
