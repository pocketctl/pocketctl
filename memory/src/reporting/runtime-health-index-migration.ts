/** Health polling must avoid walking source payloads or every historical episode. */
export const RUNTIME_HEALTH_INDEX_MIGRATION = {version:67,statements:[
  `CREATE INDEX IF NOT EXISTS idx_memory_extraction_runs_health_time
    ON memory_extraction_runs(installation_id,started_at DESC) INCLUDE(state,error_code)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_extraction_runs_health_failed
    ON memory_extraction_runs(installation_id,episode_id,episode_source_digest,started_at DESC,run_id DESC)
    WHERE state IN('failed','quarantined')`,
  `CREATE INDEX IF NOT EXISTS idx_memory_extraction_runs_health_latest
    ON memory_extraction_runs(installation_id,episode_id,episode_source_digest,started_at DESC,run_id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_budget_uncertain_time
    ON memory_provider_budget_reservations(created_at) INCLUDE(reserved_input_tokens,reserved_output_tokens)
    WHERE provider_kind='text' AND state='reserved'`,
  `CREATE INDEX IF NOT EXISTS idx_memory_feed_inbox_oversized_gap
    ON memory_feed_inbox(installation_id,session_id,turn_id) WHERE projection_state='quarantined' AND error_code='oversized_content'`,
]} as const
