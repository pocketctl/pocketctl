import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { createScopeResolver } from '../context/scope-resolver.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const integrationEnabled = Boolean(
  databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1',
)
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const INSTALLATION = '89898989-8989-4899-8989-898989898989'
const REPO = '9a9a9a9a-9a9a-4a9a-8a9a-9a9a9a9a9a9a'

describeWithDatabase('context scope resolver (PostgreSQL)', () => {
  let pool: pg.Pool
  let scope: ReturnType<typeof createScopeResolver>

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
    await assertMemoryTestDatabase(pool, databaseUrl!)
    await applyMemorySchema(pool)
    scope = createScopeResolver(pool)
  }, 60_000)

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE knowledge_evidence, knowledge_versions, knowledge_claims,
               work_episodes, source_turns, source_events, source_sessions,
               repositories, memory_installations
      RESTART IDENTITY CASCADE
    `)
    await pool.query(`
      INSERT INTO memory_installations
        (installation_id, provider_id, relay_status, local_status, config_version)
      VALUES ($1, 'pocketctl-memory', 'active', 'ready', 1)
    `, [INSTALLATION])
    await pool.query(`
      INSERT INTO repositories (repository_id, installation_id, repository_key, first_observed_at, last_observed_at)
      VALUES ($1, $2, 'github.com/example/main', NOW(), NOW())
    `, [REPO, INSTALLATION])
    await pool.query(`
      INSERT INTO source_sessions (installation_id, session_id, first_recorded_at, last_recorded_at)
      VALUES ($1, 'ses-scope', NOW(), NOW())
    `, [INSTALLATION])
    await pool.query(`
      INSERT INTO work_episodes
        (installation_id, episode_id, session_id, turn_id, state, compiler_version,
         source_digest, document, evidence_manifest, document_compiler_version, compiled_at)
      VALUES ($1, gen_random_uuid(), 'ses-scope', 'turn-1', 'ready', 'c-v1',
              decode(md5('ctx'),'hex'), '{}'::jsonb, '{}'::jsonb, 'd-v1', NOW())
    `, [INSTALLATION])
  })

  test('a known repository id hint resolves within the installation', async () => {
    const resolved = await scope.resolve({
      installationId: INSTALLATION, sessionId: 'ses-scope', repositoryIdHint: REPO,
    })
    expect(resolved.repositoryKnown).toBe(true)
    expect(resolved.repositoryId).toBe(REPO)
    expect(resolved.personaOnly).toBe(false)
  })

  test('resolves the repository learned from the session event stream when no hint is provided', async () => {
    await pool.query(`
      INSERT INTO source_events
        (source_event_id, installation_id, origin, origin_position, session_id,
         event_type, occurred_at, payload, payload_hash)
      VALUES (gen_random_uuid(), $1, 'feed', 'scope-repo-1', 'ses-scope',
              'session_metadata', NOW(), '{"repository_id":"github.com/example/main"}'::jsonb,
              sha256(convert_to('scope-repo-1','utf8')))
    `, [INSTALLATION])

    const resolved = await scope.resolve({ installationId: INSTALLATION, sessionId: 'ses-scope' })
    expect(resolved).toMatchObject({ repositoryKnown: true, repositoryId: REPO, personaOnly: false })
  })

  test('an unknown hint narrows to persona-only and never opens another scope', async () => {
    const resolved = await scope.resolve({
      installationId: INSTALLATION, sessionId: 'ses-scope',
      repositoryIdHint: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    })
    expect(resolved.repositoryKnown).toBe(false)
    expect(resolved.repositoryId).toBeNull()
    expect(resolved.personaOnly).toBe(true)
  })

  test('unknown behavior empty returns neither repository nor persona', async () => {
    const resolved = await scope.resolve({
      installationId: INSTALLATION, sessionId: 'ses-scope',
      repositoryKeyHint: 'not-known', unknownRepositoryBehavior: 'empty',
    })
    expect(resolved.repositoryKnown).toBe(false)
    expect(resolved.personaOnly).toBe(false)
  })

  test('installation Persona excludes reviewed work methods from narrower scopes', async () => {
    const seed = async (
      claimType: string,
      authority: string,
      state: string,
      withEvidence: boolean,
      scopeKind = 'installation',
      scopeKey = 'global',
    ) => {
      const claim = await pool.query<{ claim_id: string }>(`
        INSERT INTO knowledge_claims
          (claim_id, installation_id, claim_type, scope_kind, scope_key, normalized_key, state)
        VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6)
        RETURNING claim_id::text
      `, [
        INSTALLATION,
        claimType,
        scopeKind,
        scopeKey,
        `${claimType}:${authority}:${state}:${withEvidence}:${scopeKind}:${scopeKey}`,
        state,
      ])
      const version = await pool.query<{ version_id: string }>(`
        INSERT INTO knowledge_versions
          (version_id, installation_id, claim_id, version_number, statement, authority, confidence, freshness_at)
        VALUES (gen_random_uuid(), $1, $2, 1, 's', $3, 0.9, NOW())
        RETURNING version_id::text
      `, [INSTALLATION, claim.rows[0].claim_id, authority])
      await pool.query(`UPDATE knowledge_claims SET current_version_id = $2 WHERE claim_id = $1`,
        [claim.rows[0].claim_id, version.rows[0].version_id])
      if (withEvidence) {
        await pool.query(`
          INSERT INTO knowledge_evidence
            (evidence_id, installation_id, version_id, episode_id, evidence_kind, excerpt, excerpt_hash, occurred_at, ordinal)
          VALUES (gen_random_uuid(), $1, $2, (SELECT episode_id FROM work_episodes WHERE installation_id = $1 LIMIT 1), 'episode', 'x', sha256(convert_to('x','utf8')), NOW(), 0)
        `, [INSTALLATION, version.rows[0].version_id])
      }
      return claim.rows[0].claim_id
    }
    const eligible = await seed('work_method', 'user_accepted', 'active', true)
    await seed('work_method', 'user_accepted', 'revoked', true)
    await seed('work_method', 'user_accepted', 'active', false)
    await seed('architecture_decision', 'user_accepted', 'active', true)
    await seed('work_method', 'user_accepted', 'active', true, 'task', 'turn-task')
    await seed('work_method', 'user_corrected', 'active', true, 'repository', REPO)
    await seed('work_method', 'user_accepted', 'active', true, 'installation', 'not-global')

    const persona = await scope.personaVersions({ installationId: INSTALLATION })
    expect(persona).toEqual([{ claimId: eligible, versionId: expect.any(String) }])
  })

  test('session binding: an unprojected session is reported unknown', async () => {
    const resolved = await scope.resolve({
      installationId: INSTALLATION, sessionId: 'ses-not-projected',
    })
    expect(resolved.sessionKnown).toBe(false)
  })
})
