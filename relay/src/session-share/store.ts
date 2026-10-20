import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

export interface ShareRecord {
  id: string; user_id: number; session_id: string; title: string;
  created_at: Date; expires_at: Date; revoked_at: Date | null; server_time: Date;
}
export interface ShareStore {
  create(userId: number, sessionId: string, requestId: string): Promise<ShareRecord>;
  list(userId: number, sessionId?: string): Promise<ShareRecord[]>;
  get(userId: number, id: string): Promise<ShareRecord | null>;
  revoke(userId: number, id: string): Promise<ShareRecord | null>;
}
export class ShareConflict extends Error {}
export class ShareLimit extends Error {}

export async function initSessionShareSchema(pool: Pick<Pool, 'query'>): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS session_share_links (
      id UUID PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id VARCHAR(64) NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      request_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      UNIQUE(user_id, request_id),
      CHECK(expires_at = created_at + INTERVAL '15 minutes')
    );
    CREATE INDEX IF NOT EXISTS session_share_active ON session_share_links(user_id, expires_at DESC);
  `);
}
const projection = `l.*, s.title, clock_timestamp() AS server_time`;
const owned = `JOIN sessions s ON s.session_id=l.session_id AND s.user_id=l.user_id`;
export function postgresShareStore(pool: Pool): ShareStore {
  const get = async (userId: number, id: string) => {
    const result = await pool.query<ShareRecord>(`SELECT ${projection} FROM session_share_links l ${owned} WHERE l.user_id=$1 AND l.id=$2`, [userId, id]);
    return result.rows[0] ?? null;
  };
  return {
    get,
    async list(userId, sessionId) {
      const result = await pool.query<ShareRecord>(`SELECT ${projection} FROM session_share_links l ${owned}
        WHERE l.user_id=$1 AND l.revoked_at IS NULL AND l.expires_at>clock_timestamp()
        AND ($2::text IS NULL OR l.session_id=$2) ORDER BY l.created_at DESC,l.id DESC`, [userId, sessionId ?? null]);
      return result.rows;
    },
    async create(userId, sessionId, requestId) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Serialize per owner: concurrent retries and the active-link quota are atomic.
        await client.query(`SELECT pg_advisory_xact_lock(hashtext('session-share'),$1)`, [userId]);
        const previous = await client.query<ShareRecord>(`SELECT ${projection} FROM session_share_links l ${owned} WHERE l.user_id=$1 AND l.request_id=$2`, [userId, requestId]);
        if (previous.rows[0]) {
          if (previous.rows[0].session_id !== sessionId) throw new ShareConflict();
          await client.query('COMMIT');
          return previous.rows[0];
        }
        const count = await client.query(`SELECT count(*)::int AS n FROM session_share_links WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>clock_timestamp()`, [userId]);
        if (count.rows[0].n >= 100) throw new ShareLimit();
        const id = randomUUID();
        const result = await client.query<ShareRecord>(`WITH inserted AS (
          INSERT INTO session_share_links(id,user_id,session_id,request_id,created_at,expires_at)
          SELECT $1::uuid,$2::int,$3::varchar(64),$4::uuid,date_trunc('second',statement_timestamp()),date_trunc('second',statement_timestamp())+INTERVAL '15 minutes'
          FROM sessions WHERE session_id=$3::varchar(64) AND user_id=$2::int AND session_id NOT LIKE 'pending-%'
          RETURNING *)
          SELECT l.*,s.title,clock_timestamp() AS server_time FROM inserted l ${owned}`, [id,userId,sessionId,requestId]);
        if (!result.rows[0]) throw new ShareConflict();
        await client.query('COMMIT');
        return result.rows[0];
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    },
    async revoke(userId, id) {
      await pool.query(`UPDATE session_share_links l SET revoked_at=COALESCE(l.revoked_at,clock_timestamp())
        FROM sessions s WHERE l.id=$2 AND l.user_id=$1 AND s.session_id=l.session_id AND s.user_id=l.user_id`, [userId,id]);
      return get(userId,id);
    },
  };
}
