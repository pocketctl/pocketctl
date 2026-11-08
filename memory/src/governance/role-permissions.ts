const PERMISSIONS_BY_ROLE: Readonly<Record<string, readonly string[]>> = Object.freeze({
  reader: Object.freeze(['read']),
  contributor: Object.freeze(['read', 'contribute']),
  reviewer: Object.freeze(['read', 'review']),
  publisher: Object.freeze(['read', 'review', 'publish']),
  policy_administrator: Object.freeze(['read', 'policy_admin']),
  scope_administrator: Object.freeze(['read', 'contribute', 'review', 'publish', 'policy_admin', 'scope_admin']),
})

export function permissionsForMirrorRoles(roles: readonly string[]): string[] {
  const wanted = new Set<string>()
  for (const role of roles) {
    for (const permission of PERMISSIONS_BY_ROLE[role] ?? []) wanted.add(permission)
  }
  return [...wanted]
}

