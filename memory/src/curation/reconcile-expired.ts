import type pg from 'pg'

// Caller owns the bundle lock before the run lock. A newer revision, a
// replacement run or a successful publication always wins over bookkeeping.
export async function blockCurationBundle(client:pg.PoolClient,installationId:string,bundleId:string,revision:number,runId:string,reason:string){
 await client.query(`UPDATE memory_task_bundles SET state='blocked',reason_code=$5,updated_at=clock_timestamp()
  WHERE installation_id=$1 AND bundle_id=$2 AND revision=$3 AND
   (state='running' OR (state='blocked' AND reason_code IN ('provider_result_unknown','publication_interrupted')))
   AND NOT EXISTS(SELECT 1 FROM memory_curation_runs other WHERE other.installation_id=$1
    AND other.bundle_id=$2 AND other.bundle_revision=$3 AND other.run_id<>$4 AND other.state IN('running','completed'))`,
  [installationId,bundleId,revision,runId,reason])
}

export async function expireCurationRun(client:pg.PoolClient,installationId:string,bundleId:string,revision:number,runId:string){
 // Only the worker that witnessed a known response writes this marker. A
 // partial charge may also exist for a multi-window or uncertain request.
 const row=(await client.query(`UPDATE memory_curation_runs SET
   state=CASE WHEN error_code='provider_response_received' THEN 'failed' ELSE 'provider_result_unknown' END,
   error_code=CASE error_code WHEN 'provider_response_received' THEN 'publication_interrupted'
    WHEN 'provider_response_uncertain' THEN 'provider_uncertain_at_expiry' ELSE 'lease_expired' END,
   completed_at=clock_timestamp() WHERE installation_id=$1 AND run_id=$2 AND state='running'
   AND claim_expires_at<=clock_timestamp() RETURNING state,error_code`,[installationId,runId])).rows[0]
 if(row)await blockCurationBundle(client,installationId,bundleId,revision,runId,row.state==='failed'?row.error_code:row.state)
}

/** Restrictive bookkeeping only: a dead queue owner cannot finish its expired
 * run. Never infer provider success from tokens, replay a call, alter accounting,
 * or block a newer bundle revision. Locks serialize with revival and completion. */
export async function reconcileExpiredCurationRuns(pool:pg.Pool):Promise<number>{
 const client=await pool.connect()
 try{
  await client.query('BEGIN')
  await client.query("SET LOCAL lock_timeout='500ms'; SET LOCAL statement_timeout='3s'")
  const rows=(await client.query(`SELECT r.installation_id,r.run_id,r.bundle_id,r.bundle_revision
   FROM memory_curation_runs r
   JOIN memory_jobs j ON j.job_id::text=r.claimed_by AND j.installation_id=r.installation_id
    AND j.job_type='consolidate_task' AND j.state='dead'
   JOIN memory_task_bundles b ON b.installation_id=r.installation_id AND b.bundle_id=r.bundle_id
   WHERE r.state='running' AND r.claim_expires_at<clock_timestamp() AND r.result IS NULL
   ORDER BY r.claim_expires_at,r.run_id LIMIT 25 FOR UPDATE OF j,b,r SKIP LOCKED`)).rows
  for(const r of rows){
   await expireCurationRun(client,r.installation_id,r.bundle_id,r.bundle_revision,r.run_id)
  }
  await client.query('COMMIT');return rows.length
 }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error}finally{client.release()}
}
