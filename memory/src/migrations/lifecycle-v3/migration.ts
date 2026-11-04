/** Additive audit data; no body backup that could resurrect a deleted fact. */
export const LIFECYCLE_BACKFILL_MIGRATION={version:81,statements:[
 `CREATE TABLE memory_lifecycle_migration_runs (
 manifest_digest TEXT PRIMARY KEY CHECK(manifest_digest~'^[a-f0-9]{64}$'),
 policy_version TEXT NOT NULL, installation_ids UUID[] NOT NULL,
 target_mode TEXT NOT NULL CHECK(target_mode IN('off','shadow','enabled')),
 checkpoint INTEGER NOT NULL DEFAULT 0 CHECK(checkpoint>=0), total INTEGER NOT NULL CHECK(total>=0),
 state TEXT NOT NULL DEFAULT 'running' CHECK(state IN('running','completed')),
 source_watermark TEXT NOT NULL, deletion_watermark TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),completed_at TIMESTAMPTZ)`,
 `CREATE TABLE memory_lifecycle_migration_items (
 manifest_digest TEXT NOT NULL REFERENCES memory_lifecycle_migration_runs ON DELETE CASCADE,
 ordinal INTEGER NOT NULL,installation_id UUID NOT NULL,claim_id UUID NOT NULL,
 outcome TEXT NOT NULL CHECK(outcome IN('migrated','preserved_existing','preserved_concurrent_change','preserved_inactive','missing_deleted')),
 source_fingerprint TEXT NOT NULL CHECK(source_fingerprint~'^[a-f0-9]{64}$'),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(manifest_digest,ordinal))`,
]}
