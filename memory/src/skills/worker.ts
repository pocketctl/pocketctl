import { createHash, randomUUID } from 'node:crypto'
import type pg from 'pg'
import type { JobClaim, JobFence } from '../jobs/types.js'
import { assertJobFence } from '../generation/fence.js'
import type { V2GrantFacts } from '../governance/authorization.js'
import { buildResolvedSkillArchive } from './archive.js'
import { canonicalJsonString } from '../inbox/canonical-json.js'
import { resolveSkillSource, SkillWorkError, type SkillSourceContext, type SkillSourceRequest } from './source-resolver.js'
import type { SkillGenerator } from './generator.js'
interface LockedRun {
  run_id: string
  task_id: string
  generation: string
  source_kind: 'episode' | 'claim_version'
  repository_id: string
  repo_snapshot_id: string
  episode_id: string | null
  claim_version_id: string | null
  source_digest: string
  input_digest: string
  policy_version: string
  grant_snapshot: V2GrantFacts
  state: string
  candidate_key: string
  current_generation: string
  generation_run_id: string | null
}
export function createSkillWorker(deps: {
  pool: pg.Pool
  context: SkillSourceContext
  generator?: SkillGenerator
}) {
  async function assertSkillFence(client: pg.PoolClient, fence: JobFence) {
    await assertJobFence(client, fence)
    const live = await client.query(`SELECT 1 FROM memory_jobs WHERE job_id=$1 AND claim_expires_at>clock_timestamp()`, [fence.jobId])
    if (!live.rowCount)
      throw new SkillWorkError('skill_lease_expired', 'lost_lease')
  }
  const load = async (client: pg.PoolClient, claim: JobClaim, lock = true) => {
    const taskId = typeof claim.payload.task_id === 'string' ? claim.payload.task_id : null, generation = Number(claim.payload.generation)
    if (!taskId || !Number.isSafeInteger(generation) || generation < 1)
      throw new SkillWorkError('skill_payload_invalid')
    if (lock)
      await client.query(`SELECT 1 FROM memory_skill_tasks WHERE installation_id=$1 AND task_id=$2 FOR UPDATE`, [claim.installation_id, taskId])
    const result = await client.query<LockedRun>(`SELECT r.run_id,r.task_id,r.generation::text,r.source_kind,r.repository_id,
      r.repo_snapshot_id,r.episode_id,r.claim_version_id,r.source_digest,r.input_digest,r.policy_version,r.grant_snapshot,
      r.state,t.candidate_key,t.current_generation::text,r.generation_run_id
      FROM memory_skill_task_runs r JOIN memory_skill_tasks t USING(installation_id,task_id)
      WHERE r.installation_id=$1 AND r.task_id=$2 AND r.generation=$3 ${lock ? 'FOR UPDATE OF r' : ''}`, [claim.installation_id, taskId, generation])
    if (!result.rows[0])
      throw new SkillWorkError('skill_run_missing')
    return result.rows[0]
  }
  async function deadLetter(client: pg.PoolClient, claim: JobClaim, code: string) {
    await client.query(`UPDATE memory_jobs SET state='dead',last_error_code=$2,completed_at=NOW(),claim_expires_at=NULL WHERE job_id=$1`, [claim.job_id, code])
    await client.query(`INSERT INTO memory_dead_letters(job_id,installation_id,job_type,attempts,error_code,payload_hash)
      SELECT job_id,installation_id,job_type,attempts,$2,$3 FROM memory_jobs WHERE job_id=$1
      ON CONFLICT(job_id) DO NOTHING`, [claim.job_id, code, createHash('sha256').update(JSON.stringify(claim.payload)).digest()])
  }
  async function finishWithoutProvider(claim: JobClaim, fence: JobFence, state: 'cancelled' | 'failed' | 'stale_generation', code: string) {
    const client = await deps.pool.connect()
    try {
      await client.query('BEGIN')
      const run = await load(client, claim)
      await assertSkillFence(client, fence)
      await client.query(`UPDATE memory_skill_task_runs SET state=$4,error_code=$5,completed_at=NOW()
        WHERE installation_id=$1 AND task_id=$2 AND generation=$3`, [claim.installation_id, run.task_id, Number(run.generation), state, code])
      if (state === 'failed') await deadLetter(client, claim, code)
      else await client.query(`UPDATE memory_jobs SET state='completed',last_error_code=$2,completed_at=NOW(),claim_expires_at=NULL
          WHERE job_id=$1`, [claim.job_id, code])
      const taskState = state === 'cancelled' ? 'cancelled' : state === 'failed' ? 'dead' : null
      if (taskState)
        await client.query(`UPDATE memory_skill_tasks SET state=$4,updated_at=NOW()
        WHERE installation_id=$1 AND task_id=$2 AND current_generation=$3`, [claim.installation_id, run.task_id, Number(run.generation), taskState])
      if (run.generation_run_id)
        await client.query(`UPDATE memory_generation_runs SET state=$2,error_code=$3,completed_at=NOW()
        WHERE run_id=$1 AND state IN('queued','running')`, [run.generation_run_id, state === 'cancelled' ? 'cancelled' : 'failed', code])
      await client.query('COMMIT')
    }
    catch (e) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw e
    }
    finally {
      client.release()
    }
  }
  async function handleClaim(claim: JobClaim, signal: AbortSignal, ctx?: {
    fence: JobFence
  }) {
    if (!claim.installation_id || !ctx?.fence)
      throw new SkillWorkError('skill_fence_missing', 'lost_lease')
    if (signal.aborted)
      throw new SkillWorkError('skill_aborted', 'cancelled')
    if (deps.context.config.mode === 'off') {
      await finishWithoutProvider(claim, ctx.fence, 'cancelled', 'skill_disabled')
      return
    }
    if (!deps.generator) {
      await finishWithoutProvider(claim, ctx.fence, 'failed', 'skill_provider_unavailable')
      return
    }
    let run: LockedRun, source: Awaited<ReturnType<typeof resolveSkillSource>>, generationRunId: string
    const start = await deps.pool.connect()
    try {
      await start.query('BEGIN')
      run = await load(start, claim, false)
      if (run.state === 'candidate') {
        await start.query('COMMIT')
        return
      }
      if (Number(run.current_generation) !== Number(run.generation)) {
        await start.query('ROLLBACK')
        await finishWithoutProvider(claim, ctx.fence, 'stale_generation', 'stale_generation')
        return
      }
      source = await resolveSkillSource(start, { installationId: claim.installation_id, grant: run.grant_snapshot, source: (run.source_kind === 'episode' ? { kind: 'episode', episodeId: run.episode_id! } : { kind: 'claim_version', versionId: run.claim_version_id!, repositoryId: run.repository_id, repoSnapshotId: run.repo_snapshot_id }) as SkillSourceRequest }, deps.context)
      run = await load(start, claim)
      if (Number(run.current_generation) !== Number(run.generation) || !['pending','running'].includes(run.state))
        throw new SkillWorkError('stale_generation', 'cancelled')
      if (source.inputDigest !== run.input_digest || source.sourceDigest !== run.source_digest)
        throw new SkillWorkError('stale_generation', 'cancelled')
      await assertSkillFence(start, ctx.fence)
      if (run.generation_run_id)
        await start.query(`UPDATE memory_generation_runs SET state='cancelled',error_code='worker_reclaimed',completed_at=NOW()
        WHERE run_id=$1 AND state IN('queued','running')`, [run.generation_run_id])
      generationRunId = randomUUID()
      const subject = createHash('sha256').update(`${run.task_id}:${run.generation}`).digest()
      await start.query(`INSERT INTO memory_generation_runs(run_id,installation_id,operation,subject_kind,subject_key_hash,
        input_digest,effective_policy_hash,state,job_id,job_claim_epoch)
        VALUES($1,$2,'extract_skill_candidate','skill_task',$3,decode($4,'hex'),$5,'running',$6,$7)`, [generationRunId, claim.installation_id, subject, run.input_digest, createHash('sha256').update(run.policy_version).digest(), claim.job_id, ctx.fence.claimEpoch])
      await start.query(`UPDATE memory_skill_task_runs SET state='running',generation_run_id=$4,error_code=NULL
        WHERE installation_id=$1 AND task_id=$2 AND generation=$3`, [claim.installation_id, run.task_id, Number(run.generation), generationRunId])
      await start.query(`UPDATE memory_skill_tasks SET state='running',updated_at=NOW() WHERE installation_id=$1 AND task_id=$2`, [claim.installation_id, run.task_id])
      await start.query('COMMIT')
    }
    catch (e) {
      await start.query('ROLLBACK').catch(() => undefined)
      if (e instanceof SkillWorkError && (e.kind === 'permanent' || e.kind === 'cancelled')) {
        await finishWithoutProvider(claim, ctx.fence, e.kind === 'cancelled' ? 'cancelled' : 'failed', e.code)
        return
      }
      throw e
    }
    finally {
      start.release()
    }
    const generated = await deps.generator.generate(source!, signal)
    if (signal.aborted)
      throw new SkillWorkError('skill_aborted', 'cancelled')
    const finish = await deps.pool.connect()
    try {
      await finish.query('BEGIN')
      run = await load(finish, claim, false)
      const fresh = await resolveSkillSource(finish, { installationId: claim.installation_id, grant: run.grant_snapshot, source: (run.source_kind === 'episode' ? { kind: 'episode', episodeId: run.episode_id! } : { kind: 'claim_version', versionId: run.claim_version_id!, repositoryId: run.repository_id, repoSnapshotId: run.repo_snapshot_id }) as SkillSourceRequest }, deps.context)
      run = await load(finish, claim)
      await assertSkillFence(finish, ctx.fence)
      if (run.generation_run_id !== generationRunId || Number(run.current_generation) !== Number(run.generation))
        throw new SkillWorkError('stale_generation', 'cancelled')
      if (fresh.inputDigest !== run.input_digest || fresh.sourceDigest !== run.source_digest)
        throw new SkillWorkError('stale_generation', 'cancelled')
      if (!generated.ok) {
        await finish.query(`UPDATE memory_generation_runs SET state='failed',error_code=$2,input_tokens=$3,output_tokens=$4,completed_at=NOW()
          WHERE run_id=$1`, [generationRunId, generated.code, generated.usage?.inputTokens ?? 0, generated.usage?.outputTokens ?? 0])
        if (generated.retryable) {
          await finish.query(`UPDATE memory_skill_task_runs SET state='pending',error_code=$4,generation_run_id=NULL
          WHERE installation_id=$1 AND task_id=$2 AND generation=$3`, [claim.installation_id, run.task_id, Number(run.generation), generated.code])
          await finish.query('COMMIT')
          throw new SkillWorkError(generated.code, 'transient')
        }
        await finish.query(`UPDATE memory_skill_task_runs SET state='failed',error_code=$4,completed_at=NOW()
          WHERE installation_id=$1 AND task_id=$2 AND generation=$3`, [claim.installation_id, run.task_id, Number(run.generation), generated.code])
        await finish.query(`UPDATE memory_skill_tasks SET state='dead',updated_at=NOW() WHERE installation_id=$1 AND task_id=$2`, [claim.installation_id, run.task_id])
        await deadLetter(finish, claim, generated.code)
        await finish.query('COMMIT')
        return
      }
      if (canonicalJsonString(generated.document).length > deps.context.config.maxCandidateChars)
        throw new SkillWorkError('skill_output_size_exceeded')
      const archive = buildResolvedSkillArchive({
        source: fresh, taskId: run.task_id, generation: Number(run.generation),
        candidateKey: run.candidate_key, policyVersion: run.policy_version, document: generated.document
      })
      const archiveId = randomUUID(), candidateId = randomUUID()
      await finish.query(`INSERT INTO memory_skill_archives(archive_id,installation_id,repository_id,repo_snapshot_id,episode_id,
        claim_version_id,source_kind,task_id,generation,candidate_key,policy_version,source_digest,input_digest,content_hash,document_hash,document)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)`, [archiveId, claim.installation_id, fresh.repositoryId, fresh.repoSnapshotId, fresh.episodeId, fresh.versionId, fresh.kind,
        run.task_id, Number(run.generation), run.candidate_key, run.policy_version, fresh.sourceDigest, fresh.inputDigest,
        archive.contentHash, archive.documentHash, JSON.stringify(generated.document)])
      for (const item of fresh.sources)
        await finish.query(`INSERT INTO memory_skill_archive_sources(installation_id,archive_id,
        source_token,evidence_handle,excerpt_hash,evidence_kind,source_event_id,artifact_id,evidence_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [claim.installation_id, archiveId, item.token, item.handle, item.excerptHash, item.kind, item.eventId, item.artifactId, item.evidenceId])
      await finish.query(`UPDATE memory_skill_candidates SET state='superseded' WHERE installation_id=$1 AND task_id=$2 AND state='candidate'`, [claim.installation_id, run.task_id])
      await finish.query(`INSERT INTO memory_skill_candidates(candidate_id,installation_id,task_id,generation,archive_id,generation_run_id,document_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [candidateId, claim.installation_id, run.task_id, Number(run.generation), archiveId, generationRunId, archive.documentHash])
      await finish.query(`UPDATE memory_generation_runs SET state='succeeded',output_kind='skill_candidate',output_id=$2,input_tokens=$3,
        output_tokens=$4,cost_micros=$5,completed_at=NOW() WHERE run_id=$1`, [generationRunId, candidateId, generated.usage.inputTokens, generated.usage.outputTokens, generated.usage.costMicros ?? 0])
      if (generated.budgetReservationId) await finish.query(`UPDATE memory_skill_task_runs SET budget_reservation_id=$4
        WHERE installation_id=$1 AND task_id=$2 AND generation=$3`, [claim.installation_id,run.task_id,Number(run.generation),generated.budgetReservationId])
      const completedRun = await finish.query(`UPDATE memory_skill_task_runs SET state='candidate',completed_at=NOW()
        WHERE installation_id=$1 AND task_id=$2 AND generation=$3 AND generation_run_id=$4 AND state='running'`, [claim.installation_id, run.task_id, Number(run.generation), generationRunId])
      const completedTask = await finish.query(`UPDATE memory_skill_tasks SET state='candidate',updated_at=NOW()
        WHERE installation_id=$1 AND task_id=$2 AND current_generation=$3`, [claim.installation_id, run.task_id, Number(run.generation)])
      if (completedRun.rowCount !== 1 || completedTask.rowCount !== 1)
        throw new SkillWorkError('skill_completion_cas_lost', 'lost_lease')
      if (signal.aborted)
        throw new SkillWorkError('skill_aborted', 'lost_lease')
      await assertSkillFence(finish, ctx.fence)
      await finish.query(`UPDATE memory_jobs SET state='completed',completed_at=NOW(),claim_expires_at=NULL,last_error_code=NULL WHERE job_id=$1`, [claim.job_id])
      await finish.query('COMMIT')
    }
    catch (e) {
      await finish.query('ROLLBACK').catch(() => undefined)
      const classified = e instanceof SkillWorkError ? e :
        e instanceof Error && /^(skill_archive|skill_secret|skill_source)/.test(e.message)
          ? new SkillWorkError(e.message, 'permanent') : null
      if (classified && (classified.kind === 'permanent' || classified.kind === 'cancelled')) {
        await finishWithoutProvider(claim, ctx.fence, classified.kind === 'cancelled' ? 'cancelled' : 'failed', classified.code)
        return
      }
      throw e
    }
    finally {
      finish.release()
    }
  }
  return {
    async handle(claim: JobClaim, signal: AbortSignal, ctx?: {
      fence: JobFence
    }) {
      const lock = await deps.pool.connect()
      const key = `skill:worker:${claim.installation_id}:${String(claim.payload.task_id)}`
      let owned = false
      try {
        const result = await lock.query<{
          owned: boolean
        }>(`SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS owned`, [key])
        owned = result.rows[0]?.owned === true
        if (!owned)
          throw new SkillWorkError('skill_key_busy', 'transient')
        await handleClaim(claim, signal, ctx)
      }
      finally {
        let releaseError: Error | undefined
        if (owned)
          try {
            await lock.query(`SELECT pg_advisory_unlock(hashtextextended($1,0))`, [key])
          }
          catch {
            releaseError = new Error('skill_worker_lock_release_failed')
          }
        lock.release(releaseError)
      }
    }
  }
}
