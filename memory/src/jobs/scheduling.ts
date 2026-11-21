// Priority assigned by shared.dispatch_memory_source_distribution only when
// the dispatched frontier covers a previously undispatched native append.
export const APPEND_PROJECTION_PRIORITY = 51
// Snapshot and scan-derived compilations share general capacity. An append
// affecting the same turn promotes its next eligible compilation.
export const HISTORICAL_COMPILE_PRIORITY = 70

export const SHARED_JOB_CAPACITY = {
  event_append: 1,
  projection_scan: 1,
  compile: 2,
  general: 3,
} as const

export type JobCapacity = Partial<Record<keyof typeof SHARED_JOB_CAPACITY, number>>

// These classes affect scheduling only. Authorization, processing fences and
// the idempotency key remain the responsibility of the ordinary job handlers.
export const jobCapacityClassSql = `CASE
  WHEN job_type='project_shared_source' AND (priority=${APPEND_PROJECTION_PRIORITY}
    OR payload->'offline_projection'='true'::jsonb) THEN 'event_append'
  WHEN job_type='project_shared_source' THEN 'projection_scan'
  WHEN job_type='compile_episode' AND priority<>${HISTORICAL_COMPILE_PRIORITY} THEN 'compile'
  WHEN job_type IN ('session_purge','installation_purge','invalidate_scope_authorization','invalidate_context_packs') THEN 'control'
  ELSE 'general' END`
