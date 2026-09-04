import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { createPolicyRepository } from '../policies/repository.js'
import { createPolicyResolver } from '../policies/resolver.js'
import { createPolicyService } from '../policies/service.js'
import {
  canonicalPolicyHash,
  SYSTEM_CONTEXT_POLICY_V1,
  SYSTEM_EXTRACTION_POLICY_V1,
  SYSTEM_RANKING_POLICY_V1,
} from '../policies/schemas.js'
import { createExtractionRepository } from '../extraction/repository.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const integrationEnabled = Boolean(
  databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1',
)
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const INSTALLATION = '65656565-6565-4655-8655-656565656565'
const REPOSITORY_A = '11111111-1111-4111-8111-111111111111'
const REPOSITORY_B = '22222222-2222-4222-8222-222222222222'

const USER_EXTRACTION_DOC = {
  schema_version: 1,
  mode: 'shadow',
  focus: {
    claim_types: ['work_method', 'test_invariant'],
    include_topics: ['testing'],
    exclude_topics: [],
  },
  value_filter: { min_utility: 0.1, min_repeatability: 0, max_friction: 0.9 },
  evidence: { min_items: 2, require_terminal_outcome: false, require_distinct_turns: 2 },
  versions: {
    prompt: 'extraction-prompt-v3',
    extractor: 'extraction-v3',
    content_policy: 'extraction-content-v1',
    model_profile: 'default',
  },
}

describeWithDatabase('versioned policies (PostgreSQL)', () => {
  let pool: pg.Pool
  let repository: ReturnType<typeof createPolicyRepository>
  let resolver: ReturnType<typeof createPolicyResolver>
  let service: ReturnType<typeof createPolicyService>
  let extraction: ReturnType<typeof createExtractionRepository>

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
    await assertMemoryTestDatabase(pool, databaseUrl!)
    await applyMemorySchema(pool)
    repository = createPolicyRepository(pool)
    resolver = createPolicyResolver({ pool, repository })
    service = createPolicyService({ pool, repository, resolver })
    extraction = createExtractionRepository(pool)
  }, 60_000)

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE memory_jobs, memory_policy_heads, memory_policy_versions,
               memory_policy_sets, memory_extraction_runs, work_episodes,
               source_turns, source_events, source_sessions,
               memory_feature_settings, memory_installations
      RESTART IDENTITY CASCADE
    `)
    await pool.query(`
      INSERT INTO memory_installations
        (installation_id, provider_id, relay_status, local_status, config_version)
      VALUES ($1, 'pocketctl-memory', 'active', 'ready', 1)
    `, [INSTALLATION])
    resolver.clearCache()
  })

  test('system policies install idempotently', async () => {
    await repository.ensureSystemPolicies()
    await repository.ensureSystemPolicies()
    const sets = await pool.query<{ n: string }>(`
      SELECT COUNT(*)::text AS n FROM memory_policy_sets
      WHERE installation_id IS NULL AND layer = 'system'
    `)
    expect(Number(sets.rows[0].n)).toBe(3)
    const versions = await pool.query<{ n: string }>(`
      SELECT COUNT(*)::text AS n FROM memory_policy_versions v
      JOIN memory_policy_sets s ON s.policy_id = v.policy_id
      WHERE s.installation_id IS NULL
    `)
    expect(Number(versions.rows[0].n)).toBe(3)
  })

  test('system ranking policy advances immutably when its code-owned contract changes', async () => {
    const policy = await pool.query<{ policy_id: string }>(`
      INSERT INTO memory_policy_sets
        (policy_id, installation_id, policy_kind, layer, scope_key)
      VALUES (gen_random_uuid(), NULL, 'ranking', 'system', 'global')
      RETURNING policy_id::text
    `)
    const legacyDocument = {
      schema_version: 1,
      weights: SYSTEM_RANKING_POLICY_V1.weights,
      tie_break: ['version_id'],
    }
    const legacy = await pool.query<{ policy_version_id: string }>(`
      INSERT INTO memory_policy_versions
        (policy_version_id, policy_id, version_number, schema_version,
         document, content_hash, created_by)
      VALUES (gen_random_uuid(), $1, 1, 1, $2::jsonb, $3, 'system')
      RETURNING policy_version_id::text
    `, [policy.rows[0].policy_id, JSON.stringify(legacyDocument), canonicalPolicyHash(legacyDocument)])
    await pool.query(`
      INSERT INTO memory_policy_heads (policy_id, active_version_id, revision)
      VALUES ($1, $2, 1)
    `, [policy.rows[0].policy_id, legacy.rows[0].policy_version_id])

    await repository.ensureSystemPolicies()
    await repository.ensureSystemPolicies()

    const versions = await pool.query<{ version_number: number; content_hash: Buffer }>(`
      SELECT v.version_number, v.content_hash
      FROM memory_policy_versions v
      WHERE v.policy_id = $1
      ORDER BY v.version_number
    `, [policy.rows[0].policy_id])
    expect(versions.rows).toHaveLength(2)
    expect(versions.rows.map(row => Number(row.version_number))).toEqual([1, 2])
    const head = await pool.query<{ content_hash: Buffer; revision: string }>(`
      SELECT v.content_hash, h.revision::text
      FROM memory_policy_heads h
      JOIN memory_policy_versions v ON v.policy_version_id = h.active_version_id
      WHERE h.policy_id = $1
    `, [policy.rows[0].policy_id])
    expect(head.rows[0].content_hash.equals(canonicalPolicyHash(SYSTEM_RANKING_POLICY_V1))).toBe(true)
    expect(Number(head.rows[0].revision)).toBe(2)
  })

  test('organization and team layers are rejected in phase 2', async () => {
    const result = await repository.createVersion({
      installationId: INSTALLATION,
      kind: 'extraction',
      layer: 'organization',
      scopeKey: 'org-1',
      document: USER_EXTRACTION_DOC,
    })
    expect(result).toEqual({ ok: false, error: 'layer_unavailable' })
  })

  test('resolution merges system head with the user layer monotonically', async () => {
    await repository.ensureSystemPolicies()
    const created = await repository.createVersion({
      installationId: INSTALLATION,
      kind: 'extraction',
      layer: 'user',
      scopeKey: 'global',
      document: USER_EXTRACTION_DOC,
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const heads = await repository.listHeadDocuments({ installationId: INSTALLATION, kind: 'extraction' })
    const userHead = heads.find(head => head.layer === 'user')!
    const activated = await repository.activateVersion({
      installationId: INSTALLATION,
      policyVersionId: created.policyVersionId,
      expectedActiveVersionId: userHead.policyVersionId,
      expectedRevision: 1,
    })
    expect(activated).toBe(true)

    const effective = await resolver.resolve({ installationId: INSTALLATION, kind: 'extraction' })
    const doc = effective.document as typeof USER_EXTRACTION_DOC
    expect(doc.mode).toBe('shadow')
    expect(doc.focus.claim_types).toEqual(['work_method', 'test_invariant'])
    expect(doc.evidence.min_items).toBe(2)
    // Ordered contributing versions: system first, user second.
    expect(effective.policyVersionIds).toHaveLength(2)
  })

  test('repository policy heads apply only to the exact repository scope', async () => {
    await repository.ensureSystemPolicies()
    const repoPolicy = { ...SYSTEM_CONTEXT_POLICY_V1, max_items: 2 }
    const created = await repository.createVersion({
      installationId: INSTALLATION,
      kind: 'context',
      layer: 'repository',
      scopeKey: REPOSITORY_A,
      document: repoPolicy,
    })
    expect(created.ok).toBe(true)

    const forA = await resolver.resolve({
      installationId: INSTALLATION, kind: 'context', repositoryId: REPOSITORY_A,
    })
    const forB = await resolver.resolve({
      installationId: INSTALLATION, kind: 'context', repositoryId: REPOSITORY_B,
    })
    expect((forA.document as typeof SYSTEM_CONTEXT_POLICY_V1).max_items).toBe(2)
    expect((forB.document as typeof SYSTEM_CONTEXT_POLICY_V1).max_items)
      .toBe(SYSTEM_CONTEXT_POLICY_V1.max_items)
  })

  test('concurrent policy creates allocate distinct monotonic version numbers', async () => {
    const first = await repository.createVersion({
      installationId: INSTALLATION, kind: 'extraction', layer: 'user', scopeKey: 'global',
      document: USER_EXTRACTION_DOC,
    })
    expect(first.ok).toBe(true)
    const [second, third] = await Promise.all([
      repository.createVersion({
        installationId: INSTALLATION, kind: 'extraction', layer: 'user', scopeKey: 'global',
        document: { ...USER_EXTRACTION_DOC, mode: 'off' },
      }),
      repository.createVersion({
        installationId: INSTALLATION, kind: 'extraction', layer: 'user', scopeKey: 'global',
        document: { ...USER_EXTRACTION_DOC, focus: {
          ...USER_EXTRACTION_DOC.focus, exclude_topics: ['generated'],
        } },
      }),
    ])
    expect(second.ok && third.ok).toBe(true)
    const versions = await repository.listVersions({
      installationId: INSTALLATION, kind: 'extraction', layer: 'user', scopeKey: 'global',
    })
    expect(versions.map(version => version.versionNumber)).toEqual([1, 2, 3])
  })

  test('activation is CAS-guarded, invalidates the cache, and enqueues a digest-keyed recompile', async () => {
    await repository.ensureSystemPolicies()
    const created = await repository.createVersion({
      installationId: INSTALLATION,
      kind: 'extraction',
      layer: 'user',
      scopeKey: 'global',
      document: USER_EXTRACTION_DOC,
    })
    if (!created.ok) throw new Error('create failed')
    const heads = await repository.listHeadDocuments({ installationId: INSTALLATION, kind: 'extraction' })
    const userHead = heads.find(head => head.layer === 'user')!
    const stale = await service.activate({
      installationId: INSTALLATION,
      policyVersionId: created.policyVersionId,
      expectedActiveVersionId: '00000000-0000-4000-8000-000000000000',
      expectedRevision: 99,
    })
    expect(stale).toEqual({ ok: false, error: 'cas_conflict' })

    const fresh = await service.activate({
      installationId: INSTALLATION,
      policyVersionId: created.policyVersionId,
      expectedActiveVersionId: userHead.policyVersionId,
      expectedRevision: 1,
    })
    expect(fresh).toEqual({ ok: true, revision: 2 })

    // Recompile job enqueued exactly once, keyed by the effective policy hash.
    const jobs = await pool.query<{ idempotency_key: string }>(`
      SELECT idempotency_key FROM memory_jobs
      WHERE installation_id = $1 AND job_type = 'recompile_extraction_policy'
    `, [INSTALLATION])
    expect(jobs.rows).toHaveLength(1)
    const effective = await resolver.resolve({ installationId: INSTALLATION, kind: 'extraction' })
    expect(jobs.rows[0].idempotency_key).toContain(
      effective.effectivePolicyHash.toString('hex').slice(0, 32))
  })

  test('activation rejects a policy version whose kind differs from the route kind', async () => {
    const created = await repository.createVersion({
      installationId: INSTALLATION,
      kind: 'context',
      layer: 'user',
      scopeKey: 'global',
      document: SYSTEM_CONTEXT_POLICY_V1,
    })
    if (!created.ok) throw new Error('create failed')
    const result = await service.activate({
      installationId: INSTALLATION,
      policyVersionId: created.policyVersionId,
      expectedActiveVersionId: created.policyVersionId,
      expectedRevision: 1,
      expectedKind: 'extraction',
    })
    expect(result).toEqual({ ok: false, error: 'cas_conflict' })
  })

  test('rollback reactivates the prior version with the same CAS rules', async () => {
    await repository.ensureSystemPolicies()
    const first = await repository.createVersion({
      installationId: INSTALLATION,
      kind: 'extraction',
      layer: 'user',
      scopeKey: 'global',
      document: USER_EXTRACTION_DOC,
    })
    if (!first.ok) throw new Error('first create failed')
    // A new set installs its first version as the initial head (revision 1).
    const second = await repository.createVersion({
      installationId: INSTALLATION,
      kind: 'extraction',
      layer: 'user',
      scopeKey: 'global',
      document: { ...USER_EXTRACTION_DOC, mode: 'off' },
    })
    if (!second.ok) throw new Error('second create failed')
    // Activate v2 (head moves, revision bumps), then roll back to v1.
    const activatedSecond = await repository.activateVersion({
      installationId: INSTALLATION,
      policyVersionId: second.policyVersionId,
      expectedActiveVersionId: first.policyVersionId,
      expectedRevision: 1,
    })
    expect(activatedSecond).toBe(true)
    const rolled = await service.rollback({
      installationId: INSTALLATION,
      policyVersionId: first.policyVersionId,
      expectedActiveVersionId: second.policyVersionId,
      expectedRevision: 2,
    })
    expect(rolled.ok).toBe(true)
    resolver.clearCache()
    const versions = await repository.listVersions({
      installationId: INSTALLATION, kind: 'extraction', layer: 'user', scopeKey: 'global',
    })
    expect(versions.find(v => v.policyVersionId === first.policyVersionId)?.active).toBe(true)
    expect(versions.find(v => v.policyVersionId === second.policyVersionId)?.active).toBe(false)
  })

  test('extraction reservation is policy-bound: same policy dedupes, changed policy reruns', async () => {
    await pool.query(`
      INSERT INTO source_sessions (installation_id, session_id, first_recorded_at, last_recorded_at)
      VALUES ($1, 'ses-p', NOW(), NOW())
    `, [INSTALLATION])
    await pool.query(`
      INSERT INTO source_turns (installation_id, turn_id, session_id, state, terminal_at)
      VALUES ($1, 'turn-p', 'ses-p', 'completed', NOW())
    `, [INSTALLATION])
    await pool.query(`
      INSERT INTO work_episodes
        (installation_id, episode_id, session_id, turn_id, state, compiler_version,
         source_digest, document, evidence_manifest, document_compiler_version, compiled_at)
      VALUES ($1, gen_random_uuid(), 'ses-p', 'turn-p', 'ready', 'c-v1',
              decode(md5('pol'),'hex'), '{}'::jsonb, '{}'::jsonb, 'd-v1', NOW())
    `, [INSTALLATION])
    const episodeId = (await pool.query<{ episode_id: string }>(
      `SELECT episode_id::text FROM work_episodes LIMIT 1`)).rows[0].episode_id
    const digest = Buffer.alloc(32, 3)
    const base = {
      installationId: INSTALLATION,
      episodeId,
      sourceDigest: digest,
      extractorVersion: 'extraction-v3',
      promptVersion: 'extraction-prompt-v3',
      modelConfigHash: Buffer.alloc(32, 1),
      mode: 'enabled' as const,
      provider: 'p',
      model: 'm',
      staleAfterMs: 60_000,
    }
    const first = await extraction.reserveRun({ ...base, effectivePolicyHash: canonicalPolicyHash(SYSTEM_EXTRACTION_POLICY_V1) })
    expect(first.owner).toBe(true)
    const second = await extraction.reserveRun({ ...base, effectivePolicyHash: canonicalPolicyHash(SYSTEM_EXTRACTION_POLICY_V1) })
    expect(second.owner).toBe(false)
    // A changed effective policy reserves a NEW run for the same input.
    const changed = await extraction.reserveRun({ ...base, effectivePolicyHash: canonicalPolicyHash(SYSTEM_CONTEXT_POLICY_V1) })
    expect(changed.owner).toBe(true)
    expect(changed.runId).not.toBe(first.runId)
  })
})
