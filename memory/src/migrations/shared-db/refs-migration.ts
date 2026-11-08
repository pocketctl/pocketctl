/** R1 keeps compatibility bodies; binding is populated only by proven mapping. */
export const SHARED_SOURCE_REFS_MIGRATION={version:86,statements:[
 `ALTER TABLE source_events
   ADD COLUMN source_kind TEXT CHECK(source_kind IN('relay_event','team_collaboration','team_delivery','legacy_archive')),
   ADD COLUMN canonical_key TEXT CHECK(length(canonical_key) BETWEEN 1 AND 1024),
   ADD COLUMN canonical_session_key TEXT CHECK(length(canonical_session_key) BETWEEN 1 AND 512),
   ADD COLUMN source_version JSONB,
   ADD COLUMN source_sequence BIGINT CHECK(source_sequence>0),
   ADD COLUMN content_hash BYTEA CHECK(content_hash IS NULL OR octet_length(content_hash)=32),
   ADD COLUMN hash_version TEXT CHECK(hash_version IS NULL OR hash_version='canonical-json-sha256-v1'),
   ADD COLUMN mapping_state TEXT NOT NULL DEFAULT 'unproven' CHECK(mapping_state IN('unproven','verified','deleted','revoked','conflict')),
   ADD COLUMN adapter_version TEXT,
   ADD CONSTRAINT source_events_verified_ref CHECK(mapping_state<>'verified' OR
    (source_kind IS NOT NULL AND canonical_key IS NOT NULL AND canonical_session_key IS NOT NULL AND source_version IS NOT NULL
      AND jsonb_typeof(source_version)='object' AND source_version ?& ARRAY['content','authorization','storage']
      AND COALESCE(jsonb_typeof(source_version->'content')='string' AND source_version->>'content' ~ '^(0|[1-9][0-9]{0,18})$',false)
      AND COALESCE(jsonb_typeof(source_version->'authorization')='string' AND source_version->>'authorization' ~ '^(0|[1-9][0-9]{0,18})$',false)
      AND COALESCE(jsonb_typeof(source_version->'storage')='string' AND source_version->>'storage' ~ '^(0|[1-9][0-9]{0,18})$',false)
      AND content_hash IS NOT NULL AND hash_version IS NOT NULL AND adapter_version IS NOT NULL))`,
 `CREATE UNIQUE INDEX source_events_verified_canonical_identity ON source_events(installation_id,source_kind,canonical_key) WHERE mapping_state='verified'`,
]} as const
