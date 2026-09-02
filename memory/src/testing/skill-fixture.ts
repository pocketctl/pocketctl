import { createHash, randomUUID } from 'node:crypto'
import type pg from 'pg'
import { createSkillAdmissionService } from '../skills/admission-service.js'
import { createSkillWorker } from '../skills/worker.js'
import { createSkillGenerator } from '../skills/generator.js'
import { createJobRepository } from '../jobs/repository.js'
import { createReviewPolicyRepository, DEFAULT_TEAM_REVIEW_POLICY } from '../governance/review-policy.js'
import type { V2GrantFacts } from '../governance/authorization.js'
import type { TextGenerator } from '../ports/text-generator.js'
import type { SkillSourceContext } from '../skills/source-resolver.js'
import { EPISODE_COMPILER_VERSION } from '../episodes/compiler.js'
import { EPISODE_PACKET_COMPILER_VERSION } from '../episodes/packet.js'

export const skillFixtureDocument = (high = false) => ({
  schema_version: 'skill-candidate.v1', title: 'Find the failing test', trigger: 'Investigate failure', preconditions: ['Repository access'],
  steps: [{ instruction: high ? 'Deploy the service' : 'Search source files', tool: high ? 'deploy' : 'search', permissions: [high ? 'production:write' : 'repository:read'], operation: high ? 'deployment' : 'read' }],
  validation: ['Check expected result'], failure_handling: ['Report failure'], rollback: ['Stop and report'], source_tokens: ['source-1'],
})

export async function createSkillGovernanceFixture(pool: pg.Pool, context: SkillSourceContext, kind: 'personal' | 'team' | 'organization' = 'personal', high = false, options: { naturalSourceSessionKeys?: string[] } = {}) {
    const installationId = randomUUID(), repositoryId = randomUUID(), snapshotId = randomUUID(), episodeId = randomUUID(), sessionId = randomUUID()
    const excerpt = 'tests passed', hash = createHash('sha256').update(excerpt).digest('hex').slice(0, 16)
    await pool.query(`INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version)
      VALUES($1,'pocketctl-memory','active','ready',1)`, [installationId])
    await pool.query(`INSERT INTO memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id)VALUES($1,$2,$1)`, [installationId, kind])
    await pool.query(`INSERT INTO source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at)VALUES($1,$2,NOW(),NOW())`, [installationId, sessionId])
    await pool.query(`INSERT INTO repositories(installation_id,repository_id,repository_key,first_observed_at,last_observed_at)VALUES($1,$2,$2::uuid::text,NOW(),NOW())`, [installationId, repositoryId])
    await pool.query(`INSERT INTO repo_snapshots(installation_id,repo_snapshot_id,repository_id,commit_sha,observed_at)VALUES($1,$2,$3,$4,NOW())`, [installationId, snapshotId, repositoryId, 'a'.repeat(40)])
    await pool.query(`INSERT INTO work_episodes(installation_id,episode_id,session_id,turn_id,state,outcome,ready_at,compiler_version,repository_id,repo_snapshot_id,source_digest,document,evidence_manifest,document_compiler_version,compiled_at)
      VALUES($1,$2,$3,$2::uuid::text,'ready','completed',NOW()-INTERVAL'1s','fixture',$4,$5,decode($6,'hex'),$7,$8,'v1',NOW())`,
    [installationId, episodeId, sessionId, repositoryId, snapshotId, 'a'.repeat(64), { tests: [{ status: 'passed', text: excerpt, evidence_handle: 'e1' }] }, { e1: { kind: 'episode', excerpt_hash: hash, excerpt_length: excerpt.length, truncated: false } }])
    async function actor(roles: string[], permissions: string[]) {
      const membershipId = kind === 'personal' ? null : randomUUID()
      if (membershipId) await pool.query(`INSERT INTO memory_scope_memberships(installation_id,membership_id,roles)VALUES($1,$2,$3)`, [installationId, membershipId, roles])
      const grant: V2GrantFacts = { primaryInstallationId: installationId, configVersion: '1', scopeBindings: [{ installation_id: installationId,
        owner_scope_kind: kind, owner_scope_id: installationId, membership_id: membershipId, membership_revision: membershipId ? '1' : '0', authorization_epoch: '1', permissions }] }
      return { installationId, grant, membershipId }
    }
    const author = await actor(['contributor','reviewer'], ['read','contribute','review'])
    let source: { kind: string; episodeId?: string; versionId?: string; repositoryId?: string; repoSnapshotId?: string } = { kind: 'episode', episodeId }
    if (kind !== 'personal') {
      const claimId = randomUUID(), versionId = randomUUID()
      const policies = createReviewPolicyRepository(pool)
      const policy = await policies.ensurePolicySet(installationId, DEFAULT_TEAM_REVIEW_POLICY)
      await pool.query(`UPDATE work_episodes SET session_id='shared-governance',outcome=NULL,repository_id=NULL,repo_snapshot_id=NULL,source_digest=NULL,document='{}',evidence_manifest='{}' WHERE episode_id=$1`, [episodeId])
      const c = await pool.connect()
      try {
        await c.query('BEGIN')
        await c.query(`INSERT INTO knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state,current_version_id,owner_scope_kind,owner_scope_id)
          VALUES($1,$2,'work_method','repository',$3,'method','active',$4,$5,$2)`, [claimId, installationId, repositoryId, versionId, kind])
        await c.query(`INSERT INTO knowledge_versions(version_id,installation_id,claim_id,version_number,statement,authority,confidence,source_promotion_candidate_id)
          VALUES($1,$2,$3,1,'Reviewed method','team_published',1,$4)`, [versionId, installationId, claimId, randomUUID()])
        await c.query('COMMIT')
      } finally { c.release() }
      await pool.query(`INSERT INTO knowledge_evidence(evidence_id,installation_id,version_id,episode_id,evidence_kind,excerpt,excerpt_hash,occurred_at,ordinal,visibility)
        VALUES($1,$2,$3,$4,'episode',$5,$6,NOW(),1,'shared')`, [randomUUID(), installationId, versionId, episodeId, excerpt, createHash('sha256').update(excerpt).digest()])
      await pool.query(`INSERT INTO memory_authority_records(authority_id,installation_id,version_id,candidate_revision_id,review_policy_version_id,counted_decision_ids,publisher_membership_id,source_scope_kind,source_content_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,'personal','fixture')`, [randomUUID(), installationId, versionId, randomUUID(), policy.policyVersionId, [randomUUID()], author.membershipId])
      source = { kind: 'claim_version', versionId, repositoryId, repoSnapshotId: snapshotId }
      const sessions = new Map<string,string>()
      for(const [index,key] of (options.naturalSourceSessionKeys??[]).entries()) {
        const id=sessions.get(key)??randomUUID();sessions.set(key,id)
        const naturalEpisodeId=randomUUID()
        await pool.query(`INSERT INTO source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at)VALUES($1,$2,NOW(),NOW()) ON CONFLICT DO NOTHING`,[installationId,id])
        await pool.query(`INSERT INTO work_episodes(installation_id,episode_id,session_id,turn_id,state,outcome,ready_at,compiler_version,repository_id,repo_snapshot_id,source_digest,document,evidence_manifest,document_compiler_version,compiled_at)
          VALUES($1,$2,$3,$2::uuid::text,'ready','completed',NOW()-INTERVAL'1s',$4,$5,$6,decode($7,'hex'),$8,$9,$10,NOW())`,
        [installationId,naturalEpisodeId,id,EPISODE_COMPILER_VERSION,repositoryId,snapshotId,'b'.repeat(64),{tests:[{status:'passed',text:excerpt,evidence_handle:'e1'}]},{e1:{kind:'episode',excerpt_hash:hash,excerpt_length:excerpt.length,truncated:false}},EPISODE_PACKET_COMPILER_VERSION])
        await pool.query(`INSERT INTO knowledge_evidence(evidence_id,installation_id,version_id,episode_id,evidence_kind,excerpt,excerpt_hash,occurred_at,ordinal,visibility)
          VALUES($1,$2,$3,$4,'episode',$5,$6,NOW(),$7,'shared')`,[randomUUID(),installationId,versionId,naturalEpisodeId,excerpt,createHash('sha256').update(excerpt).digest(),index+2])
      }
    }
    const scheduled = await createSkillAdmissionService({ pool, context }).schedule({ ...author, candidateKey: 'method', source })
    const job = (await createJobRepository(pool).claimJobs({ workerId: 'governance-fixture', limit: 1, leaseMs: 30000 }))[0]!
    const provider = { generateJson: async () => ({ ok: true, value: {...skillFixtureDocument(high),source_tokens:Array.from({length:1+(options.naturalSourceSessionKeys?.length??0)},(_,i)=>`source-${i+1}`)}, usage: { inputTokens: 1, outputTokens: 1, model: 'fixture' } }) } as TextGenerator
    await createSkillWorker({ pool, context, generator: createSkillGenerator({ provider, timeoutMs: 100 }) }).handle(job, new AbortController().signal,
      { fence: { jobId: job.job_id, claimedBy: 'governance-fixture', claimEpoch: job.claim_epoch } })
    const candidateId = (await pool.query(`SELECT candidate_id FROM memory_skill_candidates WHERE task_id=$1`, [scheduled.taskId])).rows[0].candidate_id as string
    return { installationId, repositoryId, snapshotId, sessionId, episodeId, candidateId, author, actor }
  }
