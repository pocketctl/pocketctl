import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { createContextSettingsRepository } from '../context/settings-repository.js'
import { createLoadoutRepository } from '../context/loadout-repository.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const integrationEnabled = Boolean(
  databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1',
)
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const INSTALLATION = '76767676-7676-4676-8676-767676767676'
const REPO_A = 'a7a7a7a7-a7a7-4a77-8a77-a7a7a7a7a7a7'

async function seedClaim(pool: pg.Pool, installationId: string, key: string, claimType: string, state = 'active'): Promise<string> {
  const claim = await pool.query<{ claim_id: string }>(`
    INSERT INTO knowledge_claims
      (claim_id, installation_id, claim_type, scope_kind, scope_key, normalized_key, state)
    VALUES (gen_random_uuid(), $1, $2, 'installation', 'global', $3, $4)
    RETURNING claim_id::text
  `, [installationId, claimType, key, state])
  const claimId = claim.rows[0].claim_id
  const version = await pool.query<{ version_id: string }>(`
    INSERT INTO knowledge_versions
      (version_id, installation_id, claim_id, version_number, statement, authority, confidence, freshness_at)
    VALUES (gen_random_uuid(), $1, $2, 1, $3, 'user_accepted', 0.9, NOW())
    RETURNING version_id::text
  `, [installationId, claimId, `statement:${key}`])
  await pool.query(`UPDATE knowledge_claims SET current_version_id = $2 WHERE claim_id = $1`, [claimId, version.rows[0].version_id])
  await pool.query(`
    INSERT INTO knowledge_evidence
      (evidence_id, installation_id, version_id, episode_id, evidence_kind, excerpt, excerpt_hash, occurred_at, ordinal)
    VALUES (gen_random_uuid(), $1, $2, (SELECT episode_id FROM work_episodes WHERE installation_id = $1 LIMIT 1), 'episode', 'x', sha256(convert_to('x','utf8')), NOW(), 0)
  `, [installationId, version.rows[0].version_id])
  return claimId
}

describeWithDatabase('context settings and loadouts (PostgreSQL)', () => {
  let pool: pg.Pool
  let settings: ReturnType<typeof createContextSettingsRepository>
  let loadouts: ReturnType<typeof createLoadoutRepository>

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
    await assertMemoryTestDatabase(pool, databaseUrl!)
    await applyMemorySchema(pool)
    settings = createContextSettingsRepository(pool)
    loadouts = createLoadoutRepository(pool)
  }, 60_000)

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE memory_context_loadout_items, memory_context_loadouts,
               memory_context_settings, knowledge_evidence, knowledge_versions,
               knowledge_claims, work_episodes, source_turns, source_events,
               source_sessions, repositories, memory_installations
      RESTART IDENTITY CASCADE
    `)
    await pool.query(`
      INSERT INTO memory_installations
        (installation_id, provider_id, relay_status, local_status, config_version)
      VALUES ($1, 'pocketctl-memory', 'active', 'ready', 1)
    `, [INSTALLATION])
    await pool.query(`
      INSERT INTO repositories (repository_id, installation_id, repository_key, first_observed_at, last_observed_at)
      VALUES ($1, $2, 'github.com/example/a', NOW(), NOW())
    `, [REPO_A, INSTALLATION])
    await pool.query(`
      INSERT INTO source_sessions (installation_id, session_id, first_recorded_at, last_recorded_at)
      VALUES ($1, 'ses-1', NOW(), NOW())
    `, [INSTALLATION])
    await pool.query(`
      INSERT INTO work_episodes
        (installation_id, episode_id, session_id, turn_id, state, compiler_version,
         source_digest, document, evidence_manifest, document_compiler_version, compiled_at)
      VALUES ($1, gen_random_uuid(), 'ses-1', 'turn-1', 'ready', 'c-v1',
              decode(md5('ctx'),'hex'), '{}'::jsonb, '{}'::jsonb, 'd-v1', NOW())
    `, [INSTALLATION])
  })

  test('effective mode is the minimum across scopes; agent rows override generic', async () => {
    await settings.upsert({
      installationId: INSTALLATION, scopeKind: 'installation', scopeKey: 'global',
      agent: null, mode: 'enabled', maxTokens: 2000, expectedRevision: 1,
    })
    await settings.upsert({
      installationId: INSTALLATION, scopeKind: 'repository', scopeKey: REPO_A,
      agent: null, mode: 'shadow', maxTokens: 800, expectedRevision: 1,
    })
    await settings.upsert({
      installationId: INSTALLATION, scopeKind: 'session', scopeKey: 'ses-1',
      agent: 'codex', mode: 'off', maxTokens: null, expectedRevision: 1,
    })

    const broad = await settings.resolve({ installationId: INSTALLATION })
    expect(broad.mode).toBe('enabled')
    expect(broad.maxTokens).toBe(2000)

    const repoScoped = await settings.resolve({ installationId: INSTALLATION, repositoryId: REPO_A })
    expect(repoScoped.mode).toBe('shadow')
    expect(repoScoped.maxTokens).toBe(800)

    // The session row for codex turns the mode off entirely.
    const sessionScoped = await settings.resolve({
      installationId: INSTALLATION, repositoryId: REPO_A, sessionId: 'ses-1', agent: 'codex',
    })
    expect(sessionScoped.mode).toBe('off')
  })

  test('updates are CAS-guarded per revision', async () => {
    const staleCreate = await settings.upsert({
      installationId: INSTALLATION, scopeKind: 'session', scopeKey: 'never-created',
      agent: null, mode: 'enabled', maxTokens: null, expectedRevision: 9,
    })
    expect(staleCreate).toEqual({ ok: false, error: 'cas_conflict' })

    const first = await settings.upsert({
      installationId: INSTALLATION, scopeKind: 'installation', scopeKey: 'global',
      agent: null, mode: 'shadow', maxTokens: null, expectedRevision: 1,
    })
    expect(first).toEqual({ ok: true, revision: 1 })
    const stale = await settings.upsert({
      installationId: INSTALLATION, scopeKind: 'installation', scopeKey: 'global',
      agent: null, mode: 'enabled', maxTokens: null, expectedRevision: 0,
    })
    expect(stale).toEqual({ ok: false, error: 'cas_conflict' })
    const fresh = await settings.upsert({
      installationId: INSTALLATION, scopeKind: 'installation', scopeKey: 'global',
      agent: null, mode: 'enabled', maxTokens: null, expectedRevision: 1,
    })
    expect(fresh).toEqual({ ok: true, revision: 2 })
  })

  test('loadout replace is CAS-guarded and resolves inert vs live assets', async () => {
    const workMethod = await seedClaim(pool, INSTALLATION, 'wm-1', 'work_method')
    const inactive = await seedClaim(pool, INSTALLATION, 'dead-1', 'architecture_decision', 'revoked')
    const wrongType = await seedClaim(pool, INSTALLATION, 'wt-1', 'bug_root_cause')

    const staleCreate = await loadouts.replace({
      installationId: INSTALLATION, repositoryId: REPO_A, agent: 'opencode',
      items: [], expectedRevision: 9,
    })
    expect(staleCreate).toEqual({ ok: false, error: 'cas_conflict' })

    const first = await loadouts.replace({
      installationId: INSTALLATION, repositoryId: null, agent: 'codex',
      items: [], expectedRevision: 1,
    })
    expect(first).toEqual({ ok: true, revision: 1 })
    const stale = await loadouts.replace({
      installationId: INSTALLATION, repositoryId: null, agent: 'codex',
      items: [], expectedRevision: 0,
    })
    expect(stale).toEqual({ ok: false, error: 'cas_conflict' })

    const replaced = await loadouts.replace({
      installationId: INSTALLATION, repositoryId: null, agent: 'codex',
      expectedRevision: 1,
      items: [
        { itemId: crypto.randomUUID(), assetKind: 'persona', claimId: workMethod, externalAssetRef: null, representation: 'summary', priority: 80 },
        { itemId: crypto.randomUUID(), assetKind: 'claim', claimId: inactive, externalAssetRef: null, representation: 'summary', priority: 50 },
        { itemId: crypto.randomUUID(), assetKind: 'runbook', claimId: wrongType, externalAssetRef: null, representation: 'reference', priority: 40 },
        { itemId: crypto.randomUUID(), assetKind: 'wiki', claimId: null, externalAssetRef: 'wiki:future', representation: 'reference', priority: 30 },
      ],
    })
    expect(replaced).toEqual({ ok: true, revision: 2 })

    const resolved = await loadouts.resolve({
      installationId: INSTALLATION, repositoryId: null, agent: 'codex',
    })
    expect(resolved.revision).toBe(2)
    const statuses = Object.fromEntries(resolved.items.map(item => [item.assetKind, item.status]))
    // Persona resolves: active work_method with live evidence.
    expect(statuses.persona).toBe('resolved')
    // A revoked claim cannot be forced in by pinning.
    expect(statuses.claim).toBe('claim_inactive')
    // Runbook requires operational_runbook.
    expect(statuses.runbook).toBe('claim_inactive')
    // Wiki stays inert until Phase 4.
    expect(statuses.wiki).toBe('asset_unavailable')
  })

  test('cross-installation repository keys are invisible to resolution', async () => {
    const other = '88888888-8888-4888-8888-888888888888'
    await pool.query(`
      INSERT INTO memory_installations
        (installation_id, provider_id, relay_status, local_status, config_version)
      VALUES ($1, 'pocketctl-memory', 'active', 'ready', 1)
    `, [other])
    await pool.query(`
      INSERT INTO repositories (repository_id, installation_id, repository_key, first_observed_at, last_observed_at)
      VALUES (gen_random_uuid(), $1, 'github.com/other/only-there', NOW(), NOW())
    `, [other])
    const { createScopeResolver } = await import('../context/scope-resolver.js')
    const scope = createScopeResolver(pool)
    // Same key hint, but scoped to THIS installation: unknown here.
    const resolved = await scope.resolve({
      installationId: INSTALLATION, sessionId: 'ses-1', repositoryKeyHint: 'github.com/other/only-there',
    })
    expect(resolved.repositoryKnown).toBe(false)
    expect(resolved.personaOnly).toBe(true)
    expect(resolved.sessionKnown).toBe(true)
  })
})
