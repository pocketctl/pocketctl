import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { createPostgresVectorIndex, normalize } from '../retrieval/postgres-vector-index.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const integrationEnabled = Boolean(
  databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1',
)
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const INSTALLATION = '99999999-9999-4999-8999-999999999999'

describeWithDatabase('postgres vector index', () => {
  let pool: pg.Pool
  let index: ReturnType<typeof createPostgresVectorIndex>

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
    await assertMemoryTestDatabase(pool, databaseUrl!)
    await applyMemorySchema(pool)
    index = createPostgresVectorIndex(pool)
  }, 60_000)

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE claim_search_documents, knowledge_evidence, knowledge_versions,
               knowledge_claims, memory_installations
      RESTART IDENTITY CASCADE
    `)
    await pool.query(`
      INSERT INTO memory_installations
        (installation_id, provider_id, relay_status, local_status, config_version)
      VALUES ($1, 'pocketctl-memory', 'active', 'ready', 1)
    `, [INSTALLATION])
  })

  async function seedVersion(dimensionHint = ''): Promise<string> {
    const claim = await pool.query<{ claim_id: string }>(`
      INSERT INTO knowledge_claims
        (claim_id, installation_id, claim_type, scope_kind, scope_key, normalized_key, state)
      VALUES (gen_random_uuid(), $1, 'work_method', 'installation', 'global', $2, 'active')
      RETURNING claim_id::text
    `, [INSTALLATION, `key-${dimensionHint || Math.random()}`])
    const version = await pool.query<{ version_id: string }>(`
      INSERT INTO knowledge_versions
        (version_id, installation_id, claim_id, version_number, statement, authority, confidence)
      VALUES (gen_random_uuid(), $1, $2, 1, 'statement', 'user_accepted', 0.5)
      RETURNING version_id::text
    `, [INSTALLATION, claim.rows[0].claim_id])
    await pool.query(`
      INSERT INTO claim_search_documents (installation_id, version_id, document)
      VALUES ($1, $2, 'statement')
    `, [INSTALLATION, version.rows[0].version_id])
    return version.rows[0].version_id
  }

  test('normalize produces unit vectors and leaves zero vectors finite', () => {
    const unit = normalize([3, 4])
    expect(Math.hypot(...unit)).toBeCloseTo(1, 12)
    expect(normalize([0, 0])).toEqual([0, 0])
  })

  test('upsert writes normalized vectors and search ranks by cosine similarity', async () => {
    const a = await seedVersion('a')
    const b = await seedVersion('b')
    await index.upsert({
      installationId: INSTALLATION, versionId: a, provider: 'openai-compatible',
      model: 'embed-small', dimensions: 2, vector: [3, 4],
    })
    await index.upsert({
      installationId: INSTALLATION, versionId: b, provider: 'openai-compatible',
      model: 'embed-small', dimensions: 2, vector: [-1, 0],
    })
    const stored = await pool.query<{ embedding: number[] }>(`
      SELECT embedding FROM claim_search_documents WHERE version_id = $1
    `, [a])
    expect(Math.hypot(...stored.rows[0].embedding)).toBeCloseTo(1, 6)

    const hits = await index.search({
      installationId: INSTALLATION, provider: 'openai-compatible',
      model: 'embed-small', dimensions: 2, vector: [1, 0], limit: 10,
    })
    expect(hits[0].versionId).toBe(a)
    expect(hits[1].versionId).toBe(b)
    expect(hits[0].score).toBeGreaterThan(hits[1].score)
  })

  test('dimension mismatches are hard errors', async () => {
    const a = await seedVersion('dim')
    await expect(index.upsert({
      installationId: INSTALLATION, versionId: a, provider: 'p', model: 'm',
      dimensions: 3, vector: [1, 0],
    })).rejects.toThrow(/dimension/)
    await expect(index.search({
      installationId: INSTALLATION, provider: 'p', model: 'm',
      dimensions: 3, vector: [1, 0], limit: 5,
    })).rejects.toThrow(/dimension/)
  })

  test('search never crosses provider/model families', async () => {
    const a = await seedVersion('family')
    await index.upsert({
      installationId: INSTALLATION, versionId: a, provider: 'openai-compatible',
      model: 'embed-small', dimensions: 2, vector: [1, 0],
    })
    const foreignModel = await index.search({
      installationId: INSTALLATION, provider: 'openai-compatible',
      model: 'other-model', dimensions: 2, vector: [1, 0], limit: 5,
    })
    expect(foreignModel).toEqual([])
    const foreignProvider = await index.search({
      installationId: INSTALLATION, provider: 'vendor-x',
      model: 'embed-small', dimensions: 2, vector: [1, 0], limit: 5,
    })
    expect(foreignProvider).toEqual([])
  })

  test('deleteVersion removes exactly one projection row', async () => {
    const a = await seedVersion('del')
    await index.deleteVersion(INSTALLATION, a)
    const remaining = await pool.query(`SELECT COUNT(*)::int AS count FROM claim_search_documents`)
    expect(remaining.rows[0].count).toBe(0)
  })
})

describe('vector math (no database)', () => {
  test('normalize is deterministic', () => {
    expect(normalize([2, 2])).toEqual(normalize([2, 2]))
  })

  test('normalize handles finite extremes without overflow', () => {
    const normalized = normalize([1e308, 1e308])
    expect(normalized.every(Number.isFinite)).toBe(true)
    expect(Math.hypot(...normalized)).toBeCloseTo(1, 12)
  })

  test('normalize rejects non-finite values', () => {
    expect(() => normalize([Number.NaN])).toThrow(/finite/)
    expect(() => normalize([Number.POSITIVE_INFINITY])).toThrow(/finite/)
  })
})
