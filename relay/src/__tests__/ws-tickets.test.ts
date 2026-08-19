import { describe, expect, test } from 'vitest';
import { createWsTicketStore } from '../config/ws-tickets.js';

describe('ws ticket store', () => {
  const payload = { userId: 1, email: 'u@example.com', jti: 'jti-1', machine_id: 'web' };

  test('ticket can be consumed exactly once', () => {
    const store = createWsTicketStore(60_000);
    const { ticket, expiresIn } = store.create(payload);

    expect(expiresIn).toBe(60);
    expect(store.consume(ticket)).toEqual(payload);
    expect(store.consume(ticket)).toBeNull();
  });

  test('expired ticket is rejected', () => {
    let now = 1_000;
    const store = createWsTicketStore(100, () => now);
    const { ticket } = store.create(payload);

    now += 101;
    expect(store.consume(ticket)).toBeNull();
  });
});

describe('ws ticket store capacity (M-2)', () => {
  const payload = { userId: 1, email: 'u@example.com', jti: 'jti-capacity', machine_id: 'web' };

  test('create fails with an explicit capacity error at the hard cap', () => {
    let now = 1_000;
    const store = createWsTicketStore(60_000, () => now, { maxTickets: 2 });
    store.create(payload);
    store.create(payload);
    expect(() => store.create(payload)).toThrow(/at capacity/i);
    expect(store.size()).toBe(2);
  });

  test('create GCs expired tickets first, so capacity is recovered', () => {
    let now = 1_000;
    const store = createWsTicketStore(100, () => now, { maxTickets: 1 });
    store.create(payload);
    now += 101;
    expect(() => store.create(payload)).not.toThrow();
    expect(store.size()).toBe(1);
  });

  test('consuming a ticket recovers capacity', () => {
    const store = createWsTicketStore(60_000, () => 1_000, { maxTickets: 1 });
    const { ticket } = store.create(payload);
    expect(() => store.create(payload)).toThrow(/at capacity/i);
    expect(store.consume(ticket)).toEqual(payload);
    expect(() => store.create(payload)).not.toThrow();
  });
});
