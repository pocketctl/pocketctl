/** Frozen job types and claim shapes for the Memory background runtime. */
export type JobType =
  | 'project_feed'
  | 'compile_episode'
  | 'snapshot_reconcile'
  | 'session_purge'
  | 'installation_purge'
  | 'report_status'
  | 'report_usage'
  | 'extract_candidates'
  | 'index_claim_version'
  | 'rebuild_claim_index'
  | 'expire_claims'

export const JOB_TYPES: readonly JobType[] = Object.freeze([
  'project_feed',
  'compile_episode',
  'snapshot_reconcile',
  'session_purge',
  'installation_purge',
  'report_status',
  'report_usage',
  'extract_candidates',
  'index_claim_version',
  'rebuild_claim_index',
  'expire_claims',
])

/**
 * Frozen priorities: purge always outranks everything else, Phase 1 model
 * extraction runs before episode compilation, and index rebuild plus expiry
 * share the maintenance band (plan section 6.1).
 */
export const JOB_PRIORITIES = Object.freeze({
  installation_purge: 0,
  session_purge: 0,
  snapshot_reconcile: 20,
  project_feed: 50,
  compile_episode: 80,
  extract_candidates: 85,
  index_claim_version: 90,
  rebuild_claim_index: 95,
  expire_claims: 95,
  report_status: 100,
  report_usage: 100,
} as Record<JobType, number>)

export const JOB_DEAD_LETTER_ATTEMPTS = 12

export interface JobClaim {
  job_id: string
  installation_id: string | null
  job_type: JobType
  idempotency_key: string
  payload: Record<string, unknown>
  attempts: number
  claim_epoch: number
}
