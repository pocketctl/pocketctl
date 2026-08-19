import { createHash, randomBytes } from 'crypto';

export interface WsTicketPayload {
  userId: number;
  email: string;
  jti: string;
  machine_id: string;
}

interface StoredTicket {
  payload: WsTicketPayload;
  expiresAt: number;
}

export interface WsTicketStoreConfig {
  /** Hard cap on concurrently stored tickets (default 20,000). */
  maxTickets: number;
}

export const DEFAULT_WS_TICKET_STORE_CONFIG: WsTicketStoreConfig = {
  maxTickets: 20_000,
};

/** Raised only when the store is at its hard capacity; message carries no counts. */
export class WsTicketStoreCapacityError extends Error {
  constructor() {
    super('websocket ticket store is at capacity, retry later')
    this.name = 'WsTicketStoreCapacityError'
  }
}

export function createWsTicketStore(
  ttlMs = 60_000,
  now: () => number = Date.now,
  config: Partial<WsTicketStoreConfig> = {},
) {
  const resolved = { ...DEFAULT_WS_TICKET_STORE_CONFIG, ...config }
  const tickets = new Map<string, StoredTicket>();

  function hashTicket(ticket: string): string {
    return createHash('sha256').update(ticket).digest('hex');
  }

  function create(payload: WsTicketPayload): { ticket: string; expiresIn: number } {
    gc();
    if (tickets.size >= resolved.maxTickets) {
      throw new WsTicketStoreCapacityError();
    }
    const ticket = randomBytes(32).toString('base64url');
    // Keys are SHA-256 digests of the ticket; a generation collision with a
    // still-live entry cannot happen at 256 bits, but never overwrite anyway.
    const key = hashTicket(ticket);
    if (tickets.has(key)) {
      throw new WsTicketStoreCapacityError();
    }
    tickets.set(key, {
      payload,
      expiresAt: now() + ttlMs,
    });
    return { ticket, expiresIn: Math.floor(ttlMs / 1000) };
  }

  function consume(ticket: string): WsTicketPayload | null {
    const key = hashTicket(ticket);
    const stored = tickets.get(key);
    if (!stored) return null;
    tickets.delete(key);
    if (stored.expiresAt <= now()) return null;
    return stored.payload;
  }

  function gc(): void {
    const t = now();
    for (const [key, stored] of tickets) {
      if (stored.expiresAt <= t) tickets.delete(key);
    }
  }

  return { create, consume, gc, size: () => tickets.size };
}
