/** Expand only: no backfill, index swap, production switch or automatic authority. */
export const GOVERNANCE_V2_EXPAND_MIGRATION = {
 version:51,
 statements:[
  `ALTER TABLE knowledge_claims ADD COLUMN identity_generation SMALLINT NOT NULL DEFAULT 1,
    ADD COLUMN normalized_key_v2 TEXT,
    ADD COLUMN canonical_repository_key TEXT,
    ADD COLUMN consumption_hold_reason TEXT,
    ADD CONSTRAINT knowledge_claims_identity_generation_check CHECK(identity_generation IN(1,2)),
    ADD CONSTRAINT knowledge_claims_v2_identity_check CHECK(identity_generation=1 OR (normalized_key_v2 IS NOT NULL AND normalized_key_v2 ~ '^[a-f0-9]{64}$'))`,
  `ALTER TABLE knowledge_versions ADD COLUMN applicability JSONB,
    ADD COLUMN effective_from TIMESTAMPTZ, ADD COLUMN effective_until TIMESTAMPTZ,
    ADD CONSTRAINT knowledge_versions_applicability_object CHECK(applicability IS NULL OR jsonb_typeof(applicability)='object'),
    ADD CONSTRAINT knowledge_versions_effective_interval CHECK(effective_until IS NULL OR (effective_from IS NOT NULL AND effective_until>effective_from))`,
  `ALTER TABLE memory_promotion_candidate_versions ADD COLUMN revision_bundle JSONB,
    ADD COLUMN revision_bundle_hash TEXT,
    ADD CONSTRAINT memory_promotion_bundle_object CHECK(revision_bundle IS NULL OR jsonb_typeof(revision_bundle)='object')`,
  `CREATE TABLE memory_governance_v2_states(
    installation_id UUID PRIMARY KEY REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
    phase TEXT NOT NULL DEFAULT 'expand' CHECK(phase IN('expand','bridge','backfill','validate','cutover','active','hold')),
    identity_generation SMALLINT NOT NULL DEFAULT 1 CHECK(identity_generation IN(1,2)),
    generation BIGINT NOT NULL DEFAULT 1 CHECK(generation>0),
    writer_floor TEXT NOT NULL DEFAULT 'v1', updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  `CREATE TABLE memory_governance_migration_runs(
    run_id UUID PRIMARY KEY, environment_fingerprint TEXT NOT NULL, schema_version INTEGER NOT NULL,
    manifest JSONB NOT NULL DEFAULT '{}'::jsonb, state TEXT NOT NULL CHECK(state IN('planned','running','interrupted','validated','complete','failed')),
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at TIMESTAMPTZ)`,
  `CREATE TABLE memory_governance_migration_actions(
    run_id UUID NOT NULL REFERENCES memory_governance_migration_runs(run_id),
    installation_id UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
    entity_kind TEXT NOT NULL, entity_id TEXT NOT NULL, source_revision TEXT,
    action TEXT NOT NULL CHECK(action IN('updated','unchanged','quarantined','retry')),
    reason TEXT NOT NULL, change_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(run_id,entity_kind,entity_id))`,
  `CREATE TABLE memory_governance_migration_checkpoints(
    run_id UUID NOT NULL REFERENCES memory_governance_migration_runs(run_id),
    installation_id UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
    entity_kind TEXT NOT NULL, last_id TEXT, change_watermark BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(run_id,installation_id,entity_kind))`,
  `CREATE TABLE memory_governance_migration_changes(
    sequence BIGSERIAL PRIMARY KEY,
    installation_id UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
    entity_kind TEXT NOT NULL, entity_id TEXT NOT NULL, operation TEXT NOT NULL CHECK(operation IN('INSERT','UPDATE','DELETE')),
    source_revision TEXT, occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  `CREATE INDEX memory_governance_migration_changes_scope_idx ON memory_governance_migration_changes(installation_id,sequence)`,
 ],
} as const
