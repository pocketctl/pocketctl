import type pg from 'pg'

/** A running job owns its lease and rechecks the revision itself. If a claim
 * is in progress, leave its row to the worker or the next maintenance pass. */
export async function closeSupersededConsolidationJobs(
  client: Pick<pg.PoolClient, 'query'>,
  bundle?: { installationId: string; bundleId: string },
): Promise<number> {
  const result = await client.query(`
    WITH superseded AS (
      SELECT j.job_id
      FROM memory_jobs j
      JOIN memory_task_bundles b ON b.installation_id = j.installation_id
        AND b.bundle_id::text = j.payload->>'bundle_id'
      WHERE j.job_type = 'consolidate_task' AND j.state = 'pending'
        AND b.bundle_kind = 'intake'
        AND CASE WHEN j.payload->>'bundle_revision' ~ '^[1-9][0-9]{0,18}$'
              THEN (j.payload->>'bundle_revision')::numeric END < b.revision
        ${bundle ? 'AND b.installation_id = $1 AND b.bundle_id = $2' : ''}
      ORDER BY j.job_id
      ${bundle ? '' : 'LIMIT 500'}
      FOR UPDATE OF j SKIP LOCKED
    )
    UPDATE memory_jobs j SET state = 'completed', completed_at = clock_timestamp(),
      last_error_code = 'bundle_revision_superseded', claimed_by = NULL, claim_expires_at = NULL
    FROM superseded WHERE j.job_id = superseded.job_id
  `, bundle ? [bundle.installationId, bundle.bundleId] : [])
  return result.rowCount ?? 0
}
