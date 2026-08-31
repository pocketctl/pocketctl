/** Frozen job types and claim shapes for the Memory background runtime. */
export type JobType =
  | 'expire_promotion_candidates'
  | 'index_shared_claim'
  | 'invalidate_scope_authorization'
  | 'transfer_scope_claims'
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
  | 'recompile_extraction_policy'
  | 'compile_context_shadow'
  | 'record_context_delivery'
  | 'invalidate_context_packs'

export const JOB_TYPES: readonly JobType[] = Object.freeze([
  'expire_promotion_candidates',
  'index_shared_claim',
  'invalidate_scope_authorization',
  'transfer_scope_claims',
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
  'recompile_extraction_policy',
  'compile_context_shadow',
  'record_context_delivery',
  'invalidate_context_packs',
])

/**
 * Frozen priorities: purge always outranks everything else, Phase 1 model
 * extraction runs before episode compilation, and index rebuild plus expiry
 * share the maintenance band (plan section 6.1).
 */
export const JOB_PRIORITIES = Object.freeze({
  expire_promotion_candidates: 40,
  index_shared_claim: 60,
  invalidate_scope_authorization: 10,
  transfer_scope_claims: 30,
  installation_purge: 0,
  session_purge: 0,
  snapshot_reconcile: 20,
  project_feed: 50,
  compile_episode: 80,
  extract_candidates: 85,
  index_claim_version: 90,
  rebuild_claim_index: 95,
  expire_claims: 95,
  recompile_extraction_policy: 84,
  compile_context_shadow: 88,
  invalidate_context_packs: 10,
  report_status: 100,
  report_usage: 100,
  record_context_delivery: 100,
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

/**
 * Per-job ownership fence (ADR-P2-09). Renewal, generation persistence and
 * follow-on enqueue must all re-check this triple in the same transaction as
 * the write; a false or erroring check cancels that job's side effects.
 */
export interface JobFence {
  jobId: string
  claimedBy: string
  claimEpoch: number
}
