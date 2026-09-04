import pg from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import {
  DEFAULT_ORGANIZATION_REVIEW_POLICY,
  DEFAULT_TEAM_REVIEW_POLICY,
  canonicalReviewPolicyHash,
  createReviewPolicyRepository,
  loadEffectiveReviewPolicySnapshot,
  parseReviewPolicyDocument,
  resolveEffectivePolicy,
} from '../governance/review-policy.js'
import { createAuditRepository } from '../governance/audit-repository.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const integrationEnabled = Boolean(
  databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = integrationEnabled ? describe : describe.skip

describeWithDatabase('memory review policy repository', () => {
  let pool: pg.Pool
  let teamInstallation: string
  let orgInstallation: string

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl })
    const database = await pool.query<{ database_name: string }>(
      'SELECT current_database() AS database_name',
    )
    if (!/test/i.test(database.rows[0]?.database_name ?? '')) {
      throw new Error('Refusing integration test against non-test database')
    }
    await applyMemorySchema(pool)
    for (const [name, kind] of [['review-policy-team', 'team'], ['review-policy-org', 'organization']] as const) {
      const row = await pool.query<{ id: string }>(`
        INSERT INTO memory_installations
          (installation_id, provider_id, relay_status, local_status, config_version,
           granted_scopes, subscriptions, enabled_services, event_filter)
        VALUES (gen_random_uuid(), 'pocketctl-memory', 'active', 'ready', 1,
                '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb)
        RETURNING installation_id::text AS id
      `)
      await pool.query(`
        INSERT INTO memory_owner_scopes (installation_id, owner_scope_kind, owner_scope_id)
        VALUES ($1, $2, gen_random_uuid())
        ON CONFLICT (installation_id) DO NOTHING
      `, [row.rows[0].id, kind])
      if (kind === 'team') teamInstallation = row.rows[0].id
      else orgInstallation = row.rows[0].id
    }
    const organizationScope = await pool.query<{ owner_scope_id: string }>(`
      SELECT owner_scope_id::text FROM memory_owner_scopes WHERE installation_id = $1
    `, [orgInstallation])
    await pool.query(`
      UPDATE memory_owner_scopes SET parent_organization_id = $2
      WHERE installation_id = $1
    `, [teamInstallation, organizationScope.rows[0].owner_scope_id])
  }, 60_000)

  afterAll(async () => {
    await pool?.end()
  })

  test('parses the frozen V1 document and fails closed on unknown fields', () => {
    expect(parseReviewPolicyDocument(DEFAULT_TEAM_REVIEW_POLICY)).not.toBeNull()
    expect(parseReviewPolicyDocument(DEFAULT_ORGANIZATION_REVIEW_POLICY)).not.toBeNull()
    expect(DEFAULT_ORGANIZATION_REVIEW_POLICY.minimum_approvals).toBeGreaterThanOrEqual(2)
    expect(DEFAULT_TEAM_REVIEW_POLICY.minimum_approvals).toBe(1)
    expect(DEFAULT_TEAM_REVIEW_POLICY.allow_self_publish).toBe(false)

    expect(parseReviewPolicyDocument({ ...DEFAULT_TEAM_REVIEW_POLICY, extra: 1 })).toBeNull()
    expect(parseReviewPolicyDocument({ ...DEFAULT_TEAM_REVIEW_POLICY, allow_self_publish: true })).toBeNull()
    expect(parseReviewPolicyDocument({ ...DEFAULT_TEAM_REVIEW_POLICY, minimum_approvals: 0 })).toBeNull()
    expect(parseReviewPolicyDocument({ ...DEFAULT_TEAM_REVIEW_POLICY, schema_version: 2 })).toBeNull()
    expect(parseReviewPolicyDocument(null)).toBeNull()
    expect(canonicalReviewPolicyHash(DEFAULT_TEAM_REVIEW_POLICY)).toBe(
      canonicalReviewPolicyHash({ ...DEFAULT_TEAM_REVIEW_POLICY }),
    )
    expect(canonicalReviewPolicyHash(DEFAULT_TEAM_REVIEW_POLICY)).not.toBe(
      canonicalReviewPolicyHash(DEFAULT_ORGANIZATION_REVIEW_POLICY),
    )
  })

  test('resolves monotonically: a team layer can only strengthen the organization floor', () => {
    const resolved = resolveEffectivePolicy(
      DEFAULT_ORGANIZATION_REVIEW_POLICY,
      { ...DEFAULT_TEAM_REVIEW_POLICY, minimum_approvals: 1 },
    )
    expect(resolved.minimum_approvals).toBe(2)
    expect(resolveEffectivePolicy(
      DEFAULT_ORGANIZATION_REVIEW_POLICY,
      { ...DEFAULT_TEAM_REVIEW_POLICY, minimum_approvals: 3 },
    ).minimum_approvals).toBe(3)
    const stricter = resolveEffectivePolicy(
      DEFAULT_ORGANIZATION_REVIEW_POLICY,
      { ...DEFAULT_TEAM_REVIEW_POLICY, max_shared_evidence: 16 },
    )
    expect(stricter.max_shared_evidence).toBe(8)
    expect(stricter.require_independent_reviewer).toBe(true)
    expect(stricter.allow_self_publish).toBe(false)
  })

  test('creates immutable versions with a CAS head, diff, and rollback', async () => {
    const repository = createReviewPolicyRepository(pool)
    const created = await repository.ensurePolicySet(teamInstallation, DEFAULT_TEAM_REVIEW_POLICY)
    expect(created.versionNumber).toBe(1)
    // Idempotent creation keeps the same head.
    const again = await repository.ensurePolicySet(teamInstallation, DEFAULT_TEAM_REVIEW_POLICY)
    expect(again.policyVersionId).toBe(created.policyVersionId)

    const head = await repository.getHead(teamInstallation)
    expect(head!.revision).toBe(1)

    const stricter = { ...DEFAULT_TEAM_REVIEW_POLICY, minimum_approvals: 2 }
    const updated = await repository.publishVersion({
      installationId: teamInstallation,
      document: stricter,
      createdByMembershipId: '11111111-1111-4111-8111-111111111111',
      expectedRevision: 1,
    })
    expect(updated.versionNumber).toBe(2)

    // Stale CAS fails closed.
    await expect(repository.publishVersion({
      installationId: teamInstallation,
      document: stricter,
      createdByMembershipId: '11111111-1111-4111-8111-111111111111',
      expectedRevision: 1,
    })).rejects.toThrow(/revision/i)

    // Versions are immutable: same content hash can never be renumbered.
    const versions = await repository.listVersions(teamInstallation)
    expect(versions.map(version => version.versionNumber)).toEqual([1, 2])
    expect(versions[1].contentHash).not.toBe(versions[0].contentHash)

    // Rollback re-points the head with CAS and keeps history.
    const rolled = await repository.rollback({
      installationId: teamInstallation,
      targetVersionId: created.policyVersionId,
      expectedRevision: 2,
    })
    expect(rolled.activeVersionId).toBe(created.policyVersionId)
    const active = await repository.getActiveDocument(teamInstallation)
    expect(active!.minimum_approvals).toBe(1)
  })

  test('loads the real parent organization head into a team snapshot', async () => {
    const repository = createReviewPolicyRepository(pool)
    await repository.ensurePolicySet(teamInstallation, DEFAULT_TEAM_REVIEW_POLICY)
    await repository.ensurePolicySet(orgInstallation, DEFAULT_ORGANIZATION_REVIEW_POLICY)
    const parentHead = await repository.getHead(orgInstallation)
    const parentVersion = await repository.publishVersion({
      installationId: orgInstallation,
      document: {
        ...DEFAULT_ORGANIZATION_REVIEW_POLICY,
        minimum_approvals: 4,
        candidate_ttl_days: 5,
        max_shared_evidence: 2,
      },
      createdByMembershipId: null,
      expectedRevision: parentHead!.revision,
    })
    const client = await pool.connect()
    try {
      const snapshot = await loadEffectiveReviewPolicySnapshot(client, teamInstallation)
      expect(snapshot.parentActiveVersionId).toBe(parentVersion.policyVersionId)
      expect(snapshot.policy.minimum_approvals).toBe(4)
      expect(snapshot.policy.candidate_ttl_days).toBe(5)
      expect(snapshot.policy.max_shared_evidence).toBe(2)
    } finally {
      client.release()
    }
  })

  test('audit events are append-only, content-free, and page backwards', async () => {
    const audit = createAuditRepository(pool, { cursorSecret: 'audit-cursor-secret-0123456789' })
    for (let index = 0; index < 5; index++) {
      await audit.append({
        installationId: orgInstallation,
        actorMembershipId: '22222222-2222-4222-8222-222222222222',
        action: 'candidate_proposed',
        targetKind: 'promotion_candidate',
        targetId: null,
        requestHash: `hash-${index}`,
        previousState: null,
        nextState: 'proposed',
        metadata: { revision: index + 1 },
      })
    }
    // PII and content can never ride inside metadata.
    await expect(audit.append({
      installationId: orgInstallation,
      actorMembershipId: null,
      action: 'candidate_published',
      targetKind: 'promotion_candidate',
      targetId: null,
      requestHash: null,
      previousState: 'approved',
      nextState: 'published',
      metadata: { statement: 'secret claim text', email: 'x@y.z' },
    })).rejects.toThrow()

    // Drain every page: five events total, no duplicates, newest first.
    const seen: string[] = []
    let cursor: string | undefined
    for (let pass = 0; pass < 5; pass++) {
      const page = await audit.listPage(orgInstallation, { limit: 3, cursor })
      seen.push(...page.events.map(event => event.eventId))
      if (!page.nextCursor) break
      cursor = page.nextCursor
    }
    expect(seen).toHaveLength(5)
    expect(new Set(seen).size).toBe(5)
    expect(seen.every(event => event !== undefined)).toBe(true)
    const firstPage = await audit.listPage(orgInstallation, { limit: 3 })
    expect(firstPage.events.map(event => event.action)).toEqual(
      ['candidate_proposed', 'candidate_proposed', 'candidate_proposed'])
    expect(firstPage.events.every(event => event.metadata !== null
      && Object.keys(event.metadata!).every(key => ['revision', 'reason_code', 'resolution', 'count'].includes(key)))).toBe(true)
  })

  test('audit cursor preserves PostgreSQL sub-millisecond ordering', async () => {
    const installation = (await pool.query<{ id: string }>(`
      INSERT INTO memory_installations
        (installation_id, provider_id, relay_status, local_status, config_version,
         granted_scopes, subscriptions, enabled_services, event_filter)
      VALUES (gen_random_uuid(), 'pocketctl-memory', 'active', 'ready', 1,
              '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb)
      RETURNING installation_id::text AS id
    `)).rows[0].id
    await pool.query(`
      INSERT INTO memory_governance_events
        (event_id, installation_id, action, target_kind, metadata, created_at)
      VALUES
        ('00000000-0000-4000-8000-000000000001', $1, 'cursor_test', 'audit', '{}'::jsonb, '2026-08-30T12:00:00.000100Z'),
        ('00000000-0000-4000-8000-000000000002', $1, 'cursor_test', 'audit', '{}'::jsonb, '2026-08-30T12:00:00.000200Z'),
        ('00000000-0000-4000-8000-000000000003', $1, 'cursor_test', 'audit', '{}'::jsonb, '2026-08-30T12:00:00.000300Z'),
        ('00000000-0000-4000-8000-000000000004', $1, 'cursor_test', 'audit', '{}'::jsonb, '2026-08-30T12:00:00.000400Z'),
        ('00000000-0000-4000-8000-000000000005', $1, 'cursor_test', 'audit', '{}'::jsonb, '2026-08-30T12:00:00.000500Z')
    `, [installation])

    const audit = createAuditRepository(pool, { cursorSecret: 'audit-cursor-secret-0123456789' })
    const seen: string[] = []
    let cursor: string | undefined
    for (let pass = 0; pass < 5; pass++) {
      const page = await audit.listPage(installation, { limit: 2, cursor })
      seen.push(...page.events.map(event => event.eventId))
      if (!page.nextCursor) break
      cursor = page.nextCursor
    }

    expect(seen).toEqual([
      '00000000-0000-4000-8000-000000000005',
      '00000000-0000-4000-8000-000000000004',
      '00000000-0000-4000-8000-000000000003',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000001',
    ])
  })
})
