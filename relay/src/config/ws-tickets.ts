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

function hashTicket(ticket: string): string {
  return createHash('sha256').update(ticket).digest('hex');
}

export function createWsTicketStore(ttlMs = 60_000, now = () => Date.now()) {
  const tickets = new Map<string, StoredTicket>();

  function create(payload: WsTicketPayload): { ticket: string; expiresIn: number } {
    const ticket = randomBytes(32).toString('base64url');
    tickets.set(hashTicket(ticket), {
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

  return { create, consume, gc };
}
