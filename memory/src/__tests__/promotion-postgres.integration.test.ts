import pg from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { createPromotionService } from '../governance/promotion-service.js'
import { createPromotionRepository } from '../governance/promotion-repository.js'
import {
  createReviewPolicyRepository,
  DEFAULT_TEAM_REVIEW_POLICY,
} from '../governance/review-policy.js'
import type { ValidatedV2Grant } from '../governance/authorization.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const integrationEnabled = Boolean(
  databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const PERSONAL = 'dddddddd-0000-4000-8000-000000000001'
const TEAM = 'dddddddd-0000-4000-8000-000000000002'
const ORG = 'dddddddd-0000-4000-8000-000000000003'
const SOURCE_CLAIM = 'dddddddd-0000-4000-8000-000000000011'
const SOURCE_VERSION = 'dddddddd-0000-4000-8000-000000000012'
const EVIDENCE_1 = 'dddddddd-0000-4000-8000-000000000013'
const EVIDENCE_2 = 'dddddddd-0000-4000-8000-000000000014'
const MEMBERSHIP = 'dddddddd-0000-4000-8000-000000000021'

function grant(overrides: Partial<ValidatedV2Grant> = {}): ValidatedV2Grant {
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
        owner_scope_id: 'dddddddd-0000-4000-8000-000000000031',
        membership_id: MEMBERSHIP,
        membership_revision: '2',
        authorization_epoch: '3',
        permissions: ['read', 'contribute'],
      },
    ],
    ...overrides,
  }
}

describeWithDatabase('promotion proposal transaction (PostgreSQL)', () => {
  let pool: pg.Pool
  let service: ReturnType<typeof createPromotionService>
  let repository: ReturnType<typeof createPromotionRepository>

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl })
    const database = await pool.query<{ database_name: string }>(
      'SELECT current_database() AS database_name',
    )
    if (!/test/i.test(database.rows[0]?.database_name ?? '')) {
      throw new Error('Refusing integration test against non-test database')
    }
    await applyMemorySchema(pool)
    service = createPromotionService(pool)
    repository = createPromotionRepository(pool)
  }, 60_000)

  afterAll(async () => {
    await pool?.end()
  })

  async function seedInstallation(installationId: string, kind: 'personal' | 'team' | 'organization'): Promise<void> {
    await pool.query(`
      INSERT INTO memory_installations
        (installation_id, provider_id, relay_status, local_status, config_version,
         granted_scopes, subscriptions, enabled_services, event_filter)
      VALUES ($1, 'pocketctl-memory', 'active', 'ready', 1,
              '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb)
      ON CONFLICT (installation_id) DO NOTHING
    `, [installationId])
    await pool.query(`
      INSERT INTO memory_owner_scopes (installation_id, owner_scope_kind, owner_scope_id)
      VALUES ($1, $2, $1)
      ON CONFLICT (installation_id) DO NOTHING
    `, [installationId, kind])
  }

  async function seedSourceClaim(input: {
    claimId?: string
    statement?: string
    normalizedKey?: string
  } = {}): Promise<void> {
    const claimId = input.claimId ?? SOURCE_CLAIM
    const versionId = SOURCE_VERSION
    await pool.query(`
      INSERT INTO knowledge_claims
        (claim_id, installation_id, claim_type, scope_kind, scope_key, normalized_key, state)
      VALUES ($1, $2, 'repository_convention', 'repository', '/repo', $3, 'active')
      ON CONFLICT (installation_id, claim_id) DO UPDATE SET state = 'active'
    `, [claimId, PERSONAL, input.normalizedKey ?? 'promotion-key'])
    await pool.query(`
      INSERT INTO knowledge_versions
        (version_id, installation_id, claim_id, version_number, statement, authority, confidence)
      VALUES ($1, $2, $3, 1, $4, 'user_accepted', 0.9)
      ON CONFLICT (installation_id, version_id) DO UPDATE SET statement = EXCLUDED.statement
    `, [versionId, PERSONAL, claimId, input.statement ?? 'deploy with migrations gated by tests'])
    await pool.query(`
      UPDATE knowledge_claims SET current_version_id = $2
      WHERE installation_id = $1 AND claim_id = $3
    `, [PERSONAL, versionId, claimId])
    await pool.query(`
      INSERT INTO work_episodes
        (installation_id, episode_id, session_id, turn_id, state, compiler_version)
      VALUES ($1, 'dddddddd-0000-4000-8000-000000000041', 'promotion-session', 'promotion-turn', 'ready', 'test')
      ON CONFLICT DO NOTHING
    `, [PERSONAL])
    const seedEvidence: Array<[string, string]> = [
      [EVIDENCE_1, 'the  deploy   pipeline\nrequires a green gate with token=supersecretvalue01'],
      [EVIDENCE_2, 'rollback documented at /Users/dev/notes/runbook.md'],
    ]
    for (let index = 0; index < seedEvidence.length; index++) {
      const [evidenceId, excerpt] = seedEvidence[index]
      await pool.query(`
        INSERT INTO knowledge_evidence
          (evidence_id, installation_id, version_id, episode_id, ordinal, evidence_kind,
           excerpt, excerpt_hash, occurred_at)
        VALUES ($1, $2, $3, 'dddddddd-0000-4000-8000-000000000041', $4, 'episode', $5, 'hash', NOW())
        ON CONFLICT (installation_id, evidence_id) DO UPDATE SET excerpt = EXCLUDED.excerpt
      `, [evidenceId, PERSONAL, versionId, index + 1, excerpt])
    }
  }

  async function resetGovernance(): Promise<void> {
    await pool.query(`
      TRUNCATE memory_governance_events, memory_review_decisions, memory_promotion_evidence,
                memory_promotion_candidate_versions, memory_promotion_candidates,
                memory_review_policy_heads, memory_review_policy_versions, memory_review_policy_sets,
                memory_scope_tombstones, memory_scope_memberships, memory_owner_scopes,
                knowledge_evidence, knowledge_versions, knowledge_claims, work_episodes,
                memory_installations CASCADE
    `)
    await seedInstallation(PERSONAL, 'personal')
    await seedInstallation(TEAM, 'team')
    await seedInstallation(ORG, 'organization')
    await pool.query(`
      INSERT INTO memory_scope_memberships (installation_id, membership_id, roles, state, membership_revision)
      VALUES ($1, $2, '{contributor}', 'active', 2)
      ON CONFLICT DO NOTHING
    `, [TEAM, MEMBERSHIP])
    await seedSourceClaim()
  }

  test('proposes with a sanitized immutable evidence copy and no private locators', async () => {
    await resetGovernance()
    const result = await service.propose({
      grant: grant(),
      sourceInstallationId: PERSONAL,
      sourceClaimId: SOURCE_CLAIM,
      evidenceIds: [EVIDENCE_1, EVIDENCE_2],
      idempotencyDigest: 'propose-digest-1',
    })
    expect(result.classification).toBe('new')
    expect(result.candidate.state).toBe('proposed')
    expect(result.candidate.source_scope_kind).toBe('personal')
    expect(result.candidate.created_by_membership_id).toBe(MEMBERSHIP)

    const evidence = await repository.listEvidence(result.candidateRevision.candidate_revision_id)
    expect(evidence).toHaveLength(2)
    for (const item of evidence) {
      expect(item.excerpt).not.toContain('supersecretvalue01')
      expect(item.excerpt).not.toContain('/Users/dev')
      expect(item.excerpt.length).toBeLessThanOrEqual(4000)
    }
    // The serialized target package carries no personal source ids.
    const serialized = JSON.stringify(evidence) + JSON.stringify(result.candidate)
    for (const forbidden of [EVIDENCE_1, EVIDENCE_2, 'promotion-session', 'promotion-turn',
      'dddddddd-0000-4000-8000-000000000041']) {
      expect(serialized).not.toContain(forbidden)
    }
    const storedLocators = await pool.query(`
      SELECT sanitized_locator FROM memory_promotion_evidence
      WHERE candidate_revision_id = $1
    `, [result.candidateRevision.candidate_revision_id])
    expect(storedLocators.rows.every(row => row.sanitized_locator === null)).toBe(true)

    // Policy head lazily seeded for the team scope.
    const head = await pool.query(`
      SELECT 1 FROM memory_review_policy_heads h
      JOIN memory_review_policy_sets s ON s.policy_id = h.policy_id
      WHERE s.installation_id = $1
    `, [TEAM])
    expect(head.rowCount).toBe(1)

    // Audit trail records the bounded proposal event.
    const audit = await pool.query(`
      SELECT action, next_state FROM memory_governance_events WHERE installation_id = $1
    `, [TEAM])
    expect(audit.rows.some(row => row.action === 'candidate_proposed' && row.next_state === 'proposed')).toBe(true)
  })

  test('applies the active review policy TTL and evidence cap when proposing', async () => {
    await resetGovernance()
    const policies = createReviewPolicyRepository(pool)
    await policies.ensurePolicySet(TEAM, DEFAULT_TEAM_REVIEW_POLICY)
    await policies.publishVersion({
      installationId: TEAM,
      document: {
        ...DEFAULT_TEAM_REVIEW_POLICY,
        candidate_ttl_days: 5,
        max_shared_evidence: 1,
      },
      createdByMembershipId: MEMBERSHIP,
      expectedRevision: 1,
    })

    await expect(service.propose({
      grant: grant(),
      sourceInstallationId: PERSONAL,
      sourceClaimId: SOURCE_CLAIM,
      evidenceIds: [EVIDENCE_1, EVIDENCE_2],
      idempotencyDigest: 'policy-bounds-rejected',
    })).rejects.toMatchObject({ code: 'evidence_out_of_bounds' })

    const proposedAt = Date.now()
    const accepted = await service.propose({
      grant: grant(),
      sourceInstallationId: PERSONAL,
      sourceClaimId: SOURCE_CLAIM,
      evidenceIds: [EVIDENCE_1],
      idempotencyDigest: 'policy-bounds-accepted',
    })
    const ttlMs = accepted.candidate.expires_at.getTime() - proposedAt
    expect(ttlMs).toBeGreaterThan(4.9 * 24 * 60 * 60 * 1000)
    expect(ttlMs).toBeLessThan(5.1 * 24 * 60 * 60 * 1000)
  })

  test('replays an identical propose digest idempotently', async () => {
    await resetGovernance()
    const first = await service.propose({
      grant: grant(), sourceInstallationId: PERSONAL, sourceClaimId: SOURCE_CLAIM,
      evidenceIds: [EVIDENCE_1], idempotencyDigest: 'propose-digest-2',
    })
    const second = await service.propose({
      grant: grant(), sourceInstallationId: PERSONAL, sourceClaimId: SOURCE_CLAIM,
      evidenceIds: [EVIDENCE_1], idempotencyDigest: 'propose-digest-2',
    })
    expect(second.candidate.candidate_id).toBe(first.candidate.candidate_id)
    const count = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM memory_promotion_candidates`,
    )
    expect(Number(count.rows[0].count)).toBe(1)
  })

  test('rejects forbidden edges: team→team and personal→organization', async () => {
    await resetGovernance()
    await expect(service.propose({
      grant: grant({ primaryInstallationId: PERSONAL }),
      sourceInstallationId: TEAM, sourceClaimId: SOURCE_CLAIM,
      evidenceIds: [EVIDENCE_1], idempotencyDigest: 'edge-1',
    })).rejects.toMatchObject({ code: 'invalid_edge' })

    const orgGrant = grant({
      primaryInstallationId: ORG,
      scopeBindings: [
        ...grant().scopeBindings,
        {
          installation_id: ORG,
          owner_scope_kind: 'organization',
          owner_scope_id: 'dddddddd-0000-4000-8000-000000000032',
          membership_id: MEMBERSHIP,
          membership_revision: '2',
          authorization_epoch: '1',
          permissions: ['read', 'contribute'],
        },
      ],
    })
    await expect(service.propose({
      grant: orgGrant, sourceInstallationId: PERSONAL, sourceClaimId: SOURCE_CLAIM,
      evidenceIds: [EVIDENCE_1], idempotencyDigest: 'edge-2',
    })).rejects.toMatchObject({ code: 'invalid_edge' })
  })

  test('rejects evidence outside the current version and out-of-band selections', async () => {
    await resetGovernance()
    // Evidence on another (non-current) version.
    await pool.query(`
      INSERT INTO knowledge_versions
        (version_id, installation_id, claim_id, version_number, statement, authority, confidence)
      VALUES ('dddddddd-0000-4000-8000-000000000051', $1, $2, 2, 'second', 'user_corrected', 0.9)
    `, [PERSONAL, SOURCE_CLAIM])
    await pool.query(`
      INSERT INTO knowledge_evidence
        (evidence_id, installation_id, version_id, episode_id, ordinal, evidence_kind, excerpt, excerpt_hash, occurred_at)
      VALUES ('dddddddd-0000-4000-8000-000000000061', $1, 'dddddddd-0000-4000-8000-000000000051',
              'dddddddd-0000-4000-8000-000000000041', 1, 'episode', 'foreign excerpt', 'hash', NOW())
    `, [PERSONAL])
    await expect(service.propose({
      grant: grant(), sourceInstallationId: PERSONAL, sourceClaimId: SOURCE_CLAIM,
      evidenceIds: ['dddddddd-0000-4000-8000-000000000061'],
      idempotencyDigest: 'evidence-foreign',
    })).rejects.toMatchObject({ code: 'evidence_not_owned' })

    // Evidence from another installation entirely.
    await expect(service.propose({
      grant: grant(), sourceInstallationId: PERSONAL, sourceClaimId: SOURCE_CLAIM,
      evidenceIds: ['dddddddd-0000-4000-8000-000000000071'],
      idempotencyDigest: 'evidence-missing',
    })).rejects.toMatchObject({ code: 'evidence_not_owned' })
  })

  test('classifies identical content as duplicate and divergent content as conflict', async () => {
    await resetGovernance()
    const first = await service.propose({
      grant: grant(), sourceInstallationId: PERSONAL, sourceClaimId: SOURCE_CLAIM,
      evidenceIds: [EVIDENCE_1], idempotencyDigest: 'classify-1',
    })
    expect(first.classification).toBe('new')

    // A team claim with the same identity and identical content.
    await pool.query(`
      INSERT INTO knowledge_claims
        (claim_id, installation_id, claim_type, scope_kind, scope_key, normalized_key, state, owner_scope_kind, owner_scope_id)
      VALUES ('dddddddd-0000-4000-8000-000000000081', $1, 'repository_convention', 'repository', '/repo', 'promotion-key', 'active',
              'team', 'dddddddd-0000-4000-8000-000000000031')
    `, [TEAM])
    await pool.query(`
      INSERT INTO knowledge_versions
        (version_id, installation_id, claim_id, version_number, statement, authority, confidence)
      VALUES ('dddddddd-0000-4000-8000-000000000082', $1, 'dddddddd-0000-4000-8000-000000000081', 1,
              'deploy with migrations gated by tests', 'team_published', 0.9)
    `, [TEAM])
    await pool.query(`
      UPDATE knowledge_claims SET current_version_id = 'dddddddd-0000-4000-8000-000000000082'
      WHERE installation_id = $1 AND claim_id = 'dddddddd-0000-4000-8000-000000000081'
    `, [TEAM])

    const duplicate = await service.propose({
      grant: grant(), sourceInstallationId: PERSONAL, sourceClaimId: SOURCE_CLAIM,
      evidenceIds: [EVIDENCE_1], idempotencyDigest: 'classify-duplicate',
    })
    expect(duplicate.classification).toBe('duplicate')
    expect(duplicate.candidate.duplicate_of_claim_id).toBe('dddddddd-0000-4000-8000-000000000081')

    // Divergent target content, same identity → conflict.
    await pool.query(`
      UPDATE knowledge_versions SET statement = 'deploy without any gate at all'
      WHERE installation_id = $1 AND version_id = 'dddddddd-0000-4000-8000-000000000082'
    `, [TEAM])
    const conflict = await service.propose({
      grant: grant(), sourceInstallationId: PERSONAL, sourceClaimId: SOURCE_CLAIM,
      evidenceIds: [EVIDENCE_1], idempotencyDigest: 'classify-conflict',
    })
    expect(conflict.classification).toBe('conflict')
    expect(conflict.candidate.state).toBe('conflict')
    expect(conflict.candidate.conflict_group_id).not.toBeNull()

    // Revisions are immutable: appending an edit creates revision N+1.
    const revised = await repository.appendRevision({
      targetInstallationId: TEAM,
      candidateId: first.candidate.candidate_id,
      expectedRevision: 1,
      statement: 'deploy with migrations gated by tests, revised',
      structuredContent: {},
      contentHash: 'revised-hash',
      createdByMembershipId: MEMBERSHIP,
    })
    expect(revised.revisionNumber).toBe(2)
    const queue = await repository.listQueue(TEAM, ['proposed'])
    expect(queue.find(entry => entry.candidate_id === first.candidate.candidate_id)?.revision).toBe(2)
  })
})
