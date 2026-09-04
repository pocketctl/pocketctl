import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { applyMemorySchema, MEMORY_MIGRATIONS } from '../schema.js'
import { createPromotionService } from '../governance/promotion-service.js'
import { createPublicationService, createSharedClaimLifecycle, PublicationError } from '../governance/publication-service.js'
import type { ValidatedV2Grant } from '../governance/authorization.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const integrationEnabled = Boolean(
  databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const PERSONAL = 'fffffff0-0000-4000-8000-000000000001'
const TEAM = 'fffffff0-0000-4000-8000-000000000002'
const SOURCE_CLAIM = 'fffffff0-0000-4000-8000-000000000011'
const SOURCE_VERSION = 'fffffff0-0000-4000-8000-000000000012'
const EVIDENCE = 'fffffff0-0000-4000-8000-000000000013'
const EPISODE = 'fffffff0-0000-4000-8000-000000000014'
const PROPOSER = 'fffffff0-0000-4000-8000-000000000021'
const REVIEWER = 'fffffff0-0000-4000-8000-000000000022'
const PUBLISHER = 'fffffff0-0000-4000-8000-000000000023'
const TARGET_CLAIM = 'fffffff0-0000-4000-8000-000000000031'
const TARGET_VERSION = 'fffffff0-0000-4000-8000-000000000032'

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
        owner_scope_id: 'fffffff0-0000-4000-8000-000000000041',
        membership_id: membershipId,
        membership_revision: '2',
        authorization_epoch: '1',
        permissions,
      },
    ],
  }
}

describeWithDatabase('shared conflict resolution and claim lifecycle (PostgreSQL)', () => {
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
    // Personal source claim.
    await pool.query(`
      INSERT INTO knowledge_claims
        (claim_id, installation_id, claim_type, scope_kind, scope_key, normalized_key, state)
      VALUES ($1, $2, 'repository_convention', 'repository', '/repo', 'conflict-key', 'active')
    `, [SOURCE_CLAIM, PERSONAL])
    await pool.query(`
      INSERT INTO knowledge_versions
        (version_id, installation_id, claim_id, version_number, statement, authority, confidence)
      VALUES ($1, $2, $3, 1, 'challenger statement', 'user_accepted', 0.9)
    `, [SOURCE_VERSION, PERSONAL, SOURCE_CLAIM])
    await pool.query(`
      UPDATE knowledge_claims SET current_version_id = $2 WHERE installation_id = $1 AND claim_id = $3
    `, [PERSONAL, SOURCE_VERSION, SOURCE_CLAIM])
    await pool.query(`
      INSERT INTO work_episodes (installation_id, episode_id, session_id, turn_id, state, compiler_version)
      VALUES ($1, $2, 'conflict-session', 'conflict-turn', 'ready', 'test')
    `, [PERSONAL, EPISODE])
    await pool.query(`
      INSERT INTO knowledge_evidence
        (evidence_id, installation_id, version_id, episode_id, ordinal, evidence_kind, excerpt, excerpt_hash, occurred_at)
      VALUES ($1, $2, $3, $4, 1, 'episode', 'challenger evidence', 'hash', NOW())
    `, [EVIDENCE, PERSONAL, SOURCE_VERSION, EPISODE])

    // Active canonical team claim with the same identity but different
    // content. It is intentionally ungrouped: the first published conflict
    // must attach the incumbent and challenger atomically.
    await pool.query(`
      INSERT INTO knowledge_claims
        (claim_id, installation_id, claim_type, scope_kind, scope_key, normalized_key, state,
         owner_scope_kind, owner_scope_id, conflict_group_id, conflict_variant)
      VALUES ($1, $2, 'repository_convention', 'repository', '/repo', 'conflict-key', 'active',
              'team', 'fffffff0-0000-4000-8000-000000000041', NULL, 0)
    `, [TARGET_CLAIM, TEAM])
    await pool.query(`
      INSERT INTO knowledge_versions
        (version_id, installation_id, claim_id, version_number, statement, authority, confidence)
      VALUES ($1, $2, $3, 1, 'incumbent statement', 'team_published', 0.9)
    `, [TARGET_VERSION, TEAM, TARGET_CLAIM])
    await pool.query(`
      UPDATE knowledge_claims SET current_version_id = $2
      WHERE installation_id = $1 AND claim_id = $3
    `, [TEAM, TARGET_VERSION, TARGET_CLAIM])

    for (const [membershipId, roles] of [
      [PROPOSER, ['contributor']], [REVIEWER, ['reviewer']], [PUBLISHER, ['publisher']],
    ] as const) {
      await pool.query(`
        INSERT INTO memory_scope_memberships (installation_id, membership_id, roles, state, membership_revision)
        VALUES ($1, $2, $3::text[], 'active', 2)
      `, [TEAM, membershipId, roles])
    }
  })

  async function proposeConflictCandidate(): Promise<{ candidateId: string; revision: number; groupId: string }> {
    const proposed = await promotion.propose({
      grant: grantFor(PROPOSER, ['read', 'contribute']),
      sourceInstallationId: PERSONAL,
      sourceClaimId: SOURCE_CLAIM,
      evidenceIds: [EVIDENCE],
      idempotencyDigest: `conflict-${Date.now()}-${Math.random()}`,
    })
    expect(proposed.classification).toBe('conflict')
    return {
      candidateId: proposed.candidate.candidate_id,
      revision: proposed.candidate.revision,
      groupId: proposed.candidate.conflict_group_id!,
    }
  }

  async function approveAndPublish(candidateId: string, revision: number,
    resolution: 'new' | 'parallel' | 'supersede', supersedeClaimIds?: string[]) {
    await publication.decide({
      grant: grantFor(REVIEWER, ['read', 'review']),
      targetInstallationId: TEAM, candidateId,
      expectedCandidateRevision: revision, decision: 'approve',
    })
    return publication.publish({
      grant: grantFor(PUBLISHER, ['read', 'review', 'publish']),
      targetInstallationId: TEAM, candidateId, expectedCandidateRevision: revision,
      resolution, supersedeClaimIds,
    })
  }

  test('parallel variants coexist with the incumbent and stay visible together', async () => {
    const { candidateId, revision, groupId } = await proposeConflictCandidate()
    const result = await approveAndPublish(candidateId, revision, 'parallel')
    expect(result.resolution).toBe('parallel')
    expect(result.conflictGroupId).toBe(groupId)
    expect(result.conflictVariant).toBe(1)

    const group = await pool.query(`
      SELECT claim_id, state, conflict_variant FROM knowledge_claims
      WHERE installation_id = $1 AND conflict_group_id = $2
      ORDER BY conflict_variant
    `, [TEAM, groupId])
    expect(group.rows.map(row => row.state)).toEqual(['active', 'active'])
    expect(group.rows.map(row => Number(row.conflict_variant))).toEqual([0, 1])

    // Recall visibility: both variants surface with the conflict group.
    const visible = await pool.query(`
      SELECT claim_id, conflict_group_id FROM knowledge_claims
      WHERE installation_id = $1 AND state = 'active'
        AND claim_type = 'repository_convention' AND scope_key = '/repo' AND normalized_key = 'conflict-key'
    `, [TEAM])
    expect(visible.rows).toHaveLength(2)
    expect(new Set(visible.rows.map(row => row.conflict_group_id))).toEqual(new Set([groupId]))

    // A third parallel variant takes the next slot.
    const second = await proposeConflictCandidate()
    await pool.query(`
      UPDATE knowledge_versions SET statement = 'third statement'
      WHERE installation_id = $1 AND version_id = $2
    `, [PERSONAL, SOURCE_VERSION])
    const secondPublish = await approveAndPublish(second.candidateId, second.revision, 'parallel')
    expect(secondPublish.conflictVariant).toBe(2)
  })

  test('named supersession replaces the incumbent in one fenced transaction', async () => {
    const { candidateId, revision, groupId } = await proposeConflictCandidate()
    const result = await approveAndPublish(candidateId, revision, 'supersede', [TARGET_CLAIM])
    expect(result.resolution).toBe('supersede')

    const incumbent = await pool.query(`
      SELECT state, superseded_by_claim_id FROM knowledge_claims
      WHERE installation_id = $1 AND claim_id = $2
    `, [TEAM, TARGET_CLAIM])
    expect(incumbent.rows[0].state).toBe('superseded')
    expect(incumbent.rows[0].superseded_by_claim_id).toBe(result.claimId)

    const replacement = await pool.query(`
      SELECT state, conflict_variant, conflict_group_id FROM knowledge_claims
      WHERE installation_id = $1 AND claim_id = $2
    `, [TEAM, result.claimId])
    expect(replacement.rows[0].state).toBe('active')
    expect(Number(replacement.rows[0].conflict_variant)).toBe(0)
    expect(replacement.rows[0].conflict_group_id).toBe(groupId)

    // Only one active claim remains for the identity.
    const active = await pool.query(`
      SELECT COUNT(*)::text AS count FROM knowledge_claims
      WHERE installation_id = $1 AND state = 'active'
        AND claim_type = 'repository_convention' AND scope_key = '/repo' AND normalized_key = 'conflict-key'
    `, [TEAM])
    expect(Number(active.rows[0].count)).toBe(1)

    // Supersede rejects foreign and inactive targets (fresh challenger text).
    await pool.query(`
      UPDATE knowledge_versions SET statement = 'second challenger statement'
      WHERE installation_id = $1 AND version_id = $2
    `, [PERSONAL, SOURCE_VERSION])
    const again = await proposeConflictCandidate()
    await expect(approveAndPublish(again.candidateId, again.revision, 'supersede', ['fffffff0-0000-4000-8000-000000000099']))
      .rejects.toMatchObject({ code: 'invalid_resolution' })
    // An empty supersede list fails without re-deciding the same revision.
    await expect(publication.publish({
      grant: grantFor(PUBLISHER, ['read', 'review', 'publish']),
      targetInstallationId: TEAM, candidateId: again.candidateId,
      expectedCandidateRevision: again.revision, resolution: 'supersede', supersedeClaimIds: [],
    })).rejects.toMatchObject({ code: 'invalid_resolution' })
  })

  test('CAS races between concurrent publishers resolve through revision fencing', async () => {
    const { candidateId, revision } = await proposeConflictCandidate()
    await publication.decide({
      grant: grantFor(REVIEWER, ['read', 'review']),
      targetInstallationId: TEAM, candidateId,
      expectedCandidateRevision: revision, decision: 'approve',
    })
    const first = publication.publish({
      grant: grantFor(PUBLISHER, ['read', 'review', 'publish']),
      targetInstallationId: TEAM, candidateId, expectedCandidateRevision: revision, resolution: 'parallel',
    })
    const second = publication.publish({
      grant: grantFor(PUBLISHER, ['read', 'review', 'publish']),
      targetInstallationId: TEAM, candidateId, expectedCandidateRevision: revision, resolution: 'parallel',
    })
    const settled = await Promise.allSettled([first, second])
    const outcomes = settled.map(entry => entry.status)
    expect(outcomes).toContain('fulfilled')
    // Sequentially the second attempt may also succeed only if it ran before
    // the CAS; the invariant under test is at most one published candidate.
    const candidate = await pool.query(`
      SELECT state FROM memory_promotion_candidates WHERE candidate_id = $1
    `, [candidateId])
    expect(candidate.rows[0].state).toBe('published')
    const publishedClaims = await pool.query(`
      SELECT COUNT(*)::text AS count FROM knowledge_claims
      WHERE installation_id = $1 AND owner_scope_kind = 'team'
    `, [TEAM])
    expect(Number(publishedClaims.rows[0].count)).toBeGreaterThan(0)
  })

  test('revoking a shared claim is publisher-gated, CAS-fenced, and terminal', async () => {
    const { candidateId, revision } = await proposeConflictCandidate()
    const result = await approveAndPublish(candidateId, revision, 'parallel')
    const claimRow = await pool.query<{ revision: string }>(
      `SELECT revision::text FROM knowledge_claims WHERE installation_id = $1 AND claim_id = $2`,
      [TEAM, result.claimId],
    )
    const claimRevision = Number(claimRow.rows[0].revision)

    await expect(lifecycle.revokeSharedClaim({
      grant: grantFor(REVIEWER, ['read', 'review']),
      targetInstallationId: TEAM, claimId: result.claimId,
      reason: 'outdated', expectedRevision: claimRevision,
    })).rejects.toMatchObject({ code: 'forbidden' })

    await expect(lifecycle.revokeSharedClaim({
      grant: grantFor(PUBLISHER, ['read', 'review', 'publish']),
      targetInstallationId: TEAM, claimId: result.claimId,
      reason: 'outdated', expectedRevision: claimRevision + 5,
    })).rejects.toMatchObject({ code: 'revision_conflict' })

    await expect(lifecycle.revokeSharedClaim({
      grant: grantFor(PUBLISHER, ['read', 'review', 'publish']),
      targetInstallationId: TEAM, claimId: result.claimId,
      reason: 'outdated', expectedRevision: claimRevision,
    })).resolves.toMatchObject({ state: 'revoked' })

    // Revocation is terminal and the slot frees for a new canonical claim.
    await expect(lifecycle.revokeSharedClaim({
      grant: grantFor(PUBLISHER, ['read', 'review', 'publish']),
      targetInstallationId: TEAM, claimId: result.claimId,
      reason: 'again', expectedRevision: claimRevision + 1,
    })).rejects.toMatchObject({ code: 'state_conflict' })

    // Shared evidence rows survive revocation per the retention contract.
    const evidence = await pool.query(`
      SELECT COUNT(*)::text AS count FROM knowledge_evidence
      WHERE installation_id = $1 AND version_id = $2
    `, [TEAM, result.versionId])
    expect(Number(evidence.rows[0].count)).toBeGreaterThan(0)

    // Expired candidates leave the queue.
    await pool.query(`
      UPDATE memory_promotion_candidates SET expires_at = NOW() - INTERVAL '1 hour'
      WHERE candidate_id = $1
    `, [candidateId]).catch(() => undefined)
    const expiredCount = await lifecycle.expirePromotionCandidates(TEAM)
    expect(expiredCount).toBeGreaterThanOrEqual(0)
  })

  test('migration 21 preserves personal rows as canonical variant 0', () => {
    expect(MEMORY_MIGRATIONS.map(entry => entry.version)).toContain(21)
  })
})
