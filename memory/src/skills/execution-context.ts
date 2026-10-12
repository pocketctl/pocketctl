import type pg from 'pg'
import type { V2GrantFacts } from '../governance/authorization.js'
import { assertCurrentGrantClock, requireCurrentScopePermission, TargetBindingError, createScopeAuthorization, type GrantScopeBinding } from '../governance/authorization.js'
import { createTransactionBoundPool } from '../api/transaction-bound-pool.js'
import { skillModeForScope } from './config.js'
import type { SkillSourceContext } from './source-resolver.js'
import { hasSkillFixtureCapability } from './testing-capability.js'

export type SkillIdentity = { installationId: string; grant: V2GrantFacts }
export function requireSkillExecutionFixture(capability: object | undefined): void {
  if (!hasSkillFixtureCapability(capability)) throw new SkillExecutionError('product_gate_closed')
}
export class SkillExecutionError extends Error {
  readonly statusCode: number
  constructor(readonly code: 'invalid_request'|'forbidden'|'not_found'|'feature_disabled'|'product_gate_closed'|'revision_conflict'|'source_invalid'|'rollout_disabled'|'not_assigned'|'receipt_conflict') {
    super(code); this.name = 'SkillExecutionError'
    this.statusCode = code === 'invalid_request' ? 400 : code === 'forbidden' ? 403 : code === 'not_found' ? 404 : code === 'feature_disabled' ? 503 : 409
  }
}
export async function withSkillTransaction<T>(pool: pg.Pool, identity: SkillIdentity, body: (client: pg.PoolClient) => Promise<T>, beforeCommit?: (client: pg.PoolClient) => Promise<void>): Promise<T> {
  const client = await pool.connect()
  try { await client.query('BEGIN'); const result = await body(client); await assertSkillExecutionGrantClock(client, identity); await beforeCommit?.(client); await client.query('COMMIT'); return result }
  catch(error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}
export async function authorizeSkillExecution(client: pg.PoolClient, identity: SkillIdentity, context: SkillSourceContext, permission: 'read'|'publish', lock = true) {
  let binding: GrantScopeBinding | undefined
  if (lock) {
    try {
      binding = await requireCurrentScopePermission({client,grant:identity.grant,targetInstallationId:identity.installationId,permission})
    }catch(error){if(error instanceof TargetBindingError)throw new SkillExecutionError('forbidden');throw error}
  } else {
    // Preliminary admission only: source Sessions must be locked before the
    // authoritative source resolver takes lifecycle/mirror locks.
    const auth = createScopeAuthorization(createTransactionBoundPool(client)), grant = await auth.validateV2Grant(identity.grant)
    binding = grant?.scopeBindings.find(b => b.installation_id === identity.installationId)
  }
  if (!binding || !binding.permissions.includes(permission)) throw new SkillExecutionError('forbidden')
  if (skillModeForScope(context.globalMode,context.config.mode,context.sharedMode,binding.owner_scope_kind) === 'off') throw new SkillExecutionError('feature_disabled')
  return binding
}

async function assertSkillExecutionGrantClock(client: Pick<pg.PoolClient, 'query'>, identity: SkillIdentity): Promise<void> {
  try { await assertCurrentGrantClock(client, identity.grant,[identity.installationId]) }
  catch (error) { if (error instanceof TargetBindingError) throw new SkillExecutionError('forbidden'); throw error }
}
