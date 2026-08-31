import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { createScopeControlProjector } from '../governance/membership-projector.js'
import type { ExtensionScopeFeedEnvelopeV2 } from '../relay/contracts.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const integrationEnabled = Boolean(
  databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const PERSONAL = 'feedfeed-0000-4000-8000-000000000001'
const TEAM = 'feedfeed-0000-4000-8000-000000000002'
const TEAM_SCOPE = 'feedfeed-0000-4000-8000-000000000041'

function lifecycleEnvelope(feedId: number, state: string, epoch: number): ExtensionScopeFeedEnvelopeV2 {
  return {
    envelope_version: 2,
    feed_id: String(feedId),
    topic: 'scope.lifecycle.v2',
    owner_scope: { kind: 'team', id: TEAM_SCOPE, authorization_epoch: String(epoch) },
    source: { kind: 'scope_lifecycle', id: TEAM_SCOPE, recorded_at: '2026-08-30T12:00:00Z' },
    subject: { event_type: `scope_${state}` },
    classification: {},
    data: { state },
  }
}

describeWithDatabase('phase3 purge and replay fences (PostgreSQL)', () => {
  let pool: pg.Pool

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl })
    const database = await pool.query<{ database_name: string }>(
      'SELECT current_database() AS database_name',
    )
    if (!/test/i.test(database.rows[0]?.database_name ?? '')) {
      throw new Error('Refusing integration test against non-test database')
    }
    await applyMemorySchema(pool)
  }, 60_000)

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE memory_scope_tombstones, memory_scope_memberships, memory_owner_scopes,
                memory_governance_events, knowledge_evidence, knowledge_versions, knowledge_claims,
                work_episodes, memory_installations CASCADE
    `)
    for (const [installationId, kind] of [[PERSONAL, 'personal'], [TEAM, 'team']] as const) {
      await pool.query(`
        INSERT INTO memory_installations
          (installation_id, provider_id, relay_status, local_status, config_version,
           granted_scopes, subscriptions, enabled_services, event_filter)
        VALUES ($1, 'pocketctl-memory', 'active', 'ready', 1,
                '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb)
      `, [installationId])
      await pool.query(`
        INSERT INTO memory_owner_scopes (installation_id, owner_scope_kind, owner_scope_id)
        VALUES ($1::uuid, $2::text, CASE WHEN $2 = 'team' THEN $3::uuid ELSE $1::uuid END)
      `, [installationId, kind, TEAM_SCOPE])
    }
  })

  test('purging a personal installation leaves shared-scope knowledge intact', async () => {
    // Shared claim + evidence in the team installation.
    const claimId = (await pool.query<{ id: string }>(`
      INSERT INTO knowledge_claims
        (claim_id, installation_id, claim_type, scope_kind, scope_key, normalized_key, state, owner_scope_kind, owner_scope_id)
      VALUES (gen_random_uuid(), $1, 'repository_convention', 'repository', '/repo', 'purge-key', 'active', 'team', $2)
      RETURNING claim_id::text AS id
    `, [TEAM, TEAM_SCOPE])).rows[0].id
    const versionId = (await pool.query<{ id: string }>(`
      INSERT INTO knowledge_versions
        (version_id, installation_id, claim_id, version_number, statement, authority, confidence)
      VALUES (gen_random_uuid(), $1, $2, 1, 'shared survivor', 'team_published', 0.9)
      RETURNING version_id::text AS id
    `, [TEAM, claimId])).rows[0].id
    await pool.query(`
      UPDATE knowledge_claims SET current_version_id = $2 WHERE installation_id = $1 AND claim_id = $3
    `, [TEAM, versionId, claimId])
    const episodeId = (await pool.query<{ id: string }>(`
      INSERT INTO work_episodes (installation_id, episode_id, session_id, turn_id, state, compiler_version)
      VALUES ($1, gen_random_uuid(), 'purge-session', 'purge-turn', 'ready', 'test')
      RETURNING episode_id::text AS id
    `, [TEAM])).rows[0].id
    await pool.query(`
      INSERT INTO knowledge_evidence
        (evidence_id, installation_id, version_id, episode_id, ordinal, evidence_kind, excerpt, excerpt_hash, occurred_at, visibility)
      VALUES (gen_random_uuid(), $1, $2, $3, 1, 'episode', 'shared evidence', 'hash', NOW(), 'shared')
    `, [TEAM, versionId, episodeId])

    // Purge the PERSONAL installation (hard delete like installation_purge).
    await pool.query(`DELETE FROM memory_installations WHERE installation_id = $1`, [PERSONAL])

    const survivor = await pool.query(`
      SELECT c.state, v.statement FROM knowledge_claims c
      JOIN knowledge_versions v ON v.version_id = c.current_version_id AND v.installation_id = c.installation_id
      WHERE c.installation_id = $1
    `, [TEAM])
    expect(survivor.rows[0]).toMatchObject({ state: 'active', statement: 'shared survivor' })
    const evidence = await pool.query(`
      SELECT COUNT(*)::text AS count FROM knowledge_evidence WHERE installation_id = $1 AND visibility = 'shared'
    `, [TEAM])
    expect(Number(evidence.rows[0].count)).toBe(1)
  })

  test('replayed older lifecycle facts cannot resurrect a dissolved scope', async () => {
    const batch = (items: ExtensionScopeFeedEnvelopeV2[]) => ({
      installation_id: TEAM, items,
      next_cursor: 'cursor', lease_token: 'lease',
      lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    })
    const projector = createScopeControlProjector({
      pool, workerId: 'purge-test',
      pullScopeControlFeed: async () => batch([]),
      ackScopeControlFeed: (async () => 0) as never,
    })
    await projector.consumeInstallation(TEAM)
    await projector.consumeInstallation(TEAM)

    // Dissolve the scope at epoch 3.
    const dissolved = createScopeControlProjector({
      pool, workerId: 'purge-test',
      pullScopeControlFeed: async () => batch([lifecycleEnvelope(2, 'dissolved', 3)]),
      ackScopeControlFeed: (async () => 0) as never,
    })
    await dissolved.consumeInstallation(TEAM)
    let scope = await pool.query<{ state: string }>(
      `SELECT state FROM memory_owner_scopes WHERE installation_id = $1`, [TEAM])
    expect(scope.rows[0].state).toBe('dissolved')

    // Replay an older active/suspended fact: the tombstone wins.
    const replay = createScopeControlProjector({
      pool, workerId: 'purge-test',
      pullScopeControlFeed: async () => batch([
        lifecycleEnvelope(3, 'suspended', 2),
        lifecycleEnvelope(4, 'active', 2),
      ]),
      ackScopeControlFeed: (async () => 0) as never,
    })
    await replay.consumeInstallation(TEAM)
    scope = await pool.query<{ state: string }>(
      `SELECT state FROM memory_owner_scopes WHERE installation_id = $1`, [TEAM])
    expect(scope.rows[0].state).toBe('dissolved')
    const tombstone = await pool.query<{ authorization_epoch: string }>(
      `SELECT authorization_epoch::text FROM memory_scope_tombstones WHERE owner_scope_kind = 'team' AND owner_scope_id = $1`,
      [TEAM_SCOPE],
    )
    expect(Number(tombstone.rows[0].authorization_epoch)).toBe(3)
  })
})
