import { createHash, randomBytes } from 'crypto';
import type pg from 'pg';

export interface WsTicketPayload {
  userId: number;
  email: string;
  jti: string;
  machine_id: string;
}

export interface WsTicketPersistence {
  insert(
    ticketHash: string,
    payload: WsTicketPayload,
    ttlMs: number,
    maxTickets: number,
  ): Promise<boolean>;
  consume(ticketHash: string): Promise<WsTicketPayload | null>;
}

export interface WsTicketStoreConfig {
  /** Hard cap on concurrently stored tickets across all Relay instances. */
  maxTickets: number;
}

export const DEFAULT_WS_TICKET_STORE_CONFIG: WsTicketStoreConfig = {
  maxTickets: 20_000,
};

/** Raised only when the shared store is at capacity; message carries no counts. */
export class WsTicketStoreCapacityError extends Error {
  constructor() {
    super('websocket ticket store is at capacity, retry later');
    this.name = 'WsTicketStoreCapacityError';
  }
}

function hashTicket(ticket: string): string {
  return createHash('sha256').update(ticket).digest('hex');
}

export function createWsTicketStore(
  persistence: WsTicketPersistence,
  ttlMs = 60_000,
  config: Partial<WsTicketStoreConfig> = {},
) {
  const resolved = { ...DEFAULT_WS_TICKET_STORE_CONFIG, ...config };

  async function create(payload: WsTicketPayload): Promise<{ ticket: string; expiresIn: number }> {
    const ticket = randomBytes(32).toString('base64url');
    const inserted = await persistence.insert(
      hashTicket(ticket),
      payload,
      ttlMs,
      resolved.maxTickets,
    );
    if (!inserted) throw new WsTicketStoreCapacityError();
    return { ticket, expiresIn: Math.floor(ttlMs / 1000) };
  }

  async function consume(ticket: string): Promise<WsTicketPayload | null> {
    return persistence.consume(hashTicket(ticket));
  }

  return { create, consume };
}

export function createPostgresWsTicketPersistence(pool: pg.Pool): WsTicketPersistence {
  return {
    async insert(ticketHash, payload, ttlMs, maxTickets) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // A separate lock statement is intentional: under READ COMMITTED, a
        // waiter gets a fresh snapshot after the preceding issuer commits.
        await client.query(`SELECT pg_advisory_xact_lock(hashtext('pocketctl-ws-ticket-capacity-v1'))`);
        await client.query('DELETE FROM websocket_tickets WHERE expires_at <= NOW()');
        const count = await client.query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM websocket_tickets',
        );
        if (Number(count.rows[0]?.count ?? maxTickets) >= maxTickets) {
          await client.query('ROLLBACK');
          return false;
        }
        const inserted = await client.query(
          `INSERT INTO websocket_tickets
             (ticket_hash, user_id, email, token_jti, machine_id, expires_at)
           VALUES ($1, $2, $3, $4, $5, NOW() + ($6::double precision * interval '1 millisecond'))
           ON CONFLICT (ticket_hash) DO NOTHING
           RETURNING ticket_hash`,
          [ticketHash, payload.userId, payload.email, payload.jti, payload.machine_id, ttlMs],
        );
        if (inserted.rowCount !== 1) {
          await client.query('ROLLBACK');
          return false;
        }
        await client.query('COMMIT');
        return true;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Preserve the original persistence failure.
        }
        throw error;
      } finally {
        client.release();
      }
    },

    async consume(ticketHash) {
      const result = await pool.query<{
        user_id: number;
        email: string;
        token_jti: string;
        machine_id: string;
        live: boolean;
      }>(
        `WITH consumed AS (
           DELETE FROM websocket_tickets
           WHERE ticket_hash = $1
           RETURNING user_id, email, token_jti, machine_id, expires_at > NOW() AS live
         )
         SELECT user_id, email, token_jti, machine_id, live
         FROM consumed
         WHERE live`,
        [ticketHash],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        userId: Number(row.user_id),
        email: row.email,
        jti: row.token_jti,
        machine_id: row.machine_id,
      };
    },
  };
}
