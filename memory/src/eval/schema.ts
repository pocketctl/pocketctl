import { z } from 'zod'

/**
 * Versioned Golden Set format (plan Task 16). Only synthetic fixtures are
 * committed; `memory/eval/private/**` stays out of the repository. Each case
 * carries an opaque id — never raw private query or evidence text.
 */

export const GoldenCaseSchema = z.strictObject({
  id: z.string().min(1).max(64),
  schema_version: z.literal(1),
  query: z.string().min(1).max(2000),
  installation_id: z.string().uuid(),
  allowed: z.strictObject({
    repository_ids: z.array(z.string().uuid()).max(8).default([]),
    repo_snapshot_ids: z.array(z.string().uuid()).max(8).default([]),
    branches: z.array(z.string().min(1).max(255)).max(8).default([]),
  }),
  expected: z.strictObject({
    /** Any of these claim ids in Top-5 counts as a valid hit. */
    claim_ids: z.array(z.string().uuid()).default([]),
    /** Every listed claim must appear with at least one evidence row. */
    evidence_claim_ids: z.array(z.string().uuid()).default([]),
  }),
  review_outcome: z.enum([
    'accepted_as_is', 'light_edit', 'major_edit', 'rejected',
  ]).optional(),
}).superRefine((value, context) => {
  const combinations = Math.max(1, value.allowed.repository_ids.length)
    * Math.max(1, value.allowed.repo_snapshot_ids.length)
    * Math.max(1, value.allowed.branches.length)
  if (combinations > 64) {
    context.addIssue({ code: 'custom', path: ['allowed'], message: 'allowed scope expands beyond 64 combinations' })
  }
})

export const GoldenDatasetSchema = z.strictObject({
  schema_version: z.literal(1),
  dataset_version: z.string().min(1).max(64),
  created_at: z.string().datetime(),
  cases: z.array(GoldenCaseSchema).min(1),
})

export type GoldenCase = z.output<typeof GoldenCaseSchema>
export type GoldenDataset = z.output<typeof GoldenDatasetSchema>
