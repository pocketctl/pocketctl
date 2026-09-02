import { createHash, randomUUID } from 'crypto'
import type pg from 'pg'
import { JOB_DEAD_LETTER_ATTEMPTS, JOB_PRIORITIES, type JobClaim, type JobType } from './types.js'

const RETRY_LADDER_MS: readonly number[] = [1_000, 5_000, 15_000, 45_000]
const RETRY_CAP_MS = 5 * 60_000

/** Frozen retry ladder: attempt n backs off per section 8.2 of the plan. */
export function retryDelayMs(attempts: number): number {
  if (attempts <= RETRY_LADDER_MS.length) return RETRY_LADDER_MS[attempts - 1]
  return RETRY_CAP_MS
}

interface JobRow {
  job_id: string
  installation_id: string | null
  job_type: JobType
  idempotency_key: string
  payload: Record<string, unknown>
  attempts: number | string
  claim_epoch: number | string
}

function toClaim(row: JobRow): JobClaim {
  return {
    job_id: row.job_id,
    installation_id: row.installation_id,
    job_type: row.job_type,
    idempotency_key: row.idempotency_key,
    payload: row.payload ?? {},
    attempts: Number(row.attempts),
    claim_epoch: Number(row.claim_epoch),
  }
}

/**
 * PostgreSQL job queue with claim fencing: every completion, renewal or
 * failure must match `job_id + claimed_by + claim_epoch`, so a worker whose
 * lease expired (and whose job was reclaimed under a bumped epoch) can never
 * finalize work a new worker already owns.
 */
export function createJobRepository(pool: pg.Pool) {
  return {
    async enqueueJob(input: {
      installationId?: string | null
      jobType: JobType
      idempotencyKey: string
      priority?: number
      payload?: Record<string, unknown>
      availableAt?: Date
    }): Promise<void> {
      // Availability defaults to the server clock: claiming compares
      // against server NOW(), so a client-side Date can make a job briefly
      // unclaimable whenever the two clocks skew apart.
      await pool.query(`
        INSERT INTO memory_jobs
          (job_id, installation_id, job_type, idempotency_key, priority, payload, available_at)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, COALESCE($7, NOW()))
        ON CONFLICT DO NOTHING
      `, [
        randomUUID(),
        input.installationId ?? null,
        input.jobType,
        input.idempotencyKey,
        input.priority ?? JOB_PRIORITIES[input.jobType],
        JSON.stringify(input.payload ?? {}),
        input.availableAt ?? null,
      ])
    },

    /** Reclaim expired leases, then claim one bounded batch (SKIP LOCKED). */
    async claimJobs(input: {
      workerId: string
      limit: number
      leaseMs: number
    }): Promise<JobClaim[]> {
      await pool.query(`
        UPDATE memory_jobs
        SET state = 'pending', claimed_by = NULL, claim_expires_at = NULL
        WHERE state = 'running' AND claim_expires_at < NOW()
      `)
      const result = await pool.query<JobRow>(`
        UPDATE memory_jobs SET
          state = 'running',
          claimed_by = $1,
          claim_epoch = claim_epoch + 1,
          claim_expires_at = NOW() + ($2 * INTERVAL '1 millisecond'),
          attempts = attempts + 1,
          last_error_code = NULL
        WHERE job_id IN (
          SELECT job_id FROM memory_jobs
          WHERE state = 'pending' AND available_at <= NOW()
          ORDER BY priority ASC, available_at ASC, created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT $3
        )
        RETURNING job_id, installation_id, job_type, idempotency_key, payload, attempts, claim_epoch
      `, [input.workerId, input.leaseMs, input.limit])
      return result.rows.map(toClaim)
    },

    /**
     * Fenced per-job renewal (ADR-P2-09): renews exactly one claim and
     * returns false when the caller no longer owns the job (lease expired and
     * reclaimed under a bumped epoch, or completed by someone else). A false
     * result must abort that job's handler immediately.
     */
    async renewClaim(input: {
      jobId: string
      claimedBy: string
      claimEpoch: number
      leaseMs: number
    }): Promise<boolean> {
      const result = await pool.query(`
        UPDATE memory_jobs
        SET claim_expires_at = NOW() + ($4 * INTERVAL '1 millisecond')
        WHERE job_id = $1 AND claimed_by = $2 AND claim_epoch = $3 AND state = 'running'
      `, [input.jobId, input.claimedBy, input.claimEpoch, input.leaseMs])
      return (result.rowCount ?? 0) > 0
    },

    /** Fenced completion; false means the caller no longer owns the job. */
    async completeJob(input: {
      jobId: string
      claimedBy: string
      claimEpoch: number
    }): Promise<boolean> {
      const result = await pool.query(`
        UPDATE memory_jobs
        SET state = CASE WHEN last_error_code = 'rerun_required' THEN 'pending' ELSE 'completed' END,
            completed_at = CASE WHEN last_error_code = 'rerun_required' THEN NULL ELSE NOW() END,
            attempts = CASE WHEN last_error_code = 'rerun_required' THEN 0 ELSE attempts END,
            claimed_by = CASE WHEN last_error_code = 'rerun_required' THEN NULL ELSE claimed_by END,
            claim_expires_at = NULL,
            last_error_code = NULL
        WHERE job_id = $1 AND claimed_by = $2 AND claim_epoch = $3 AND state = 'running'
      `, [input.jobId, input.claimedBy, input.claimEpoch])
      return (result.rowCount ?? 0) > 0
    },

    /**
     * Fenced retry. Returns true when the attempt budget is exhausted and the
     * job moved to the dead-letter queue instead of back to pending.
     */
    async rescheduleJob(input: {
      jobId: string
      claimedBy: string
      claimEpoch: number
      errorCode: string
    }): Promise<boolean> {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        try {
          // Skill writers take task -> run -> job. Read metadata without a row lock,
          // then join that order before taking the fenced job lock below.
          const skill = await client.query<{ installation_id: string; payload: Record<string, unknown> }>(`
            SELECT installation_id,payload FROM memory_jobs WHERE job_id=$1 AND job_type='extract_skill_candidate'
          `, [input.jobId])
          const skillJob = skill.rows[0]
          if (skillJob && typeof skillJob.payload.task_id === 'string') {
            await client.query(`SELECT 1 FROM memory_skill_tasks WHERE installation_id=$1 AND task_id::text=$2 FOR UPDATE`,
              [skillJob.installation_id, skillJob.payload.task_id])
            await client.query(`SELECT 1 FROM memory_skill_task_runs WHERE installation_id=$1 AND task_id::text=$2 AND generation::text=$3 FOR UPDATE`,
              [skillJob.installation_id, skillJob.payload.task_id, String(skillJob.payload.generation)])
          }
          const claimed = await client.query<{ attempts: number; last_error_code: string | null }>(`
            SELECT attempts, last_error_code FROM memory_jobs
            WHERE job_id = $1 AND claimed_by = $2 AND claim_epoch = $3 AND state = 'running'
            FOR UPDATE
          `, [input.jobId, input.claimedBy, input.claimEpoch])
          const row = claimed.rows[0]
          if (!row) {
            await client.query('COMMIT')
            return false
          }
          const attempts = Number(row.attempts)
          if (row.last_error_code === 'rerun_required') {
            await client.query(`
              UPDATE memory_jobs
              SET state = 'pending', attempts = 0,
                  claimed_by = NULL, claim_expires_at = NULL,
                  last_error_code = $2, completed_at = NULL
              WHERE job_id = $1
            `, [input.jobId, input.errorCode])
            await client.query('COMMIT')
            return false
          }
          if (attempts >= JOB_DEAD_LETTER_ATTEMPTS) {
            const job = await client.query<{
              installation_id: string | null
              job_type: JobType
              payload: Record<string, unknown>
            }>(`
              UPDATE memory_jobs
              SET state = 'dead', completed_at = NOW(), claim_expires_at = NULL,
                  last_error_code = $2
              WHERE job_id = $1
              RETURNING installation_id, job_type, payload
            `, [input.jobId, input.errorCode])
            const dead = job.rows[0]
            if (dead) {
              // The DLQ stores only a payload digest — never the body.
              const digest = createHash('sha256')
                .update(JSON.stringify(dead.payload ?? {}))
                .digest()
              await client.query(`
                INSERT INTO memory_dead_letters
                  (job_id, installation_id, job_type, attempts, error_code, payload_hash)
                VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT (job_id) DO NOTHING
              `, [input.jobId, dead.installation_id, dead.job_type, attempts, input.errorCode, digest])
              if (dead.job_type === 'parse_code_snapshot'
                && typeof dead.payload?.snapshot_id === 'string') {
                await client.query(`
                  UPDATE memory_source_snapshots
                  SET state = 'failed', completed_at = NOW()
                  WHERE installation_id = $1 AND snapshot_id = $2
                    AND state IN ('ready','parsing')
                `, [dead.installation_id, dead.payload.snapshot_id])
              }
              if (dead.job_type === 'build_wiki'
                && typeof dead.payload?.run_id === 'string') {
                await client.query(`
                  UPDATE memory_wiki_build_runs
                  SET state = 'failed', error_code = $3, completed_at = NOW()
                  WHERE installation_id = $1 AND run_id = $2
                    AND state IN ('queued','running','validating')
                `, [dead.installation_id, dead.payload.run_id, input.errorCode])
                await client.query(`
                  UPDATE memory_generation_runs g
                  SET state = 'failed', error_code = $3, completed_at = NOW()
                  FROM memory_wiki_build_runs r
                  WHERE r.installation_id = $1 AND r.run_id = $2
                    AND r.generation_run_id = g.run_id
                    AND g.state IN ('queued','running')
                `, [dead.installation_id, dead.payload.run_id, input.errorCode])
              }
              if (dead.job_type === 'extract_skill_candidate' && typeof dead.payload?.task_id === 'string') {
                const values = [dead.installation_id, dead.payload.task_id, String(dead.payload.generation), input.errorCode]
                await client.query(`UPDATE memory_skill_task_runs SET state='failed',error_code=$4,completed_at=NOW()
                  WHERE installation_id=$1 AND task_id::text=$2 AND generation::text=$3 AND state IN('pending','running')`, values)
                await client.query(`UPDATE memory_generation_runs g SET state='failed',error_code=$4,completed_at=NOW()
                  FROM memory_skill_task_runs r WHERE r.installation_id=$1 AND r.task_id::text=$2 AND r.generation::text=$3
                    AND r.generation_run_id=g.run_id AND g.state IN('queued','running')`, values)
                await client.query(`UPDATE memory_skill_tasks SET state='dead',updated_at=NOW()
                  WHERE installation_id=$1 AND task_id::text=$2 AND current_generation::text=$3`, values.slice(0, 3))
              }
            }
            await client.query('COMMIT')
            return true
          }
          const delayMs = retryDelayMs(attempts)
          await client.query(`
            UPDATE memory_jobs
            SET state = 'pending',
                available_at = NOW() + ($2 * INTERVAL '1 millisecond'),
                claimed_by = NULL,
                claim_expires_at = NULL,
                last_error_code = $3
            WHERE job_id = $1
          `, [input.jobId, delayMs, input.errorCode])
          await client.query('COMMIT')
          return false
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        }
      } finally {
        client.release()
      }
    },
  }
}

export type JobRepository = ReturnType<typeof createJobRepository>
