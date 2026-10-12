import { createHash, randomUUID } from 'node:crypto'
import type pg from 'pg'
import type { ValidatedV2Grant } from '../governance/authorization.js'
import { createPromotionService } from '../governance/promotion-service.js'
import { createPublicationService } from '../governance/publication-service.js'

export async function governanceFixture(pool: pg.Pool) {
  const personal = randomUUID(), team = randomUUID(), claim = randomUUID(), version = randomUUID()
  const episode = randomUUID(), evidence = randomUUID()
  const proposer = randomUUID(), reviewer = randomUUID(), publisher = randomUUID()
  for (const [id, kind] of [[personal, 'personal'], [team, 'team']]) {
    await pool.query(`INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version)
      VALUES($1,'pocketctl-memory','active','ready',1)`, [id])
    await pool.query('INSERT INTO memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id) VALUES($1,$2,$1)', [id, kind])
  }
  for (const [id, roles] of [[proposer, ['contributor']], [reviewer, ['reviewer']], [publisher, ['scope_administrator']]]) {
    await pool.query(`INSERT INTO memory_scope_memberships(installation_id,membership_id,roles,state,membership_revision)
      VALUES($1,$2,$3,'active',1)`, [team, id, roles])
  }
  await pool.query(`INSERT INTO knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state)
    VALUES($1,$2,'test_invariant','installation','','transaction-fixture','active')`, [claim, personal])
  await pool.query(`INSERT INTO knowledge_versions(version_id,installation_id,claim_id,version_number,statement,authority,confidence)
    VALUES($1,$2,$3,1,'Transactional fixture invariant','user_accepted',0.9)`, [version, personal, claim])
  await pool.query('UPDATE knowledge_claims SET current_version_id=$2 WHERE claim_id=$1', [claim, version])
  await pool.query(`INSERT INTO work_episodes(installation_id,episode_id,session_id,turn_id,state,compiler_version)
    VALUES($1,$2,'transaction-fixture','transaction-turn','ready','fixture')`, [personal, episode])
  const excerpt = 'The fixture verifies transaction boundaries.'
  await pool.query(`INSERT INTO knowledge_evidence(evidence_id,installation_id,version_id,episode_id,ordinal,evidence_kind,excerpt,excerpt_hash,occurred_at)
    VALUES($1,$2,$3,$4,1,'episode',$5,$6,NOW())`, [evidence, personal, version, episode, excerpt, createHash('sha256').update(excerpt).digest()])
  function grant(member: string, permissions: string[]): ValidatedV2Grant {
    return { primaryInstallationId: team, configVersion: '1', scopeBindings: [
      { installation_id: personal, owner_scope_kind: 'personal', owner_scope_id: personal,
        membership_id: null, membership_revision: '0', authorization_epoch: '1', permissions: ['read'] },
      { installation_id: team, owner_scope_kind: 'team', owner_scope_id: team,
        membership_id: member, membership_revision: '1', authorization_epoch: '1', permissions },
    ] }
  }
  const proposeInput = { grant: grant(proposer, ['read', 'contribute']), sourceInstallationId: personal,
    sourceClaimId: claim, evidenceIds: [evidence], idempotencyDigest: randomUUID() }
  const promotion = createPromotionService(pool), publication = createPublicationService(pool)
  async function proposed() { return promotion.propose(proposeInput) }
  async function approved() {
    const result = await proposed()
    await publication.decide({ grant: grant(reviewer, ['read', 'review']), targetInstallationId: team,
      candidateId: result.candidate.candidate_id, expectedCandidateRevision: result.candidate.revision, decision: 'approve' })
    return result
  }
  return { personal, team, claim, version, evidence, proposer, reviewer, publisher, grant, proposeInput, proposed, approved }
}
