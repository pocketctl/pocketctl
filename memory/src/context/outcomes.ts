/**
 * Bounded Phase 2 outcome vocabularies (plan 12.1/17): every metric label
 * and log code comes from one of these frozen lists — never from user
 * content, pack text, grants, paths, or any high-cardinality source.
 */
export const PHASE2_CONTEXT_OUTCOMES = Object.freeze([
  'off', 'shadow_queued', 'ready', 'empty', 'degraded',
  'unsupported_adapter', 'retrieval_failed', 'admission_failed',
  'admission_existing', 'grant_unavailable', 'deadline',
] as const)

export const PHASE2_ADMISSION_CODES = Object.freeze([
  'pack_not_ready', 'mode_off', 'claim_invalid', 'expired', 'pack_mismatch',
] as const)

export const PHASE2_DELIVERY_CODES = Object.freeze([
  'delivered', 'delivery_failed', 'expired', 'skipped',
] as const)

export type Phase2ContextOutcome = (typeof PHASE2_CONTEXT_OUTCOMES)[number]
export type Phase2AdmissionCode = (typeof PHASE2_ADMISSION_CODES)[number]
export type Phase2DeliveryCode = (typeof PHASE2_DELIVERY_CODES)[number]
