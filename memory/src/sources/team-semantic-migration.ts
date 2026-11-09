import {TEAM_SEMANTIC_LEGACY_AUDIT_CHECK} from './team-semantic-legacy-audit.js'
/** Explicit semantic UUIDs are new source references. Existing raw metadata,
 * source identities, bodies, packet/fee history and preparatory rows survive. */
export const TEAM_SEMANTIC_MIGRATION={version:96,statements:[
 `ALTER TABLE source_events DROP CONSTRAINT source_events_source_kind_check`,
 `ALTER TABLE source_events ADD CONSTRAINT source_events_source_kind_check CHECK(source_kind IN('relay_event','team_collaboration','team_delivery','legacy_archive','team_semantic'))`,
 `ALTER TABLE source_events DROP CONSTRAINT source_events_verified_ref`,
 `ALTER TABLE source_events ADD CONSTRAINT source_events_verified_ref CHECK(mapping_state<>'verified' OR
  (source_kind IS NOT NULL AND canonical_key IS NOT NULL AND canonical_session_key IS NOT NULL AND source_version IS NOT NULL
   AND jsonb_typeof(source_version)='object' AND content_hash IS NOT NULL AND hash_version IS NOT NULL AND adapter_version IS NOT NULL
   AND(source_kind<>'team_semantic' AND source_version ?& ARRAY['content','authorization','storage']
    AND COALESCE(jsonb_typeof(source_version->'content')='string' AND source_version->>'content' ~ '^(0|[1-9][0-9]{0,18})$',false)
    AND COALESCE(jsonb_typeof(source_version->'authorization')='string' AND source_version->>'authorization' ~ '^(0|[1-9][0-9]{0,18})$',false)
    AND COALESCE(jsonb_typeof(source_version->'storage')='string' AND source_version->>'storage' ~ '^(0|[1-9][0-9]{0,18})$',false)
   OR source_kind='team_semantic' AND COALESCE(octet_length(source_version::text)<=512
    AND source_version ?& ARRAY['normalization','businessDigest','originalSupportDigest']
    AND source_version-ARRAY['normalization','businessDigest','originalSupportDigest']='{}'::jsonb
    AND source_version->>'normalization'='team-semantic-v1'
    AND COALESCE(jsonb_typeof(source_version->'businessDigest')='string' AND source_version->>'businessDigest' ~ '^[a-f0-9]{64}$',false)
    AND COALESCE(jsonb_typeof(source_version->'originalSupportDigest')='string' AND source_version->>'originalSupportDigest' ~ '^[a-f0-9]{64}$',false),FALSE))))`,
 `ALTER TABLE source_events DROP CONSTRAINT source_events_verified_version_range`,
 `ALTER TABLE source_events ADD CONSTRAINT source_events_verified_version_range CHECK(mapping_state<>'verified' OR source_kind='team_semantic' OR
  (${['content','authorization','storage'].map(key=>`CASE WHEN source_version->>'${key}' ~ '^(0|[1-9][0-9]{0,18})$' THEN (source_version->>'${key}')::numeric<=9223372036854775807 ELSE FALSE END`).join(' AND ')}))`,
 `ALTER TABLE source_events DROP CONSTRAINT source_events_bodyless_proof`,
 `ALTER TABLE source_events ADD CONSTRAINT source_events_bodyless_proof CHECK(payload IS NOT NULL OR
  COALESCE(mapping_state IN('verified','deleted','revoked') AND source_kind IN('relay_event','team_collaboration','team_delivery','legacy_archive','team_semantic')
   AND canonical_key IS NOT NULL AND canonical_session_key IS NOT NULL AND content_hash IS NOT NULL
   AND hash_version='canonical-json-sha256-v1' AND source_version IS NOT NULL AND adapter_version IS NOT NULL,FALSE))`,
 `ALTER TABLE source_events DROP CONSTRAINT source_events_canonical_metadata_only`,
 `ALTER TABLE source_events ADD CONSTRAINT source_events_canonical_metadata_only CHECK(origin<>'canonical' OR
  COALESCE(payload IS NULL AND mapping_state IN('verified','deleted','revoked') AND content_hash=payload_hash
   AND(source_kind IN('relay_event','team_collaboration','team_delivery') AND adapter_version='canonical-ref-v1'
    OR source_kind='team_semantic' AND adapter_version='team-semantic-v1' AND canonical_key ~ '^[a-f0-9]{64}$'
     AND source_provenance->>'source_kind'='team_semantic' AND source_provenance->>'source_version'='1'),FALSE))`,
 `ALTER TABLE memory_canonical_projection_progress DROP CONSTRAINT memory_canonical_projection_progress_state_check`,
 `ALTER TABLE memory_canonical_projection_progress ADD CONSTRAINT memory_canonical_projection_progress_state_check CHECK(state IN('scanning','raw_ready','ready'))`,
 `ALTER TABLE memory_team_semantic_groups DROP CONSTRAINT memory_team_semantic_groups_registration_state_check`,
 `ALTER TABLE memory_team_semantic_groups ADD CONSTRAINT memory_team_semantic_groups_registration_state_check CHECK(registration_state IN('preparatory','published'))`,
 `ALTER TABLE memory_team_semantic_groups ADD COLUMN semantic_payload_hash BYTEA CHECK(semantic_payload_hash IS NULL OR octet_length(semantic_payload_hash)=32)`,
 `ALTER TABLE memory_team_semantic_groups ADD CONSTRAINT memory_team_semantic_group_published_hash CHECK(registration_state<>'published' OR semantic_payload_hash IS NOT NULL)`,
 `CREATE TABLE memory_team_semantic_publications(
  installation_id UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
  group_key TEXT NOT NULL CHECK(group_key ~ '^[a-f0-9]{64}$'),
  source_kind TEXT NOT NULL CHECK(source_kind IN('team_collaboration','team_delivery')),
  structured_identity JSONB NOT NULL CHECK(jsonb_typeof(structured_identity)='array' AND jsonb_array_length(structured_identity) BETWEEN 5 AND 6 AND octet_length(structured_identity::text)<=8192),
  semantic_session_id TEXT NOT NULL CHECK(length(semantic_session_id) BETWEEN 1 AND 512),
  semantic_turn_id TEXT NOT NULL CHECK(length(semantic_turn_id) BETWEEN 1 AND 1024),
  disposition TEXT NOT NULL CHECK(disposition IN('published','policy_excluded','legacy_related','legacy_unproven')),
  goal_ref_id UUID REFERENCES memory_team_semantic_groups(semantic_ref_id) ON DELETE CASCADE,
  reply_ref_id UUID REFERENCES memory_team_semantic_groups(semantic_ref_id) ON DELETE CASCADE,
  outcome_ref_id UUID REFERENCES memory_team_semantic_groups(semantic_ref_id) ON DELETE CASCADE,
  business_digest BYTEA CHECK(business_digest IS NULL OR octet_length(business_digest)=32),
  support_digest BYTEA NOT NULL CHECK(octet_length(support_digest)=32),
  native_publication_proof JSONB NOT NULL CHECK(jsonb_typeof(native_publication_proof)='object' AND octet_length(native_publication_proof::text)<=65536),
  source_roster JSONB NOT NULL CHECK(jsonb_typeof(source_roster)='object' AND octet_length(source_roster::text)<=2097152),
  normalization_version TEXT NOT NULL CHECK(normalization_version='team-semantic-v1'),
  publication_execution_id UUID NOT NULL,
  publication_control_revision BIGINT NOT NULL CHECK(publication_control_revision>0),
  publication_mode_generation BIGINT NOT NULL CHECK(publication_mode_generation>0),
  legacy_relation_audit JSONB,
  legacy_relation_digest BYTEA,
  CONSTRAINT memory_team_semantic_legacy_audit_pair CHECK(legacy_relation_audit IS NULL AND legacy_relation_digest IS NULL OR COALESCE(legacy_relation_audit IS NOT NULL AND legacy_relation_digest IS NOT NULL AND octet_length(legacy_relation_digest)=32 AND legacy_relation_digest=sha256(convert_to(legacy_relation_audit::text,'UTF8')) AND(${TEAM_SEMANTIC_LEGACY_AUDIT_CHECK}),FALSE)),
  CONSTRAINT memory_team_semantic_legacy_disposition CHECK(disposition='policy_excluded' OR COALESCE(legacy_relation_audit IS NOT NULL AND legacy_relation_digest IS NOT NULL AND(disposition='legacy_related' AND legacy_relation_audit->>'disposition'='related' OR disposition='legacy_unproven' AND legacy_relation_audit->>'disposition' IN('unproven','fresh_candidate') OR disposition='published' AND legacy_relation_audit->>'disposition'='fresh_candidate'),FALSE)),
  published_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(installation_id,group_key),
  UNIQUE(installation_id,semantic_turn_id),
  CHECK(disposition IN('published','legacy_related') AND goal_ref_id IS NOT NULL AND reply_ref_id IS NOT NULL AND outcome_ref_id IS NOT NULL AND business_digest IS NOT NULL
    AND goal_ref_id<>reply_ref_id AND goal_ref_id<>outcome_ref_id AND reply_ref_id<>outcome_ref_id
   OR disposition IN('policy_excluded','legacy_unproven') AND goal_ref_id IS NULL AND reply_ref_id IS NULL AND outcome_ref_id IS NULL AND business_digest IS NULL),
  FOREIGN KEY(goal_ref_id) REFERENCES source_events(source_event_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(reply_ref_id) REFERENCES source_events(source_event_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(outcome_ref_id) REFERENCES source_events(source_event_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED)`,
 `CREATE INDEX memory_team_semantic_publications_session ON memory_team_semantic_publications(installation_id,semantic_session_id)`,
]} as const
/** A previously promised96 prototype is not automatically repaired in place.
 * This read-only gate precedes every installer DDL in the shared path. */
export async function assertTeamSemanticLegacySchema(client:{query:(...args:any[])=>Promise<any>},namespace:'public'|'memory'='memory'):Promise<void>{
 const marker=(await client.query('SELECT to_regclass($1) IS NOT NULL AS present',[namespace+'.memory_schema_migrations'])).rows[0]?.present
 if(!marker)return
 const version=(await client.query(`SELECT EXISTS(SELECT 1 FROM ${namespace}.memory_schema_migrations WHERE version=96) AS promised`)).rows[0]?.promised
 if(!version)return
 const ok=(await client.query(`SELECT to_regclass($1) IS NOT NULL AND NOT EXISTS(SELECT 1 FROM(VALUES('legacy_relation_audit','jsonb'::regtype),('legacy_relation_digest','bytea'::regtype)) expected(name,kind)
  WHERE NOT EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass($1) AND a.attname=expected.name AND a.atttypid=expected.kind AND NOT a.attnotnull AND NOT a.attisdropped AND a.attidentity='' AND a.attgenerated='' AND a.attacl IS NULL
   AND NOT EXISTS(SELECT 1 FROM pg_attrdef d WHERE d.adrelid=a.attrelid AND d.adnum=a.attnum)))
  AND(SELECT count(*) FROM pg_constraint WHERE conrelid=to_regclass($1) AND conname IN('memory_team_semantic_legacy_audit_pair','memory_team_semantic_legacy_disposition') AND contype='c' AND convalidated AND NOT connoinherit AND NOT condeferrable AND NOT condeferred)=2
  AND NOT EXISTS(SELECT 1 FROM jsonb_each_text($2::jsonb) expected(name,digest) WHERE NOT EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass($1) AND c.conname=expected.name AND encode(sha256(convert_to(pg_get_constraintdef(c.oid,TRUE),'UTF8')),'hex')=expected.digest)) AS ready`,[namespace+'.memory_team_semantic_publications',JSON.stringify({memory_team_semantic_legacy_audit_pair:'d76f8443b395689811c5b13e88c858751c8af863542f8ffa53cf17179c22ad30',memory_team_semantic_legacy_disposition:'c1299f95c1ce9b2474984367a2aafd7223c9c8d37e20d9620f94d243676c35b9'})])).rows[0]?.ready
 if(ok!==true)throw Error('team_semantic_legacy_schema_incompatible')
}
