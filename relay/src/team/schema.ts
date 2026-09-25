import type pg from 'pg'

export async function initTeamSchema(db: Pick<pg.Pool, 'query'>): Promise<void> {
  await db.query(`ALTER TABLE daemons ADD COLUMN IF NOT EXISTS collaboration_capabilities JSONB NOT NULL DEFAULT '[]'::jsonb`)
  await db.query(`
    CREATE TABLE IF NOT EXISTS collaboration_teams (
      team_id TEXT PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      creator_user_id INT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      state VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'dissolved')),
      revision BIGINT NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      dissolved_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS collaboration_team_memberships (
      membership_id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL REFERENCES collaboration_teams(team_id) ON DELETE CASCADE,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      state VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'left', 'removed')),
      revision BIGINT NOT NULL DEFAULT 1,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ended_at TIMESTAMPTZ,
      UNIQUE (team_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_collaboration_memberships_user
      ON collaboration_team_memberships(user_id, state, team_id);

    CREATE TABLE IF NOT EXISTS collaboration_team_invitations (
      invitation_id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL REFERENCES collaboration_teams(team_id) ON DELETE CASCADE,
      invited_by_user_id INT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      recipient_user_id INT REFERENCES users(id) ON DELETE CASCADE,
      recipient_email VARCHAR(255),
      state VARCHAR(16) NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'accepted', 'declined', 'revoked', 'expired')),
      revision BIGINT NOT NULL DEFAULT 1,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      responded_at TIMESTAMPTZ,
      CHECK (recipient_user_id IS NOT NULL OR recipient_email IS NOT NULL)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_collaboration_pending_invitation_user
      ON collaboration_team_invitations(team_id, recipient_user_id)
      WHERE state = 'pending' AND recipient_user_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_collaboration_pending_invitation_email
      ON collaboration_team_invitations(team_id, lower(recipient_email))
      WHERE state = 'pending' AND recipient_user_id IS NULL;
    CREATE INDEX IF NOT EXISTS idx_collaboration_invitations_recipient
      ON collaboration_team_invitations(recipient_user_id, state, created_at DESC);

    CREATE TABLE IF NOT EXISTS collaboration_team_daemon_bindings (
      daemon_id VARCHAR(64) PRIMARY KEY REFERENCES daemons(daemon_id) ON DELETE RESTRICT,
      team_id TEXT NOT NULL REFERENCES collaboration_teams(team_id) ON DELETE CASCADE,
      owner_user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      revision BIGINT NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_collaboration_daemon_bindings_team
      ON collaboration_team_daemon_bindings(team_id, owner_user_id);

    CREATE TABLE IF NOT EXISTS team_agent_offers (
      offer_id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL REFERENCES collaboration_teams(team_id) ON DELETE CASCADE,
      owner_user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      daemon_id VARCHAR(64) NOT NULL REFERENCES daemons(daemon_id) ON DELETE RESTRICT,
      provider VARCHAR(32) NOT NULL CHECK (provider IN ('codex', 'claude-code')),
      runtime_profile_id TEXT,
      capability_revision BIGINT NOT NULL DEFAULT 1,
      state VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'revoked')),
      revision BIGINT NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at TIMESTAMPTZ
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_team_agent_offer_active_runtime
      ON team_agent_offers(team_id, owner_user_id, daemon_id, provider, COALESCE(runtime_profile_id, ''))
      WHERE state = 'active';
    CREATE INDEX IF NOT EXISTS idx_team_agent_offers_team
      ON team_agent_offers(team_id, state, created_at);

    CREATE TABLE IF NOT EXISTS team_tasks (
      task_id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL REFERENCES collaboration_teams(team_id) ON DELETE CASCADE,
      creator_user_id INT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      title VARCHAR(240) NOT NULL,
      background TEXT NOT NULL DEFAULT '',
      state VARCHAR(24) NOT NULL DEFAULT 'open'
        CHECK (state IN ('open', 'in_progress', 'completed', 'archived', 'deleted')),
      previous_state VARCHAR(24)
        CHECK (previous_state IS NULL OR previous_state IN ('open', 'in_progress', 'completed')),
      revision BIGINT NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at TIMESTAMPTZ,
      UNIQUE (task_id, team_id)
    );
    CREATE INDEX IF NOT EXISTS idx_team_tasks_team_state
      ON team_tasks(team_id, state, updated_at DESC);

    CREATE TABLE IF NOT EXISTS team_task_holders (
      task_id TEXT NOT NULL REFERENCES team_tasks(task_id) ON DELETE CASCADE,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      state VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'released')),
      revision BIGINT NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      released_at TIMESTAMPTZ,
      PRIMARY KEY (task_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS collaboration_sessions (
      team_session_id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL REFERENCES collaboration_teams(team_id) ON DELETE CASCADE,
      creator_user_id INT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      task_id TEXT,
      title VARCHAR(240) NOT NULL,
      state VARCHAR(16) NOT NULL DEFAULT 'active'
        CHECK (state IN ('active', 'paused', 'ended', 'archived')),
      revision BIGINT NOT NULL DEFAULT 1,
      latest_event_seq BIGINT NOT NULL DEFAULT 0,
      current_context_version BIGINT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (team_session_id, team_id),
      FOREIGN KEY (task_id, team_id) REFERENCES team_tasks(task_id, team_id)
    );
    CREATE INDEX IF NOT EXISTS idx_collaboration_sessions_task
      ON collaboration_sessions(task_id) WHERE task_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS collaboration_session_participants (
      participant_id TEXT PRIMARY KEY,
      team_session_id TEXT NOT NULL REFERENCES collaboration_sessions(team_session_id) ON DELETE CASCADE,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      state VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'removed')),
      revision BIGINT NOT NULL DEFAULT 1,
      added_by_user_id INT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      removed_at TIMESTAMPTZ,
      UNIQUE (team_session_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_collaboration_participants_user
      ON collaboration_session_participants(user_id, state, team_session_id);

    CREATE TABLE IF NOT EXISTS collaboration_session_agent_bindings (
      binding_id TEXT PRIMARY KEY,
      team_session_id TEXT NOT NULL REFERENCES collaboration_sessions(team_session_id) ON DELETE CASCADE,
      offer_id TEXT NOT NULL REFERENCES team_agent_offers(offer_id) ON DELETE RESTRICT,
      owner_user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      native_session_id VARCHAR(64),
      state VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'removed', 'unavailable')),
      revision BIGINT NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      removed_at TIMESTAMPTZ
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_collaboration_active_session_offer
      ON collaboration_session_agent_bindings(team_session_id, offer_id) WHERE state = 'active';
    CREATE INDEX IF NOT EXISTS idx_collaboration_session_bindings_offer
      ON collaboration_session_agent_bindings(offer_id, state);

    CREATE TABLE IF NOT EXISTS collaboration_context_versions (
      context_version_id TEXT PRIMARY KEY,
      team_session_id TEXT NOT NULL REFERENCES collaboration_sessions(team_session_id) ON DELETE CASCADE,
      version BIGINT NOT NULL,
      revision BIGINT NOT NULL,
      goal TEXT NOT NULL,
      consensus JSONB NOT NULL DEFAULT '[]'::jsonb,
      open_questions JSONB NOT NULL DEFAULT '[]'::jsonb,
      context_references JSONB NOT NULL DEFAULT '[]'::jsonb,
      content_hash CHAR(64) NOT NULL,
      created_by_user_id INT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (team_session_id, version),
      UNIQUE (team_session_id, content_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_collaboration_context_session
      ON collaboration_context_versions(team_session_id, version DESC);

    CREATE TABLE IF NOT EXISTS collaboration_events (
      event_id TEXT PRIMARY KEY,
      team_session_id TEXT NOT NULL REFERENCES collaboration_sessions(team_session_id) ON DELETE CASCADE,
      event_seq BIGINT NOT NULL,
      kind VARCHAR(24) NOT NULL CHECK (kind IN ('member_message', 'agent_message', 'status', 'context', 'run', 'system')),
      author_user_id INT REFERENCES users(id) ON DELETE SET NULL,
      author_offer_id TEXT REFERENCES team_agent_offers(offer_id) ON DELETE SET NULL,
      target_mode VARCHAR(16) CHECK (target_mode IS NULL OR target_mode IN ('offers', 'all', 'discussion')),
      target_offer_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      reference_event_id TEXT REFERENCES collaboration_events(event_id) ON DELETE SET NULL,
      reference_event_seq BIGINT,
      context_version BIGINT,
      call_id TEXT,
      content TEXT NOT NULL,
      request_id VARCHAR(128),
      request_hash CHAR(64),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (team_session_id, event_seq)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_collaboration_member_event_request
      ON collaboration_events(team_session_id, author_user_id, request_id)
      WHERE author_user_id IS NOT NULL AND request_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_collaboration_events_replay
      ON collaboration_events(team_session_id, event_seq);

    CREATE TABLE IF NOT EXISTS collaboration_calls (
      call_id TEXT PRIMARY KEY,
      team_session_id TEXT NOT NULL REFERENCES collaboration_sessions(team_session_id) ON DELETE CASCADE,
      run_id TEXT,
      event_id TEXT NOT NULL REFERENCES collaboration_events(event_id) ON DELETE CASCADE,
      offer_id TEXT NOT NULL REFERENCES team_agent_offers(offer_id) ON DELETE RESTRICT,
      binding_id TEXT REFERENCES collaboration_session_agent_bindings(binding_id) ON DELETE RESTRICT,
      native_session_id VARCHAR(64),
      provider_request_id TEXT,
      operation VARCHAR(16) CHECK (operation IS NULL OR operation IN ('create', 'message')),
      binding_revision BIGINT,
      offer_revision BIGINT,
      quota_reservation_id UUID,
      context_snapshot_hash CHAR(64),
      history_through_event_seq BIGINT NOT NULL DEFAULT 0,
      context_version BIGINT NOT NULL DEFAULT 0,
      state VARCHAR(16) NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'dispatched', 'accepted', 'completed', 'failed', 'blocked', 'cancelled', 'uncertain')),
      outcome TEXT,
      dispatched_at TIMESTAMPTZ,
      accepted_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (event_id, offer_id)
    );
    CREATE INDEX IF NOT EXISTS idx_collaboration_calls_pending
      ON collaboration_calls(state, created_at) WHERE state = 'pending';
    CREATE UNIQUE INDEX IF NOT EXISTS uq_collaboration_active_binding_call
      ON collaboration_calls(binding_id)
      WHERE binding_id IS NOT NULL AND state IN ('dispatched', 'accepted', 'uncertain');

    CREATE TABLE IF NOT EXISTS collaboration_context_deliveries (
      delivery_id TEXT PRIMARY KEY,
      call_id TEXT NOT NULL UNIQUE REFERENCES collaboration_calls(call_id) ON DELETE CASCADE,
      binding_id TEXT NOT NULL REFERENCES collaboration_session_agent_bindings(binding_id) ON DELETE RESTRICT,
      context_version BIGINT NOT NULL,
      content_hash CHAR(64) NOT NULL,
      history_through_event_seq BIGINT NOT NULL,
      payload_hash CHAR(64) NOT NULL,
      payload_bytes INT NOT NULL,
      truncated BOOLEAN NOT NULL DEFAULT false,
      state VARCHAR(16) NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'dispatched', 'accepted', 'failed', 'uncertain')),
      outcome TEXT,
      dispatched_at TIMESTAMPTZ,
      receipt_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS collaboration_team_idempotency (
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      operation VARCHAR(256) NOT NULL,
      request_id VARCHAR(128) NOT NULL,
      request_hash CHAR(64) NOT NULL,
      response JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, operation, request_id)
    );
    CREATE INDEX IF NOT EXISTS idx_collaboration_team_idempotency_created
      ON collaboration_team_idempotency(created_at);
  `)
  await db.query(`
    ALTER TABLE collaboration_calls ADD COLUMN IF NOT EXISTS binding_id TEXT REFERENCES collaboration_session_agent_bindings(binding_id) ON DELETE RESTRICT;
    ALTER TABLE collaboration_calls ADD COLUMN IF NOT EXISTS operation VARCHAR(16);
    ALTER TABLE collaboration_calls ADD COLUMN IF NOT EXISTS binding_revision BIGINT;
    ALTER TABLE collaboration_calls ADD COLUMN IF NOT EXISTS offer_revision BIGINT;
    ALTER TABLE collaboration_calls ADD COLUMN IF NOT EXISTS quota_reservation_id UUID;
    ALTER TABLE collaboration_calls ADD COLUMN IF NOT EXISTS context_snapshot_hash CHAR(64);
    ALTER TABLE collaboration_calls ADD COLUMN IF NOT EXISTS history_through_event_seq BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE collaboration_calls ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ;
    ALTER TABLE collaboration_calls ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ;
    ALTER TABLE collaboration_calls ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_collaboration_active_binding_call
      ON collaboration_calls(binding_id)
      WHERE binding_id IS NOT NULL AND state IN ('dispatched', 'accepted', 'uncertain');
    ALTER TABLE collaboration_team_idempotency
      ALTER COLUMN operation TYPE VARCHAR(256)
  `)
}
