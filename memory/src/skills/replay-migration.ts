/** Task 7 recorded Replay ledger. No real execution or Provider capability. */
export const SKILL_REPLAY_MIGRATION = {
  version: 34,
  statements: [
    `ALTER TABLE memory_skill_audit_events DROP CONSTRAINT memory_skill_audit_events_action_check`,
    `ALTER TABLE memory_skill_audit_events ADD CONSTRAINT memory_skill_audit_events_action_check
      CHECK(action IN('draft','edit','approve','request_changes','reject','revoke','replay'))`,
    `ALTER TABLE memory_skill_audit_events DROP CONSTRAINT memory_skill_audit_events_code_check`,
    `ALTER TABLE memory_skill_audit_events ADD CONSTRAINT memory_skill_audit_events_code_check CHECK(code IN(
      'ok','invalid_request','forbidden','not_found','revision_conflict','state_conflict','source_invalid','policy_changed',
      'self_review_denied','secret_detected','size_exceeded','source_tokens_invalid','duplicate_decision','feature_disabled',
      'case_invalid','version_conflict','lease_lost','runner_failed','replay_failed','replay_cancelled'))`,
    `CREATE TABLE memory_skill_replay_runs (
      run_id UUID PRIMARY KEY, sequence BIGSERIAL UNIQUE, installation_id UUID NOT NULL, skill_id UUID NOT NULL, version_id UUID NOT NULL,
      repository_id UUID NOT NULL, repo_snapshot_id UUID NOT NULL,
      head_revision BIGINT NOT NULL CHECK(head_revision>0), idempotency_key TEXT NOT NULL CHECK(idempotency_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$'),
      document_hash TEXT NOT NULL, source_digest TEXT NOT NULL, policy_hash TEXT NOT NULL,
      input_hash TEXT NOT NULL CHECK(input_hash ~ '^[0-9a-f]{64}$'), runner_version TEXT NOT NULL CHECK(runner_version='skill-recorded-replay.v1'),
      actor_kind TEXT NOT NULL CHECK(actor_kind IN('personal','membership')), actor_id UUID NOT NULL,
      state TEXT NOT NULL CHECK(state IN('running','passed','failed','cancelled')),
      attempt INTEGER NOT NULL DEFAULT 1 CHECK(attempt BETWEEN 1 AND 3), lease_token UUID NOT NULL, lease_expires_at TIMESTAMPTZ,
      error_code TEXT CHECK(error_code ~ '^[a-z][a-z0-9_]{0,63}$'), started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at TIMESTAMPTZ,
      created_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
      UNIQUE(installation_id,run_id), UNIQUE(installation_id,skill_id,idempotency_key),
      CHECK((state='running' AND lease_expires_at IS NOT NULL AND completed_at IS NULL)
        OR (state<>'running' AND lease_expires_at IS NULL AND completed_at IS NOT NULL)),
      FOREIGN KEY(installation_id,skill_id,version_id) REFERENCES memory_skill_versions(installation_id,skill_id,version_id) ON DELETE CASCADE,
      FOREIGN KEY(installation_id,version_id,document_hash,source_digest,policy_hash)
        REFERENCES memory_skill_versions(installation_id,version_id,document_hash,source_digest,policy_hash) ON DELETE CASCADE,
      FOREIGN KEY(installation_id,repo_snapshot_id) REFERENCES repo_snapshots(installation_id,repo_snapshot_id) ON DELETE CASCADE
    )`,
    `CREATE INDEX memory_skill_replay_latest ON memory_skill_replay_runs(installation_id,skill_id,sequence DESC)`,
    `CREATE FUNCTION memory_skill_replay_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS(SELECT 1 FROM memory_skill_versions v JOIN memory_skill_archives a USING(installation_id,archive_id)
          WHERE v.installation_id=NEW.installation_id AND v.version_id=NEW.version_id
            AND a.repository_id=NEW.repository_id AND a.repo_snapshot_id=NEW.repo_snapshot_id)
          OR NEW.state<>'running' OR NEW.attempt<>1 OR NEW.created_transaction<>pg_current_xact_id()
        THEN RAISE EXCEPTION 'skill_replay_invalid_lineage'; END IF;
        RETURN NEW;
      END $$`,
    `CREATE TRIGGER memory_skill_replay_lineage BEFORE INSERT ON memory_skill_replay_runs
      FOR EACH ROW EXECUTE FUNCTION memory_skill_replay_lineage()`,
    `CREATE TABLE memory_skill_replay_cases (
      installation_id UUID NOT NULL, run_id UUID NOT NULL, case_id TEXT NOT NULL CHECK(length(case_id) BETWEEN 1 AND 128),
      kind TEXT NOT NULL CHECK(kind IN('historical_session','golden_task')), provenance TEXT NOT NULL CHECK(provenance IN('fixture','recorded')),
      reference_id TEXT NOT NULL CHECK(length(reference_id) BETWEEN 1 AND 200), session_id TEXT,
      input_hash TEXT NOT NULL CHECK(input_hash ~ '^[0-9a-f]{64}$'),
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','passed','failed','cancelled')),
      error_code TEXT CHECK(error_code ~ '^[a-z][a-z0-9_]{0,63}$'), assertion_results JSONB NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(assertion_results)='array'),
      PRIMARY KEY(installation_id,run_id,case_id),
      CHECK((kind='historical_session' AND session_id IS NOT NULL AND session_id=reference_id) OR (kind='golden_task' AND session_id IS NULL)),
      FOREIGN KEY(installation_id,run_id) REFERENCES memory_skill_replay_runs(installation_id,run_id) ON DELETE CASCADE,
      FOREIGN KEY(installation_id,session_id) REFERENCES source_sessions(installation_id,session_id) ON DELETE CASCADE
    )`,
    `CREATE FUNCTION memory_skill_replay_run_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.state<>'running' OR (to_jsonb(NEW)-ARRAY['state','attempt','lease_token','lease_expires_at','error_code','completed_at'])
          IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','attempt','lease_token','lease_expires_at','error_code','completed_at'])
        THEN RAISE EXCEPTION 'skill_replay_immutable'; END IF;
        RETURN NEW;
      END $$`,
    `CREATE TRIGGER memory_skill_replay_run_immutable BEFORE UPDATE ON memory_skill_replay_runs
      FOR EACH ROW EXECUTE FUNCTION memory_skill_replay_run_immutable()`,
    `CREATE FUNCTION memory_skill_replay_case_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.state<>'pending' OR NEW.assertion_results<>'[]'::jsonb OR NEW.error_code IS NOT NULL OR NOT EXISTS(
          SELECT 1 FROM memory_skill_replay_runs WHERE installation_id=NEW.installation_id AND run_id=NEW.run_id
            AND state='running' AND created_transaction=pg_current_xact_id())
        THEN RAISE EXCEPTION 'skill_replay_case_set_closed'; END IF;
        RETURN NEW;
      END $$`,
    `CREATE TRIGGER memory_skill_replay_case_insert BEFORE INSERT ON memory_skill_replay_cases
      FOR EACH ROW EXECUTE FUNCTION memory_skill_replay_case_insert()`,
    `CREATE FUNCTION memory_skill_replay_case_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.state<>'pending' OR (to_jsonb(NEW)-ARRAY['state','error_code','assertion_results'])
          IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','error_code','assertion_results'])
        THEN RAISE EXCEPTION 'skill_replay_immutable'; END IF;
        RETURN NEW;
      END $$`,
    `CREATE TRIGGER memory_skill_replay_case_immutable BEFORE UPDATE ON memory_skill_replay_cases
      FOR EACH ROW EXECUTE FUNCTION memory_skill_replay_case_immutable()`,
    `CREATE FUNCTION memory_skill_replay_case_deleted() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN DELETE FROM memory_skill_replay_runs WHERE installation_id=OLD.installation_id AND run_id=OLD.run_id; RETURN NULL; END $$`,
    `CREATE TRIGGER memory_skill_replay_case_deleted AFTER DELETE ON memory_skill_replay_cases
      FOR EACH ROW EXECUTE FUNCTION memory_skill_replay_case_deleted()`,
    `CREATE FUNCTION memory_skill_replay_session_purged() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN DELETE FROM memory_skill_replay_runs r WHERE r.installation_id=NEW.installation_id
        AND EXISTS(SELECT 1 FROM memory_skill_replay_cases c WHERE c.installation_id=r.installation_id AND c.run_id=r.run_id AND c.session_id=NEW.session_id);
        RETURN NULL; END $$`,
    `CREATE TRIGGER memory_skill_replay_session_purged AFTER INSERT ON memory_session_tombstones
      FOR EACH ROW EXECUTE FUNCTION memory_skill_replay_session_purged()`,
  ],
} as const
