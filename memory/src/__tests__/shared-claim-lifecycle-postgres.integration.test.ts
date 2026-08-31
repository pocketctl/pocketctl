import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { createPromotionService } from '../governance/promotion-service.js'
import { createPublicationService, createSharedClaimLifecycle } from '../governance/publication-service.js'
import type { ValidatedV2Grant } from '../governance/authorization.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const integrationEnabled = Boolean(
  databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const PERSONAL = 'fffffff1-0000-4000-8000-000000000001'
const TEAM = 'fffffff1-0000-4000-8000-000000000002'
const SOURCE_CLAIM = 'fffffff1-0000-4000-8000-000000000011'
const SOURCE_VERSION = 'fffffff1-0000-4000-8000-000000000012'
const EVIDENCE = 'fffffff1-0000-4000-8000-000000000013'
const EPISODE = 'fffffff1-0000-4000-8000-000000000014'
const PROPOSER = 'fffffff1-0000-4000-8000-000000000021'
const REVIEWER = 'fffffff1-0000-4000-8000-000000000022'
const PUBLISHER = 'fffffff1-0000-4000-8000-000000000023'

function grantFor(membershipId: string, permissions: string[]): ValidatedV2Grant {
  return {
    primaryInstallationId: TEAM,
    configVersion: '1',
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
        owner_scope_id: 'fffffff1-0000-4000-8000-000000000031',
        membership_id: membershipId,
        membership_revision: '2',
        authorization_epoch: '1',
        permissions,
      },
    ],
  }
}

describeWithDatabase('shared claim lifecycle visibility (PostgreSQL)', () => {
  let pool: pg.Pool
  let promotion: ReturnType<typeof createPromotionService>
  let publication: ReturnType<typeof createPublicationService>
  let lifecycle: ReturnType<typeof createSharedClaimLifecycle>

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl })
    const database = await pool.query<{ database_name: string }>(
      'SELECT current_database() AS database_name',
    )
    if (!/test/i.test(database.rows[0]?.database_name ?? '')) {
      throw new Error('Refusing integration test against non-test database')
    }
    await applyMemorySchema(pool)
    promotion = createPromotionService(pool)
    publication = createPublicationService(pool)
    lifecycle = createSharedClaimLifecycle(pool)
  }, 60_000)

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
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
      VALUES ($1, $2, 'repository_convention', 'repository', '/repo', 'lifecycle-key', 'active')
    `, [SOURCE_CLAIM, PERSONAL])
    await pool.query(`
      INSERT INTO knowledge_versions
        (version_id, installation_id, claim_id, version_number, statement, authority, confidence)
      VALUES ($1, $2, $3, 1, 'lifecycle gated statement', 'user_accepted', 0.9)
    `, [SOURCE_VERSION, PERSONAL, SOURCE_CLAIM])
    await pool.query(`
      UPDATE knowledge_claims SET current_version_id = $2 WHERE installation_id = $1 AND claim_id = $3
    `, [PERSONAL, SOURCE_VERSION, SOURCE_CLAIM])
    await pool.query(`
      INSERT INTO work_episodes (installation_id, episode_id, session_id, turn_id, state, compiler_version)
      VALUES ($1, $2, 'lc-session', 'lc-turn', 'ready', 'test')
    `, [PERSONAL, EPISODE])
    await pool.query(`
      INSERT INTO knowledge_evidence
        (evidence_id, installation_id, version_id, episode_id, ordinal, evidence_kind, excerpt, excerpt_hash, occurred_at)
      VALUES ($1, $2, $3, $4, 1, 'episode', 'lifecycle excerpt', 'hash', NOW())
    `, [EVIDENCE, PERSONAL, SOURCE_VERSION, EPISODE])
    for (const [membershipId, roles] of [
      [PROPOSER, ['contributor']], [REVIEWER, ['reviewer']], [PUBLISHER, ['publisher']],
    ] as const) {
      await pool.query(`
        INSERT INTO memory_scope_memberships (installation_id, membership_id, roles, state, membership_revision)
        VALUES ($1, $2, $3::text[], 'active', 2)
      `, [TEAM, membershipId, roles])
    }
  })

  async function activeTeamStatements(): Promise<string[]> {
    const result = await pool.query<{ statement: string }>(`
      SELECT v.statement FROM knowledge_claims c
      JOIN knowledge_versions v ON v.version_id = c.current_version_id AND v.installation_id = c.installation_id
      WHERE c.installation_id = $1 AND c.state = 'active'
    `, [TEAM])
    return result.rows.map(row => row.statement)
  }

  test('a personal claim never appears in team recall before publication, then does after', async () => {
    expect(await activeTeamStatements()).toEqual([])

    const proposed = await promotion.propose({
      grant: grantFor(PROPOSER, ['read', 'contribute']),
      sourceInstallationId: PERSONAL, sourceClaimId: SOURCE_CLAIM,
      evidenceIds: [EVIDENCE], idempotencyDigest: 'lifecycle-1',
    })
    // Proposed but unpublished: still invisible.
    expect(await activeTeamStatements()).toEqual([])

    await publication.decide({
      grant: grantFor(REVIEWER, ['read', 'review']),
      targetInstallationId: TEAM, candidateId: proposed.candidate.candidate_id,
      expectedCandidateRevision: proposed.candidate.revision, decision: 'approve',
    })
    const published = await publication.publish({
      grant: grantFor(PUBLISHER, ['read', 'review', 'publish']),
      targetInstallationId: TEAM, candidateId: proposed.candidate.candidate_id,
      expectedCandidateRevision: proposed.candidate.revision, resolution: 'new',
    })
    expect(await activeTeamStatements()).toEqual(['lifecycle gated statement'])

    // Revocation removes it from recall while the evidence copy survives.
    const claimRow = await pool.query<{ revision: string }>(
      `SELECT revision::text FROM knowledge_claims WHERE installation_id = $1 AND claim_id = $2`,
      [TEAM, published.claimId],
    )
    await lifecycle.revokeSharedClaim({
      grant: grantFor(PUBLISHER, ['read', 'review', 'publish']),
      targetInstallationId: TEAM, claimId: published.claimId,
      reason: 'superseded by policy change', expectedRevision: Number(claimRow.rows[0].revision),
    })
    expect(await activeTeamStatements()).toEqual([])
    const retained = await pool.query(`
      SELECT COUNT(*)::text AS count FROM knowledge_evidence
      WHERE installation_id = $1 AND visibility = 'shared'
    `, [TEAM])
    expect(Number(retained.rows[0].count)).toBeGreaterThan(0)
  })
})
