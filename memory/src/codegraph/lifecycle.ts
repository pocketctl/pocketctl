import type pg from 'pg'
import type { VerifiedMemoryGrant } from '../auth/grant-guard.js'
import {
  assertCurrentGrantClock,
  requireCurrentInstallationAuthority,
  requireCurrentScopePermission,
  TargetBindingError,
  type ValidatedV2Grant,
} from '../governance/authorization.js'

export type SourceMutationGrant = VerifiedMemoryGrant | ValidatedV2Grant

export class SourceLifecycleFenceError extends Error {
  constructor(readonly code: 'not_found' | 'state_conflict' | 'repository_tombstoned'
    | 'snapshot_tombstoned' | 'forbidden' | 'source_changed') {
    super(code)
  }
}

/** This floor precedes resource/receipt locks, including for trusted workers. */
export async function lockSourceInstallation(client: pg.PoolClient, installationId: string): Promise<void> {
  await client.query(`
    SELECT pg_advisory_xact_lock_shared(hashtextextended('purge:installation:' || $1, 0))
  `, [installationId])
}

export async function requireSourceAuthority(
  client: pg.PoolClient,
  input: { installationId: string; grant?: SourceMutationGrant },
  permission: 'read' | 'contribute' | 'publish' = 'contribute',
): Promise<void> {
  if (input.grant) {
    if ('scopeBindings' in input.grant) {
      const binding = await requireCurrentScopePermission({
        client, grant: input.grant, targetInstallationId: input.installationId, permission,
      })
      if (binding.owner_scope_kind === 'personal'
        && input.grant.primaryInstallationId !== input.installationId) {
        throw new TargetBindingError('personal source authority is stale')
      }
    } else {
      if (input.grant.installationId !== input.installationId) {
        throw new TargetBindingError('source authority is stale')
      }
      await requireCurrentInstallationAuthority(client, input.grant)
    }
    return
  }
  await lockSourceInstallation(client, input.installationId)
  const result = await client.query<{ local_status: string; relay_status: string }>(`
    SELECT local_status, relay_status FROM memory_installations
    WHERE installation_id = $1 FOR SHARE
  `, [input.installationId])
  const row = result.rows[0]
  if (!row || ['purging', 'purged', 'integrity_error'].includes(row.local_status)
    || ['revoking', 'revoked'].includes(row.relay_status)) {
    throw new SourceLifecycleFenceError('forbidden')
  }
}

export async function assertSourceGrantClock(
  client: pg.PoolClient,
  input: { installationId: string; grant?: SourceMutationGrant },
): Promise<void> {
  if (input.grant) await assertCurrentGrantClock(client, input.grant, [input.installationId])
}

export async function lockSourceRepository(
  client: pg.PoolClient, installationId: string, repositoryId: string, exclusive = false,
): Promise<void> {
  await client.query(`
    SELECT ${exclusive ? 'pg_advisory_xact_lock' : 'pg_advisory_xact_lock_shared'}(
      hashtextextended('purge:repository:' || $1 || ':' || $2, 0))
  `, [installationId, repositoryId])
}

export async function lockSourceSnapshotId(
  client: pg.PoolClient, installationId: string, snapshotId: string,
): Promise<void> {
  await client.query(`
    SELECT pg_advisory_xact_lock(hashtextextended('purge:snapshot:' || $1 || ':' || $2, 0))
  `, [installationId, snapshotId])
}

/** Discovery grants no authority. Re-read only after repository/snapshot fences. */
export async function lockSourceSnapshot(
  client: pg.PoolClient,
  input: { installationId: string; snapshotId: string },
  exclusiveRepository = false,
): Promise<string> {
  const observed = await client.query<{ repository_id: string }>(`
    SELECT repository_id FROM memory_source_snapshots
    WHERE installation_id = $1 AND snapshot_id = $2
  `, [input.installationId, input.snapshotId])
  const repositoryId = observed.rows[0]?.repository_id
  if (repositoryId) {
    await lockSourceRepository(client, input.installationId, repositoryId, exclusiveRepository)
  }
  await lockSourceSnapshotId(client, input.installationId, input.snapshotId)
  const current = await client.query<{ repository_id: string }>(`
    SELECT repository_id FROM memory_source_snapshots
    WHERE installation_id = $1 AND snapshot_id = $2
  `, [input.installationId, input.snapshotId])
  if (!current.rows[0]) {
    const tombstone = await client.query(`
      SELECT 1 FROM memory_source_snapshot_tombstones
      WHERE installation_id = $1 AND snapshot_id = $2
    `, [input.installationId, input.snapshotId])
    throw new SourceLifecycleFenceError(tombstone.rows[0] ? 'snapshot_tombstoned' : 'not_found')
  }
  if (current.rows[0].repository_id !== repositoryId) {
    throw new SourceLifecycleFenceError('source_changed')
  }
  const tombstone = await client.query<{ kind: string }>(`
    SELECT 'repository' AS kind FROM memory_repository_tombstones
    WHERE installation_id = $1 AND repository_id = $2
    UNION ALL
    SELECT 'snapshot' AS kind FROM memory_source_snapshot_tombstones
    WHERE installation_id = $1 AND snapshot_id = $3
  `, [input.installationId, repositoryId, input.snapshotId])
  if (tombstone.rows[0]) {
    throw new SourceLifecycleFenceError(tombstone.rows[0].kind === 'repository'
      ? 'repository_tombstoned' : 'snapshot_tombstoned')
  }
  return repositoryId!
}
