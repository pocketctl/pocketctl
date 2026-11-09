/** Frozen queue/index inputs for the canonical producer; later job types use
 * another migration rather than changing this historical list. */
export const CANONICAL_WORK_MIGRATION={version:92,statements:[
 `ALTER TABLE source_events ADD COLUMN canonical_projected_at TIMESTAMPTZ`,
 `CREATE TABLE memory_canonical_projection_progress(
  installation_id UUID NOT NULL REFERENCES memory_installations(installation_id),
  source_kind TEXT NOT NULL CHECK(source_kind IN('relay_event','team_collaboration','team_delivery')),
  root_key TEXT NOT NULL CHECK(length(root_key) BETWEEN 1 AND 1024),
  context_key TEXT NOT NULL CHECK(context_key ~ '^[a-f0-9]{64}$'),
  source_version JSONB NOT NULL CHECK(jsonb_typeof(source_version)='object'),
  next_cursor TEXT CHECK(length(next_cursor)<=8192),
  state TEXT NOT NULL CHECK(state IN('scanning','ready')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(installation_id,source_kind,root_key,context_key),
  CHECK(state='scanning' OR next_cursor IS NULL))`,
 `CREATE INDEX source_events_unproven_session ON source_events(installation_id,session_id) WHERE mapping_state IN('unproven','conflict')`,
 `CREATE INDEX source_events_unproven_canonical_session ON source_events(installation_id,canonical_session_key) WHERE mapping_state IN('unproven','conflict')`,
 `CREATE INDEX source_events_typed_lookup ON source_events(installation_id,source_kind,canonical_key) WHERE source_kind IS NOT NULL AND canonical_key IS NOT NULL`,
 `ALTER TABLE memory_jobs DROP CONSTRAINT memory_jobs_job_type_check`,
 `ALTER TABLE memory_jobs ADD CONSTRAINT memory_jobs_job_type_check CHECK(job_type IN(
  'project_shared_source','consolidate_task','curate_conclusions','evaluate_claim_lifecycle','reclaim_claim_history','execute_publication_delegation','evaluate_review_shadow',
  'git_ingest','git_export','git_reconcile','expire_promotion_candidates','index_shared_claim','invalidate_scope_authorization','transfer_scope_claims',
  'project_feed','compile_episode','snapshot_reconcile','session_purge','installation_purge','report_status','report_usage','extract_candidates',
  'index_claim_version','rebuild_claim_index','expire_claims','recompile_extraction_policy','compile_context_shadow','record_context_delivery',
  'invalidate_context_packs','parse_code_snapshot','build_wiki','extract_skill_candidate'))`,
]} as const
