/** Keep high-frequency diagnostics on bounded metadata and active inbox rows. */
export const LIFECYCLE_HEALTH_INDEX_MIGRATION={version:84,statements:[
 `CREATE INDEX IF NOT EXISTS memory_inbox_active_gauges ON memory_feed_inbox(installation_id,projection_state,feed_id)
  WHERE projection_state IN('pending','quarantined')`,
 `CREATE INDEX IF NOT EXISTS memory_processing_receipt_latest ON memory_source_processing_receipts
  (installation_id,turn_id,created_at DESC,source_digest,policy_version) INCLUDE(session_id,disposition,complete)`,
 `CREATE INDEX IF NOT EXISTS memory_source_turns_lifecycle_health ON source_turns(installation_id,updated_at DESC,turn_id)
  WHERE state IN('completed','interrupted','failed','abandoned')`,
 `CREATE INDEX IF NOT EXISTS memory_migration_tombstone_proofs ON memory_governance_migration_changes
  (installation_id,transaction_id,sequence) INCLUDE(entity_id)
  WHERE entity_kind='memory_session_tombstones' AND operation='INSERT' AND transaction_id IS NOT NULL`,
 `CREATE INDEX IF NOT EXISTS memory_migration_source_deletion_proofs ON memory_governance_migration_changes
  (installation_id,transaction_id,sequence) INCLUDE(entity_id)
  WHERE entity_kind='source_events' AND operation='DELETE'`,
]} as const
