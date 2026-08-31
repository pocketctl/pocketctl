import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { createInvalidationService } from '../context/invalidation-service.js'
import { createPackRepository } from '../context/pack-repository.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const integrationEnabled = Boolean(
  databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1',
)
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const INSTALLATION = 'f1f1f1f1-f1f1-4f11-8f11-f1f1f1f1f1f1'

describeWithDatabase('context invalidation (PostgreSQL)', () => {
  let pool: pg.Pool
  let invalidation: ReturnType<typeof createInvalidationService>
  let packs: ReturnType<typeof createPackRepository>
  let claimId: string
  let versionId: string

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
    await assertMemoryTestDatabase(pool, databaseUrl!)
    await applyMemorySchema(pool)
    invalidation = createInvalidationService({ pool })
    packs = createPackRepository(pool)
  }, 60_000)

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE memory_context_feedback, memory_context_injections,
               memory_context_pack_evidence, memory_context_pack_items,
               memory_context_packs, memory_generation_runs,
               claim_search_documents, knowledge_evidence, knowledge_versions,
               knowledge_claims, work_episodes, source_turns, source_events,
               source_sessions, memory_context_settings, repositories,
               memory_installations
      RESTART IDENTITY CASCADE
    `)
    await pool.query(`
      INSERT INTO memory_installations
        (installation_id, provider_id, relay_status, local_status, config_version)
      VALUES ($1, 'pocketctl-memory', 'active', 'ready', 1)
    `, [INSTALLATION])
    await pool.query(`
      INSERT INTO source_sessions (installation_id, session_id, first_recorded_at, last_recorded_at)
      VALUES ($1, 'ses-i', NOW(), NOW())
    `, [INSTALLATION])
    await pool.query(`
      INSERT INTO work_episodes
        (installation_id, episode_id, session_id, turn_id, state, compiler_version,
         source_digest, document, evidence_manifest, document_compiler_version, compiled_at)
      VALUES ($1, gen_random_uuid(), 'ses-i', 'turn-1', 'ready', 'c',
              decode(md5('i'),'hex'), '{}'::jsonb, '{}'::jsonb, 'd', NOW())
    `, [INSTALLATION])
    const claim = await pool.query<{ claim_id: string }>(`
      INSERT INTO knowledge_claims
        (claim_id, installation_id, claim_type, scope_kind, scope_key, normalized_key, state)
      VALUES (gen_random_uuid(), $1, 'repository_convention', 'installation', 'global', 'inv-1', 'active')
      RETURNING claim_id::text
    `, [INSTALLATION])
    const version = await pool.query<{ version_id: string }>(`
      INSERT INTO knowledge_versions
        (version_id, installation_id, claim_id, version_number, statement, authority, confidence, freshness_at)
      VALUES (gen_random_uuid(), $1, $2, 1, 'invalidation source statement', 'user_accepted', 0.9, NOW())
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
    claimId = claim.rows[0].claim_id
    versionId = version.rows[0].version_id
  })

  async function seedPack(
    clientRequestId: string,
    state: 'ready' | 'shadow',
    injectionState: 'prepared' | 'delivered' | 'delivery_failed' | null,
  ): Promise<string> {
    const packId = await packs.persist({
      installationId: INSTALLATION, generationRunId: null, trajectoryId: null, sessionId: 'ses-i',
      clientRequestId, agent: 'codex', repositoryId: null, mode: state === 'ready' ? 'enabled' : 'shadow',
      effectivePolicyHash: Buffer.alloc(32, 1), inputDigest: Buffer.alloc(32, 2),
      settingsFingerprint: Buffer.alloc(32, 3),
      loadoutFingerprint: Buffer.alloc(32, 4),
      policyRevision: 1, settingsRevision: 1, loadoutRevision: 1, state,
      items: [{
        itemId: crypto.randomUUID(), claimId, versionId,
        claimType: 'repository_convention', layer: 'L2', section: 'dynamic',
        representation: 'summary', statement: 'invalidation source statement',
        scopeKind: 'installation', reasonCodes: ['ranked'], evidenceIds: [],
      }],
    })
    if (injectionState) {
      await pool.query(`
        INSERT INTO memory_context_injections
          (injection_id, installation_id, pack_id, session_id, client_request_id,
           agent, adapter, admission_nonce_hmac, state, admitted_at, delivered_at)
        VALUES (gen_random_uuid(), $1, $2, 'ses-i', $3, 'codex', 'codex-app-server',
                decode(md5('n'),'hex'), $4, NOW(),
                CASE WHEN $4 = 'delivered' THEN NOW() ELSE NULL END)
      `, [INSTALLATION, packId, clientRequestId, injectionState])
    }
    return packId
  }

  test('claim revocation invalidates dependent pending packs but never delivered history', async () => {
    const pending = await seedPack('cr-pending', 'ready', null)
    const delivered = await seedPack('cr-delivered', 'ready', 'delivered')
    const count = await invalidation.onClaimStateChange({
      installationId: INSTALLATION, claimIds: [claimId],
    })
    expect(count).toBeGreaterThanOrEqual(1)
    const states = await pool.query<{ pack_id: string; state: string }>(
      `SELECT pack_id::text, state FROM memory_context_packs`)
    const byPack = Object.fromEntries(states.rows.map(row => [row.pack_id, row.state]))
    expect(byPack[pending]).toBe('invalidated')
    // Already delivered history is never rewritten.
    expect(byPack[delivered]).toBe('ready')
  })

  test('evidence purge invalidates packs whose versions lost their last evidence', async () => {
    const pending = await seedPack('cr-ev', 'shadow', null)
    const count = await invalidation.onEvidencePurge({
      installationId: INSTALLATION, versionIds: [versionId],
    })
    expect(count).toBeGreaterThanOrEqual(1)
    const state = await pool.query<{ state: string }>(
      `SELECT state FROM memory_context_packs WHERE pack_id = $1`, [pending])
    expect(state.rows[0].state).toBe('invalidated')
  })

  test('policy/settings change invalidates every not-yet-admitted pack', async () => {
    const a = await seedPack('cr-cfg-a', 'ready', null)
    const b = await seedPack('cr-cfg-b', 'shadow', null)
    const delivered = await seedPack('cr-cfg-d', 'ready', 'delivered')
    const count = await invalidation.onConfigurationChange({
      installationId: INSTALLATION, reason: 'policy_changed',
    })
    expect(count).toBe(2)
    const states = await pool.query<{ pack_id: string; state: string; error_code: string }>(
      `SELECT pack_id::text, state, error_code FROM memory_context_packs`)
    const byPack = Object.fromEntries(states.rows.map(row => [row.pack_id, row]))
    expect(byPack[a].state).toBe('invalidated')
    expect(byPack[b].state).toBe('invalidated')
    expect(byPack[b].error_code).toBe('policy_changed')
    expect(byPack[delivered].state).toBe('ready')
  })

  test('pack bytes already consumed for dispatch are never invalidated retroactively', async () => {
    const prepared = await seedPack('cr-prepared', 'ready', 'prepared')
    const failed = await seedPack('cr-delivery-failed', 'ready', 'delivery_failed')
    expect(await invalidation.onConfigurationChange({
      installationId: INSTALLATION, reason: 'settings_changed',
    })).toBe(0)
    const states = await pool.query<{ pack_id: string; state: string }>(
      `SELECT pack_id::text, state FROM memory_context_packs`)
    const byPack = Object.fromEntries(states.rows.map(row => [row.pack_id, row.state]))
    expect(byPack[prepared]).toBe('ready')
    expect(byPack[failed]).toBe('ready')
  })
})
