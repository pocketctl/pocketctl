import pg from 'pg'
import { createHash } from 'crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { createAdmissionService } from '../context/admission-service.js'
import { createFeedbackService } from '../context/feedback-service.js'
import { createPackRepository } from '../context/pack-repository.js'
import {
  createContextSettingsRepository,
  effectiveContextSettingsFingerprint,
} from '../context/settings-repository.js'
import { createLoadoutRepository, resolvedLoadoutFingerprint } from '../context/loadout-repository.js'
import { createPolicyRepository } from '../policies/repository.js'
import {
  canonicalPolicyHash,
  SYSTEM_CONTEXT_POLICY_V1,
  SYSTEM_RANKING_POLICY_V1,
} from '../policies/schemas.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const integrationEnabled = Boolean(
  databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1',
)
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const INSTALLATION = 'efefefef-efef-4eef-8eef-efefefefefef'
const NONCE_KEY = Buffer.alloc(32, 7)

describeWithDatabase('context admission fence (PostgreSQL)', () => {
  let pool: pg.Pool
  let admission: ReturnType<typeof createAdmissionService>
  let feedback: ReturnType<typeof createFeedbackService>
  let packs: ReturnType<typeof createPackRepository>
  let settings: ReturnType<typeof createContextSettingsRepository>
  let loadouts: ReturnType<typeof createLoadoutRepository>
  let policies: ReturnType<typeof createPolicyRepository>
  let claimIds: string[] = []
  let versionIds: string[] = []
  let evidenceIds: string[] = []

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
    await assertMemoryTestDatabase(pool, databaseUrl!)
    await applyMemorySchema(pool)
    admission = createAdmissionService({ pool, nonceHmacKey: NONCE_KEY })
    feedback = createFeedbackService({ pool })
    packs = createPackRepository(pool)
    settings = createContextSettingsRepository(pool)
    loadouts = createLoadoutRepository(pool)
    policies = createPolicyRepository(pool)
    await policies.ensureSystemPolicies()
  }, 60_000)

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    claimIds = []
    versionIds = []
    evidenceIds = []
    await pool.query(`
      TRUNCATE memory_context_feedback, memory_context_injections,
               memory_context_pack_evidence, memory_context_pack_items,
               memory_context_packs, memory_generation_runs,
               memory_session_tombstones, claim_search_documents,
               knowledge_evidence, knowledge_versions, knowledge_claims,
               work_episodes, source_turns, source_events, source_sessions,
               memory_context_settings, memory_feature_settings,
               repositories, memory_installations
      RESTART IDENTITY CASCADE
    `)
    await pool.query(`
      INSERT INTO memory_installations
        (installation_id, provider_id, relay_status, local_status, config_version)
      VALUES ($1, 'pocketctl-memory', 'active', 'ready', 1)
    `, [INSTALLATION])
    await pool.query(`
      INSERT INTO source_sessions (installation_id, session_id, first_recorded_at, last_recorded_at)
      VALUES ($1, 'ses-a', NOW(), NOW())
    `, [INSTALLATION])
    await pool.query(`
      INSERT INTO work_episodes
        (installation_id, episode_id, session_id, turn_id, state, compiler_version,
         source_digest, document, evidence_manifest, document_compiler_version, compiled_at)
      VALUES ($1, gen_random_uuid(), 'ses-a', 'turn-1', 'ready', 'c',
              decode(md5('a'),'hex'), '{}'::jsonb, '{}'::jsonb, 'd', NOW())
    `, [INSTALLATION])
    await settings.upsert({
      installationId: INSTALLATION, scopeKind: 'installation', scopeKey: 'global',
      agent: null, mode: 'enabled', maxTokens: null, expectedRevision: 1,
    })

    // One active claim with live evidence feeding a ready pack.
    const claim = await pool.query<{ claim_id: string }>(`
      INSERT INTO knowledge_claims
        (claim_id, installation_id, claim_type, scope_kind, scope_key, normalized_key, state)
      VALUES (gen_random_uuid(), $1, 'repository_convention', 'installation', 'global', 'adm-1', 'active')
      RETURNING claim_id::text
    `, [INSTALLATION])
    const version = await pool.query<{ version_id: string }>(`
      INSERT INTO knowledge_versions
        (version_id, installation_id, claim_id, version_number, statement, authority, confidence, freshness_at)
      VALUES (gen_random_uuid(), $1, $2, 1, 'admission test statement', 'user_accepted', 0.9, NOW())
      RETURNING version_id::text
    `, [INSTALLATION, claim.rows[0].claim_id])
    await pool.query(`UPDATE knowledge_claims SET current_version_id = $2 WHERE claim_id = $1`,
      [claim.rows[0].claim_id, version.rows[0].version_id])
    const evidence = await pool.query<{ evidence_id: string }>(`
      INSERT INTO knowledge_evidence
        (evidence_id, installation_id, version_id, episode_id, evidence_kind, excerpt, excerpt_hash, occurred_at, ordinal)
      VALUES (gen_random_uuid(), $1, $2,
              (SELECT episode_id FROM work_episodes LIMIT 1), 'episode', 'x',
              sha256(convert_to('x','utf8')), NOW(), 0)
      RETURNING evidence_id::text
    `, [INSTALLATION, version.rows[0].version_id])
    claimIds = [claim.rows[0].claim_id]
    versionIds = [version.rows[0].version_id]
    evidenceIds = [evidence.rows[0].evidence_id]
  })

  let lastClientRequestId = 'cr-1'
  async function persistReadyPack(clientRequestId: string): Promise<string> {
    lastClientRequestId = clientRequestId
    const effectiveSettings = await settings.resolve({
      installationId: INSTALLATION, repositoryId: null, sessionId: 'ses-a', agent: 'codex',
    })
    const loadout = await loadouts.resolve({
      installationId: INSTALLATION, repositoryId: null, agent: 'codex',
    })
    const effectivePolicyHash = createHash('sha256')
      .update(canonicalPolicyHash(SYSTEM_CONTEXT_POLICY_V1))
      .update(canonicalPolicyHash(SYSTEM_RANKING_POLICY_V1))
      .digest()
    return packs.persist({
      installationId: INSTALLATION, generationRunId: null, trajectoryId: null, sessionId: 'ses-a',
      clientRequestId, agent: 'codex', repositoryId: null, mode: 'enabled',
      effectivePolicyHash, inputDigest: Buffer.alloc(32, 2),
      settingsFingerprint: effectiveContextSettingsFingerprint(effectiveSettings),
      loadoutFingerprint: resolvedLoadoutFingerprint(loadout),
      policyRevision: 1, settingsRevision: effectiveSettings.revisions[0] ?? 1,
      loadoutRevision: loadout.revision,
      state: 'ready',
      items: [{
        itemId: crypto.randomUUID(), claimId: claimIds[0], versionId: versionIds[0],
        claimType: 'repository_convention', layer: 'L2', section: 'dynamic',
        representation: 'summary', statement: 'admission test statement',
        scopeKind: 'installation', reasonCodes: ['ranked'], evidenceIds,
      }],
    })
  }

  const admitFor = (packId: string, clientRequestId = lastClientRequestId) => admission.admit({
    installationId: INSTALLATION, sessionId: 'ses-a', clientRequestId,
    packId, agent: 'codex', adapter: 'codex-app-server', grantConfigVersion: '1',
  })

  test('admits a ready pack with a single-use 5s ticket and stores only the nonce HMAC', async () => {
    const packId = await persistReadyPack('cr-1')
    const result = await admitFor(packId)
    expect(result.ok).toBe(true)
    if (!result.ok || !('expiresAt' in result)) return
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now())
    expect(result.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 5_500)
    const stored = await pool.query<{ admission_nonce_hmac: Buffer }>(
      `SELECT admission_nonce_hmac FROM memory_context_injections WHERE injection_id = $1`,
      [result.injectionId])
    expect(stored.rows[0].admission_nonce_hmac.length).toBe(32)
    // The clear nonce is never persisted anywhere.
    const leaked = await pool.query(
      `SELECT COUNT(*)::int AS n FROM memory_context_injections
       WHERE memory_context_injections::text LIKE '%' || $1 || '%'`, [result.nonce])
    expect(leaked.rows[0].n).toBe(0)
  })

  test('duplicate client requests return the existing admission without re-admitting', async () => {
    const packId = await persistReadyPack('cr-dup')
    const first = await admitFor(packId)
    const second = await admitFor(packId)
    expect(first.ok && !('existing' in first && first.existing)).toBe(true)
    expect(second.ok && 'existing' in second && second.existing).toBe(true)
    const rows = await pool.query(`SELECT COUNT(*)::int AS n FROM memory_context_injections`)
    expect(rows.rows[0].n).toBe(1)
  })

  test('a duplicate after delivery failure returns terminal state and never reinjects', async () => {
    const packId = await persistReadyPack('cr-delivery-failed-duplicate')
    const admitted = await admitFor(packId)
    if (!admitted.ok || !('nonce' in admitted)) throw new Error('admission failed')
    expect(await admission.consume({
      installationId: INSTALLATION, sessionId: 'ses-a', packId,
      injectionId: admitted.injectionId, nonce: admitted.nonce,
    })).toMatchObject({ ok: true })
    expect(await admission.receipt({
      injectionId: admitted.injectionId, installationId: INSTALLATION,
      sessionId: 'ses-a', delivered: false, outcomeCode: 'dispatch_failed',
    })).toEqual({ ok: true, state: 'delivery_failed' })

    expect(await admitFor(packId)).toEqual({
      ok: true, existing: true, injectionId: admitted.injectionId, state: 'delivery_failed',
    })
  })

  test('mode-off between compile and admission blocks the admission (linearization)', async () => {
    const packId = await persistReadyPack('cr-off')
    await settings.upsert({
      installationId: INSTALLATION, scopeKind: 'installation', scopeKey: 'global',
      agent: null, mode: 'off', maxTokens: null, expectedRevision: 1,
    })
    const result = await admitFor(packId)
    expect(result).toEqual({ ok: false, error: 'mode_off' })
  })

  test('an enabled settings revision change rejects the stale compiled snapshot', async () => {
    const packId = await persistReadyPack('cr-settings-revision')
    await settings.upsert({
      installationId: INSTALLATION, scopeKind: 'installation', scopeKey: 'global',
      agent: null, mode: 'enabled', maxTokens: 700, expectedRevision: 1,
    })
    expect(await admitFor(packId)).toEqual({ ok: false, error: 'pack_mismatch' })
  })

  test('a policy head change rejects the stale compiled snapshot', async () => {
    const packId = await persistReadyPack('cr-policy-head')
    const created = await policies.createVersion({
      installationId: INSTALLATION,
      kind: 'context',
      layer: 'user',
      scopeKey: 'global',
      document: { ...SYSTEM_CONTEXT_POLICY_V1, max_items: 5 },
    })
    expect(created.ok).toBe(true)
    expect(await admitFor(packId)).toEqual({ ok: false, error: 'pack_mismatch' })
  })

  test('creating a loadout rejects a pack compiled against no loadout', async () => {
    const packId = await persistReadyPack('cr-loadout-revision')
    expect(await loadouts.replace({
      installationId: INSTALLATION, repositoryId: null, agent: 'codex',
      expectedRevision: 1, items: [{
        itemId: crypto.randomUUID(), assetKind: 'claim', claimId: claimIds[0],
        externalAssetRef: null, representation: 'summary', priority: 100,
      }],
    })).toEqual({ ok: true, revision: 1 })
    expect(await admitFor(packId)).toEqual({ ok: false, error: 'pack_mismatch' })
  })

  test('revoking a pack claim between compile and admission blocks delivery', async () => {
    const packId = await persistReadyPack('cr-revoke')
    await pool.query(`UPDATE knowledge_claims SET state = 'revoked' WHERE claim_id = $1`, [claimIds[0]])
    const result = await admitFor(packId)
    expect(result).toEqual({ ok: false, error: 'claim_invalid' })
  })

  test('an admitted ticket expires and cannot be reused after TTL', async () => {
    const packId = await persistReadyPack('cr-ttl')
    const admitted = await admitFor(packId)
		if (!admitted.ok || !('nonce' in admitted)) throw new Error('admission failed')
    // Force the ticket into the past.
    await pool.query(
      `UPDATE memory_context_injections SET admission_expires_at = NOW() - INTERVAL '1 second'
       WHERE injection_id = $1`, [admitted.injectionId])
    expect(await admission.assertUsable({ injectionId: admitted.injectionId })).toBe(false)
    const state = await pool.query<{ state: string }>(
      `SELECT state FROM memory_context_injections WHERE injection_id = $1`, [admitted.injectionId])
    expect(state.rows[0].state).toBe('expired')
  })

  test('a duplicate request cannot keep an expired admission alive forever', async () => {
    const packId = await persistReadyPack('cr-expired-duplicate')
    const admitted = await admitFor(packId)
    if (!admitted.ok || !('nonce' in admitted)) throw new Error('admission failed')
    await pool.query(`
      UPDATE memory_context_injections
      SET admission_expires_at = NOW() - INTERVAL '1 second'
      WHERE injection_id = $1
    `, [admitted.injectionId])
    expect(await admitFor(packId)).toEqual({ ok: false, error: 'expired' })
    const state = await pool.query<{ state: string }>(
      `SELECT state FROM memory_context_injections WHERE injection_id = $1`, [admitted.injectionId])
    expect(state.rows[0].state).toBe('expired')
  })

  test('receipts are idempotent and never resend: a retried receipt is a no-op', async () => {
    const packId = await persistReadyPack('cr-rcpt')
    const admitted = await admitFor(packId)
		if (!admitted.ok || !('nonce' in admitted)) throw new Error('admission failed')
		const consumed = await admission.consume({
			installationId: INSTALLATION, sessionId: 'ses-a', packId,
			injectionId: admitted.injectionId, nonce: admitted.nonce,
		})
		expect(consumed.ok).toBe(true)
    const first = await admission.receipt({
      injectionId: admitted.injectionId, installationId: INSTALLATION,
      sessionId: 'ses-a',
      delivered: true, outcomeCode: 'accepted',
    })
    expect(first).toEqual({ ok: true, state: 'delivered' })
    const retry = await admission.receipt({
      injectionId: admitted.injectionId, installationId: INSTALLATION,
      sessionId: 'ses-a',
      delivered: false, outcomeCode: 'retry_after_delivery',
    })
    expect(retry).toEqual({ ok: true, state: 'delivered' })
    const rows = await pool.query<{ delivered_at: Date | null }>(
      `SELECT delivered_at FROM memory_context_injections WHERE injection_id = $1`,
      [admitted.injectionId])
    expect(rows.rows[0].delivered_at).not.toBeNull()
  })

	test('a receipt cannot bypass single-use pack consumption', async () => {
		const packId = await persistReadyPack('cr-receipt-before-consume')
		const admitted = await admitFor(packId)
		if (!admitted.ok || !('nonce' in admitted)) throw new Error('admission failed')
		expect(await admission.receipt({
			injectionId: admitted.injectionId, installationId: INSTALLATION,
			sessionId: 'ses-a', delivered: true, outcomeCode: 'accepted',
		})).toEqual({ ok: false, error: 'not_found' })
		const row = await pool.query<{ state: string }>(
			`SELECT state FROM memory_context_injections WHERE injection_id = $1`, [admitted.injectionId])
		expect(row.rows[0].state).toBe('admitted')
	})

  test('feedback is bounded to visible targets and never widens', async () => {
    const packId = await persistReadyPack('cr-fb')
    const admitted = await admitFor(packId)
		if (!admitted.ok || !('nonce' in admitted)) throw new Error('admission failed')
    const ok = await feedback.submit({
      installationId: INSTALLATION, injectionId: admitted.injectionId,
      actor: 'user', action: 'used',
    })
    expect(ok.ok).toBe(true)
    const foreign = await feedback.submit({
      installationId: 'f0f0f0f0-f0f0-4f0f-80f0-f0f0f0f0f0f0',
      injectionId: admitted.injectionId, actor: 'user', action: 'harmful',
    })
    expect(foreign).toEqual({ ok: false, error: 'target_not_visible' })
    const noTarget = await feedback.submit({
      installationId: INSTALLATION, actor: 'agent', action: 'ignored',
    })
    expect(noTarget).toEqual({ ok: false, error: 'target_required' })
    const firstItem = await pool.query<{ item_id: string }>(`
      SELECT item_id::text FROM memory_context_pack_items WHERE pack_id = $1 LIMIT 1
    `, [packId])
    const otherPackId = await persistReadyPack('cr-fb-other')
    const crossLinked = await feedback.submit({
      installationId: INSTALLATION,
      injectionId: admitted.injectionId,
      packId: otherPackId,
      itemId: firstItem.rows[0].item_id,
      actor: 'user',
      action: 'incorrect',
    })
    expect(crossLinked).toEqual({ ok: false, error: 'target_not_visible' })
    const aggregate = await feedback.aggregate({ installationId: INSTALLATION })
    expect(aggregate).toEqual({ used: 1 })
  })
})
