import type pg from 'pg'

/** Additive only: cold body constraints are introduced after all readers work. */
export async function initSessionLifecycleSchema(
  db: Pick<pg.Pool, 'query'>,
): Promise<void> {
  await db.query(`
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS activity_epoch BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_business_activity_at TIMESTAMPTZ;
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS activity_verified BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS archive_reason TEXT CHECK (archive_reason IN ('manual','inactivity'));
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS content_state TEXT NOT NULL DEFAULT 'hot'
      CHECK (content_state IN ('hot','cooling','cold','mixed','deleting','deleted'));
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS cooling_operation_id UUID;

    CREATE TABLE IF NOT EXISTS session_lifecycle_daily_runs (
      policy_version TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('archive','purge')),
      scheduled_at TIMESTAMPTZ NOT NULL,
      after_row_id BIGINT NOT NULL DEFAULT 0,
      scan_complete BOOLEAN NOT NULL DEFAULT false,
      completed_at TIMESTAMPTZ,
      lease_token UUID,
      lease_until TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(policy_version,action,scheduled_at),
      CHECK((lease_token IS NULL)=(lease_until IS NULL))
    );
    CREATE TABLE IF NOT EXISTS session_lifecycle_scan_state (
      policy_version TEXT PRIMARY KEY,
      after_row_id BIGINT NOT NULL DEFAULT 0 CHECK (after_row_id >= 0),
      next_scan_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      lease_token UUID,
      lease_until TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK ((lease_token IS NULL) = (lease_until IS NULL))
    );

    CREATE TABLE IF NOT EXISTS session_lifecycle_jobs (
      operation_id UUID PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id VARCHAR(128) NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('archive','cool','resume','purge')),
      policy_version TEXT NOT NULL,
      activity_epoch BIGINT NOT NULL CHECK (activity_epoch >= 0),
      state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','succeeded','partial','failed','cancelled')),
      lease_owner TEXT,
      lease_token UUID,
      lease_until TIMESTAMPTZ,
      attempt INT NOT NULL DEFAULT 0 CHECK (attempt >= 0),
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      result JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, session_id, action, activity_epoch, policy_version),
      CHECK ((state = 'running' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
        OR (state <> 'running' AND lease_owner IS NULL AND lease_token IS NULL AND lease_until IS NULL))
    );
    CREATE TABLE IF NOT EXISTS session_lifecycle_stale_audit (
      operation_id UUID PRIMARY KEY REFERENCES session_lifecycle_jobs(operation_id) ON DELETE CASCADE,
      session_id VARCHAR(128) NOT NULL,
      stable_since TIMESTAMPTZ NOT NULL,
      pending_effects INT NOT NULL,
      pending_inbox INT NOT NULL,
      previous_states JSONB NOT NULL,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_lifecycle_jobs_claim
      ON session_lifecycle_jobs(next_attempt_at, created_at, operation_id)
      WHERE state IN ('queued','failed','partial','running');

    CREATE TABLE IF NOT EXISTS session_lifecycle_attempts (
      operation_id UUID NOT NULL REFERENCES session_lifecycle_jobs(operation_id) ON DELETE CASCADE,
      attempt INT NOT NULL CHECK(attempt>0),
      lease_token UUID NOT NULL,
      worker VARCHAR(128) NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ,
      state TEXT NOT NULL CHECK(state IN ('running','expired','succeeded','partial','failed','cancelled')),
      result JSONB,
      PRIMARY KEY(operation_id,attempt)
    );
    CREATE OR REPLACE FUNCTION journal_session_lifecycle_attempt() RETURNS TRIGGER LANGUAGE plpgsql AS $$ DECLARE notice UUID; BEGIN
      IF OLD.state='running' AND (NEW.state<>'running' OR NEW.lease_token IS DISTINCT FROM OLD.lease_token) THEN
        UPDATE session_lifecycle_attempts SET finished_at=NOW(),
          state=CASE WHEN NEW.state='running' THEN 'expired' ELSE NEW.state END,
          result=CASE WHEN NEW.state='running' THEN NULL ELSE NEW.result END
        WHERE operation_id=OLD.operation_id AND attempt=OLD.attempt AND lease_token=OLD.lease_token AND state='running';
      END IF;
      IF NEW.state='running' AND NEW.lease_token IS DISTINCT FROM OLD.lease_token THEN
        INSERT INTO session_lifecycle_attempts(operation_id,attempt,lease_token,worker,state)
        VALUES(NEW.operation_id,NEW.attempt,NEW.lease_token,NEW.lease_owner,'running');
      END IF;
      IF NEW.state='cancelled' AND OLD.state<>'cancelled' THEN
        UPDATE session_lifecycle_results SET state='cancelled',reason_code='superseded',executed_at=NOW(),updated_at=NOW(),revision=revision+1,
          stages=CASE WHEN stages->>'cool'='pending' THEN jsonb_set(stages,'{cool}','"not_applicable"') ELSE stages END
          WHERE operation_id=NEW.operation_id AND state IN ('running','partial','failed') RETURNING notification_id INTO notice;
        IF notice IS NOT NULL THEN
          UPDATE attention_notification_subjects SET state='cancelled',reason_code='superseded',executed_at=NOW() WHERE operation_id=NEW.operation_id;
          UPDATE attention_notifications SET revision=revision+1,read_at=NULL,completed_at=NOW(),updated_at=NOW() WHERE notification_id=notice;
          INSERT INTO notification_delivery_outbox(user_id,notification_id,revision,operation)
            SELECT user_id,notification_id,revision,'changed' FROM attention_notifications WHERE notification_id=notice ON CONFLICT DO NOTHING;
          PERFORM pg_notify('pocketctl_attention',json_build_object('entity','notification','user_id',NEW.user_id,'item_id',notice,
            'revision',(SELECT revision FROM attention_notifications WHERE notification_id=notice),'operation','changed')::text);
        END IF;
      END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS lifecycle_attempt_journal ON session_lifecycle_jobs;
    CREATE TRIGGER lifecycle_attempt_journal AFTER UPDATE ON session_lifecycle_jobs
      FOR EACH ROW EXECUTE FUNCTION journal_session_lifecycle_attempt();

    CREATE TABLE IF NOT EXISTS session_lifecycle_results (
      operation_id UUID PRIMARY KEY REFERENCES session_lifecycle_jobs(operation_id) ON DELETE CASCADE,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id VARCHAR(128) NOT NULL,
      daemon_id VARCHAR(64) NOT NULL,
      title_snapshot VARCHAR(512) NOT NULL,
      daemon_name_snapshot VARCHAR(255) NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('archive','cool','resume','purge')),
      state TEXT NOT NULL CHECK (state IN ('running','succeeded','partial','failed','cancelled')),
      activity_at TIMESTAMPTZ NOT NULL,
      executed_at TIMESTAMPTZ,
      effective_purge_at TIMESTAMPTZ,
      reason_code VARCHAR(64) NOT NULL,
      revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
      stages JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE session_lifecycle_results ADD COLUMN IF NOT EXISTS notification_id UUID;
    ALTER TABLE session_lifecycle_results ADD COLUMN IF NOT EXISTS notification_revision BIGINT;

    CREATE TABLE IF NOT EXISTS session_archive_manifests (
      manifest_id UUID PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id VARCHAR(128) NOT NULL,
      activity_epoch BIGINT NOT NULL CHECK (activity_epoch >= 0),
      schema_version INT NOT NULL CHECK (schema_version = 1),
      codec TEXT NOT NULL CHECK (codec = 'gzip'),
      state TEXT NOT NULL CHECK (state IN ('uploading','verified','published','deleting','deleted')),
      event_high_water BIGINT NOT NULL CHECK (event_high_water >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      published_at TIMESTAMPTZ,
      CHECK ((state = 'published' AND published_at IS NOT NULL) OR state <> 'published'),
      UNIQUE (manifest_id, user_id, session_id, activity_epoch)
    );
    CREATE TABLE IF NOT EXISTS session_archive_chunks (
      manifest_id UUID NOT NULL REFERENCES session_archive_manifests(manifest_id) ON DELETE CASCADE,
      ordinal INT NOT NULL CHECK (ordinal >= 0),
      object_key TEXT NOT NULL UNIQUE CHECK (length(object_key) BETWEEN 1 AND 512),
      first_event_id BIGINT NOT NULL CHECK (first_event_id > 0),
      last_event_id BIGINT NOT NULL CHECK (last_event_id >= first_event_id),
      event_count INT NOT NULL CHECK (event_count > 0),
      raw_bytes BIGINT NOT NULL CHECK (raw_bytes > 0),
      compressed_bytes BIGINT NOT NULL CHECK (compressed_bytes > 0),
      raw_sha256 TEXT NOT NULL CHECK (raw_sha256 ~ '^[a-f0-9]{64}$'),
      compressed_sha256 TEXT NOT NULL CHECK (compressed_sha256 ~ '^[a-f0-9]{64}$'),
      PRIMARY KEY (manifest_id, ordinal)
    );
    ALTER TABLE session_archive_manifests ADD COLUMN IF NOT EXISTS storage_namespace TEXT;
    ALTER TABLE session_archive_manifests ADD COLUMN IF NOT EXISTS operation_id UUID;
    ALTER TABLE session_archive_manifests ADD COLUMN IF NOT EXISTS upload_deadline TIMESTAMPTZ;
    -- Predicates match the per-member latest timestamp and pending probes.
    CREATE INDEX IF NOT EXISTS idx_events_lifecycle_activity
      ON events(session_id,created_at DESC) WHERE event_type NOT IN
        ('session_discovered','session_status','session_meta','command_list','subagent_discovered');
    CREATE INDEX IF NOT EXISTS idx_events_lifecycle_pending
      ON events(session_id) WHERE effect_status='pending';
    CREATE INDEX IF NOT EXISTS idx_event_inbox_lifecycle_activity
      ON event_inbox(session_id,received_at DESC) WHERE event_type NOT IN
        ('session_discovered','session_status','session_meta','command_list','subagent_discovered')
        AND payload->>'resync' IS DISTINCT FROM 'true';
    CREATE INDEX IF NOT EXISTS idx_sessions_lifecycle_root ON sessions(root_session_id);
    CREATE INDEX IF NOT EXISTS idx_subagents_lifecycle_agent ON subagents(agent_id);
  `)
  // Pre-existing archived sessions represent manual intent. Never relabel as
  // inactivity merely because the new migration runs.
  await db.query(`UPDATE sessions SET archive_reason = 'manual'
    WHERE archived_at IS NOT NULL AND archive_reason IS NULL`)
}

export async function assertSessionLifecycleSchema(
  db: Pick<pg.Pool, 'query'>,
): Promise<void> {
  const result =
    await db.query(`SELECT count(*)=3 AS ready FROM information_schema.columns
    WHERE table_schema=current_schema() AND table_name='sessions'
      AND column_name IN ('activity_epoch','activity_verified','last_business_activity_at')`)
  if (result.rows[0]?.ready !== true)
    throw new Error('session lifecycle activity schema not ready')
}
