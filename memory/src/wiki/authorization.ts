import type pg from 'pg'

import {assertCurrentGrantClock,requireCurrentScopePermission,TargetBindingError,type GrantScopeBinding,type ValidatedV2Grant } from '../governance/authorization.js'

const ROLE_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  reader: ['read'],
  contributor: ['read', 'contribute'],
  reviewer: ['read', 'review'],
  publisher: ['read', 'review', 'publish'],
  policy_administrator: ['read', 'policy_admin'],
  scope_administrator: ['read', 'contribute', 'review', 'publish', 'policy_admin', 'scope_admin'],
}

/** Revalidate a mutation binding inside the caller's publication transaction. */
export async function requireCurrentWikiPermission(input: {
  client: pg.PoolClient
  grant: ValidatedV2Grant
  targetInstallationId: string
  permission: 'contribute' | 'publish'
}): Promise<GrantScopeBinding> {
  const binding = input.grant.scopeBindings.find(
    candidate => candidate.installation_id === input.targetInstallationId,
  )
  if (!binding || !binding.permissions.includes(input.permission)) {
    throw new Error('wiki_forbidden')
  }
  if (binding.owner_scope_kind === 'personal'
    && input.grant.primaryInstallationId !== input.targetInstallationId) {
    throw new Error('wiki_forbidden')
  }
  // Installation purge deletes Wiki rows before updating the installation.
  // Join its lifecycle fence before either row family, so a waiting writer
  // cannot hold the installation row that the purge needs to finish.
  // Validate the primary Grant and selected target together, in the common
  // sorted lifecycle/mirror order; a live secondary cannot revive a stale primary.
  try {
    await requireCurrentScopePermission(input)
  } catch (error) {
    if (error instanceof TargetBindingError) throw new Error('wiki_forbidden')
    throw error
  }
  const scope = await input.client.query<{
    relay_status: string
    local_status: string
    config_version: string
    owner_scope_kind: string
    owner_scope_id: string
    scope_state: string
    authorization_epoch: string
    tombstone_epoch: string | null
  }>(`
    SELECT i.relay_status, i.local_status, i.config_version::text,
           s.owner_scope_kind, s.owner_scope_id::text,
           s.state AS scope_state, s.authorization_epoch::text,
           t.authorization_epoch::text AS tombstone_epoch
    FROM memory_installations i
    JOIN memory_owner_scopes s ON s.installation_id = i.installation_id
    LEFT JOIN memory_scope_tombstones t
      ON t.owner_scope_kind = s.owner_scope_kind AND t.owner_scope_id = s.owner_scope_id
    WHERE i.installation_id = $1
    FOR SHARE OF i, s
  `, [input.targetInstallationId])
  const row = scope.rows[0]
  if (!row || row.relay_status !== 'active'
    || ['purging', 'purged', 'integrity_error'].includes(row.local_status)
    || row.owner_scope_kind !== binding.owner_scope_kind
    || row.owner_scope_id !== binding.owner_scope_id
    || row.scope_state !== 'active'
    || row.authorization_epoch !== binding.authorization_epoch
    || (input.targetInstallationId === input.grant.primaryInstallationId
      && row.config_version !== input.grant.configVersion)
    || (row.tombstone_epoch !== null
      && BigInt(row.tombstone_epoch) >= BigInt(binding.authorization_epoch))) {
    throw new Error('wiki_forbidden')
  }
  if (binding.owner_scope_kind !== 'personal') {
    if (!binding.membership_id) throw new Error('wiki_forbidden')
    const membership = await input.client.query<{
      state: string
      time_valid:boolean
      membership_revision: string
      roles: string[]
    }>(`
      SELECT state, membership_revision::text, roles,
        ((valid_from IS NULL OR valid_from<=clock_timestamp()) AND (valid_until IS NULL OR valid_until>clock_timestamp())) AS time_valid
      FROM memory_scope_memberships
      WHERE installation_id = $1 AND membership_id = $2
      FOR SHARE
    `, [input.targetInstallationId, binding.membership_id])
    const member = membership.rows[0]
    const permissions = new Set(
      (member?.roles ?? []).flatMap(role => ROLE_PERMISSIONS[role] ?? []),
    )
    if (!member || member.state !== 'active' || member.time_valid!==true
      || member.membership_revision !== binding.membership_revision
      || !permissions.has(input.permission)) {
      throw new Error('wiki_forbidden')
    }
  }
  await assertCurrentWikiGrantClock(input.client,input.grant,[input.targetInstallationId])
  return binding
}

export async function assertCurrentWikiGrantClock(client: Pick<pg.PoolClient,'query'>,grant:ValidatedV2Grant,selectedInstallationIds:readonly string[]=[]):Promise<void>{
  try {await assertCurrentGrantClock(client,grant,selectedInstallationIds)}
  catch(error){if(error instanceof TargetBindingError)throw new Error('wiki_forbidden');throw error}
}

/** Call after the installation/actor fence and before any Wiki row locks.
 * Discovery grants no authority; callers re-read the Wiki under this fence.
 * Repository/snapshot purge takes the exclusive side before deleting sources. */
export async function lockWikiRepository(client:pg.PoolClient,installationId:string,wikiId:string):Promise<void>{
  const observed=await client.query<{repository_id:string}>(
    'SELECT repository_id FROM memory_wikis WHERE installation_id=$1 AND wiki_id=$2',[installationId,wikiId])
  if(observed.rows[0])await client.query(`SELECT pg_advisory_xact_lock_shared(hashtextextended('purge:repository:' || $1 || ':' || $2,0))`,[installationId,observed.rows[0].repository_id])
}
