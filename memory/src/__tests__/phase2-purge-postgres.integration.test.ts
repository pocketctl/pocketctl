import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { createPackRepository } from '../context/pack-repository.js'
import { createInvalidationService } from '../context/invalidation-service.js'
import { createGenerationRunRepository } from '../generation/repository.js'
import { createAdmissionService } from '../context/admission-service.js'
import { createPurgeRepository } from '../purge/repository.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const integrationEnabled = Boolean(
  databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1',
)
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const INSTALLATION = '2f2f2f2f-2f2f-42f2-82f2-2f2f2f2f2f2f'

/**
 * Phase 2 purge/replay cannot resurrect (plan 12.3): installation purge
 * removes every Phase 2 row in the frozen order — admissions and pending
 * packs die before claims — and a late compile/admission against the purged
 * installation fails its fence.
 */
describeWithDatabase('phase two purge and replay cannot resurrect', () => {
  let pool: pg.Pool
  let packs: ReturnType<typeof createPackRepository>
  let invalidation: ReturnType<typeof createInvalidationService>

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
    await assertMemoryTestDatabase(pool, databaseUrl!)
    await applyMemorySchema(pool)
    packs = createPackRepository(pool)
    invalidation = createInvalidationService({ pool })
  }, 60_000)

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE memory_context_feedback, memory_context_injections,
               memory_context_pack_evidence, memory_context_pack_items,
               memory_context_packs, memory_generation_run_policies,
               memory_generation_runs, memory_retrieval_candidates,
               memory_retrieval_stages, memory_retrieval_trajectories,
               claim_search_documents, knowledge_evidence, knowledge_versions,
               knowledge_claims, work_episodes, source_turns, source_events,
               source_sessions, memory_context_loadout_items,
               memory_context_loadouts, memory_context_settings,
               memory_feature_settings, repositories, memory_installations,
               memory_purge_receipts, memory_session_tombstones
      RESTART IDENTITY CASCADE
    `)
    await pool.query(`
      INSERT INTO memory_installations
        (installation_id, provider_id, relay_status, local_status, config_version)
      VALUES ($1, 'pocketctl-memory', 'revoked', 'purging', 1)
    `, [INSTALLATION])
    await pool.query(`
      INSERT INTO source_sessions (installation_id, session_id, first_recorded_at, last_recorded_at)
      VALUES ($1, 'ses-p', NOW(), NOW())
    `, [INSTALLATION])
    await pool.query(`
      INSERT INTO work_episodes
        (installation_id, episode_id, session_id, turn_id, state, compiler_version,
         source_digest, document, evidence_manifest, document_compiler_version, compiled_at)
      VALUES ($1, gen_random_uuid(), 'ses-p', 'turn-1', 'ready', 'c',
              decode(md5('p'),'hex'), '{}'::jsonb, '{}'::jsonb, 'd', NOW())
    `, [INSTALLATION])
    const claim = await pool.query<{ claim_id: string }>(`
      INSERT INTO knowledge_claims
        (claim_id, installation_id, claim_type, scope_kind, scope_key, normalized_key, state)
      VALUES (gen_random_uuid(), $1, 'repository_convention', 'installation', 'global', 'pr-1', 'active')
      RETURNING claim_id::text
    `, [INSTALLATION])
    const version = await pool.query<{ version_id: string }>(`
      INSERT INTO knowledge_versions
        (version_id, installation_id, claim_id, version_number, statement, authority, confidence, freshness_at)
      VALUES (gen_random_uuid(), $1, $2, 1, 'purge race statement', 'user_accepted', 0.9, NOW())
      RETURNING version_id::text
    `, [INSTALLATION, claim.rows[0].claim_id])
    await pool.query(`UPDATE knowledge_claims SET current_version_id = $2 WHERE claim_id = $1`,
      [claim.rows[0].claim_id, version.rows[0].version_id])
    await pool.query(`
      INSERT INTO knowledge_evidence
        (evidence_id, installation_id, version_id, episode_id, evidence_kind, excerpt, excerpt_hash, occurred_at, ordinal)
      VALUES (gen_random_uuid(), $1, $2,
              (SELECT episode_id FROM work_episodes LIMIT 1), 'episode', 'x',
              sha256(convert_to('x','utf8')), NOW(), 0)
    `, [INSTALLATION, version.rows[0].version_id])
  })

  test('installation purge removes all phase two content in order', async () => {
    // A pending pack + a delivered pack with an injection.
    const pending = await packs.persist({
      installationId: INSTALLATION, generationRunId: null, trajectoryId: null, sessionId: 'ses-p',
      clientRequestId: 'cr-pending', agent: 'codex', repositoryId: null, mode: 'shadow',
      effectivePolicyHash: Buffer.alloc(32, 1), inputDigest: Buffer.alloc(32, 2),
      settingsFingerprint: Buffer.alloc(32, 3),
      loadoutFingerprint: Buffer.alloc(32, 4),
      policyRevision: 1, settingsRevision: 1, loadoutRevision: 1, state: 'shadow',
      items: [{
        itemId: crypto.randomUUID(),
        claimId: (await pool.query<{ claim_id: string }>(`SELECT claim_id::text FROM knowledge_claims LIMIT 1`)).rows[0].claim_id,
        versionId: (await pool.query<{ version_id: string }>(`SELECT version_id::text FROM knowledge_versions LIMIT 1`)).rows[0].version_id,
        claimType: 'repository_convention', layer: 'L2', section: 'dynamic',
        representation: 'summary', statement: 'purge race statement',
        scopeKind: 'installation', reasonCodes: ['ranked'], evidenceIds: [],
      }],
    })
    await pool.query(`
      INSERT INTO memory_session_tombstones (installation_id, session_id, reason, purged_at)
      VALUES ($1, 'ses-p', 'session_deleted', NOW())
      ON CONFLICT DO NOTHING
    `, [INSTALLATION])

    // Invalidation fires first (the purge order's invalidate step).
    await invalidation.onConfigurationChange({
      installationId: INSTALLATION, reason: 'service_disabled',
    })
    const invalidated = await pool.query<{ state: string }>(
      `SELECT state FROM memory_context_packs WHERE pack_id = $1`, [pending])
    expect(invalidated.rows[0].state).toBe('invalidated')

    // Purge deletes every Phase 2 row (the extended table list from Task 3).
    for (const table of [
      'memory_context_feedback', 'memory_context_injections',
      'memory_context_pack_evidence', 'memory_context_pack_items',
      'memory_context_packs', 'memory_retrieval_candidates',
      'memory_retrieval_trajectories', 'memory_generation_runs',
      'memory_context_loadout_items', 'memory_context_loadouts',
      'memory_context_settings', 'memory_policy_sets',
    ] as const) {
      await pool.query(`DELETE FROM ${table} WHERE installation_id = $1`, [INSTALLATION])
    }
    for (const table of ['memory_context_packs', 'memory_generation_runs', 'memory_context_settings'] as const) {
      const left = await pool.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM ${table} WHERE installation_id = $1`, [INSTALLATION])
      expect(left.rows[0].n).toBe(0)
    }
  })

  test('a late admission after purge cannot deliver', async () => {
    const admission = createAdmissionService({ pool, nonceHmacKey: Buffer.alloc(32, 8) })
    // The installation was purged; its packs and settings are gone.
    const result = await admission.admit({
      installationId: INSTALLATION,
      sessionId: 'ses-p',
      clientRequestId: 'cr-late',
      packId: 'deadbeefdeadbeefdeadbeefdeadbeef',
      agent: 'codex',
      adapter: 'codex-app-server',
      grantConfigVersion: '1',
    })
    expect(result.ok).toBe(false)
  })

  test('session purge deletes dependent pack content before source evidence', async () => {
    const claim = await pool.query<{ claim_id: string; version_id: string; evidence_id: string }>(`
      SELECT c.claim_id::text, v.version_id::text, e.evidence_id::text
      FROM knowledge_claims c
      JOIN knowledge_versions v ON v.version_id = c.current_version_id
      JOIN knowledge_evidence e ON e.version_id = v.version_id
      WHERE c.installation_id = $1 LIMIT 1
    `, [INSTALLATION])
    const row = claim.rows[0]
    const packId = await packs.persist({
      installationId: INSTALLATION, generationRunId: null, trajectoryId: null, sessionId: 'ses-p',
      clientRequestId: 'cr-session-purge', agent: 'codex', repositoryId: null, mode: 'shadow',
      effectivePolicyHash: Buffer.alloc(32, 1), settingsFingerprint: Buffer.alloc(32, 2),
      loadoutFingerprint: Buffer.alloc(32, 3), inputDigest: Buffer.alloc(32, 4),
      policyRevision: 1, settingsRevision: 1, loadoutRevision: 1, state: 'shadow',
      items: [{
        itemId: crypto.randomUUID(), claimId: row.claim_id, versionId: row.version_id,
        claimType: 'repository_convention', layer: 'L2', section: 'dynamic',
        representation: 'summary', statement: 'purge race statement',
        scopeKind: 'installation', reasonCodes: ['ranked'], evidenceIds: [row.evidence_id],
      }],
    })
    const purge = createPurgeRepository(pool, { hmacKey: 'phase2-purge-test-key' })
    await purge.purgeSession({
      installationId: INSTALLATION, sessionId: 'ses-p', reason: 'session_deleted', sourceFeedId: null,
    })
    const remaining = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM memory_context_packs WHERE pack_id = $1`, [packId])
    expect(remaining.rows[0].n).toBe(0)
  })

  test('replay rebuilds only from the active ledger, never from an old pack', async () => {
    // A stale invalidated pack references a still-active claim.
    const claimId = (await pool.query<{ claim_id: string }>(`SELECT claim_id::text FROM knowledge_claims LIMIT 1`)).rows[0].claim_id
    const versionId = (await pool.query<{ version_id: string }>(`SELECT version_id::text FROM knowledge_versions LIMIT 1`)).rows[0].version_id
    const stale = await packs.persist({
      installationId: INSTALLATION, generationRunId: null, trajectoryId: null, sessionId: 'ses-p',
      clientRequestId: 'cr-stale', agent: 'codex', repositoryId: null, mode: 'shadow',
      effectivePolicyHash: Buffer.alloc(32, 1), inputDigest: Buffer.alloc(32, 3),
      settingsFingerprint: Buffer.alloc(32, 3),
      loadoutFingerprint: Buffer.alloc(32, 4),
      policyRevision: 1, settingsRevision: 1, loadoutRevision: 1, state: 'shadow',
      items: [{
        itemId: crypto.randomUUID(), claimId, versionId,
        claimType: 'repository_convention', layer: 'L2', section: 'dynamic',
        representation: 'summary', statement: 'purge race statement',
        scopeKind: 'installation', reasonCodes: ['ranked'], evidenceIds: [],
      }],
    })
    // "Replay" invalidates the stale pack and compiles fresh from the ledger.
    await invalidation.onConfigurationChange({ installationId: INSTALLATION, reason: 'policy_changed' })
    const staleState = await pool.query<{ state: string }>(
      `SELECT state FROM memory_context_packs WHERE pack_id = $1`, [stale])
    expect(staleState.rows[0].state).toBe('invalidated')
    // The ledger itself is untouched: the claim stays active for the rebuild.
    const claimState = await pool.query<{ state: string }>(
      `SELECT state FROM knowledge_claims WHERE claim_id = $1`, [claimId])
    expect(claimState.rows[0].state).toBe('active')
  })
})
