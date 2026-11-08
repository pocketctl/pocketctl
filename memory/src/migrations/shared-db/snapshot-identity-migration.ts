/** Additive landing proof. Historical envelope hashes remain immutable. */
export const SNAPSHOT_IDENTITY_MIGRATION={version:90,statements:[
 `ALTER TABLE memory_snapshot_events ADD COLUMN content_hash BYTEA
   CHECK(content_hash IS NULL OR octet_length(content_hash)=32)`,
]} as const
