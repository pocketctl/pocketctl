import { z } from 'zod'
import { canonicalPayloadHash } from '../inbox/canonical-json.js'

/** ADR-0007: model content has no authority, risk, identity or result fields. */
export const SKILL_CANDIDATE_SCHEMA_VERSION = 'skill-candidate.v1' as const
export const SKILL_MAX_CANDIDATE_CHARS = 32_000
export const SKILL_MAX_INPUT_CHARS = 64_000
export const SKILL_MAX_STEPS = 32
export const SKILL_MAX_SOURCES = 64
export const SKILL_STATES = ['candidate', 'draft', 'reviewed', 'canary', 'active', 'rejected', 'superseded', 'revoked'] as const
export type SkillState = typeof SKILL_STATES[number]
export const SKILL_HIGH_RISK_OPERATIONS = [
  'deployment', 'deletion', 'production_write', 'permission_change', 'data_migration',
] as const

const text = (max: number) => z.string().min(1).max(max).refine(value => value.trim().length > 0)
const identifier = text(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/)
export const SkillCandidateDocumentSchema = z.object({
  schema_version: z.literal(SKILL_CANDIDATE_SCHEMA_VERSION),
  title: text(200),
  trigger: text(2000),
  preconditions: z.array(text(2000)).min(1).max(16),
  steps: z.array(z.object({
    instruction: text(4000),
    tool: identifier,
    permissions: z.array(identifier).min(1).max(16),
    operation: z.enum(['read', 'local_write', 'unknown', ...SKILL_HIGH_RISK_OPERATIONS]),
  }).strict()).min(1).max(SKILL_MAX_STEPS),
  validation: z.array(text(2000)).min(1).max(16),
  failure_handling: z.array(text(2000)).min(1).max(16),
  rollback: z.array(text(2000)).min(1).max(16),
  source_tokens: z.array(identifier).min(1).max(SKILL_MAX_SOURCES)
    .refine(tokens => new Set(tokens).size === tokens.length),
}).strict()

export type SkillCandidateDocument = z.infer<typeof SkillCandidateDocumentSchema>

/** Exact document digest used by review, validation and Replay contracts. */
export function skillDocumentHash(document: SkillCandidateDocument): string {
  return canonicalPayloadHash(SkillCandidateDocumentSchema.parse(document)).toString('hex')
}
