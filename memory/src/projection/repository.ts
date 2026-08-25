import type pg from 'pg'
import { createSourceProjector } from './source-projector.js'
import type { JobClaim } from '../jobs/types.js'

/**
 * project_feed job handler glue: one job projects the oldest pending inbox
 * rows of its installation and, while backlog remains, re-enqueues so the
 * queue drains without one giant transaction.
 */
export function createProjectionHandler(
  pool: pg.Pool,
  options: Parameters<typeof createSourceProjector>[1] & {
    onProjected?(count: number): void
    onProjectionError?(): void
  } = {},
) {
  const projector = createSourceProjector(pool, options)

  return {
    projector,
    async handleProjectFeed(job: JobClaim, signal: AbortSignal): Promise<void> {
      if (!job.installation_id) return
      let total = 0
      try {
        for (;;) {
          if (signal.aborted) throw new Error('project_feed aborted during drain')
          const result = await projector.projectOnce(job.installation_id)
          total += result.projected
          options.onProjected?.(result.projected)
          if (result.projected === 0) break
          if (total >= 1000) {
            // Bounded drain: leave the rest to a follow-up job.
            await pool.query(`
              INSERT INTO memory_jobs (job_id, installation_id, job_type, idempotency_key, priority, payload)
              VALUES (gen_random_uuid(), $1, 'project_feed', $2, 50, '{}'::jsonb)
              ON CONFLICT DO NOTHING
            `, [job.installation_id, `project:${job.installation_id}:drain:${Date.now()}`])
            break
          }
        }
      } catch (error) {
        options.onProjectionError?.()
        throw error
      }
    },
  }
}

export type ProjectionHandler = ReturnType<typeof createProjectionHandler>
