import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { z } from 'zod'

export const SKILL_AUDIT_ACTIONS = ['draft', 'edit', 'approve', 'request_changes', 'reject', 'revoke', 'replay', 'publish', 'rollback', 'policy', 'eligibility'] as const
export const SKILL_AUDIT_OUTCOMES = ['allowed', 'denied'] as const
export const SKILL_AUDIT_CODES = [
  'ok', 'invalid_request', 'forbidden', 'not_found', 'revision_conflict', 'state_conflict',
  'source_invalid', 'policy_changed', 'self_review_denied', 'secret_detected', 'size_exceeded',
  'source_tokens_invalid', 'duplicate_decision', 'feature_disabled',
  'case_invalid', 'version_conflict', 'lease_lost', 'runner_failed', 'replay_failed', 'replay_cancelled',
  'product_gate_closed', 'risk_denied', 'review_required', 'self_publish_denied', 'independent_successes_required',
  'generation_invalid', 'budget_invalid', 'no_previous_version', 'target_revoked', 'publication_failed',
] as const

const ActorSchema = z.object({
  actorKind: z.enum(['personal', 'membership']).nullable(),
  actorId: z.uuid().nullable(),
}).strict().refine(
  ({ actorKind, actorId }) => (actorKind === null) === (actorId === null),
)

export const SkillAuditInputSchema = z.object({
  installationId: z.uuid(),
  ...ActorSchema.shape,
  action: z.enum(SKILL_AUDIT_ACTIONS),
  outcome: z.enum(SKILL_AUDIT_OUTCOMES),
  skillId: z.uuid().nullable(),
  versionId: z.uuid().nullable(),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
  code: z.enum(SKILL_AUDIT_CODES),
}).strict().refine(
  ({ actorKind, actorId }) => (actorKind === null) === (actorId === null),
)

export type SkillAuditInput = z.infer<typeof SkillAuditInputSchema>

/** Appends only bounded, content-free audit facts. The caller keeps its domain response authoritative. */
export async function appendSkillAudit(
  client: Pick<pg.PoolClient, 'query'>,
  rawInput: unknown,
): Promise<string | null> {
  const parsed = SkillAuditInputSchema.safeParse(rawInput)
  if (!parsed.success) throw new Error('skill_audit_invalid')
  const input = parsed.data
  const eventId = randomUUID()
  const inserted = await client.query<{ event_id: string }>(`
    INSERT INTO memory_skill_audit_events
      (event_id, installation_id, actor_kind, actor_id, action, outcome,
       skill_id, version_id, revision, code)
    SELECT $1, installation_id, $3, $4, $5, $6, $7, $8, $9, $10
      FROM memory_installations
      WHERE installation_id = $2
    RETURNING event_id
  `, [
    eventId, input.installationId, input.actorKind, input.actorId, input.action, input.outcome,
    input.skillId, input.versionId, input.revision, input.code,
  ])
  return inserted.rows[0]?.event_id ?? null
}
