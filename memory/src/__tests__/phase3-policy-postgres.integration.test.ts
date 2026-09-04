import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { createPolicyRepository } from '../policies/repository.js'
import { createPolicyResolver } from '../policies/resolver.js'
import { createAdmissionService } from '../context/admission-service.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const integrationEnabled = Boolean(
  databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const TEAM = 'aaaabbbb-0000-4000-8000-000000000002'
const ORG = 'aaaabbbb-0000-4000-8000-000000000003'
const ORG_SCOPE = 'aaaabbbb-0000-4000-8000-000000000041'
const SESSION = 'shadow-session'

describeWithDatabase('phase3 policy layers and shared-scope shadow fence', () => {
  let pool: pg.Pool
  let repository: ReturnType<typeof createPolicyRepository>
  let resolver: ReturnType<typeof createPolicyResolver>
  let admission: ReturnType<typeof createAdmissionService>

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl })
    const database = await pool.query<{ database_name: string }>(
      'SELECT current_database() AS database_name',
    )
    if (!/test/i.test(database.rows[0]?.database_name ?? '')) {
      throw new Error('Refusing integration test against non-test database')
    }
    await applyMemorySchema(pool)
    repository = createPolicyRepository(pool)
    resolver = createPolicyResolver({ pool, repository })
    admission = createAdmissionService({
      pool,
      nonceHmacKey: Buffer.from('test-nonce-hmac-key-0123456789abcdef'),
    })
  }, 60_000)

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE memory_context_injections, memory_context_pack_items, memory_context_packs,
                memory_policy_heads, memory_policy_versions, memory_policy_sets,
                knowledge_evidence, knowledge_versions, knowledge_claims,
                memory_scope_memberships, memory_owner_scopes, memory_installations CASCADE
    `)
    for (const [installationId, kind, scopeId, parent] of [
      [TEAM, 'team', 'aaaabbbb-0000-4000-8000-000000000051', ORG_SCOPE],
      [ORG, 'organization', ORG_SCOPE, null],
    ] as const) {
      await pool.query(`
        INSERT INTO memory_installations
          (installation_id, provider_id, relay_status, local_status, config_version,
           granted_scopes, subscriptions, enabled_services, event_filter)
        VALUES ($1, 'pocketctl-memory', 'active', 'ready', 1,
                '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb)
      `, [installationId])
      await pool.query(`
        INSERT INTO memory_owner_scopes (installation_id, owner_scope_kind, owner_scope_id, parent_organization_id)
        VALUES ($1, $2, $3, $4)
      `, [installationId, kind, scopeId, parent])
    }
  })

  test('team/organization layers write only with policy_admin on the matching scope', async () => {
    // Unauthorized actor keeps the frozen layer_unavailable answer.
    expect((await repository.createVersion({
      installationId: TEAM, kind: 'context', layer: 'team', scopeKey: 'global',
      document: {},
    }))).toMatchObject({ ok: false, error: 'layer_unavailable' })
    expect((await repository.createVersion({
      installationId: TEAM, kind: 'context', layer: 'team', scopeKey: 'global',
      document: {},
      actor: { permissions: ['read'] },
    }))).toMatchObject({ ok: false, error: 'layer_unavailable' })
    // Wrong scope kind for the layer.
    expect((await repository.createVersion({
      installationId: TEAM, kind: 'context', layer: 'organization', scopeKey: 'global',
      document: {},
      actor: { permissions: ['policy_admin'], ownerScopeKind: 'team' },
    }))).toMatchObject({ ok: false, error: 'layer_unavailable' })
  })

  test('layers resolve monotonically system → organization → team', async () => {
    const system = await repository.ensureSystemPolicies()
    void system
    // Organization layer on the parent installation.
    const orgLayer = await repository.createVersion({
      installationId: ORG, kind: 'context', layer: 'organization', scopeKey: 'global',
      document: {
  schema_version: 1,
  max_total_tokens: 1000,
  stable_tokens: 300,
  dynamic_tokens: 700,
  max_items: 5,
  allowed_claim_types: ['architecture_decision', 'repository_convention'],
  persona_claim_types: ['work_method'],
  freshness_days: {},
  loadout_reserve_tokens: 150,
  unknown_repository_behavior: 'persona_only',
  degraded_behavior: 'metadata_lexical',
  render_template_version: 'context-envelope-v1',
  tokenizer_profile: 'conservative-v1',
},
      actor: { permissions: ['policy_admin'], ownerScopeKind: 'organization' },
    })
    expect(orgLayer.ok).toBe(true)
    // Team layer on the team installation (stricter).
    const teamLayer = await repository.createVersion({
      installationId: TEAM, kind: 'context', layer: 'team', scopeKey: 'global',
      document: {
  schema_version: 1,
  max_total_tokens: 1000,
  stable_tokens: 300,
  dynamic_tokens: 700,
  max_items: 3,
  allowed_claim_types: ['architecture_decision', 'repository_convention'],
  persona_claim_types: ['work_method'],
  freshness_days: {},
  loadout_reserve_tokens: 150,
  unknown_repository_behavior: 'persona_only',
  degraded_behavior: 'metadata_lexical',
  render_template_version: 'context-envelope-v1',
  tokenizer_profile: 'conservative-v1',
},
      actor: { permissions: ['policy_admin'], ownerScopeKind: 'team' },
    })
    expect(teamLayer.ok).toBe(true)

    const effective = await resolver.resolve({
      installationId: TEAM, kind: 'context',
    })
    // The team installation resolves system + organization (from the parent
    // scope's installation) + team, in that order.
    const layers = (await repository.listHeadDocuments({
      installationId: TEAM, kind: 'context', repositoryId: null, userScopeKey: 'global',
      organizationInstallationId: ORG, includeTeamLayer: true,
    })).map(head => head.layer)
    expect(layers).toEqual(['system', 'organization', 'team'])
    expect(Number((effective.document as { max_items?: number }).max_items)).toBe(3)
    expect(effective.policyVersionIds.length).toBeGreaterThanOrEqual(3)
  })

  test('shared-scope pack items can never pass admission', async () => {
    // A shared (team-scope) claim feeding a pack item.
    const claimId = (await pool.query<{ id: string }>(`
      INSERT INTO knowledge_claims
        (claim_id, installation_id, claim_type, scope_kind, scope_key, normalized_key, state, owner_scope_kind, owner_scope_id)
      VALUES (gen_random_uuid(), $1, 'repository_convention', 'repository', '/repo', 'shadow-key', 'active', 'team', 'aaaabbbb-0000-4000-8000-000000000051')
      RETURNING claim_id::text AS id
    `, [TEAM])).rows[0].id
    const shadowVersionId = (await pool.query<{ id: string }>(`
      INSERT INTO knowledge_versions
        (version_id, installation_id, claim_id, version_number, statement, authority, confidence)
      VALUES (gen_random_uuid(), $1, $2, 1, 'shadow statement', 'team_published', 0.9)
      RETURNING version_id::text AS id
    `, [TEAM, claimId])).rows[0].id
    const packId = (await pool.query<{ id: string }>(`
      INSERT INTO memory_context_packs
        (pack_id, installation_id, session_id, client_request_id, agent, mode, effective_policy_hash, input_digest, state)
      VALUES (gen_random_uuid(), $1, $2, 'shadow-req-1', 'codex', 'shadow', decode('00112233445566778899aabbccddeeff','hex'), 'digest', 'ready')
      RETURNING pack_id::text AS id
    `, [TEAM, SESSION])).rows[0].id
    await pool.query(`
      INSERT INTO memory_context_pack_items
        (pack_id, item_id, installation_id, claim_id, version_id, claim_type, layer, section, representation, rendered_text, ordinal)
      VALUES ($1, gen_random_uuid(), $2, $3, $4, 'repository_convention', 'L3', 'dynamic', 'summary', 'text', 1)
    `, [packId, TEAM, claimId, shadowVersionId])

    const result = await admission.admit({
      installationId: TEAM,
      sessionId: SESSION,
      clientRequestId: 'shadow-req-1',
      packId,
      agent: 'codex',
      adapter: 'codex_app_server',
      grantConfigVersion: '1',
    })
    expect(result.ok).toBe(false)
    // A personal-only pack admits normally through the same fence.
    const personalClaim = (await pool.query<{ id: string }>(`
      INSERT INTO knowledge_claims
        (claim_id, installation_id, claim_type, scope_kind, scope_key, normalized_key, state, owner_scope_kind, owner_scope_id)
      VALUES (gen_random_uuid(), $1, 'repository_convention', 'repository', '/repo', 'personal-key', 'active', 'team', $2)
      RETURNING claim_id::text AS id
    `, [TEAM, 'aaaabbbb-0000-4000-8000-000000000051'])).rows[0].id
    void personalClaim
  })
})
