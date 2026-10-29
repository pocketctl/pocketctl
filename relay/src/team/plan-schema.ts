import type pg from 'pg'

/** Draft plans do not dispatch work or change legacy Task completion. Activation
 * will be enabled only together with the scheduler and its completion guard. */
export async function initTeamPlanSchema(db: Pick<pg.Pool, 'query'>): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS team_task_plan_revisions (
      task_id TEXT NOT NULL REFERENCES team_tasks(task_id) ON DELETE CASCADE,
      revision BIGINT NOT NULL CHECK(revision>0),
      team_session_id TEXT NOT NULL REFERENCES collaboration_sessions(team_session_id) ON DELETE RESTRICT,
      context_version BIGINT NOT NULL CHECK(context_version>=0), context_hash TEXT,
      spec_revision BIGINT NOT NULL,
      plan_hash CHAR(64) NOT NULL,
      created_by_user_id INT NOT NULL REFERENCES team_actor_identities(actor_user_id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(task_id,revision),
      FOREIGN KEY(task_id,spec_revision) REFERENCES team_task_specs(task_id,revision)
    );
    CREATE TABLE IF NOT EXISTS team_task_plan_steps (
      task_id TEXT NOT NULL, plan_revision BIGINT NOT NULL, step_id TEXT NOT NULL,
      position INT NOT NULL CHECK(position>=0), definition JSONB NOT NULL CHECK(jsonb_typeof(definition)='object'),
      step_hash CHAR(64) NOT NULL,
      PRIMARY KEY(task_id,plan_revision,step_id), UNIQUE(task_id,plan_revision,position),
      FOREIGN KEY(task_id,plan_revision) REFERENCES team_task_plan_revisions(task_id,revision) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS team_task_plan_heads (
      task_id TEXT PRIMARY KEY REFERENCES team_tasks(task_id) ON DELETE CASCADE,
      revision BIGINT NOT NULL,
      state TEXT NOT NULL DEFAULT 'draft' CHECK(state='draft'),
      FOREIGN KEY(task_id,revision) REFERENCES team_task_plan_revisions(task_id,revision)
    );
    CREATE TABLE IF NOT EXISTS team_task_step_attempts (
      attempt_id UUID PRIMARY KEY, task_id TEXT NOT NULL, plan_revision BIGINT NOT NULL, step_id TEXT NOT NULL,
      attempt_no INT NOT NULL CHECK(attempt_no>0),
      state TEXT NOT NULL CHECK(state IN ('reserved','dispatched','running','unknown','failed','awaiting_review','accepted','cancelled')),
      call_id TEXT UNIQUE REFERENCES collaboration_calls(call_id) ON DELETE RESTRICT,
      accepted_submission_id UUID,
      lease_token BIGINT NOT NULL DEFAULT 0 CHECK(lease_token>=0),
      frozen_inputs JSONB NOT NULL CHECK(jsonb_typeof(frozen_inputs)='array'),
      input_hash CHAR(64) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(task_id,plan_revision,step_id,attempt_no),
      FOREIGN KEY(task_id,plan_revision,step_id) REFERENCES team_task_plan_steps(task_id,plan_revision,step_id) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS team_task_plan_runtime (
      task_id TEXT PRIMARY KEY REFERENCES team_tasks(task_id) ON DELETE CASCADE,
      plan_revision BIGINT NOT NULL,
      revision BIGINT NOT NULL DEFAULT 1 CHECK(revision>0),
      state TEXT NOT NULL CHECK(state IN ('active','paused','cancelled')),
      initiator_user_id INT NOT NULL REFERENCES team_actor_identities(actor_user_id),
      invocation_limit INT NOT NULL DEFAULT 128 CHECK(invocation_limit BETWEEN 1 AND 128),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      FOREIGN KEY(task_id,plan_revision) REFERENCES team_task_plan_revisions(task_id,revision)
    );
    ALTER TABLE team_task_plan_runtime ADD COLUMN IF NOT EXISTS invocation_limit INT NOT NULL DEFAULT 128 CHECK(invocation_limit BETWEEN 1 AND 128);
    ALTER TABLE team_task_plan_runtime ADD COLUMN IF NOT EXISTS budget_policy JSONB NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(budget_policy)='object');
    ALTER TABLE team_task_plan_runtime ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    CREATE OR REPLACE FUNCTION protect_team_plan_budget() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.invocation_limit IS DISTINCT FROM NEW.invocation_limit OR OLD.budget_policy IS DISTINCT FROM NEW.budget_policy OR OLD.started_at IS DISTINCT FROM NEW.started_at THEN
        RAISE EXCEPTION 'activated plan budget is immutable' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS protect_team_plan_budget ON team_task_plan_runtime;
    CREATE TRIGGER protect_team_plan_budget BEFORE UPDATE ON team_task_plan_runtime
      FOR EACH ROW EXECUTE FUNCTION protect_team_plan_budget();
    CREATE TABLE IF NOT EXISTS team_task_plan_control_receipts (
      task_id TEXT NOT NULL REFERENCES team_tasks(task_id) ON DELETE CASCADE,
      actor_user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL, request_hash CHAR(64) NOT NULL, response JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(task_id,actor_user_id,request_id)
    );
    -- Attempt numbers remain monotonic for a stable step across plan revisions.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_team_step_attempt_number ON team_task_step_attempts(task_id,step_id,attempt_no);
    ALTER TABLE team_task_step_attempts ADD COLUMN IF NOT EXISTS accepted_submission_id UUID;
    DO $$ BEGIN
      IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='team_task_step_attempts'::regclass AND conname='team_step_accepted_submission_fk') THEN
        ALTER TABLE team_task_step_attempts ADD CONSTRAINT team_step_accepted_submission_fk
          FOREIGN KEY(task_id,accepted_submission_id) REFERENCES team_task_submissions(task_id,submission_id) ON DELETE RESTRICT;
      END IF;
      IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='team_task_step_attempts'::regclass AND conname='team_step_accepted_submission_required') THEN
        ALTER TABLE team_task_step_attempts ADD CONSTRAINT team_step_accepted_submission_required CHECK(state<>'accepted' OR accepted_submission_id IS NOT NULL);
      END IF;
    END $$;
    CREATE INDEX IF NOT EXISTS idx_team_step_attempts_task ON team_task_step_attempts(task_id,step_id,created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_team_attempt_task_identity ON team_task_step_attempts(task_id,attempt_id);
    CREATE TABLE IF NOT EXISTS team_step_delivery_heads (
      attempt_id UUID PRIMARY KEY REFERENCES team_task_step_attempts(attempt_id) ON DELETE RESTRICT,
      task_id TEXT NOT NULL REFERENCES team_tasks(task_id) ON DELETE CASCADE,
      spec_revision BIGINT NOT NULL, revision BIGINT NOT NULL DEFAULT 1 CHECK(revision>0),
      latest_submission_id UUID,
      FOREIGN KEY(task_id,spec_revision) REFERENCES team_task_specs(task_id,revision),
      FOREIGN KEY(task_id,attempt_id) REFERENCES team_task_step_attempts(task_id,attempt_id),
      FOREIGN KEY(task_id,latest_submission_id) REFERENCES team_task_submissions(task_id,submission_id)
    );
    CREATE INDEX IF NOT EXISTS idx_team_step_delivery_task ON team_step_delivery_heads(task_id);
    CREATE TABLE IF NOT EXISTS team_step_wakeups (
      task_id TEXT PRIMARY KEY REFERENCES team_tasks(task_id) ON DELETE CASCADE,
      generation BIGINT NOT NULL DEFAULT 1 CHECK(generation>0),
      acknowledged_generation BIGINT NOT NULL DEFAULT 0 CHECK(acknowledged_generation>=0 AND acknowledged_generation<=generation),
      lease_token BIGINT NOT NULL DEFAULT 0 CHECK(lease_token>=0), lease_owner UUID, lease_until TIMESTAMPTZ,
      available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_error_code TEXT CHECK(last_error_code IN ('retry_pending','authorization_changed','dependency_unavailable','budget_exhausted')),
      CHECK((lease_owner IS NULL)=(lease_until IS NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_team_step_wakeups_pending ON team_step_wakeups(available_at,task_id)
      WHERE generation>acknowledged_generation;
    CREATE OR REPLACE FUNCTION signal_team_step_wakeup(target TEXT) RETURNS void LANGUAGE sql AS $$
      INSERT INTO team_step_wakeups(task_id) SELECT target WHERE EXISTS(SELECT 1 FROM team_task_plan_heads WHERE task_id=target)
      ON CONFLICT(task_id) DO UPDATE SET generation=team_step_wakeups.generation+1,
        available_at=LEAST(team_step_wakeups.available_at,clock_timestamp()),updated_at=clock_timestamp();
    $$;
    CREATE OR REPLACE FUNCTION enqueue_team_step_change() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM signal_team_step_wakeup(NEW.task_id);
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS enqueue_team_plan_change ON team_task_plan_heads;
    CREATE TRIGGER enqueue_team_plan_change AFTER INSERT OR UPDATE ON team_task_plan_heads
      FOR EACH ROW EXECUTE FUNCTION enqueue_team_step_change();
    DROP TRIGGER IF EXISTS enqueue_team_plan_runtime_change ON team_task_plan_runtime;
    CREATE TRIGGER enqueue_team_plan_runtime_change AFTER INSERT OR UPDATE ON team_task_plan_runtime
      FOR EACH ROW EXECUTE FUNCTION enqueue_team_step_change();
    CREATE OR REPLACE FUNCTION enqueue_team_step_session_change() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE target TEXT;
    BEGIN
      IF OLD.state IS DISTINCT FROM NEW.state THEN
        FOR target IN SELECT r.task_id FROM team_task_plan_runtime r
          JOIN team_task_plan_revisions p ON p.task_id=r.task_id AND p.revision=r.plan_revision
          WHERE p.team_session_id=NEW.team_session_id ORDER BY r.task_id
        LOOP
          PERFORM signal_team_step_wakeup(target);
        END LOOP;
      END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS enqueue_team_step_session_change ON collaboration_sessions;
    CREATE TRIGGER enqueue_team_step_session_change AFTER UPDATE OF state ON collaboration_sessions
      FOR EACH ROW EXECUTE FUNCTION enqueue_team_step_session_change();
    DROP TRIGGER IF EXISTS enqueue_team_delivery_change ON team_delivery_outbox;
    CREATE TRIGGER enqueue_team_delivery_change AFTER INSERT ON team_delivery_outbox
      FOR EACH ROW EXECUTE FUNCTION enqueue_team_step_change();
    DROP TRIGGER IF EXISTS enqueue_team_attempt_change ON team_task_step_attempts;
    CREATE TRIGGER enqueue_team_attempt_change AFTER INSERT OR UPDATE ON team_task_step_attempts
      FOR EACH ROW EXECUTE FUNCTION enqueue_team_step_change();
    CREATE OR REPLACE FUNCTION enqueue_team_step_call_change() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.state IS DISTINCT FROM NEW.state AND EXISTS(SELECT 1 FROM team_task_step_attempts WHERE call_id=NEW.call_id) THEN
        PERFORM signal_team_step_wakeup(NEW.task_id);
      END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS enqueue_team_step_call_change ON collaboration_calls;
    CREATE TRIGGER enqueue_team_step_call_change AFTER UPDATE OF state ON collaboration_calls
      FOR EACH ROW EXECUTE FUNCTION enqueue_team_step_call_change();
    -- Backfill each historical plan once. Re-running migration must not replay
    -- acknowledged work or depend on the Inbox projector's processed_at cursor.
    INSERT INTO team_step_wakeups(task_id) SELECT task_id FROM team_task_plan_heads ON CONFLICT DO NOTHING;
    ALTER TABLE team_delivery_receipts ADD COLUMN IF NOT EXISTS attempt_id UUID REFERENCES team_task_step_attempts(attempt_id);
    CREATE TABLE IF NOT EXISTS team_task_plan_receipts (
      task_id TEXT NOT NULL REFERENCES team_tasks(task_id) ON DELETE CASCADE,
      actor_user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL, request_hash CHAR(64) NOT NULL, response JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(task_id,actor_user_id,request_id)
    );
    DROP TRIGGER IF EXISTS protect_team_plan_revision ON team_task_plan_revisions;
    CREATE TRIGGER protect_team_plan_revision BEFORE UPDATE ON team_task_plan_revisions
      FOR EACH ROW EXECUTE FUNCTION protect_team_delivery_record();
    DROP TRIGGER IF EXISTS protect_team_plan_step ON team_task_plan_steps;
    CREATE TRIGGER protect_team_plan_step BEFORE UPDATE ON team_task_plan_steps
      FOR EACH ROW EXECUTE FUNCTION protect_team_delivery_record();
    CREATE OR REPLACE FUNCTION protect_team_attempt_inputs() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.state='cancelled' AND NEW.state<>'cancelled' THEN
        RAISE EXCEPTION 'cancelled step attempt cannot be resumed' USING ERRCODE='23514';
      END IF;
      IF (to_jsonb(OLD)-'state'-'call_id'-'accepted_submission_id'-'lease_token'-'updated_at') IS DISTINCT FROM
         (to_jsonb(NEW)-'state'-'call_id'-'accepted_submission_id'-'lease_token'-'updated_at')
         OR (OLD.call_id IS NOT NULL AND OLD.call_id IS DISTINCT FROM NEW.call_id)
         OR (OLD.accepted_submission_id IS NOT NULL AND OLD.accepted_submission_id IS DISTINCT FROM NEW.accepted_submission_id)
         OR NEW.lease_token<OLD.lease_token THEN
        RAISE EXCEPTION 'step attempt inputs and call identity are immutable' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS protect_team_attempt_inputs ON team_task_step_attempts;
    CREATE TRIGGER protect_team_attempt_inputs BEFORE UPDATE ON team_task_step_attempts
      FOR EACH ROW EXECUTE FUNCTION protect_team_attempt_inputs();
    CREATE OR REPLACE FUNCTION guard_team_attempt_source() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.call_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM collaboration_calls c WHERE c.call_id=NEW.call_id AND c.task_id=NEW.task_id) THEN
        RAISE EXCEPTION 'attempt Call must belong to the same Task' USING ERRCODE='23514';
      END IF;
      IF NEW.call_id IS NOT NULL AND (TG_OP='INSERT' OR OLD.call_id IS NULL)
        AND EXISTS(SELECT 1 FROM team_task_submissions WHERE source_call_id=NEW.call_id) THEN
        RAISE EXCEPTION 'published or preparing legacy Call cannot be reassigned to a step' USING ERRCODE='23514';
      END IF;
      IF NEW.accepted_submission_id IS NOT NULL AND NOT EXISTS(
        SELECT 1 FROM team_task_submissions s JOIN team_acceptance_decisions d USING(submission_id)
        WHERE s.submission_id=NEW.accepted_submission_id AND s.task_id=NEW.task_id AND s.source_call_id=NEW.call_id
          AND s.state='published' AND d.decision='accepted' AND d.spec_revision=s.spec_revision) THEN
        RAISE EXCEPTION 'attempt result must be an accepted output of its own Call' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS guard_team_attempt_source ON team_task_step_attempts;
    CREATE TRIGGER guard_team_attempt_source BEFORE INSERT OR UPDATE ON team_task_step_attempts
      FOR EACH ROW EXECUTE FUNCTION guard_team_attempt_source();
    CREATE OR REPLACE FUNCTION guard_team_step_delivery_head() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='UPDATE' AND (to_jsonb(OLD)-'revision'-'latest_submission_id') IS DISTINCT FROM
        (to_jsonb(NEW)-'revision'-'latest_submission_id') THEN
        RAISE EXCEPTION 'attempt delivery specification is immutable' USING ERRCODE='23514';
      END IF;
      IF NEW.latest_submission_id IS NOT NULL AND NOT EXISTS(
        SELECT 1 FROM team_task_submissions s JOIN team_task_step_attempts a ON a.call_id=s.source_call_id AND a.task_id=s.task_id
        WHERE a.attempt_id=NEW.attempt_id AND s.submission_id=NEW.latest_submission_id AND s.task_id=NEW.task_id
          AND s.spec_revision=NEW.spec_revision AND s.state='published' AND s.delivery_role='primary') THEN
        RAISE EXCEPTION 'step head must reference its own published primary output' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS guard_team_step_delivery_head ON team_step_delivery_heads;
    CREATE TRIGGER guard_team_step_delivery_head BEFORE INSERT OR UPDATE ON team_step_delivery_heads
      FOR EACH ROW EXECUTE FUNCTION guard_team_step_delivery_head();
    CREATE OR REPLACE FUNCTION team_task_delivery_complete(p_task TEXT) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
    DECLARE runtime team_task_plan_runtime%ROWTYPE;
    BEGIN
      SELECT * INTO runtime FROM team_task_plan_runtime WHERE task_id=p_task;
      IF NOT FOUND THEN RETURN team_task_legacy_delivery_complete(p_task); END IF;
      IF runtime.state='cancelled' THEN RETURN false; END IF;
      IF NOT EXISTS(SELECT 1 FROM team_task_plan_steps WHERE task_id=p_task AND plan_revision=runtime.plan_revision
        AND definition->>'required'='true') THEN RETURN false; END IF;
      RETURN NOT EXISTS(
        SELECT 1 FROM team_task_plan_steps step WHERE step.task_id=p_task AND step.plan_revision=runtime.plan_revision
          AND step.definition->>'required'='true' AND NOT EXISTS(
            SELECT 1 FROM team_task_step_attempts a
            JOIN team_task_plan_steps old ON old.task_id=a.task_id AND old.plan_revision=a.plan_revision AND old.step_id=a.step_id
            JOIN team_step_delivery_heads h ON h.attempt_id=a.attempt_id AND h.task_id=a.task_id
            JOIN team_task_specs spec ON spec.task_id=h.task_id AND spec.revision=h.spec_revision
            JOIN collaboration_calls c ON c.call_id=a.call_id AND c.task_id=a.task_id AND c.state='completed'
            JOIN team_call_delivery_specs binding ON binding.call_id=c.call_id AND binding.task_id=h.task_id AND binding.spec_revision=h.spec_revision
            WHERE a.task_id=p_task AND a.step_id=step.step_id AND a.state='accepted' AND old.step_hash=step.step_hash
              AND a.accepted_submission_id=h.latest_submission_id
              AND NOT EXISTS(SELECT 1 FROM team_task_step_attempts newer WHERE newer.task_id=a.task_id AND newer.step_id=a.step_id AND newer.attempt_no>a.attempt_no)
              AND spec.primary_offer_id=step.definition->'review_policy'->>'primary_offer_id'
              AND spec.reviewer_user_id=(step.definition->'review_policy'->>'reviewer_user_id')::int
              AND spec.required_checks @> (step.definition->'review_policy'->'required_checks')
              AND (step.definition->'review_policy'->'required_checks') @> spec.required_checks
              AND team_delivery_submission_accepted(p_task,a.accepted_submission_id,h.spec_revision)
          )
      );
    END $$;
  `)
}
