import type pg from 'pg'

/**
 * ADR-0005 Memory-side v2 grant authorization (§8.1). The cryptographic
 * verifier establishes WHAT Relay signed; this module revalidates every
 * binding against the local scope mirror in one bounded query and returns
 * only bindings whose installation, owner scope, lifecycle state,
 * authorization epoch, membership revision, and role-derived permissions are
 * all still current. Stale/missing/revoked bindings are silently dropped for
 * reads; mutations demand an exact surviving target binding.
 */

export interface GrantScopeBinding {
  installation_id: string
  owner_scope_kind: 'personal' | 'team' | 'organization'
  owner_scope_id: string
  membership_id: string | null
  membership_revision: string
  authorization_epoch: string
  permissions: string[]
}

/** Cryptographically verified facts handed over by the grant guard. */
export interface V2GrantFacts {
  primaryInstallationId: string
  configVersion: string
  scopeBindings: GrantScopeBinding[]
}

/**
 * Route-level v2 grant context (the guard's return shape): carries the same
 * fences as V2GrantFacts plus display fields. Structurally assignable to
 * V2GrantFacts wherever services consume bindings.
 */
export interface RouteV2Grant extends V2GrantFacts {
  version: 'v2'
  installationId: string
  services: string[]
  callerType: string
  scopeBindings: GrantScopeBinding[]
  primaryInstallationId: string
}

export interface ValidatedV2Grant {
  primaryInstallationId: string
  configVersion: string
  scopeBindings: GrantScopeBinding[]
}

const PERMISSIONS_BY_ROLE: Readonly<Record<string, readonly string[]>> = Object.freeze({
  reader: Object.freeze(['read']),
  contributor: Object.freeze(['read', 'contribute']),
  reviewer: Object.freeze(['read', 'review']),
  publisher: Object.freeze(['read', 'review', 'publish']),
  policy_administrator: Object.freeze(['read', 'policy_admin']),
  scope_administrator: Object.freeze(['read', 'contribute', 'review', 'publish', 'policy_admin', 'scope_admin']),
})

function permissionsForMirrorRoles(roles: readonly string[]): string[] {
  const wanted = new Set<string>()
  for (const role of roles) {
    for (const permission of PERMISSIONS_BY_ROLE[role] ?? []) wanted.add(permission)
  }
  return [...wanted]
}

interface MirrorJoinRow {
  installation_id: string
  local_status: string
  relay_status: string
  config_version: string | number
  owner_scope_kind: string | null
  owner_scope_id: string | null
  scope_state: string | null
  authorization_epoch: string | null
  membership_id: string | null
  membership_state: string | null
  membership_revision: string | null
  roles: string[] | null
  tombstone_epoch: string | null
}

export class TargetBindingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TargetBindingError'
  }
}

export function createScopeAuthorization(pool: pg.Pool) {
  return {
    /**
     * Revalidate every binding of a cryptographically verified v2 grant.
     * Returns null when the primary binding fails validation (uniform 401)
     * or the mirror query cannot prove the grant current.
     */
    async validateV2Grant(
      facts: V2GrantFacts,
      options: { allowedSharedStates?: readonly string[] } = {},
    ): Promise<ValidatedV2Grant | null> {
      if (facts.scopeBindings.length === 0 || facts.scopeBindings.length > 16) return null
      const result = await pool.query<MirrorJoinRow>(`
        SELECT i.installation_id, i.local_status, i.relay_status, i.config_version,
               s.owner_scope_kind, s.owner_scope_id::text AS owner_scope_id,
               s.state AS scope_state, s.authorization_epoch::text AS authorization_epoch,
               m.membership_id, m.state AS membership_state,
               m.membership_revision::text AS membership_revision, m.roles,
               t.authorization_epoch::text AS tombstone_epoch
        FROM memory_installations i
        LEFT JOIN memory_owner_scopes s ON s.installation_id = i.installation_id
        LEFT JOIN memory_scope_memberships m
          ON m.installation_id = i.installation_id
         AND m.membership_id = ANY($2::uuid[])
        LEFT JOIN memory_scope_tombstones t
          ON t.owner_scope_kind = s.owner_scope_kind
         AND t.owner_scope_id = s.owner_scope_id
        WHERE i.installation_id = ANY($1::uuid[])
      `, [
        facts.scopeBindings.map(binding => binding.installation_id),
        facts.scopeBindings.map(binding => binding.membership_id).filter((id): id is string => id !== null),
      ])
      const byInstallation = new Map(result.rows.map(row => [row.installation_id, row]))

      const validated: GrantScopeBinding[] = []
      for (const binding of facts.scopeBindings) {
        const row = byInstallation.get(binding.installation_id)
        // Foreign and missing resources are indistinguishable: drop quietly.
        if (!row) continue
        if (row.local_status === 'purging' || row.local_status === 'purged'
          || row.local_status === 'integrity_error') continue
        if (row.relay_status === 'revoking' || row.relay_status === 'revoked') continue
        if (!row.owner_scope_kind || row.owner_scope_kind !== binding.owner_scope_kind
          || row.owner_scope_id !== binding.owner_scope_id) continue
        if (binding.installation_id === facts.primaryInstallationId
          && String(row.config_version) !== facts.configVersion) continue
        if (typeof row.tombstone_epoch === 'string'
          && BigInt(row.tombstone_epoch) >= BigInt(binding.authorization_epoch)) continue
        if (binding.owner_scope_kind === 'personal') {
          validated.push(binding)
          continue
        }
        // Shared scope: lifecycle, epoch, and membership fences must match.
        const allowedSharedStates = options.allowedSharedStates ?? ['active']
        if (!row.scope_state || !allowedSharedStates.includes(row.scope_state)) continue
        if (row.authorization_epoch === null
          || row.authorization_epoch !== binding.authorization_epoch) continue
        if (row.membership_id === null || row.membership_state !== 'active') continue
        if (row.membership_revision === null
          || row.membership_revision !== binding.membership_revision) continue
        const mirrorPermissions = permissionsForMirrorRoles(row.roles ?? [])
        if (!binding.permissions.every(permission => mirrorPermissions.includes(permission))) continue
        validated.push(binding)
      }

      if (!validated.some(binding => binding.installation_id === facts.primaryInstallationId)) {
        return null
      }
      return {
        primaryInstallationId: facts.primaryInstallationId,
        configVersion: facts.configVersion,
        scopeBindings: validated,
      }
    },

    hasPermission(grant: ValidatedV2Grant, installationId: string, permission: string): boolean {
      const binding = grant.scopeBindings.find(entry => entry.installation_id === installationId)
      return binding !== undefined && binding.permissions.includes(permission)
    },

    /** Mutation helper: the exact target installation must carry the permission. */
    requireTargetBinding(
      grant: ValidatedV2Grant,
      installationId: string,
      permission: string,
    ): GrantScopeBinding {
      const binding = grant.scopeBindings.find(entry => entry.installation_id === installationId)
      if (!binding) {
        throw new TargetBindingError('target installation binding not found')
      }
      if (!binding.permissions.includes(permission)) {
        throw new TargetBindingError('target installation binding lacks the required permission')
      }
      return binding
    },
  }
}

export type ScopeAuthorization = ReturnType<typeof createScopeAuthorization>
