import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { createPromotionService } from '../governance/promotion-service.js'
import { createPublicationService, PublicationError } from '../governance/publication-service.js'
import { evaluateQuorum } from '../governance/authority.js'
import { DEFAULT_ORGANIZATION_REVIEW_POLICY, DEFAULT_TEAM_REVIEW_POLICY } from '../governance/review-policy.js'
import type { ValidatedV2Grant } from '../governance/authorization.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const integrationEnabled = Boolean(
  databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const PERSONAL = 'eeeeeeee-0000-4000-8000-000000000001'
const TEAM = 'eeeeeeee-0000-4000-8000-000000000002'
const ORG = 'eeeeeeee-0000-4000-8000-000000000003'
const SOURCE_CLAIM = 'eeeeeeee-0000-4000-8000-000000000011'
const SOURCE_VERSION = 'eeeeeeee-0000-4000-8000-000000000012'
const EVIDENCE = 'eeeeeeee-0000-4000-8000-000000000013'
const EPISODE = 'eeeeeeee-0000-4000-8000-000000000014'
const PROPOSER = 'eeeeeeee-0000-4000-8000-000000000021'
const REVIEWER = 'eeeeeeee-0000-4000-8000-000000000022'
const REVIEWER_2 = 'eeeeeeee-0000-4000-8000-000000000023'
const PUBLISHER = 'eeeeeeee-0000-4000-8000-000000000024'

function bindingFor(installationId: string, membershipId: string | null, permissions: string[]) {
  return {
    installation_id: installationId,
    owner_scope_kind: installationId === PERSONAL ? 'personal' as const : 'team' as const,
    owner_scope_id: installationId === PERSONAL ? PERSONAL : 'eeeeeeee-0000-4000-8000-000000000031',
    membership_id: membershipId,
    membership_revision: membershipId === null ? '0' : '2',
    authorization_epoch: '1',
    permissions,
  }
}

function grantFor(actor: { installationId: string; membershipId: string | null; permissions: string[] },
  targetInstallation: string = TEAM): ValidatedV2Grant {
  const targetPermissions = actor.installationId === targetInstallation
    ? actor.permissions
    : ['read', 'contribute']
  return {
    primaryInstallationId: targetInstallation,
    configVersion: '1',
    scopeBindings: [
      bindingFor(PERSONAL, null, ['read', 'contribute']),
      bindingFor(targetInstallation, actor.membershipId, targetPermissions),
      bindingFor(TEAM === targetInstallation ? ORG : TEAM,
        actor.membershipId, targetPermissions),
    ].filter((binding, index, all) =>
      all.findIndex(candidate => candidate.installation_id === binding.installation_id) === index),
  }
}

describeWithDatabase('governance publication transaction (PostgreSQL)', () => {
  let pool: pg.Pool
  let promotion: ReturnType<typeof createPromotionService>
  let publication: ReturnType<typeof createPublicationService>
  let candidateId: string
  let candidateRevision: number

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
    for (const [installationId, kind] of [
      [PERSONAL, 'personal'], [TEAM, 'team'], [ORG, 'organization'],
    ] as const) {
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
      VALUES ($1, $2, 'repository_convention', 'repository', '/repo', 'publish-key', 'active')
    `, [SOURCE_CLAIM, PERSONAL])
    await pool.query(`
      INSERT INTO knowledge_versions
        (version_id, installation_id, claim_id, version_number, statement, authority, confidence)
      VALUES ($1, $2, $3, 1, 'gated deploy statement', 'user_accepted', 0.9)
    `, [SOURCE_VERSION, PERSONAL, SOURCE_CLAIM])
    await pool.query(`
      UPDATE knowledge_claims SET current_version_id = $2 WHERE installation_id = $1 AND claim_id = $3
    `, [PERSONAL, SOURCE_VERSION, SOURCE_CLAIM])
    await pool.query(`
      INSERT INTO work_episodes (installation_id, episode_id, session_id, turn_id, state, compiler_version)
      VALUES ($1, $2, 'pub-session', 'pub-turn', 'ready', 'test')
    `, [PERSONAL, EPISODE])
    await pool.query(`
      INSERT INTO knowledge_evidence
        (evidence_id, installation_id, version_id, episode_id, ordinal, evidence_kind, excerpt, excerpt_hash, occurred_at)
      VALUES ($1, $2, $3, $4, 1, 'episode', 'publish excerpt', 'hash', NOW())
    `, [EVIDENCE, PERSONAL, SOURCE_VERSION, EPISODE])

    const memberships: Array<[string, string[]]> = [
      [PROPOSER, ['contributor']],
      [REVIEWER, ['reviewer']],
      [REVIEWER_2, ['reviewer']],
      [PUBLISHER, ['publisher']],
    ]
    for (const [membershipId, roles] of memberships) {
      await pool.query(`
        INSERT INTO memory_scope_memberships (installation_id, membership_id, roles, state, membership_revision)
        VALUES ($1, $2, $3::text[], 'active', 2)
      `, [TEAM, membershipId, roles])
    }

    const proposed = await promotion.propose({
      grant: {
        primaryInstallationId: TEAM,
        configVersion: '1',
        scopeBindings: [
          bindingFor(PERSONAL, null, ['read', 'contribute']),
          bindingFor(TEAM, PROPOSER, ['read', 'contribute']),
        ],
      },
      sourceInstallationId: PERSONAL,
      sourceClaimId: SOURCE_CLAIM,
      evidenceIds: [EVIDENCE],
      idempotencyDigest: 'publish-digest',
    })
    candidateId = proposed.candidate.candidate_id
    candidateRevision = proposed.candidate.revision
  })

  function approve(membershipId: string) {
    return publication.decide({
      grant: grantFor({ installationId: TEAM, membershipId, permissions: ['read', 'review'] }),
      targetInstallationId: TEAM,
      candidateId,
      expectedCandidateRevision: candidateRevision,
      decision: 'approve',
    })
  }

  test('publishes in one transaction with authority, evidence, job, and audit', async () => {
    const approval = await approve(REVIEWER)
    const result = await publication.publish({
      grant: grantFor({ installationId: TEAM, membershipId: PUBLISHER, permissions: ['read', 'review', 'publish'] }),
      targetInstallationId: TEAM,
      candidateId,
      expectedCandidateRevision: candidateRevision,
      resolution: 'new',
    })
    expect(result.resolution).toBe('new')

    const claim = await pool.query(`
      SELECT state, owner_scope_kind, current_version_id FROM knowledge_claims
      WHERE installation_id = $1 AND claim_id = $2
    `, [TEAM, result.claimId])
    expect(claim.rows[0].state).toBe('active')
    expect(claim.rows[0].owner_scope_kind).toBe('team')

    const version = await pool.query(`
      SELECT authority, source_promotion_candidate_id FROM knowledge_versions
      WHERE installation_id = $1 AND version_id = $2
    `, [TEAM, result.versionId])
    expect(version.rows[0].authority).toBe('team_published')
    expect(version.rows[0].source_promotion_candidate_id).toBe(candidateId)

    const evidence = await pool.query(`
      SELECT visibility, source_evidence_hash, contributor_membership_id FROM knowledge_evidence
      WHERE installation_id = $1 AND version_id = $2
    `, [TEAM, result.versionId])
    expect(evidence.rows[0].visibility).toBe('shared')
    expect(evidence.rows[0].contributor_membership_id).toBe(PROPOSER)

    const authority = await pool.query(`
      SELECT counted_decision_ids, publisher_membership_id, source_scope_kind
      FROM memory_authority_records WHERE installation_id = $1 AND version_id = $2
    `, [TEAM, result.versionId])
    expect(authority.rows[0].source_scope_kind).toBe('personal')
    expect(authority.rows[0].counted_decision_ids).toContain(approval.decisionId)

    const job = await pool.query(`
      SELECT 1 FROM memory_jobs WHERE installation_id = $1 AND job_type = 'index_shared_claim'
    `, [TEAM])
    expect(job.rowCount).toBe(1)

    const audit = await pool.query(`
      SELECT next_state FROM memory_governance_events
      WHERE installation_id = $1 AND action = 'candidate_published'
    `, [TEAM])
    expect(audit.rows[0].next_state).toBe('published')

    const candidate = await pool.query(`
      SELECT state FROM memory_promotion_candidates WHERE candidate_id = $1
    `, [candidateId])
    expect(candidate.rows[0].state).toBe('published')

    // Publication is terminal: a second publish fails closed.
    await expect(publication.publish({
      grant: grantFor({ installationId: TEAM, membershipId: PUBLISHER, permissions: ['read', 'review', 'publish'] }),
      targetInstallationId: TEAM,
      candidateId,
      expectedCandidateRevision: candidateRevision,
      resolution: 'new',
    })).rejects.toBeInstanceOf(PublicationError)
  })

  test('copies redacted event evidence as synthetic episode evidence', async () => {
    await pool.query(`
      UPDATE memory_promotion_evidence SET evidence_kind = 'event'
      WHERE candidate_revision_id = (
        SELECT candidate_revision_id FROM memory_promotion_candidate_versions
        WHERE candidate_id = $1 ORDER BY revision_number DESC LIMIT 1
      )
    `, [candidateId])
    await approve(REVIEWER)

    const result = await publication.publish({
      grant: grantFor({ installationId: TEAM, membershipId: PUBLISHER, permissions: ['read', 'review', 'publish'] }),
      targetInstallationId: TEAM,
      candidateId,
      expectedCandidateRevision: candidateRevision,
      resolution: 'new',
    })

    const copied = await pool.query(`
      SELECT evidence_kind, source_event_id, artifact_id, visibility, source_evidence_hash
      FROM knowledge_evidence
      WHERE installation_id = $1 AND version_id = $2
    `, [TEAM, result.versionId])
    expect(copied.rows).toHaveLength(1)
    expect(copied.rows[0]).toMatchObject({
      evidence_kind: 'episode',
      source_event_id: null,
      artifact_id: null,
      visibility: 'shared',
    })
    expect(copied.rows[0].source_evidence_hash).toBeTruthy()
  })

  test('fails quorum without independent review and on pending change requests', async () => {
    // Proposer self-approval only → missing independent reviewer.
    await approve(PROPOSER)
    await expect(publication.publish({
      grant: grantFor({ installationId: TEAM, membershipId: PUBLISHER, permissions: ['read', 'review', 'publish'] }),
      targetInstallationId: TEAM, candidateId, expectedCandidateRevision: candidateRevision, resolution: 'new',
    })).rejects.toMatchObject({ code: 'quorum_failed' })

    // Any request_changes blocks publication.
    await publication.decide({
      grant: grantFor({ installationId: TEAM, membershipId: REVIEWER, permissions: ['read', 'review'] }),
      targetInstallationId: TEAM, candidateId,
      expectedCandidateRevision: candidateRevision, decision: 'request_changes',
    })
    await expect(publication.publish({
      grant: grantFor({ installationId: TEAM, membershipId: PUBLISHER, permissions: ['read', 'review', 'publish'] }),
      targetInstallationId: TEAM, candidateId, expectedCandidateRevision: candidateRevision, resolution: 'new',
    })).rejects.toMatchObject({ code: 'quorum_failed' })
  })

  test('a revoked reviewer stops counting at publication time', async () => {
    await approve(REVIEWER)
    await pool.query(`
      UPDATE memory_scope_memberships SET state = 'revoked'
      WHERE installation_id = $1 AND membership_id = $2
    `, [TEAM, REVIEWER])
    await expect(publication.publish({
      grant: grantFor({ installationId: TEAM, membershipId: PUBLISHER, permissions: ['read', 'review', 'publish'] }),
      targetInstallationId: TEAM, candidateId, expectedCandidateRevision: candidateRevision, resolution: 'new',
    })).rejects.toMatchObject({ code: 'quorum_failed' })
  })

  test('the publisher gate requires the publish permission and CAS matches', async () => {
    await approve(REVIEWER)
    await expect(publication.publish({
      grant: grantFor({ installationId: TEAM, membershipId: REVIEWER, permissions: ['read', 'review'] }),
      targetInstallationId: TEAM, candidateId, expectedCandidateRevision: candidateRevision, resolution: 'new',
    })).rejects.toMatchObject({ code: 'forbidden' })

    await expect(publication.publish({
      grant: grantFor({ installationId: TEAM, membershipId: PUBLISHER, permissions: ['read', 'review', 'publish'] }),
      targetInstallationId: TEAM, candidateId, expectedCandidateRevision: 999, resolution: 'new',
    })).rejects.toMatchObject({ code: 'revision_conflict' })

    await expect(publication.publish({
      grant: grantFor({ installationId: TEAM, membershipId: PUBLISHER, permissions: ['read', 'review', 'publish'] }),
      targetInstallationId: TEAM, candidateId, expectedCandidateRevision: candidateRevision,
      resolution: 'parallel' as never,
    })).rejects.toMatchObject({ code: 'invalid_resolution' })
  })

  test('expired candidates never publish', async () => {
    await pool.query(`
      UPDATE memory_promotion_candidates SET expires_at = NOW() - INTERVAL '1 hour'
      WHERE candidate_id = $1
    `, [candidateId])
    await expect(publication.publish({
      grant: grantFor({ installationId: TEAM, membershipId: PUBLISHER, permissions: ['read', 'review', 'publish'] }),
      targetInstallationId: TEAM, candidateId, expectedCandidateRevision: candidateRevision, resolution: 'new',
    })).rejects.toMatchObject({ code: 'expired' })
  })

  test('pure quorum evaluation enforces the organization floor', () => {
    const policy = DEFAULT_ORGANIZATION_REVIEW_POLICY
    const one = evaluateQuorum({
      decisions: [{ membershipId: REVIEWER, decision: 'approve' }],
      policy,
      proposerMembershipId: PROPOSER,
      publisherMembershipId: PUBLISHER,
    })
    expect(one.ok).toBe(false)
    expect(one.reason).toBe('insufficient_approvals')

    const two = evaluateQuorum({
      decisions: [
        { membershipId: REVIEWER, decision: 'approve' },
        { membershipId: REVIEWER_2, decision: 'approve' },
      ],
      policy,
      proposerMembershipId: PROPOSER,
      publisherMembershipId: PUBLISHER,
    })
    expect(two.ok).toBe(true)
    expect(two.countedDecisionMemberships).toEqual([REVIEWER, REVIEWER_2])

    const teamOne = evaluateQuorum({
      decisions: [{ membershipId: REVIEWER, decision: 'approve' }],
      policy: DEFAULT_TEAM_REVIEW_POLICY,
      proposerMembershipId: PROPOSER,
      publisherMembershipId: PUBLISHER,
    })
    expect(teamOne.ok).toBe(true)
  })
})
