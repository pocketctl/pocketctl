import type pg from 'pg'

// Shared immutable history refers to an identity, not an active login. These
// rows contain no profile, credential, email, hostname or workspace data.
const historicalActors = [
  ['collaboration_teams', 'creator_user_id'],
  ['collaboration_team_invitations', 'invited_by_user_id'],
  ['team_memory_bindings', 'created_by_user_id'],
  ['team_agent_offers', 'owner_user_id'],
  ['team_tasks', 'creator_user_id'],
  ['collaboration_sessions', 'creator_user_id'],
  ['collaboration_session_participants', 'added_by_user_id'],
  ['collaboration_session_agent_bindings', 'owner_user_id'],
  ['collaboration_context_versions', 'created_by_user_id'],
  ['collaboration_runs', 'initiator_user_id'],
  ['team_task_specs', 'reviewer_user_id'],
  ['team_task_specs', 'created_by_user_id'],
  ['team_task_submissions', 'submitted_by_user_id'],
  ['team_artifact_revocations', 'actor_user_id'],
  ['team_acceptance_decisions', 'reviewer_user_id'],
] as const

export async function initTeamAccountLifecycleSchema(db: Pick<pg.Pool, 'query'>): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS team_actor_identities (
      actor_user_id INT PRIMARY KEY,
      account_user_id INT UNIQUE REFERENCES users(id) ON DELETE SET NULL,
      CHECK(account_user_id IS NULL OR account_user_id=actor_user_id)
    );
    CREATE TABLE IF NOT EXISTS team_daemon_identities (
      daemon_id VARCHAR(64) PRIMARY KEY,
      live_daemon_id VARCHAR(64) UNIQUE REFERENCES daemons(daemon_id) ON DELETE SET NULL,
      CHECK(live_daemon_id IS NULL OR live_daemon_id=daemon_id)
    );
    INSERT INTO team_actor_identities SELECT id,id FROM users ON CONFLICT DO NOTHING;
    INSERT INTO team_daemon_identities SELECT daemon_id,daemon_id FROM daemons ON CONFLICT DO NOTHING;
    CREATE OR REPLACE FUNCTION register_team_actor_identity() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      -- An erased account number must never become a different person's actor.
      INSERT INTO team_actor_identities(actor_user_id,account_user_id) VALUES(NEW.id,NEW.id);
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS register_team_actor_identity ON users;
    CREATE TRIGGER register_team_actor_identity AFTER INSERT ON users
      FOR EACH ROW EXECUTE FUNCTION register_team_actor_identity();
    CREATE OR REPLACE FUNCTION register_team_daemon_identity() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      -- A stable machine may register again; old offers remain revoked and
      -- owned by their original actor, never by the new machine owner.
      INSERT INTO team_daemon_identities(daemon_id,live_daemon_id) VALUES(NEW.daemon_id,NEW.daemon_id)
        ON CONFLICT(daemon_id) DO UPDATE SET live_daemon_id=EXCLUDED.live_daemon_id;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS register_team_daemon_identity ON daemons;
    CREATE TRIGGER register_team_daemon_identity AFTER INSERT ON daemons
      FOR EACH ROW EXECUTE FUNCTION register_team_daemon_identity();
    CREATE TABLE IF NOT EXISTS team_account_deletion_audit (
      actor_user_id INT PRIMARY KEY REFERENCES team_actor_identities(actor_user_id),
      dissolved_teams INT NOT NULL CHECK(dissolved_teams>=0),
      removed_preparations INT NOT NULL CHECK(removed_preparations>=0),
      deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `)
  const references = [
    ...historicalActors.map(([table,column]) => ({table,column,oldTable:'users',target:'team_actor_identities',key:'actor_user_id'})),
    {table:'team_agent_offers',column:'daemon_id',oldTable:'daemons',target:'team_daemon_identities',key:'daemon_id'},
  ]
  for (const {table,column,oldTable,target,key} of references) {
    // Identifiers are a closed source-code list, never request/config data.
    const name = `${table}_${column}_history_fk`.slice(0,63)
    await db.query(`DO $$ DECLARE existing RECORD; BEGIN
      FOR existing IN SELECT c.conname FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid=c.conrelid AND c.conkey=ARRAY[a.attnum]::smallint[]
        WHERE c.contype='f' AND c.conrelid='${table}'::regclass AND c.confrelid='${oldTable}'::regclass
          AND a.attname='${column}'
      LOOP EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I','${table}',existing.conname); END LOOP;
      IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='${table}'::regclass AND conname='${name}') THEN
        ALTER TABLE ${table} ADD CONSTRAINT ${name} FOREIGN KEY(${column}) REFERENCES ${target}(${key}) ON DELETE RESTRICT;
      END IF;
    END $$`)
  }
  // Old binaries must not erase a live identity while leaving shared access
  // active. They can read the additive schema, but Team-linked deletion must
  // use the new revocation transaction rather than silently orphaning a Team.
  const hasHistory = historicalActors.map(([table,column]) => `EXISTS(SELECT 1 FROM ${table} WHERE ${column}=OLD.id)`)
  hasHistory.push('EXISTS(SELECT 1 FROM collaboration_team_memberships WHERE user_id=OLD.id)')
  await db.query(`
    CREATE OR REPLACE FUNCTION require_team_account_revocation() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF (${hasHistory.join(' OR ')}) AND NOT EXISTS(SELECT 1 FROM team_account_deletion_audit WHERE actor_user_id=OLD.id) THEN
        RAISE EXCEPTION 'Team account revocation transaction required' USING ERRCODE='55000';
      END IF;
      RETURN OLD;
    END $$;
    DROP TRIGGER IF EXISTS require_team_account_revocation ON users;
    CREATE TRIGGER require_team_account_revocation BEFORE DELETE ON users
      FOR EACH ROW EXECUTE FUNCTION require_team_account_revocation();
    CREATE OR REPLACE FUNCTION require_team_daemon_revocation() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS(SELECT 1 FROM team_agent_offers WHERE daemon_id=OLD.daemon_id AND state='active') THEN
        RAISE EXCEPTION 'revoke shared Agent offers before deleting host' USING ERRCODE='55000';
      END IF;
      RETURN OLD;
    END $$;
    DROP TRIGGER IF EXISTS require_team_daemon_revocation ON daemons;
    CREATE TRIGGER require_team_daemon_revocation BEFORE DELETE ON daemons
      FOR EACH ROW EXECUTE FUNCTION require_team_daemon_revocation();
  `)
}
