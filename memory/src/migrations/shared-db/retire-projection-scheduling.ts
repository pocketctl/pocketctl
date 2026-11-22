// The Relay migrator owns event triggers. Refuse to retire the window while an
// old Relay trigger could run against it. Never cascade into external objects.
export const RETIRE_PROJECTION_SCHEDULING = [
 `DO $$ BEGIN
   IF to_regclass('memory.memory_canonical_projection_progress') IS NOT NULL THEN
   LOCK TABLE memory.memory_jobs IN SHARE MODE;
   IF EXISTS(SELECT 1 FROM memory.memory_jobs WHERE state='running' AND claim_expires_at>clock_timestamp()
    AND (job_type IN('project_feed','project_shared_source','snapshot_reconcile')
      OR job_type='compile_episode' AND NOT(payload ? 'dialogue_session')))
    OR EXISTS(SELECT 1 FROM shared.memory_source_provider_attempts WHERE state='inflight')
    THEN RAISE EXCEPTION 'source_executions_not_drained';END IF;
   END IF;
   IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.events')
     AND tgname IN('memory_window_capture_insert','memory_window_capture_update')) THEN
    RAISE EXCEPTION 'relay_projection_capture_upgrade_required';
   END IF;
 END $$`,
 `DROP TRIGGER IF EXISTS freeze_memory_projection_window ON shared.memory_source_work;
  DROP TRIGGER IF EXISTS bind_memory_projection_batch ON shared.memory_source_distributions;
  DROP TRIGGER IF EXISTS bind_memory_projection_target ON shared.memory_source_distribution_targets;
  DROP TRIGGER IF EXISTS classify_memory_projection_job ON memory.memory_jobs`,
 `DO $$ BEGIN IF to_regclass('memory.memory_canonical_projection_progress') IS NOT NULL THEN
  DROP TRIGGER IF EXISTS ack_memory_projection_target ON memory.memory_canonical_projection_progress;
 END IF;END $$`,
 `DROP TABLE IF EXISTS shared.memory_projection_policies,shared.memory_projection_windows,
   shared.memory_source_shadow_progress,memory.memory_canonical_projection_progress RESTRICT`,
 `DROP FUNCTION IF EXISTS shared.check_memory_projection_capture(),shared.memory_projection_runtime_ready(),
   shared.memory_projection_capture_installed(),shared.freeze_memory_projection_window(),
   shared.bind_memory_projection_batch(),shared.bind_memory_projection_target(),
   shared.classify_memory_projection_job(),shared.ack_memory_projection_target(),
   shared.write_memory_source_shadow_progress(UUID,JSONB,TEXT,TEXT,UUID,TEXT,JSONB),
   shared.read_memory_source_shadow_progress(UUID,TEXT,TEXT,UUID,TEXT),
   shared.memory_shadow_candidate_headers(UUID,TEXT,TEXT[],TEXT[]) RESTRICT`,
 `ALTER TABLE shared.memory_source_contract ADD COLUMN IF NOT EXISTS offline_projection_version INT NOT NULL DEFAULT 0,
   ADD COLUMN IF NOT EXISTS shadow_version INT NOT NULL DEFAULT 0;
  UPDATE shared.memory_source_contract SET offline_projection_version=0,shadow_version=0 WHERE singleton`,
] as const
