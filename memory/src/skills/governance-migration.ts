/** Task 6: immutable governed versions and decisions, with a CAS review head. */
export const SKILL_GOVERNANCE_MIGRATION = {
  version: 33,
  statements: [
    `CREATE TABLE memory_skills (
      skill_id UUID PRIMARY KEY, installation_id UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
      task_id UUID NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(installation_id,skill_id), UNIQUE(installation_id,task_id),
      FOREIGN KEY(installation_id,task_id) REFERENCES memory_skill_tasks(installation_id,task_id) ON DELETE CASCADE
    )`,
    `ALTER TABLE memory_skill_candidates ADD CONSTRAINT memory_skill_candidate_archive_identity UNIQUE(installation_id,candidate_id,archive_id)`,
    `CREATE TABLE memory_skill_versions (
      version_id UUID PRIMARY KEY, installation_id UUID NOT NULL, skill_id UUID NOT NULL,
      version_number INTEGER NOT NULL CHECK(version_number>0), candidate_id UUID NOT NULL, archive_id UUID NOT NULL,
      document JSONB NOT NULL CHECK(jsonb_typeof(document)='object'),
      document_hash TEXT NOT NULL CHECK(document_hash ~ '^[0-9a-f]{64}$'),
      source_digest TEXT NOT NULL CHECK(source_digest ~ '^[0-9a-f]{64}$'),
      archive_content_hash TEXT NOT NULL CHECK(archive_content_hash ~ '^[0-9a-f]{64}$'),
      policy_snapshot JSONB NOT NULL CHECK(jsonb_typeof(policy_snapshot)='object'),
      policy_hash TEXT NOT NULL CHECK(policy_hash ~ '^[0-9a-f]{64}$'),
      risk TEXT NOT NULL CHECK(risk IN('low','high','unknown')),
      author_kind TEXT NOT NULL CHECK(author_kind IN('personal','membership')), author_id UUID NOT NULL,
      authorization_epoch BIGINT NOT NULL CHECK(authorization_epoch>0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(installation_id,skill_id,version_id), UNIQUE(installation_id,skill_id,version_number),
      UNIQUE(installation_id,version_id,document_hash,source_digest,policy_hash),
      FOREIGN KEY(installation_id,skill_id) REFERENCES memory_skills(installation_id,skill_id) ON DELETE CASCADE,
      FOREIGN KEY(installation_id,candidate_id,archive_id) REFERENCES memory_skill_candidates(installation_id,candidate_id,archive_id) ON DELETE CASCADE,
      FOREIGN KEY(installation_id,archive_id) REFERENCES memory_skill_archives(installation_id,archive_id) ON DELETE CASCADE
    )`,
    `CREATE TABLE memory_skill_heads (
      installation_id UUID NOT NULL, skill_id UUID PRIMARY KEY, current_version_id UUID NOT NULL,
      revision BIGINT NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
      state TEXT NOT NULL CHECK(state IN('draft','reviewed','rejected','revoked')),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      FOREIGN KEY(installation_id,skill_id,current_version_id) REFERENCES memory_skill_versions(installation_id,skill_id,version_id) ON DELETE CASCADE
    )`,
    `CREATE FUNCTION memory_skill_version_check_source() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM 1 FROM memory_skills s JOIN memory_skill_candidates c ON c.installation_id=s.installation_id AND c.task_id=s.task_id
          JOIN memory_skill_archives a ON a.installation_id=c.installation_id AND a.archive_id=c.archive_id
          WHERE s.installation_id=NEW.installation_id AND s.skill_id=NEW.skill_id AND c.candidate_id=NEW.candidate_id
            AND a.archive_id=NEW.archive_id AND a.source_digest=NEW.source_digest AND a.content_hash=NEW.archive_content_hash
          FOR SHARE OF s,c,a;
        IF NOT FOUND THEN RAISE EXCEPTION 'skill_version_source_invalid'; END IF;
        RETURN NEW;
      END $$`,
    `CREATE TRIGGER memory_skill_version_source BEFORE INSERT ON memory_skill_versions
      FOR EACH ROW EXECUTE FUNCTION memory_skill_version_check_source()`,
    `CREATE TABLE memory_skill_review_decisions (
      decision_id UUID PRIMARY KEY, installation_id UUID NOT NULL, skill_id UUID NOT NULL, version_id UUID NOT NULL,
      document_hash TEXT NOT NULL, source_digest TEXT NOT NULL, policy_hash TEXT NOT NULL,
      actor_kind TEXT NOT NULL CHECK(actor_kind IN('personal','membership')), actor_id UUID NOT NULL,
      membership_revision BIGINT, authorization_epoch BIGINT NOT NULL CHECK(authorization_epoch>0),
      decision TEXT NOT NULL CHECK(decision IN('approve','request_changes','reject')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK((actor_kind='personal' AND membership_revision IS NULL) OR (actor_kind='membership' AND membership_revision>0)),
      UNIQUE(installation_id,version_id,actor_kind,actor_id),
      FOREIGN KEY(installation_id,skill_id,version_id) REFERENCES memory_skill_versions(installation_id,skill_id,version_id) ON DELETE CASCADE,
      FOREIGN KEY(installation_id,version_id,document_hash,source_digest,policy_hash)
        REFERENCES memory_skill_versions(installation_id,version_id,document_hash,source_digest,policy_hash) ON DELETE CASCADE
    )`,
    `CREATE TABLE memory_skill_audit_events (
      event_id UUID PRIMARY KEY, installation_id UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
      actor_kind TEXT CHECK(actor_kind IN('personal','membership')), actor_id UUID,
      action TEXT NOT NULL CHECK(action IN('draft','edit','approve','request_changes','reject','revoke')),
      outcome TEXT NOT NULL CHECK(outcome IN('allowed','denied')), skill_id UUID, version_id UUID,
      revision BIGINT CHECK(revision BETWEEN 1 AND 9007199254740991),
      code TEXT NOT NULL CHECK(code IN('ok','invalid_request','forbidden','not_found','revision_conflict','state_conflict',
        'source_invalid','policy_changed','self_review_denied','secret_detected','size_exceeded','source_tokens_invalid',
        'duplicate_decision','feature_disabled')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), CHECK((actor_kind IS NULL)=(actor_id IS NULL))
    )`,
    `CREATE INDEX memory_skill_audit_scope_time ON memory_skill_audit_events(installation_id,created_at,event_id)`,
    `CREATE FUNCTION memory_skill_governance_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'skill_governance_immutable'; END $$`,
    ...['memory_skill_versions','memory_skill_review_decisions','memory_skill_audit_events'].map(table =>
      `CREATE TRIGGER ${table}_immutable BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION memory_skill_governance_immutable()`),
  ],
} as const
