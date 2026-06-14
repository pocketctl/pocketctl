-- pocketctl schema
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
