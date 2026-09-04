import { z } from 'zod'

/** Bounded request schemas for /api/v1/memory (plan §7). */

export const UUIDSchema = z.string().uuid()
const UUID = UUIDSchema

export const EpisodesQuerySchema = z.strictObject({
  session_id: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

export const ClaimVersionsQuerySchema = z.strictObject({
  installation_id: UUID.optional(),
  version_limit: z.coerce.number().int().min(1).max(20).default(20),
  version_cursor: z.string().min(1).max(512).optional(),
})

export const ClaimsQuerySchema = z.strictObject({
  state: z.literal('active').default('active'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(2048).optional(),
})

export const SearchRequestSchema = z.strictObject({
  query: z.string().min(1).max(2000),
  scope_installation_ids: z.array(UUID).min(1).max(16).refine(
    ids => new Set(ids).size === ids.length,
    { message: 'scope_installation_ids must be unique' },
  ).nullish(),
  repository_id: UUID.nullish(),
  repo_snapshot_id: UUID.nullish(),
  branch: z.string().min(1).max(255).nullish(),
  claim_types: z.array(z.enum([
    'architecture_decision', 'repository_convention', 'bug_root_cause',
    'rejected_hypothesis', 'test_invariant', 'implementation_map',
    'operational_runbook', 'work_method', 'reusable_skill_candidate',
  ])).min(1).max(9).nullish(),
  as_of: z.string().datetime().nullish(),
  limit: z.number().int().min(1).max(20).nullish(),
  cursor: z.string().min(1).max(2048).nullish(),
})

export const RecallRequestSchema = SearchRequestSchema.extend({
  max_claims: z.number().int().min(1).max(10).nullish(),
  max_evidence_per_claim: z.number().int().min(1).max(5).nullish(),
  max_chars: z.number().int().min(1000).max(12000).nullish(),
})

export const AcceptRequestSchema = z.strictObject({
  expected_revision: z.number().int().min(1),
  edited_statement: z.string().min(1).max(4000).nullish(),
})

export const RejectRequestSchema = z.strictObject({
  expected_revision: z.number().int().min(1),
  reason_code: z.string().min(1).max(128).nullish(),
})

const ExplicitEvidenceBase = {
  episode_id: UUID,
  locator: z.record(z.string(), z.unknown()).default({}),
  excerpt: z.string().min(1).max(4000),
  occurred_at: z.string().datetime(),
}

const ExplicitEvidenceSchema = z.discriminatedUnion('evidence_kind', [
  z.strictObject({
    ...ExplicitEvidenceBase,
    evidence_kind: z.literal('event'),
    source_event_id: UUID,
  }),
  z.strictObject({
    ...ExplicitEvidenceBase,
    evidence_kind: z.literal('artifact'),
    artifact_id: UUID,
  }),
  z.strictObject({
    ...ExplicitEvidenceBase,
    evidence_kind: z.literal('episode'),
  }),
])

export const CorrectRequestSchema = z.strictObject({
  expected_revision: z.number().int().min(1),
  statement: z.string().min(1).max(4000),
  evidence: z.array(ExplicitEvidenceSchema).min(1).max(13),
})

export const ListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

export const TransitionRequestSchema = z.strictObject({
  expected_revision: z.number().int().min(1),
})

export const DeleteRequestSchema = TransitionRequestSchema

export const SettingsPatchSchema = z.strictObject({
  expected_revision: z.number().int().min(1),
  extraction_mode: z.enum(['off', 'shadow', 'enabled']).nullish(),
  embedding_mode: z.enum(['off', 'shadow', 'enabled']).nullish(),
  confirm_extraction_fingerprint: z.string().length(64).nullish(),
  confirm_embedding_fingerprint: z.string().length(64).nullish(),
})

export const FeedbackRequestSchema = z.strictObject({
  request_id: UUID.nullish(),
  action: z.enum([
    'recall_used', 'recall_incorrect', 'recall_not_useful',
  ]),
  reason_code: z.string().min(1).max(128).nullish(),
})

export type SearchRequest = z.output<typeof SearchRequestSchema>
export type RecallRequest = z.output<typeof RecallRequestSchema>
