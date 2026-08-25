import { z } from 'zod'
import { caseInsensitiveClaimKey } from '../retrieval/query-normalizer.js'

/**
 * Strict wire schema for model extraction output (plan §9.2). Everything not
 * declared here is rejected — unknown keys, extra candidates, out-of-range
 * confidence, malformed handles. The schema is the deny-by-default boundary
 * between untrusted model output and the candidate ledger.
 */

export const CLAIM_TYPES = [
  'architecture_decision',
  'repository_convention',
  'bug_root_cause',
  'rejected_hypothesis',
  'test_invariant',
  'implementation_map',
  'operational_runbook',
  'work_method',
  'reusable_skill_candidate',
] as const

export const SCOPE_KINDS = [
  'installation',
  'repository',
  'snapshot',
  'branch',
  'task',
] as const

/** Evidence handles are Episode-local and structurally opaque. */
export const EVIDENCE_HANDLE_PATTERN = /^h\d+-[0-9a-f]{8}$/

const EvidenceHandle = z.string().regex(
  EVIDENCE_HANDLE_PATTERN,
  'evidence_handle must be an episode-local handle from the allowlist',
)

const IsoTimestamp = z.string().datetime()

const StructuredValue = z.union([
  z.string().max(512),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(z.string().max(128)).max(16),
])

export const StructuredContentSchema = z.record(
  z.string().min(1).max(64),
  StructuredValue,
).refine(value => Object.keys(value).length <= 16, 'structured_content has too many fields')

export const ExtractionCandidateSchema = z.strictObject({
  claim_type: z.enum(CLAIM_TYPES),
  statement: z.string().min(1).max(4000),
  structured_content: StructuredContentSchema.optional(),
  confidence: z.number().min(0).max(1),
  scope_kind: z.enum(SCOPE_KINDS),
  scope_key: z.string().min(1).max(512),
  repository_id: z.string().uuid().nullable().optional(),
  repo_snapshot_id: z.string().uuid().nullable().optional(),
  branch: z.string().min(1).max(255).nullable().optional(),
  freshness_at: IsoTimestamp.optional(),
  valid_from: IsoTimestamp.nullable().optional(),
  valid_until: IsoTimestamp.nullable().optional(),
  evidence_handles: z.array(EvidenceHandle).min(1).max(12),
})

export const ExtractionOutputSchema = z.strictObject({
  candidates: z.array(ExtractionCandidateSchema).min(1).max(16),
})

export type ExtractionCandidate = z.output<typeof ExtractionCandidateSchema>
export type ExtractionOutput = z.output<typeof ExtractionOutputSchema>

export interface ValidationFailure {
  codes: string[]
}

/** Validate raw model output; returns bounded error codes, never raw text. */
export function validateExtractionOutput(raw: unknown): { ok: true; value: ExtractionOutput } | { ok: false; failure: ValidationFailure } {
  const result = ExtractionOutputSchema.safeParse(raw)
  if (result.success) return { ok: true, value: result.data }
  const codes = result.error.issues
    .slice(0, 16)
    .map(issue => {
      const path = issue.path.length > 0 ? issue.path.join('.') : 'root'
      return `${path}:${issue.code}`
    })
  return { ok: false, failure: { codes } }
}

/**
 * Deterministic normalized key for candidate identity (interim form; Task 6
 * refines token-level normalization). Bounded to the ledger column limit.
 */
export function normalizedKeyForCandidate(input: {
  claimType: string
  scopeKey: string
  statement: string
}): string {
  return caseInsensitiveClaimKey(input)
}
