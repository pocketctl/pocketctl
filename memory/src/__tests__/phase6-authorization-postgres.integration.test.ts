import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { gitDbFixture } from '../testing/phase6-db-fixture.js'
import { createGitRepository, type GitTargetRegistry } from '../git-sync/repository.js'
import { requireCurrentGitAuthorization, requireGitPermission } from '../git-sync/authorization.js'

const url = process.env.MEMORY_TEST_DATABASE_URL
const db = url && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1' ? describe : describe.skip

db('Phase 6 current Git authorization and connection CAS', () => {
  let pool: pg.Pool
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 4 })
    await assertMemoryTestDatabase(pool, url!)
    await applyMemorySchema(pool)
  }, 60_000)
  afterAll(async () => { await pool?.end() })

  function registry(f: Awaited<ReturnType<typeof gitDbFixture>>): GitTargetRegistry {
    return { resolve: async input => input.installationId === f.installationId && input.repositoryId === f.repositoryId && input.targetId === 'fixture-target'
      ? { provider: 'github', providerRepositoryId: '123', branch: 'main', credentialRef: 'server-secret-reference' } : null }
  }
  function request(f: Awaited<ReturnType<typeof gitDbFixture>>) {
    return { installationId: f.installationId, repositoryId: f.repositoryId, targetId: 'fixture-target', syncMode: 'shadow' as const, writeMode: 'off' as const }
  }

  test('scope administrator creates a fixed registered target and reads redact credential references', async () => {
    const f = await gitDbFixture(pool), repo = createGitRepository({ pool, targets: registry(f) })
    const created = await repo.createConnection(f.grant, request(f))
    expect(created).toMatchObject({ repositoryId: f.repositoryId, ownerScopeId: f.scopeId, generation: '1', providerRepositoryId: '123', targetBranch: 'main' })
    expect(JSON.stringify(created)).not.toContain('server-secret-reference')
    expect(await repo.getConnection(f.grant, { installationId: f.installationId, connectionId: created.connectionId })).toEqual(created)
    expect(await repo.listConnections(f.grant, f.installationId)).toEqual([created])
    const saved = await pool.query('SELECT credential_ref FROM memory_git_connections WHERE connection_id=$1', [created.connectionId])
    expect(saved.rows[0].credential_ref).toBe('server-secret-reference')
  })

  test.each(['reader', 'contributor'])('%s cannot register or modify connections or map actors', async role => {
    const f = await gitDbFixture(pool), repo = createGitRepository({ pool, targets: registry(f) })
    const created = await repo.createConnection(f.grant, request(f))
    await pool.query('UPDATE memory_scope_memberships SET roles=$2 WHERE installation_id=$1', [f.installationId, [role]])
    f.grant.scopeBindings[0]!.permissions = role === 'reader' ? ['read'] : ['read','contribute']
    expect((await repo.listConnections(f.grant, f.installationId))).toHaveLength(1)
    await expect(repo.createConnection(f.grant, request(f))).rejects.toThrow(/git_forbidden/)
    await expect(repo.updateConnection(f.grant, { installationId: f.installationId, connectionId: created.connectionId, expectedGeneration: '1', syncMode: 'off', writeMode: 'off', state: 'disabled' })).rejects.toThrow(/git_forbidden/)
    await expect(repo.mapActor(f.grant, { installationId: f.installationId, connectionId: created.connectionId, expectedGeneration: '1', providerActorId: '456', membershipId: f.membershipId })).rejects.toThrow(/git_forbidden/)
  })

  test.each(['membership_revision', 'epoch', 'roles', 'suspended', 'expired', 'personal'])('rejects stale or ineligible current mirror: %s', async change => {
    const f = await gitDbFixture(pool), repo = createGitRepository({ pool, targets: registry(f) })
    if (change === 'membership_revision') await pool.query('UPDATE memory_scope_memberships SET membership_revision=2 WHERE installation_id=$1', [f.installationId])
    if (change === 'epoch') await pool.query('UPDATE memory_owner_scopes SET authorization_epoch=2 WHERE installation_id=$1', [f.installationId])
    if (change === 'roles') await pool.query("UPDATE memory_scope_memberships SET roles=ARRAY['reader'] WHERE installation_id=$1", [f.installationId])
    if (change === 'suspended') await pool.query("UPDATE memory_owner_scopes SET state='suspended' WHERE installation_id=$1", [f.installationId])
    if (change === 'expired') await pool.query("UPDATE memory_scope_memberships SET valid_until=NOW()-INTERVAL '1 second' WHERE installation_id=$1", [f.installationId])
    if (change === 'personal') {
      await pool.query("UPDATE memory_owner_scopes SET owner_scope_kind='personal' WHERE installation_id=$1", [f.installationId])
      f.grant.scopeBindings[0]!.owner_scope_kind = 'personal'
    }
    await expect(repo.createConnection(f.grant, request(f))).rejects.toThrow(/git_forbidden/)
    expect((await pool.query('SELECT 1 FROM memory_git_connections WHERE installation_id=$1', [f.installationId])).rowCount).toBe(0)
  })

  test('request fields cannot forge permission, credentials or targets', async () => {
    const f = await gitDbFixture(pool), other = await gitDbFixture(pool), repo = createGitRepository({ pool, targets: registry(f) })
    for (const extra of [{ permission: true }, { credentialRef: 'attacker' }, { url: 'https://attacker.invalid/repo' }, { ownerScopeId: other.scopeId }]) {
      await expect(repo.createConnection(f.grant, { ...request(f), ...extra })).rejects.toThrow(/git_invalid_request/)
    }
    await expect(repo.createConnection(f.grant, { ...request(f), targetId: 'unknown' })).rejects.toThrow(/git_target_unregistered/)
    await expect(repo.createConnection(f.grant, { ...request(f), installationId: other.installationId })).rejects.toThrow(/git_forbidden/)
    await expect(repo.createConnection(f.grant, { ...request(f), repositoryId: other.repositoryId })).rejects.toThrow(/git_not_found/)
  })

  test('generation CAS admits one writer and rejects stale clients without losing BIGINT precision', async () => {
    const f = await gitDbFixture(pool), repo = createGitRepository({ pool, targets: registry(f) })
    const created = await repo.createConnection(f.grant, request(f))
    await pool.query('UPDATE memory_git_connections SET generation=9007199254740993 WHERE connection_id=$1', [created.connectionId])
    const update = { installationId: f.installationId, connectionId: created.connectionId, expectedGeneration: '9007199254740993', syncMode: 'off' as const, writeMode: 'off' as const, state: 'disabled' as const }
    const results = await Promise.allSettled([repo.updateConnection(f.grant, update), repo.updateConnection(f.grant, update)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(await repo.getConnection(f.grant, { installationId: f.installationId, connectionId: created.connectionId })).toMatchObject({ generation: '9007199254740994', state: 'disabled' })
    await expect(repo.updateConnection(f.grant, update)).rejects.toThrow(/git_generation_conflict/)
  })

  test('actor mapping uses current membership revision and advances connection generation', async () => {
    const f = await gitDbFixture(pool), repo = createGitRepository({ pool, targets: registry(f) })
    const created = await repo.createConnection(f.grant, request(f))
    const member = randomUUID()
    await pool.query("INSERT INTO memory_scope_memberships(installation_id,membership_id,roles,membership_revision) VALUES($1,$2,ARRAY['contributor'],7)", [f.installationId, member])
    const updated = await repo.mapActor(f.grant, { installationId: f.installationId, connectionId: created.connectionId, expectedGeneration: '1', providerActorId: 'stable-account-123', membershipId: member })
    expect(updated.generation).toBe('2')
    expect((await pool.query('SELECT membership_revision::text FROM memory_git_actor_mappings WHERE connection_id=$1', [created.connectionId])).rows[0].membership_revision).toBe('7')
  })

  test('background stamps revalidate current roles and epoch without retaining a Relay grant', async () => {
    const f = await gitDbFixture(pool), client = await pool.connect()
    try {
      await client.query('BEGIN')
      const stamp = await requireGitPermission(client, f.grant, f.installationId, 'contribute')
      expect(Object.keys(stamp).sort()).toEqual(['authorizationEpoch','configVersion','installationId','membershipId','membershipRevision','ownerScopeId','ownerScopeKind'])
      await client.query('COMMIT')
      await client.query('BEGIN')
      await expect(requireCurrentGitAuthorization(client, stamp, 'contribute')).resolves.toEqual(stamp)
      await client.query('COMMIT')
      await pool.query('UPDATE memory_owner_scopes SET authorization_epoch=2 WHERE installation_id=$1', [f.installationId])
      await client.query('BEGIN')
      await expect(requireCurrentGitAuthorization(client, stamp, 'contribute')).rejects.toThrow(/git_authorization_stale/)
      await client.query('ROLLBACK')
    } finally { client.release() }
  })
  test('final authorization fence rejects membership that expires while the transaction is open', async () => {
    const f=await gitDbFixture(pool),client=await pool.connect()
    try {
      await pool.query("UPDATE memory_scope_memberships SET valid_until=clock_timestamp()+INTERVAL '500 milliseconds' WHERE membership_id=$1",[f.membershipId])
      await client.query('BEGIN')
      const stamp=await requireGitPermission(client,f.grant,f.installationId,'contribute')
      await client.query('SELECT pg_sleep(0.6)')
      const time=await client.query('SELECT valid_until>NOW() AS valid_at_start,valid_until<clock_timestamp() AS expired_now FROM memory_scope_memberships WHERE membership_id=$1',[f.membershipId])
      expect(time.rows[0]).toEqual({valid_at_start:true,expired_now:true})
      await expect(requireCurrentGitAuthorization(client,stamp,'contribute')).rejects.toThrow('git_authorization_stale')
    } finally {await client.query('ROLLBACK');client.release()}
  })
})
