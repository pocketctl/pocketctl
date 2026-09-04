/** Fixture-gated rollout/execution contracts. No production execution permission. */
export const SKILL_EXECUTION_MIGRATION = {
  version: 36,
  statements: [
    `CREATE TABLE memory_skill_rollouts (
      installation_id UUID NOT NULL,skill_id UUID NOT NULL,revision BIGINT NOT NULL CHECK(revision>0),
      state TEXT NOT NULL CHECK(state IN('shadow','canary','disabled')),basis_points INTEGER NOT NULL CHECK(basis_points BETWEEN 0 AND 10000),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(installation_id,skill_id),
      FOREIGN KEY(installation_id,skill_id) REFERENCES memory_skills(installation_id,skill_id) ON DELETE CASCADE
    )`,
    `CREATE TABLE memory_skill_executions (
      execution_id UUID PRIMARY KEY,installation_id UUID NOT NULL,skill_id UUID NOT NULL,version_id UUID NOT NULL,
      repository_id UUID NOT NULL,repo_snapshot_id UUID NOT NULL,session_id TEXT NOT NULL,
      document_hash TEXT NOT NULL,source_digest TEXT NOT NULL,policy_hash TEXT NOT NULL,
      publication_revision BIGINT NOT NULL CHECK(publication_revision>0),rollout_revision BIGINT NOT NULL CHECK(rollout_revision>0),
      actor_kind TEXT NOT NULL CHECK(actor_kind IN('personal','membership')),actor_id UUID NOT NULL,
      membership_revision BIGINT NOT NULL,authorization_epoch BIGINT NOT NULL,
      assignment_bucket INTEGER NOT NULL CHECK(assignment_bucket BETWEEN 0 AND 9999),
      idempotency_key TEXT NOT NULL CHECK(idempotency_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$'),
      input_hash TEXT NOT NULL CHECK(input_hash ~ '^[0-9a-f]{64}$'),provenance TEXT NOT NULL DEFAULT 'fixture' CHECK(provenance='fixture'),
      state TEXT NOT NULL DEFAULT 'started' CHECK(state IN('started','succeeded','failed','taken_over','cancelled')),
      revision BIGINT NOT NULL DEFAULT 1 CHECK(revision>0),receipt_key TEXT,started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),completed_at TIMESTAMPTZ,
      UNIQUE(installation_id,execution_id),UNIQUE(installation_id,actor_kind,actor_id,idempotency_key),
      CHECK((state='started' AND completed_at IS NULL AND receipt_key IS NULL) OR (state<>'started' AND completed_at IS NOT NULL)),
      FOREIGN KEY(installation_id,skill_id,version_id) REFERENCES memory_skill_versions(installation_id,skill_id,version_id) ON DELETE CASCADE,
      FOREIGN KEY(installation_id,version_id,document_hash,source_digest,policy_hash)
        REFERENCES memory_skill_versions(installation_id,version_id,document_hash,source_digest,policy_hash) ON DELETE CASCADE,
      FOREIGN KEY(installation_id,repo_snapshot_id) REFERENCES repo_snapshots(installation_id,repo_snapshot_id) ON DELETE CASCADE,
      FOREIGN KEY(installation_id,session_id) REFERENCES source_sessions(installation_id,session_id) ON DELETE CASCADE
    )`,
    `CREATE INDEX memory_skill_executions_skill ON memory_skill_executions(installation_id,skill_id,started_at DESC)`,
    `CREATE FUNCTION memory_skill_execution_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.state<>'started' OR NEW.state='started' OR NEW.revision<>OLD.revision+1 OR
          (to_jsonb(NEW)-ARRAY['state','revision','receipt_key','completed_at']) IS DISTINCT FROM
          (to_jsonb(OLD)-ARRAY['state','revision','receipt_key','completed_at'])
        THEN RAISE EXCEPTION 'skill_execution_immutable'; END IF;
        RETURN NEW;
      END $$`,
    `CREATE TRIGGER memory_skill_execution_immutable BEFORE UPDATE ON memory_skill_executions
      FOR EACH ROW EXECUTE FUNCTION memory_skill_execution_immutable()`,
    `CREATE FUNCTION memory_skill_execution_session_purged() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN DELETE FROM memory_skill_executions WHERE installation_id=NEW.installation_id AND session_id=NEW.session_id; RETURN NULL; END $$`,
    `CREATE TRIGGER memory_skill_execution_session_purged AFTER INSERT ON memory_session_tombstones
      FOR EACH ROW EXECUTE FUNCTION memory_skill_execution_session_purged()`,
  ],
} as const
