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
  /** Signed JWT NumericDate; production guards always retain it. */
  expiresAt?: number
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
  sessionId?:string
  callerType: string
  scopeBindings: GrantScopeBinding[]
  primaryInstallationId: string
}

export interface ValidatedV2Grant extends V2GrantFacts {}

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
  membership_time_valid: boolean
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
      options: { allowedSharedStates?: readonly string[]; allowedPrimarySharedStates?: readonly string[] } = {},
    ): Promise<ValidatedV2Grant | null> {
      if (facts.scopeBindings.length === 0 || facts.scopeBindings.length > 16) return null
      try { await assertCurrentGrantClock(pool, {expiresAt:facts.expiresAt}) }
      catch(error) { if(error instanceof TargetBindingError)return null; throw error }
      const result = await pool.query<MirrorJoinRow>(`
        SELECT i.installation_id, i.local_status, i.relay_status, i.config_version,
               s.owner_scope_kind, s.owner_scope_id::text AS owner_scope_id,
               s.state AS scope_state, s.authorization_epoch::text AS authorization_epoch,
               m.membership_id, m.state AS membership_state,
               m.membership_revision::text AS membership_revision, m.roles,
               ((m.valid_from IS NULL OR m.valid_from<=clock_timestamp()) AND (m.valid_until IS NULL OR m.valid_until>clock_timestamp())) AS membership_time_valid,
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
        const allowedSharedStates = binding.installation_id===facts.primaryInstallationId ? options.allowedPrimarySharedStates??options.allowedSharedStates??['active'] : options.allowedSharedStates??['active']
        if (!row.scope_state || !allowedSharedStates.includes(row.scope_state)) continue
        if (row.authorization_epoch === null
          || row.authorization_epoch !== binding.authorization_epoch) continue
        if (row.membership_id === null || row.membership_id !== binding.membership_id
          || row.membership_state !== 'active' || row.membership_time_valid!==true) continue
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
        ...(facts.expiresAt !== undefined ? { expiresAt: facts.expiresAt } : {}),
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

/** Transaction-owned authority locks; call before candidate/asset locks. */
export async function requireCurrentScopePermission(input: {
  client: pg.PoolClient
  grant: V2GrantFacts
  targetInstallationId: string
  permission: 'read' | 'contribute' | 'review' | 'publish' | 'policy_admin' | 'scope_admin'
  allowedSharedStates?: readonly string[]
  allowedPrimarySharedStates?: readonly string[]
}): Promise<GrantScopeBinding> {
  const ids = [...new Set(input.grant.scopeBindings.map(binding => binding.installation_id))].sort()
  if (ids.length === 0 || ids.length > 16) throw new TargetBindingError('scope authority is stale')
  for (const id of ids) {
    await input.client.query(`SELECT pg_advisory_xact_lock_shared(hashtextextended('purge:installation:' || $1,0))`, [id])
  }
  await input.client.query('SELECT installation_id FROM memory_installations WHERE installation_id=ANY($1::uuid[]) ORDER BY installation_id FOR SHARE', [ids])
  await input.client.query('SELECT installation_id FROM memory_owner_scopes WHERE installation_id=ANY($1::uuid[]) ORDER BY installation_id FOR SHARE', [ids])
  const memberIds = input.grant.scopeBindings.flatMap(binding => binding.membership_id ? [binding.membership_id] : [])
  await input.client.query(`SELECT membership_id FROM memory_scope_memberships
    WHERE installation_id=ANY($1::uuid[]) AND membership_id=ANY($2::uuid[])
    ORDER BY installation_id,membership_id FOR SHARE`, [ids, memberIds])
  // Query on this exact client, never on a pool connection outside the locks.
  const queryPool = { query: input.client.query.bind(input.client) } as unknown as pg.Pool
  await assertCurrentGrantClock(input.client, input.grant,[input.targetInstallationId])
  const grant = await createScopeAuthorization(queryPool).validateV2Grant(input.grant, {allowedSharedStates:input.allowedSharedStates,allowedPrimarySharedStates:input.allowedPrimarySharedStates})
  const binding = grant?.scopeBindings.find(entry => entry.installation_id === input.targetInstallationId)
  if (!binding?.permissions.includes(input.permission)) throw new TargetBindingError('scope authority is stale')
  return binding
}

/** Time is not locked: repeat immediately before commit after any blocking work. */
export async function assertCurrentGrantClock(client: Pick<pg.PoolClient, 'query'>, grant: {
 expiresAt?: number;primaryInstallationId?:string;scopeBindings?:readonly GrantScopeBinding[]
},selectedInstallationIds:readonly string[]=[]): Promise<void> {
 if(grant.expiresAt!==undefined){
  if(!Number.isFinite(grant.expiresAt))throw new TargetBindingError('grant expired')
  const result=await client.query<{alive:boolean}>('SELECT clock_timestamp() < to_timestamp($1::double precision) AS alive',[grant.expiresAt])
  if(result.rows[0]?.alive!==true)throw new TargetBindingError('grant expired')
 }
 // An unused secondary binding may expire without denying the primary. Only
 // the primary and the service-selected targets/sources participate here.
 const ids=new Set([grant.primaryInstallationId,...selectedInstallationIds])
 const members=(grant.scopeBindings??[]).filter(b=>ids.has(b.installation_id)&&b.owner_scope_kind!=='personal'&&b.membership_id)
 await assertCurrentMembershipWindows(client,members.map(b=>({installationId:b.installation_id,membershipId:b.membership_id!})))
}

/** Roles/revisions must already be locked and validated by the caller. Time
 * keeps moving while row locks are held; repeat after the last blocking work. */
export async function assertCurrentMembershipWindows(client:Pick<pg.PoolClient,'query'>,members:readonly {installationId:string;membershipId:string}[]):Promise<void>{
 if(!members.length)return
 const rows=await client.query<{alive:boolean}>(`SELECT NOT EXISTS(
   SELECT 1 FROM jsonb_to_recordset($1::jsonb) AS wanted(installation_id UUID,membership_id UUID)
   WHERE NOT EXISTS(SELECT 1 FROM memory_scope_memberships m WHERE m.installation_id=wanted.installation_id AND m.membership_id=wanted.membership_id
     AND m.state='active' AND (m.valid_from IS NULL OR m.valid_from<=clock_timestamp()) AND (m.valid_until IS NULL OR m.valid_until>clock_timestamp()))
 ) AS alive`,[JSON.stringify(members.map(m=>({installation_id:m.installationId,membership_id:m.membershipId})))])
 if(rows.rows[0]?.alive!==true)throw new TargetBindingError('membership validity elapsed')
}

/** Serialize personal management with purge/settings writers before resource locks. */
export async function requireCurrentInstallationAuthority(client: pg.PoolClient, grant: {
  installationId: string; configVersion?: string; expiresAt?: number
}): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('purge:installation:' || $1,0))", [grant.installationId])
  const result = await client.query<{local_status:string;relay_status:string;config_version:string}>(
    'SELECT local_status,relay_status,config_version::text FROM memory_installations WHERE installation_id=$1 FOR SHARE', [grant.installationId])
  const row=result.rows[0]
  if (!row || ['purging','purged','integrity_error'].includes(row.local_status)
    || ['revoking','revoked'].includes(row.relay_status)
    || (grant.configVersion !== undefined && row.config_version !== grant.configVersion)) {
    throw new TargetBindingError('installation authority is stale')
  }
  await assertCurrentGrantClock(client, grant)
}
