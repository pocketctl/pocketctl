import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { applyMemorySchema, MEMORY_MIGRATIONS } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { canonicalJsonString } from '../inbox/canonical-json.js'
import { skillFixtureDocument } from '../testing/skill-fixture.js'

const url = process.env.MEMORY_TEST_DATABASE_URL
const db = url && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1' ? describe : describe.skip

db('Phase 5 immutable archive schema (migration 31)', () => {
  let pool: pg.Pool
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 4 })
    await assertMemoryTestDatabase(pool, url!)
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
    // Explicit upgrade from v30, not just a clean install of the new schema.
    const client = await pool.connect()
    try {
      for (const migration of MEMORY_MIGRATIONS.filter(m => m.version <= 30)) {
        await client.query('BEGIN')
        for (const statement of migration.statements) await client.query(statement)
        await client.query('INSERT INTO memory_schema_migrations(version) VALUES ($1)', [migration.version])
        await client.query('COMMIT')
      }
    } finally { client.release() }
  }, 60_000)
  afterAll(async () => { await pool?.end() })

  async function fixture() {
    const installation = randomUUID(), repository = randomUUID(), snapshot = randomUUID(), episode = randomUUID()
    await pool.query(`INSERT INTO memory_installations
      (installation_id, provider_id, relay_status, local_status, config_version)
      VALUES ($1, 'pocketctl-memory', 'active', 'ready', 1)`, [installation])
    await pool.query(`INSERT INTO repositories
      (installation_id, repository_id, repository_key, first_observed_at, last_observed_at)
      VALUES ($1, $2, $2::uuid::text, NOW(), NOW())`, [installation, repository])
    await pool.query(`INSERT INTO repo_snapshots
      (installation_id, repository_id, repo_snapshot_id, commit_sha, observed_at)
      VALUES ($1, $2, $3, $4, NOW())`, [installation, repository, snapshot, 'a'.repeat(40)])
    await pool.query(`INSERT INTO work_episodes
      (installation_id, episode_id, session_id, turn_id, state, outcome, compiler_version,
       repository_id, repo_snapshot_id, source_digest, evidence_manifest)
      VALUES ($1, $2, $2::uuid::text, $2::uuid::text, 'ready', 'completed', 'fixture.v1', $3, $4, decode($5, 'hex'), $6::jsonb)`,
    [installation, episode, repository, snapshot, 'a'.repeat(64), JSON.stringify({
      e1: { kind: 'episode', excerpt_hash: 'b'.repeat(16), excerpt_length: 20, truncated: false },
    })])
    return { installation, repository, snapshot, episode }
  }

  async function insert(f: Awaited<ReturnType<typeof fixture>>, overrides: { task?: string; generation?: number; snapshot?: string; inputHash?: string; handle?: string; omitSource?: boolean; document?: object } = {}) {
    const archive = randomUUID(), task = overrides.task ?? randomUUID()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`INSERT INTO memory_skill_archives
        (archive_id, installation_id, repository_id, repo_snapshot_id, episode_id,
         task_id, generation, candidate_key, policy_version, source_digest,
         input_digest, content_hash, document_hash, document)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'fixture','policy.v1',$8,$9,$10,$11,$12)`,
      [archive, f.installation, f.repository, overrides.snapshot ?? f.snapshot, f.episode, task,
        overrides.generation ?? 1, 'a'.repeat(64), overrides.inputHash ?? 'b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64),
        overrides.document ?? { schema_version: 'skill-candidate.v1', source_tokens: ['source-1'] }])
      if (!overrides.omitSource) await client.query(`INSERT INTO memory_skill_archive_sources
        (installation_id, archive_id, source_token, evidence_handle, excerpt_hash, evidence_kind)
        VALUES ($1, $2, 'source-1', $3, $4, 'episode')`,
      [f.installation, archive, overrides.handle ?? 'e1', 'b'.repeat(16)])
      await client.query('COMMIT')
      return { archive, task }
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }

  test('upgrades populated v30 and v37 databases idempotently without changing archive content', async () => {
    const f = await fixture()
    expect(MEMORY_MIGRATIONS.map(m => m.version)).toEqual(Array.from({ length: 46 }, (_, i) => i + 1))
    const client=await pool.connect()
    try {
      for(const migration of MEMORY_MIGRATIONS.filter(m=>m.version>30&&m.version<=37)) {
        await client.query('BEGIN')
        for(const statement of migration.statements)await client.query(statement)
        await client.query('INSERT INTO memory_schema_migrations(version) VALUES ($1)',[migration.version])
        await client.query('COMMIT')
      }
    } finally {client.release()}
    const {archive}=await insert(f)
    const before=(await pool.query('SELECT * FROM memory_skill_archives WHERE archive_id=$1',[archive])).rows
    await applyMemorySchema(pool); await applyMemorySchema(pool)
    expect((await pool.query('SELECT episode_id FROM work_episodes WHERE installation_id=$1', [f.installation])).rowCount).toBe(1)
    expect((await pool.query('SELECT * FROM memory_skill_archives WHERE archive_id=$1',[archive])).rows).toEqual(before)
    await expect(insert(f)).resolves.toBeDefined()
  })

  test('requires a unique task generation and bounded hashes', async () => {
    const f = await fixture()
    const first = await insert(f)
    await expect(insert(f, { task: first.task })).rejects.toThrow()
    await expect(insert(f, { task: first.task, generation: 2 })).resolves.toBeDefined()
    await expect(insert(f, { generation: 0 })).rejects.toThrow()
    await expect(insert(f, { inputHash: 'bad' })).rejects.toThrow()
  })

  test.each(['ASCII','escaped Unicode'])('enforces the canonical UTF-16 length at 32000/32001 for %s',async kind=>{
    const f=await fixture(),document=skillFixtureDocument()
    document.title=kind==='ASCII'?'Boundary':'中文 🚀 "quoted", spaced: \\ \n\t\u0001'
    document.steps=Array.from({length:8},()=>({...document.steps[0]!,instruction:'x'.repeat(3800)}))
    document.trigger='x'.repeat(document.trigger.length+32000-canonicalJsonString(document).length)
    expect(canonicalJsonString(document)).toHaveLength(32000)
    await expect(insert(f,{document})).resolves.toBeDefined()
    document.trigger+='x'
    expect(canonicalJsonString(document)).toHaveLength(32001)
    await expect(insert(f,{document})).rejects.toMatchObject({code:'23514'})
  })

  test('SQL NULL checks cannot admit an empty archive or missing source tokens', async () => {
    const f = await fixture()
    for (const document of [{}, { schema_version: 'skill-candidate.v1' }, { source_tokens: ['source-1'] }]) {
      await expect(insert(f, { document, omitSource: true })).rejects.toThrow()
    }
  })

  test('rejects a foreign tenant, repository snapshot, incomplete episode and invented Evidence', async () => {
    const a = await fixture(), b = await fixture()
    await expect(insert(a, { snapshot: b.snapshot })).rejects.toThrow()
    await expect(insert({ ...a, installation: b.installation })).rejects.toThrow()
    await expect(insert({ ...a, repository: b.repository })).rejects.toThrow()
    await expect(insert(a, { handle: 'invented' })).rejects.toThrow(/skill_source_invalid/)
    await pool.query("UPDATE work_episodes SET outcome='failed' WHERE episode_id=$1", [a.episode])
    await expect(insert(a)).rejects.toThrow(/skill_archive_source_invalid/)
  })

  test('archives and evidence mappings cannot be updated or extended after commit', async () => {
    const f = await fixture(), { archive } = await insert(f)
    await expect(pool.query("UPDATE memory_skill_archives SET candidate_key='changed' WHERE archive_id=$1", [archive])).rejects.toThrow(/skill_archive_immutable/)
    await expect(pool.query("UPDATE memory_skill_archive_sources SET excerpt_hash=$2 WHERE archive_id=$1", [archive, 'c'.repeat(16)])).rejects.toThrow(/skill_archive_immutable/)
    await expect(pool.query(`INSERT INTO memory_skill_archive_sources
      (installation_id, archive_id, source_token, evidence_handle, excerpt_hash, evidence_kind)
      VALUES ($1,$2,'late','e1',$3,'episode')`, [f.installation, archive, 'b'.repeat(16)])).rejects.toThrow(/skill_archive_immutable/)
    await expect(insert(f, { omitSource: true })).rejects.toThrow(/skill_archive_sources_incomplete/)
  })

  test('deleting one evidence mapping removes the entire dependent archive', async () => {
    const f = await fixture(), { archive } = await insert(f)
    await pool.query('DELETE FROM memory_skill_archive_sources WHERE archive_id=$1', [archive])
    expect((await pool.query('SELECT 1 FROM memory_skill_archives WHERE archive_id=$1', [archive])).rowCount).toBe(0)
  })

  test.each(['digest', 'manifest', 'invalidated', 'episode_delete', 'installation_delete'])('%s removes dependent content', async action => {
    const f = await fixture(), { archive } = await insert(f)
    if (action === 'digest') await pool.query("UPDATE work_episodes SET source_digest=decode($2,'hex') WHERE episode_id=$1", [f.episode, 'f'.repeat(64)])
    if (action === 'manifest') await pool.query("UPDATE work_episodes SET evidence_manifest='{}'::jsonb WHERE episode_id=$1", [f.episode])
    if (action === 'invalidated') await pool.query("UPDATE work_episodes SET state='invalidated' WHERE episode_id=$1", [f.episode])
    if (action === 'episode_delete') await pool.query('DELETE FROM work_episodes WHERE episode_id=$1', [f.episode])
    if (action === 'installation_delete') await pool.query('DELETE FROM memory_installations WHERE installation_id=$1', [f.installation])
    expect((await pool.query('SELECT 1 FROM memory_skill_archives WHERE archive_id=$1', [archive])).rowCount).toBe(0)
    expect((await pool.query('SELECT 1 FROM memory_skill_archive_sources WHERE archive_id=$1', [archive])).rowCount).toBe(0)
  })
})
