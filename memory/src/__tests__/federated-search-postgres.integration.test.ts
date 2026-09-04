import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import {
  decorateWithScopeMetadata,
  mergeFederatedRrf,
  selectFederatedScopes,
} from '../retrieval/federated-search-service.js'
import type { ValidatedV2Grant } from '../governance/authorization.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const integrationEnabled = Boolean(
  databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const PERSONAL = '12345690-1234-4123-8123-123456789001'
const TEAM = '12345690-1234-4123-8123-123456789002'
const FOREIGN = '12345690-1234-4123-8123-123456789003'

function grant(): ValidatedV2Grant {
  return {
    primaryInstallationId: PERSONAL,
    configVersion: '1',
    scopeBindings: [
      {
        installation_id: PERSONAL,
        owner_scope_kind: 'personal',
        owner_scope_id: PERSONAL,
        membership_id: null,
        membership_revision: '0',
        authorization_epoch: '1',
        permissions: ['read'],
      },
      {
        installation_id: TEAM,
        owner_scope_kind: 'team',
        owner_scope_id: '12345690-1234-4123-8123-123456789011',
        membership_id: '12345690-1234-4123-8123-123456789021',
        membership_revision: '2',
        authorization_epoch: '1',
        permissions: ['read'],
      },
    ],
  }
}

describeWithDatabase('federated search across authorized scopes (PostgreSQL)', () => {
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
      TRUNCATE knowledge_evidence, knowledge_versions, knowledge_claims,
                memory_owner_scopes, memory_installations CASCADE
    `)
    for (const [installationId, kind] of [
      [PERSONAL, 'personal'], [TEAM, 'team'], [FOREIGN, 'personal'],
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
  })

  async function seedClaim(installationId: string, key: string, statement: string,
    authority: string, conflictGroup: string | null = null, variant = 0): Promise<string> {
    const ownerKind = installationId === TEAM ? 'team' : 'personal'
    const claimId = (await pool.query<{ id: string }>(`
      INSERT INTO knowledge_claims
        (claim_id, installation_id, claim_type, scope_kind, scope_key, normalized_key, state,
         conflict_group_id, conflict_variant, owner_scope_kind)
      VALUES (gen_random_uuid(), $1, 'repository_convention', 'repository', '/repo', $2, 'active', $3, $4, $5)
      RETURNING claim_id::text AS id
    `, [installationId, key, conflictGroup, variant, ownerKind])).rows[0].id
    const versionId = (await pool.query<{ id: string }>(`
      INSERT INTO knowledge_versions
        (version_id, installation_id, claim_id, version_number, statement, authority, confidence)
      VALUES (gen_random_uuid(), $1, $2, 1, $3, $4, 0.9)
      RETURNING version_id::text AS id
    `, [installationId, claimId, statement, authority])).rows[0].id
    await pool.query(`
      UPDATE knowledge_claims SET current_version_id = $2 WHERE installation_id = $1 AND claim_id = $3
    `, [installationId, versionId, claimId])
    return claimId
  }

  test('authorization precedes retrieval: foreign installations never join the pool', async () => {
    const personalClaim = await seedClaim(PERSONAL, 'shared-key', 'personal statement', 'user_accepted')
    const teamClaim = await seedClaim(TEAM, 'shared-key', 'team statement', 'team_published',
      '12345690-1234-4123-8123-123456789091', 1)
    // An identical-document claim in a foreign installation must never leak.
    await seedClaim(FOREIGN, 'shared-key', 'foreign statement', 'user_accepted')

    const selected = selectFederatedScopes({
      grant: grant(), requestedInstallationIds: [PERSONAL, TEAM], sharedScopesEnabled: true,
    })
    expect(selected.map(scope => scope.installationId)).toEqual([PERSONAL, TEAM])

    // Per-scope candidate SQL is installation-fenced: run the exact
    // per-installation candidate query the search backend uses.
    const hits: Array<{ scope: typeof selected[number]; claimId: string; statement: string; authority: string }> = []
    for (const scope of selected) {
      const rows = await pool.query<{ claim_id: string; statement: string; authority: string; freshness: Date | null }>(`
        SELECT c.claim_id::text, v.statement, v.authority, v.created_at AS freshness
        FROM knowledge_claims c
        JOIN knowledge_versions v ON v.version_id = c.current_version_id AND v.installation_id = c.installation_id
        WHERE c.installation_id = $1 AND c.state = 'active'
          AND v.statement ILIKE '%statement%'
      `, [scope.installationId])
      for (const row of rows.rows) {
        hits.push({ scope, claimId: row.claim_id, statement: row.statement, authority: row.authority })
      }
    }
    expect(hits.map(hit => hit.statement).sort()).toEqual(['personal statement', 'team statement'])
    expect(hits.every(hit => hit.statement !== 'foreign statement')).toBe(true)

    // Federated merge decorates every hit with its owner scope.
    const merged = mergeFederatedRrf(hits.map(hit => ({
      scope: hit.scope,
      claimId: hit.claimId,
      hit,
      authority: hit.authority,
      repositoryApplicable: true,
      freshnessAt: null,
    })), 10)
    const decoration = await decorateWithScopeMetadata(pool, [PERSONAL, TEAM],
      new Map(selected.map(scope => [scope.installationId,
        merged.filter(entry => entry.scope.installationId === scope.installationId)
          .map(entry => entry.hit.claimId)])))
    const teamDecoration = decoration.get(`${TEAM}:${teamClaim}`)
    expect(teamDecoration).toMatchObject({
      ownerScopeKind: 'team',
      conflictGroupId: '12345690-1234-4123-8123-123456789091',
      conflictVariant: 1,
    })
    const personalDecoration = decoration.get(`${PERSONAL}:${personalClaim}`)
    expect(personalDecoration).toMatchObject({ ownerScopeKind: 'personal', conflictVariant: 0 })

    // Unauthorized explicit selection fails closed before any SQL runs.
    expect(() => selectFederatedScopes({
      grant: grant(), requestedInstallationIds: [FOREIGN], sharedScopesEnabled: true,
    })).toThrow(/subset of the validated grant bindings/)
  })

  test('a personal claim stays invisible to a shared-scope-only query', async () => {
    await seedClaim(PERSONAL, 'personal-only-key', 'secret personal statement', 'user_accepted')
    const selected = selectFederatedScopes({
      grant: grant(), requestedInstallationIds: [TEAM], sharedScopesEnabled: true,
    })
    const rows = await pool.query(`
      SELECT COUNT(*)::text AS count FROM knowledge_claims c
      JOIN knowledge_versions v ON v.version_id = c.current_version_id AND v.installation_id = c.installation_id
      WHERE c.installation_id = ANY($1::uuid[]) AND c.state = 'active'
        AND v.statement ILIKE '%statement%'
    `, [selected.map(scope => scope.installationId)])
    expect(Number(rows.rows[0].count)).toBe(0)
  })
})
