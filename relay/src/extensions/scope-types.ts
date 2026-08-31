/**
 * ADR-0005 Phase 3 owner-scope contracts. Owner scope kinds, shared-scope
 * lifecycle states, membership states, roles, and permissions are code-owned
 * allowlists: nothing here accepts arbitrary caller-supplied strings, and
 * unknown values fail closed (ADR-P3-04: permissions, never role ordering).
 */

export type OwnerScopeKind = 'personal' | 'team' | 'organization'
export type SharedScopeKind = 'team' | 'organization'

export type SharedScopeState = 'active' | 'suspended' | 'dissolving' | 'dissolved'
export type MembershipState = 'invited' | 'active' | 'suspended' | 'revoked'

export type ScopePermission =
  | 'read'
  | 'contribute'
  | 'review'
  | 'publish'
  | 'policy_admin'
  | 'scope_admin'

export type ScopeRole =
  | 'reader'
  | 'contributor'
  | 'reviewer'
  | 'publisher'
  | 'policy_administrator'
  | 'scope_administrator'

export const OWNER_SCOPE_KINDS: readonly OwnerScopeKind[] = Object.freeze([
  'personal',
  'team',
  'organization',
])

export const SHARED_SCOPE_KINDS: readonly SharedScopeKind[] = Object.freeze([
  'team',
  'organization',
])

export const SHARED_SCOPE_STATES: readonly SharedScopeState[] = Object.freeze([
  'active',
  'suspended',
  'dissolving',
  'dissolved',
])

export const MEMBERSHIP_STATES: readonly MembershipState[] = Object.freeze([
  'invited',
  'active',
  'suspended',
  'revoked',
])

export const SCOPE_PERMISSIONS: readonly ScopePermission[] = Object.freeze([
  'read',
  'contribute',
  'review',
  'publish',
  'policy_admin',
  'scope_admin',
])

export const SCOPE_ROLES: readonly ScopeRole[] = Object.freeze([
  'reader',
  'contributor',
  'reviewer',
  'publisher',
  'policy_administrator',
  'scope_administrator',
])

/**
 * Server-owned role bundles (ADR-P3-04). Roles are the only way memberships
 * name permissions; callers can never submit a permission list directly.
 */
const ROLE_PERMISSIONS: Record<ScopeRole, readonly ScopePermission[]> = {
  reader: ['read'],
  contributor: ['read', 'contribute'],
  reviewer: ['read', 'review'],
  publisher: ['read', 'review', 'publish'],
  policy_administrator: ['read', 'policy_admin'],
  scope_administrator: [
    'read',
    'contribute',
    'review',
    'publish',
    'policy_admin',
    'scope_admin',
  ],
}

export const SCOPE_ROLE_PERMISSIONS: Readonly<Record<ScopeRole, readonly ScopePermission[]>> =
  Object.freeze(ROLE_PERMISSIONS)

export function isOwnerScopeKind(value: unknown): value is OwnerScopeKind {
  return typeof value === 'string' && (OWNER_SCOPE_KINDS as readonly string[]).includes(value)
}

export function isSharedScopeKind(value: unknown): value is SharedScopeKind {
  return typeof value === 'string' && (SHARED_SCOPE_KINDS as readonly string[]).includes(value)
}

export function isSharedScopeState(value: unknown): value is SharedScopeState {
  return typeof value === 'string' && (SHARED_SCOPE_STATES as readonly string[]).includes(value)
}

const SHARED_SCOPE_TRANSITIONS: Readonly<Record<SharedScopeState, readonly SharedScopeState[]>> = {
  active: ['suspended', 'dissolving', 'dissolved'],
  suspended: ['active', 'dissolving', 'dissolved'],
  dissolving: ['dissolved'],
  dissolved: [],
}

export function canTransitionSharedScope(from: SharedScopeState, to: SharedScopeState): boolean {
  return SHARED_SCOPE_TRANSITIONS[from].includes(to)
}

export function isMembershipState(value: unknown): value is MembershipState {
  return typeof value === 'string' && (MEMBERSHIP_STATES as readonly string[]).includes(value)
}

export function isScopePermission(value: unknown): value is ScopePermission {
  return typeof value === 'string' && (SCOPE_PERMISSIONS as readonly string[]).includes(value)
}

export function isScopeRole(value: unknown): value is ScopeRole {
  return typeof value === 'string' && (SCOPE_ROLES as readonly string[]).includes(value)
}

/**
 * Validate a caller-supplied role list against the allowlist. Returns the
 * de-duplicated, allowlist-ordered roles, or null when any value is unknown,
 * the list is empty, or the input is not a string array.
 */
export function normalizeScopeRoles(value: unknown): ScopeRole[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const seen = new Set<string>()
  for (const entry of value) {
    if (!isScopeRole(entry)) return null
    seen.add(entry)
  }
  return SCOPE_ROLES.filter((role) => seen.has(role))
}

/** Union of permissions carried by a role set; deterministic allowlist order. */
export function permissionsForRoles(roles: readonly ScopeRole[]): readonly ScopePermission[] {
  const wanted = new Set<ScopePermission>()
  for (const role of roles) {
    for (const permission of SCOPE_ROLE_PERMISSIONS[role] ?? []) wanted.add(permission)
  }
  return SCOPE_PERMISSIONS.filter((permission) => wanted.has(permission))
}
