import pg from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { applyMemorySchema, MEMORY_MIGRATIONS } from '../schema.js'
import {
  MEMORY_TEST_DATABASE_TABLES,
  assertMemoryTestDatabase,
} from '../testing/test-db.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const integrationEnabled = Boolean(
  databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1',
)
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const PHASE4_TABLES = [
  'memory_source_snapshots',
  'memory_source_blobs',
  'memory_source_snapshot_entries',
  'memory_code_graph_versions',
  'memory_code_graph_heads',
  'memory_code_nodes',
  'memory_code_edges',
  'memory_wikis',
  'memory_wiki_heads',
  'memory_wiki_build_runs',
  'memory_wiki_versions',
  'memory_wiki_pages',
  'memory_wiki_sections',
  'memory_wiki_source_bindings',
  'memory_wiki_manual_section_versions',
  'memory_wiki_manual_section_heads',
  'memory_wiki_stale_marks',
  'memory_source_snapshot_tombstones',
  'memory_repository_tombstones',
  'memory_wiki_audit_events',
  'memory_phase4_authorization_audit_events',
] as const

async function insertInstallation(pool: pg.Pool): Promise<string> {
  const result = await pool.query<{ id: string }>(`
    INSERT INTO memory_installations
      (installation_id, provider_id, relay_status, local_status, config_version,
       granted_scopes, subscriptions, enabled_services, event_filter)
    VALUES (gen_random_uuid(), 'pocketctl-memory', 'active', 'ready', 1,
            '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb)
    RETURNING installation_id::text AS id
  `)
  return result.rows[0]!.id
}

async function insertRepository(
  pool: pg.Pool,
  installationId: string,
  key: string,
): Promise<string> {
  const result = await pool.query<{ id: string }>(`
    INSERT INTO repositories (repository_id, installation_id, repository_key,
                              first_observed_at, last_observed_at)
    VALUES (gen_random_uuid(), $1, $2, NOW(), NOW())
    RETURNING repository_id::text AS id
  `, [installationId, key])
  return result.rows[0]!.id
}

async function insertSnapshot(
  pool: pg.Pool,
  installationId: string,
  repositoryId: string,
  commitSha: string,
  manifestHash: string,
): Promise<string> {
  const result = await pool.query<{ id: string }>(`
    INSERT INTO memory_source_snapshots
      (snapshot_id, installation_id, repository_id, commit_sha, git_object_format,
       manifest_hash, state, generation, parser_matrix_version, file_count, byte_count)
    VALUES (gen_random_uuid(), $1, $2, $3, 'sha1', $4, 'staging', 0, 'phase4-v1', 0, 0)
    RETURNING snapshot_id::text AS id
  `, [installationId, repositoryId, commitSha, manifestHash])
  return result.rows[0]!.id
}

describeWithDatabase('memory phase4 schema (migrations 25-30)', () => {
  let pool: pg.Pool

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
    await assertMemoryTestDatabase(pool, databaseUrl!)
    await pool.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`)
    await applyMemorySchema(pool)
  }, 60_000)

  afterAll(async () => {
    await pool?.end()
  })

  test('appends migrations 25-30 additively without renumbering 1-24', () => {
    const versions = MEMORY_MIGRATIONS.map(migration => migration.version)
    expect(versions.slice(0, 24)).toEqual(
      Array.from({ length: 24 }, (_, index) => index + 1),
    )
    expect(versions.slice(24, 30)).toEqual([25, 26, 27, 28, 29, 30])
  })

  test('creates every phase4 table and reruns idempotently', async () => {
    await applyMemorySchema(pool)
    const tables = await pool.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema()
      ORDER BY table_name
    `)
    const names = tables.rows.map(row => row.table_name)
    for (const table of PHASE4_TABLES) {
      expect(names, table).toContain(table)
    }
    for (const table of MEMORY_TEST_DATABASE_TABLES) {
      expect(names, table).toContain(table)
    }
    const applied = await pool.query<{ version: number }>(
      `SELECT version FROM memory_schema_migrations ORDER BY version`,
    )
    expect(applied.rows.map(row => Number(row.version))).toHaveLength(38)
  })

  test('upgrades a populated v24 database without touching existing rows', async () => {
    // Rebuild to exactly v24, seed data, then upgrade through 25-30.
    await pool.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`)
    const client = await pool.connect()
    try {
      for (const migration of MEMORY_MIGRATIONS) {
        if (migration.version > 24) break
        await client.query('BEGIN')
        try {
          for (const statement of migration.statements) {
            await client.query(statement)
          }
          await client.query(
            'INSERT INTO memory_schema_migrations (version) VALUES ($1)',
            [migration.version],
          )
          await client.query('COMMIT')
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        }
      }
    } finally {
      client.release()
    }
    const installationId = await insertInstallation(pool)
    const repositoryId = await insertRepository(pool, installationId, 'seed/repo')
    await applyMemorySchema(pool)

    const survived = await pool.query<{ repository_key: string }>(
      `SELECT repository_key FROM repositories WHERE repository_id = $1`,
      [repositoryId],
    )
    expect(survived.rows[0]?.repository_key).toBe('seed/repo')
    const versions = await pool.query<{ version: number }>(
      `SELECT version FROM memory_schema_migrations ORDER BY version`,
    )
    expect(versions.rows.map(row => Number(row.version))).toHaveLength(38)
  })

  test('snapshots are unique per installation/repo/commit/manifest and state-checked', async () => {
    const installationId = await insertInstallation(pool)
    const repositoryId = await insertRepository(pool, installationId, 'a/repo')
    const commitSha = 'a'.repeat(40)
    const manifestHash = 'b'.repeat(64)
    await insertSnapshot(pool, installationId, repositoryId, commitSha, manifestHash)
    // Same installation + repo + commit + manifest is idempotent-rejected.
    await expect(insertSnapshot(pool, installationId, repositoryId, commitSha, manifestHash))
      .rejects.toThrow()
    // A different installation may record the same commit: per-tenant scoping.
    const otherInstallationId = await insertInstallation(pool)
    const otherRepositoryId = await insertRepository(pool, otherInstallationId, 'a/repo')
    await expect(insertSnapshot(pool, otherInstallationId, otherRepositoryId, commitSha, manifestHash))
      .resolves.toBeTruthy()
    // State and format checks reject unknown values and malformed ids.
    await expect(pool.query(`
      INSERT INTO memory_source_snapshots
        (snapshot_id, installation_id, repository_id, commit_sha, git_object_format,
         manifest_hash, state, generation, parser_matrix_version, file_count, byte_count)
      VALUES (gen_random_uuid(), $1, $2, $3, 'sha1', $4, 'unknown', 0, 'phase4-v1', 0, 0)
    `, [installationId, repositoryId, commitSha, manifestHash])).rejects.toThrow()
    await expect(pool.query(`
      INSERT INTO memory_source_snapshots
        (snapshot_id, installation_id, repository_id, commit_sha, git_object_format,
         manifest_hash, state, generation, parser_matrix_version, file_count, byte_count)
      VALUES (gen_random_uuid(), $1, $2, 'SHORTSHA', 'sha1', $4, 'staging', 0, 'phase4-v1', 0, 0)
    `, [installationId, repositoryId, manifestHash])).rejects.toThrow()
    await expect(pool.query(`
      INSERT INTO memory_source_snapshots
        (snapshot_id, installation_id, repository_id, commit_sha, git_object_format,
         manifest_hash, state, generation, parser_matrix_version, file_count, byte_count)
      VALUES (gen_random_uuid(), $1, $2, $3, 'sha1', 'tooshort', 'staging', 0, 'phase4-v1', 0, 0)
    `, [installationId, repositoryId, commitSha])).rejects.toThrow()
  })

  test('blob and entry composite tenant keys reject cross-installation reuse', async () => {
    const installationA = await insertInstallation(pool)
    const installationB = await insertInstallation(pool)
    const repositoryA = await insertRepository(pool, installationA, 'iso/repo')
    const repositoryB = await insertRepository(pool, installationB, 'iso/repo')

    await pool.query(`
      INSERT INTO memory_source_blobs (installation_id, blob_hash, byte_count, utf8_content)
      VALUES ($1, $2, 3, 'abc')
    `, [installationA, 'c'.repeat(64)])
    // The same content hash in another installation is an independent row:
    // no global content table may reveal cross-tenant equality.
    await expect(pool.query(`
      INSERT INTO memory_source_blobs (installation_id, blob_hash, byte_count, utf8_content)
      VALUES ($1, $2, 3, 'abc')
    `, [installationB, 'c'.repeat(64)])).resolves.toBeTruthy()
    // A blob hash that only exists in installation A.
    await pool.query(`
      INSERT INTO memory_source_blobs (installation_id, blob_hash, byte_count, utf8_content)
      VALUES ($1, $2, 3, 'xyz')
    `, [installationA, 'd'.repeat(64)])

    const snapshotA = await insertSnapshot(pool, installationA, repositoryA, 'd'.repeat(40), 'e'.repeat(64))
    // An entry in installation B cannot reference installation A's blob.
    const snapshotB = await insertSnapshot(pool, installationB, repositoryB, 'd'.repeat(40), 'e'.repeat(64))
    await expect(pool.query(`
      INSERT INTO memory_source_snapshot_entries
        (snapshot_id, installation_id, path, blob_hash, language, capability, byte_count, mode)
      VALUES ($1, $2, 'src/a.ts', $3, 'typescript', 'symbols_and_edges', 3, '100644')
    `, [snapshotB, installationB, 'd'.repeat(64)])).rejects.toThrow()
    // A valid same-tenant entry works.
    await expect(pool.query(`
      INSERT INTO memory_source_snapshot_entries
        (snapshot_id, installation_id, path, blob_hash, language, capability, byte_count, mode)
      VALUES ($1, $2, 'src/a.ts', $3, 'typescript', 'symbols_and_edges', 3, '100644')
    `, [snapshotA, installationA, 'c'.repeat(64)])).resolves.toBeTruthy()
    // Duplicate path inside one snapshot is rejected.
    await expect(pool.query(`
      INSERT INTO memory_source_snapshot_entries
        (snapshot_id, installation_id, path, blob_hash, language, capability, byte_count, mode)
      VALUES ($1, $2, 'src/a.ts', $3, 'typescript', 'symbols_and_edges', 3, '100644')
    `, [snapshotA, installationA, 'c'.repeat(64)])).rejects.toThrow()
    // A cross-installation snapshot reference is rejected by the composite FK.
    await expect(pool.query(`
      INSERT INTO memory_source_snapshot_entries
        (snapshot_id, installation_id, path, blob_hash, language, capability, byte_count, mode)
      VALUES ($1, $2, 'src/b.ts', $3, 'typescript', 'symbols_and_edges', 3, '100644')
    `, [snapshotA, installationB, 'c'.repeat(64)])).rejects.toThrow()
  })

  test('keeps one graph head per repository with monotonic revision', async () => {
    const installationId = await insertInstallation(pool)
    const repositoryId = await insertRepository(pool, installationId, 'graph/repo')
    const commitSha = 'f'.repeat(40)
    const manifestHash = '0'.repeat(64)
    const snapshotId = await insertSnapshot(pool, installationId, repositoryId, commitSha, manifestHash)
    await pool.query(`
      INSERT INTO memory_code_graph_versions
        (graph_version_id, installation_id, repository_id, snapshot_id, generation,
         parser_version, state, coverage, content_hash)
      VALUES (gen_random_uuid(), $1, $2, $3, 1, 'phase4-parser-v1', 'candidate',
              'complete', $4)
    `, [installationId, repositoryId, snapshotId, '1'.repeat(64)])
    const graphVersion = await pool.query<{ id: string }>(`
      SELECT graph_version_id::text AS id FROM memory_code_graph_versions
      WHERE installation_id = $1 AND repository_id = $2
    `, [installationId, repositoryId])
    const graphVersionId = graphVersion.rows[0]!.id

    await pool.query(`
      INSERT INTO memory_code_graph_heads
        (installation_id, repository_id, active_graph_version_id, revision)
      VALUES ($1, $2, $3, 1)
    `, [installationId, repositoryId, graphVersionId])
    // Exactly one active head per (installation, repository).
    await expect(pool.query(`
      INSERT INTO memory_code_graph_heads
        (installation_id, repository_id, active_graph_version_id, revision)
      VALUES ($1, $2, $3, 2)
    `, [installationId, repositoryId, graphVersionId])).rejects.toThrow()
    // Revisions start at one.
    await expect(pool.query(`
      INSERT INTO memory_code_graph_heads
        (installation_id, repository_id, active_graph_version_id, revision)
      VALUES ($1, $2, $3, 0)
    `, [installationId, await insertRepository(pool, installationId, 'graph/repo2'), graphVersionId])
    ).rejects.toThrow()
    // Cross-installation graph head references a foreign repository.
    const otherInstallation = await insertInstallation(pool)
    await expect(pool.query(`
      INSERT INTO memory_code_graph_heads
        (installation_id, repository_id, active_graph_version_id, revision)
      VALUES ($1, $2, $3, 1)
    `, [otherInstallation, repositoryId, graphVersionId])).rejects.toThrow()
  })

  test('nodes and edges are graph-version scoped with frozen kind checks', async () => {
    const installationId = await insertInstallation(pool)
    const repositoryId = await insertRepository(pool, installationId, 'nodes/repo')
    const snapshotId = await insertSnapshot(pool, installationId, repositoryId, '1'.repeat(40), '2'.repeat(64))
    const inserted = await pool.query<{ id: string }>(`
      INSERT INTO memory_code_graph_versions
        (graph_version_id, installation_id, repository_id, snapshot_id, generation,
         parser_version, state, coverage, content_hash)
      VALUES (gen_random_uuid(), $1, $2, $3, 1, 'phase4-parser-v1', 'candidate',
              'complete', $4)
      RETURNING graph_version_id::text AS id
    `, [installationId, repositoryId, snapshotId, '3'.repeat(64)])
    const graphVersionId = inserted.rows[0]!.id

    await pool.query(`
      INSERT INTO memory_code_nodes
        (graph_version_id, installation_id, node_id, kind, stable_key, path, name, symbol_kind)
      VALUES ($1, $2, gen_random_uuid(), 'file', 'file:src/a.ts', 'src/a.ts', 'a.ts', NULL)
    `, [graphVersionId, installationId])
    await expect(pool.query(`
      INSERT INTO memory_code_nodes
        (graph_version_id, installation_id, node_id, kind, stable_key, path, name, symbol_kind)
      VALUES ($1, $2, gen_random_uuid(), 'blob', 'file:src/b.ts', 'src/b.ts', 'b.ts', NULL)
    `, [graphVersionId, installationId])).rejects.toThrow()
    // Duplicate stable keys inside one graph version are rejected.
    await expect(pool.query(`
      INSERT INTO memory_code_nodes
        (graph_version_id, installation_id, node_id, kind, stable_key, path, name)
      VALUES ($1, $2, gen_random_uuid(), 'file', 'file:src/a.ts', 'src/a.ts', 'a.ts')
    `, [graphVersionId, installationId])).rejects.toThrow()

    const node = await pool.query<{ id: string }>(`
      SELECT node_id::text AS id FROM memory_code_nodes WHERE graph_version_id = $1
    `, [graphVersionId])
    const nodeId = node.rows[0]!.id
    await pool.query(`
      INSERT INTO memory_code_edges
        (graph_version_id, installation_id, edge_id, kind, from_node_id, to_node_id,
         source_path, source_line, resolution)
      VALUES ($1, $2, gen_random_uuid(), 'import', $3, $3, 'src/a.ts', 1, 'resolved')
    `, [graphVersionId, installationId, nodeId])
    await expect(pool.query(`
      INSERT INTO memory_code_edges
        (graph_version_id, installation_id, edge_id, kind, from_node_id, to_node_id,
         source_path, source_line, resolution)
      VALUES ($1, $2, gen_random_uuid(), 'contains', $3, $3, 'src/a.ts', 1, 'resolved')
    `, [graphVersionId, installationId, nodeId])).rejects.toThrow()
    await expect(pool.query(`
      INSERT INTO memory_code_edges
        (graph_version_id, installation_id, edge_id, kind, from_node_id, to_node_id,
         source_path, source_line, resolution)
      VALUES ($1, $2, gen_random_uuid(), 'import', $3, $3, 'src/a.ts', 1, 'maybe')
    `, [graphVersionId, installationId, nodeId])).rejects.toThrow()
  })

  test('wikis are unique per repository with one serial active build run', async () => {
    const installationId = await insertInstallation(pool)
    const repositoryId = await insertRepository(pool, installationId, 'wiki/repo')
    const snapshotId = await insertSnapshot(pool, installationId, repositoryId, '4'.repeat(40), '5'.repeat(64))
    const wiki = await pool.query<{ id: string }>(`
      INSERT INTO memory_wikis (wiki_id, installation_id, repository_id)
      VALUES (gen_random_uuid(), $1, $2)
      RETURNING wiki_id::text AS id
    `, [installationId, repositoryId])
    const wikiId = wiki.rows[0]!.id
    // One Wiki per (installation, repository).
    await expect(pool.query(`
      INSERT INTO memory_wikis (wiki_id, installation_id, repository_id)
      VALUES (gen_random_uuid(), $1, $2)
    `, [installationId, repositoryId])).rejects.toThrow()
    // Cross-installation wiki creation against a foreign repository is rejected.
    const otherInstallation = await insertInstallation(pool)
    await expect(pool.query(`
      INSERT INTO memory_wikis (wiki_id, installation_id, repository_id)
      VALUES (gen_random_uuid(), $1, $2)
    `, [otherInstallation, repositoryId])).rejects.toThrow()

    const enqueueRun = async (generation: number) => pool.query(`
      INSERT INTO memory_wiki_build_runs
        (run_id, installation_id, wiki_id, generation, source_snapshot_id, state, input_digest)
      VALUES (gen_random_uuid(), $1, $2, $3, $4, 'queued', $5)
    `, [installationId, wikiId, generation, snapshotId, '6'.repeat(64)])
    await expect(enqueueRun(1)).resolves.toBeTruthy()
    // The partial unique index forbids a second queued/running/validating run.
    await expect(enqueueRun(2)).rejects.toThrow()
    // Advancing the first run to candidate frees the serial slot.
    await pool.query(`
      UPDATE memory_wiki_build_runs SET state = 'candidate' WHERE installation_id = $1 AND wiki_id = $2
    `, [installationId, wikiId])
    await expect(enqueueRun(2)).resolves.toBeTruthy()
    // Terminal states never collide with the active-run fence.
    await pool.query(`
      UPDATE memory_wiki_build_runs SET state = 'stale_generation' WHERE installation_id = $1 AND wiki_id = $2 AND generation = 2
    `, [installationId, wikiId])
    await expect(enqueueRun(3)).resolves.toBeTruthy()
    // Generation is unique and monotonic per wiki.
    await expect(enqueueRun(3)).rejects.toThrow()
  })

  test('wiki versions carry the frozen manual authority enum', async () => {
    const installationId = await insertInstallation(pool)
    const repositoryId = await insertRepository(pool, installationId, 'authority/repo')
    const snapshotId = await insertSnapshot(pool, installationId, repositoryId, '7'.repeat(40), '8'.repeat(64))
    const graphVersion = await pool.query<{ id: string }>(`
      INSERT INTO memory_code_graph_versions
        (graph_version_id, installation_id, repository_id, snapshot_id, generation,
         parser_version, state, coverage, content_hash)
      VALUES (gen_random_uuid(), $1, $2, $3, 1, 'phase4-parser-v1', 'active',
              'complete', $4)
      RETURNING graph_version_id::text AS id
    `, [installationId, repositoryId, snapshotId, '9'.repeat(64)])
    const wiki = await pool.query<{ id: string }>(`
      INSERT INTO memory_wikis (wiki_id, installation_id, repository_id)
      VALUES (gen_random_uuid(), $1, $2)
      RETURNING wiki_id::text AS id
    `, [installationId, repositoryId])
    const version = await pool.query<{ id: string }>(`
      INSERT INTO memory_wiki_versions
        (wiki_version_id, installation_id, wiki_id, revision, source_snapshot_id,
         graph_version_id, state, content_hash)
      VALUES (gen_random_uuid(), $1, $2, 1, $3, $4, 'active', $5)
      RETURNING wiki_version_id::text AS id
    `, [installationId, wiki.rows[0]!.id, snapshotId, graphVersion.rows[0]!.id, 'a'.repeat(64)])
    const wikiVersionId = version.rows[0]!.id

    // Revisions are unique and monotonic per wiki.
    await expect(pool.query(`
      INSERT INTO memory_wiki_versions
        (wiki_version_id, installation_id, wiki_id, revision, source_snapshot_id,
         graph_version_id, state, content_hash)
      VALUES (gen_random_uuid(), $1, $2, 1, $3, $4, 'active', $5)
    `, [installationId, wiki.rows[0]!.id, snapshotId, graphVersion.rows[0]!.id, 'b'.repeat(64)])
    ).rejects.toThrow()

    const page = await pool.query<{ id: string }>(`
      INSERT INTO memory_wiki_pages
        (wiki_version_id, installation_id, page_id, page_key, title, position)
      VALUES ($1, $2, gen_random_uuid(), 'overview', 'Overview', 0)
      RETURNING page_id::text AS id
    `, [wikiVersionId, installationId])
    const pageId = page.rows[0]!.id

    for (const authority of ['generated', 'manual', 'locked']) {
      await expect(pool.query(`
        INSERT INTO memory_wiki_sections
          (wiki_version_id, installation_id, section_id, page_id, section_key,
           heading, markdown, authority, coverage, position)
        VALUES ($1, $2, gen_random_uuid(), $3, $4, 'H', 'm', $5, 'complete', 0)
      `, [wikiVersionId, installationId, pageId, `s/${authority}`, authority])).resolves.toBeTruthy()
    }
    await expect(pool.query(`
      INSERT INTO memory_wiki_sections
        (wiki_version_id, installation_id, section_id, page_id, section_key,
         heading, markdown, authority, coverage, position)
      VALUES ($1, $2, gen_random_uuid(), $3, 's/bad', 'H', 'm', 'immutable', 'complete', 0)
    `, [wikiVersionId, installationId, pageId])).rejects.toThrow()

    // Source bindings reference only sections of the same wiki version.
    const section = await pool.query<{ id: string }>(`
      SELECT section_id::text AS id FROM memory_wiki_sections
      WHERE wiki_version_id = $1 AND section_key = 's/manual'
    `, [wikiVersionId])
    await expect(pool.query(`
      INSERT INTO memory_wiki_source_bindings
        (wiki_version_id, installation_id, section_id, binding_id, source_kind, source_token)
      VALUES ($1, $2, $3, gen_random_uuid(), 'file', 'file:src/a.ts')
    `, [wikiVersionId, installationId, section.rows[0]!.id])).resolves.toBeTruthy()
    await expect(pool.query(`
      INSERT INTO memory_wiki_source_bindings
        (wiki_version_id, installation_id, section_id, binding_id, source_kind, source_token)
      VALUES ($1, $2, gen_random_uuid(), gen_random_uuid(), 'vibe', 'x')
    `, [wikiVersionId, installationId])).rejects.toThrow()
  })
})
