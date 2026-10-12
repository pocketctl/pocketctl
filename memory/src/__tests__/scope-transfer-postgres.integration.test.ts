import {queryHookPool} from './helpers/query-hook-pool.js'
import {originContextFixture} from './helpers/origin-context-fixture.js'
import {createAdmissionService} from '../context/admission-service.js'
import {createSearchService} from '../retrieval/search-service.js'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { createTransferService, TransferError } from '../governance/transfer-service.js'
import type { RouteV2Grant } from '../governance/authorization.js'
import {createHash,randomUUID} from 'node:crypto'
import {governanceFixture} from '../testing/governance-fixture.js'
import {createPublicationService} from '../governance/publication-service.js'
import {verifyRevisionBundle} from '../governance/revision-bundle.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const integrationEnabled = Boolean(
  databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const TEAM = 'beefbeef-0000-4000-8000-000000000002'
const ORG = 'beefbeef-0000-4000-8000-000000000003'
const ORG_SCOPE = 'beefbeef-0000-4000-8000-000000000031'
const ADMIN = 'beefbeef-0000-4000-8000-000000000021'

function grant(): RouteV2Grant {
  return {
    version: 'v2',
    installationId: ORG,
    primaryInstallationId: ORG,
    services: ['memory.search'],
    configVersion: '1',
    callerType: 'web',
    scopeBindings: [
      {
        installation_id: TEAM,
        owner_scope_kind: 'team',
        owner_scope_id: 'beefbeef-0000-4000-8000-000000000041',
        membership_id: ADMIN,
        membership_revision: '2',
        authorization_epoch: '1',
        permissions: ['read', 'scope_admin'],
      },
      {
        installation_id: ORG,
        owner_scope_kind: 'organization',
        owner_scope_id: ORG_SCOPE,
        membership_id: ADMIN,
        membership_revision: '2',
        authorization_epoch: '1',
        permissions: ['read', 'scope_admin'],
      },
    ],
  }
}

describeWithDatabase('scope transfer runs (PostgreSQL)', () => {
  let pool: pg.Pool
  let transfer: ReturnType<typeof createTransferService>

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl })
    const database = await pool.query<{ database_name: string }>(
      'SELECT current_database() AS database_name',
    )
    if (!/test/i.test(database.rows[0]?.database_name ?? '')) {
      throw new Error('Refusing integration test against non-test database')
    }
    await applyMemorySchema(pool)
    transfer = createTransferService(pool)
  }, 60_000)

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE memory_governance_events, memory_review_decisions, memory_promotion_evidence,
                memory_promotion_candidate_versions, memory_promotion_candidates,
                memory_authority_records, memory_jobs, memory_transfer_runs,
                memory_review_policy_heads, memory_review_policy_versions, memory_review_policy_sets,
                memory_scope_tombstones, memory_scope_memberships, memory_owner_scopes,
                knowledge_evidence, knowledge_versions, knowledge_claims, work_episodes,
                memory_installations CASCADE
    `)
    for (const [installationId, kind, scopeId, parent, state] of [
      [TEAM, 'team', 'beefbeef-0000-4000-8000-000000000041', ORG_SCOPE, 'dissolving'],
      [ORG, 'organization', ORG_SCOPE, null, 'active'],
    ] as const) {
      await pool.query(`
        INSERT INTO memory_installations
          (installation_id, provider_id, relay_status, local_status, config_version,
           granted_scopes, subscriptions, enabled_services, event_filter)
        VALUES ($1, 'pocketctl-memory', 'active', 'ready', 1,
                '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb)
      `, [installationId])
      await pool.query(`
        INSERT INTO memory_owner_scopes (installation_id, owner_scope_kind, owner_scope_id, parent_organization_id, state)
        VALUES ($1, $2, $3, $4, $5)
      `, [installationId, kind, scopeId, parent, state])
    }
    for (const [installationId, membershipId] of [[TEAM, ADMIN], [ORG, ADMIN]] as const) {
      await pool.query(`
        INSERT INTO memory_scope_memberships (installation_id, membership_id, roles, state, membership_revision)
        VALUES ($1, $2, '{scope_administrator}', 'active', 2)
      `, [installationId, membershipId])
    }
    // Two active team claims with shared evidence.
    for (const key of ['transfer-key-1', 'transfer-key-2']) {
      const claimId = (await pool.query<{ id: string }>(`
        INSERT INTO knowledge_claims
          (claim_id, installation_id, claim_type, scope_kind, scope_key, normalized_key, state, owner_scope_kind, owner_scope_id)
        VALUES (gen_random_uuid(), $1, 'repository_convention', 'repository', '/repo', $2, 'active', 'team', 'beefbeef-0000-4000-8000-000000000041')
        RETURNING claim_id::text AS id
      `, [TEAM, key])).rows[0].id
      const versionId = (await pool.query<{ id: string }>(`
        INSERT INTO knowledge_versions
          (version_id, installation_id, claim_id, version_number, statement, authority, confidence)
        VALUES (gen_random_uuid(), $1, $2, 1, $3, 'team_published', 0.9)
        RETURNING version_id::text AS id
      `, [TEAM, claimId, `statement for ${key}`])).rows[0].id
      await pool.query(`
        UPDATE knowledge_claims SET current_version_id = $2 WHERE installation_id = $1 AND claim_id = $3
      `, [TEAM, versionId, claimId])
      await pool.query(`
        INSERT INTO work_episodes (installation_id, episode_id, session_id, turn_id, state, compiler_version)
        VALUES ($1, gen_random_uuid(), 'transfer-session', $2, 'ready', 'test')
      `, [TEAM, key])
      await pool.query(`
        INSERT INTO knowledge_evidence
          (evidence_id, installation_id, version_id, episode_id, ordinal, evidence_kind, excerpt, excerpt_hash, occurred_at, visibility)
        VALUES (gen_random_uuid(), $1, $2,
                (SELECT episode_id FROM work_episodes WHERE installation_id = $1 AND turn_id = $3),
                1, 'episode', $4, $5, NOW(), 'shared')
      `, [TEAM, versionId, key, `evidence for ${key}`,createHash('sha256').update(`evidence for ${key}`).digest()])
    }
  })

  test('creates organization candidates only; nothing publishes automatically', async () => {
    const result = await transfer.startTeamTransfer({
      grant: grant(), sourceInstallationId: TEAM, targetInstallationId: ORG, expectedAuthorizationEpoch: 1,
    })
    expect(result.candidates).toBe(2)

    const candidates = await pool.query(`
      SELECT state, source_scope_kind, target_installation_id::text
      FROM memory_promotion_candidates WHERE target_installation_id = $1
    `, [ORG])
    expect(candidates.rows.every(row => row.state === 'proposed')).toBe(true)
    expect(candidates.rows.every(row => row.source_scope_kind === 'team')).toBe(true)
    // No active organization claim was created by the transfer.
    const activeOrg = await pool.query(`
      SELECT COUNT(*)::text AS count FROM knowledge_claims
      WHERE installation_id = $1 AND state = 'active'
    `, [ORG])
    expect(Number(activeOrg.rows[0].count)).toBe(0)

    // The run completed with evidence copies attached.
    const evidence = await pool.query(`
      SELECT COUNT(*)::text AS count FROM memory_promotion_evidence e
      JOIN memory_promotion_candidate_versions v ON v.candidate_revision_id = e.candidate_revision_id
      JOIN memory_promotion_candidates c ON c.candidate_id = v.candidate_id
      WHERE c.target_installation_id = $1
    `, [ORG])
    expect(Number(evidence.rows[0].count)).toBe(2)

    // A second run for the same source conflicts.
    await expect(transfer.startTeamTransfer({
      grant: grant(), sourceInstallationId: TEAM, targetInstallationId: ORG, expectedAuthorizationEpoch: 1,
    })).rejects.toMatchObject({ code: 'conflict' })
  })

  test('transfer freezes full bundles and safe source provenance even when legacy proof is unknown',async()=>{
    await pool.query("UPDATE knowledge_versions SET valid_from='2025-01-01',valid_until='2030-01-01',freshness_at='2025-02-01' WHERE installation_id=$1",[TEAM])
    const provenance={source_kind:'team_session',team_id:'opaque-team',team_session_id:'opaque-session'}
    await pool.query('UPDATE knowledge_evidence SET locator=$2 WHERE installation_id=$1',[TEAM,{source_provenance:provenance,secret_path:'/private/source'}])
    await transfer.startTeamTransfer({grant:grant(),sourceInstallationId:TEAM,targetInstallationId:ORG,expectedAuthorizationEpoch:1})
    const revisions=(await pool.query('SELECT * FROM memory_promotion_candidate_versions')).rows
    for(const revision of revisions){
      const evidence=(await pool.query('SELECT * FROM memory_promotion_evidence WHERE candidate_revision_id=$1 ORDER BY ordinal',[revision.candidate_revision_id])).rows
      expect(revision.revision_bundle).not.toBeNull();expect(verifyRevisionBundle(revision,evidence)).toBe(true)
      expect(revision.revision_bundle).toMatchObject({sourceValidFrom:'2025-01-01T00:00:00.000Z',sourceValidUntil:'2030-01-01T00:00:00.000Z',sourceFreshnessAt:'2025-02-01T00:00:00.000Z',originPolicyHash:null,applicability:{scopeKind:'repository',status:'legacy_unknown'}})
      expect(evidence[0].sanitized_locator).toEqual({source_provenance:provenance})
    }
  })
  test('corrupt raw evidence rolls back the complete transfer',async()=>{
    await pool.query("UPDATE knowledge_evidence SET excerpt='Substituted source' WHERE installation_id=$1",[TEAM])
    await expect(transfer.startTeamTransfer({grant:grant(),sourceInstallationId:TEAM,targetInstallationId:ORG,expectedAuthorizationEpoch:1})).rejects.toThrow(/integrity/)
    expect((await pool.query('SELECT 1 FROM memory_transfer_runs')).rowCount).toBe(0)
    expect((await pool.query('SELECT 1 FROM memory_promotion_candidates')).rowCount).toBe(0)
  })
  test('published Team source transfers with upstream proof and publishes only after fresh Organization votes',async()=>{
    const f=await governanceFixture(pool),proposal=await f.approved(),publication=createPublicationService(pool)
    const published=await publication.publish({grant:f.grant(f.publisher,['read','publish']),targetInstallationId:f.team,candidateId:proposal.candidate.candidate_id,expectedCandidateRevision:1,resolution:'new'})
    const original=(await pool.query('SELECT revision_bundle FROM memory_promotion_candidate_versions WHERE candidate_revision_id=$1',[proposal.candidateRevision.candidate_revision_id])).rows[0].revision_bundle
    await pool.query("UPDATE memory_owner_scopes SET state='dissolving',parent_organization_id=$2 WHERE installation_id=$1",[f.team,ORG_SCOPE])
    const g=grant();g.scopeBindings[0]={installation_id:f.team,owner_scope_kind:'team',owner_scope_id:f.team,membership_id:f.publisher,membership_revision:'1',authorization_epoch:'1',permissions:['read','scope_admin']}
    await transfer.startTeamTransfer({grant:g,sourceInstallationId:f.team,targetInstallationId:ORG,expectedAuthorizationEpoch:1})
    const candidate=(await pool.query('SELECT * FROM memory_promotion_candidates WHERE source_installation_id=$1',[f.team])).rows[0]
    const revision=(await pool.query('SELECT * FROM memory_promotion_candidate_versions WHERE candidate_id=$1',[candidate.candidate_id])).rows[0]
    expect(revision.revision_bundle.originPolicyHash).toBe(original.reviewPolicyHash)
    expect(revision.revision_bundle.sourceFreshnessAt).toBe(original.sourceFreshnessAt)
    expect(revision.revision_bundle.applicability).toEqual(original.applicability)
    expect((await pool.query('SELECT 1 FROM knowledge_claims WHERE installation_id=$1',[ORG])).rowCount).toBe(0)
    const actor=(id:string,permissions:string[])=>({...g,scopeBindings:[{...g.scopeBindings[1],membership_id:id,permissions}]})
    const request={targetInstallationId:ORG,candidateId:candidate.candidate_id,expectedCandidateRevision:1,resolution:'new' as const,grant:actor(ADMIN,['read','publish'])}
    await expect(publication.publish(request)).rejects.toMatchObject({code:'quorum_failed'})
    for(let i=0;i<2;i++){
      const id=randomUUID();await pool.query("INSERT INTO memory_scope_memberships(installation_id,membership_id,roles,membership_revision) VALUES($1,$2,ARRAY['reviewer'],2)",[ORG,id])
      await publication.decide({grant:actor(id,['read','review']),targetInstallationId:ORG,candidateId:candidate.candidate_id,expectedCandidateRevision:1,decision:'approve'})
    }
    const result=await publication.publish(request)
    expect((await pool.query('SELECT freshness_at FROM knowledge_versions WHERE version_id=$1',[result.versionId])).rows[0].freshness_at.toISOString()).toBe(original.sourceFreshnessAt)
    expect(published.claimId).toBe(candidate.source_claim_id)
    await pool.query("UPDATE memory_owner_scopes SET state='dissolved' WHERE installation_id=$1",[f.team])
    const search=createSearchService({pool,recallEmbeddingTimeoutMs:100,cursorSigningKey:'transfer-origin'})
    expect((await search.search({installationId:ORG,query:'Transactional fixture'})).hits.map(h=>h.versionId)).toContain(result.versionId)
    const context=await originContextFixture(pool,ORG),pack=await context.compile();if(pack.kind!=='ready')throw new Error('transfer context not ready '+JSON.stringify(pack))
    const ticket=await context.admit(pack.packId);if(!ticket.ok||!('nonce' in ticket))throw new Error('transfer context not admitted')
    const hookedPool=queryHookPool(pool,async(sql:string,params:unknown[])=>{
      if(/UPDATE memory_context_injections j\s+SET state = 'prepared'/.test(sql))await pool.query("DELETE FROM memory_governance_events WHERE action='transfer_candidate_created' AND target_id=$1",[candidate.candidate_id])
    })
    expect(await createAdmissionService({pool:hookedPool,nonceHmacKey:Buffer.alloc(32,7)}).consume({installationId:ORG,sessionId:'origin-context-session',packId:pack.packId,injectionId:ticket.injectionId,nonce:ticket.nonce})).toEqual({ok:false,error:'expired'})
  })
  test('rejects non-parent targets and non-dissolving sources', async () => {
    await expect(transfer.startTeamTransfer({
      grant: grant(), sourceInstallationId: ORG, targetInstallationId: TEAM, expectedAuthorizationEpoch: 1,
    })).rejects.toMatchObject({ code: 'forbidden' })

    await pool.query(`
      UPDATE memory_owner_scopes SET state = 'active' WHERE installation_id = $1
    `, [TEAM])
    await expect(transfer.startTeamTransfer({
      grant: grant(), sourceInstallationId: TEAM, targetInstallationId: ORG, expectedAuthorizationEpoch: 1,
    })).rejects.toMatchObject({ code: 'invalid_edge' })

    await pool.query(`
      UPDATE memory_owner_scopes SET state = 'dissolving' WHERE installation_id = $1
    `, [TEAM])
    await pool.query(`
      UPDATE memory_owner_scopes SET state = 'suspended' WHERE installation_id = $1
    `, [ORG])
    await expect(transfer.startTeamTransfer({
      grant: grant(), sourceInstallationId: TEAM, targetInstallationId: ORG, expectedAuthorizationEpoch: 1,
    })).rejects.toMatchObject({ code: 'forbidden' })
  })
})
