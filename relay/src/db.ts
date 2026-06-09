import pg from 'pg';
const { Pool } = pg;

export interface DBConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export function createPool(config: DBConfig): pg.Pool {
  return new Pool(config);
}

export async function initDB(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS daemons (
      id SERIAL PRIMARY KEY,
      daemon_id VARCHAR(64) UNIQUE NOT NULL,
      hostname VARCHAR(255),
      agents JSONB DEFAULT '[]',
      status VARCHAR(32) DEFAULT 'offline',
      last_heartbeat TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id SERIAL PRIMARY KEY,
      session_id VARCHAR(64) UNIQUE NOT NULL,
      daemon_id VARCHAR(64) REFERENCES daemons(daemon_id),
      agent_type VARCHAR(64),
      cwd TEXT,
      title TEXT,
      source VARCHAR(16) DEFAULT 'daemon',
      status VARCHAR(32) DEFAULT 'running',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS events (
      id BIGSERIAL PRIMARY KEY,
      session_id VARCHAR(64) NOT NULL,
      event_type VARCHAR(64) NOT NULL,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_daemon ON sessions(daemon_id);
    CREATE INDEX IF NOT EXISTS idx_events_session_id ON events(session_id, id);
  `);
  // Migration: add title and source columns to existing sessions table
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS title TEXT`);
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS source VARCHAR(16) DEFAULT 'daemon'`);
  // Migration: add last_activity_at and exit_reason columns
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS exit_reason VARCHAR(32)`);
  // Migration: add subagent_count column
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS subagent_count INT DEFAULT 0`);

  // Phase 2: users table for authentication
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      display_name VARCHAR(100),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Phase 2: add user_id to sessions and daemons
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_id INT`);
  await pool.query(`ALTER TABLE daemons ADD COLUMN IF NOT EXISTS user_id INT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)`);

  // Phase 3: devices table for push notifications
  await pool.query(`
    CREATE TABLE IF NOT EXISTS devices (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device_token VARCHAR(512) NOT NULL,
      platform VARCHAR(16) DEFAULT 'ios',
      device_name VARCHAR(255),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, device_token)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id)`);

  // Phase 3: add phone column to users for SMS auth
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(32)`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone) WHERE phone IS NOT NULL`);

  // Session delete tombstone table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS deleted_sessions (
      session_id VARCHAR(64) PRIMARY KEY,
      deleted_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

export async function upsertDaemon(pool: pg.Pool, daemonId: string, hostname: string, agents: string[]): Promise<void> {
  await pool.query(
    `INSERT INTO daemons (daemon_id, hostname, agents, status, last_heartbeat)
     VALUES ($1, $2, $3, 'online', NOW())
     ON CONFLICT (daemon_id) DO UPDATE SET hostname = $2, agents = $3, status = 'online', last_heartbeat = NOW()`,
    [daemonId, hostname, JSON.stringify(agents)]
  );
}

export async function setDaemonOffline(pool: pg.Pool, daemonId: string): Promise<void> {
  await pool.query(`UPDATE daemons SET status = 'offline' WHERE daemon_id = $1`, [daemonId]);
}

export async function updateHeartbeat(pool: pg.Pool, daemonId: string): Promise<void> {
  await pool.query(`UPDATE daemons SET last_heartbeat = NOW() WHERE daemon_id = $1`, [daemonId]);
}

export async function insertEvent(pool: pg.Pool, sessionId: string, eventType: string, payload: any): Promise<number> {
  const result = await pool.query(
    `INSERT INTO events (session_id, event_type, payload) VALUES ($1, $2, $3) RETURNING id`,
    [sessionId, eventType, JSON.stringify(payload)]
  );
  // Update last_activity_at for the session
  pool.query(`UPDATE sessions SET last_activity_at = NOW(), updated_at = NOW() WHERE session_id = $1`, [sessionId]).catch(console.error);
  return result.rows[0].id;
}

export async function getEventsAfter(pool: pg.Pool, sessionId: string, lastSeq: number): Promise<any[]> {
  const result = await pool.query(
    `SELECT id, session_id, event_type, payload, created_at FROM events WHERE session_id = $1 AND id > $2 ORDER BY id ASC`,
    [sessionId, lastSeq]
  );
  return result.rows;
}

export async function listSessions(pool: pg.Pool): Promise<any[]> {
  const result = await pool.query(
    `SELECT s.session_id, s.daemon_id, s.agent_type, s.cwd, s.title, s.source, s.status,
            s.created_at, s.updated_at, s.last_activity_at, s.exit_reason, s.subagent_count,
            d.status AS daemon_status, d.hostname AS hostname
     FROM sessions s
     LEFT JOIN daemons d ON s.daemon_id = d.daemon_id
     WHERE s.status NOT IN ('completed', 'error', 'killed')
       AND s.session_id NOT LIKE 'pending-%'
     ORDER BY COALESCE(s.last_activity_at, s.updated_at) DESC`
  );
  return result.rows.map((row: any) => ({
    ...row,
    daemon_online: row.daemon_status === 'online',
    daemon_status: undefined,
  }));
}

export async function upsertSession(pool: pg.Pool, sessionId: string, daemonId: string, agentType: string, cwd: string, status: string, title?: string, source?: string, exitReason?: string, userId?: number): Promise<void> {
  await pool.query(
    `INSERT INTO sessions (session_id, daemon_id, agent_type, cwd, title, source, status, exit_reason, user_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
     ON CONFLICT (session_id) DO UPDATE SET
       daemon_id = $2,
       status = $7,
       title = COALESCE($5, sessions.title),
       source = COALESCE($6, sessions.source),
       exit_reason = COALESCE($8, sessions.exit_reason),
       user_id = COALESCE($9, sessions.user_id),
       updated_at = NOW()`,
    [sessionId, daemonId, agentType, cwd, title || null, source || 'daemon', status, exitReason || null, userId || null]
  );
}

/** Increment subagent_count for a session. */
export async function incrementSubagentCount(pool: pg.Pool, sessionId: string): Promise<void> {
  await pool.query(
    `UPDATE sessions SET subagent_count = subagent_count + 1, updated_at = NOW() WHERE session_id = $1`,
    [sessionId]
  );
}

/** Mark sessions as completed if their daemon has been offline for > 5 minutes. */
export async function cleanStaleSessions(pool: pg.Pool): Promise<void> {
  await pool.query(`
    UPDATE sessions SET status = 'completed', updated_at = NOW()
    WHERE status IN ('running', 'busy')
      AND daemon_id NOT IN (SELECT daemon_id FROM daemons WHERE status = 'online' AND last_heartbeat > NOW() - INTERVAL '5 minutes')
  `);
  // Also purge ghost pending-* sessions older than 1 hour
  await pool.query(`
    DELETE FROM sessions
    WHERE session_id LIKE 'pending-%'
      AND created_at < NOW() - INTERVAL '1 hour'
  `);
}

// --- Phase 2: User management ---

export async function createUser(pool: pg.Pool, email: string, passwordHash: string, displayName?: string): Promise<any> {
  const result = await pool.query(
    `INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id, email, display_name, created_at`,
    [email, passwordHash, displayName || null]
  );
  return result.rows[0];
}

export async function getUserByEmail(pool: pg.Pool, email: string): Promise<any | null> {
  const result = await pool.query(
    `SELECT id, email, password_hash, display_name, created_at FROM users WHERE email = $1`,
    [email]
  );
  return result.rows[0] || null;
}

export async function getUserById(pool: pg.Pool, id: number): Promise<any | null> {
  const result = await pool.query(
    `SELECT id, email, display_name, created_at FROM users WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

export async function bindDaemonToUser(pool: pg.Pool, daemonId: string, userId: number): Promise<void> {
  await pool.query(`UPDATE daemons SET user_id = $1 WHERE daemon_id = $2`, [userId, daemonId]);
}

export async function listSessionsByUser(pool: pg.Pool, userId: number): Promise<any[]> {
  const result = await pool.query(
    `SELECT s.session_id, s.daemon_id, s.agent_type, s.cwd, s.title, s.source, s.status,
            s.created_at, s.updated_at, s.last_activity_at, s.exit_reason, s.subagent_count,
            d.status AS daemon_status, d.hostname AS hostname
     FROM sessions s
     LEFT JOIN daemons d ON s.daemon_id = d.daemon_id
     WHERE s.user_id = $1
       AND s.status NOT IN ('completed', 'error', 'killed')
       AND s.session_id NOT LIKE 'pending-%'
     ORDER BY COALESCE(s.last_activity_at, s.updated_at) DESC`,
    [userId]
  );
  return result.rows.map((row: any) => ({
    ...row,
    daemon_online: row.daemon_status === 'online',
    daemon_status: undefined,
  }));
}

// --- Session deletion ---

export async function deleteSession(pool: pg.Pool, sessionId: string): Promise<void> {
  await pool.query(`DELETE FROM events WHERE session_id = $1`, [sessionId]);
  await pool.query(`DELETE FROM sessions WHERE session_id = $1`, [sessionId]);
  await pool.query(
    `INSERT INTO deleted_sessions (session_id) VALUES ($1) ON CONFLICT (session_id) DO UPDATE SET deleted_at = NOW()`,
    [sessionId]
  );
}

export async function isSessionDeleted(pool: pg.Pool, sessionId: string): Promise<boolean> {
  const result = await pool.query(`SELECT 1 FROM deleted_sessions WHERE session_id = $1`, [sessionId]);
  return (result.rowCount ?? 0) > 0;
}

/// Clean up tombstones older than 30 days
export async function cleanStaleTombstones(pool: pg.Pool): Promise<number> {
  const result = await pool.query(`DELETE FROM deleted_sessions WHERE deleted_at < NOW() - INTERVAL '30 days'`);
  return result.rowCount ?? 0;
}

// --- Phase 3: Device management for push notifications ---

export async function registerDevice(pool: pg.Pool, userId: number, deviceToken: string, platform: string, deviceName?: string): Promise<void> {
  await pool.query(
    `INSERT INTO devices (user_id, device_token, platform, device_name, last_seen_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (user_id, device_token) DO UPDATE SET last_seen_at = NOW(), device_name = COALESCE($4, devices.device_name)`,
    [userId, deviceToken, platform, deviceName || null]
  );
}

export async function removeDevice(pool: pg.Pool, deviceToken: string): Promise<void> {
  await pool.query(`DELETE FROM devices WHERE device_token = $1`, [deviceToken]);
}

export async function getDevicesByUser(pool: pg.Pool, userId: number): Promise<any[]> {
  const result = await pool.query(
    `SELECT id, user_id, device_token, platform, device_name, created_at, last_seen_at FROM devices WHERE user_id = $1`,
    [userId]
  );
  return result.rows;
}

// --- Phase 3: Phone-based user management for SMS auth ---

export async function getUserByPhone(pool: pg.Pool, phone: string): Promise<any | null> {
  const result = await pool.query(
    `SELECT id, email, phone, password_hash, display_name, created_at FROM users WHERE phone = $1`,
    [phone]
  );
  return result.rows[0] || null;
}

export async function createUserByPhone(pool: pg.Pool, phone: string, displayName?: string): Promise<any> {
  const result = await pool.query(
    `INSERT INTO users (email, phone, password_hash, display_name)
     VALUES ($1, $1, '', $2)
     RETURNING id, email, phone, display_name, created_at`,
    [phone, displayName || null]
  );
  return result.rows[0];
}

export function parseDBUrl(url: string): DBConfig {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname,
      port: parseInt(parsed.port || '5432'),
      database: parsed.pathname.slice(1),
      user: parsed.username,
      password: parsed.password,
    };
  } catch {
    return { host: 'localhost', port: 5432, database: 'pocketctl', user: 'postgres', password: '' };
  }
}
