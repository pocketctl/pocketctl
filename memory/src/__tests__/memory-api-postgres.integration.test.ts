import pg from 'pg'
import Fastify from 'fastify'
import { generateKeyPairSync } from 'crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import {
  publicJwks,
  resolveGrantKeyMaterial,
  signCapabilityGrant,
} from '../../../relay/src/extensions/capability-grant.js'
import { createGrantGuard } from '../auth/grant-guard.js'
import { createCorsHostPolicy } from '../auth/cors-host-policy.js'
import { registerReadRoutes } from '../api/read-routes.js'
import { registerManageRoutes } from '../api/manage-routes.js'
import { createSettingsRepository } from '../settings/repository.js'
import { normalizedClaimKey } from '../retrieval/query-normalizer.js'
import { tombstoneIdentityHmac } from '../claims/tombstones.js'
import { createPackRepository } from '../context/pack-repository.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const integrationEnabled = Boolean(
  databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1',
)
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const INSTALLATION = 'aaaaaaa7-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_INSTALLATION = 'aaaaaaa8-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const EVIDENCE_HANDLE = 'h0-aaaaaaaa'

describeWithDatabase('memory api under real capability grants (PostgreSQL)', () => {
  let pool: pg.Pool
  let app: ReturnType<typeof Fastify>
  let jwksApp: ReturnType<typeof Fastify>
  let keys: ReturnType<typeof resolveGrantKeyMaterial>
  let guard: ReturnType<typeof createGrantGuard>
  let policy: ReturnType<typeof createCorsHostPolicy>
  let candidateId: string
  let reviewDecisionMetrics = 0
  let candidateStatusMetrics = 0

  const issueGrant = (services: string[], options: { installationId?: string; configVersion?: string } = {}) =>
    signCapabilityGrant(keys, {
      issuer: 'https://relay.test',
      providerId: 'pocketctl-memory',
      installationId: options.installationId ?? INSTALLATION,
      userId: 42,
      callerType: 'web',
      services,
      configVersion: options.configVersion ?? '3',
    })

  const authHeaders = (services: string[], options?: Parameters<typeof issueGrant>[1]) => ({
    host: 'memory.example',
    authorization: `Bearer ${issueGrant(services, options)}`,
  })

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
    await assertMemoryTestDatabase(pool, databaseUrl!)
    await applyMemorySchema(pool)

    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
    keys = resolveGrantKeyMaterial({
      EXTENSION_GRANT_PRIVATE_KEY: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      EXTENSION_GRANT_PUBLIC_KEY: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      EXTENSION_GRANT_KEY_ID: 'test-kid',
    })

    // Minimal Relay JWKS stub the verifier will hit.
    jwksApp = Fastify()
    jwksApp.get('/.well-known/pocketctl-extension-jwks.json', async () => publicJwks(keys))
    await jwksApp.listen({ port: 0, host: '127.0.0.1' })
    const jwksPort = (jwksApp.server.address() as { port: number }).port
    const relayUrl = `http://127.0.0.1:${jwksPort}`

    app = Fastify()
    guard = createGrantGuard({ pool, relayUrl, relayIssuer: 'https://relay.test' })
    policy = createCorsHostPolicy({
      allowedOrigins: [], allowedHosts: ['memory.example'], isProduction: false,
    })
    registerReadRoutes(app, {
      pool, guard, policy, recallEmbeddingTimeoutMs: 100,
      cursorSigningKey: 'test-cursor-signing-key',
    })
    registerManageRoutes(app, {
      pool, guard, policy, textConfigured: false, embeddingConfigured: false,
      tombstoneHmacKeys: [{ version: 'v1', key: 't'.repeat(32) }],
      phase1Metrics: {
        reviewDecisions: { inc: () => { reviewDecisionMetrics++ } },
        candidateStatus: { inc: () => { candidateStatusMetrics++ } },
      } as never,
    })
  }, 60_000)

  afterAll(async () => {
    await app?.close()
    await jwksApp?.close()
    await pool?.end()
  })

  beforeEach(async () => {
    reviewDecisionMetrics = 0
    candidateStatusMetrics = 0
    await pool.query(`
      TRUNCATE memory_context_feedback, memory_context_injections,
               memory_context_pack_evidence, memory_context_pack_items,
               memory_context_packs, memory_generation_runs,
               memory_idempotency_keys, memory_feedback, memory_jobs,
               claim_search_documents, knowledge_evidence, memory_candidates,
               memory_extraction_runs, knowledge_versions, knowledge_claims,
               knowledge_tombstones, work_episodes, source_turns, source_events,
               source_sessions, memory_feature_settings, memory_installations
      RESTART IDENTITY CASCADE
    `)
    for (const installationId of [INSTALLATION, OTHER_INSTALLATION]) {
      await pool.query(`
        INSERT INTO memory_installations
          (installation_id, provider_id, relay_status, local_status, config_version)
        VALUES ($1, 'pocketctl-memory', 'active', 'ready', 3)
      `, [installationId])
      await pool.query(`
        INSERT INTO memory_feature_settings (installation_id) VALUES ($1)
      `, [installationId])
    }
    await pool.query(`
      INSERT INTO source_sessions
        (installation_id, session_id, first_recorded_at, last_recorded_at)
      VALUES ($1, 'ses-1', NOW(), NOW())
    `, [INSTALLATION])
    await pool.query(`
      INSERT INTO source_turns (installation_id, turn_id, session_id, state, terminal_at)
      VALUES ($1, 'turn-1', 'ses-1', 'completed', NOW())
    `, [INSTALLATION])
    const episode = await pool.query<{ episode_id: string }>(`
      INSERT INTO work_episodes
        (installation_id, episode_id, session_id, turn_id, state, compiler_version,
         document, evidence_manifest, compiled_at)
      VALUES ($1, gen_random_uuid(), 'ses-1', 'turn-1', 'ready', 'v1',
              $2::jsonb, $3::jsonb, NOW())
      RETURNING episode_id::text
    `, [INSTALLATION,
      JSON.stringify({ final_outcome: { text: 'Prefer trunk-based development for this repo', evidence_handle: EVIDENCE_HANDLE } }),
      JSON.stringify({ [EVIDENCE_HANDLE]: { kind: 'episode' } })])
    const run = await pool.query<{ run_id: string }>(`
      INSERT INTO memory_extraction_runs
        (run_id, installation_id, episode_id, episode_source_digest, extractor_version,
         prompt_version, model_config_hash, input_digest, mode, state, provider, model)
      VALUES (gen_random_uuid(), $1, $2, 'x'::bytea, 'e', 'p', 'x'::bytea, 'x'::bytea,
              'enabled', 'succeeded', 'openai-compatible', 'm')
      RETURNING run_id::text
    `, [INSTALLATION, episode.rows[0].episode_id])
    const candidate = await pool.query<{ candidate_id: string }>(`
      INSERT INTO memory_candidates
        (candidate_id, installation_id, run_id, episode_id, ordinal, claim_type, statement,
         normalized_key, scope_kind, scope_key, confidence, freshness_at, evidence_handles, status)
      VALUES (gen_random_uuid(), $1, $2, $3, 0, 'work_method',
              'Prefer trunk-based development for this repo', 'key-api-1',
              'installation', 'global', 0.9, NOW(), $4::jsonb, 'validated')
      RETURNING candidate_id::text
    `, [INSTALLATION, run.rows[0].run_id, episode.rows[0].episode_id,
      JSON.stringify([EVIDENCE_HANDLE])])
    candidateId = candidate.rows[0].candidate_id
  })

  test('a valid grant searches claims through the REST surface', async () => {
    // Seed one active claim the search can find.
    const claim = await pool.query<{ claim_id: string }>(`
      INSERT INTO knowledge_claims
        (claim_id, installation_id, claim_type, scope_kind, scope_key, normalized_key, state)
      VALUES (gen_random_uuid(), $1, 'work_method', 'installation', 'global', 'key-api-1', 'active')
      RETURNING claim_id::text
    `, [INSTALLATION])
    const version = await pool.query<{ version_id: string }>(`
      INSERT INTO knowledge_versions
        (version_id, installation_id, claim_id, version_number, statement, authority, confidence)
      VALUES (gen_random_uuid(), $1, $2, 1, 'Prefer trunk-based development for this repo',
              'user_accepted', 0.9)
      RETURNING version_id::text
    `, [INSTALLATION, claim.rows[0].claim_id])
    await pool.query(`UPDATE knowledge_claims SET current_version_id = $2 WHERE claim_id = $1`,
      [claim.rows[0].claim_id, version.rows[0].version_id])
    await pool.query(`
      INSERT INTO knowledge_evidence
        (evidence_id, installation_id, version_id, episode_id, evidence_kind,
         excerpt, excerpt_hash, occurred_at, ordinal)
      SELECT gen_random_uuid(), $1, $2, episode_id, 'episode', 'api evidence',
             sha256(convert_to('api evidence', 'utf8')), NOW(), 0
      FROM work_episodes WHERE installation_id = $1 LIMIT 1
    `, [INSTALLATION, version.rows[0].version_id])
    await pool.query(`
      INSERT INTO claim_search_documents (installation_id, version_id, document)
      VALUES ($1, $2, 'Prefer trunk-based development for this repo work_method')
    `, [INSTALLATION, version.rows[0].version_id])

    const response = await app.inject({
      method: 'POST', url: '/api/v1/memory/search',
      headers: authHeaders(['memory.search']),
      payload: { query: 'trunk-based development' },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.hits.length).toBe(1)
    expect(body.hits[0].claimId).toBe(claim.rows[0].claim_id)
  })

  test('stale config versions and wrong services answer the same uniform 401', async () => {
    const stale = await app.inject({
      method: 'POST', url: '/api/v1/memory/search',
      headers: authHeaders(['memory.search'], { configVersion: '2' }),
      payload: { query: 'anything' },
    })
    expect(stale.statusCode).toBe(401)
    expect(stale.json().error.code).toBe('unauthorized')

    const wrongService = await app.inject({
      method: 'GET', url: '/api/v1/memory/candidates',
      headers: authHeaders(['memory.search']),
    })
    expect(wrongService.statusCode).toBe(401)
    expect(wrongService.json()).toEqual(stale.json())
  })

  test('cross-installation resources are a 404, not a leak', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/memory/claims/${'11111111-1111-4111-8111-111111111111'}`,
      headers: authHeaders(['memory.search']),
    })
    expect(response.statusCode).toBe(404)
    const body = response.json()
    expect(body.error.code).toBe('not_found')
    expect(JSON.stringify(body)).not.toContain(OTHER_INSTALLATION)
  })

  test('lists only active claims for the granted installation with stable pagination', async () => {
    const seedClaim = async (input: {
      installationId: string
      state: 'active' | 'revoked'
      statement: string
      updatedAt: string
    }) => {
      const claim = await pool.query<{ claim_id: string }>(`
        INSERT INTO knowledge_claims
          (claim_id, installation_id, claim_type, scope_kind, scope_key,
           normalized_key, state, updated_at)
        VALUES (gen_random_uuid(), $1, 'work_method', 'installation', 'global',
                $2, $3, $4::timestamptz)
        RETURNING claim_id::text
      `, [input.installationId, `list-${input.statement}`, input.state, input.updatedAt])
      const version = await pool.query<{ version_id: string }>(`
        INSERT INTO knowledge_versions
          (version_id, installation_id, claim_id, version_number, statement,
           authority, confidence, freshness_at)
        VALUES (gen_random_uuid(), $1, $2, 1, $3, 'user_accepted', 1, $4::timestamptz)
        RETURNING version_id::text
      `, [input.installationId, claim.rows[0].claim_id, input.statement, input.updatedAt])
      await pool.query(`
        UPDATE knowledge_claims
        SET current_version_id = $2, updated_at = $3::timestamptz
        WHERE installation_id = $1 AND claim_id = $4
      `, [input.installationId, version.rows[0].version_id, input.updatedAt, claim.rows[0].claim_id])
      return claim.rows[0].claim_id
    }

    const olderClaimId = await seedClaim({
      installationId: INSTALLATION,
      state: 'active',
      statement: 'Older active knowledge',
      updatedAt: '2026-08-27T10:00:00.000Z',
    })
    const newerClaimId = await seedClaim({
      installationId: INSTALLATION,
      state: 'active',
      statement: 'Newer active knowledge',
      updatedAt: '2026-08-28T10:00:00.000Z',
    })
    await seedClaim({
      installationId: INSTALLATION,
      state: 'revoked',
      statement: 'Revoked knowledge',
      updatedAt: '2026-08-29T10:00:00.000Z',
    })
    await seedClaim({
      installationId: OTHER_INSTALLATION,
      state: 'active',
      statement: 'Other installation knowledge',
      updatedAt: '2026-08-30T10:00:00.000Z',
    })

    const first = await app.inject({
      method: 'GET', url: '/api/v1/memory/claims?state=active&limit=1',
      headers: authHeaders(['memory.search']),
    })
    expect(first.statusCode).toBe(200)
    expect(first.json()).toMatchObject({
      total_count: 2,
      claims: [{ claim_id: newerClaimId, statement: 'Newer active knowledge', state: 'active' }],
    })
    expect(first.json().next_cursor).toEqual(expect.any(String))

    const second = await app.inject({
      method: 'GET',
      url: `/api/v1/memory/claims?state=active&limit=1&cursor=${encodeURIComponent(first.json().next_cursor)}`,
      headers: authHeaders(['memory.search']),
    })
    expect(second.statusCode).toBe(200)
    expect(second.json()).toMatchObject({
      total_count: 2,
      claims: [{ claim_id: olderClaimId, statement: 'Older active knowledge', state: 'active' }],
      next_cursor: null,
    })
    expect(JSON.stringify([first.json(), second.json()])).not.toContain('Other installation knowledge')
    expect(JSON.stringify([first.json(), second.json()])).not.toContain('Revoked knowledge')
  })

  test('accept runs end-to-end with idempotent replay', async () => {
    const headers = {
      ...authHeaders(['memory.manage']),
      'idempotency-key': 'accept-1',
    }
    const request = () => app.inject({
      method: 'POST', url: `/api/v1/memory/candidates/${candidateId}/accept`,
      headers,
      payload: { expected_revision: 1 },
    })
    const first = await request()
    expect(first.statusCode).toBe(200)
    const second = await request()
    expect(second.statusCode).toBe(200)
    expect(second.json().claim_id).toBe(first.json().claim_id)
    const claims = await pool.query(`SELECT COUNT(*)::int AS count FROM knowledge_claims`)
    expect(claims.rows[0].count).toBe(1)
    expect(reviewDecisionMetrics).toBe(1)
    expect(candidateStatusMetrics).toBe(1)
  })

  test('a stale revision surfaces only the current revision and state', async () => {
    const response = await app.inject({
      method: 'POST', url: `/api/v1/memory/candidates/${candidateId}/accept`,
      headers: { ...authHeaders(['memory.manage']), 'idempotency-key': 'accept-stale' },
      payload: { expected_revision: 99 },
    })
    expect(response.statusCode).toBe(409)
    const body = response.json()
    expect(body.error.code).toBe('revision_conflict')
    expect(body.error.current_revision).toBe(1)
    expect(body.error.state).toBe('validated')
    expect(JSON.stringify(body).length).toBeLessThan(512)
  })

  test('settings refuse shadow modes while adapters are unconfigured', async () => {
    const response = await app.inject({
      method: 'PATCH', url: '/api/v1/memory/settings',
      headers: { ...authHeaders(['memory.manage']), 'idempotency-key': 'settings-1' },
      payload: { expected_revision: 1, extraction_mode: 'shadow' },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('invalid_request')
  })

  test('settings enforce first-write CAS and provider-specific consent', async () => {
    await pool.query(`DELETE FROM memory_feature_settings WHERE installation_id = $1`, [INSTALLATION])
    const settings = createSettingsRepository(pool, {
      textConfigured: true,
      embeddingConfigured: true,
      extractionConsentFingerprint: 'a'.repeat(64),
      embeddingConsentFingerprint: 'b'.repeat(64),
    })
    await expect(settings.update({
      installationId: INSTALLATION,
      expectedRevision: 9,
      extractionMode: 'enabled',
      confirmExtractionFingerprint: 'a'.repeat(64),
    })).resolves.toMatchObject({ ok: false, code: 'revision_conflict' })
    await expect(settings.update({
      installationId: INSTALLATION,
      expectedRevision: 1,
      extractionMode: 'enabled',
    })).resolves.toMatchObject({ ok: false, code: 'extraction_consent_required' })
    const accepted = await settings.update({
      installationId: INSTALLATION,
      expectedRevision: 1,
      extractionMode: 'enabled',
      confirmExtractionFingerprint: 'a'.repeat(64),
    })
    expect(accepted).toMatchObject({ ok: true, settings: { extractionMode: 'enabled', revision: 2 } })
    await expect(settings.update({
      installationId: INSTALLATION,
      expectedRevision: 1,
      extractionMode: 'off',
    })).resolves.toMatchObject({ ok: false, code: 'revision_conflict' })
    const disabled = await settings.update({
      installationId: INSTALLATION,
      expectedRevision: 2,
      extractionMode: 'off',
    })
    expect(disabled).toMatchObject({
      ok: true,
      settings: { extractionMode: 'off', extractionConsentFingerprint: null, revision: 3 },
    })
    await expect(settings.update({
      installationId: INSTALLATION,
      expectedRevision: 3,
      extractionMode: 'enabled',
    })).resolves.toMatchObject({ ok: false, code: 'extraction_consent_required' })
  })

  test('concurrent first settings writers produce one revision-two winner', async () => {
    await pool.query(`DELETE FROM memory_feature_settings WHERE installation_id = $1`, [INSTALLATION])
    const settings = createSettingsRepository(pool, {
      textConfigured: true,
      embeddingConfigured: false,
    })
    const results = await Promise.all([
      settings.update({ installationId: INSTALLATION, expectedRevision: 1, extractionMode: 'enabled' }),
      settings.update({ installationId: INSTALLATION, expectedRevision: 1, extractionMode: 'shadow' }),
    ])
    expect(results.filter(result => result.ok)).toHaveLength(1)
    expect(results.filter(result => !result.ok)).toEqual([
      expect.objectContaining({ ok: false, code: 'revision_conflict' }),
    ])
    const persisted = await settings.get(INSTALLATION)
    expect(persisted.revision).toBe(2)
  })

  test('privacy deletion tombstones every historical claim identity', async () => {
    const oldStatement = 'Use the legacy release checklist'
    const currentStatement = 'Use the reviewed release checklist'
    const currentKey = normalizedClaimKey({
      claimType: 'work_method', scopeKey: 'global', statement: currentStatement,
    })
    const claim = await pool.query<{ claim_id: string }>(`
      INSERT INTO knowledge_claims
        (claim_id, installation_id, claim_type, scope_kind, scope_key, normalized_key, state, revision)
      VALUES (gen_random_uuid(), $1, 'work_method', 'installation', 'global', $2, 'active', 2)
      RETURNING claim_id::text
    `, [INSTALLATION, currentKey])
    const versions = await pool.query<{ version_id: string; version_number: number }>(`
      INSERT INTO knowledge_versions
        (version_id, installation_id, claim_id, version_number, statement, authority, confidence, freshness_at)
      VALUES
        (gen_random_uuid(), $1, $2, 1, $3, 'user_accepted', 1, NOW() - INTERVAL '1 day'),
        (gen_random_uuid(), $1, $2, 2, $4, 'user_corrected', 1, NOW())
      RETURNING version_id::text, version_number
    `, [INSTALLATION, claim.rows[0].claim_id, oldStatement, currentStatement])
    const currentVersion = versions.rows.find(version => version.version_number === 2)!
    await pool.query(`
      UPDATE knowledge_claims SET current_version_id = $2
      WHERE installation_id = $1 AND claim_id = $3
    `, [INSTALLATION, currentVersion.version_id, claim.rows[0].claim_id])

    const detail = await app.inject({
      method: 'GET', url: `/api/v1/memory/claims/${claim.rows[0].claim_id}`,
      headers: authHeaders(['memory.search']),
    })
    expect(detail.statusCode).toBe(200)
    expect(detail.json().claim).toMatchObject({ scope_kind: 'installation', scope_key: 'global' })
    expect(detail.json().versions.every((version: { freshness_at: string | null }) => Boolean(version.freshness_at))).toBe(true)

    const response = await app.inject({
      method: 'DELETE', url: `/api/v1/memory/claims/${claim.rows[0].claim_id}`,
      headers: { ...authHeaders(['memory.manage']), 'idempotency-key': 'delete-history' },
      payload: { expected_revision: 2 },
    })
    expect(response.statusCode).toBe(200)
    const historicalKeys = [oldStatement, currentStatement].map(statement => normalizedClaimKey({
      claimType: 'work_method', scopeKey: 'global', statement,
    }))
    for (const key of historicalKeys) {
      const tombstone = await pool.query<{ count: number }>(`
        SELECT COUNT(*)::int AS count FROM knowledge_tombstones
        WHERE installation_id = $1 AND key_id = 'v1' AND identity_hmac = $2
      `, [INSTALLATION, tombstoneIdentityHmac(key, 't'.repeat(32))])
      expect(tombstone.rows[0].count).toBe(1)
    }
  })

  test('claim revocation atomically invalidates dependent pending context packs', async () => {
    const claim = await pool.query<{ claim_id: string }>(`
      INSERT INTO knowledge_claims
        (claim_id, installation_id, claim_type, scope_kind, scope_key, normalized_key, state, revision)
      VALUES (gen_random_uuid(), $1, 'repository_convention', 'installation', 'global',
              'revoke-context-pack', 'active', 1)
      RETURNING claim_id::text
    `, [INSTALLATION])
    const version = await pool.query<{ version_id: string }>(`
      INSERT INTO knowledge_versions
        (version_id, installation_id, claim_id, version_number, statement, authority, confidence, freshness_at)
      VALUES (gen_random_uuid(), $1, $2, 1, 'context pack source', 'user_accepted', 1, NOW())
      RETURNING version_id::text
    `, [INSTALLATION, claim.rows[0].claim_id])
    await pool.query(`UPDATE knowledge_claims SET current_version_id = $2 WHERE claim_id = $1`,
      [claim.rows[0].claim_id, version.rows[0].version_id])
    const evidence = await pool.query<{ evidence_id: string }>(`
      INSERT INTO knowledge_evidence
        (evidence_id, installation_id, version_id, episode_id, evidence_kind,
         excerpt, excerpt_hash, occurred_at, ordinal)
      SELECT gen_random_uuid(), $1, $2, episode_id, 'episode', 'context source',
             sha256(convert_to('context source', 'utf8')), NOW(), 0
      FROM work_episodes WHERE installation_id = $1 LIMIT 1
      RETURNING evidence_id::text
    `, [INSTALLATION, version.rows[0].version_id])
    const packId = await createPackRepository(pool).persist({
      installationId: INSTALLATION, generationRunId: null, trajectoryId: null, sessionId: 'ses-1',
      clientRequestId: 'cr-claim-revoke', agent: 'codex', repositoryId: null, mode: 'enabled',
      effectivePolicyHash: Buffer.alloc(32, 1), settingsFingerprint: Buffer.alloc(32, 2),
      loadoutFingerprint: Buffer.alloc(32, 3), inputDigest: Buffer.alloc(32, 4),
      policyRevision: 1, settingsRevision: 1, loadoutRevision: 1, state: 'ready',
      items: [{
        itemId: crypto.randomUUID(), claimId: claim.rows[0].claim_id,
        versionId: version.rows[0].version_id, claimType: 'repository_convention',
        layer: 'L2', section: 'dynamic', representation: 'summary',
        statement: 'context pack source', scopeKind: 'installation',
        reasonCodes: ['ranked'], evidenceIds: [evidence.rows[0].evidence_id],
      }],
    })

    const response = await app.inject({
      method: 'POST', url: `/api/v1/memory/claims/${claim.rows[0].claim_id}/revoke`,
      headers: { ...authHeaders(['memory.manage']), 'idempotency-key': 'revoke-context-pack' },
      payload: { expected_revision: 1 },
    })
    expect(response.statusCode).toBe(200)
    const pack = await pool.query<{ state: string; error_code: string }>(
      `SELECT state, error_code FROM memory_context_packs WHERE pack_id = $1`, [packId])
    expect(pack.rows[0]).toEqual({ state: 'invalidated', error_code: 'claim_state_changed' })
  })

  test('enabling configured modes backfills stable episodes and active claim indexes', async () => {
    await pool.query(`
      UPDATE work_episodes SET source_digest = decode(repeat('ab', 32), 'hex'),
        document_compiler_version = 'packet-v1'
      WHERE installation_id = $1
    `, [INSTALLATION])
    const claim = await pool.query<{ claim_id: string }>(`
      INSERT INTO knowledge_claims
        (claim_id, installation_id, claim_type, scope_kind, scope_key, normalized_key, state)
      VALUES (gen_random_uuid(), $1, 'work_method', 'installation', 'backfill', 'backfill-key', 'active')
      RETURNING claim_id::text
    `, [INSTALLATION])
    const version = await pool.query<{ version_id: string }>(`
      INSERT INTO knowledge_versions
        (version_id, installation_id, claim_id, version_number, statement, authority, confidence)
      VALUES (gen_random_uuid(), $1, $2, 1, 'Backfill claim', 'user_accepted', 1)
      RETURNING version_id::text
    `, [INSTALLATION, claim.rows[0].claim_id])
    await pool.query(`UPDATE knowledge_claims SET current_version_id = $2 WHERE claim_id = $1`,
      [claim.rows[0].claim_id, version.rows[0].version_id])

    const configured = Fastify()
    registerManageRoutes(configured, {
      pool, guard, policy, textConfigured: true, embeddingConfigured: true,
      extractionAdapter: {
        provider: 'openai-compatible', origin: 'https://text.example', model: 'text-v1', fingerprint: 'a'.repeat(64), pricing_configured: false,
      },
      embeddingAdapter: {
        provider: 'openai-compatible', origin: 'https://embed.example', model: 'embed-v1', fingerprint: 'b'.repeat(64), pricing_configured: true,
      },
      tombstoneHmacKeys: [{ version: 'v1', key: 't'.repeat(32) }],
    })
    try {
      const response = await configured.inject({
        method: 'PATCH', url: '/api/v1/memory/settings',
        headers: { ...authHeaders(['memory.manage']), 'idempotency-key': 'settings-backfill' },
        payload: {
          expected_revision: 1,
          extraction_mode: 'enabled',
          embedding_mode: 'enabled',
          confirm_extraction_fingerprint: 'a'.repeat(64),
          confirm_embedding_fingerprint: 'b'.repeat(64),
        },
      })
      expect(response.statusCode).toBe(200)
      const jobs = await pool.query<{ job_type: string }>(`
        SELECT job_type FROM memory_jobs WHERE installation_id = $1 ORDER BY job_type
      `, [INSTALLATION])
      expect(jobs.rows.map(row => row.job_type)).toEqual(['extract_candidates', 'rebuild_claim_index'])
    } finally {
      await configured.close()
    }
  })

  test('re-enabling extraction requeues a job that completed while consent was off', async () => {
    await pool.query(`
      UPDATE work_episodes SET source_digest = decode(repeat('ab', 32), 'hex'),
        document_compiler_version = 'packet-v1'
      WHERE installation_id = $1
    `, [INSTALLATION])

    const configured = Fastify()
    registerManageRoutes(configured, {
      pool, guard, policy, textConfigured: true, embeddingConfigured: false,
      extractionAdapter: {
        provider: 'openai-compatible', origin: 'https://text.example', model: 'text-v1', fingerprint: 'a'.repeat(64), pricing_configured: false,
      },
      tombstoneHmacKeys: [{ version: 'v1', key: 't'.repeat(32) }],
    })
    try {
      const enable = await configured.inject({
        method: 'PATCH', url: '/api/v1/memory/settings',
        headers: { ...authHeaders(['memory.manage']), 'idempotency-key': 'settings-enable-first' },
        payload: {
          expected_revision: 1,
          extraction_mode: 'enabled',
          confirm_extraction_fingerprint: 'a'.repeat(64),
        },
      })
      expect(enable.statusCode).toBe(200)
      const disable = await configured.inject({
        method: 'PATCH', url: '/api/v1/memory/settings',
        headers: { ...authHeaders(['memory.manage']), 'idempotency-key': 'settings-disable' },
        payload: { expected_revision: 2, extraction_mode: 'off' },
      })
      expect(disable.statusCode).toBe(200)

      await pool.query(`
        UPDATE memory_jobs
        SET state = 'completed', attempts = 1, completed_at = NOW(),
            claimed_by = 'worker-that-observed-off', claim_expires_at = NULL
        WHERE installation_id = $1 AND job_type = 'extract_candidates'
      `, [INSTALLATION])

      const reenable = await configured.inject({
        method: 'PATCH', url: '/api/v1/memory/settings',
        headers: { ...authHeaders(['memory.manage']), 'idempotency-key': 'settings-enable-again' },
        payload: {
          expected_revision: 3,
          extraction_mode: 'enabled',
          confirm_extraction_fingerprint: 'a'.repeat(64),
        },
      })
      expect(reenable.statusCode).toBe(200)
      const job = await pool.query<{
        state: string
        attempts: number
        claimed_by: string | null
        completed_at: Date | null
      }>(`
        SELECT state, attempts, claimed_by, completed_at
        FROM memory_jobs
        WHERE installation_id = $1 AND job_type = 'extract_candidates'
      `, [INSTALLATION])
      expect(job.rows[0]).toEqual({
        state: 'pending', attempts: 0, claimed_by: null, completed_at: null,
      })
    } finally {
      await configured.close()
    }
  })
})
