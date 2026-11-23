import {jobCapacityClassSql, type JobCapacity} from './scheduling.js'
import { createHash, randomUUID } from 'crypto'
import type pg from 'pg'
import { JOB_DEAD_LETTER_ATTEMPTS, JOB_PRIORITIES, type JobClaim, type JobType, type JobDeferReason } from './types.js'

const RETRY_LADDER_MS: readonly number[] = [1_000, 5_000, 15_000, 45_000]
const RETRY_CAP_MS = 5 * 60_000

/** Frozen retry ladder: attempt n backs off per section 8.2 of the plan. */
export function retryDelayMs(attempts: number): number {
  if (attempts <= RETRY_LADDER_MS.length) return RETRY_LADDER_MS[attempts - 1]
  return RETRY_CAP_MS
}

/** ±20% jitter, capped at the frozen maximum; explicit sample aids reproducibility. */
export function retryDelayWithJitterMs(attempts:number,sample=Math.random()):number{
  if(!Number.isFinite(sample)||sample<0||sample>1)throw new Error('invalid_retry_jitter')
  return Math.min(RETRY_CAP_MS,Math.round(retryDelayMs(attempts)*(.8+.4*sample)))
}

interface JobRow {
  priority: number
  job_id: string
  installation_id: string | null
  job_type: JobType
  idempotency_key: string
  payload: Record<string, unknown>
  last_error_code: string | null
  attempts: number | string
  claim_epoch: number | string
}

function toClaim(row: JobRow): JobClaim {
  return {
    job_id: row.job_id,
    installation_id: row.installation_id,
    job_type: row.job_type,
    priority: row.priority,
    idempotency_key: row.idempotency_key,
    payload: row.payload ?? {},
    attempts: Number(row.attempts),
    ...(row.last_error_code ? {last_error_code:row.last_error_code} : {}),
    claim_epoch: Number(row.claim_epoch),
  }
}

/**
 * PostgreSQL job queue with claim fencing: every completion, renewal or
 * failure must match `job_id + claimed_by + claim_epoch`, so a worker whose
 * lease expired (and whose job was reclaimed under a bumped epoch) can never
 * finalize work a new worker already owns.
 */
export function createJobRepository(pool: pg.Pool, options: { compileBatchIntervalMs?: number; nativeSourcesOnly?:boolean } = {}) {
  const compileBatchMs = options.compileBatchIntervalMs ?? 0
  if (!Number.isSafeInteger(compileBatchMs) || compileBatchMs < 0 || compileBatchMs > 3_600_000) {
    throw new Error('invalid_compile_batch_interval')
  }
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

    /** Serialize the short claim transaction so caps hold across workers. */
    async claimJobs(input: {
      workerId: string; limit: number; leaseMs: number
      globalLimit?: number; perInstallationLimit?: number
      typeLimits?: Partial<Record<JobType,number>>
      capacity?: JobCapacity
    }): Promise<JobClaim[]> {
      if(input.limit===0)return []
      if(!Number.isInteger(input.limit)||input.limit<0||input.limit>1000||!Number.isFinite(input.leaseMs)||input.leaseMs<=0)throw new Error('invalid_claim_limits')
      const globalLimit=input.globalLimit??2147483647,tenantLimit=input.perInstallationLimit??2147483647
      const limits={...input.typeLimits}
      // The type cap includes both ordinary and historical compile lanes.
      if (compileBatchMs > 0) limits.compile_episode = Math.min(1, limits.compile_episode ?? 1)
      if(!Number.isInteger(globalLimit)||globalLimit<1||!Number.isInteger(tenantLimit)||tenantLimit<1
        ||[...Object.values(limits),...Object.values(input.capacity??{})].some(n=>!Number.isInteger(n)||Number(n)<0))throw new Error('invalid_claim_limits')
      const client=await pool.connect()
      try{
        await client.query('BEGIN')
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('memory-jobs:claim',0))")
        await client.query(`UPDATE memory_jobs SET state='pending',claimed_by=NULL,claim_expires_at=NULL
          WHERE state='running' AND claim_expires_at<=clock_timestamp()`)
        const capacityClass = input.capacity ? jobCapacityClassSql : "'general'::text"
        // Drain turns that were ready at the last database-clock boundary. Store the
        // claim time atomically: expiry, reruns and deferrals may all change available_at.
        const result=await client.query<JobRow>(`WITH batch AS (
          SELECT floor(extract(epoch FROM statement_timestamp()) * 1000 / NULLIF($8::integer, 0)) * $8 AS start_ms
        ), live AS(
          SELECT installation_id,job_type,${capacityClass} AS lane FROM memory_jobs
          WHERE state='running' AND claim_expires_at>clock_timestamp()
        ), tenant AS(SELECT installation_id,count(*)::int n FROM live GROUP BY installation_id),
        kind AS(SELECT job_type,count(*)::int n FROM live GROUP BY job_type),
        lanes AS(SELECT lane,count(*)::int n FROM live GROUP BY lane),
        eligible AS(
          SELECT j.job_id,j.installation_id,j.job_type,j.priority,j.available_at,j.created_at,j.lane,
            COALESCE(t.n,0) AS active_tenant,
            $5::int-COALESCE(t.n,0) AS tenant_room,
            COALESCE(($6::jsonb->>j.job_type)::int,2147483647)-COALESCE(k.n,0) AS type_room,
            COALESCE(($7::jsonb->>j.lane)::int,2147483647)-COALESCE(l.n,0) AS lane_room
          FROM (SELECT job_id,installation_id,job_type,priority,available_at,created_at,${capacityClass} AS lane
                FROM memory_jobs CROSS JOIN batch WHERE state='pending' AND available_at<=statement_timestamp()
                  ${options.nativeSourcesOnly?`AND job_type NOT IN('snapshot_reconcile','project_feed')
                    AND (job_type<>'project_shared_source' OR payload#>>'{root,kind}' IN('team_collaboration','team_delivery'))
                    AND (job_type NOT IN('consolidate_task','curate_conclusions') OR EXISTS(
                     SELECT 1 FROM memory_task_bundles b WHERE b.installation_id=memory_jobs.installation_id
                      AND b.bundle_id=CASE WHEN memory_jobs.payload->>'bundle_id' ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
                       THEN (memory_jobs.payload->>'bundle_id')::uuid END AND b.dialogue_members IS NOT NULL))
                    AND (job_type<>'compile_episode' OR (idempotency_key LIKE 'dialogue:%' AND payload ?& ARRAY['dialogue_session','turn']))`:''}
                  AND (job_type<>'compile_episode' OR $8=0 OR (
                    available_at<=to_timestamp(batch.start_ms::double precision/1000)
                    AND (jsonb_typeof(payload->'compile_last_claim_ms') IS DISTINCT FROM 'number'
                      OR payload->'compile_last_claim_ms'<to_jsonb(batch.start_ms))
                  ))) j
          LEFT JOIN tenant t ON t.installation_id IS NOT DISTINCT FROM j.installation_id
          LEFT JOIN kind k ON k.job_type=j.job_type
          LEFT JOIN lanes l ON l.lane=j.lane
        ), tenant_order AS(
          SELECT *,ROW_NUMBER() OVER(PARTITION BY installation_id ORDER BY priority,available_at,created_at,job_id) AS tenant_turn
          FROM eligible WHERE tenant_room>0 AND type_room>0 AND lane_room>0
        ), type_order AS(
          SELECT *,ROW_NUMBER() OVER(PARTITION BY job_type ORDER BY
            CASE WHEN job_type='compile_episode' AND $8>0 THEN available_at END,
            priority,active_tenant,tenant_turn,available_at,created_at,job_id) AS type_rank
          FROM tenant_order
        ), lane_order AS(
          SELECT *,ROW_NUMBER() OVER(PARTITION BY lane ORDER BY priority,active_tenant,tenant_turn,available_at,created_at,job_id) AS lane_rank
          FROM type_order WHERE type_rank<=type_room
        ), ranked AS(
          SELECT *,ROW_NUMBER() OVER(PARTITION BY installation_id ORDER BY priority,available_at,created_at,job_id) AS tenant_rank
          FROM lane_order WHERE lane_rank<=lane_room
        ), picked AS(SELECT j.job_id,j.last_error_code FROM memory_jobs j JOIN ranked r ON r.job_id=j.job_id
          WHERE r.tenant_rank<=r.tenant_room
          ORDER BY r.priority,r.active_tenant,r.tenant_rank,r.available_at,r.created_at,j.job_id
          FOR UPDATE OF j SKIP LOCKED
          LIMIT LEAST($3::int,GREATEST(0,$4::int-(SELECT count(*)::int FROM live))))
        UPDATE memory_jobs j SET state='running',claimed_by=$1,claim_epoch=j.claim_epoch+1,
          claim_expires_at=clock_timestamp()+($2*interval '1 millisecond'),attempts=j.attempts+1,last_error_code=NULL,
          payload=CASE WHEN j.job_type='compile_episode' AND $8>0 THEN
            jsonb_set(j.payload,'{compile_last_claim_ms}',to_jsonb(floor(extract(epoch FROM statement_timestamp())*1000)))
            ELSE j.payload END
        FROM picked WHERE j.job_id=picked.job_id
        RETURNING j.job_id,j.installation_id,j.job_type,j.idempotency_key,j.payload,j.attempts,j.claim_epoch,j.priority,picked.last_error_code`,
          [input.workerId,input.leaseMs,input.limit,globalLimit,tenantLimit,JSON.stringify(limits),JSON.stringify(input.capacity??{}),compileBatchMs])
        await client.query('COMMIT');return result.rows.map(toClaim)
      }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error}finally{client.release()}
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
      const client=await pool.connect()
      try{
        await client.query('BEGIN')
        await client.query("SELECT 1 FROM memory_jobs WHERE job_id=$1 AND claimed_by=$2 AND claim_epoch=$3 AND state='running' FOR UPDATE",[input.jobId,input.claimedBy,input.claimEpoch])
        const result = await client.query(`
        UPDATE memory_jobs
        SET claim_expires_at = clock_timestamp() + ($4 * INTERVAL '1 millisecond')
        WHERE job_id = $1 AND claimed_by = $2 AND claim_epoch = $3 AND state = 'running' AND claim_expires_at>clock_timestamp()
      `, [input.jobId, input.claimedBy, input.claimEpoch, input.leaseMs])
        await client.query('COMMIT')
        return (result.rowCount ?? 0) > 0
      }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error}finally{client.release()}
    },

    /** Fenced completion; false means the caller no longer owns the job. */
    async completeJob(input: {
      jobId: string
      claimedBy: string
      claimEpoch: number
    }): Promise<boolean> {
      const client=await pool.connect()
      try{
        await client.query('BEGIN')
        await client.query("SELECT 1 FROM memory_jobs WHERE job_id=$1 AND claimed_by=$2 AND claim_epoch=$3 AND state='running' FOR UPDATE",[input.jobId,input.claimedBy,input.claimEpoch])
        const result = await client.query(`
        UPDATE memory_jobs
        SET state = CASE WHEN last_error_code = 'rerun_required' THEN 'pending' ELSE 'completed' END,
            completed_at = CASE WHEN last_error_code = 'rerun_required' THEN NULL ELSE NOW() END,
            attempts = CASE WHEN last_error_code = 'rerun_required' THEN 0 ELSE attempts END,
            claimed_by = CASE WHEN last_error_code = 'rerun_required' THEN NULL ELSE claimed_by END,
            claim_expires_at = NULL,
            last_error_code = NULL
        WHERE job_id = $1 AND claimed_by = $2 AND claim_epoch = $3 AND state = 'running' AND claim_expires_at>clock_timestamp()
      `, [input.jobId, input.claimedBy, input.claimEpoch])
        await client.query('COMMIT')
        return (result.rowCount ?? 0) > 0
      }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error}finally{client.release()}
    },

    /** Budget waits undo only this claim's attempt, preserving earlier failures. */
    async deferJob(input: {
      jobId: string; claimedBy: string; claimEpoch: number
      reason: JobDeferReason; availableAt: Date
    }): Promise<boolean> {
      if (!Number.isFinite(input.availableAt.getTime())) throw new Error('invalid_defer_clock')
      const client=await pool.connect()
      try{
        await client.query('BEGIN')
        await client.query("SELECT 1 FROM memory_jobs WHERE job_id=$1 AND claimed_by=$2 AND claim_epoch=$3 AND state='running' FOR UPDATE",[input.jobId,input.claimedBy,input.claimEpoch])
        const result = await client.query(`
        UPDATE memory_jobs SET state='pending',
          attempts=CASE WHEN last_error_code='rerun_required' THEN 0 ELSE GREATEST(0,attempts-1) END,
          available_at=CASE WHEN last_error_code='rerun_required' THEN clock_timestamp()+interval '1 second'
            ELSE GREATEST($4::timestamptz,clock_timestamp()+interval '1 second') END,
          claimed_by=NULL,claim_expires_at=NULL,completed_at=NULL,
          last_error_code=CASE WHEN last_error_code='rerun_required' THEN 'rerun_required' ELSE $5 END,
          payload=jsonb_set(payload,ARRAY[$6::text],to_jsonb(
            CASE WHEN payload->>$6 ~ '^[0-9]{1,9}$'
              THEN LEAST(999999999,(payload->>$6)::int+1) ELSE 1 END))
        WHERE job_id=$1 AND claimed_by=$2 AND claim_epoch=$3 AND state='running'
          AND claim_expires_at>clock_timestamp()
      `, [input.jobId,input.claimedBy,input.claimEpoch,input.availableAt,input.reason,
        input.reason==='source_not_ready'?'source_wait_count':'budget_wait_count'])
        await client.query('COMMIT')
        return (result.rowCount??0)>0
      }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error}finally{client.release()}
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
      terminal?: boolean
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
          const claimed = await client.query<{ attempts: number; last_error_code: string | null; job_type: JobType }>(`
            SELECT attempts, last_error_code, job_type FROM memory_jobs
            WHERE job_id = $1 AND claimed_by = $2 AND claim_epoch = $3 AND state = 'running'
            FOR UPDATE
          `, [input.jobId, input.claimedBy, input.claimEpoch])
          const row = claimed.rows[0]
          const live=await client.query(`SELECT 1 FROM memory_jobs WHERE job_id=$1 AND claimed_by=$2
            AND claim_epoch=$3 AND state='running' AND claim_expires_at>clock_timestamp()`,
            [input.jobId,input.claimedBy,input.claimEpoch])
          if (!row||!live.rowCount) {
            await client.query('COMMIT')
            return false
          }
          const attempts = Number(row.attempts)
          if (row.last_error_code === 'rerun_required' && !input.terminal) {
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
          // A compile over a hard preparation limit cannot advance on this
          // input. A concurrently dirtied turn takes the rerun branch above.
          const exceedsCompileLimit = row.job_type === 'compile_episode'
            && ['source_reference_limit','source_reference_byte_limit'].includes(input.errorCode)
          if (input.terminal || exceedsCompileLimit || attempts >= JOB_DEAD_LETTER_ATTEMPTS) {
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
          const delayMs = retryDelayWithJitterMs(attempts)
          await client.query(`
            UPDATE memory_jobs
            SET state = 'pending',
                available_at = NOW() + ($2 * INTERVAL '1 millisecond'),
                claimed_by = NULL,
                claim_expires_at = NULL,
                last_error_code = $3,
                payload = CASE WHEN job_type='project_shared_source'
                    AND $3 IN ('canonical_reference_budget_exceeded','canonical_reference_write_timeout','projection_read_page_timeout')
                  THEN jsonb_set(payload,'{projection_budget_step}',to_jsonb(CASE
                    WHEN payload->>'projection_budget_step' ~ '^[1-8]$'
                    THEN LEAST(8,(payload->>'projection_budget_step')::int+1) ELSE 1 END))
                  ELSE payload END
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
