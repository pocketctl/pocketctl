import type pg from 'pg'
import { createTransactionBoundPool } from '../api/transaction-bound-pool.js'
import { createScopeAuthorization, type V2GrantFacts } from '../governance/authorization.js'

export type GitPermission = 'read' | 'contribute' | 'review' | 'publish' | 'scope_admin'
export interface GitAuthorizationStamp {
  installationId: string
  ownerScopeKind: 'team' | 'organization'
  ownerScopeId: string
  membershipId: string
  membershipRevision: string
  authorizationEpoch: string
  configVersion: string
}
const permissions: Record<string, readonly string[]> = {
  reader: ['read'], contributor: ['read','contribute'], reviewer: ['read','review'], publisher: ['read','review','publish'],
  policy_administrator: ['read','policy_admin'], scope_administrator: ['read','contribute','review','publish','policy_admin','scope_admin'],
}

/** Call after any source Session locks, before repository/source/connection locks. */
async function lockMirrors(client: pg.PoolClient, installationIds: string[]) {
  const ids = [...new Set(installationIds)].sort()
  for (const id of ids) await client.query(`SELECT pg_advisory_xact_lock_shared(hashtextextended('purge:installation:' || $1,0))`, [id])
  await client.query('SELECT installation_id FROM memory_installations WHERE installation_id=ANY($1::uuid[]) ORDER BY installation_id FOR SHARE', [ids])
  await client.query('SELECT installation_id FROM memory_owner_scopes WHERE installation_id=ANY($1::uuid[]) ORDER BY installation_id FOR SHARE', [ids])
}

/** Internal inheritance lock discovery, not a grant extension. Parent scope
 * identity comes only from current Ledger relationships. Lock the grant scopes
 * plus this bounded dependency set together before any policy/source locks. */
export async function lockGitPolicyScopes(client:pg.PoolClient,facts:V2GrantFacts,installationId:string):Promise<string[]> {
  async function discover() {
    const rows=await client.query<{installationId:string;parentOrganizationId:string|null;parentInstallationId:string|null}>(`SELECT s.installation_id AS "installationId",
      s.parent_organization_id::text AS "parentOrganizationId",p.installation_id AS "parentInstallationId" FROM memory_owner_scopes s
      LEFT JOIN memory_owner_scopes p ON s.owner_scope_kind='team' AND p.owner_scope_kind='organization' AND p.owner_scope_id=s.parent_organization_id
      WHERE s.installation_id=$1`,[installationId])
    if(rows.rowCount!==1)throw new Error('git_policy_scope_stale')
    const row=rows.rows[0]
    if(row.parentOrganizationId&&!row.parentInstallationId)throw new Error('git_policy_scope_stale')
    return row
  }
  const observed=await discover(),ids=[...new Set([installationId,...(observed.parentInstallationId?[observed.parentInstallationId]:[])])].sort()
  await lockMirrors(client,[...facts.scopeBindings.map(b=>b.installation_id),...ids])
  const current=await discover()
  if(current.parentOrganizationId!==observed.parentOrganizationId||current.parentInstallationId!==observed.parentInstallationId)throw new Error('git_policy_scope_stale')
  const alive=await client.query(`SELECT s.installation_id FROM memory_owner_scopes s JOIN memory_installations i USING(installation_id)
    WHERE s.installation_id=ANY($1::uuid[]) AND s.state='active' AND i.relay_status='active' AND i.local_status NOT IN('purging','purged','integrity_error')
      AND NOT EXISTS(SELECT 1 FROM memory_scope_tombstones t WHERE t.owner_scope_kind=s.owner_scope_kind
        AND t.owner_scope_id=s.owner_scope_id AND t.authorization_epoch>=s.authorization_epoch)`,[ids])
  if(alive.rowCount!==ids.length)throw new Error('git_policy_scope_stale')
  return ids
}

async function currentStamp(client: pg.PoolClient, input: GitAuthorizationStamp, permission: GitPermission, code: string) {
  const result = await client.query<{
    owner_scope_kind: string; owner_scope_id: string; authorization_epoch: string; config_version: string
    membership_revision: string; roles: string[]
  }>(`SELECT s.owner_scope_kind,s.owner_scope_id::text,s.authorization_epoch::text,i.config_version::text,
      m.membership_revision::text,m.roles
    FROM memory_installations i JOIN memory_owner_scopes s USING(installation_id)
    JOIN memory_scope_memberships m USING(installation_id)
    WHERE i.installation_id=$1 AND m.membership_id=$2 AND i.relay_status='active'
      AND i.local_status NOT IN('purging','purged','integrity_error') AND s.state='active'
      AND s.owner_scope_kind IN('team','organization') AND m.state='active'
      AND (m.valid_from IS NULL OR m.valid_from<=clock_timestamp()) AND (m.valid_until IS NULL OR m.valid_until>clock_timestamp())
      AND NOT EXISTS(SELECT 1 FROM memory_scope_tombstones t WHERE t.owner_scope_kind=s.owner_scope_kind
        AND t.owner_scope_id=s.owner_scope_id AND t.authorization_epoch>=s.authorization_epoch)
    FOR SHARE OF i,s,m`, [input.installationId, input.membershipId])
  const row = result.rows[0]
  if (!row || row.owner_scope_kind !== input.ownerScopeKind || row.owner_scope_id !== input.ownerScopeId
    || row.authorization_epoch !== input.authorizationEpoch || row.membership_revision !== input.membershipRevision
    || row.config_version !== input.configVersion || !row.roles.some(role => permissions[role]?.includes(permission))) throw new Error(code)
  return input
}

/** The grant parameter is supplied by the cryptographic route guard, never parsed from a request body. */
export async function requireGitPermission(client: pg.PoolClient, facts: V2GrantFacts, installationId: string,
  permission: GitPermission): Promise<GitAuthorizationStamp> {
  await lockMirrors(client, facts.scopeBindings.map(binding => binding.installation_id))
  await client.query(`SELECT installation_id,membership_id FROM memory_scope_memberships
    WHERE installation_id=ANY($1::uuid[]) AND membership_id=ANY($2::uuid[]) ORDER BY installation_id,membership_id FOR SHARE`,
  [facts.scopeBindings.map(binding => binding.installation_id), facts.scopeBindings.map(binding => binding.membership_id).filter(Boolean)])
  const authorization = createScopeAuthorization(createTransactionBoundPool(client))
  const grant = await authorization.validateV2Grant(facts)
  const binding = grant?.scopeBindings.find(row => row.installation_id === installationId)
  if (!binding || binding.owner_scope_kind === 'personal' || !binding.membership_id || !binding.permissions.includes(permission)) throw new Error('git_forbidden')
  const config = await client.query<{ config_version: string }>('SELECT config_version::text FROM memory_installations WHERE installation_id=$1', [installationId])
  if (!config.rows[0]) throw new Error('git_forbidden')
  return currentStamp(client, { installationId, ownerScopeKind: binding.owner_scope_kind, ownerScopeId: binding.owner_scope_id,
    membershipId: binding.membership_id, membershipRevision: binding.membership_revision,
    authorizationEpoch: binding.authorization_epoch, configVersion: config.rows[0].config_version }, permission, 'git_forbidden')
}

/** Background workers keep this stamp, not a short-lived grant. Current mirror roles confer permission. */
export async function requireCurrentGitAuthorization(client: pg.PoolClient, stamp: GitAuthorizationStamp,
  permission: GitPermission): Promise<GitAuthorizationStamp> {
  await lockMirrors(client, [stamp.installationId])
  return currentStamp(client, stamp, permission, 'git_authorization_stale')
}
