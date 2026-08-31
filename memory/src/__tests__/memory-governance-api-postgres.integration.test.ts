import Fastify, { type FastifyInstance } from 'fastify'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { registerGovernanceRoutes } from '../api/governance-routes.js'
import type { RouteV2Grant } from '../governance/authorization.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const integrationEnabled = Boolean(
  databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const PERSONAL = 'ddddeeee-0000-4000-8000-000000000001'
const TEAM = 'ddddeeee-0000-4000-8000-000000000002'
const SOURCE_CLAIM = 'ddddeeee-0000-4000-8000-000000000011'
const SOURCE_VERSION = 'ddddeeee-0000-4000-8000-000000000012'
const EVIDENCE = 'ddddeeee-0000-4000-8000-000000000013'
const EPISODE = 'ddddeeee-0000-4000-8000-000000000014'
const PROPOSER = 'ddddeeee-0000-4000-8000-000000000021'
const REVIEWER = 'ddddeeee-0000-4000-8000-000000000022'
const PUBLISHER = 'ddddeeee-0000-4000-8000-000000000023'

function grantFor(membershipId: string, permissions: string[]): RouteV2Grant {
  return {
    version: 'v2',
    installationId: TEAM,
    primaryInstallationId: TEAM,
    services: ['memory.search'],
    configVersion: '1',
    callerType: 'web',
    scopeBindings: [
      {
        installation_id: PERSONAL,
        owner_scope_kind: 'personal',
        owner_scope_id: PERSONAL,
        membership_id: null,
        membership_revision: '0',
        authorization_epoch: '1',
        permissions: ['read', 'contribute'],
      },
      {
        installation_id: TEAM,
        owner_scope_kind: 'team',
        owner_scope_id: 'ddddeeee-0000-4000-8000-000000000031',
        membership_id: membershipId,
        membership_revision: '2',
        authorization_epoch: '1',
        permissions,
      },
    ],
  }
}

describeWithDatabase('memory governance API (PostgreSQL)', () => {
  let pool: pg.Pool
  let app: FastifyInstance

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
    await app?.close()
    await pool?.end()
  })

  beforeEach(async () => {
    await app?.close()
    await pool.query(`
      TRUNCATE memory_governance_events, memory_review_decisions, memory_promotion_evidence,
                memory_promotion_candidate_versions, memory_promotion_candidates,
                memory_authority_records, memory_jobs,
                memory_review_policy_heads, memory_review_policy_versions, memory_review_policy_sets,
                memory_scope_tombstones, memory_scope_memberships, memory_owner_scopes,
                knowledge_evidence, knowledge_versions, knowledge_claims, work_episodes,
                memory_installations CASCADE
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
        VALUES ($1, $2, $1)
      `, [installationId, kind])
    }
    await pool.query(`
      INSERT INTO knowledge_claims
        (claim_id, installation_id, claim_type, scope_kind, scope_key, normalized_key, state)
      VALUES ($1, $2, 'repository_convention', 'repository', '/repo', 'api-key', 'active')
    `, [SOURCE_CLAIM, PERSONAL])
    await pool.query(`
      INSERT INTO knowledge_versions
        (version_id, installation_id, claim_id, version_number, statement, authority, confidence)
      VALUES ($1, $2, $3, 1, 'api gated statement', 'user_accepted', 0.9)
    `, [SOURCE_VERSION, PERSONAL, SOURCE_CLAIM])
    await pool.query(`
      UPDATE knowledge_claims SET current_version_id = $2 WHERE installation_id = $1 AND claim_id = $3
    `, [PERSONAL, SOURCE_VERSION, SOURCE_CLAIM])
    await pool.query(`
      INSERT INTO work_episodes (installation_id, episode_id, session_id, turn_id, state, compiler_version)
      VALUES ($1, $2, 'api-session', 'api-turn', 'ready', 'test')
    `, [PERSONAL, EPISODE])
    await pool.query(`
      INSERT INTO knowledge_evidence
        (evidence_id, installation_id, version_id, episode_id, ordinal, evidence_kind, excerpt, excerpt_hash, occurred_at)
      VALUES ($1, $2, $3, $4, 1, 'episode', 'api excerpt', 'hash', NOW())
    `, [EVIDENCE, PERSONAL, SOURCE_VERSION, EPISODE])
    for (const [membershipId, roles] of [
      [PROPOSER, ['contributor']], [REVIEWER, ['reviewer']], [PUBLISHER, ['publisher']],
    ] as const) {
      await pool.query(`
        INSERT INTO memory_scope_memberships (installation_id, membership_id, roles, state, membership_revision)
        VALUES ($1, $2, $3::text[], 'active', 2)
      `, [TEAM, membershipId, roles])
    }

    app = Fastify()
    const grantsByActor: Record<string, RouteV2Grant> = {
      [PROPOSER]: grantFor(PROPOSER, ['read', 'contribute']),
      [REVIEWER]: grantFor(REVIEWER, ['read', 'review']),
      [PUBLISHER]: grantFor(PUBLISHER, ['read', 'review', 'publish', 'policy_admin', 'scope_admin']),
    }
    registerGovernanceRoutes(app, {
      pool,
      guard: {
        guard: vi.fn(),
        guardV2: vi.fn(async (input: { authorization?: string }) => {
          const actor = (input.authorization ?? '').replace('Bearer actor-', '')
          return grantsByActor[actor] ?? grantsByActor[PROPOSER]
        }),
      } as never,
      sharedScopesEnabled: false,
      cursorSigningKey: 'test-governance-cursor-key',
    })
  })

  test('propose → decide → publish through the HTTP surface', async () => {
    const proposed = await app.inject({
      method: 'POST',
      url: '/api/v1/memory/governance/proposals',
      headers: { authorization: 'Bearer token', 'idempotency-key': 'api-propose-1' },
      payload: {
        target_installation_id: TEAM,
        expected_revision: 1,
        source_installation_id: PERSONAL,
        source_claim_id: SOURCE_CLAIM,
        evidence_ids: [EVIDENCE],
      },
    })
    expect(proposed.statusCode).toBe(201)
    const candidateId = proposed.json().candidate.candidate_id
    expect(proposed.json().classification).toBe('new')

    // Idempotent replay returns the same candidate.
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/memory/governance/proposals',
      headers: { authorization: 'Bearer token', 'idempotency-key': 'api-propose-1' },
      payload: {
        target_installation_id: TEAM,
        expected_revision: 1,
        source_installation_id: PERSONAL,
        source_claim_id: SOURCE_CLAIM,
        evidence_ids: [EVIDENCE],
      },
    })
    expect(replay.statusCode).toBe(201)
    expect(replay.json().candidate.candidate_id).toBe(candidateId)

    const queue = await app.inject({
      method: 'GET',
      url: `/api/v1/memory/governance/proposals?target_installation_id=${TEAM}`,
      headers: { authorization: 'Bearer token' },
    })
    expect(queue.statusCode).toBe(200)
    expect(queue.json().queue).toHaveLength(1)

    // Publish before any approval fails quorum through the API envelope.
    const premature = await app.inject({
      method: 'POST',
      url: `/api/v1/memory/governance/proposals/${candidateId}/publish`,
      headers: { authorization: `Bearer actor-${PUBLISHER}`, 'idempotency-key': 'api-publish-early' },
      payload: { target_installation_id: TEAM, expected_revision: 1, resolution: 'new' },
    })
    expect(premature.statusCode).toBe(409)
    expect(premature.json().error.code).toBe('quorum_failed')

    // Decide + publish with properly granted actors.
    const decision = await app.inject({
      method: 'POST',
      url: `/api/v1/memory/governance/proposals/${candidateId}/decisions`,
      headers: { authorization: `Bearer actor-${REVIEWER}`, 'idempotency-key': 'api-decide-1' },
      payload: { target_installation_id: TEAM, expected_revision: 1, decision: 'approve' },
    })
    expect(decision.statusCode).toBe(200)

    const publish = await app.inject({
      method: 'POST',
      url: `/api/v1/memory/governance/proposals/${candidateId}/publish`,
      headers: { authorization: `Bearer actor-${PUBLISHER}`, 'idempotency-key': 'api-publish-1' },
      payload: { target_installation_id: TEAM, expected_revision: 1, resolution: 'new' },
    })
    expect(publish.statusCode).toBe(200)
    expect(publish.json().resolution).toBe('new')

    const claim = await pool.query(`
      SELECT state, owner_scope_kind FROM knowledge_claims
      WHERE installation_id = $1 AND claim_id = $2
    `, [TEAM, publish.json().claim_id])
    expect(claim.rows[0]).toMatchObject({ state: 'active', owner_scope_kind: 'team' })
  })
})
