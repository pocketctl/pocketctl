import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { JOB_PRIORITIES } from '../jobs/types.js'
import type { ResolvedSkillInput, SkillSourceRequest } from './source-resolver.js'
import { SKILL_EXTRACTION_POLICY_VERSION } from './source-resolver.js'
import type { V2GrantFacts } from '../governance/authorization.js'

export interface ScheduledSkillTask { taskId: string; runId: string; generation: number; jobId: string; deduplicated: boolean }
export async function persistSkillTask(client: pg.PoolClient, input: {
  resolved: ResolvedSkillInput; candidateKey: string; grant: V2GrantFacts; source: SkillSourceRequest
}): Promise<ScheduledSkillTask> {
  const { resolved } = input
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended(
    'skill:task:' || $1 || ':' || $2 || ':' || $3,0))`,
  [resolved.installationId, resolved.repositoryId, input.candidateKey])
  const taskId = randomUUID()
  await client.query(`INSERT INTO memory_skill_tasks(task_id,installation_id,repository_id,candidate_key)
    VALUES($1,$2,$3,$4) ON CONFLICT(installation_id,repository_id,candidate_key) DO NOTHING`,
  [taskId, resolved.installationId, resolved.repositoryId, input.candidateKey])
  const locked = await client.query<{ task_id: string; current_generation: string; current_input_digest: string | null }>(`
    SELECT task_id,current_generation::text,current_input_digest FROM memory_skill_tasks
    WHERE installation_id=$1 AND repository_id=$2 AND candidate_key=$3 FOR UPDATE`,
  [resolved.installationId, resolved.repositoryId, input.candidateKey])
  const task = locked.rows[0]
  if (!task) throw new Error('skill_task_missing')
  const existing = await client.query<{ run_id: string; generation: string; job_id: string }>(`
    SELECT r.run_id,r.generation::text,j.job_id FROM memory_skill_task_runs r
    JOIN memory_jobs j ON j.installation_id=r.installation_id AND j.job_type='extract_skill_candidate'
      AND j.idempotency_key='skill:' || r.task_id || ':' || r.generation
    WHERE r.installation_id=$1 AND r.task_id=$2 AND r.input_digest=$3 AND r.generation=$4
      AND j.state<>'dead'
      AND r.state IN('pending','running','candidate') ORDER BY r.generation DESC LIMIT 1`,
  [resolved.installationId, task.task_id, resolved.inputDigest, Number(task.current_generation)])
  if (existing.rows[0]) return { taskId: task.task_id, runId: existing.rows[0].run_id,
    generation: Number(existing.rows[0].generation), jobId: existing.rows[0].job_id, deduplicated: true }
  const generation = Number(task.current_generation) + 1
  if (!Number.isSafeInteger(generation)) throw new Error('skill_generation_exhausted')
  await client.query(`UPDATE memory_skill_task_runs SET state='cancelled',error_code='new_generation',completed_at=NOW()
    WHERE installation_id=$1 AND task_id=$2 AND state IN('pending','running')`, [resolved.installationId, task.task_id])
  await client.query(`UPDATE memory_jobs SET state='completed',last_error_code='new_generation',completed_at=NOW(),claim_expires_at=NULL
    WHERE installation_id=$1 AND job_type='extract_skill_candidate' AND state IN('pending','running')
      AND (payload->>'task_id')=$2`, [resolved.installationId, task.task_id])
  await client.query(`UPDATE memory_generation_runs g SET state='cancelled',error_code='new_generation',completed_at=NOW()
    FROM memory_skill_task_runs r WHERE r.installation_id=$1 AND r.task_id=$2
      AND r.generation_run_id=g.run_id AND g.state IN('queued','running')`, [resolved.installationId, task.task_id])
  const runId = randomUUID(), jobId = randomUUID()
  const safeGrant = {
    primaryInstallationId: input.grant.primaryInstallationId, configVersion: input.grant.configVersion,
    scopeBindings: input.grant.scopeBindings.map(binding => ({ ...binding, permissions: [...binding.permissions] })),
  }
  await client.query(`INSERT INTO memory_skill_task_runs
    (run_id,installation_id,task_id,generation,source_kind,repository_id,repo_snapshot_id,
     episode_id,claim_version_id,source_digest,input_digest,policy_version,owner_scope_kind,
     authorization_epoch,grant_snapshot)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)`,
  [runId,resolved.installationId,task.task_id,generation,resolved.kind,resolved.repositoryId,resolved.repoSnapshotId,
    resolved.episodeId,resolved.versionId,resolved.sourceDigest,resolved.inputDigest,SKILL_EXTRACTION_POLICY_VERSION,
    resolved.ownerKind,resolved.authorizationEpoch,JSON.stringify(safeGrant)])
  await client.query(`INSERT INTO memory_jobs(job_id,installation_id,job_type,idempotency_key,priority,payload)
    VALUES($1,$2,'extract_skill_candidate',$3,$4,$5::jsonb)`,
  [jobId,resolved.installationId,`skill:${task.task_id}:${generation}`,
    JOB_PRIORITIES.extract_skill_candidate,JSON.stringify({task_id:task.task_id,generation})])
  await client.query(`UPDATE memory_skill_tasks SET current_generation=$3,current_input_digest=$4,state='pending',updated_at=NOW()
    WHERE installation_id=$1 AND task_id=$2`, [resolved.installationId,task.task_id,generation,resolved.inputDigest])
  return { taskId: task.task_id, runId, generation, jobId, deduplicated: false }
}
