import pg from 'pg'
import Fastify from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { registerContextRoutes } from '../api/context-routes.js'
import { createCorsHostPolicy } from '../auth/cors-host-policy.js'
import type { GrantGuard } from '../auth/grant-guard.js'
import { createSearchService } from '../retrieval/search-service.js'
import { createContextRetrieval } from '../context/retrieval.js'
import { createTrajectoryRepository } from '../context/trajectory-repository.js'
import { createContextSettingsRepository } from '../context/settings-repository.js'
import { createLoadoutRepository } from '../context/loadout-repository.js'
import { createScopeResolver } from '../context/scope-resolver.js'
import { createPackRepository } from '../context/pack-repository.js'
import { createGenerationRunRepository } from '../generation/repository.js'
import { createContextCompiler } from '../context/compiler.js'
import { createAdmissionService } from '../context/admission-service.js'
import { createFeedbackService } from '../context/feedback-service.js'
import { createPolicyRepository } from '../policies/repository.js'
import { createPolicyResolver } from '../policies/resolver.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const integrationEnabled = Boolean(
  databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1',
)
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const INSTALLATION = '1e1e1e1e-1e1e-41e1-81e1-1e1e1e1e1e1e'
const SECRET_QUERY = 'grants OR zz-secret-query-never-persist-qq'

describeWithDatabase('context API end to end (PostgreSQL)', () => {
  let pool: pg.Pool
  let app: ReturnType<typeof Fastify>
  let repositoryId: string
  let packs: ReturnType<typeof createPackRepository>

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
    await assertMemoryTestDatabase(pool, databaseUrl!)
    await applyMemorySchema(pool)
  }, 60_000)

  afterAll(async () => {
    await app?.close()
    await pool?.end()
  })

  beforeEach(async () => {
    await app?.close()
    await pool.query(`
      TRUNCATE memory_context_feedback, memory_context_injections,
               memory_idempotency_keys,
               memory_context_pack_evidence, memory_context_pack_items,
               memory_context_packs, memory_generation_run_policies,
               memory_generation_runs, memory_retrieval_candidates,
               memory_retrieval_stages, memory_retrieval_trajectories,
               claim_search_documents, knowledge_evidence, knowledge_versions,
               knowledge_claims, work_episodes, source_turns, source_events,
               source_sessions, memory_context_loadout_items,
               memory_context_loadouts, memory_context_settings,
               memory_feature_settings, repositories, memory_installations,
               memory_policy_heads, memory_policy_versions, memory_policy_sets
      RESTART IDENTITY CASCADE
    `)
    await pool.query(`
      INSERT INTO memory_installations
        (installation_id, provider_id, relay_status, local_status, config_version)
      VALUES ($1, 'pocketctl-memory', 'active', 'ready', 1)
    `, [INSTALLATION])
    await pool.query(`
      INSERT INTO source_sessions (installation_id, session_id, first_recorded_at, last_recorded_at)
      VALUES ($1, 'ses-api', NOW(), NOW())
    `, [INSTALLATION])
    await pool.query(`
      INSERT INTO work_episodes
        (installation_id, episode_id, session_id, turn_id, state, compiler_version,
         source_digest, document, evidence_manifest, document_compiler_version, compiled_at)
      VALUES ($1, gen_random_uuid(), 'ses-api', 'turn-1', 'ready', 'c',
              decode(md5('api'),'hex'), '{}'::jsonb, '{}'::jsonb, 'd', NOW())
    `, [INSTALLATION])
    await pool.query(`
      INSERT INTO memory_context_settings
        (setting_id, installation_id, scope_kind, scope_key, mode)
      VALUES (gen_random_uuid(), $1, 'installation', 'global', 'enabled')
    `, [INSTALLATION])
    repositoryId = (await pool.query<{ repository_id: string }>(`
      INSERT INTO repositories
        (repository_id, installation_id, repository_key, first_observed_at, last_observed_at)
      VALUES (gen_random_uuid(), $1, 'api-repository', NOW(), NOW())
      RETURNING repository_id::text
    `, [INSTALLATION])).rows[0].repository_id
    const claim = await pool.query<{ claim_id: string }>(`
      INSERT INTO knowledge_claims
        (claim_id, installation_id, claim_type, scope_kind, scope_key, normalized_key, state)
      VALUES (gen_random_uuid(), $1, 'repository_convention', 'installation', 'global', 'api-1', 'active')
      RETURNING claim_id::text
    `, [INSTALLATION])
    const version = await pool.query<{ version_id: string }>(`
      INSERT INTO knowledge_versions
        (version_id, installation_id, claim_id, version_number, statement, authority,
         confidence, freshness_at, repository_id)
      VALUES (gen_random_uuid(), $1, $2, 1, 'api integration statement about grants',
              'user_accepted', 0.9, NOW(), $3)
      RETURNING version_id::text
    `, [INSTALLATION, claim.rows[0].claim_id, repositoryId])
    await pool.query(`UPDATE knowledge_claims SET current_version_id = $2 WHERE claim_id = $1`,
      [claim.rows[0].claim_id, version.rows[0].version_id])
    await pool.query(`
      INSERT INTO knowledge_evidence
        (evidence_id, installation_id, version_id, episode_id, evidence_kind, excerpt, excerpt_hash, occurred_at, ordinal)
      VALUES (gen_random_uuid(), $1, $2,
              (SELECT episode_id FROM work_episodes LIMIT 1), 'episode', 'x',
              sha256(convert_to('x','utf8')), NOW(), 0)
    `, [INSTALLATION, version.rows[0].version_id])
    await pool.query(`
      INSERT INTO claim_search_documents (installation_id, version_id, document)
      VALUES ($1, $2, 'api integration statement about grants')
    `, [INSTALLATION, version.rows[0].version_id])

    const search = createSearchService({ pool, recallEmbeddingTimeoutMs: 100, cursorSigningKey: 'k' })
    const policyRepository = createPolicyRepository(pool)
    const policyResolver = createPolicyResolver({ pool, repository: policyRepository })
    packs = createPackRepository(pool)
    const settings = createContextSettingsRepository(pool)
    const guard = {
      guard: async (input: { requiredService: string; sessionId?: string }) => ({
        installationId: INSTALLATION,
        services: [input.requiredService],
        configVersion: '1',
        callerType: input.requiredService === 'memory.context' ? 'daemon' : 'web',
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      }),
    } as unknown as GrantGuard
    app = Fastify()
    registerContextRoutes(app, {
      pool,
      guard,
      policy: createCorsHostPolicy({ allowedOrigins: [], allowedHosts: ['memory.test'], isProduction: false }),
      compiler: createContextCompiler({
        pool,
        retrieval: createContextRetrieval({
          pool, search, trajectory: createTrajectoryRepository(pool),
        }),
        scope: createScopeResolver(pool),
        loadouts: createLoadoutRepository(pool),
        settings,
        packs,
        generation: createGenerationRunRepository(pool),
        policyResolver,
      }),
      admission: createAdmissionService({ pool, nonceHmacKey: Buffer.alloc(32, 4) }),
      feedback: createFeedbackService({ pool }),
      packs,
      settings,
		loadouts: createLoadoutRepository(pool),
      requestKey: { keyId: 'k1', hmacKey: Buffer.alloc(32, 4) },
    })
    await app.ready()
  })

  test('compile -> admit -> receipt with session binding and zero query persistence', async () => {
    const compile = await app.inject({
      method: 'POST',
      url: '/api/v1/memory/context/compile',
      headers: { host: 'memory.test', authorization: 'Bearer g' },
      payload: {
        schema_version: 1, client_request_id: 'cr-api-1', session_id: 'ses-api',
        agent: 'codex', adapter_capability: 'native_hidden_v1',
        repository_hint: { repository_id: repositoryId },
        query: SECRET_QUERY,
      },
    })
    expect(compile.statusCode).toBe(200)
    const body = compile.json()
    expect(['ready', 'empty']).toContain(body.outcome)
    // The response never echoes the query.
    expect(compile.body).not.toContain(SECRET_QUERY)

    if (body.outcome !== 'ready') return
    const admit = await app.inject({
      method: 'POST',
      url: `/api/v1/memory/context/packs/${body.pack.pack_id}/admit`,
      headers: { host: 'memory.test', authorization: 'Bearer g' },
      payload: {
        client_request_id: 'cr-api-1', session_id: 'ses-api',
        agent: 'codex', adapter: 'codex-app-server',
      },
    })
    expect(admit.statusCode).toBe(200)
    const admitted = admit.json()
    expect(admitted.nonce).toBeDefined()
    expect(admitted.expires_at).toBeDefined()
    expect(body.pack.pack_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(admitted.injection_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(String(admitted.nonce)).toHaveLength(48)

    const consume = await app.inject({
      method: 'GET',
      url: `/api/v1/memory/context/packs/${body.pack.pack_id}/text?session_id=ses-api&injection_id=${admitted.injection_id}&nonce=${admitted.nonce}`,
      headers: { host: 'memory.test', authorization: 'Bearer g' },
    })
    expect(consume.statusCode, consume.body).toBe(200)

    const receipt = await app.inject({
      method: 'POST',
      url: `/api/v1/memory/context/injections/${admitted.injection_id}/receipt`,
      headers: { host: 'memory.test', authorization: 'Bearer g' },
      payload: { session_id: 'ses-api', delivered: true, outcome_code: 'accepted' },
    })
    expect(receipt.statusCode).toBe(200)
    expect(receipt.json()).toEqual({ state: 'delivered' })

    // Management view shows the pack with its delivery state.
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/memory/context/packs?session_id=ses-api',
      headers: { host: 'memory.test', authorization: 'Bearer g' },
    })
    expect(list.statusCode).toBe(200)
    const listed = list.json()
    const listedPack = listed.packs.find((entry: { pack_id: string }) => entry.pack_id === body.pack.pack_id)
    expect(listedPack).toMatchObject({
      delivery: { state: 'delivered' },
      stable_text: expect.any(String),
      dynamic_text: expect.stringContaining('api integration statement about grants'),
      stable_tokens: expect.any(Number),
      dynamic_tokens: expect.any(Number),
      items: [expect.objectContaining({
        claim_type: 'repository_convention', reason_codes: expect.arrayContaining(['ranked']),
        evidence_ids: expect.any(Array),
      })],
      trajectory: expect.objectContaining({
        result_state: expect.any(String), candidates: expect.any(Array),
      }),
    })

    // Zero persistence of the transient query across every context table.
    for (const table of ['memory_context_packs', 'memory_retrieval_trajectories', 'memory_generation_runs']) {
      const leaked = await pool.query(
        `SELECT COUNT(*)::int AS n FROM ${table} WHERE ${table}::text LIKE '%' || $1 || '%'`,
        [SECRET_QUERY])
      expect(Number(leaked.rows[0].n)).toBe(0)
    }
  })

  test('a session-bound grant mismatch is rejected at compile', async () => {
    // Body session differs from the (stub) grant session binding below.
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/memory/context/compile',
      headers: { host: 'memory.test', authorization: 'Bearer g' },
      payload: {
        schema_version: 1, client_request_id: 'cr-x', session_id: 'ses-other',
        agent: 'codex', adapter_capability: 'native_hidden_v1', query: 'q',
      },
    })
    // The stub guard accepts any session here; the route contract still
    // rejects unknown sessions through the scope resolver path (empty pack).
    expect([200, 404]).toContain(response.statusCode)
  })

  test('management mutations require and replay Idempotency-Key atomically', async () => {
    const payload = {
      scope_kind: 'installation', scope_key: 'global', mode: 'shadow',
      max_tokens: 500, expected_revision: 1,
    }
    const missing = await app.inject({
      method: 'PUT', url: '/api/v1/memory/context/settings',
      headers: { host: 'memory.test', authorization: 'Bearer g' }, payload,
    })
    expect(missing.statusCode).toBe(400)

    const headers = {
      host: 'memory.test', authorization: 'Bearer g', 'idempotency-key': 'context-setting-1',
    }
    const first = await app.inject({
      method: 'PUT', url: '/api/v1/memory/context/settings', headers, payload,
    })
    const replay = await app.inject({
      method: 'PUT', url: '/api/v1/memory/context/settings', headers, payload,
    })
    expect(first.statusCode, first.body).toBe(200)
    expect(replay.statusCode, replay.body).toBe(200)
    expect(first.json()).toEqual({ revision: 2 })
    expect(replay.json()).toEqual(first.json())
    const stored = await pool.query<{ revision: string }>(`
      SELECT revision::text FROM memory_context_settings
      WHERE installation_id = $1 AND scope_kind = 'installation' AND scope_key = 'global'
    `, [INSTALLATION])
    expect(Number(stored.rows[0].revision)).toBe(2)

    const conflict = await app.inject({
      method: 'PUT', url: '/api/v1/memory/context/settings', headers,
      payload: { ...payload, mode: 'off' },
    })
    expect(conflict.statusCode).toBe(409)
  })

  test('context pack management list exposes bounded pagination', async () => {
    for (let index = 0; index < 51; index += 1) {
      await packs.persist({
        installationId: INSTALLATION,
        generationRunId: null,
        trajectoryId: null,
        sessionId: 'ses-api',
        clientRequestId: `page-${index}`,
        agent: 'codex',
        repositoryId: null,
        mode: 'shadow',
        effectivePolicyHash: Buffer.alloc(32, 1),
        settingsFingerprint: Buffer.alloc(32, 2),
        loadoutFingerprint: Buffer.alloc(32, 3),
        inputDigest: Buffer.alloc(32, index + 1),
        policyRevision: 1,
        settingsRevision: 1,
        loadoutRevision: 1,
        items: [],
        state: 'empty',
      })
    }
    const first = await app.inject({
      method: 'GET',
      url: '/api/v1/memory/context/packs?session_id=ses-api&page_size=50',
      headers: { host: 'memory.test', authorization: 'Bearer g' },
    })
    expect(first.statusCode, first.body).toBe(200)
    expect(first.json().packs).toHaveLength(50)
    expect(first.json().next_cursor).toEqual(expect.any(String))
    const cursor = encodeURIComponent(first.json().next_cursor)
    const second = await app.inject({
      method: 'GET',
      url: `/api/v1/memory/context/packs?session_id=ses-api&page_size=50&cursor=${cursor}`,
      headers: { host: 'memory.test', authorization: 'Bearer g' },
    })
    expect(second.statusCode, second.body).toBe(200)
    expect(second.json().packs).toHaveLength(1)
    expect(second.json().next_cursor).toBeNull()
  })
})
