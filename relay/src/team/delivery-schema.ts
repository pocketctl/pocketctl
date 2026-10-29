import type pg from 'pg'

/** Additive migration. Historical tasks acquire no synthetic review history. */
export async function initTeamDeliverySchema(db: Pick<pg.Pool, 'query'>): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS team_external_recovery_operations (
      sequence BIGSERIAL PRIMARY KEY,
      call_id TEXT NOT NULL REFERENCES collaboration_calls(call_id) ON DELETE CASCADE,
      actor_user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL,action TEXT NOT NULL CHECK(action IN ('query','retry_original')),
      input_hash TEXT NOT NULL,expected_query_id TEXT,
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','done','expired')),
      result JSONB,expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(call_id,actor_user_id,request_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_external_recovery_pending ON team_external_recovery_operations(call_id) WHERE state='pending';
    CREATE TABLE IF NOT EXISTS team_external_usage_facts (
      fact_key TEXT PRIMARY KEY REFERENCES token_usage_facts(fact_key) ON DELETE CASCADE,
      call_id TEXT NOT NULL REFERENCES collaboration_calls(call_id) ON DELETE CASCADE,
      request_id TEXT NOT NULL, remote_task_id TEXT NOT NULL,
      chat_id TEXT NOT NULL, original_turn_id TEXT NOT NULL,
      evidence JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS team_delivery_export_status (
      call_id TEXT PRIMARY KEY REFERENCES collaboration_calls(call_id) ON DELETE CASCADE,
      revision BIGINT NOT NULL DEFAULT 1,
      phase TEXT NOT NULL CHECK(phase IN ('waiting_for_files','publication_pending','blocked','published')),
      error_code TEXT, reporter_user_id INT REFERENCES users(id) ON DELETE SET NULL,
      reporter_daemon_id TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS team_task_specs (
      task_id TEXT NOT NULL REFERENCES team_tasks(task_id) ON DELETE CASCADE,
      revision BIGINT NOT NULL CHECK (revision > 0),
      goal TEXT NOT NULL, acceptance TEXT NOT NULL,
      primary_offer_id TEXT NOT NULL REFERENCES team_agent_offers(offer_id) ON DELETE RESTRICT,
      reviewer_user_id INT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      required_checks JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(required_checks) = 'array'),
      created_by_user_id INT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(task_id, revision)
    );
    CREATE TABLE IF NOT EXISTS team_task_delivery_heads (
      task_id TEXT PRIMARY KEY REFERENCES team_tasks(task_id) ON DELETE CASCADE,
      spec_revision BIGINT NOT NULL,
      revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
      latest_submission_id UUID,
      FOREIGN KEY(task_id,spec_revision) REFERENCES team_task_specs(task_id,revision)
    );
    CREATE TABLE IF NOT EXISTS team_call_delivery_specs (
      call_id TEXT PRIMARY KEY REFERENCES collaboration_calls(call_id) ON DELETE CASCADE,
      task_id TEXT NOT NULL, spec_revision BIGINT NOT NULL,
      FOREIGN KEY(task_id,spec_revision) REFERENCES team_task_specs(task_id,revision)
    );
    CREATE TABLE IF NOT EXISTS team_task_submissions (
      submission_id UUID PRIMARY KEY, task_id TEXT NOT NULL,
      spec_revision BIGINT NOT NULL, version BIGINT,
      state TEXT NOT NULL DEFAULT 'preparing' CHECK(state IN ('preparing','published')),
      source_call_id TEXT NOT NULL REFERENCES collaboration_calls(call_id) ON DELETE RESTRICT,
      source_run_id TEXT, source_offer_id TEXT NOT NULL, native_session_id TEXT,
      context_version BIGINT NOT NULL, context_hash TEXT,
      submitted_by_user_id INT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      summary TEXT NOT NULL, code_revision TEXT,
      delivery_role TEXT NOT NULL CHECK(delivery_role IN ('primary','contribution')),
      contribution_ids JSONB NOT NULL DEFAULT '[]',
      manifest JSONB NOT NULL, evidence JSONB NOT NULL,
      manifest_sha256 CHAR(64) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), published_at TIMESTAMPTZ,
      FOREIGN KEY(task_id,spec_revision) REFERENCES team_task_specs(task_id,revision),
      UNIQUE(task_id,version), UNIQUE(task_id,submission_id),
      CHECK ((state='preparing' AND version IS NULL AND published_at IS NULL) OR
             (state='published' AND version > 0 AND published_at IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_team_submissions_task ON team_task_submissions(task_id,created_at);
    CREATE TABLE IF NOT EXISTS team_submission_artifacts (
      submission_id UUID NOT NULL REFERENCES team_task_submissions(submission_id) ON DELETE CASCADE,
      artifact_id TEXT NOT NULL, sha256 CHAR(64) NOT NULL,
      byte_size INT NOT NULL CHECK(byte_size > 0 AND byte_size <= 2097152),
      content_bytes BYTEA NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(submission_id,artifact_id), CHECK(octet_length(content_bytes)=byte_size)
    );
    CREATE TABLE IF NOT EXISTS team_artifact_revocations (
      submission_id UUID NOT NULL, artifact_id TEXT NOT NULL,
      actor_user_id INT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      reason TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(submission_id,artifact_id),
      FOREIGN KEY(submission_id,artifact_id) REFERENCES team_submission_artifacts(submission_id,artifact_id) ON DELETE CASCADE
    );
    -- Activity belongs outside immutable manifests/bytes. Re-uploading the same
    -- file renews a preparation without rewriting either original record.
    CREATE TABLE IF NOT EXISTS team_delivery_staging_activity (
      submission_id UUID PRIMARY KEY REFERENCES team_task_submissions(submission_id) ON DELETE CASCADE,
      last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_team_delivery_staging_activity ON team_delivery_staging_activity(last_activity_at,submission_id);
    CREATE TABLE IF NOT EXISTS team_delivery_staging_reclaims (
      reclaim_id UUID PRIMARY KEY,
      submission_id UUID NOT NULL REFERENCES team_task_submissions(submission_id) ON DELETE CASCADE,
      artifact_count INT NOT NULL CHECK(artifact_count>0), byte_count BIGINT NOT NULL CHECK(byte_count>0),
      policy_version TEXT NOT NULL CHECK(policy_version='staging-bytes-v1'),
      reclaimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_team_delivery_staging_reclaims ON team_delivery_staging_reclaims(submission_id,reclaimed_at);
    CREATE TABLE IF NOT EXISTS team_acceptance_decisions (
      decision_id UUID PRIMARY KEY, submission_id UUID NOT NULL UNIQUE,
      task_id TEXT NOT NULL, spec_revision BIGINT NOT NULL,
      reviewer_user_id INT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      decision TEXT NOT NULL CHECK(decision IN ('accepted','changes_requested')),
      reason TEXT NOT NULL, verified_checks JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      FOREIGN KEY(task_id,submission_id) REFERENCES team_task_submissions(task_id,submission_id) ON DELETE CASCADE,
      FOREIGN KEY(task_id,spec_revision) REFERENCES team_task_specs(task_id,revision),
      CHECK(decision='accepted' OR length(trim(reason))>0)
    );
    CREATE TABLE IF NOT EXISTS team_delivery_receipts (
      task_id TEXT NOT NULL REFERENCES team_tasks(task_id) ON DELETE CASCADE,
      actor_user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL, request_hash CHAR(64) NOT NULL,
      operation TEXT NOT NULL, response JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(task_id,actor_user_id,request_id)
    );
    -- Individual rows are durable work items: a later consumer must not use a
    -- naked BIGSERIAL high-water mark (commits can arrive out of ID order).
    CREATE TABLE IF NOT EXISTS team_delivery_outbox (
      event_id UUID PRIMARY KEY, task_id TEXT NOT NULL REFERENCES team_tasks(task_id) ON DELETE CASCADE,
      kind TEXT NOT NULL, payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), processed_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_team_delivery_outbox_pending ON team_delivery_outbox(created_at,event_id) WHERE processed_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_team_delivery_outbox_task ON team_delivery_outbox(task_id,created_at) WHERE processed_at IS NULL;
    CREATE OR REPLACE FUNCTION notify_team_delivery_task_state() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.state IS DISTINCT FROM NEW.state AND EXISTS(SELECT 1 FROM team_task_delivery_heads WHERE task_id=NEW.task_id) THEN
        INSERT INTO team_delivery_outbox(event_id,task_id,kind,payload)
          VALUES(gen_random_uuid(),NEW.task_id,'task_state_changed',jsonb_build_object('state',NEW.state));
      END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS notify_team_delivery_task_state ON team_tasks;
    CREATE TRIGGER notify_team_delivery_task_state AFTER UPDATE OF state ON team_tasks
      FOR EACH ROW EXECUTE FUNCTION notify_team_delivery_task_state();
    CREATE TABLE IF NOT EXISTS team_delivery_attention_items (
      item_id UUID PRIMARY KEY, task_id TEXT NOT NULL REFERENCES team_tasks(task_id) ON DELETE CASCADE,
      submission_id UUID NOT NULL REFERENCES team_task_submissions(submission_id) ON DELETE CASCADE,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('review_required','changes_requested')),
      state TEXT NOT NULL CHECK(state IN ('open','resolved','superseded')),
      revision BIGINT NOT NULL DEFAULT 1, seen_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(submission_id,user_id,kind)
    );
    CREATE INDEX IF NOT EXISTS idx_team_delivery_attention_open ON team_delivery_attention_items(user_id,created_at,item_id) WHERE state='open';

    CREATE OR REPLACE FUNCTION protect_team_delivery_record() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_TABLE_NAME='team_task_submissions' THEN
        IF OLD.state='preparing' AND NEW.state='published'
          AND (to_jsonb(OLD)-'state'-'version'-'published_at')=(to_jsonb(NEW)-'state'-'version'-'published_at') THEN RETURN NEW; END IF;
      END IF;
      RAISE EXCEPTION 'team delivery record is immutable' USING ERRCODE='23514';
    END $$;
    DROP TRIGGER IF EXISTS protect_team_spec ON team_task_specs;
    CREATE TRIGGER protect_team_spec BEFORE UPDATE ON team_task_specs FOR EACH ROW EXECUTE FUNCTION protect_team_delivery_record();
    DROP TRIGGER IF EXISTS protect_team_submission ON team_task_submissions;
    CREATE TRIGGER protect_team_submission BEFORE UPDATE ON team_task_submissions FOR EACH ROW EXECUTE FUNCTION protect_team_delivery_record();
    DROP TRIGGER IF EXISTS protect_team_artifact ON team_submission_artifacts;
    CREATE TRIGGER protect_team_artifact BEFORE UPDATE ON team_submission_artifacts FOR EACH ROW EXECUTE FUNCTION protect_team_delivery_record();
    DROP TRIGGER IF EXISTS protect_team_decision ON team_acceptance_decisions;
    CREATE TRIGGER protect_team_decision BEFORE UPDATE ON team_acceptance_decisions FOR EACH ROW EXECUTE FUNCTION protect_team_delivery_record();

    CREATE OR REPLACE FUNCTION team_delivery_submission_accepted(p_task TEXT,p_submission UUID,p_spec BIGINT) RETURNS boolean LANGUAGE SQL STABLE AS $$
      SELECT EXISTS(SELECT 1 FROM team_task_submissions s
          JOIN team_task_specs p ON p.task_id=s.task_id AND p.revision=s.spec_revision
          JOIN team_acceptance_decisions d ON d.submission_id=s.submission_id AND d.spec_revision=p.revision AND d.decision='accepted' AND d.reviewer_user_id=p.reviewer_user_id
          WHERE s.task_id=p_task AND s.submission_id=p_submission AND s.spec_revision=p_spec AND s.state='published' AND s.delivery_role='primary'
          AND d.verified_checks @> p.required_checks
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(p.required_checks) c(check_id)
            WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s.evidence) e
              WHERE e->>'check_id'=c.check_id AND e->>'result' IN ('passed','unverified')))
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(s.manifest) a
            LEFT JOIN team_submission_artifacts f ON f.submission_id=s.submission_id AND f.artifact_id=a->>'id'
            LEFT JOIN team_artifact_revocations r ON r.submission_id=s.submission_id AND r.artifact_id=a->>'id'
            WHERE ((a->>'required')::boolean OR EXISTS (
              SELECT 1 FROM jsonb_array_elements(s.evidence) e
              WHERE e->>'artifact_id'=a->>'id' AND p.required_checks ? (e->>'check_id')))
            AND (f.artifact_id IS NULL OR r.artifact_id IS NOT NULL
              OR f.byte_size<>(a->>'byte_size')::int
              OR encode(sha256(f.content_bytes),'hex')<>a->>'sha256')))
    $$;
    CREATE OR REPLACE FUNCTION team_task_legacy_delivery_complete(p_task TEXT) RETURNS boolean LANGUAGE SQL STABLE AS $$
      SELECT NOT EXISTS(SELECT 1 FROM team_task_delivery_heads WHERE task_id=p_task)
        OR EXISTS(SELECT 1 FROM team_task_delivery_heads h WHERE h.task_id=p_task
          AND team_delivery_submission_accepted(p_task,h.latest_submission_id,h.spec_revision))
    $$;
    -- Full initDB is transactional. Preserve an installed plan-aware gate even
    -- if this exported sub-initializer is used independently in tooling.
    DO $$ BEGIN
      IF to_regprocedure('team_task_delivery_complete(text)') IS NULL THEN
        EXECUTE 'CREATE FUNCTION team_task_delivery_complete(p_task TEXT) RETURNS boolean LANGUAGE SQL STABLE AS ''SELECT team_task_legacy_delivery_complete(p_task)''';
      END IF;
    END
    $$;
    CREATE OR REPLACE FUNCTION guard_team_task_completion() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.state='completed' AND NOT team_task_delivery_complete(NEW.task_id) THEN
        RAISE EXCEPTION 'task delivery acceptance required' USING ERRCODE='23514', CONSTRAINT='team_task_acceptance_required';
      END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS guard_team_task_completion ON team_tasks;
    CREATE TRIGGER guard_team_task_completion BEFORE UPDATE OF state ON team_tasks FOR EACH ROW EXECUTE FUNCTION guard_team_task_completion();
  `)
}
