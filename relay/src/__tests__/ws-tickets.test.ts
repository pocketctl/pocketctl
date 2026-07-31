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
