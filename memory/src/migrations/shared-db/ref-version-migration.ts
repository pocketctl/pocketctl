/** Additive: already installed migration86 stays immutable. Runtime and SQL
 * agree on signed-bigint versions, rejecting malformed/unavailable proofs. */
export const SHARED_SOURCE_VERSION_RANGE_MIGRATION={version:87,statements:[
 `ALTER TABLE source_events ADD CONSTRAINT source_events_verified_version_range CHECK(mapping_state<>'verified' OR
  (${['content','authorization','storage'].map(key=>`CASE WHEN source_version->>'${key}' ~ '^(0|[1-9][0-9]{0,18})$' THEN (source_version->>'${key}')::numeric<=9223372036854775807 ELSE FALSE END`).join(' AND ')}))`,
]} as const
