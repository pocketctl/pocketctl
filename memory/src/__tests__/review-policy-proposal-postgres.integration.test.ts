import { randomUUID } from 'crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { createPromotionService } from '../governance/promotion-service.js'
import { createPublicationService } from '../governance/publication-service.js'
import type { ValidatedV2Grant } from '../governance/authorization.js'
import {
  DEFAULT_ORGANIZATION_REVIEW_POLICY,
  createReviewPolicyRepository,
  loadEffectiveReviewPolicySnapshot,
} from '../governance/review-policy.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const describeWithDatabase = databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1'
  ? describe : describe.skip

describeWithDatabase('Team review policy with an optional parent Memory installation', () => {
  let pool: pg.Pool

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl })
    const database = await pool.query<{ name: string }>('SELECT current_database() AS name')
    if (!/test/i.test(database.rows[0]?.name ?? '')) {
      throw new Error('Refusing integration test against non-test database')
    }
    await applyMemorySchema(pool)
  }, 60_000)

  afterAll(async () => {
    await pool?.end()
  })

  async function fixture() {
    const personal = randomUUID()
    const team = randomUUID()
    const organization = randomUUID()
    const sourceClaim = randomUUID()
    const sourceVersion = randomUUID()
    const evidence = randomUUID()
    const episode = randomUUID()
    const proposer = randomUUID()
    const reviewers = [randomUUID(), randomUUID(), randomUUID()]
    const publisher = randomUUID()
    const policies = createReviewPolicyRepository(pool)
    const promotion = createPromotionService(pool)
    const publication = createPublicationService(pool)

    async function install(id: string, kind: 'personal' | 'team' | 'organization') {
      await pool.query(`
        INSERT INTO memory_installations
          (installation_id, provider_id, relay_status, local_status, config_version,
           granted_scopes, subscriptions, enabled_services, event_filter)
        VALUES ($1, 'pocketctl-memory', 'active', 'ready', 1,
                '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb)
      `, [id])
      await pool.query(`
        INSERT INTO memory_owner_scopes
          (installation_id, owner_scope_kind, owner_scope_id, parent_organization_id)
        VALUES ($1, $2, $1, $3)
      `, [id, kind, kind === 'team' ? organization : null])
    }
    await install(personal, 'personal')
    await install(team, 'team')
    for (const [membership, roles] of [
      [proposer, ['contributor']],
      ...reviewers.map(id => [id, ['reviewer']] as const),
      [publisher, ['publisher']],
    ] as const) {
      await pool.query(`
        INSERT INTO memory_scope_memberships
          (installation_id, membership_id, roles, state, membership_revision)
        VALUES ($1, $2, $3::text[], 'active', 1)
      `, [team, membership, roles])
    }
    await pool.query(`
      INSERT INTO knowledge_claims
        (claim_id, installation_id, claim_type, scope_kind, scope_key, normalized_key, state)
      VALUES ($1, $2, 'repository_convention', 'repository', '/repo', 'optional-parent', 'active')
    `, [sourceClaim, personal])
    await pool.query(`
      INSERT INTO knowledge_versions
        (version_id, installation_id, claim_id, version_number, statement, authority, confidence)
      VALUES ($1, $2, $3, 1, 'Require the migration gate before deploy.', 'user_accepted', 0.9)
    `, [sourceVersion, personal, sourceClaim])
    await pool.query(`
      UPDATE knowledge_claims SET current_version_id = $2
      WHERE installation_id = $1 AND claim_id = $3
    `, [personal, sourceVersion, sourceClaim])
    await pool.query(`
      INSERT INTO work_episodes
        (installation_id, episode_id, session_id, turn_id, state, compiler_version)
      VALUES ($1, $2, $3, 'policy-turn', 'ready', 'test')
    `, [personal, episode, `policy-${episode}`])
    await pool.query(`
      INSERT INTO knowledge_evidence
        (evidence_id, installation_id, version_id, episode_id, ordinal,
         evidence_kind, excerpt, excerpt_hash, occurred_at)
      VALUES ($1, $2, $3, $4, 1, 'episode', 'The migration gate passed.', 'hash', NOW())
    `, [evidence, personal, sourceVersion, episode])

    function grant(membershipId: string, permissions: string[]): ValidatedV2Grant {
      return {
        primaryInstallationId: team,
        configVersion: '1',
        scopeBindings: [{
          installation_id: team, owner_scope_kind: 'team', owner_scope_id: team,
          membership_id: membershipId, membership_revision: '1',
          authorization_epoch: '1', permissions,
        }, {
          installation_id: personal, owner_scope_kind: 'personal', owner_scope_id: personal,
          membership_id: null, membership_revision: '0', authorization_epoch: '1',
          permissions: ['read', 'contribute'],
        }],
      }
    }
    async function propose() {
      return promotion.propose({
        grant: grant(proposer, ['read', 'contribute']),
        sourceInstallationId: personal, sourceClaimId: sourceClaim,
        evidenceIds: [evidence], idempotencyDigest: randomUUID(),
      })
    }
    async function approve(candidateId: string, reviewer: string) {
      return publication.decide({
        grant: grant(reviewer, ['read', 'review']), targetInstallationId: team,
        candidateId, expectedCandidateRevision: 1, decision: 'approve',
      })
    }
    async function publish(candidateId: string) {
      return publication.publish({
        grant: grant(publisher, ['read', 'review', 'publish']), targetInstallationId: team,
        candidateId, expectedCandidateRevision: 1, resolution: 'new',
      })
    }
    async function snapshot(ensure = false) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const result = await loadEffectiveReviewPolicySnapshot(client, team, { ensure })
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    }
    return { team, organization, reviewers, install, policies, propose, approve, publish, snapshot }
  }

  test('proposes without a parent installation and enforces the Organization two-reviewer floor', async () => {
    const f = await fixture()
    const proposed = await f.propose()
    expect(proposed.candidate.state).toBe('proposed')
    expect(proposed.candidateRevision.parent_review_policy_version_id).toBeNull()
    expect(await f.snapshot()).toMatchObject({
      parentActiveVersionId: null,
      policy: { minimum_approvals: 2, require_independent_reviewer: true, allow_self_publish: false },
    })
    await f.approve(proposed.candidate.candidate_id, f.reviewers[0])
    await expect(f.publish(proposed.candidate.candidate_id)).rejects.toMatchObject({ code: 'quorum_failed' })
    await f.approve(proposed.candidate.candidate_id, f.reviewers[1])
    const published = await f.publish(proposed.candidate.candidate_id)
    const authority = await pool.query(`
      SELECT parent_review_policy_version_id, counted_decision_ids
      FROM memory_authority_records WHERE installation_id = $1 AND version_id = $2
    `, [f.team, published.versionId])
    expect(authority.rows[0].parent_review_policy_version_id).toBeNull()
    expect(authority.rows[0].counted_decision_ids).toHaveLength(2)
    expect((await pool.query(`
      SELECT 1 FROM memory_owner_scopes
      WHERE owner_scope_kind = 'organization' AND owner_scope_id = $1
    `, [f.organization])).rowCount).toBe(0)
  })

  test('keeps the Organization floor when a newly installed parent has no policy head', async () => {
    const f = await fixture()
    const proposed = await f.propose()
    await f.install(f.organization, 'organization')
    expect(await f.snapshot()).toMatchObject({ parentActiveVersionId: null, policy: { minimum_approvals: 2 } })
    expect(await f.policies.getHead(f.organization)).toBeNull()
    const initialized = await f.snapshot(true)
    expect(initialized.parentActiveVersionId).not.toBeNull()
    await expect(f.publish(proposed.candidate.candidate_id)).rejects.toMatchObject({ code: 'policy_head_changed' })
  })

  test('still rejects a missing primary Team policy head on reads', async () => {
    const f = await fixture()
    await expect(f.snapshot()).rejects.toThrow('review policy head missing')
    expect(await f.policies.getHead(f.team)).toBeNull()
  })

  test('does not replace an invalid configured parent policy with the default floor', async () => {
    const f = await fixture()
    await f.propose()
    await f.install(f.organization, 'organization')
    await f.policies.ensurePolicySet(f.organization, {
      ...DEFAULT_ORGANIZATION_REVIEW_POLICY, minimum_approvals: 0,
    })
    await expect(f.snapshot()).rejects.toThrow('review policy document invalid')
  })

  test('inherits configured parent policy and fences proposals across parent installation and policy changes', async () => {
    const f = await fixture()
    const beforeInstallation = await f.propose()
    await Promise.all(f.reviewers.map(id => f.approve(beforeInstallation.candidate.candidate_id, id)))
    await f.install(f.organization, 'organization')
    const parent = await f.policies.ensurePolicySet(f.organization, {
      ...DEFAULT_ORGANIZATION_REVIEW_POLICY, minimum_approvals: 3,
      candidate_ttl_days: 5, max_shared_evidence: 2,
    })
    await expect(f.publish(beforeInstallation.candidate.candidate_id)).rejects.toMatchObject({ code: 'policy_head_changed' })
    const afterInstallation = await f.propose()
    expect(afterInstallation.candidateRevision.parent_review_policy_version_id).toBe(parent.policyVersionId)
    expect(await f.snapshot()).toMatchObject({
      parentActiveVersionId: parent.policyVersionId,
      policy: { minimum_approvals: 3, candidate_ttl_days: 5, max_shared_evidence: 2 },
    })
    await f.approve(afterInstallation.candidate.candidate_id, f.reviewers[0])
    await f.approve(afterInstallation.candidate.candidate_id, f.reviewers[1])
    await expect(f.publish(afterInstallation.candidate.candidate_id)).rejects.toMatchObject({ code: 'quorum_failed' })
    await f.policies.publishVersion({
      installationId: f.organization,
      document: { ...DEFAULT_ORGANIZATION_REVIEW_POLICY, minimum_approvals: 4 },
      createdByMembershipId: null, expectedRevision: 1,
    })
    await expect(f.publish(afterInstallation.candidate.candidate_id)).rejects.toMatchObject({ code: 'policy_head_changed' })
    expect((await pool.query('SELECT 1 FROM knowledge_claims WHERE installation_id = $1', [f.team])).rowCount).toBe(0)
  })
})
