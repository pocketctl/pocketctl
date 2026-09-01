import { randomUUID } from 'node:crypto'
import type pg from 'pg'

import type { VerifiedMemoryGrant } from '../auth/grant-guard.js'

export type Phase4DeniedMutation =
  | 'source_upload'
  | 'publish'
  | 'manual_edit'
  | 'unlock'

/**
 * Persist one shared-scope authorization denial without request content,
 * resource identifiers, grants, user identities, paths, symbols, or Wiki text.
 * The verified binding is the only provenance stored, so the response cannot
 * acknowledge a durable audit unless this insert commits first.
 */
export async function recordSharedPhase4MutationDenied(
  pool: pg.Pool,
  grant: VerifiedMemoryGrant,
  action: Phase4DeniedMutation,
): Promise<boolean> {
  if (!('version' in grant) || grant.version !== 'v2') return false
  const binding = grant.scopeBindings.find(
    candidate => candidate.installation_id === grant.installationId,
  )
  if (!binding || binding.owner_scope_kind === 'personal' || !binding.membership_id) {
    return false
  }
  await pool.query(`
    INSERT INTO memory_phase4_authorization_audit_events
      (audit_id, installation_id, action, result, actor_scope_kind,
       actor_scope_id, membership_id, membership_revision, authorization_epoch)
    VALUES ($1, $2, $3, 'unauthorized', $4, $5, $6, $7, $8)
  `, [
    randomUUID(),
    grant.installationId,
    action,
    binding.owner_scope_kind,
    binding.owner_scope_id,
    binding.membership_id,
    binding.membership_revision,
    binding.authorization_epoch,
  ])
  return true
}
