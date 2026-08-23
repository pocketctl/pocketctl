import { describe, expect, test, vi } from 'vitest';
import { initDB } from '../db.js';
import {
  createWsTicketStore,
  type WsTicketPayload,
  type WsTicketPersistence,
} from '../config/ws-tickets.js';

interface FakeRecord {
  payload: WsTicketPayload;
  expiresAt: number;
}

class SharedTicketPersistence implements WsTicketPersistence {
  readonly records = new Map<string, FakeRecord>();

  constructor(private readonly now: () => number) {}

  async insert(
    ticketHash: string,
    payload: WsTicketPayload,
    ttlMs: number,
    maxTickets: number,
  ): Promise<boolean> {
    const now = this.now();
    for (const [key, record] of this.records) {
      if (record.expiresAt <= now) this.records.delete(key);
    }
    if (this.records.size >= maxTickets || this.records.has(ticketHash)) return false;
    this.records.set(ticketHash, { payload, expiresAt: now + ttlMs });
    return true;
  }

  async consume(ticketHash: string): Promise<WsTicketPayload | null> {
    const record = this.records.get(ticketHash);
    if (!record) return null;
    this.records.delete(ticketHash);
    return record.expiresAt > this.now() ? record.payload : null;
  }
}

describe('shared websocket ticket store', () => {
  const payload = { userId: 1, email: 'u@example.com', jti: 'jti-1', machine_id: 'web' };

  test('a ticket issued by one Relay instance is consumed exactly once by another', async () => {
    const persistence = new SharedTicketPersistence(() => 1_000);
    const issuer = createWsTicketStore(persistence, 60_000);
    const websocketRelay = createWsTicketStore(persistence, 60_000);

    const { ticket, expiresIn } = await issuer.create(payload);

    expect(expiresIn).toBe(60);
    await expect(websocketRelay.consume(ticket)).resolves.toEqual(payload);
    await expect(issuer.consume(ticket)).resolves.toBeNull();
  });

  test('persistence receives only a digest, never the plaintext ticket', async () => {
    const persistence = new SharedTicketPersistence(() => 1_000);
    const store = createWsTicketStore(persistence, 60_000);

    const { ticket } = await store.create(payload);
    const [storedKey] = persistence.records.keys();

    expect(storedKey).toMatch(/^[a-f0-9]{64}$/);
    expect(storedKey).not.toBe(ticket);
  });

  test('expired ticket is rejected', async () => {
    let now = 1_000;
    const persistence = new SharedTicketPersistence(() => now);
    const store = createWsTicketStore(persistence, 100);
    const { ticket } = await store.create(payload);

    now += 101;
    await expect(store.consume(ticket)).resolves.toBeNull();
  });
});

describe('shared websocket ticket capacity (M-2)', () => {
  const payload = { userId: 1, email: 'u@example.com', jti: 'jti-capacity', machine_id: 'web' };

  test('the hard cap is shared by Relay instances', async () => {
    const persistence = new SharedTicketPersistence(() => 1_000);
    const relayA = createWsTicketStore(persistence, 60_000, { maxTickets: 2 });
    const relayB = createWsTicketStore(persistence, 60_000, { maxTickets: 2 });

    await relayA.create(payload);
    await relayB.create(payload);
    await expect(relayA.create(payload)).rejects.toThrow(/at capacity/i);
  });

  test('expired tickets recover shared capacity', async () => {
    let now = 1_000;
    const persistence = new SharedTicketPersistence(() => now);
    const relayA = createWsTicketStore(persistence, 100, { maxTickets: 1 });
    const relayB = createWsTicketStore(persistence, 100, { maxTickets: 1 });

    await relayA.create(payload);
    now += 101;
    await expect(relayB.create(payload)).resolves.toMatchObject({ expiresIn: 0 });
  });

  test('consuming a ticket recovers shared capacity', async () => {
    const persistence = new SharedTicketPersistence(() => 1_000);
    const relayA = createWsTicketStore(persistence, 60_000, { maxTickets: 1 });
    const relayB = createWsTicketStore(persistence, 60_000, { maxTickets: 1 });
    const { ticket } = await relayA.create(payload);

    await expect(relayB.create(payload)).rejects.toThrow(/at capacity/i);
    await expect(relayB.consume(ticket)).resolves.toEqual(payload);
    await expect(relayB.create(payload)).resolves.toMatchObject({ expiresIn: 60 });
  });
});

describe('websocket ticket schema', () => {
  test('the main Relay bootstrap creates the shared ticket table', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });

    await initDB({ query } as never);

    const statements = query.mock.calls.map((call) => String(call[0])).join('\n');
    expect(statements).toContain('CREATE TABLE IF NOT EXISTS websocket_tickets');
    expect(statements).toContain('user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE');
    expect(statements).toContain('ticket_hash CHAR(64) PRIMARY KEY');
  });
});
