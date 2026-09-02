export const SKILL_PUBLICATION_MIGRATION = {
  version: 35,
  statements: [
    `ALTER TABLE memory_skill_audit_events DROP CONSTRAINT memory_skill_audit_events_action_check`,
    `ALTER TABLE memory_skill_audit_events ADD CONSTRAINT memory_skill_audit_events_action_check CHECK(action IN('draft','edit','approve','request_changes','reject','revoke','replay','publish','rollback','policy','eligibility'))`,
    `ALTER TABLE memory_skill_audit_events DROP CONSTRAINT memory_skill_audit_events_code_check`,
    `ALTER TABLE memory_skill_audit_events ADD CONSTRAINT memory_skill_audit_events_code_check CHECK(code IN('ok','invalid_request','forbidden','not_found','revision_conflict','state_conflict','source_invalid','policy_changed','self_review_denied','secret_detected','size_exceeded','source_tokens_invalid','duplicate_decision','feature_disabled','case_invalid','version_conflict','lease_lost','runner_failed','replay_failed','replay_cancelled','product_gate_closed','risk_denied','review_required','self_publish_denied','independent_successes_required','generation_invalid','budget_invalid','no_previous_version','target_revoked','publication_failed'))`,
    `ALTER TABLE memory_skill_task_runs ADD COLUMN budget_reservation_id UUID`,
    `CREATE TABLE memory_skill_publication_policy_versions (
      version_id UUID PRIMARY KEY, installation_id UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
      revision BIGINT NOT NULL CHECK(revision>0), policy JSONB NOT NULL, policy_hash TEXT NOT NULL CHECK(policy_hash ~ '^[0-9a-f]{64}$'),
      actor_kind TEXT NOT NULL CHECK(actor_kind IN('personal','membership')),actor_id UUID NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK((policy->>'minimumIndependentSuccesses')::int>=2 AND policy->>'autoMode' IN('off','shadow') AND policy->>'canaryMode' IN('off','shadow')),
      UNIQUE(installation_id,version_id),UNIQUE(installation_id,revision))`,
    `CREATE TABLE memory_skill_publication_policy_heads (
      installation_id UUID PRIMARY KEY REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
      version_id UUID NOT NULL,revision BIGINT NOT NULL CHECK(revision>0),
      FOREIGN KEY(installation_id,version_id) REFERENCES memory_skill_publication_policy_versions(installation_id,version_id))`,
    `CREATE TABLE memory_skill_publication_events (
      event_id UUID PRIMARY KEY,installation_id UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
      skill_id UUID NOT NULL,version_id UUID NOT NULL,previous_version_id UUID,revision BIGINT NOT NULL CHECK(revision>0),
      mode TEXT NOT NULL CHECK(mode IN('manual','auto','rollback')),provenance TEXT NOT NULL CHECK(provenance='fixture'),
      actor_kind TEXT NOT NULL CHECK(actor_kind IN('personal','membership')),actor_id UUID NOT NULL,
      membership_revision BIGINT,authorization_epoch BIGINT NOT NULL CHECK(authorization_epoch>0),
      policy_hash TEXT NOT NULL CHECK(policy_hash ~ '^[0-9a-f]{64}$'),replay_run_id UUID NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(installation_id,event_id),UNIQUE(installation_id,skill_id,revision))`,
    `CREATE TABLE memory_skill_publication_heads (
      installation_id UUID NOT NULL,skill_id UUID NOT NULL,current_version_id UUID,previous_version_id UUID,
      revision BIGINT NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),state TEXT NOT NULL CHECK(state IN('active','disabled')),
      publication_event_id UUID,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(installation_id,skill_id),
      CHECK(state<>'active' OR current_version_id IS NOT NULL),
      FOREIGN KEY(installation_id,skill_id) REFERENCES memory_skills(installation_id,skill_id) ON DELETE CASCADE,
      FOREIGN KEY(installation_id,skill_id,current_version_id) REFERENCES memory_skill_versions(installation_id,skill_id,version_id) ON DELETE CASCADE,
      FOREIGN KEY(installation_id,skill_id,previous_version_id) REFERENCES memory_skill_versions(installation_id,skill_id,version_id) ON DELETE SET NULL(previous_version_id),
      FOREIGN KEY(installation_id,publication_event_id) REFERENCES memory_skill_publication_events(installation_id,event_id))`,
    `CREATE TABLE memory_skill_version_revocations (
      installation_id UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
      skill_id UUID NOT NULL,version_id UUID NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(installation_id,version_id))`,
    ...['memory_skill_publication_policy_versions','memory_skill_publication_events','memory_skill_version_revocations'].map(table =>
      `CREATE TRIGGER ${table}_immutable BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION memory_skill_governance_immutable()`),
    `CREATE FUNCTION memory_skill_publication_revoke() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.state='revoked' THEN
          INSERT INTO memory_skill_version_revocations(installation_id,skill_id,version_id)
            SELECT installation_id,skill_id,version_id FROM memory_skill_versions WHERE installation_id=NEW.installation_id AND skill_id=NEW.skill_id
            ON CONFLICT DO NOTHING;
          UPDATE memory_skill_publication_heads SET state='disabled',revision=revision+1,updated_at=NOW()
            WHERE installation_id=NEW.installation_id AND skill_id=NEW.skill_id AND state='active';
        END IF; RETURN NEW;
      END $$`,
    `CREATE TRIGGER memory_skill_publication_revoke AFTER UPDATE OF state ON memory_skill_heads
      FOR EACH ROW EXECUTE FUNCTION memory_skill_publication_revoke()`,
    `CREATE FUNCTION memory_skill_publication_target_revoked() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN UPDATE memory_skill_publication_heads SET state='disabled',revision=revision+1,updated_at=NOW()
        WHERE installation_id=NEW.installation_id AND current_version_id=NEW.version_id AND state='active'; RETURN NEW; END $$`,
    `CREATE TRIGGER memory_skill_publication_target_revoked AFTER INSERT ON memory_skill_version_revocations
      FOR EACH ROW EXECUTE FUNCTION memory_skill_publication_target_revoked()`,
  ],
} as const
