import pg from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { applyMemorySchema, MEMORY_MIGRATIONS } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { randomUUID } from 'node:crypto'
import { gitDbFixture, gitClaimFixture, gitWikiFixture, insertGitConnection } from '../testing/phase6-db-fixture.js'
import { bindGitAsset, createGitRepository, insertGitSnapshot, insertGitRevisionLink } from '../git-sync/repository.js'
import { phase6Snapshot } from '../testing/phase6-fixtures.js'
import { assetContentHash } from '../git-sync/codec.js'
import { createSkillGovernanceFixture } from '../testing/skill-fixture.js'
import { loadSkillConfig } from '../skills/config.js'
import { createSkillReviewService } from '../skills/review-service.js'

const url = process.env.MEMORY_TEST_DATABASE_URL
const db = url && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1' ? describe : describe.skip

db('Phase 6 Git ledger schema', () => {
  let pool: pg.Pool
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 4 })
    await assertMemoryTestDatabase(pool, url!)
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
    const client = await pool.connect()
    try {
      for (const migration of MEMORY_MIGRATIONS.filter(m => m.version <= 38)) {
        await client.query('BEGIN')
        for (const statement of migration.statements) await client.query(statement)
        await client.query('INSERT INTO memory_schema_migrations(version) VALUES ($1)', [migration.version])
        await client.query('COMMIT')
      }
    } finally { client.release() }
  }, 60_000)
  afterAll(async () => { await pool?.end() })

  test('upgrades v38 twice and installs the constrained Git ledger and queue', async () => {
    const existing = await gitDbFixture(pool)
    const source = await gitClaimFixture(pool, existing)
    await applyMemorySchema(pool)
    await applyMemorySchema(pool)
    expect((await pool.query('SELECT statement FROM knowledge_versions WHERE version_id=$1', [source.versionId])).rows[0].statement).toBe('Synthetic statement')
    const versions = await pool.query('SELECT version FROM memory_schema_migrations ORDER BY version')
    expect(versions.rows.map(row => row.version)).toEqual(Array.from({ length: 46 }, (_, i) => i + 1))
    const tables = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'memory_git_%'")
    expect(tables.rows.map(row => row.tablename).sort()).toEqual([
      'memory_git_connections', 'memory_git_actor_mappings', 'memory_git_asset_bindings',
      'memory_git_snapshots', 'memory_git_snapshot_assets', 'memory_git_revision_links',
      'memory_git_runs', 'memory_git_inbox', 'memory_git_outbox', 'memory_git_import_proposals',
      'memory_git_conflicts', 'memory_git_review_decisions', 'memory_git_audit_events',
      'memory_git_attestation_keys','memory_git_snapshot_keys','memory_git_sync_principals',
      'memory_git_run_receipts','memory_git_merge_receipts','memory_git_request_reservations',
      'memory_git_outbox_steps','memory_git_projection_invalidations',
      'memory_git_proposal_runs',
      'memory_git_original_authors','memory_git_resolution_authors','memory_git_governed_revisions','memory_git_revision_evidence',
      'memory_git_revision_reviews','memory_git_import_outcomes','memory_git_confirmed_bases','memory_git_claim_authority','memory_git_claim_authority_decisions',
      'memory_git_tombstones','memory_git_lifecycle_epochs','memory_git_proposal_identities','memory_git_retained_outcomes','memory_git_remote_cleanup','memory_git_retained_steps','memory_git_snapshot_sources',
    ].sort())
    // Durable acceptance of the three job types is exercised by the inbox suite.
  })

  async function binding(f: Awaited<ReturnType<typeof gitDbFixture>>, connectionId: string, claimId: string,
    overrides: { kind?: string; path?: string; wikiId?: string; repositoryId?: string } = {}) {
    const bindingId = randomUUID()
    await pool.query(`INSERT INTO memory_git_asset_bindings(binding_id,installation_id,connection_id,repository_id,kind,claim_id,wiki_id,path)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [bindingId, f.installationId, connectionId, overrides.repositoryId ?? f.repositoryId,
      overrides.kind ?? 'claim', claimId, overrides.wikiId ?? null, overrides.path ?? `.pocketctl/knowledge/claims/${claimId}.yaml`])
    return bindingId
  }

  test('rejects cross-tenant/repository connections and duplicate active connections', async () => {
    const a = await gitDbFixture(pool), b = await gitDbFixture(pool)
    await expect(insertGitConnection(pool, { ...a, repositoryId: b.repositoryId })).rejects.toMatchObject({ code: '23503' })
    const connectionId = await insertGitConnection(pool, a)
    await expect(insertGitConnection(pool, a)).rejects.toMatchObject({ code: '23505' })
    await pool.query("UPDATE memory_git_connections SET state='disabled' WHERE connection_id=$1", [connectionId])
    await expect(insertGitConnection(pool, a)).resolves.toBeDefined()
  })

  test('requires exactly one typed ID, matching kind, tenant, repository, unique path and unique runtime asset', async () => {
    const a = await gitDbFixture(pool), b = await gitDbFixture(pool), connectionId = await insertGitConnection(pool, a)
    const first = await gitClaimFixture(pool, a), second = await gitClaimFixture(pool, a), foreign = await gitClaimFixture(pool, b)
    await expect(pool.query(`INSERT INTO memory_git_asset_bindings(binding_id,installation_id,connection_id,repository_id,kind,path)
      VALUES($1,$2,$3,$4,'claim','.pocketctl/knowledge/claims/missing.yaml')`, [randomUUID(), a.installationId, connectionId, a.repositoryId])).rejects.toMatchObject({ code: '23514' })
    await expect(binding(a, connectionId, first.claimId, { wikiId: randomUUID() })).rejects.toMatchObject({ code: '23514' })
    await expect(binding(a, connectionId, first.claimId, { kind: 'wiki' })).rejects.toMatchObject({ code: '23514' })
    await expect(binding(a, connectionId, foreign.claimId)).rejects.toThrow()
    await expect(binding(a, connectionId, first.claimId, { repositoryId: b.repositoryId })).rejects.toThrow()
    await binding(a, connectionId, first.claimId)
    await expect(binding(a, connectionId, first.claimId, { path: '.pocketctl/knowledge/claims/other.yaml' })).rejects.toMatchObject({ code: '23505' })
    await expect(binding(a, connectionId, second.claimId, { path: `.pocketctl/knowledge/claims/${first.claimId}.yaml` })).rejects.toMatchObject({ code: '23505' })
    await expect(binding(a, connectionId, second.claimId, { path: `.pocketctl/knowledge/claims/${first.claimId.toUpperCase()}.yaml` })).rejects.toMatchObject({ code: '23505' })
    await expect(binding(a, connectionId, second.claimId, { path: '../escape.yaml' })).rejects.toThrow()
    // Rule and Claim share one real Claim identity, and cannot bind it twice.
    const rule = await gitClaimFixture(pool, a, { claimType: 'test_invariant' })
    await binding(a, connectionId, rule.claimId, { kind: 'rule', path: `.pocketctl/knowledge/rules/${rule.claimId}.yaml` })
    await expect(binding(a, connectionId, rule.claimId)).rejects.toMatchObject({ code: '23505' })
  })

  test('accepts shared Claim repository-scope fallback and rejects another same-tenant repository', async () => {
    const f = await gitDbFixture(pool), connectionId = await insertGitConnection(pool, f)
    const good = await gitClaimFixture(pool, f, { noVersionRepository: true, scopeKey: `repo-${f.repositoryId}` })
    await expect(binding(f, connectionId, good.claimId)).resolves.toBeDefined()
    const bad = await gitClaimFixture(pool, f, { noVersionRepository: true, scopeKey: randomUUID() })
    await expect(binding(f, connectionId, bad.claimId)).rejects.toThrow(/git_asset_repository_mismatch/)
  })

  async function snapshot(f: Awaited<ReturnType<typeof gitDbFixture>>, connectionId: string, bindingId: string,
    claimId: string, versionId: string, options: { snapshotInstallationId?: string; assetConnectionId?: string } = {}) {
    const exportId = randomUUID(), client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`INSERT INTO memory_git_snapshots(export_id,installation_id,connection_id,generation,base_commit,source_digest,manifest_hash,attestation,asset_count)
        VALUES($1,$2,$3,1,$4,$5,$5,$6,1)`, [exportId, options.snapshotInstallationId ?? f.installationId, connectionId, 'a'.repeat(40), 'b'.repeat(64), Buffer.from('signed-fixture')])
      await client.query(`INSERT INTO memory_git_snapshot_assets(installation_id,connection_id,export_id,binding_id,kind,claim_id,claim_version_id,
        path,base_revision,source_digest,content_hash,file_hash,base_document,field_map)
        VALUES($1,$2,$3,$4,'claim',$5,$6,$7,1,$8,$8,$8,$9,$10)`,
      [f.installationId, options.assetConnectionId ?? connectionId, exportId, bindingId, claimId, versionId,
        `.pocketctl/knowledge/claims/${claimId}.yaml`, 'b'.repeat(64), { editable: { statement: 'Synthetic' } }, { statement: 'editable' }])
      await client.query('COMMIT')
      return exportId
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }

  test('binds snapshot versions to the exact asset, tenant and connection', async () => {
    const f = await gitDbFixture(pool), other = await gitDbFixture(pool), connectionId = await insertGitConnection(pool, f)
    const a = await gitClaimFixture(pool, f), b = await gitClaimFixture(pool, f), foreign = await gitClaimFixture(pool, other)
    const bindingId = await binding(f, connectionId, a.claimId)
    await expect(snapshot(f, connectionId, bindingId, a.claimId, b.versionId)).rejects.toMatchObject({ code: '23503' })
    await expect(snapshot(f, connectionId, bindingId, a.claimId, foreign.versionId)).rejects.toMatchObject({ code: '23503' })
    await expect(snapshot(f, connectionId, bindingId, a.claimId, a.versionId, { snapshotInstallationId: other.installationId })).rejects.toMatchObject({ code: '23503' })
    await expect(snapshot(f, connectionId, bindingId, a.claimId, a.versionId, { assetConnectionId: await insertGitConnection(pool, other) })).rejects.toMatchObject({ code: '23503' })
    await expect(snapshot(f, connectionId, bindingId, a.claimId, a.versionId)).resolves.toBeDefined()
  })

  test('freezes snapshots and removes all dependent content when a typed source is deleted; audit survives', async () => {
    const f = await gitDbFixture(pool), connectionId = await insertGitConnection(pool, f), a = await gitClaimFixture(pool, f)
    const bindingId = await binding(f, connectionId, a.claimId), exportId = await snapshot(f, connectionId, bindingId, a.claimId, a.versionId)
    await expect(pool.query("UPDATE memory_git_snapshots SET base_commit=$2 WHERE export_id=$1", [exportId, 'c'.repeat(40)])).rejects.toThrow(/git_snapshot_immutable/)
    await expect(pool.query("UPDATE memory_git_snapshot_assets SET base_document='{}' WHERE export_id=$1", [exportId])).rejects.toThrow(/git_snapshot_immutable/)
    await pool.query(`INSERT INTO memory_git_audit_events(event_id,installation_id,connection_id,export_id,action,outcome,reason_code)
      VALUES($1,$2,$3,$4,'snapshot','allowed','ok')`, [randomUUID(), f.installationId, connectionId, exportId])
    await pool.query('DELETE FROM knowledge_claims WHERE claim_id=$1', [a.claimId])
    expect((await pool.query('SELECT 1 FROM memory_git_snapshots WHERE export_id=$1', [exportId])).rowCount).toBe(0)
    expect((await pool.query("SELECT action,outcome FROM memory_git_audit_events WHERE export_id=$1 ORDER BY action", [exportId])).rows).toEqual([
      {action:'invalidate',outcome:'invalidated'},{action:'snapshot',outcome:'allowed'}])
  })

  test('stores portable snapshots with exact source revision and generation; equal content never overwrites the baseline', async () => {
    const f = await gitDbFixture(pool), connectionId = await insertGitConnection(pool, f), a = await gitClaimFixture(pool, f)
    const asset = phase6Snapshot().asset
    asset.key.id = a.claimId; asset.connectionId = connectionId; asset.exportId = randomUUID(); asset.baseVersionId = a.versionId; asset.baseRevision = '1'
    asset.path = `.pocketctl/knowledge/claims/${a.claimId}.yaml`
    asset.immutable.installationId = f.installationId; asset.immutable.ownerScopeId = f.scopeId
    // Give this codec-valid portable fixture a real same-tenant source. The
    // migration44 Evidence FK must not be relaxed for synthetic placeholder IDs.
    const episodeId=randomUUID(),evidenceId=randomUUID()
    await pool.query(`INSERT INTO work_episodes(episode_id,installation_id,session_id,turn_id,compiler_version,state)
      VALUES($1,$2,'schema-fixture',$3,'fixture','ready')`,[episodeId,f.installationId,episodeId])
    await pool.query(`INSERT INTO knowledge_evidence(evidence_id,installation_id,version_id,episode_id,evidence_kind,excerpt,excerpt_hash,occurred_at,ordinal)
      VALUES($1,$2,$3,$4,'episode','Fixture',decode($5,'hex'),NOW(),0)`,[evidenceId,f.installationId,a.versionId,episodeId,'a'.repeat(64)])
    asset.immutable.evidence[0]={...asset.immutable.evidence[0]!,evidenceId,versionId:a.versionId}
    if('evidence' in asset.serverOnly)asset.serverOnly.evidence[0]={...asset.serverOnly.evidence[0]!,evidenceId,episodeId}
    const input = { installationId: f.installationId, connectionId, exportId: asset.exportId, generation: '1', baseCommit: 'a'.repeat(40),
      sourceDigest: 'b'.repeat(64), manifestHash: 'c'.repeat(64), attestation: Buffer.from('signed-fixture'),
      assets: [{ asset, contentHash: assetContentHash(asset), fileHash: 'd'.repeat(64), fieldMap: { statement: 'editable' } }] }
    async function store(value: typeof input) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await bindGitAsset(client, { installationId: f.installationId, connectionId, repositoryId: f.repositoryId, key: asset.key, path: asset.path })
        await insertGitSnapshot(client, value)
        await client.query('COMMIT')
      } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    }
    await store(input)
    const repo = createGitRepository({ pool, targets: { resolve: async () => null } })
    const saved = await repo.getSnapshot(f.grant, { installationId: f.installationId, connectionId, exportId: asset.exportId })
    expect(saved).toMatchObject({ generation: '1', assets: [{ asset, contentHash: input.assets[0]!.contentHash }] })
    const secondId = randomUUID()
    await store({ ...input, exportId: secondId, assets: [{ ...input.assets[0]!, asset: { ...asset, exportId: secondId, sourceDigest: 'e'.repeat(64) } }] })
    expect((await pool.query('SELECT 1 FROM memory_git_snapshots WHERE connection_id=$1', [connectionId])).rowCount).toBe(2)
    await expect(store({ ...input, exportId: randomUUID(), generation: '2' })).rejects.toThrow(/git_generation_conflict/)
    const staleExportId = randomUUID()
    await expect(store({ ...input, exportId: staleExportId, assets: [{ ...input.assets[0]!, asset: { ...asset, exportId: staleExportId, baseRevision: '2' } }] })).rejects.toThrow(/^git_source_stale$/)
  })

  test('review decisions cannot be counted against another proposal revision or hash', async () => {
    const f = await gitDbFixture(pool), connectionId = await insertGitConnection(pool, f), a = await gitClaimFixture(pool, f)
    const bindingId = await binding(f, connectionId, a.claimId), exportId = await snapshot(f, connectionId, bindingId, a.claimId, a.versionId), proposalId = randomUUID()
    await pool.query(`INSERT INTO memory_git_import_proposals(proposal_id,installation_id,connection_id,export_id,generation,base_revision,
      base_hash,local_hash,proposed_hash,policy_hash,proposed_document,authorization_epoch,head_commit)
      VALUES($1,$2,$3,$4,1,1,$5,$5,$5,$5,'{}',1,$6)`, [proposalId, f.installationId, connectionId, exportId, 'a'.repeat(64), 'b'.repeat(40)])
    const review = (revision: string, hash: string) => pool.query(`INSERT INTO memory_git_review_decisions(decision_id,installation_id,proposal_id,
      proposal_revision,base_revision,proposed_hash,policy_hash,membership_id,membership_revision,authorization_epoch,decision)
      VALUES($1,$2,$3,$4,1,$5,$6,$7,1,1,'approve')`, [randomUUID(), f.installationId, proposalId, revision, hash, 'a'.repeat(64), f.membershipId])
    await expect(review('2', 'a'.repeat(64))).rejects.toMatchObject({ code: '23503' })
    await expect(review('1', 'b'.repeat(64))).rejects.toMatchObject({ code: '23503' })
    await review('1', 'a'.repeat(64))
    await pool.query('UPDATE memory_git_import_proposals SET revision=2,proposed_hash=$2 WHERE proposal_id=$1', [proposalId, 'b'.repeat(64)])
    expect((await pool.query('SELECT 1 FROM memory_git_review_decisions WHERE proposal_id=$1', [proposalId])).rowCount).toBe(0)
  })

  test('revision links use the snapshot asset version, preserve tenant identity and reject duplicates', async () => {
    const f = await gitDbFixture(pool), connectionId = await insertGitConnection(pool, f), a = await gitClaimFixture(pool, f), b = await gitClaimFixture(pool, f)
    const bindingId = await binding(f, connectionId, a.claimId), exportId = await snapshot(f, connectionId, bindingId, a.claimId, a.versionId)
    const client = await pool.connect()
    try {
      const input = { installationId: f.installationId, connectionId, bindingId, key: { kind: 'claim' as const, id: a.claimId },
        versionId: a.versionId, path: `.pocketctl/knowledge/claims/${a.claimId}.yaml`, commitSha: 'a'.repeat(40), treeSha: 'b'.repeat(40), direction: 'export' as const, exportId }
      await expect(insertGitRevisionLink(client, { ...input, versionId: b.versionId })).rejects.toThrow()
      await expect(insertGitRevisionLink(client, { ...input, path: '.pocketctl/knowledge/claims/wrong.yaml' })).rejects.toMatchObject({ code: '23503' })
      await expect(insertGitRevisionLink(client, input)).resolves.toBeDefined()
      await expect(insertGitRevisionLink(client, input)).rejects.toMatchObject({ code: '23505' })
    } finally { client.release() }
  })

  test.each(['wiki','skill'] as const)('%s bindings and snapshot versions use real typed foreign keys', async kind => {
    const context = { globalMode: 'enabled' as const, sharedMode: 'shadow' as const, config: loadSkillConfig({ MEMORY_SKILL_MODE: 'shadow' }) }
    async function source() {
      if (kind === 'wiki') {
        const f = await gitDbFixture(pool), wiki = await gitWikiFixture(pool, f)
        return { f, assetId: wiki.wikiId, versionId: wiki.versionId }
      }
      const skill = await createSkillGovernanceFixture(pool, context, 'team')
      const draft = await createSkillReviewService({ pool, context }).execute(skill.author, { action: 'draft', candidateId: skill.candidateId, expectedRevision: 0 })
      return { f: { installationId: skill.installationId, repositoryId: skill.repositoryId, scopeId: skill.installationId,
        membershipId: skill.author.membershipId!, grant: skill.author.grant }, assetId: draft.skillId, versionId: draft.versionId }
    }
    const a = await source(), foreign = await source(), connectionId = await insertGitConnection(pool, a.f)
    const client = await pool.connect()
    const path = `.pocketctl/knowledge/${kind}s/${a.assetId}.yaml`
    try {
      const bindingId = await bindGitAsset(client, { installationId: a.f.installationId, connectionId, repositoryId: a.f.repositoryId, key: { kind, id: a.assetId }, path })
      async function insert(versionId: string) {
        const exportId = randomUUID()
        await client.query('BEGIN')
        try {
          await client.query(`INSERT INTO memory_git_snapshots(export_id,installation_id,connection_id,generation,base_commit,source_digest,manifest_hash,attestation,asset_count)
            VALUES($1,$2,$3,1,$4,$5,$5,$6,1)`, [exportId, a.f.installationId, connectionId, 'a'.repeat(40), 'b'.repeat(64), Buffer.from('fixture')])
          const assetIds = kind === 'wiki' ? [a.assetId, null, versionId, null] : [null, a.assetId, null, versionId]
          await client.query(`INSERT INTO memory_git_snapshot_assets(installation_id,connection_id,export_id,binding_id,kind,wiki_id,skill_id,wiki_version_id,skill_version_id,
            path,base_revision,source_digest,content_hash,file_hash,base_document,field_map)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11,$11,$11,'{}','{}')`,
          [a.f.installationId, connectionId, exportId, bindingId, kind, ...assetIds, path, 'b'.repeat(64)])
          await client.query('COMMIT')
          return exportId
        } catch (error) { await client.query('ROLLBACK'); throw error }
      }
      await expect(insert(foreign.versionId)).rejects.toMatchObject({ code: '23503' })
      const exportId = await insert(a.versionId)
      await client.query(kind === 'wiki' ? 'DELETE FROM memory_wikis WHERE wiki_id=$1' : 'DELETE FROM memory_skills WHERE skill_id=$1', [a.assetId])
      expect((await client.query('SELECT 1 FROM memory_git_snapshots WHERE export_id=$1', [exportId])).rowCount).toBe(0)
    } finally { client.release() }
  })

  test('snapshot insertion must be complete in one transaction and rejects later extensions', async () => {
    const f = await gitDbFixture(pool), connectionId = await insertGitConnection(pool, f), a = await gitClaimFixture(pool, f)
    const bindingId = await binding(f, connectionId, a.claimId), exportId = await snapshot(f, connectionId, bindingId, a.claimId, a.versionId)
    await expect(pool.query(`INSERT INTO memory_git_snapshots(export_id,installation_id,connection_id,generation,base_commit,source_digest,manifest_hash,attestation,asset_count)
      VALUES($1,$2,$3,1,$4,$5,$5,$6,1)`, [randomUUID(), f.installationId, connectionId, 'a'.repeat(40), 'b'.repeat(64), Buffer.from('fixture')])).rejects.toThrow(/git_snapshot_incomplete/)
    await expect(pool.query(`INSERT INTO memory_git_snapshot_assets(installation_id,connection_id,export_id,binding_id,kind,claim_id,claim_version_id,path,
      base_revision,source_digest,content_hash,file_hash,base_document,field_map) SELECT installation_id,connection_id,export_id,binding_id,kind,claim_id,claim_version_id,path,
      base_revision,source_digest,content_hash,file_hash,base_document,field_map FROM memory_git_snapshot_assets WHERE export_id=$1`, [exportId])).rejects.toThrow(/git_snapshot_immutable/)
  })
})
